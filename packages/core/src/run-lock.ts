/**
 * Inter-process run lock for agent-rigger (R7 / design D7).
 *
 * apply() and remove() bracket a read-modify-write window over state.json that
 * also spawns slow external processes (`claude plugin marketplace add/install`).
 * Two concurrent runs therefore race: writeJson's tmp+rename keeps the file from
 * being torn, but NOT from a logical lost update (run B overwrites run A's freshly
 * recorded entry). This lock serialises those windows across processes; the
 * engine re-read/merge (see engine.ts) is the second, defence-in-depth layer.
 *
 * Design invariants:
 * - Exclusive creation via fs.open(lockPath, 'wx') (O_CREAT|O_EXCL) — the kernel
 *   guarantees exactly one creator wins the race, no user-space TOCTOU.
 * - The lock records {pid, startedAt}. A lock is STALE only when BOTH its mtime
 *   is older than the TTL AND its pid is dead (process.kill(pid, 0) throws): a
 *   long-running legit run (alive pid, old mtime) is never broken, and a very
 *   recent crash (dead pid, fresh mtime) waits out the TTL so a reused pid can't
 *   trigger a wrongful break.
 * - A live conflict throws the typed ConcurrentRunError — NEVER process.exit()
 *   (the CLI maps it to an exit code). Fast-fail, never block/spin.
 * - release() unlinks the lockfile, best-effort and idempotent.
 *
 * The lockfile path is `<manifestPath>.lock`.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

/**
 * Thrown by acquireRunLock when another agent-rigger run holds the lock and is
 * NOT stale (its pid is alive, or the TTL has not elapsed). The CLI maps this to
 * a stable exit code; core never calls process.exit().
 */
export class ConcurrentRunError extends Error {
  /** Absolute path of the contended lockfile. */
  readonly lockPath: string;
  /** The pid recorded in the held lock (-1 when the lock content was unreadable). */
  readonly pid: number;

  constructor(lockPath: string, pid: number) {
    super(
      `Another agent-rigger run is in progress (pid ${pid}). `
        + `The lockfile is "${lockPath}". Wait for it to finish and retry; `
        + 'if you are sure no run is active, delete the lockfile by hand.',
    );
    this.name = 'ConcurrentRunError';
    this.lockPath = lockPath;
    this.pid = pid;
  }
}

// ---------------------------------------------------------------------------
// RunLock handle
// ---------------------------------------------------------------------------

/**
 * A held run lock. release() unlinks the lockfile; it is idempotent and never
 * throws (a lock already gone is a success). Callers MUST release in a finally.
 */
export interface RunLock {
  /** Absolute path of the held lockfile. */
  readonly path: string;
  /** Remove the lockfile. Idempotent, best-effort, never throws. */
  release(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** The stored lock payload. */
interface LockRecord {
  pid: number;
  startedAt: string;
}

export interface AcquireRunLockOptions {
  /**
   * Staleness TTL in milliseconds, measured against the lockfile mtime. A lock
   * older than this AND whose pid is dead is considered stale. Default 15 min —
   * comfortably longer than a slow `claude plugin install`, so a live run is
   * never mistaken for stale.
   */
  ttlMs?: number;
  /** Injectable clock (ms since epoch). Defaults to Date.now. */
  now?: () => number;
  /** Injectable liveness probe. Defaults to a process.kill(pid, 0) check. */
  pidAlive?: (pid: number) => boolean;
  /** Sink for the "breaking a stale lock" notice. Defaults to a no-op. */
  warn?: (message: string) => void;
}

/** Default TTL: 15 minutes. */
const DEFAULT_TTL_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// pid liveness
// ---------------------------------------------------------------------------

/**
 * True when `pid` names a live process. process.kill(pid, 0) sends no signal but
 * performs the permission/existence check: ESRCH → dead; EPERM → alive (exists,
 * owned by another user). Any other error is treated conservatively as alive.
 */
function defaultPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM (or anything else) → the process exists / we can't prove it dead.
    return true;
  }
}

function isEExist(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'EEXIST';
}

// ---------------------------------------------------------------------------
// staleness
// ---------------------------------------------------------------------------

/**
 * Read the held lock and decide whether it is stale. Stale requires BOTH the
 * mtime past the TTL AND the recorded pid dead. A lock that vanished between the
 * failed create and this read is treated as breakable (stale) so the retry can
 * proceed.
 *
 * `startedAt` echoes the observed record's identity (undefined when the content
 * was unreadable/corrupt) so the caller can compare-and-swap: after moving the
 * lock aside it verifies it broke the SAME record it judged stale, not a fresh
 * holder that replaced it in the read→break window.
 */
async function evaluateStale(
  lockPath: string,
  ttlMs: number,
  now: () => number,
  pidAlive: (pid: number) => boolean,
): Promise<{ stale: boolean; pid: number; startedAt: string | undefined }> {
  let pid = -1;
  let startedAt: string | undefined;
  try {
    const raw = await readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LockRecord>;
    if (typeof parsed.pid === 'number') pid = parsed.pid;
    if (typeof parsed.startedAt === 'string') startedAt = parsed.startedAt;
  } catch {
    // Unreadable or corrupt content: leave pid = -1 (treated as dead below).
  }

  let mtimeMs: number;
  try {
    mtimeMs = (await stat(lockPath)).mtimeMs;
  } catch {
    // The lock disappeared under us — the holder released it. Breakable.
    return { stale: true, pid, startedAt };
  }

  const ttlExceeded = now() - mtimeMs > ttlMs;
  const dead = pid < 0 ? true : !pidAlive(pid);
  return { stale: ttlExceeded && dead, pid, startedAt };
}

