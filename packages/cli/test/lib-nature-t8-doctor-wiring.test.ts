/**
 * lib-nature-t8-doctor-wiring.test.ts — proves the T8 additions are actually
 * WIRED into `rigger doctor`'s real pipeline (cmd-doctor.ts's `assembleScanners`),
 * not just correct in isolation. Every other T8 test calls a scanner factory
 * directly; these run `runDoctorState` end-to-end with NO `scanners` override,
 * so the real adapters + the real assembled scanner list (including the new
 * `edgeIntegrityScanner` and the libs-aware phantom/hygiene scanners) produce
 * the report.
 *
 * Named scenarios (tasks.md T8, requirements.md R7/S6):
 *   - "doctor sur un état SAIN (lib + dépendants) → ZÉRO finding" — a real lib
 *     + a real installed consumer, resolved through the REAL `runRemoteInstall`
 *     pipeline (never a manual `requires` stamp): the full `rigger doctor`
 *     pipeline reports nothing at all.
 *   - "doctor sur un état SAIN (entrée zéro-dépendance)" — review T8 fix
 *     (tech-lead option A): a plain entry with NO declared requires, resolved
 *     through the REAL install pipeline, must persist `requires: []` (never
 *     `undefined`) and must NEVER trip the `no-edges` (S6) finding — a resolved
 *     entry is never "legacy" just because it has zero dependencies. This test
 *     is the one the review flagged as false-green before the fix: it failed
 *     against the pre-fix cmd-install.ts (which omitted the field on zero deps,
 *     making every fresh zero-dep entry misread as legacy) and passes after.
 *   - "edge cassé surfacé par le pipeline réel" — a dependent's required lib is
 *     force-removed out of band (an anomalous state a real install can never
 *     produce, so it is deliberately manifest-injected — same posture as the
 *     R6 refcount-gate tests' injected extra dependents): the broken edge
 *     still surfaces through the real pipeline.
 *   - "backfill S6 réel" — a legacy entry (requires field entirely absent,
 *     zero catalogue-side deps) trips `no-edges`; a REAL `rigger update`
 *     backfills `requires: []`; the finding clears. Proves the S6 promise
 *     ("backfilled at the first update") is not a permanent no-op for a
 *     zero-dependency entry — the exact bug the review caught.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createClaudeAdapter } from '@agent-rigger/adapters';
import { type CatalogEntry, type TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { apply } from '@agent-rigger/core/engine';
import { emptyManifest, readManifest, writeManifest } from '@agent-rigger/core/manifest';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';
import type { ManifestEntry } from '@agent-rigger/core/types';

import { runDoctorState } from '../src/cmd-doctor';
import { runUpdate } from '../src/cmd-update';
import { runRemoteInstall } from '../src/remote-install';

const TAG = 'v9.9.9';
const SHA = 'c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff';
const CATALOG_URL = 'https://example.com/jr.git';

function makeRunner(tag: string, sha: string): CommandRunner {
  return (_cmd, args) => {
    const argv = args ?? [];
    if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
      return Promise.resolve({ exitCode: 0, stdout: `${sha}\trefs/tags/${tag}\n`, stderr: '' });
    }
    if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
      return Promise.resolve({ exitCode: 0, stdout: `${sha}\tHEAD\n`, stderr: '' });
    }
    if (argv[0] === 'clone') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${sha}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };
}

interface Harness {
  env: Env;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  stateJson: string;
  cleanup: () => Promise<void>;
}

/** Build an isolated HOME + an in-memory checkout for the `jr` catalogue. */
async function makeEnv(entries: CatalogEntry[], files: Record<string, string>): Promise<Harness> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t8-wiring-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t8-wiring-content-'));

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 'jr' }, entries }),
    'utf8',
  );
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(contentDir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content, 'utf8');
  }
  await fs.mkdir(path.join(homeDir, '.config', 'agent-rigger'), { recursive: true });

  const env: Env = { RIGGER_HOME: homeDir };
  return {
    env,
    runner: makeRunner(TAG, SHA),
    tmpFactory: async () => ({ path: contentDir, cleanup: async () => {} }),
    stateJson: resolveUserTargets(env).stateJson,
    cleanup: async () => {
      await fs.rm(homeDir, { recursive: true, force: true });
      await fs.rm(contentDir, { recursive: true, force: true });
    },
  };
}

