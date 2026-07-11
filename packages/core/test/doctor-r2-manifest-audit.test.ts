/**
 * Tests for the R2 manifest-audit scanner
 * (core/doctor/scanners/manifest-audit.ts, T2).
 *
 * Named scenarios from requirements.md:
 *   - "entrée orpheline de son catalogue": an entry whose id references a
 *     catalog no longer in `ctx.configuredCatalogIds`.
 *   - "sha manquant": an entry with an empty/absent sha (historic adoption).
 *
 * Plus the "missing-file" check design.md explicitly assigns to this
 * scanner (files[] existence) — not a named requirements.md scenario, but
 * part of the R2 SHALL clause and cheap to prove alongside the two named
 * ones. `applied`-drift is NOT implemented here — see manifest-audit.ts's
 * docstring for why that stays out of this assistant-agnostic scanner.
 */

import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { DoctorContext } from '../src/doctor/finding';
import { manifestAuditScanner } from '../src/doctor/scanners/manifest-audit';
import type { Manifest } from '../src/types';

async function withManifest<T>(
  manifest: Manifest,
  fn: (manifestPath: string, dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'rigger-doctor-r2-'));
  try {
    const manifestPath = path.join(dir, 'state.json');
    await writeFile(manifestPath, JSON.stringify(manifest));
    return await fn(manifestPath, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function ctxFor(manifestPath: string, configuredCatalogIds: string[]): DoctorContext {
  return { env: {}, manifestPath, configuredCatalogIds };
}

// ---------------------------------------------------------------------------
// entrée orpheline de son catalogue
// ---------------------------------------------------------------------------

describe('doctor-R2: entrée orpheline de son catalogue', () => {
  it('doctor-R2: an entry whose catalog was removed from config is reported orphan-catalog', async () => {
    const manifest: Manifest = {
      version: 1,
      artifacts: [
        {
          id: 'gone/skill:x',
          nature: 'skill',
          ref: '1.0.0',
          sha: 'deadbeef',
          scope: 'user',
          installedAt: new Date().toISOString(),
          files: [],
        },
      ],
    };

    await withManifest(manifest, async (manifestPath) => {
      const findings = await manifestAuditScanner(ctxFor(manifestPath, ['kept']));

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.class).toBe('manifest');
      if (finding.class !== 'manifest') throw new Error('unreachable');
      expect(finding.issue).toBe('orphan-catalog');
      if (finding.issue !== 'orphan-catalog') throw new Error('unreachable');
      expect(finding.entryId).toBe('gone/skill:x');
      expect('repair' in finding).toBe(false);
    });
  });

  it('doctor-R2: an entry whose catalog IS still configured is never flagged', async () => {
    const manifest: Manifest = {
      version: 1,
      artifacts: [
        {
          id: 'kept/skill:y',
          nature: 'skill',
          ref: '1.0.0',
          sha: 'deadbeef',
          scope: 'user',
          installedAt: new Date().toISOString(),
          files: [],
        },
      ],
    };

    await withManifest(manifest, async (manifestPath) => {
      const findings = await manifestAuditScanner(ctxFor(manifestPath, ['kept']));
      expect(findings).toHaveLength(0);
    });
  });

  it('doctor-R2: an unqualified id (no catalog prefix, defaults adoption) is never flagged orphan', async () => {
    const manifest: Manifest = {
      version: 1,
      artifacts: [
        {
          id: 'skill:z',
          nature: 'skill',
          ref: 'v0.0.0',
          sha: 'deadbeef',
          scope: 'user',
          installedAt: new Date().toISOString(),
          files: [],
        },
      ],
    };

    await withManifest(manifest, async (manifestPath) => {
      const findings = await manifestAuditScanner(ctxFor(manifestPath, []));
      expect(findings).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// sha manquant
// ---------------------------------------------------------------------------

describe('doctor-R2: sha manquant', () => {
  it('doctor-R2: an entry with an empty sha is reported missing-sha with a restamp suggestion', async () => {
    const manifest: Manifest = {
      version: 1,
      artifacts: [
        {
          id: 'jr/skill:foo',
          nature: 'skill',
          ref: '1.0.0',
          sha: '',
          scope: 'user',
          installedAt: new Date().toISOString(),
          files: [],
        },
      ],
    };

    await withManifest(manifest, async (manifestPath) => {
      const findings = await manifestAuditScanner(ctxFor(manifestPath, ['jr']));

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.class).toBe('manifest');
      if (finding.class !== 'manifest') throw new Error('unreachable');
      expect(finding.issue).toBe('missing-sha');
      if (finding.issue !== 'missing-sha') throw new Error('unreachable');
      expect(finding.entryId).toBe('jr/skill:foo');
      expect(finding.summary).toContain('update jr/skill:foo');
      expect('repair' in finding).toBe(false);
    });
  });

  it('doctor-R2: an entry with a non-empty sha is never flagged missing-sha', async () => {
    const manifest: Manifest = {
      version: 1,
      artifacts: [
        {
          id: 'jr/skill:foo',
          nature: 'skill',
          ref: '1.0.0',
          sha: 'cafebabe',
          scope: 'user',
          installedAt: new Date().toISOString(),
          files: [],
        },
      ],
    };

    await withManifest(manifest, async (manifestPath) => {
      const findings = await manifestAuditScanner(ctxFor(manifestPath, ['jr']));
      expect(findings).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// missing-file (design.md scope, not a separately-named requirements scenario)
// ---------------------------------------------------------------------------

describe('doctor-R2: files[] disparus', () => {
  it('doctor-R2: a files[] path that no longer exists on disk is reported missing-file', async () => {
    await withManifest(
      {
        version: 1,
        artifacts: [
          {
            id: 'jr/skill:foo',
            nature: 'skill',
            ref: '1.0.0',
            sha: 'cafebabe',
            scope: 'user',
            installedAt: new Date().toISOString(),
            files: ['/does/not/exist/foo'],
          },
        ],
      },
      async (manifestPath) => {
        const findings = await manifestAuditScanner(ctxFor(manifestPath, ['jr']));

        expect(findings).toHaveLength(1);
        const finding = findings[0]!;
        expect(finding.class).toBe('manifest');
        if (finding.class !== 'manifest') throw new Error('unreachable');
        expect(finding.issue).toBe('missing-file');
        if (finding.issue !== 'missing-file') throw new Error('unreachable');
        expect(finding.missingPath).toBe('/does/not/exist/foo');
      },
    );
  });

  it('doctor-R2: an existing files[] path is never flagged', async () => {
    await withManifest(
      { version: 1, artifacts: [] },
      async (manifestPath, dir) => {
        const filePath = path.join(dir, 'present.md');
        await writeFile(filePath, 'hi');
        const manifest: Manifest = {
          version: 1,
          artifacts: [
            {
              id: 'jr/skill:foo',
              nature: 'skill',
              ref: '1.0.0',
              sha: 'cafebabe',
              scope: 'user',
              installedAt: new Date().toISOString(),
              files: [filePath],
            },
          ],
        };
        await writeFile(manifestPath, JSON.stringify(manifest));

        const findings = await manifestAuditScanner(ctxFor(manifestPath, ['jr']));
        expect(findings).toHaveLength(0);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// No manifest mutation — a scanner is read-only
// ---------------------------------------------------------------------------

describe('doctor-R2: the manifest-audit scanner never writes', () => {
  it('doctor-R2: scanning leaves state.json byte-identical', async () => {
    const manifest: Manifest = {
      version: 1,
      artifacts: [
        {
          id: 'gone/skill:x',
          nature: 'skill',
          ref: '1.0.0',
          sha: '',
          scope: 'user',
          installedAt: new Date().toISOString(),
          files: ['/does/not/exist'],
        },
      ],
    };

    await withManifest(manifest, async (manifestPath) => {
      const before = await Bun.file(manifestPath).text();
      await manifestAuditScanner(ctxFor(manifestPath, []));
      const after = await Bun.file(manifestPath).text();
      expect(after).toBe(before);
    });
  });
});
