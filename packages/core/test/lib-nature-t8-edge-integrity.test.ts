/**
 * Tests for the T8 edge-integrity scanner
 * (core/doctor/scanners/edge-integrity.ts) — R7 (edge cassé, lib orpheline),
 * S6 (entrée sans edges), U1 (lib-imports-missing, lib-imports-alias).
 *
 * Named scenarios from requirements.md / tasks.md T8:
 *   - R7.3 "edge cassé" — an entry's `requires` names an id no manifest
 *     entry carries any more (a --force removal broke it earlier).
 *   - R7.2 "orpheline détectée par doctor" (graph half) — an installed lib
 *     entry no remaining entry requires. The disk-orphan half of R7.2 (a
 *     `libs/<name>` dir with no manifest entry) is covered separately by the
 *     phantom scanner (adapters/test/shared/lib-nature-t8-doctor-scan.test.ts)
 *     — these are two DISTINCT findings.
 *   - S6 "manifest legacy toléré et backfillé" — a legacy entry with no
 *     `requires` field at all (undefined) is flagged; an entry with an
 *     explicit `requires: []` (already resolved, zero deps) is not.
 *   - "doctor sur un état SAIN" — a lib with an installed dependent, edges
 *     recorded both ways, AND a correct home package.json, produces zero
 *     findings.
 *   - "générique — pas spécifique lib" (R6.6 posture, reused here) — the
 *     broken-edge check covers any nature's requires, not lib alone.
 *   - U1 "lib-imports-missing" — a lib entry with the home package.json
 *     absent, or present without the `#libs/*` mapping, is flagged; a
 *     lib-free manifest never even reads it.
 *
 * Isolation (U1): every test's `ctx.env` points `RIGGER_HOME` at a
 * deterministic, GUARANTEED-nonexistent sibling of its tmp manifest dir
 * (`fakeHomeEnv`) — never the real machine's `~/.config/agent-rigger`. Tests
 * predating U1 that carry a `nature: 'lib'` entry (R7.2/R7.3's "still
 * installed" cases) pick this default up transparently via `ctxFor`'s second
 * parameter; only the "état sain" test needs to pre-populate a CORRECT
 * package.json there, since it asserts zero findings unfiltered.
 */

import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { DoctorContext } from '../src/doctor/finding';
import { edgeIntegrityScanner } from '../src/doctor/scanners/edge-integrity';
import { manifestAuditScanner } from '../src/doctor/scanners/manifest-audit';
import { writeJson } from '../src/fs-json';
import { homePackageJsonPath } from '../src/paths';
import type { Env } from '../src/paths';
import type { Manifest, ManifestEntry } from '../src/types';

