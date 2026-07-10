/**
 * Store-and-link mechanics for agent-rigger.
 *
 * Three operations:
 *
 * 1. syncToStore  — mirror a source (file or directory) into the managed store
 *                   (the single physical copy).
 * 2. linkOrCopy   — ensure a target path points at the store via a symlink;
 *                   falls back to a plain copy when symlinks are unavailable.
 * 3. link         — compose both steps and return a result summary.
 *
 * Design invariants:
 * - No process.exit(), no while loops.
 * - opts.symlink is injectable so tests can force the fallback path.
 * - All parent directories are created automatically.
 * - Bun-native where natural; node:fs/promises for symlink/lstat/readlink.
 */

import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink as fsSymlink,
} from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How the target was connected to the store. */
export type LinkMethod = 'symlink' | 'copy';

/** Options for linkOrCopy / link — the symlink function is injectable for tests. */
export interface LinkOptions {
  /**
   * Override the symlink implementation. Throw to trigger the copy fallback.
   * Signature mirrors `fs.promises.symlink(target, path)`.
   */
  symlink?: (target: string, dest: string) => Promise<void>;
}

/** Result returned by link(). */
export interface LinkResult {
  method: LinkMethod;
  store: string;
  target: string;
}

/** Options for syncToStore. */
export interface SyncOptions {
  /**
   * Glob patterns (basename only) for files already present in the store that
   * must survive a re-sync even when absent from the source directory.
   * Typical use: `['guard-*.log']` to preserve runtime logs written by hook
   * guard scripts after each install.
   *
   * Only effective when `sourcePath` is a directory.
   * Uses Bun.Glob for matching — patterns follow minimatch/glob conventions.
   */
  preserveGlobs?: string[];
}

// ---------------------------------------------------------------------------
// unlink
// ---------------------------------------------------------------------------

/**
 * Remove `target` (symlink, file, or directory) and `store` (file or directory)
 * from the filesystem.
 *
 * Both removals are tolerant to absence: if either path does not exist, the
 * operation is a no-op for that path (no error is thrown).
 *
 * @param target  Path to the symlink or installed file/directory.
 * @param store   Path to the managed store entry (physical copy).
 */
export async function unlink(target: string, store: string): Promise<void> {
  await Promise.all([
    rm(target, { recursive: true, force: true }),
    rm(store, { recursive: true, force: true }),
  ]);
}

// ---------------------------------------------------------------------------
// unlinkTarget
// ---------------------------------------------------------------------------

/**
 * Remove only `target` (symlink, file, or directory), leaving the store
 * untouched. Tolerant to absence: a non-existent target is a no-op.
 *
 * Companion of removeStoreIfUnreferenced() — together they implement the
 * "one store, N symlinks" removal contract (ADR-0020 §3): deleting one
 * assistant's symlink must never destroy a store still referenced by another.
 *
 * @param target  Path to the symlink or installed file/directory.
 */
