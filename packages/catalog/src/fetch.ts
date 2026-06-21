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
  const result = await run('git', ['ls-remote', '--tags', url]);

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
  const headResult = await run('git', ['ls-remote', url, 'HEAD']);

  if (headResult.exitCode !== 0) {
    throw new RemoteFetchError(url, headResult.stderr ?? '');
  }

  // Expected format: "<sha>\tHEAD"
  const firstLine = (headResult.stdout ?? '').split('\n')[0]?.trim() ?? '';
  const sha = firstLine.split('\t')[0] ?? '';

  return { ref: sha, sha, isTag: false };
}
