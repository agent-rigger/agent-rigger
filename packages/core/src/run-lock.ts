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
 *
 * Two consumers share the break-the-lock primitive (ADR-0023): normal acquisition
 * (which breaks a lock it just judged stale) and doctor's consented lock repair
 * (which breaks a lock a human agreed to break after `inspectRunLock`). Both go
 * through `breakLockCas`, which re-verifies identity AND liveness at the moment of
 * acting — never a bare unlink. `inspectRunLock` reads the lock read-only, taking
 * nothing, so `doctor diagnose` can report on it without acquiring.
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

/** The identity of a lock record, used for compare-and-swap. */
interface LockIdentity {
  pid: number;
  startedAt: string | undefined;
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
 * Tri-state liveness of a pid, distinguishing the indeterminate EPERM case that
 * `breakLockCas` and `inspectRunLock` must NOT collapse into "alive":
 * - `'dead'`   — ESRCH (no such process) or a non-positive/invalid pid.
 * - `'alive'`  — process.kill(pid, 0) succeeds (the process exists and we own it).
 * - `'unknown'`— EPERM (the process exists but is owned by another user) or any
 *                other error we cannot interpret as proof of death.
 */
export type Liveness = 'dead' | 'alive' | 'unknown';

/**
 * True when `pid` names a live process. process.kill(pid, 0) sends no signal but
 * performs the permission/existence check: ESRCH → dead; EPERM → alive (exists,
 * owned by another user). Any other error is treated conservatively as alive.
 *
 * This BINARY probe drives staleness (`evaluateStale`) where EPERM must count as
 * "alive" so a lock owned by another user is never judged stale. The refactor
 * keeps its semantics untouched.
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

/**
 * Tri-state variant of the liveness probe used by the doctor-facing surfaces
 * (`breakLockCas`, `inspectRunLock`), which must refuse to act on an EPERM pid
 * rather than treat it as plainly alive.
 */
function defaultLiveness(pid: number): Liveness {
  if (!Number.isInteger(pid) || pid <= 0) return 'dead';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    // EPERM (owned by another user) or any other error → indeterminate.
    return 'unknown';
  }
}

function isEExist(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'EEXIST';
}

// ---------------------------------------------------------------------------
// read-only lock state
// ---------------------------------------------------------------------------

/** Raw read-only view of the lockfile: its parsed identity and mtime. */
interface LockState {
  /** The lockfile is present on disk (readable content and/or stat succeeded). */
  present: boolean;
  /** Recorded pid, or -1 when absent/unreadable/corrupt. */
  pid: number;
  /** Recorded startedAt, or undefined when absent/unreadable/corrupt. */
  startedAt: string | undefined;
  /** mtime in ms, or undefined when the file vanished before it could be stat'd. */
  mtimeMs: number | undefined;
}

/**
 * Read a lockfile's identity and mtime WITHOUT taking or mutating it. The content
 * read and the stat are independent: a lock that vanished between them yields
 * `mtimeMs === undefined` (the vanished/breakable signal), while a lock present
 * but with corrupt content yields `pid === -1`.
 */
async function readLockState(lockPath: string): Promise<LockState> {
  let pid = -1;
  let startedAt: string | undefined;
  let present = false;
  try {
    const raw = await readFile(lockPath, 'utf8');
    present = true;
    const parsed = JSON.parse(raw) as Partial<LockRecord>;
    if (typeof parsed.pid === 'number') pid = parsed.pid;
    if (typeof parsed.startedAt === 'string') startedAt = parsed.startedAt;
  } catch {
    // Absent or corrupt content: leave pid = -1 (treated as dead by callers).
  }

  let mtimeMs: number | undefined;
  try {
    mtimeMs = (await stat(lockPath)).mtimeMs;
    present = true;
  } catch {
    // The lock disappeared under us — the holder released it.
    mtimeMs = undefined;
  }

  return { present, pid, startedAt, mtimeMs };
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
  const st = await readLockState(lockPath);
  if (st.mtimeMs === undefined) {
    // The lock disappeared under us — the holder released it. Breakable.
    return { stale: true, pid: st.pid, startedAt: st.startedAt };
  }

  const ttlExceeded = now() - st.mtimeMs > ttlMs;
  const dead = st.pid < 0 ? true : !pidAlive(st.pid);
  return { stale: ttlExceeded && dead, pid: st.pid, startedAt: st.startedAt };
}

/**
 * Read a lockfile's {pid, startedAt} identity, or undefined when the file is
 * gone/unreadable. Used by the compare-and-swap after a stale lock is moved
 * aside, to confirm the moved record matches the one judged stale.
 */
async function readLockIdentity(lockPath: string): Promise<LockIdentity | undefined> {
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
function sameIdentity(a: LockIdentity, b: LockIdentity): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt;
}

