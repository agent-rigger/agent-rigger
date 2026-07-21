import { join } from 'node:path';

import { assertSafeArtifactName } from '@agent-rigger/core/artifact-name';
import { readJson, readText } from '@agent-rigger/core/fs-json';
import type { OpencodePermission } from '@agent-rigger/core/types';

import { CHECKOUT_CLAUDE, CHECKOUT_OPENCODE } from './checkout-prefixes';
import { localId } from './qualify';
import { type CatalogEntry, CatalogEntrySchema, type CatalogMeta, MetaSchema } from './schema';
import type { CommandRunner } from './tool-check';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single tag from a remote git repository with its resolved commit sha. */
export interface RemoteTag {
  /** The tag name, e.g. "v1.2.3". */
  tag: string;
  /** The commit sha this tag points to. For annotated tags, the peeled commit sha. */
  sha: string;
}

/** The resolved version of a remote repository. */
export interface ResolvedVersion {
  /**
   * The version reference. When isTag is true, this is the tag name.
   * When isTag is false (HEAD fallback), this is the commit sha itself.
   */
  ref: string;
  /** The commit sha. */
  sha: string;
  /** True when the version was resolved from a semver tag; false when falling back to HEAD. */
  isTag: boolean;
}

// ---------------------------------------------------------------------------
// RemoteFetchError
// ---------------------------------------------------------------------------

/**
 * Raised when a git ls-remote command exits with a non-zero exit code.
 * The message is the raw stderr output from git, which is actionable.
 */
export class RemoteFetchError extends Error {
  /** The remote URL that was queried. */
  readonly url: string;

  constructor(url: string, stderr: string) {
    super(stderr);
    this.name = 'RemoteFetchError';
    this.url = url;
  }
}

// ---------------------------------------------------------------------------
// RefShaMismatchError — provenance check (R1 / lot 6, D1)
// ---------------------------------------------------------------------------

/**
 * Raised when the commit sha actually on disk after a clone/checkout differs
 * from the sha that was resolved (via `ls-remote`) before the clone.
 *
 * Two real vectors close on this:
 *  - A branch homonymous with a tag: `git clone --branch <name>` prefers
 *    `refs/heads` over `refs/tags` — reproduced empirically — so the branch's
 *    content gets installed under the tag's ref/sha.
 *  - TOCTOU: the tag is re-pushed to a different commit between the
 *    `ls-remote` resolution and the clone.
 *
 * Extends `RemoteFetchError` so every existing `instanceof RemoteFetchError`
 * call site keeps catching it unchanged; `instanceof RefShaMismatchError`
 * narrows to this specific provenance failure when the ref/expected/found
 * detail is needed (e.g. CLI messaging, exit-code mapping).
 *
 * This check is never bypassed by `--force` — provenance is not a scan
 * policy (ADR-0018 draws that line for content scanning; a mismatched sha is
 * not "unscanned content", it is content that is not what the manifest is
 * about to claim it is).
 */
export class RefShaMismatchError extends RemoteFetchError {
  /** The ref that was resolved (tag name, or the sha itself on the HEAD-fallback path). */
  readonly ref: string;
  /** The sha resolved by `ls-remote` before the clone (peeled, for annotated tags). */
  readonly expectedSha: string;
  /** The sha actually found via `git rev-parse HEAD` on the checkout. */
  readonly foundSha: string;

  constructor(url: string, ref: string, expectedSha: string, foundSha: string) {
    super(
      url,
      `Invalid provenance for ref "${ref}": expected sha ${expectedSha}, found sha ${foundSha} on the checkout. Installation refused — this check cannot be bypassed with --force.`,
    );
    this.name = 'RefShaMismatchError';
    this.ref = ref;
    this.expectedSha = expectedSha;
    this.foundSha = foundSha;
  }
}

// ---------------------------------------------------------------------------
// Input validation — allowlist guards against argument injection
// ---------------------------------------------------------------------------

/**
 * Raised when a remote URL is rejected by the allowlist validator.
 *
 * Accepted forms: https://, http://, ssh://, git@host:owner/repo(.git), /absolute/path.
 * Rejected: anything starting with '-', ext::, fd::, or other unlisted transports.
 */
export class InvalidRemoteUrlError extends Error {
  readonly url: string;

  constructor(url: string) {
    super(
      `Untrusted remote URL: "${url}". Accepted forms: https://, http://, ssh://, git@host:owner/repo, /absolute/path.`,
    );
    this.name = 'InvalidRemoteUrlError';
    this.url = url;
  }
}

