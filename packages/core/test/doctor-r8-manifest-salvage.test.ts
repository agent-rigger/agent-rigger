/**
 * Tests for `diagnose()`'s R8 manifest salvage (core/doctor/diagnose.ts, T2)
 * and its "zero side effect" invariant (ADR-0025 §1).
 *
 * R8 scenario ("manifest illisible — salvage au lieu du conseil
 * destructeur"): a present-but-wrong-shape `state.json` must produce a
 * `manifest` Finding carrying a `backup-state` repair and a shape
 * diagnostic — never the old "delete the file to start fresh" advice
 * (there is no such advice anywhere in this model: the Finding's `summary`
 * only ever proposes a backup).
 */

import { describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { diagnose } from '../src/doctor/diagnose';
import type { DoctorContext, DoctorScanner, Finding } from '../src/doctor/finding';
import { createLockScanner } from '../src/doctor/scanners/lock';
import { manifestAuditScanner } from '../src/doctor/scanners/manifest-audit';

async function withTmpDir<T>(fn: (dir: string, manifestPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'rigger-doctor-r8-'));
  try {
    return await fn(dir, path.join(dir, 'state.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function ctxFor(manifestPath: string): DoctorContext {
  return { env: {}, manifestPath, configuredCatalogIds: [] };
}

// ---------------------------------------------------------------------------
// R8 salvage — malformed manifest
// ---------------------------------------------------------------------------

describe('doctor-R8: manifest illisible — salvage au lieu du conseil destructeur', () => {
  it('doctor-R8: a non-object top-level state.json is salvaged into a backup-state Finding', async () => {
    await withTmpDir(async (_dir, manifestPath) => {
      await writeFile(manifestPath, '[]');

      const report = await diagnose([manifestAuditScanner], ctxFor(manifestPath));

      expect(report.findings).toHaveLength(1);
      const finding = report.findings[0]!;
      expect(finding.class).toBe('manifest');
      if (finding.class !== 'manifest') throw new Error('unreachable');
      expect(finding.issue).toBe('malformed');
      if (finding.issue !== 'malformed') throw new Error('unreachable');
      expect(finding.reason).toContain('not a JSON object');
      expect(finding.repair.kind).toBe('backup-state');
      expect(finding.repair.consent).toBe('safe');
      expect(finding.repair.path).toBe(manifestPath);
      expect(finding.summary).not.toContain('delete the file');
      expect(finding.summary).toContain('back it up');
    });
  });

  it('doctor-R8: a non-numeric version is salvaged with the shape reason verbatim', async () => {
    await withTmpDir(async (_dir, manifestPath) => {
      await writeFile(manifestPath, JSON.stringify({ version: '1', artifacts: [] }));

      const report = await diagnose([manifestAuditScanner], ctxFor(manifestPath));

      expect(report.findings).toHaveLength(1);
      const finding = report.findings[0]!;
      if (finding.class !== 'manifest' || finding.issue !== 'malformed') {
        throw new Error('expected a malformed manifest finding');
      }
      expect(finding.reason).toContain('must be the number 1');
    });
  });

  it('doctor-R8: a non-array artifacts field is salvaged with the shape reason verbatim', async () => {
    await withTmpDir(async (_dir, manifestPath) => {
      await writeFile(manifestPath, JSON.stringify({ version: 1, artifacts: {} }));

      const report = await diagnose([manifestAuditScanner], ctxFor(manifestPath));

      expect(report.findings).toHaveLength(1);
      const finding = report.findings[0]!;
      if (finding.class !== 'manifest' || finding.issue !== 'malformed') {
        throw new Error('expected a malformed manifest finding');
      }
      expect(finding.reason).toContain('"artifacts" must be an array');
    });
  });

  it('doctor-R8: findings from scanners that ran BEFORE the failure are kept, not discarded', async () => {
    await withTmpDir(async (_dir, manifestPath) => {
      await writeFile(manifestPath, '[]');
      const lockPath = `${manifestPath}.lock`;
      await writeFile(
        lockPath,
        JSON.stringify({ pid: 4242, startedAt: new Date(0).toISOString() }),
      );

      const lockScanner = createLockScanner({ liveness: () => 'dead' });
      const report = await diagnose([lockScanner, manifestAuditScanner], ctxFor(manifestPath));

      expect(report.findings).toHaveLength(2);
      expect(report.findings.some((f) => f.class === 'lock')).toBe(true);
      expect(report.findings.some((f) => f.class === 'manifest')).toBe(true);
    });
  });

  it('doctor-R8: a malformed manifest is reported at most ONCE even if several scanners would throw', async () => {
    await withTmpDir(async (_dir, manifestPath) => {
      await writeFile(manifestPath, '[]');

      // manifestAuditScanner throws first; this second scanner (standing in
      // for a T3 adapter scanner that ALSO needs the manifest) must never run.
      let secondCalls = 0;
      const secondManifestReader: DoctorScanner = async (): Promise<Finding[]> => {
        secondCalls += 1;
        return [];
      };

      const report = await diagnose(
        [manifestAuditScanner, secondManifestReader],
        ctxFor(manifestPath),
      );

      expect(secondCalls).toBe(0);
      expect(report.findings.filter((f) => f.class === 'manifest' && f.issue === 'malformed'))
        .toHaveLength(1);
    });
  });

  it('doctor-R8: a scanner error unrelated to the manifest shape is NOT swallowed as salvage', async () => {
    await withTmpDir(async (_dir, manifestPath) => {
      await expect(diagnose([boomScanner], ctxFor(manifestPath))).rejects.toThrow('boom');
    });
  });
});

const boomScanner: DoctorScanner = async (): Promise<Finding[]> => {
  throw new Error('boom');
};

// ---------------------------------------------------------------------------
// diagnose() is read-only absolute — proven by spy / directory-listing
// ---------------------------------------------------------------------------

describe('doctor: diagnose() performs zero writes, zero lock, zero spawn', () => {
  it('doctor-R8: diagnosing a malformed manifest creates no backup — the repair is only PROPOSED', async () => {
    await withTmpDir(async (dir, manifestPath) => {
      await writeFile(manifestPath, '[]');
      const before = await readdir(dir);

      await diagnose([manifestAuditScanner], ctxFor(manifestPath));

      const after = await readdir(dir);
      expect(after.sort()).toEqual(before.sort());
    });
  });

  it('doctor: diagnosing a healthy manifest + a dead lock creates no new files at all', async () => {
    await withTmpDir(async (dir, manifestPath) => {
      await writeFile(manifestPath, JSON.stringify({ version: 1, artifacts: [] }));
      const lockPath = `${manifestPath}.lock`;
      await writeFile(
        lockPath,
        JSON.stringify({ pid: 4242, startedAt: new Date(0).toISOString() }),
      );
      const before = (await readdir(dir)).sort();

      const lockScanner = createLockScanner({ liveness: () => 'dead' });
      const report = await diagnose([lockScanner, manifestAuditScanner], ctxFor(manifestPath));

      expect(report.findings.some((f) => f.class === 'lock')).toBe(true);
      const after = (await readdir(dir)).sort();
      expect(after).toEqual(before);
    });
  });

  it('doctor: a scanner call count matches exactly the scanners array — diagnose invokes each once, in order', async () => {
    await withTmpDir(async (_dir, manifestPath) => {
      await writeFile(manifestPath, JSON.stringify({ version: 1, artifacts: [] }));

      const calls: string[] = [];
      const a: DoctorScanner = async () => {
        calls.push('a');
        return [];
      };
      const b: DoctorScanner = async () => {
        calls.push('b');
        return [];
      };

      await diagnose([a, b], ctxFor(manifestPath));
      expect(calls).toEqual(['a', 'b']);
    });
  });
});