// ---------------------------------------------------------------------------
// inspectRunLock — read-only diagnosis (doctor R6)
// ---------------------------------------------------------------------------

/**
 * A read-only snapshot of the lockfile, taken WITHOUT acquiring or mutating it.
 * `doctor diagnose` builds its lock verdict from these raw signals; it never
 * decides here whether the lock is "crash probable" vs "pid recycled" (that needs
 * process-identity inspection, which lives in the diagnosis layer).
 */
export interface RunLockInspection {
  /** The lockfile exists on disk. */
  present: boolean;
  /** Recorded pid, or -1 when the lock is absent/unreadable/corrupt. */
  pid: number;
  /** Recorded startedAt, or undefined when absent/unreadable/corrupt. */
  startedAt: string | undefined;
  /** mtime in ms, or undefined when absent / vanished mid-read. */
  mtimeMs: number | undefined;
  /** Age of the lock in ms (now - mtime), or undefined when mtime is unknown. */
  ageMs: number | undefined;
  /** Tri-state liveness of the recorded pid at inspection time. */
  liveness: Liveness;
}

export interface InspectRunLockOptions {
  /** Injectable clock (ms since epoch). Defaults to Date.now. */
  now?: () => number;
  /** Injectable tri-state liveness probe. Defaults to a process.kill(pid, 0) check. */
  liveness?: (pid: number) => Liveness;
}

/**
 * Inspect the lockfile read-only: pid, startedAt, mtime, age, and the tri-state
 * liveness of the recorded pid. Takes NOTHING (no create, no rename, no unlink) —
 * the only I/O is a readFile and a stat. Absent lock → `present: false`, `pid -1`,
 * `liveness 'dead'`.
 */
export async function inspectRunLock(
  lockPath: string,
  options: InspectRunLockOptions = {},
): Promise<RunLockInspection> {
  const now = options.now ?? Date.now;
  const liveness = options.liveness ?? defaultLiveness;

  const st = await readLockState(lockPath);
  if (!st.present) {
    return {
      present: false,
      pid: -1,
      startedAt: undefined,
      mtimeMs: undefined,
      ageMs: undefined,
      liveness: 'dead',
    };
  }

  const ageMs = st.mtimeMs === undefined ? undefined : Math.max(0, now() - st.mtimeMs);
  const live: Liveness = st.pid < 0 ? 'dead' : liveness(st.pid);

  return {
    present: true,
    pid: st.pid,
    startedAt: st.startedAt,
    mtimeMs: st.mtimeMs,
    ageMs,
    liveness: live,
  };
}

// ---------------------------------------------------------------------------
// breakLockCas — atomic compare-and-swap break (shared by both consumers)
// ---------------------------------------------------------------------------

/** The outcome of a `breakLockCas` attempt. */
export type BreakLockResult =
  /** The observed record was moved aside (or already gone) — the caller may proceed. */
  | { broken: true; pid: number; startedAt: string | undefined }
  /**
   * The break was REFUSED. `reason`:
   * - `'identity-changed'` — a fresh run replaced the observed record in the
   *   read→rename window (CAS mismatch); its live lock was restored. `pid` is the
   *   fresh holder's pid.
   * - `'pid-alive'` — the recorded pid is alive at the moment of acting, and
   *   either no `identify` probe was supplied or it did not confirm the
   *   process foreign (see `BreakLockCasOptions.identify`).
   * - `'eperm'` — the recorded pid's liveness is indeterminate (owned by another
   *   user); we refuse rather than break another user's live run.
   */
  | { broken: false; reason: 'identity-changed' | 'pid-alive' | 'eperm'; pid: number };

export interface BreakLockCasOptions {
  /**
   * Tri-state liveness probe of the recorded pid, evaluated at the moment of
   * acting. Defaults to a process.kill(pid, 0) check.
   */
  liveness?: (pid: number) => Liveness;
  /**
   * Process-identity re-check, consulted ONLY when `liveness` reports the
   * recorded pid `'alive'`. Doctor's R6 "pid recyclé" repair passes this so a
   * process CONFIRMED foreign — re-verified HERE, at the moment of acting,
   * never trusted from the diagnose-time `Finding.evidence` — does not block
   * the break: `'foreign'` lets the CAS proceed as if the pid were dead;
   * `'rigger'` or `'unknown'` still refuse `'pid-alive'`, matching the R6
   * refusal scenario (plausibly-rigger or indeterminate is NEVER broken).
   * Omitted (the default) preserves the original behaviour — ANY alive pid
   * refuses — which is what normal acquisition (no identity concept) relies
   * on; only doctor's consented lock-break op passes this.
   */
  identify?: (pid: number) => Promise<'rigger' | 'foreign' | 'unknown'>;
}