/**
 * Raised when a git ref is rejected by the guard.
 *
 * Rejects empty strings and refs starting with '-' (option injection).
 */
export class InvalidRemoteRefError extends Error {
  readonly ref: string;

  constructor(ref: string) {
    super(
      `Untrusted git ref: "${ref}". The ref cannot be empty or start with '-'.`,
    );
    this.name = 'InvalidRemoteRefError';
    this.ref = ref;
  }
}

/**
 * Allowlist guard for remote URLs passed to git commands.
 *
 * Accepted forms:
 *  - https:// or http://
 *  - ssh://
 *  - SCP-style: git@host:owner/repo(.git)
 *  - Absolute path: /...
 *
 * Explicitly rejects:
 *  - Anything starting with '-' (option injection)
 *  - ext:: transport (arbitrary command execution)
 *  - fd:: transport (file descriptor injection)
 *  - Any other unlisted transport
 *
 * Throws InvalidRemoteUrlError when the URL does not match.
 */
export function assertSafeRemoteUrl(url: string): void {
  if (
    url.startsWith('https://')
    || url.startsWith('http://')
    || url.startsWith('ssh://')
    || url.startsWith('/')
  ) {
    return;
  }

  // SCP-style: git@host:owner/repo or git@host:owner/repo.git
  // Must not contain spaces, newlines, or shell metacharacters.
  const SCP_RE = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+:[a-zA-Z0-9._/-]+$/;
  if (SCP_RE.test(url)) {
    return;
  }

  throw new InvalidRemoteUrlError(url);
}

/**
 * Guard for git refs passed as --branch or positional arguments.
 *
 * Rejects empty strings and anything starting with '-'.
 * Throws InvalidRemoteRefError when the ref is unsafe.
 */
export function assertSafeRef(ref: string): void {
  if (ref.length === 0 || ref.startsWith('-')) {
    throw new InvalidRemoteRefError(ref);
  }
}

// ---------------------------------------------------------------------------
// Semver parsing — minimal, zero dependencies
//
// Accepts "vX.Y.Z" or "X.Y.Z", stripping a leading "v".
// Build metadata ("+...") is ignored.
// A tag that does not match MAJOR.MINOR.PATCH (with optional prerelease) is ignored.
// Prerelease versions (X.Y.Z-pre) sort below the corresponding release (X.Y.Z).
// Prerelease identifiers are compared per SemVer §11.4 (numeric vs alphanum, length tiebreak).
// ---------------------------------------------------------------------------

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  /** Prerelease string without the leading "-", or undefined for releases. */
  pre: string | undefined;
  /** Original tag name, preserved for output. */
  raw: string;
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.*)?$/;
const NUMERIC_ID_RE = /^\d+$/;

function parseSemver(tag: string): ParsedSemver | undefined {
  const m = SEMVER_RE.exec(tag);
  if (!m) return undefined;
  const [, maj, min, pat, pre] = m;
  if (maj === undefined || min === undefined || pat === undefined) return undefined;
  return {
    major: Number(maj),
    minor: Number(min),
    patch: Number(pat),
    pre: pre ?? undefined,
    raw: tag,
  };
}

/**
 * Compares two prerelease identifiers per SemVer §11.4:
 *  - both numeric → numeric comparison
 *  - both alphanumeric → lexical ASCII comparison
 *  - numeric vs alphanumeric → numeric is lower (returns negative)
 */
function comparePreId(a: string, b: string): number {
  const aNum = NUMERIC_ID_RE.test(a);
  const bNum = NUMERIC_ID_RE.test(b);

  if (aNum && bNum) return Number(a) - Number(b);
  if (!aNum && !bNum) {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }
  // numeric < alphanumeric
  return aNum ? -1 : 1;
}

/**
 * Compares two parsed semver values per SemVer §11.
 * Returns a positive number when a > b, negative when a < b, 0 when equal.
 * Used for descending sort (negate the comparator in Array.sort).
 *
 * Prerelease identifiers are compared left-to-right, identifier by identifier.
 * When all compared identifiers are equal, the one with more identifiers is greater.
 */
function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  // Releases beat prereleases.
  if (a.pre === undefined && b.pre !== undefined) return 1;
  if (a.pre !== undefined && b.pre === undefined) return -1;
  if (a.pre === undefined && b.pre === undefined) return 0;

  // Both have prereleases — compare identifier by identifier.
  const aIds = (a.pre as string).split('.');
  const bIds = (b.pre as string).split('.');
  const len = Math.min(aIds.length, bIds.length);

  for (let i = 0; i < len; i++) {
    const cmp = comparePreId(aIds[i] as string, bIds[i] as string);
    if (cmp !== 0) return cmp;
  }

  // All shared identifiers are equal — longer prerelease is greater.
  return aIds.length - bIds.length;
}

