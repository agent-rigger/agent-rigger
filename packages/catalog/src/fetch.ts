import { join } from 'node:path';

import { type CatalogEntry, CatalogEntrySchema } from './schema';
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
      `URL distante non autorisée: "${url}". Formes acceptées: https://, http://, ssh://, git@host:owner/repo, /chemin/absolu.`,
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
      `Référence git non autorisée: "${ref}". La ref ne peut pas être vide ni commencer par '-'.`,
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
// Prerelease strings are compared lexicographically when both sides have one.
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
 * Compares two parsed semver values.
 * Returns a positive number when a > b, negative when a < b, 0 when equal.
 * Used for descending sort (negate the comparator in Array.sort).
 */
function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  // Releases beat prereleases.
  if (a.pre === undefined && b.pre !== undefined) return 1;
  if (a.pre !== undefined && b.pre === undefined) return -1;
  if (a.pre !== undefined && b.pre !== undefined) {
    // Lexicographic comparison between prerelease strings is sufficient for M1-a.
    if (a.pre < b.pre) return -1;
    if (a.pre > b.pre) return 1;
  }
  return 0;
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
      'HEAD introuvable : ls-remote HEAD a renvoyé une sortie vide',
    );
  }

  return { ref: sha, sha, isTag: false };
}

// ---------------------------------------------------------------------------
// fetchCatalog — shallow clone + catalog.json validation
// ---------------------------------------------------------------------------

/** The result of a successful catalog fetch. */
export interface FetchedCatalog {
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
 * Performs a shallow clone of `url` at `ref` into a temporary directory,
 * executes `fn(checkoutDir)`, then cleans up the directory unconditionally.
 *
 * Guarantees:
 *  - `assertSafeRemoteUrl` and `assertSafeRef` are called before any tmp allocation.
 *  - cleanup runs in `finally`, covering success, clone failure, and `fn` throw.
 *
 * Returns the value returned by `fn`.
 * Throws RemoteFetchError when git clone exits non-zero.
 * Throws InvalidRemoteUrlError / InvalidRemoteRefError for unsafe inputs.
 */
export async function withRemoteCheckout<T>(
  url: string,
  ref: string,
  run: CommandRunner,
  opts: { tmpFactory: TmpDirFactory },
  fn: (checkoutDir: string) => Promise<T>,
): Promise<T> {
  assertSafeRemoteUrl(url);
  assertSafeRef(ref);

  const { path, cleanup } = await opts.tmpFactory();

  try {
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
 * - Reads `<dir>/catalog.json`.
 * - Parses the JSON, checks it is an array.
 * - Validates each element via Zod (CatalogEntrySchema).
 * - Returns the validated entries.
 *
 * Throws CatalogParseError when:
 *  - catalog.json is absent.
 *  - the file contains invalid JSON.
 *  - the root value is not an array.
 *  - one or more entries fail Zod validation (issues array populated).
 */
export async function readCatalogDir(dir: string): Promise<CatalogEntry[]> {
  // Step 1 — read catalog.json from the directory.
  const catalogPath = join(dir, 'catalog.json');
  const catalogFile = Bun.file(catalogPath);
  const fileExists = await catalogFile.exists();
  if (!fileExists) {
    throw new CatalogParseError('catalog.json introuvable dans le content repo', [
      'catalog.json introuvable',
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

  // Step 3 — must be an array.
  if (!Array.isArray(raw)) {
    throw new CatalogParseError("catalog.json doit être un tableau d'entrées", [
      "catalog.json doit être un tableau d'entrées",
    ]);
  }

  // Step 4 — validate each entry via Zod.
  const entries: CatalogEntry[] = [];
  const issues: string[] = [];

  for (let i = 0; i < raw.length; i++) {
    const parsed = CatalogEntrySchema.safeParse(raw[i]);
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
      `catalog.json contient des entrées invalides: ${issues.join('; ')}`,
      issues,
    );
  }

  return entries;
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
 * Throws RemoteFetchError when any git command exits non-zero.
 * Throws CatalogParseError when catalog.json is absent, malformed, or invalid.
 * Throws InvalidRemoteUrlError / InvalidRemoteRefError for unsafe inputs.
 */
export async function fetchCatalog(
  url: string,
  ref: string,
  run: CommandRunner,
  opts: { tmpFactory: TmpDirFactory },
): Promise<FetchedCatalog> {
  return withRemoteCheckout(url, ref, run, opts, async (dir) => {
    const entries = await readCatalogDir(dir);

    // Resolve HEAD sha of the clone.
    const revParseResult = await run('git', ['-C', dir, 'rev-parse', 'HEAD']);
    if (revParseResult.exitCode !== 0) {
      throw new RemoteFetchError(url, revParseResult.stderr ?? '');
    }
    const sha = (revParseResult.stdout ?? '').trim();

    return { entries, sha };
  });
}
