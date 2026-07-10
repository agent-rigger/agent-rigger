/**
 * Backup helper for agent-rigger.
 *
 * Invariants:
 * - backup-before-write is enforced by the engine; this module is pure I/O.
 * - File absent → no-op, returns null.
 * - File present → copy to <path>.bak-<ISO>-<token>, return the backup path.
 *
 * Anti-collision by construction: a short random token is appended, so two
 * backups of the same file (even within the same millisecond) never collide —
 * no existence-probing loop required.
 *
 * Bun-native: Bun.file() for existence/read, Bun.write() for the copy.
 */

import { randomUUID } from 'node:crypto';
import { cp, lstat, rename, rm } from 'node:fs/promises';

import { atomicWriteBytes } from './fs-json';

/**
 * Format a Date as an ISO-8601 string safe for use in file names.
 * Colons are replaced with dashes (`2026-06-21T14-30-00.000Z`).
 */
function toFsSafeIso(date: Date): string {
  return date.toISOString().replace(/:/g, '-');
}

/**
 * Build the backup destination for `sourcePath`: `<sourcePath>.bak-<ISO>-<token>`.
 * Shared by backup() and backupDir() so both families of .bak entries follow
 * the exact same naming convention. The 8-char random token guarantees
 * distinct names for rapid successive calls without any retry loop.
 */
function backupDest(sourcePath: string): string {
  return `${sourcePath}.bak-${toFsSafeIso(new Date())}-${randomUUID().slice(0, 8)}`;
}

/**
 * If `filePath` exists, copy it to `<filePath>.bak-<ISO>-<token>` and return the
 * backup path. Returns `null` if the file does not exist.
 */
export async function backup(filePath: string): Promise<string | null> {
  const source = Bun.file(filePath);
  if (!(await source.exists())) {
    return null;
  }

  const dest = backupDest(filePath);
  // Staged write (tmp + rename): a crash never leaves a truncated `.bak` under
  // its final name — the recovery artefact is either whole or absent.
  await atomicWriteBytes(dest, await source.arrayBuffer());
  return dest;
}

/**
 * If `dirPath` exists, copy it recursively to `<dirPath>.bak-<ISO>-<token>` and
 * return the backup path. Returns `null` if the path does not exist.
 *
 * Store-level counterpart of backup() (R3, lot2-remove-reversible): a rigger
 * store deleted by `remove` may carry user edits made through the install
 * symlink, so its whole tree is preserved next to it before the rm. Also
 * handles single-file stores (agent `<name>.md`) — cp copies those verbatim.
 */
export async function backupDir(dirPath: string): Promise<string | null> {
  const stat = await lstat(dirPath).catch(() => null);
  if (stat === null) {
    return null;
  }

  const dest = backupDest(dirPath);
  // Copy into a staging directory first, then rename(2) it into place: an
  // interrupted or partial recursive copy never appears under the final `.bak`
  // name (a truncated tree is indistinguishable from a real backup otherwise).
  const tmp = `${dest}.tmp-${randomUUID().slice(0, 8)}`;
  try {
    await cp(dirPath, tmp, { recursive: true });
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
  return dest;
}

/**
 * Restore a file from its backup: copy `backupPath` content back over
 * `originalPath`. Used by the engine's transactional rollback to undo writes
 * to files that existed before an apply() run.
 */
export async function restore(backupPath: string, originalPath: string): Promise<void> {
  // Byte-exact staged write (tmp + rename): even mid-rollback — precisely when
  // the system is already degraded — the target ends up as either the original
  // or the complete restoration, never a truncated file.
  await atomicWriteBytes(originalPath, await Bun.file(backupPath).arrayBuffer());
}

/**
 * Delete `filePath` if it exists; no-op when absent. Used by the engine's
 * transactional rollback to remove files that were newly created during a
 * failed apply() run (no backup existed for them).
 */
export async function removeFile(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}

/**
 * Recursively delete `dirPath` if it exists; no-op when absent. Used by the
 * engine's transactional rollback to remove a directory (e.g. the shared hook
 * scriptStore) that did NOT exist before a failed apply() run.
 */
export async function removeDir(dirPath: string): Promise<void> {
  await rm(dirPath, { recursive: true, force: true });
}