// ---------------------------------------------------------------------------
// ls-remote output parsing
// ---------------------------------------------------------------------------

/**
 * Parses lines from `git ls-remote --tags` output.
 *
 * Each line has the form: "<sha>\t<ref>"
 * Annotated tags produce two lines:
 *   "<sha_obj>\trefs/tags/<name>"      (tag object sha)
 *   "<sha_cmt>\trefs/tags/<name>^{}"   (peeled commit sha)
 *
 * When a peeled line exists, its sha (the commit) takes precedence.
 * Non-semver tag names are discarded. Result is deduplicated by tag name.
 */
function parseLsRemoteTags(stdout: string): Map<string, string> {
  // Two-pass: first collect all shas, then apply peeled overrides.
  const base = new Map<string, string>();
  const peeled = new Map<string, string>();

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const tab = trimmed.indexOf('\t');
    if (tab === -1) continue;

    const sha = trimmed.slice(0, tab);
    const ref = trimmed.slice(tab + 1);

    const peeledPrefix = 'refs/tags/';
    const peeledSuffix = '^{}';

    if (ref.startsWith(peeledPrefix) && ref.endsWith(peeledSuffix)) {
      const name = ref.slice(peeledPrefix.length, ref.length - peeledSuffix.length);
      peeled.set(name, sha);
    } else if (ref.startsWith(peeledPrefix)) {
      const name = ref.slice(peeledPrefix.length);
      base.set(name, sha);
    }
  }

  // Merge: peeled sha overrides base sha for annotated tags.
  const result = new Map<string, string>(base);
  for (const [name, sha] of peeled) {
    result.set(name, sha);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Lists tags from a remote git repository, sorted by semver descending.
 *
 * Spawns `git ls-remote --tags <url>` via the injected runner.
 * Only tags that are valid semver (vX.Y.Z or X.Y.Z, optionally with prerelease)
 * are included in the result. Annotated tags use the peeled commit sha.
 *
 * Throws RemoteFetchError when git exits with a non-zero code.
 */
export async function listRemoteTags(url: string, run: CommandRunner): Promise<RemoteTag[]> {
  assertSafeRemoteUrl(url);

  const result = await run('git', ['ls-remote', '--tags', '--', url]);

  if (result.exitCode !== 0) {
    throw new RemoteFetchError(url, result.stderr ?? '');
  }

  const tagMap = parseLsRemoteTags(result.stdout ?? '');

  const parsed: Array<{ parsed: ParsedSemver; sha: string }> = [];
  for (const [name, sha] of tagMap) {
    const p = parseSemver(name);
    if (p) {
      parsed.push({ parsed: p, sha });
    }
  }

  // Sort descending (highest first).
  parsed.sort((a, b) => compareSemver(b.parsed, a.parsed));

  return parsed.map(({ parsed: p, sha }) => ({ tag: p.raw, sha }));
}

/**
 * Resolves the current version of a remote repository.
 *
 * If there are semver tags, returns the largest one.
 * Otherwise falls back to `git ls-remote <url> HEAD` and returns the HEAD sha.
 *
 * Throws RemoteFetchError when any git command exits with a non-zero code.
 */
export async function resolveVersion(url: string, run: CommandRunner): Promise<ResolvedVersion> {
  const tags = await listRemoteTags(url, run);

  const top = tags.at(0);
  if (top !== undefined) {
    return { ref: top.tag, sha: top.sha, isTag: true };
  }

  // No semver tags — fall back to HEAD sha.
  const headResult = await run('git', ['ls-remote', '--', url, 'HEAD']);

  if (headResult.exitCode !== 0) {
    throw new RemoteFetchError(url, headResult.stderr ?? '');
  }

  // Expected format: "<sha>\tHEAD"
  const firstLine = (headResult.stdout ?? '').split('\n')[0]?.trim() ?? '';
  const sha = firstLine.split('\t')[0] ?? '';

  if (sha === '') {
    throw new RemoteFetchError(
      url,
      'HEAD not found: ls-remote HEAD returned empty output',
    );
  }

  return { ref: sha, sha, isTag: false };
}

// ---------------------------------------------------------------------------
// fetchCatalog — shallow clone + catalog.json validation
// ---------------------------------------------------------------------------

/** The result of a successful catalog fetch. */
export interface FetchedCatalog {
  meta: CatalogMeta;
  entries: CatalogEntry[];
  sha: string;
}

/**
 * Provides a temporary directory and its cleanup function.
 * Injected into fetchCatalog — allows deterministic testing without real tmp dirs.
 */
export type TmpDirFactory = () => Promise<{ path: string; cleanup: () => Promise<void> }>;

/**
 * Raised when catalog.json is absent, contains invalid JSON, is not an array,
 * or fails Zod validation.
 *
 * `issues` is a human-readable list of problems (field path + reason).
 */
export class CatalogParseError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[]) {
    super(message);
    this.name = 'CatalogParseError';
    this.issues = issues;
  }
}