async function withManifest<T>(
  manifest: Manifest,
  fn: (manifestPath: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'rigger-doctor-t8-edges-'));
  try {
    const manifestPath = path.join(dir, 'state.json');
    await writeFile(manifestPath, JSON.stringify(manifest));
    return await fn(manifestPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A RIGGER_HOME guaranteed not to exist — sibling of the tmp manifest dir. */
function fakeHomeEnv(manifestPath: string): Env {
  return { RIGGER_HOME: path.join(path.dirname(manifestPath), '__fake_home_for_tests__') };
}

function ctxFor(manifestPath: string, env: Env = fakeHomeEnv(manifestPath)): DoctorContext {
  return { env, manifestPath, configuredCatalogIds: [] };
}

function entry(
  overrides: Partial<ManifestEntry> & { id: string; nature: ManifestEntry['nature'] },
): ManifestEntry {
  return {
    ref: 'v1.0.0',
    sha: 'cafebabe',
    scope: 'user',
    installedAt: new Date().toISOString(),
    files: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// R7.3 — edge cassé
// ---------------------------------------------------------------------------

describe('doctor-T8: edge cassé (R7.3)', () => {
  it('doctor-T8: a requires ref naming a lib no longer in the manifest is broken-edge, naming both', async () => {
    const manifest: Manifest = {
      version: 1,
      artifacts: [
        entry({
          id: 'jr/hook:guard-command',
          nature: 'hook',
          assistant: 'claude',
          requires: ['jr/lib:rules-common'],
        }),
        // jr/lib:rules-common was force-removed — no entry for it any more.
      ],
    };

    await withManifest(manifest, async (manifestPath) => {
      const findings = await edgeIntegrityScanner(ctxFor(manifestPath));

      const broken = findings.filter((f) => f.class === 'manifest' && f.issue === 'broken-edge');
      expect(broken).toHaveLength(1);
      const finding = broken[0]!;
      if (finding.class !== 'manifest' || finding.issue !== 'broken-edge') {
        throw new Error('unreachable');
      }
      expect(finding.entryId).toBe('jr/hook:guard-command');
      expect(finding.missingRef).toBe('jr/lib:rules-common');
      expect(finding.summary).toContain('jr/hook:guard-command');
      expect(finding.summary).toContain('jr/lib:rules-common');
      expect('repair' in finding).toBe(false);
    });
  });

  it('doctor-T8: générique — a non-lib requires ref (tool:git) broken the same way, exact R6 example', async () => {
    const manifest: Manifest = {
      version: 1,
      artifacts: [
        entry({
          id: 'example/skill:hello-rigger',
          nature: 'skill',
          assistant: 'claude',
          requires: ['example/tool:git'],
        }),
        // example/tool:git force-removed.
      ],
    };

    await withManifest(manifest, async (manifestPath) => {
      const findings = await edgeIntegrityScanner(ctxFor(manifestPath));

      const broken = findings.filter((f) => f.class === 'manifest' && f.issue === 'broken-edge');
      expect(broken).toHaveLength(1);
      const finding = broken[0]!;
      if (finding.class !== 'manifest' || finding.issue !== 'broken-edge') {
        throw new Error('unreachable');
      }
      expect(finding.nature).toBe('skill');
      expect(finding.missingRef).toBe('example/tool:git');
    });
  });

  it('doctor-T8: a requires ref whose target IS still installed is never flagged', async () => {
    const manifest: Manifest = {
      version: 1,
      artifacts: [
        entry({
          id: 'jr/hook:guard-command',
          nature: 'hook',
          assistant: 'claude',
          requires: ['jr/lib:rules-common'],
        }),
        entry({
          id: 'jr/lib:rules-common',
          nature: 'lib',
          assistant: 'shared',
          requires: [],
        }),
      ],
    };

    await withManifest(manifest, async (manifestPath) => {
      const findings = await edgeIntegrityScanner(ctxFor(manifestPath));
      expect(findings.filter((f) => f.class === 'manifest' && f.issue === 'broken-edge'))
        .toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// R7.2 — lib orpheline (graph half — the disk half lives in the phantom scanner)
// ---------------------------------------------------------------------------

describe('doctor-T8: lib orpheline (R7.2, graph half)', () => {
  it('doctor-T8: an installed lib with zero remaining dependents is orphan-lib, removable', async () => {
    const manifest: Manifest = {
      version: 1,
      artifacts: [
        entry({ id: 'jr/lib:rules-common', nature: 'lib', assistant: 'shared', requires: [] }),
        // No entry requires it any more (its last dependent's GC was refused earlier).
      ],
    };

    await withManifest(manifest, async (manifestPath) => {
      const findings = await edgeIntegrityScanner(ctxFor(manifestPath));

      const orphan = findings.filter((f) => f.class === 'manifest' && f.issue === 'orphan-lib');
      expect(orphan).toHaveLength(1);
      const finding = orphan[0]!;
      if (finding.class !== 'manifest' || finding.issue !== 'orphan-lib') {
        throw new Error('unreachable');
      }
      expect(finding.entryId).toBe('jr/lib:rules-common');
      expect(finding.summary).toContain('rigger remove jr/lib:rules-common');
      expect('repair' in finding).toBe(false);
    });
  });

  it('doctor-T8: a lib still required by an installed entry is never orphan-lib', async () => {
    const manifest: Manifest = {
      version: 1,
      artifacts: [
        entry({ id: 'jr/lib:rules-common', nature: 'lib', assistant: 'shared', requires: [] }),
        entry({
          id: 'jr/hook:guard-command',
          nature: 'hook',
          assistant: 'claude',
          requires: ['jr/lib:rules-common'],
        }),
      ],
    };

    await withManifest(manifest, async (manifestPath) => {
      const findings = await edgeIntegrityScanner(ctxFor(manifestPath));
      expect(findings.filter((f) => f.class === 'manifest' && f.issue === 'orphan-lib'))
        .toHaveLength(0);
    });
  });

  it('doctor-T8: a non-lib entry with zero dependents is never flagged orphan (only libs can be orphaned)', async () => {
    const manifest: Manifest = {
      version: 1,
      artifacts: [
        entry({ id: 'jr/skill:standalone', nature: 'skill', assistant: 'claude', requires: [] }),
      ],
    };

    await withManifest(manifest, async (manifestPath) => {
      const findings = await edgeIntegrityScanner(ctxFor(manifestPath));
      expect(findings.filter((f) => f.class === 'manifest' && f.issue === 'orphan-lib'))
        .toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// S6 — entrée sans edges (legacy)
// ---------------------------------------------------------------------------

describe('doctor-T8: entrée sans edges (S6)', () => {
  it('doctor-T8: a legacy entry with NO requires field at all is flagged no-edges (info)', async () => {
    const manifest: Manifest = {
      version: 1,
      artifacts: [
        // No `requires` key at all — pre-dates this change entirely.
        entry({ id: 'jr/skill:legacy', nature: 'skill', assistant: 'claude' }),
      ],
    };

    await withManifest(manifest, async (manifestPath) => {
      const findings = await edgeIntegrityScanner(ctxFor(manifestPath));

      const noEdges = findings.filter((f) => f.class === 'manifest' && f.issue === 'no-edges');
      expect(noEdges).toHaveLength(1);
      const finding = noEdges[0]!;
      if (finding.class !== 'manifest' || finding.issue !== 'no-edges') {
        throw new Error('unreachable');
      }
      expect(finding.entryId).toBe('jr/skill:legacy');
      expect(finding.summary).toContain('rigger update');
      expect('repair' in finding).toBe(false);
    });
  });

  it('doctor-T8: an entry with an explicit empty requires: [] is NOT flagged no-edges', async () => {
    const manifest: Manifest = {
      version: 1,
      artifacts: [
        entry({ id: 'jr/skill:resolved', nature: 'skill', assistant: 'claude', requires: [] }),
      ],
    };

    await withManifest(manifest, async (manifestPath) => {
      const findings = await edgeIntegrityScanner(ctxFor(manifestPath));
      expect(findings.filter((f) => f.class === 'manifest' && f.issue === 'no-edges'))
        .toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// doctor sur un état SAIN — zéro finding lib
// ---------------------------------------------------------------------------

describe('doctor-T8: état sain (lib + dépendants) — zéro finding', () => {
  it('doctor-T8: a lib with an installed dependent, edges recorded both ways, is silent', async () => {
    const manifest: Manifest = {
      version: 1,
      artifacts: [
        entry({ id: 'jr/lib:rules-common', nature: 'lib', assistant: 'shared', requires: [] }),
        entry({
          id: 'jr/hook:guard-command',
          nature: 'hook',
          assistant: 'claude',
          requires: ['jr/lib:rules-common'],
        }),
        entry({
          id: 'jr/plugin:guard-command',
          nature: 'plugin',
          assistant: 'opencode',
          requires: ['jr/lib:rules-common'],
        }),
      ],
    };

    await withManifest(manifest, async (manifestPath) => {
      // A truly healthy state ALSO means the home package.json carries the
      // correct #libs/* mapping — pre-populate it so this test's unfiltered
      // "zero findings" stays about edges, not about U1's own check.
      const env = fakeHomeEnv(manifestPath);
      await writeJson(homePackageJsonPath(env), {
        name: 'agent-rigger-home',
        imports: { '#libs/*': './libs/*' },
      });

      const findings = await edgeIntegrityScanner(ctxFor(manifestPath, env));
      expect(findings).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// U1 (lib-imports-alias) — lib-imports-missing
// ---------------------------------------------------------------------------

describe('doctor-T8u1: lib-imports-missing (U1, lib-imports-alias)', () => {
  it('doctor-T8u1: a lib entry with the home package.json ABSENT is flagged', async () => {
    const manifest: Manifest = {
      version: 1,
      artifacts: [
        entry({ id: 'jr/lib:rules-common', nature: 'lib', assistant: 'shared', requires: [] }),
      ],
    };

    await withManifest(manifest, async (manifestPath) => {
      const findings = await edgeIntegrityScanner(ctxFor(manifestPath));

      const missing = findings.filter(
        (f) => f.class === 'manifest' && f.issue === 'lib-imports-missing',
      );
      expect(missing).toHaveLength(1);
      const finding = missing[0]!;
      if (finding.class !== 'manifest' || finding.issue !== 'lib-imports-missing') {
        throw new Error('unreachable');
      }
      expect(finding.packageJsonPath).toBe(homePackageJsonPath(fakeHomeEnv(manifestPath)));
      expect(finding.summary).toContain('#libs/*');
      expect('repair' in finding).toBe(false);
    });
  });

  it('doctor-T8u1: a lib entry with the home package.json present but WITHOUT the #libs/* leaf is flagged', async () => {
    const manifest: Manifest = {
      version: 1,
      artifacts: [
        entry({ id: 'jr/lib:rules-common', nature: 'lib', assistant: 'shared', requires: [] }),
      ],
    };

    await withManifest(manifest, async (manifestPath) => {
      const env = fakeHomeEnv(manifestPath);
      await writeJson(homePackageJsonPath(env), { name: 'agent-rigger-home' });

      const findings = await edgeIntegrityScanner(ctxFor(manifestPath, env));
      expect(findings.filter((f) => f.class === 'manifest' && f.issue === 'lib-imports-missing'))
        .toHaveLength(1);
    });
  });

  it('doctor-T8u1: a lib entry with the home package.json present and CORRECT is silent', async () => {
    const manifest: Manifest = {
      version: 1,
      artifacts: [
        entry({ id: 'jr/lib:rules-common', nature: 'lib', assistant: 'shared', requires: [] }),
      ],
    };

    await withManifest(manifest, async (manifestPath) => {
      const env = fakeHomeEnv(manifestPath);
      await writeJson(homePackageJsonPath(env), {
        name: 'agent-rigger-home',
        imports: { '#libs/*': './libs/*' },
      });

      const findings = await edgeIntegrityScanner(ctxFor(manifestPath, env));
      expect(findings.filter((f) => f.class === 'manifest' && f.issue === 'lib-imports-missing'))
        .toHaveLength(0);
    });
  });

  it('doctor-T8u1: a manifest with NO lib entry never even reads the package.json (no finding regardless)', async () => {
    const manifest: Manifest = {
      version: 1,
      artifacts: [
        entry({ id: 'jr/skill:standalone', nature: 'skill', assistant: 'claude', requires: [] }),
      ],
    };

    await withManifest(manifest, async (manifestPath) => {
      // No package.json written at all under this fake home — if the check
      // were NOT gated on hasLibEntry, this would still produce a finding.
      const findings = await edgeIntegrityScanner(ctxFor(manifestPath));
      expect(findings.filter((f) => f.class === 'manifest' && f.issue === 'lib-imports-missing'))
        .toHaveLength(0);
    });
  });

  it('doctor-T8u1: a lib entry with a DIVERGENT #libs/* mapping (wrong target) is flagged', async () => {
    const manifest: Manifest = {
      version: 1,
      artifacts: [
        entry({ id: 'jr/lib:rules-common', nature: 'lib', assistant: 'shared', requires: [] }),
      ],
    };

    await withManifest(manifest, async (manifestPath) => {
      const env = fakeHomeEnv(manifestPath);
      await writeJson(homePackageJsonPath(env), {
        name: 'agent-rigger-home',
        imports: { '#libs/*': './wrong/*' },
      });

      const findings = await edgeIntegrityScanner(ctxFor(manifestPath, env));
      expect(findings.filter((f) => f.class === 'manifest' && f.issue === 'lib-imports-missing'))
        .toHaveLength(1);
    });
  });

  it(
    'doctor-T8u1: a MALFORMED home package.json degrades to the finding — '
      + 'the scanner never throws, unrelated findings from the SAME run survive (review fix)',
    async () => {
      const manifest: Manifest = {
        version: 1,
        artifacts: [
          entry({ id: 'jr/lib:rules-common', nature: 'lib', assistant: 'shared', requires: [] }),
          // A --force-removed dependency elsewhere → an UNRELATED broken-edge
          // finding this same scanner run must still surface.
          entry({
            id: 'jr/hook:guard-command',
            nature: 'hook',
            assistant: 'claude',
            requires: ['jr/lib:vanished'],
          }),
        ],
      };

      await withManifest(manifest, async (manifestPath) => {
        const env = fakeHomeEnv(manifestPath);
        const pkgPath = homePackageJsonPath(env);
        await mkdir(path.dirname(pkgPath), { recursive: true });
        // Genuinely invalid JSON — readJson would throw InvalidJsonError.
        await writeFile(pkgPath, '{ not valid json,,, ', 'utf8');

        // Must resolve (never reject/throw) despite the malformed file.
        const findings = await edgeIntegrityScanner(ctxFor(manifestPath, env));

        const missing = findings.filter(
          (f) => f.class === 'manifest' && f.issue === 'lib-imports-missing',
        );
        expect(missing).toHaveLength(1);

        // The unrelated broken-edge finding from the SAME run still surfaces
        // — the malformed package.json never aborts the rest of the scanner.
        const broken = findings.filter(
          (f) => f.class === 'manifest' && f.issue === 'broken-edge',
        );
        expect(broken).toHaveLength(1);
      });
    },
  );
});

// ---------------------------------------------------------------------------
// R7.4 — store lib disparu (missing-file, manifest-audit.ts — gratuit, no
// code change: `files[]` already carries the lib's store DIR (T3) and
// manifest-audit's existence check uses `stat` — which accepts directories —
// not `Bun.file().exists()`. This test only PROVES the free behaviour.
// ---------------------------------------------------------------------------

describe('doctor-T8: store lib disparu (R7.4, manifest-audit.ts — gratuit)', () => {
  it('doctor-T8: a lib entry whose files[] dir was deleted from disk is missing-file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rigger-doctor-t8-missing-lib-'));
    try {
      const manifestPath = path.join(dir, 'state.json');
      const libStoreDir = path.join(dir, 'libs', 'rules-common');
      // The lib's store dir NEVER created (or already removed) — same signal
      // either way for manifest-audit's existence check.
      const manifest: Manifest = {
        version: 1,
        artifacts: [
          entry({
            id: 'jr/lib:rules-common',
            nature: 'lib',
            assistant: 'shared',
            files: [libStoreDir],
            requires: [],
          }),
        ],
      };
      await writeFile(manifestPath, JSON.stringify(manifest));

      const findings = await manifestAuditScanner({
        env: {},
        manifestPath,
        configuredCatalogIds: [],
      });

      const missing = findings.filter((f) => f.class === 'manifest' && f.issue === 'missing-file');
      expect(missing).toHaveLength(1);
      const finding = missing[0]!;
      if (finding.class !== 'manifest' || finding.issue !== 'missing-file') {
        throw new Error('unreachable');
      }
      expect(finding.entryId).toBe('jr/lib:rules-common');
      expect(finding.missingPath).toBe(libStoreDir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// No manifest mutation — a scanner is read-only
// ---------------------------------------------------------------------------

describe('doctor-T8: the edge-integrity scanner never writes', () => {
  it('doctor-T8: scanning leaves state.json byte-identical', async () => {
    const manifest: Manifest = {
      version: 1,
      artifacts: [
        entry({ id: 'jr/lib:rules-common', nature: 'lib', assistant: 'shared', requires: [] }),
      ],
    };

    await withManifest(manifest, async (manifestPath) => {
      const before = await Bun.file(manifestPath).text();
      await edgeIntegrityScanner(ctxFor(manifestPath));
      const after = await Bun.file(manifestPath).text();
      expect(after).toBe(before);
    });
  });
});
