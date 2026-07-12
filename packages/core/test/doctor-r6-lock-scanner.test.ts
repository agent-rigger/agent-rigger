/**
 * Tests for the R6 lock scanner (core/doctor/scanners/lock.ts, T2) and the
 * diagnose()-level "scan pendant un run vivant" abstention it drives
 * (core/doctor/diagnose.ts, T2).
 *
 * The scanner is a thin, read-only wrapper around `inspectRunLock` (T0):
 * these tests inject the clock/liveness/identify seams (never spawning a
 * real process, never touching /proc) and assert on the resulting `Finding`
 * shape, mirroring the five R6 scenarios named in requirements.md:
 *
 *   1. crash probable       (pid dead)
 *   2. pid recyclé probable (pid alive, foreign process identity)
 *   3. refus sur vivant / EPERM (never propose a break)
 *   4. débris .stale-*      (strict pattern match, always safe)
 *   5. scan pendant un run vivant → diagnose() abstains from later scanners
 */

import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { diagnose } from '../src/doctor/diagnose';
import type { DoctorContext, DoctorScanner, Finding } from '../src/doctor/finding';
import { createLockScanner } from '../src/doctor/scanners/lock';

async function withTmpDir<T>(fn: (dir: string, manifestPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'rigger-doctor-r6-scanner-'));
  try {
    const manifestPath = path.join(dir, 'state.json');
    return await fn(dir, manifestPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function ctxFor(manifestPath: string): DoctorContext {
  return { env: {}, manifestPath, configuredCatalogIds: [] };
}

async function writeLock(lockPath: string, pid: number, startedAt: string): Promise<void> {
  await writeFile(lockPath, JSON.stringify({ pid, startedAt }));
}

// ---------------------------------------------------------------------------
// 1 — crash probable
// ---------------------------------------------------------------------------

describe('doctor-R6: crash probable', () => {
  it('doctor-R6: a dead pid produces a crash-probable lock finding proposing break-lock', async () => {
    await withTmpDir(async (_dir, manifestPath) => {
      const lockPath = `${manifestPath}.lock`;
      await writeLock(lockPath, 4242, new Date(0).toISOString());

      const scanner = createLockScanner({ liveness: () => 'dead' });
      const findings = await scanner(ctxFor(manifestPath));

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.class).toBe('lock');
      if (finding.class !== 'lock') throw new Error('unreachable');
      expect(finding.verdict).toBe('crash-probable');
      if (finding.verdict !== 'crash-probable') throw new Error('unreachable');
      expect(finding.evidence.pid).toBe(4242);
      expect(finding.evidence.liveness).toBe('dead');
      expect(finding.repair.kind).toBe('break-lock');
      expect(finding.repair.consent).toBe('item-confirm');

      // Read-only: the lockfile itself is untouched.
      expect(await readFile(lockPath, 'utf8')).toBe(
        JSON.stringify({ pid: 4242, startedAt: new Date(0).toISOString() }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 2 — pid recyclé
// ---------------------------------------------------------------------------

describe('doctor-R6: pid recyclé', () => {
  it('doctor-R6: an alive pid with a foreign process identity produces pid-recycled-probable', async () => {
    await withTmpDir(async (_dir, manifestPath) => {
      const lockPath = `${manifestPath}.lock`;
      await writeLock(lockPath, 7777, new Date().toISOString());

      const scanner = createLockScanner({
        liveness: () => 'alive',
        identify: async () => 'foreign',
      });
      const findings = await scanner(ctxFor(manifestPath));

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.class).toBe('lock');
      if (finding.class !== 'lock') throw new Error('unreachable');
      expect(finding.verdict).toBe('pid-recycled-probable');
      if (finding.verdict !== 'pid-recycled-probable') throw new Error('unreachable');
      expect(finding.evidence.identity).toBe('foreign');
      expect(finding.repair.kind).toBe('break-lock');
      expect(finding.repair.consent).toBe('item-confirm');
    });
  });
});

// ---------------------------------------------------------------------------
// 3 — refus sur vivant et sur EPERM
// ---------------------------------------------------------------------------

describe('doctor-R6: refus sur vivant et sur EPERM', () => {
  it('doctor-R6: an alive, plausibly-rigger pid is refused — no break-lock proposed', async () => {
    await withTmpDir(async (_dir, manifestPath) => {
      const lockPath = `${manifestPath}.lock`;
      await writeLock(lockPath, 9999, new Date().toISOString());

      const scanner = createLockScanner({
        liveness: () => 'alive',
        identify: async () => 'rigger',
      });
      const findings = await scanner(ctxFor(manifestPath));

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.class).toBe('lock');
      if (finding.class !== 'lock') throw new Error('unreachable');
      expect(finding.verdict).toBe('refused');
      if (finding.verdict !== 'refused') throw new Error('unreachable');
      expect(finding.reason).toBe('live');
      expect('repair' in finding).toBe(false);
    });
  });

  it('doctor-R6: an alive pid whose identity cannot be confirmed is refused, never treated as foreign', async () => {
    await withTmpDir(async (_dir, manifestPath) => {
      const lockPath = `${manifestPath}.lock`;
      // 99999999 exceeds every platform's pid ceiling (Linux PID_MAX_LIMIT is
      // 4194304; macOS caps far lower), so /proc/<pid>/comm can never exist.
      // With 1234 this test was CI-flaky: on a Linux runner that pid can be a
      // live container process, defaultIdentify() then reads its real comm and
      // classifies it 'foreign' — the exact misread this test forbids. An
      // impossible pid keeps the intent (exercise the REAL default identify,
      // no injection) while making its 'unknown' fallback deterministic on
      // /proc-less (macOS) and /proc-ful (Linux CI) platforms alike.
      await writeLock(lockPath, 99999999, new Date().toISOString());

      const scanner = createLockScanner({ liveness: () => 'alive' });
      const findings = await scanner(ctxFor(manifestPath));

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.class).toBe('lock');
      if (finding.class !== 'lock') throw new Error('unreachable');
      expect(finding.verdict).toBe('refused');
      if (finding.verdict !== 'refused') throw new Error('unreachable');
      expect(finding.reason).toBe('live');
      expect(finding.evidence.identity).toBe('unknown');
    });
  });

  it('doctor-R6: an EPERM (indeterminate) liveness is refused for the same reason, never as a break candidate', async () => {
    await withTmpDir(async (_dir, manifestPath) => {
      const lockPath = `${manifestPath}.lock`;
      await writeLock(lockPath, 5555, new Date().toISOString());

      const scanner = createLockScanner({ liveness: () => 'unknown' });
      const findings = await scanner(ctxFor(manifestPath));

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.class).toBe('lock');
      if (finding.class !== 'lock') throw new Error('unreachable');
      expect(finding.verdict).toBe('refused');
      if (finding.verdict !== 'refused') throw new Error('unreachable');
      expect(finding.reason).toBe('eperm');
      expect('repair' in finding).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// 4 — débris .stale-*
// ---------------------------------------------------------------------------

describe('doctor-R6: débris .stale-*', () => {
  it('doctor-R6: a strictly-matching .stale-<digits>-<8hex> debris file is safe to delete', async () => {
    await withTmpDir(async (dir, manifestPath) => {
      const lockPath = `${manifestPath}.lock`;
      const debrisPath = path.join(dir, 'state.json.lock.stale-12345-abcd1234');
      await writeFile(debrisPath, JSON.stringify({ pid: 1, startedAt: new Date(0).toISOString() }));

      // No live lock at all — only the debris.
      const scanner = createLockScanner();
      const findings = await scanner(ctxFor(manifestPath));

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.class).toBe('lock');
      if (finding.class !== 'lock') throw new Error('unreachable');
      expect(finding.verdict).toBe('stale-debris');
      if (finding.verdict !== 'stale-debris') throw new Error('unreachable');
      expect(finding.path).toBe(debrisPath);
      expect(finding.repair.kind).toBe('delete-residue');
      expect(finding.repair.consent).toBe('safe');
      void lockPath;
    });
  });

  it('doctor-R6: a looser glob (wrong hex length, missing digits) is never matched', async () => {
    await withTmpDir(async (dir, manifestPath) => {
      await writeFile(path.join(dir, 'state.json.lock.stale-abc-abcd1234'), '{}'); // non-digit pid segment
      await writeFile(path.join(dir, 'state.json.lock.stale-12345-abcd12'), '{}'); // short hex
      await writeFile(path.join(dir, 'state.json.lock.staleish-12345-abcd1234'), '{}'); // wrong prefix

      const scanner = createLockScanner();
      const findings = await scanner(ctxFor(manifestPath));

      expect(findings).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 5 — scan pendant un run vivant: diagnose() abstains
// ---------------------------------------------------------------------------

describe('doctor-R6: scan pendant un run vivant — diagnose abstains from the rest of the state scan', () => {
  it('doctor-R6: a live, plausibly-rigger lock stops diagnose before any later scanner runs', async () => {
    await withTmpDir(async (_dir, manifestPath) => {
      const lockPath = `${manifestPath}.lock`;
      await writeLock(lockPath, 4242, new Date().toISOString());

      const lockScanner = createLockScanner({
        liveness: () => 'alive',
        identify: async () => 'rigger',
      });
      let laterCalls = 0;
      const laterScanner: DoctorScanner = async (): Promise<Finding[]> => {
        laterCalls += 1;
        return [];
      };

      const report = await diagnose([lockScanner, laterScanner], ctxFor(manifestPath));

      expect(laterCalls).toBe(0);
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0]?.class).toBe('lock');
    });
  });

  it('doctor-R6: an EPERM lock also stops diagnose (indeterminate is never assumed safe to keep scanning)', async () => {
    await withTmpDir(async (_dir, manifestPath) => {
      const lockPath = `${manifestPath}.lock`;
      await writeLock(lockPath, 6666, new Date().toISOString());

      const lockScanner = createLockScanner({ liveness: () => 'unknown' });
      let laterCalls = 0;
      const laterScanner: DoctorScanner = async (): Promise<Finding[]> => {
        laterCalls += 1;
        return [];
      };

      const report = await diagnose([lockScanner, laterScanner], ctxFor(manifestPath));

      expect(laterCalls).toBe(0);
      expect(report.findings).toHaveLength(1);
    });
  });

  it('doctor-R6: a crash-probable or pid-recycled lock does NOT abstain — later scanners still run', async () => {
    await withTmpDir(async (_dir, manifestPath) => {
      const lockPath = `${manifestPath}.lock`;
      await writeLock(lockPath, 4242, new Date(0).toISOString());

      const lockScanner = createLockScanner({ liveness: () => 'dead' });
      let laterCalls = 0;
      const laterScanner: DoctorScanner = async (): Promise<Finding[]> => {
        laterCalls += 1;
        return [];
      };

      const report = await diagnose([lockScanner, laterScanner], ctxFor(manifestPath));

      expect(laterCalls).toBe(1);
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0]?.class).toBe('lock');
    });
  });

  it('doctor-R6: no lock present at all — later scanners run normally, no lock finding', async () => {
    await withTmpDir(async (_dir, manifestPath) => {
      const lockScanner = createLockScanner();
      let laterCalls = 0;
      const laterScanner: DoctorScanner = async (): Promise<Finding[]> => {
        laterCalls += 1;
        return [];
      };

      const report = await diagnose([lockScanner, laterScanner], ctxFor(manifestPath));

      expect(laterCalls).toBe(1);
      expect(report.findings).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Zero side effects — the scanner never acquires/mutates the lock
// ---------------------------------------------------------------------------

describe('doctor-R6: the lock scanner is read-only — it never creates, renames, or unlinks', () => {
  it('doctor-R6: scanning a live lock leaves the lockfile byte-identical and no stale artifact behind', async () => {
    await withTmpDir(async (dir, manifestPath) => {
      const lockPath = `${manifestPath}.lock`;
      const record = { pid: 4242, startedAt: new Date().toISOString() };
      await writeLock(lockPath, record.pid, record.startedAt);
      const before = await readFile(lockPath, 'utf8');

      const scanner = createLockScanner({
        liveness: () => 'alive',
        identify: async () => 'rigger',
      });
      await scanner(ctxFor(manifestPath));

      expect(await readFile(lockPath, 'utf8')).toBe(before);
      const entries = await import('node:fs/promises').then((m) => m.readdir(dir));
      expect(entries.filter((e) => e.includes('.stale-'))).toHaveLength(0);
    });
  });

  it('doctor-R6: scanning an absent lock never creates one', async () => {
    await withTmpDir(async (_dir, manifestPath) => {
      const lockPath = `${manifestPath}.lock`;
      const scanner = createLockScanner();
      await scanner(ctxFor(manifestPath));

      const exists = await stat(lockPath).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });
  });
});