/**
 * Performs a shallow clone of `url` into a temporary directory,
 * executes `fn(checkoutDir)`, then cleans up the directory unconditionally.
 *
 * When `isTag` is true the ref is a branch/tag name and is passed via
 * `--branch <ref>` (original behaviour).
 *
 * When `isTag` is false the ref is an arbitrary commit sha (HEAD fallback).
 * `git clone --branch <sha>` is rejected by git, so the sha path uses:
 *   1. `git clone --depth 1 -- <url> <path>` (clone default branch)
 *   2. `git -C <path> fetch --depth 1 origin <sha>`
 *   3. `git -C <path> checkout <sha>`
 *
 * Guarantees:
 *  - `assertSafeRemoteUrl` and `assertSafeRef` are called before any tmp allocation.
 *  - cleanup runs in `finally`, covering success, clone failure, fetch/checkout
 *    failure, and `fn` throw.
 *
 * `opts.expectedSha` (R1 / lot 6, D1, optional — back-compat): when provided,
 * a `git -C <path> rev-parse HEAD` runs right after clone/checkout (both the
 * isTag and sha paths — one branch to reason about, no bypass via --force)
 * and is compared to `expectedSha`. A mismatch throws `RefShaMismatchError`
 * BEFORE `fn` runs, so nothing is installed and nothing is written; `finally`
 * still runs cleanup. Callers should pass the *peeled* sha (what
 * `resolveVersion`/`listRemoteTags` already resolve for annotated tags) so
 * there is no false positive. Omitting `expectedSha` skips the check
 * entirely — existing callers are unaffected.
 *
 * Returns the value returned by `fn`.
 * Throws RemoteFetchError when any git command exits non-zero.
 * Throws RefShaMismatchError (a RemoteFetchError subtype) on a provenance mismatch.
 * Throws InvalidRemoteUrlError / InvalidRemoteRefError for unsafe inputs.
 */
export async function withRemoteCheckout<T>(
  url: string,
  ref: string,
  isTag: boolean,
  run: CommandRunner,
  opts: { tmpFactory: TmpDirFactory; expectedSha?: string },
  fn: (checkoutDir: string) => Promise<T>,
): Promise<T> {
  assertSafeRemoteUrl(url);
  assertSafeRef(ref);

  const { path, cleanup } = await opts.tmpFactory();

  try {
    if (isTag) {
      // '--' separates options from operands so URL/ref cannot be parsed as git flags.
      const cloneResult = await run('git', [
        'clone',
        '--depth',
        '1',
        '--branch',
        ref,
        '--',
        url,
        path,
      ]);
      if (cloneResult.exitCode !== 0) {
        throw new RemoteFetchError(url, cloneResult.stderr ?? '');
      }
    } else {
      // SHA path: clone default branch, then fetch + checkout the specific sha.
      const cloneResult = await run('git', ['clone', '--depth', '1', '--', url, path]);
      if (cloneResult.exitCode !== 0) {
        throw new RemoteFetchError(url, cloneResult.stderr ?? '');
      }

      const fetchResult = await run('git', ['-C', path, 'fetch', '--depth', '1', 'origin', ref]);
      if (fetchResult.exitCode !== 0) {
        throw new RemoteFetchError(url, fetchResult.stderr ?? '');
      }

      const checkoutResult = await run('git', ['-C', path, 'checkout', ref]);
      if (checkoutResult.exitCode !== 0) {
        throw new RemoteFetchError(url, checkoutResult.stderr ?? '');
      }
    }

    // R1 (lot 6, D1): the manifest must record the commit that is actually on
    // disk, not merely the sha ls-remote resolved before the clone started.
    // Systematic — applies on both the isTag and sha paths (redundant on the
    // sha path by construction, but a single branch to reason about) — and
    // never bypassed by --force (provenance is not a scan policy).
    if (opts.expectedSha !== undefined) {
      const provenanceResult = await run('git', ['-C', path, 'rev-parse', 'HEAD']);
      if (provenanceResult.exitCode !== 0) {
        throw new RemoteFetchError(url, provenanceResult.stderr ?? '');
      }
      const foundSha = (provenanceResult.stdout ?? '').trim();
      if (foundSha !== opts.expectedSha) {
        throw new RefShaMismatchError(url, ref, opts.expectedSha, foundSha);
      }
    }

    return await fn(path);
  } finally {
    await cleanup();
  }
}