/**
 * Break a lock ATOMICALLY via rename + compare-and-swap, re-verifying identity
 * AND liveness at the moment of acting. This is the primitive shared by normal
 * acquisition (breaking a lock it judged stale) and doctor's consented lock
 * repair (breaking a lock a human agreed to break) — never a bare unlink.
 *
 * A plain unlink+create is not safe under concurrency: two recoverers that both
 * judged the same stale lock L would each unlink() by PATH and each create — but
 * the second unlink(lockPath) would blindly delete the fresh lock the first just
 * created, so both would believe they hold the lock (R7 mutual-exclusion
 * violated). Instead we rename the observed record to a unique name: only ONE
 * process can win the rename of a given inode, and a rename never touches a lock
 * created AFTER it under the same path.
 *
 * Refuses (never touches the lock) when the recorded pid is alive or its liveness
 * is indeterminate (EPERM) — casting a lock aside while its run is live would open
 * two engine writers onto settings.json, protected ONLY by this lock (ADR-0023).
 * The ONE exception is a pid alive-but-CONFIRMED-foreign (`options.identify`
 * returns `'foreign'`, re-checked at this exact call, R6 "pid recyclé") — that
 * is the whole point of the pid-recycled repair: without it, `break-lock`
 * would be unreachable dead code for that finding (it would always refuse
 * `'pid-alive'`, exactly the bug this option fixes).
 *
 * @param observed The identity (pid, startedAt) the caller judged breakable — the
 *   record the CAS must confirm it moved, not a fresh holder that replaced it.
 */
export async function breakLockCas(
  lockPath: string,
  observed: LockIdentity,
  options: BreakLockCasOptions = {},
): Promise<BreakLockResult> {
  const liveness = options.liveness ?? defaultLiveness;

  // Re-verify liveness at the moment of acting: never move aside a lock whose
  // recorded pid is alive (a live run) or indeterminate (EPERM, another user).
  const live: Liveness = observed.pid < 0 ? 'dead' : liveness(observed.pid);
  if (live === 'alive') {
    // The pid-recycled repair's ONE way past this refusal: re-check identity
    // HERE (never trust the finding's diagnose-time evidence) and proceed
    // only when it is freshly confirmed foreign. No `identify` probe (normal
    // acquisition) or a non-'foreign' verdict (rigger/unknown) refuses, same
    // as before this option existed.
    const identity = options.identify === undefined
      ? undefined
      : await options.identify(observed.pid);
    if (identity !== 'foreign') {
      return { broken: false, reason: 'pid-alive', pid: observed.pid };
    }
  } else if (live === 'unknown') {
    return { broken: false, reason: 'eperm', pid: observed.pid };
  }

  const brokenPath = `${lockPath}.stale-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    await rename(lockPath, brokenPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // The lock was already broken/released by someone else — nothing to move;
      // the caller may proceed (the exclusive create still settles the winner).
      return { broken: true, pid: observed.pid, startedAt: observed.startedAt };
    }
    throw err;
  }

  // Compare-and-swap: confirm we moved the SAME record we judged breakable. If a
  // fresh run replaced it in the read→rename window, we just moved its live lock
  // aside by mistake — restore it and refuse rather than let two runs proceed.
  const brokenIdentity = await readLockIdentity(brokenPath);
  if (brokenIdentity !== undefined && !sameIdentity(brokenIdentity, observed)) {
    await rename(brokenPath, lockPath).catch(() => {
      // Best-effort restore; the caller's exclusive create still guards exclusion.
    });
    return { broken: false, reason: 'identity-changed', pid: brokenIdentity.pid };
  }

  // Confirmed the same record (or an unreadable one) — discard the moved copy.
  await unlink(brokenPath).catch(() => {});
  return { broken: true, pid: observed.pid, startedAt: observed.startedAt };
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

  options.warn?.(
    `Breaking a stale run lock at "${lockPath}" (pid ${observed.pid} is not alive and the `
      + 'lock is older than the timeout). A previous run likely crashed.',
  );

  // Break the stale lock via the shared CAS primitive. In acquisition the pid was
  // just judged dead by evaluateStale, so the act-time re-check agrees; we adapt
  // the binary staleness probe to the tri-state one so the two verdicts cannot
  // diverge (an EPERM pid would have been judged alive/non-stale above and never
  // reach this point). A refusal here means a fresh run raced in — back off.
  const broke = await breakLockCas(lockPath, observed, {
    liveness: (pid) => (pidAlive(pid) ? 'alive' : 'dead'),
  });
  if (!broke.broken) {
    throw new ConcurrentRunError(lockPath, broke.pid);
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