export async function unlinkTarget(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// resolvesToStore
// ---------------------------------------------------------------------------

/**
 * True when `candidate` is a symlink whose value resolves to `store`.
 *
 * Detection uses filesystem truth, fully offline:
 * - the candidate is lstat'd; absent or non-symlink entries are false
 *   (copy-fallback installs are NOT recognized as rigger-managed links);
 * - the symlink value is resolved relative to the symlink's own directory, so
 *   both absolute and relative link values are compared against the store.
 *
 * Shared predicate of the "one store, N symlinks" contract (ADR-0020 §3):
 * removeStoreIfUnreferenced uses it to count live references, and the R3
 * removal gate (claude skills/agents) uses it to refuse deleting a target
 * that rigger does not manage.
 *
 * @param candidate  Install target path to test.
 * @param store      Path to the managed store entry.
 */
export async function resolvesToStore(candidate: string, store: string): Promise<boolean> {
  const stat = await lstat(candidate).catch(() => null);
  if (stat === null || !stat.isSymbolicLink()) {
    return false;
  }
  const linkValue = await readlink(candidate).catch(() => null);
  if (linkValue === null) {
    return false;
  }
  const resolved = path.resolve(path.dirname(candidate), linkValue);
  return resolved === path.resolve(store);
}

// ---------------------------------------------------------------------------
// contentMatchesStore
// ---------------------------------------------------------------------------

/**
 * True when `candidate` is a plain file/directory whose content is
 * byte-identical to `store` (same tree shape, same file bytes).
 *
 * Companion of resolvesToStore for COPY-FALLBACK installs (linkOrCopy falls
 * back to a plain copy when symlink() fails, e.g. on a filesystem without
 * symlink support). Such a target carries no link value to compare, but a
 * byte-identical copy of the managed store contains nothing user-authored:
 * removing it destroys no user work (the store backup keeps the bytes). The R3
 * removal gate accepts it as rigger-managed instead of leaving it orphaned
 * forever — the alternative would make remove permanently impossible on a FS
 * where install worked.
 *
 * Fail-safe: any doubt returns false — absent paths, a symlink on either side
 * (a store never contains symlinks; a copy of it cannot either), a file/dir
 * type mismatch, differing entry lists, or differing bytes.
 *
 * @param candidate  Install target path to test (plain copy suspected).
 * @param store      Path to the managed store entry.
 */
export async function contentMatchesStore(candidate: string, store: string): Promise<boolean> {
  const [candStat, storeStat] = await Promise.all([
    lstat(candidate).catch(() => null),
    lstat(store).catch(() => null),
  ]);
  if (candStat === null || storeStat === null) {
    return false;
  }
  if (candStat.isSymbolicLink() || storeStat.isSymbolicLink()) {
    return false;
  }
  if (candStat.isDirectory() !== storeStat.isDirectory()) {
    return false;
  }

  if (!candStat.isDirectory()) {
    const [candBytes, storeBytes] = await Promise.all([
      readFile(candidate),
      readFile(store),
    ]);
    return candBytes.equals(storeBytes);
  }

  const [candEntries, storeEntries] = await Promise.all([
    readdir(candidate),
    readdir(store),
  ]);
  const candSorted = [...candEntries].sort();
  const storeSorted = [...storeEntries].sort();
  if (
    candSorted.length !== storeSorted.length
    || candSorted.some((name, i) => name !== storeSorted[i])
  ) {
    return false;
  }
  for (const name of candSorted) {
    if (!(await contentMatchesStore(path.join(candidate, name), path.join(store, name)))) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// removeStoreIfUnreferenced
// ---------------------------------------------------------------------------

/**
 * Delete `store` unless at least one of `candidateTargets` is a symlink that
 * resolves to it (ADR-0020 §3 — one store, N symlinks). Reference detection
 * delegates to resolvesToStore (see its contract for the offline semantics).
 *
 * Store removal is tolerant to absence (rm force).
 *
 * @param store             Path to the managed store entry.
 * @param candidateTargets  Install target paths that may reference the store.
 * @returns true when the store was removed, false when a live reference kept it.
 */
export async function removeStoreIfUnreferenced(
  store: string,
  candidateTargets: string[],
): Promise<boolean> {
  for (const candidate of candidateTargets) {
    if (await resolvesToStore(candidate, store)) {
      return false;
    }
  }

  await rm(store, { recursive: true, force: true });
  return true;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Return true if `basename` matches any of the provided glob patterns.
 * Uses Bun.Glob — patterns are basename-only (no path separators).
 */
function matchesAnyGlob(basename: string, globs: string[]): boolean {
  for (const pattern of globs) {
    const glob = new Bun.Glob(pattern);
    if (glob.match(basename)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// SymlinkInContentError / assertNoClonedSymlinks
// ---------------------------------------------------------------------------

/**
 * Thrown when content cloned from an untrusted source (a catalog skill, agent,
 * or hook fetched remotely) is, or contains, a symlink. Scanners such as
 * gitleaks/trivy do not follow symlinks, so a malicious link passes a scan
 * gate empty-handed; if it were then copied into the managed store, the
 * install symlink would re-expose whatever host path it points at (e.g.
 * `secret -> ~/.ssh/id_rsa`). This is a hard, fail-closed rejection raised
 * before any file operation is performed on the offending content.
 */
export class SymlinkInContentError extends Error {
  /** Path of the offending symlink, relative to the content root when known. */
  readonly path: string;

  constructor(offendingPath: string) {
    super(`Symlink in cloned content (rejected before write): "${offendingPath}"`);
    this.name = 'SymlinkInContentError';
    this.path = offendingPath;
  }
}

/**
 * Reject `sourcePath` if it is, or contains anywhere in its tree, a symlink.
 *
 * Must be called on content cloned from an untrusted source before any of it
 * is written to the managed store. Uses `lstat` throughout, so a dangling
 * symlink is rejected on the link itself, independently of whether its
 * target exists or is readable.
 *
 * - If `sourcePath` is itself a symlink (mono-file source), rejects immediately.
 * - If `sourcePath` is a directory, walks every entry at every depth; the
 *   first symlink found aborts the whole check.
 * - Regular files and directories are otherwise left untouched.
 */
export async function assertNoClonedSymlinks(sourcePath: string): Promise<void> {
  const srcStat = await lstat(sourcePath);

  if (srcStat.isSymbolicLink()) {
    throw new SymlinkInContentError(sourcePath);
  }

  if (srcStat.isDirectory()) {
    await assertSubtreeHasNoSymlinks(sourcePath, sourcePath);
  }
}

/**
 * Recursively lstat every entry under `dirPath`, throwing SymlinkInContentError
 * (path relative to `rootPath`) on the first symlink encountered, at any depth.
 */
async function assertSubtreeHasNoSymlinks(dirPath: string, rootPath: string): Promise<void> {
  const entries = await readdir(dirPath);

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry);
    const entryStat = await lstat(entryPath);

    if (entryStat.isSymbolicLink()) {
      throw new SymlinkInContentError(path.relative(rootPath, entryPath));
    }

    if (entryStat.isDirectory()) {
      await assertSubtreeHasNoSymlinks(entryPath, rootPath);
    }
  }
}

// ---------------------------------------------------------------------------
// syncToStore
// ---------------------------------------------------------------------------

/**
 * Copy `sourcePath` (file or directory) to `storePath`, overwriting whatever
 * was there before. Parent directories of `storePath` are created as needed.
 *
 * Before touching the filesystem, rejects `sourcePath` via
 * assertNoClonedSymlinks if it is, or contains, a symlink — no byte is
 * written to the store when that guard trips.
 *
 * **Default behaviour (no opts.preserveGlobs):** for directories the store is
 * replaced atomically — the old tree is removed before the new copy is written,
 * so no stale entries survive a re-sync.
 *
 * **With opts.preserveGlobs:** files already present in the store whose basename
 * matches one of the provided glob patterns are left untouched. All other files
 * in the store that are not present in the source are removed (mirror contract
 * preserved for source files). Source files are always copied into the store,
 * overwriting any existing copy. This mode is used by hook installs to preserve
 * runtime `guard-*.log` files written by guard scripts.
 *
 * @param sourcePath  Source file or directory.
 * @param storePath   Destination in the managed store.
 * @param opts        Optional sync options (see SyncOptions).
 */
export async function syncToStore(
  sourcePath: string,
  storePath: string,
  opts?: SyncOptions,
): Promise<void> {
  await assertNoClonedSymlinks(sourcePath);

  await mkdir(path.dirname(storePath), { recursive: true });

  const srcStat = await lstat(sourcePath);

  if (!srcStat.isDirectory()) {
    await cp(sourcePath, storePath);
    return;
  }

  const preserveGlobs = opts?.preserveGlobs;

  // Non-destructive sync when preserveGlobs is provided.
  if (preserveGlobs !== undefined && preserveGlobs.length > 0) {
    await mkdir(storePath, { recursive: true });

    // Step 1: Remove stale store entries — files/dirs that are neither in the
    // source nor protected by a preserveGlob.
    const storeEntries = await readdir(storePath).catch(() => [] as string[]);
    const srcEntries = new Set(await readdir(sourcePath).catch(() => [] as string[]));

    for (const entry of storeEntries) {
      if (!srcEntries.has(entry) && !matchesAnyGlob(entry, preserveGlobs)) {
        await rm(path.join(storePath, entry), { recursive: true, force: true });
      }
    }

    // Step 2: Copy all source files into the store (overwrite existing).
    const srcList = await readdir(sourcePath);
    for (const entry of srcList) {
      await cp(path.join(sourcePath, entry), path.join(storePath, entry), { recursive: true });
    }

    return;
  }

  // Default destructive sync: rm -rf + cp (clean mirror, no survivors).
  const storeExists = await lstat(storePath).then(() => true).catch(() => false);
  if (storeExists) {
    await rm(storePath, { recursive: true, force: true });
  }
  await cp(sourcePath, storePath, { recursive: true });
}

// ---------------------------------------------------------------------------
// linkOrCopy
// ---------------------------------------------------------------------------

/**
 * Ensure `targetPath` is a symlink pointing at `storePath`.
 *
 * Steps:
 * 1. Create parent directories for `targetPath`.
 * 2. If `targetPath` exists and is already the correct symlink → no-op.
 * 3. Otherwise remove whatever is at `targetPath` and attempt to create the
 *    symlink (using `opts.symlink` if provided, else the real `fs.symlink`).
 * 4. If the symlink attempt throws, fall back to copying `storePath` →
 *    `targetPath` (file or directory, recursive).
 *
 * Returns `'symlink'` or `'copy'` to indicate what was done.
 */
export async function linkOrCopy(
  storePath: string,
  targetPath: string,
  opts?: LinkOptions,
): Promise<LinkMethod> {
  await mkdir(path.dirname(targetPath), { recursive: true });

  const existingStat = await lstat(targetPath).catch(() => null);

  if (existingStat !== null) {
    if (existingStat.isSymbolicLink()) {
      const currentTarget = await readlink(targetPath);
      if (currentTarget === storePath) {
        return 'symlink';
      }
    }
    await rm(targetPath, { recursive: true, force: true });
  }

  const symlinkFn = opts?.symlink ?? ((target: string, dest: string) => fsSymlink(target, dest));

  try {
    await symlinkFn(storePath, targetPath);
    return 'symlink';
  } catch {
    await cp(storePath, targetPath, { recursive: true });
    return 'copy';
  }
}

// ---------------------------------------------------------------------------
// link
// ---------------------------------------------------------------------------

/**
 * Compose syncToStore and linkOrCopy into a single operation.
 *
 * 1. Copies `sourcePath` → `storePath` (overwriting the store).
 * 2. Ensures `targetPath` → `storePath` symlink (or copy fallback).
 *
 * Returns a summary with the method used and the resolved paths.
 */
export async function link(
  sourcePath: string,
  storePath: string,
  targetPath: string,
  opts?: LinkOptions,
): Promise<LinkResult> {
  await syncToStore(sourcePath, storePath);
  const method = await linkOrCopy(storePath, targetPath, opts);

  return { method, store: storePath, target: targetPath };
}