// ---------------------------------------------------------------------------
// readCatalogDir — read + validate catalog.json from a directory
// ---------------------------------------------------------------------------

/**
 * Read and validate `catalog.json` from `dir`.
 *
 * Expects the file to contain an object of the form `{ meta, entries }`.
 * A bare array or an object missing a valid `meta.name` is rejected with a
 * `CatalogParseError`.
 *
 * Throws CatalogParseError when:
 *  - catalog.json is absent.
 *  - the file contains invalid JSON.
 *  - the root value is a bare array (legacy format no longer supported).
 *  - the root object is missing `meta` or `meta.name` is empty/absent.
 *  - one or more entries fail Zod validation (issues array populated).
 */
export async function readCatalogDir(
  dir: string,
): Promise<{ meta: CatalogMeta; entries: CatalogEntry[] }> {
  // Step 1 — read catalog.json from the directory.
  const catalogPath = join(dir, 'catalog.json');
  const catalogFile = Bun.file(catalogPath);
  const fileExists = await catalogFile.exists();
  if (!fileExists) {
    throw new CatalogParseError('catalog.json not found in the content repo', [
      'catalog.json not found',
    ]);
  }

  // Step 2 — parse JSON.
  let raw: unknown;
  try {
    const text = await catalogFile.text();
    raw = JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new CatalogParseError(msg, [msg]);
  }

  // Step 3 — reject bare array (legacy format).
  if (Array.isArray(raw)) {
    throw new CatalogParseError(
      'catalog.json must be a wrapped object {meta,entries}, not a bare array',
      ['catalog.json must be a wrapped object {meta,entries}, not a bare array'],
    );
  }

  // Step 4 — must be an object with a valid meta block.
  if (raw === null || typeof raw !== 'object') {
    throw new CatalogParseError(
      'catalog.json must be a wrapped object {meta,entries}',
      ['catalog.json must be a wrapped object {meta,entries}'],
    );
  }

  const obj = raw as Record<string, unknown>;

  // Step 5 — validate meta via Zod.
  const metaResult = MetaSchema.safeParse(obj['meta']);
  if (!metaResult.success) {
    const metaIssues = metaResult.error.issues.map(
      (issue) => `meta.${issue.path.join('.')}: ${issue.message}`,
    );
    throw new CatalogParseError(
      `catalog.json: invalid meta block — meta.name is required and must not be empty`,
      metaIssues,
    );
  }
  const meta = metaResult.data;

  // Step 6 — entries must be an array.
  const rawEntries = obj['entries'];
  if (!Array.isArray(rawEntries)) {
    throw new CatalogParseError(
      'catalog.json: the entries field must be an array',
      ['catalog.json: the entries field must be an array'],
    );
  }

  // Step 7 — validate each entry via Zod.
  const entries: CatalogEntry[] = [];
  const issues: string[] = [];

  for (let i = 0; i < rawEntries.length; i++) {
    const parsed = CatalogEntrySchema.safeParse(rawEntries[i]);
    if (parsed.success) {
      entries.push(parsed.data);
    } else {
      for (const issue of parsed.error.issues) {
        const issuePath = issue.path.join('.');
        issues.push(`index ${i}: ${issuePath} ${issue.message}`);
      }
    }
  }

  if (issues.length > 0) {
    throw new CatalogParseError(
      `catalog.json contains invalid entries: ${issues.join('; ')}`,
      issues,
    );
  }

  return { meta, entries };
}

// ---------------------------------------------------------------------------
// fetchCatalog — shallow clone + catalog.json validation
// ---------------------------------------------------------------------------

