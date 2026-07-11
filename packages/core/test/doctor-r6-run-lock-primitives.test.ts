/**
 * Tests for doctor R6 — the read-only inspection and consented-break primitives
 * extracted from run-lock.ts (design "MODIFY core/src/run-lock.ts", ADR-0025 §7).
 *
 * T0 is a PURE refactor: `acquireRunLock` now reuses `breakLockCas`, and the
 * existing lot3-r7-concurrency suite proves the acquisition behaviour is
 * unchanged. THIS file covers the NEW surfaces doctor consumes:
 *
 *   - inspectRunLock() — reads pid/mtime/age/liveness WITHOUT acquiring or
 *     mutating anything (doctor diagnose is read-only absolute, ADR-0025 §1).
 *   - breakLockCas() — the atomic rename+CAS shared by acquisition and doctor's
 *     consented lock repair. It REFUSES three ways: identity changed (a fresh
 *     holder replaced the observed record), pid alive, and EPERM (indeterminate).
 *   - the CAS is the SAME primitive whether reached via acquisition or via a
 *     direct doctor break (ADR-0023, two consumers).
 *
 * No real processes are spawned: liveness is injected, and concurrency is
 * simulated by rewriting the lockfile at the exact seam.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { acquireRunLock, breakLockCas, ConcurrentRunError, inspectRunLock } from '../src/run-lock';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let dir: string;
let manifestPath: string;
let lockPath: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'rigger-doctor-r6-'));
  manifestPath = path.join(dir, 'state.json');
  lockPath = `${manifestPath}.lock`;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true).catch(() => false);
}

async function writeLock(pid: number, startedAt: string): Promise<void> {
  await writeFile(lockPath, JSON.stringify({ pid, startedAt }));
}

async function staleArtifacts(): Promise<string[]> {
  const base = path.basename(lockPath);
  return (await readdir(dir)).filter((f) => f.startsWith(`${base}.stale-`));
}

// ---------------------------------------------------------------------------
// inspectRunLock — read-only, mutates nothing
// ---------------------------------------------------------------------------

describe('inspectRunLock — read-only diagnosis', () => {
  it('doctor-R6: inspectRunLock on an absent lock reports present:false and takes nothing', async () => {
    const inspection = await inspectRunLock(lockPath);
    expect(inspection.present).toBe(false);
    expect(inspection.pid).toBe(-1);
    expect(inspection.startedAt).toBeUndefined();
    expect(inspection.mtimeMs).toBeUndefined();
    expect(inspection.ageMs).toBeUndefined();
    expect(inspection.liveness).toBe('dead');
    // It NEVER creates the lockfile it inspects.
    expect(await exists(lockPath)).toBe(false);
  });

  it('doctor-R6: inspectRunLock reads pid/startedAt/mtime/age without mutating the lockfile', async () => {
    const startedAt = new Date(1000).toISOString();
    await writeLock(4242, startedAt);
    const before = (await stat(lockPath)).mtimeMs;
    const beforeBytes = await readFile(lockPath, 'utf8');

    const inspection = await inspectRunLock(lockPath, {
      now: () => before + 5000,
      liveness: () => 'alive',
    });

    expect(inspection.present).toBe(true);
    expect(inspection.pid).toBe(4242);
    expect(inspection.startedAt).toBe(startedAt);
    expect(inspection.mtimeMs).toBe(before);
    expect(inspection.ageMs).toBe(5000);
    expect(inspection.liveness).toBe('alive');

    // Read-only: content and mtime untouched, no break artifact spawned.
    expect(await readFile(lockPath, 'utf8')).toBe(beforeBytes);
    expect((await stat(lockPath)).mtimeMs).toBe(before);
    expect(await staleArtifacts()).toHaveLength(0);
  });

  it('doctor-R6: inspectRunLock surfaces the injected liveness verdict (dead / alive / unknown)', async () => {
    await writeLock(555, new Date().toISOString());
    for (const verdict of ['dead', 'alive', 'unknown'] as const) {
      const inspection = await inspectRunLock(lockPath, { liveness: () => verdict });
      expect(inspection.liveness).toBe(verdict);
    }
  });

  it('doctor-R6: inspectRunLock on a corrupt lock reports pid -1 but stays present', async () => {
    await writeFile(lockPath, 'not-json{');
    const inspection = await inspectRunLock(lockPath, { liveness: () => 'alive' });
    expect(inspection.present).toBe(true);
    expect(inspection.pid).toBe(-1);
    // A pid < 0 is treated as dead regardless of the probe.
    expect(inspection.liveness).toBe('dead');
  });
});

// ---------------------------------------------------------------------------
// breakLockCas — the three refusals
// ---------------------------------------------------------------------------

describe('breakLockCas — refuses to break a lock that must not be broken', () => {
  it('doctor-R6: breakLockCas refuses (pid-alive) and never touches a live lock', async () => {
    const startedAt = new Date().toISOString();
    await writeLock(7777, startedAt);
    const beforeBytes = await readFile(lockPath, 'utf8');

    const result = await breakLockCas(
      lockPath,
      { pid: 7777, startedAt },
      { liveness: () => 'alive' },
    );

    expect(result.broken).toBe(false);
    expect(result).toMatchObject({ reason: 'pid-alive', pid: 7777 });
    // The lock is exactly as it was — no rename, no unlink, no artifact.
    expect(await readFile(lockPath, 'utf8')).toBe(beforeBytes);
    expect(await staleArtifacts()).toHaveLength(0);
  });

  it('doctor-R6: breakLockCas refuses (eperm) when liveness is indeterminate', async () => {
    const startedAt = new Date().toISOString();
    await writeLock(8888, startedAt);
    const beforeBytes = await readFile(lockPath, 'utf8');

    const result = await breakLockCas(
      lockPath,
      { pid: 8888, startedAt },
      { liveness: () => 'unknown' },
    );

    expect(result.broken).toBe(false);
    expect(result).toMatchObject({ reason: 'eperm', pid: 8888 });
    expect(await readFile(lockPath, 'utf8')).toBe(beforeBytes);
    expect(await staleArtifacts()).toHaveLength(0);
  });

  it('doctor-R6: breakLockCas refuses (identity-changed) and restores the fresh holder', async () => {
    // Observed a dead record, but a fresh live run replaced it before we acted.
    const observed = { pid: 999999, startedAt: new Date(0).toISOString() };
    const freshRecord = { pid: 4242, startedAt: new Date().toISOString() };
    await writeFile(lockPath, JSON.stringify(freshRecord));

    const result = await breakLockCas(lockPath, observed, {
      liveness: () => 'dead', // the OBSERVED pid is dead → proceed to the CAS
    });

    expect(result.broken).toBe(false);
    expect(result).toMatchObject({ reason: 'identity-changed', pid: freshRecord.pid });
    // The fresh live lock was restored to its path, no artifact left behind.
    const onDisk = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number };
    expect(onDisk.pid).toBe(freshRecord.pid);
    expect(await staleArtifacts()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// breakLockCas — the successful break (the other CAS consumer)
// ---------------------------------------------------------------------------

describe('breakLockCas — breaks a lock it is entitled to break', () => {
  it('doctor-R6: breakLockCas moves the observed record aside and leaves no artifact', async () => {
    const startedAt = new Date(0).toISOString();
    await writeLock(999999, startedAt);

    const result = await breakLockCas(
      lockPath,
      { pid: 999999, startedAt },
      { liveness: () => 'dead' },
    );

    expect(result.broken).toBe(true);
    expect(result).toMatchObject({ pid: 999999, startedAt });
    // The lock is gone (broken), and the moved-aside copy was discarded.
    expect(await exists(lockPath)).toBe(false);
    expect(await staleArtifacts()).toHaveLength(0);
  });

  it('doctor-R6: breakLockCas on an already-gone lock reports broken (nothing to do)', async () => {
    const result = await breakLockCas(
      lockPath,
      { pid: 123, startedAt: new Date(0).toISOString() },
      { liveness: () => 'dead' },
    );
    expect(result.broken).toBe(true);
    expect(await exists(lockPath)).toBe(false);
  });

  it('doctor-R6: breakLockCas breaks a corrupt lock (pid -1 compares to itself)', async () => {
    await writeFile(lockPath, 'not-json{');
    const result = await breakLockCas(
      lockPath,
      { pid: -1, startedAt: undefined },
      { liveness: () => 'dead' },
    );
    expect(result.broken).toBe(true);
    expect(await exists(lockPath)).toBe(false);
    expect(await staleArtifacts()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// breakLockCas — the `identify` override (R6 "pid recyclé", post-review fix)
// ---------------------------------------------------------------------------

describe('breakLockCas — confirmed-foreign alive pid (R6 pid-recycled repair)', () => {
  it('doctor-R6: breakLockCas breaks an alive pid when identify confirms it is foreign', async () => {
    const startedAt = new Date().toISOString();
    await writeLock(7777, startedAt);

    const result = await breakLockCas(
      lockPath,
      { pid: 7777, startedAt },
      { liveness: () => 'alive', identify: async () => 'foreign' },
    );

    expect(result.broken).toBe(true);
    expect(result).toMatchObject({ pid: 7777, startedAt });
    expect(await exists(lockPath)).toBe(false);
    expect(await staleArtifacts()).toHaveLength(0);
  });

  it('doctor-R6: breakLockCas still refuses an alive pid when identify says it is plausibly rigger', async () => {
    const startedAt = new Date().toISOString();
    await writeLock(7778, startedAt);
    const beforeBytes = await readFile(lockPath, 'utf8');

    const result = await breakLockCas(
      lockPath,
      { pid: 7778, startedAt },
      { liveness: () => 'alive', identify: async () => 'rigger' },
    );

    expect(result.broken).toBe(false);
    expect(result).toMatchObject({ reason: 'pid-alive', pid: 7778 });
    expect(await readFile(lockPath, 'utf8')).toBe(beforeBytes);
  });

  it('doctor-R6: breakLockCas still refuses an alive pid when identify is indeterminate (unknown)', async () => {
    const startedAt = new Date().toISOString();
    await writeLock(7779, startedAt);
    const beforeBytes = await readFile(lockPath, 'utf8');

    const result = await breakLockCas(
      lockPath,
      { pid: 7779, startedAt },
      { liveness: () => 'alive', identify: async () => 'unknown' },
    );

    expect(result.broken).toBe(false);
    expect(result).toMatchObject({ reason: 'pid-alive', pid: 7779 });
    expect(await readFile(lockPath, 'utf8')).toBe(beforeBytes);
  });

  it('doctor-R6: breakLockCas without an identify probe refuses any alive pid — normal acquisition unaffected', async () => {
    const startedAt = new Date().toISOString();
    await writeLock(7780, startedAt);
    const beforeBytes = await readFile(lockPath, 'utf8');

    // No `identify` passed at all — the exact call shape acquireRunLock uses.
    const result = await breakLockCas(lockPath, { pid: 7780, startedAt }, {
      liveness: () => 'alive',
    });

    expect(result.broken).toBe(false);
    expect(result).toMatchObject({ reason: 'pid-alive', pid: 7780 });
    expect(await readFile(lockPath, 'utf8')).toBe(beforeBytes);
  });
});

// ---------------------------------------------------------------------------
// The CAS is one primitive: acquisition and doctor break agree
// ---------------------------------------------------------------------------

describe('breakLockCas — one primitive for both consumers (ADR-0023)', () => {
  it('doctor-R6: a direct breakLockCas of a stale record leaves the path acquirable', async () => {
    const startedAt = new Date(0).toISOString();
    await writeLock(999999, startedAt);

    // Doctor-side break of the crashed run's record.
    const broke = await breakLockCas(
      lockPath,
      { pid: 999999, startedAt },
      { liveness: () => 'dead' },
    );
    expect(broke.broken).toBe(true);

    // A fresh acquisition then succeeds and the lock is ours.
    const lock = await acquireRunLock(manifestPath);
    const raw = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number };
    expect(raw.pid).toBe(process.pid);
    await lock.release();
  });

  it('doctor-R6: acquisition reaches the SAME CAS — a stale lock is broken and re-acquired', async () => {
    // The acquisition path breaks the stale lock through breakLockCas internally;
    // the observable outcome matches a direct break followed by a create.
    await writeLock(999999, new Date(0).toISOString());

    const warnings: string[] = [];
    const lock = await acquireRunLock(manifestPath, {
      ttlMs: 1000,
      now: () => Date.now() + 60_000,
      pidAlive: () => false,
      warn: (m) => warnings.push(m),
    });

    expect(warnings.join('\n').toLowerCase()).toContain('stale');
    const raw = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number };
    expect(raw.pid).toBe(process.pid);
    expect(await staleArtifacts()).toHaveLength(0);
    await lock.release();
  });

  it('doctor-R6: acquisition backs off with ConcurrentRunError when the CAS refuses (identity changed)', async () => {
    // Same seam as lot3\'s atomicity test, proving the refactored acquisition still
    // routes its stale break through the CAS refusal.
    const staleStartedAt = new Date(0).toISOString();
    await writeLock(999999, staleStartedAt);

    const freshRecord = { pid: 4242, startedAt: new Date().toISOString() };
    let injected = false;
    const pidAlive = (_pid: number): boolean => {
      if (!injected) {
        injected = true;
        // Replace the stale lock with a fresh live one in the read→break window
        // (synchronous so it lands before the rename that follows this probe).
        writeFileSync(lockPath, JSON.stringify(freshRecord));
      }
      return false;
    };

    let caught: unknown;
    try {
      await acquireRunLock(manifestPath, {
        ttlMs: 1000,
        now: () => Date.now() + 60_000,
        pidAlive,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConcurrentRunError);
  });
});
