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

import { cp, lstat, mkdir, readlink, rm, symlink as fsSymlink } from 'node:fs/promises';
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

// ---------------------------------------------------------------------------
// syncToStore
// ---------------------------------------------------------------------------

/**
 * Copy `sourcePath` (file or directory) to `storePath`, overwriting whatever
 * was there before. Parent directories of `storePath` are created as needed.
 *
 * For directories the store is replaced atomically: the old tree is removed
 * before the new copy is written, so no stale entries survive a re-sync.
 */
export async function syncToStore(sourcePath: string, storePath: string): Promise<void> {
  await mkdir(path.dirname(storePath), { recursive: true });

  const srcStat = await lstat(sourcePath);

  if (srcStat.isDirectory()) {
    const storeExists = await lstat(storePath).then(() => true).catch(() => false);
    if (storeExists) {
      await rm(storePath, { recursive: true, force: true });
    }
    await cp(sourcePath, storePath, { recursive: true });
  } else {
    await cp(sourcePath, storePath);
  }
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