/**
 * Clones a git repository at `ref` (shallow, depth 1), reads and validates
 * `catalog.json` from the clone root, then returns the parsed entries and HEAD sha.
 *
 * Delegates clone lifecycle to `withRemoteCheckout` (cleanup guaranteed).
 * Delegates catalog reading to `readCatalogDir`.
 *
 * `opts.expectedSha` (R1 / lot 6, optional — back-compat) is forwarded
 * verbatim to `withRemoteCheckout` — see its docstring. The provenance check
 * runs before catalog.json is even read: a mismatch throws
 * RefShaMismatchError, not CatalogParseError.
 *
 * Throws RemoteFetchError when any git command exits non-zero.
 * Throws RefShaMismatchError (a RemoteFetchError subtype) on a provenance mismatch.
 * Throws CatalogParseError when catalog.json is absent, malformed, or invalid.
 * Throws InvalidRemoteUrlError / InvalidRemoteRefError for unsafe inputs.
 */
export async function fetchCatalog(
  url: string,
  ref: string,
  isTag: boolean,
  run: CommandRunner,
  opts: { tmpFactory: TmpDirFactory; expectedSha?: string },
): Promise<FetchedCatalog> {
  return withRemoteCheckout(url, ref, isTag, run, opts, async (dir) => {
    const { meta, entries } = await readCatalogDir(dir);

    // Resolve HEAD sha of the clone.
    const revParseResult = await run('git', ['-C', dir, 'rev-parse', 'HEAD']);
    if (revParseResult.exitCode !== 0) {
      throw new RemoteFetchError(url, revParseResult.stderr ?? '');
    }
    const sha = (revParseResult.stdout ?? '').trim();

    return { meta, entries, sha };
  });
}

// ---------------------------------------------------------------------------
// fetchCatalogCanon — the differential canon (doctor --remote, D1/D2)
//
// catalog.json only carries metadata for guardrail and context natures; their
// canonical *content* lives in per-nature files of the checkout
// (guardrails/<name>/deny.json + allow.json, contexts/<name>/AGENTS.md — the
// exact paths the install builder resolves, adapter-builder.ts). Only mcp is
// inline (entry.config). fetchCatalog(/withRemoteCheckout) tears the checkout
// down before returning, so the canon reads those files INSIDE the checkout and
// keeps the result in memory — same canon semantics as the install, by
// construction, with no persisted clone (ADR-0012).
// ---------------------------------------------------------------------------

/**
 * The in-memory canon of a single configured catalog, read under `--remote`.
 *
 * `guardrails`, `guardrailPermissions` and `contexts` are keyed by catalog entry
 * id (raw, un-qualified — the ids as they appear in the fetched catalog.json). A
 * guardrail entry targeting BOTH assistants populates BOTH guardrail maps. mcp
 * server config stays inline in `entries` (never a file of its own). The checkout
 * that produced this is already gone by the time the value is returned.
 */
export interface CatalogCanon {
  /** The configured catalog name — the catalog id doctor knows it by. */
  name: string;
  /** The validated catalog.json meta block. */
  meta: CatalogMeta;
  /** The resolved version fetched (ref/sha/isTag), carried through verbatim. */
  version: ResolvedVersion;
  /** All validated entries; mcp entries keep their `config` inline. */
  entries: CatalogEntry[];
  /** Claude guardrail deny/allow rules, by entry id (claude-targeted guardrails). */
  guardrails: Map<string, { deny: string[]; allow: string[] }>;
  /**
   * Native opencode `permission` descriptors, by entry id (opencode-targeted
   * guardrails). The opencode guardrail canon lives in `permission.json`, not
   * deny/allow — read here so the host-diff scanner can confront it exactly (D2,
   * both assistants), instead of the claude-only shape the `guardrails` map holds.
   */
  guardrailPermissions: Map<string, OpencodePermission>;
  /** Context AGENTS.md content, by entry id. */
  contexts: Map<string, string>;
}

/**
 * Read the canonical deny rules from a guardrail's deny.json in the checkout.
 *
 * Mirrors adapters' loadCanonicalDeny (kept independent here to avoid a package
 * inversion — catalog does not depend on adapters): a claude guardrail declares
 * a non-empty deny list, so an absent file, a missing/non-array `deny` field, or
 * an empty array is a broken catalog and fails closed (CatalogParseError → the
 * caller's fail-closed exit under `--remote`). Malformed JSON keeps throwing
 * InvalidJsonError from readJson.
 */
async function readCanonDeny(denyJsonPath: string): Promise<string[]> {
  const raw = await readJson(denyJsonPath);
  const deny = raw['deny'];
  const rules = Array.isArray(deny) ? deny.filter((x): x is string => typeof x === 'string') : [];
  if (rules.length === 0) {
    throw new CatalogParseError(
      `guardrail canon: deny.json is absent or empty at ${denyJsonPath} — a claude guardrail requires a non-empty deny list`,
      [`deny.json absent or empty at ${denyJsonPath}`],
    );
  }
  return rules;
}