/**
 * Read a lockfile's {pid, startedAt} identity, or undefined when the file is
 * gone/unreadable. Used by the compare-and-swap after a stale lock is moved
 * aside, to confirm the moved record matches the one judged stale.
 */
async function readLockIdentity(
  lockPath: string,
): Promise<{ pid: number; startedAt: string | undefined } | undefined> {
  try {
    const raw = await readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LockRecord>;
    return {
      pid: typeof parsed.pid === 'number' ? parsed.pid : -1,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * True when two lock identities name the SAME record (same pid and same
 * startedAt). A corrupt record (pid -1, startedAt undefined) compared to itself
 * still matches — a corrupt stale lock stays breakable.
 */
function sameIdentity(
  a: { pid: number; startedAt: string | undefined },
  b: { pid: number; startedAt: string | undefined },
): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt;
}

// ---------------------------------------------------------------------------
// acquireRunLock
// ---------------------------------------------------------------------------

function makeLock(lockPath: string): RunLock {
  let released = false;
  return {
    path: lockPath,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await unlink(lockPath).catch(() => {
        // Already gone (someone broke it as stale, or a double release) — fine.
      });
    },
  };
}

async function createLock(lockPath: string): Promise<RunLock> {
  const handle = await open(lockPath, 'wx');
  try {
    const record: LockRecord = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    await handle.writeFile(JSON.stringify(record));
  } finally {
    await handle.close();
  }
  return makeLock(lockPath);
}

/**
 * Acquire the run lock for `manifestPath`, returning a handle whose release()
 * unlinks it. Throws ConcurrentRunError when a live (non-stale) run holds it.
 * A stale lock (TTL exceeded + pid dead) is broken with a warning and the run
 * proceeds.
 *
 * At most one stale break is attempted: after breaking, a single re-acquire is
 * tried; if a fresh holder won the race in between, ConcurrentRunError is thrown
 * rather than looping.
 */
export async function acquireRunLock(
  manifestPath: string,
  options: AcquireRunLockOptions = {},
): Promise<RunLock> {
  const lockPath = `${manifestPath}.lock`;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const pidAlive = options.pidAlive ?? defaultPidAlive;

  // The manifest dir may not exist yet on a fresh install; O_EXCL needs it.
  await mkdir(dirname(lockPath), { recursive: true });

  try {
    return await createLock(lockPath);
  } catch (err) {
    if (!isEExist(err)) throw err;
  }

  // A lock already exists — evaluate staleness.
  const observed = await evaluateStale(lockPath, ttlMs, now, pidAlive);
  if (!observed.stale) {
    throw new ConcurrentRunError(lockPath, observed.pid);
  }

  // Break the stale lock ATOMICALLY, then retry exactly once.
  //
  // A plain unlink+create is not safe under concurrency: two recoverers B and C
  // that both judged the same stale lock L would each unlink() by PATH and each
  // create — but C's unlink(lockPath) would blindly delete the fresh lock B just
  // created, so both would believe they hold the lock (R7 mutual-exclusion
  // violated). Instead we rename the observed stale lock to a unique name: only
  // ONE process can win the rename of a given inode, and a rename never touches
  // a lock created AFTER it under the same path.
  options.warn?.(
    `Breaking a stale run lock at "${lockPath}" (pid ${observed.pid} is not alive and the `
      + 'lock is older than the timeout). A previous run likely crashed.',
  );

  const brokenPath = `${lockPath}.stale-${process.pid}-${randomUUID().slice(0, 8)}`;
  let moved = false;
  try {
    await rename(lockPath, brokenPath);
    moved = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // The lock was already broken/released by someone else — fall through to the
    // exclusive create, which settles the winner via O_EXCL.
  }

  if (moved) {
    // Compare-and-swap: confirm we moved the SAME record we judged stale. If a
    // fresh run replaced the stale lock in the read→rename window, we just moved
    // its live lock aside by mistake — restore it and fail fast rather than run
    // concurrently with it.
    const brokenIdentity = await readLockIdentity(brokenPath);
    if (brokenIdentity !== undefined && !sameIdentity(brokenIdentity, observed)) {
      await rename(brokenPath, lockPath).catch(() => {
        // Best-effort restore; the create below still guards mutual exclusion.
      });
      throw new ConcurrentRunError(lockPath, brokenIdentity.pid);
    }
    // Confirmed stale (or vanished) — discard the moved-aside record.
    await unlink(brokenPath).catch(() => {});
  }

  try {
    return await createLock(lockPath);
  } catch (err) {
    if (!isEExist(err)) throw err;
    // A fresh run grabbed the lock in the break→recreate window. It is the
    // legitimate holder now — fail fast rather than spin.
    const again = await evaluateStale(lockPath, ttlMs, now, pidAlive);
    throw new ConcurrentRunError(lockPath, again.pid);
  }
}