function collectingPrinter(): { print: (s: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { print: (s: string) => lines.push(s), lines };
}

async function doctorReport(env: Env): Promise<{ code: number; report: string }> {
  const { print, lines } = collectingPrinter();
  const code = await runDoctorState({
    env,
    print,
    fix: false,
    yes: false,
    isTTY: false,
    configuredCatalogIds: ['jr'],
    color: false,
    // No `scanners` override — the REAL assembleScanners() builds the pipeline,
    // including edgeIntegrityScanner and the libs-aware phantom/hygiene scanners.
  });
  return { code, report: lines.join('\n') };
}

async function requiresOf(stateJson: string, id: string): Promise<string[] | undefined> {
  const manifest = await readManifest(stateJson);
  return manifest.artifacts.find((e) => e.id === id)?.requires;
}

// ---------------------------------------------------------------------------
// état sain — lib + dépendants réels, résolus par le VRAI pipeline d'install
// ---------------------------------------------------------------------------

describe('doctor-T8 wiring: état sain (lib + dépendants réels) — zéro finding', () => {
  it('a real lib + a real consumer, resolved via runRemoteInstall, are silent end-to-end', async () => {
    const h = await makeEnv(
      [
        {
          kind: 'artifact',
          id: 'lib:rules-common',
          nature: 'lib',
          scopes: ['user'],
        } as CatalogEntry,
        {
          kind: 'artifact',
          id: 'skill:consumer',
          nature: 'skill',
          targets: ['claude'],
          scopes: ['user'],
          requires: ['lib:rules-common'],
        },
      ],
      {
        'common/skills/consumer/SKILL.md': '# consumer\n',
        'common/libs/rules-common/rules.ts': 'export const rule = 1;\n',
      },
    );
    try {
      await runRemoteInstall({
        ids: ['jr/skill:consumer'],
        catalogUrl: CATALOG_URL,
        scope: 'user',
        env: h.env,
        manifestPath: h.stateJson,
        runner: h.runner,
        tmpFactory: h.tmpFactory,
        confirm: true,
        scanner: stubScanner,
        sourceName: 'jr',
      });

      // The requires edge is the RESOLVER's, never a manual stamp.
      expect(await requiresOf(h.stateJson, 'jr/skill:consumer')).toEqual(['jr/lib:rules-common']);

      const { code, report } = await doctorReport(h.env);
      expect(report).toContain('healthy');
      expect(code).toBe(0);
    } finally {
      await h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// état sain — entrée ZÉRO-DÉPENDANCE réelle (le test faux-vert de la review)
// ---------------------------------------------------------------------------

describe('doctor-T8 wiring: état sain (entrée zéro-dépendance réelle)', () => {
  it('a plain entry with no declared requires, installed for real, persists requires:[] and never trips no-edges', async () => {
    const h = await makeEnv(
      [
        {
          kind: 'artifact',
          id: 'skill:standalone',
          nature: 'skill',
          targets: ['claude'],
          scopes: ['user'],
        },
      ],
      { 'common/skills/standalone/SKILL.md': '# standalone\n' },
    );
    try {
      await runRemoteInstall({
        ids: ['jr/skill:standalone'],
        catalogUrl: CATALOG_URL,
        scope: 'user',
        env: h.env,
        manifestPath: h.stateJson,
        runner: h.runner,
        tmpFactory: h.tmpFactory,
        confirm: true,
        scanner: stubScanner,
        sourceName: 'jr',
      });

      // The persisted convention (review T8, option A): a RESOLVED entry
      // always carries the array, even empty — `undefined` is reserved for
      // legacy entries that predate the requires graph entirely.
      expect(await requiresOf(h.stateJson, 'jr/skill:standalone')).toEqual([]);

      const { code, report } = await doctorReport(h.env);
      expect(report).not.toContain('predates the requires graph');
      expect(report).toContain('healthy');
      expect(code).toBe(0);
    } finally {
      await h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// edge cassé — état anomal, injecté (un vrai install ne peut pas le produire)
// ---------------------------------------------------------------------------

describe('doctor-T8 wiring: edge cassé surfacé par le pipeline réel', () => {
  it('a force-removed lib leaves its dependent with a broken edge — surfaced end-to-end', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t8-wiring-brokenedge-'));
    const fixturesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t8-wiring-fixtures-'));
    try {
      const env: Env = { RIGGER_HOME: tmpHome };
      const manifestPath = resolveUserTargets(env).stateJson;

      const skillSource = path.join(fixturesDir, 'consumer');
      await fs.mkdir(skillSource, { recursive: true });
      await fs.writeFile(path.join(skillSource, 'SKILL.md'), '# consumer\n');

      const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => skillSource });
      await apply({
        adapter,
        entries: [{ id: 'jr/skill:consumer', nature: 'skill', scope: 'user' }],
        scope: 'user',
        env,
        manifestPath,
        versionFor: () => ({ ref: 'v1.0.0', sha: 'cafebabe' }),
      });

      // Simulate a prior `--force` removal of jr/lib:rules-common while this
      // dependent survived (R6 "--force documenté") — the lib entry never
      // exists. Deliberate manifest injection: no real install can produce
      // this state, matching the R6 refcount-gate tests' own posture of
      // injecting extra dependents directly into the graph.
      const manifest = await readManifest(manifestPath);
      await writeManifest(manifestPath, {
        ...manifest,
        artifacts: manifest.artifacts.map((e) =>
          e.id === 'jr/skill:consumer' ? { ...e, requires: ['jr/lib:rules-common'] } : e
        ),
      });

      const { code, report } = await doctorReport(env);
      expect(code).toBe(3);
      expect(report).toContain('jr/skill:consumer');
      expect(report).toContain('jr/lib:rules-common');
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      await fs.rm(fixturesDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// backfill S6 réel — legacy zéro-dép → finding → update réel → finding absent
// ---------------------------------------------------------------------------

describe('doctor-T8 wiring: backfill S6 réel (legacy zéro-dép)', () => {
  it('a legacy zero-dep entry trips no-edges, a real update backfills requires:[], the finding clears', async () => {
    const h = await makeEnv(
      [
        {
          kind: 'artifact',
          id: 'skill:consumer',
          nature: 'skill',
          targets: ['claude'],
          scopes: ['user'],
          // Deliberately NO requires field at all — the catalogue itself
          // declares zero dependencies for this entry.
        },
      ],
      { 'common/skills/consumer/SKILL.md': '# consumer\n' },
    );
    try {
      // Legacy manifest entry: installed before this change, NO requires field,
      // stale ref so `update` re-resolves it.
      await writeManifest(h.stateJson, {
        ...emptyManifest(),
        artifacts: [
          {
            id: 'jr/skill:consumer',
            nature: 'skill',
            ref: 'v1.0.0',
            sha: 'dead',
            scope: 'user',
            installedAt: new Date().toISOString(),
            files: [],
            assistant: 'claude',
          } satisfies ManifestEntry,
        ],
      });

      expect(await requiresOf(h.stateJson, 'jr/skill:consumer')).toBeUndefined();
      const before = await doctorReport(h.env);
      expect(before.report).toContain('predates the requires graph');

      const result = await runUpdate({
        ids: ['jr/skill:consumer'],
        scope: 'user',
        env: h.env,
        manifestPath: h.stateJson,
        catalogUrl: CATALOG_URL,
        runner: h.runner,
        tmpFactory: h.tmpFactory,
        confirm: true,
        scanner: stubScanner,
      });
      expect(result.updated).toContain('jr/skill:consumer');

      // Backfilled to an EXPLICIT empty array — not re-omitted (the review's fix).
      expect(await requiresOf(h.stateJson, 'jr/skill:consumer')).toEqual([]);

      const after = await doctorReport(h.env);
      expect(after.report).not.toContain('predates the requires graph');
    } finally {
      await h.cleanup();
    }
  });
});