/**
 * Read the canonical allow rules from a guardrail's allow.json in the checkout.
 *
 * Mirrors adapters' loadCanonicalAllow: an absent or empty allow artifact is
 * valid and yields []. Malformed JSON keeps throwing InvalidJsonError.
 */
async function readCanonAllow(allowJsonPath: string): Promise<string[]> {
  const raw = await readJson(allowJsonPath);
  const allow = raw['allow'];
  if (!Array.isArray(allow)) {
    return [];
  }
  return allow.filter((x): x is string => typeof x === 'string');
}

/**
 * Read the canonical native opencode `permission` descriptor from a guardrail's
 * permission.json in the checkout.
 *
 * Mirrors adapters' loadCanonicalOpencodePermission (kept independent here to
 * avoid a package inversion — catalog does not depend on adapters): a native
 * opencode guardrail REQUIRES a hand-authored, non-empty `permission` object
 * (ADR-0020 "Option A" — there is never a fallback to Claude-rule translation),
 * so an absent file, a missing/non-object/array `permission` field, or an empty
 * object is a broken catalog and fails closed (CatalogParseError → the caller's
 * fail-closed exit under `--remote`), exactly as the claude deny.json path.
 * Malformed JSON keeps throwing InvalidJsonError from readJson.
 */
async function readCanonPermission(permissionJsonPath: string): Promise<OpencodePermission> {
  const raw = await readJson(permissionJsonPath);
  const permission = raw['permission'];
  if (
    permission === null
    || typeof permission !== 'object'
    || Array.isArray(permission)
    || Object.keys(permission).length === 0
  ) {
    throw new CatalogParseError(
      `guardrail canon: permission.json is absent or empty at ${permissionJsonPath} — a native `
        + 'opencode guardrail requires a non-empty "permission" object',
      [`permission.json absent or empty at ${permissionJsonPath}`],
    );
  }
  return permission as OpencodePermission;
}

/**
 * Fetches the differential canon of one configured catalog.
 *
 * Clones `url` at `version` (shallow, cleanup guaranteed by `withRemoteCheckout`),
 * validates catalog.json, then reads the per-nature content files WHILE the
 * checkout is still on disk (post-cutover layout, R9 — per-assistant dirs):
 *  - guardrail (claude-targeted): claude/guardrails/<name>/deny.json + allow.json.
 *  - guardrail (opencode-targeted): opencode/guardrails/<name>/permission.json (the
 *    native opencode descriptor, ADR-0020 "Option A" — same path the install
 *    builder, opencode-adapter-builder.ts, loads). A guardrail targeting BOTH
 *    assistants reads BOTH forms, each from its assistant's dir.
 *  - context: <assistant>/contexts/<name>/AGENTS.md (S8; absent → '', install parity).
 *  - mcp: config stays inline in the entry — no file read.
 * Names are derived from the entry id (prefix stripped) and guarded by
 * `assertSafeArtifactName` before any path join, exactly as the install builder.
 *
 * `version` is carried into the returned canon verbatim; provenance (the on-disk
 * sha matching the resolved one) is enforced by `opts.expectedSha` when the
 * caller supplies it — see `withRemoteCheckout`.
 *
 * Throws RemoteFetchError / RefShaMismatchError on clone/provenance failure,
 * CatalogParseError on an invalid catalog.json or a broken guardrail canon,
 * InvalidJsonError on malformed content JSON, and
 * InvalidRemoteUrlError / InvalidRemoteRefError for unsafe inputs.
 */
