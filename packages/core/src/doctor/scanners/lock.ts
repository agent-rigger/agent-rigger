/**
 * The lock scanner (R6, ADR-0025 §1/§7) — assistant-agnostic, read-only.
 *
 * Wraps `inspectRunLock` (run-lock.ts, T0) into the doctor `Finding` model:
 * it takes NOTHING (no create, no rename, no unlink) — the only I/O is the
 * read-only inspect plus a `readdir` of the lock's directory to find stale
 * break debris. Never acquires, never calls `breakLockCas` — breaking is an
 * act reserved for `applyRepairs` (T4) under explicit consent.
 *
 * Verdict derivation from `RunLockInspection`:
 *   - absent lock              → no lock Finding at all (nothing to report).
 *   - liveness 'dead'          → `lockCrashProbable` (R6 crash scenario).
 *   - liveness 'unknown'       → `lockRefused({reason: 'eperm'})` — the
 *     kill(pid,0) probe itself could not tell (owned by another user).
 *   - liveness 'alive'         → identify the process (see below):
 *       - 'foreign'  → `lockPidRecycledProbable` (R6 pid-recycled scenario).
 *       - 'rigger' / 'unknown' → `lockRefused({reason: 'live'})` — plausibly
 *         (or indeterminately) a live rigger run; never propose a break.
 *
 * Process identity ('rigger' | 'foreign' | 'unknown', R6 "comm ≠ bun/
 * agent-rigger"): the default probe reads `/proc/<pid>/comm` — a plain file
 * read, NEVER a spawn (the diagnose read-only invariant forbids spawning a
 * `ps`/`ps -p` child to answer this). `/proc` does not exist outside Linux
 * (notably macOS, where this scanner's default probe always falls back to
 * 'unknown'): that fallback is exactly the conservative case the model
 * already documents as "never eligible for repair" (see
 * `LockEvidence.identity` in `../finding.ts`) — a missing/unreadable comm is
 * treated the same as an inconclusive one, never as proof of foreignness.
 * Tests inject a fake `identify` to exercise the pid-recycled branch without
 * depending on `/proc`.
 *
 * `diagnose.ts` relies on a DATA-visible contract, not scanner identity: any
 * `lock` Finding with `verdict === 'refused'` means "a live (or
 * indeterminate) run was observed" — diagnose() abstains from every
 * remaining scanner once it sees one (R6 "scan pendant un run vivant"). The
 * CLI (T5) is responsible for placing this scanner FIRST in the `Scanner[]`
 * it assembles so that contract is meaningful (see diagnose.ts's docstring).
 */

import { readdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { inspectRunLock, type Liveness } from '../../run-lock';
import {
  type DoctorContext,
  type DoctorScanner,
  type Finding,
  lockCrashProbable,
  type LockEvidence,
  lockPidRecycledProbable,
  lockRefused,
  lockStaleDebris,
} from '../finding';

// ---------------------------------------------------------------------------
// Process identity probe — read-only, never a spawn
// ---------------------------------------------------------------------------

/** Tri-state process identity, resolved only when the recorded pid is alive. */
export type LockIdentity = 'rigger' | 'foreign' | 'unknown';

/**
 * Read-only process identity probe: 'rigger' when the process command name is
 * `bun` or `agent-rigger` (R6's "comm ≠ bun/agent-rigger" test), 'foreign'
 * when it is a different, readable name, 'unknown' when it cannot be read
 * (no `/proc` — e.g. macOS — or any other read failure). NEVER spawns a
 * child process.
 *
 * Exported (not module-private) so `cmd-doctor.ts`'s default lock-break
 * wiring can pass the SAME real probe to `breakLockCas`'s `identify` option —
 * the R6 "pid recyclé" repair re-verifies foreignness at the moment of
 * breaking with the identical read this scanner used at diagnose time,
 * rather than a second, potentially-diverging implementation.
 */
export async function defaultIdentify(pid: number): Promise<LockIdentity> {
  try {
    const raw = await Bun.file(`/proc/${pid}/comm`).text();
    const name = raw.trim();
    return name === 'bun' || name === 'agent-rigger' ? 'rigger' : 'foreign';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Stale lock-break debris (R6 "débris .stale-*")
// ---------------------------------------------------------------------------

/**
 * Match `<lockBaseName>.stale-<digits>-<8hex>` STRICTLY (the exact shape
 * `breakLockCas` produces, run-lock.ts) — never a looser glob, and never
 * re-read (the model's `lockStaleDebris` carries only the path).
 */
function isStaleDebrisName(base: string, name: string): boolean {
  const prefix = `${base}.stale-`;
  if (!name.startsWith(prefix)) return false;
  const rest = name.slice(prefix.length);
  return /^\d+-[0-9a-f]{8}$/.test(rest);
}

async function scanStaleDebris(lockPath: string): Promise<Finding[]> {
  const dir = dirname(lockPath);
  const base = lockPath.slice(dir.length + 1);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  return entries
    .filter((name) => isStaleDebrisName(base, name))
    .map((name) => lockStaleDebris({ path: `${dir}/${name}` }));
}

// ---------------------------------------------------------------------------
// createLockScanner
// ---------------------------------------------------------------------------

export interface LockScannerOptions {
  /** Injectable clock (ms since epoch), forwarded to `inspectRunLock`. */
  now?: () => number;
  /** Injectable tri-state liveness probe, forwarded to `inspectRunLock`. */
  liveness?: (pid: number) => Liveness;
  /** Injectable process-identity probe. Defaults to the `/proc` read above. */
  identify?: (pid: number) => Promise<LockIdentity>;
}

/**
 * Build the R6 lock scanner. A factory (not a bare `DoctorScanner`) so tests
 * can inject the clock/liveness/identify seams without touching the real
 * process table — the same pattern `run-lock.ts` already uses for
 * `acquireRunLock`/`inspectRunLock`.
 */
export function createLockScanner(options: LockScannerOptions = {}): DoctorScanner {
  const identify = options.identify ?? defaultIdentify;

  return async (ctx: DoctorContext): Promise<Finding[]> => {
    const lockPath = `${ctx.manifestPath}.lock`;
    const findings: Finding[] = [];

    const inspectOptions: Parameters<typeof inspectRunLock>[1] = {};
    if (options.now !== undefined) inspectOptions.now = options.now;
    if (options.liveness !== undefined) inspectOptions.liveness = options.liveness;
    const inspection = await inspectRunLock(lockPath, inspectOptions);

    if (inspection.present) {
      if (inspection.liveness === 'dead') {
        const evidence: LockEvidence = {
          pid: inspection.pid,
          startedAt: inspection.startedAt,
          ageMs: inspection.ageMs,
          liveness: 'dead',
          identity: 'unknown',
        };
        findings.push(lockCrashProbable({ lockPath, evidence }));
      } else if (inspection.liveness === 'unknown') {
        const evidence: LockEvidence = {
          pid: inspection.pid,
          startedAt: inspection.startedAt,
          ageMs: inspection.ageMs,
          liveness: 'unknown',
          identity: 'unknown',
        };
        findings.push(lockRefused({ reason: 'eperm', evidence }));
      } else {
        const identity = await identify(inspection.pid);
        const evidence: LockEvidence = {
          pid: inspection.pid,
          startedAt: inspection.startedAt,
          ageMs: inspection.ageMs,
          liveness: 'alive',
          identity,
        };
        if (identity === 'foreign') {
          findings.push(lockPidRecycledProbable({ lockPath, evidence }));
        } else {
          // 'rigger' or 'unknown' — plausibly (or indeterminately) legitimate:
          // never propose a break (R6 refusal scenario).
          findings.push(lockRefused({ reason: 'live', evidence }));
        }
      }
    }

    findings.push(...(await scanStaleDebris(lockPath)));
    return findings;
  };
}
