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

/**
 * Format a Date as an ISO-8601 string safe for use in file names.
 * Colons are replaced with dashes (`2026-06-21T14-30-00.000Z`).
 */
function toFsSafeIso(date: Date): string {
  return date.toISOString().replace(/:/g, '-');
}

/**
 * If `filePath` exists, copy it to `<filePath>.bak-<ISO>-<token>` and return the
 * backup path. Returns `null` if the file does not exist.
 *
 * The 8-char random token guarantees distinct names for rapid successive calls
 * without any retry loop.
 */
export async function backup(filePath: string): Promise<string | null> {
  const source = Bun.file(filePath);
  if (!(await source.exists())) {
    return null;
  }

  const iso = toFsSafeIso(new Date());
  const token = randomUUID().slice(0, 8);
  const dest = `${filePath}.bak-${iso}-${token}`;

  await Bun.write(dest, await source.arrayBuffer());
  return dest;
}