export async function fetchCatalogCanon(
  name: string,
  url: string,
  version: ResolvedVersion,
  run: CommandRunner,
  opts: { tmpFactory: TmpDirFactory; expectedSha?: string },
): Promise<CatalogCanon> {
  return withRemoteCheckout(url, version.ref, version.isTag, run, opts, async (dir) => {
    const { meta, entries } = await readCatalogDir(dir);

    const guardrails = new Map<string, { deny: string[]; allow: string[] }>();
    const guardrailPermissions = new Map<string, OpencodePermission>();
    const contexts = new Map<string, string>();

    for (const entry of entries) {
      if (entry.kind !== 'artifact') continue;

      if (entry.nature === 'guardrail') {
        const local = localId(entry.id).replace(/^guardrail:/, '');
        assertSafeArtifactName(local, entry.id);
        // Post-cutover (R9): each form lives under its assistant's dir — a
        // bi-target guardrail is read from BOTH claude/ and opencode/, exactly
        // where the install builders load them.
        if (entry.targets.includes('claude')) {
          const claudeDir = join(dir, CHECKOUT_CLAUDE, 'guardrails', local);
          const [deny, allow] = await Promise.all([
            readCanonDeny(join(claudeDir, 'deny.json')),
            readCanonAllow(join(claudeDir, 'allow.json')),
          ]);
          guardrails.set(entry.id, { deny, allow });
        }
        if (entry.targets.includes('opencode')) {
          const opencodeDir = join(dir, CHECKOUT_OPENCODE, 'guardrails', local);
          guardrailPermissions.set(
            entry.id,
            await readCanonPermission(join(opencodeDir, 'permission.json')),
          );
        }
      } else if (entry.nature === 'context') {
        const local = localId(entry.id).replace(/^context:/, '');
        assertSafeArtifactName(local, entry.id);
        // Post-cutover (R9): a context lives under its assistant's dir. The canon
        // map holds ONE block per id, so this COLLAPSES a bi-target context to a
        // single assistant's form — preferring claude (S8: contexts are
        // mono-target in practice; the real entry targets claude, and no id is
        // renamed at this change — Hors périmètre). The pin in fetch.test.ts
        // ('bi-target context canon collapses to the claude form (S8)') freezes
        // this collapse so that lifting the S8 mono-target assumption (a
        // genuinely per-assistant context, differing bytes per dir) turns red and
        // forces a two-form canon here.
        //
        // This is a DRIFT-DETECTION gap, not a security hole: the pre-apply scan
        // still covers BOTH dirs (scanPathFor returns one per target, R9.4), so
        // no unscanned bytes install. Only doctor --remote's host-vs-canon
        // coincidence check would miss a drift in the opencode form of a
        // (hypothetical) bi-target context whose two forms diverge.
        const assistant = entry.targets.includes('claude')
          ? CHECKOUT_CLAUDE
          : (entry.targets[0] ?? CHECKOUT_CLAUDE);
        contexts.set(
          entry.id,
          await readText(join(dir, assistant, 'contexts', local, 'AGENTS.md')),
        );
      }
    }

    return { name, meta, version, entries, guardrails, guardrailPermissions, contexts };
  });
}

// ---------------------------------------------------------------------------
// isUpdateAvailable
// ---------------------------------------------------------------------------

/**
 * Returns true when the remote version represents an update over what is
 * currently installed.
 *
 * R2 (lot 6, D2): `installedSha`, when known (non-empty), is authoritative —
 * it primes over the ref/semver comparison below, in BOTH directions:
 *   - differs from `remote.sha` → stale, even under an unchanged ref name
 *     (a tag re-pushed to a new commit is a real update that a ref-only
 *     comparison can never see: `compareSemver` reads 0 for an identical
 *     name).
 *   - equals `remote.sha`       → NOT stale, even under a changed ref name
 *     (the remote lost its tags and fell back to HEAD, which happens to be
 *     the exact commit already installed — nothing actually changed; the
 *     symmetric case, a renamed ref over identical content, is not an
 *     update either).
 *
 * `installedSha === ''` marks a legacy manifest entry recorded before sha
 * tracking existed (`ManifestEntry.sha`, core/types.ts:203, mandatory only
 * going forward — `readManifest` stays entry-shape-tolerant, so an on-disk
 * entry written by a pre-lot6 build can still lack it at runtime). The sha
 * comparison is skipped entirely and this degrades to the pre-R2 ref/semver
 * comparison: when `remote.isTag` is true AND `installedRef` is a valid
 * semver tag, `compareSemver` gives a precise version comparison; otherwise
 * falls back to ref/sha string equality (sha-to-sha, sha-to-tag, or
 * non-semver ref). Documented, not "fixed": a same-name re-push stays
 * invisible for these entries, exactly as before R2.
 */
export function isUpdateAvailable(
  installedRef: string,
  installedSha: string,
  remote: ResolvedVersion,
): boolean {
  if (installedSha !== '') {
    return installedSha !== remote.sha;
  }

  if (remote.isTag) {
    const remoteParsed = parseSemver(remote.ref);
    const installedParsed = parseSemver(installedRef);
    if (remoteParsed !== undefined && installedParsed !== undefined) {
      return compareSemver(remoteParsed, installedParsed) > 0;
    }
  }
  // Fallback: compare by ref and sha equality.
  return installedRef !== remote.sha && installedRef !== remote.ref;
}
