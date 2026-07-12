/**
 * b1b4-r4-recommended-precheck.test.ts — R4: relay each catalog's
 * meta.recommended opinion into the install picker's pre-checked set.
 *
 * handleInstall's interactive branch reads `effectiveFull.metaBySource` (bare
 * ids per source), qualifies each recommended id with its source name, and
 * builds two sets passed to the status picker: `recommended` (qualified union)
 * and `optingPrefixes` (sources whose recommended list is non-empty — the
 * per-catalog rule: MetaSchema defaults recommended to [], so non-emptiness is
 * what counts as "declares an opinion"). The pure pre-check logic lives in
 * buildStatusInitialValues (tested in ui.test.ts); this suite proves the CLI
 * BUILDS those sets correctly from a real multi-catalog fetch.
 *
 * One test per scenario in requirements.md (R4), named `b1b4-R4: …` (stock §8
 * traceability). The injected status picker captures BOTH its arguments
 * (entries + opts); assertions check the constructed sets and — via the real
 * buildStatusInitialValues on the captured args — the resulting pre-check.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';

import type { CliPrompts } from '../src/cli';
import { runCli } from '../src/cli';
import {
  buildStatusInitialValues,
  type StatusedEntry,
  type StatusInitialValuesOpts,
} from '../src/ui';
import { pinStdinIsTTY, pinStdoutIsTTY } from './fixtures/tty';

pinStdoutIsTTY(false);
pinStdinIsTTY(false);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TAG = 'v1.0.0';
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OLD_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function skill(local: string): CatalogEntry {
  return {
    kind: 'artifact',
    id: `skill:${local}`,
    nature: 'skill',
    targets: ['claude'],
    scopes: ['user', 'project'],
  };
}

interface CatalogSpec {
  name: string;
  recommended?: string[];
  entries: CatalogEntry[];
}

interface Captured {
  entries: StatusedEntry[] | null;
  opts: StatusInitialValuesOpts | undefined;
  called: boolean;
}

function makePrompts(captured: Captured): CliPrompts {
  return {
    selectArtifacts: async () => [],
    selectArtifactsByStatus: async (entries, opts) => {
      captured.entries = entries;
      captured.opts = opts;
      captured.called = true;
      return [];
    },
    selectScope: async () => 'user',
    confirmApply: async () => true,
    askUrl: async () => '',
    askMethod: async () => 'https',
  };
}

interface Iso {
  env: Env;
  targets: ReturnType<typeof resolveUserTargets>;
  makeRunner: () => CommandRunner;
  makeTmpFactory: () => TmpDirFactory;
  seedManifest: (
    artifacts: Array<{ id: string; ref: string; sha?: string }>,
  ) => Promise<void>;
  cleanup: () => Promise<void>;
}

/**
 * Isolated env with `specs` catalogs configured (config order preserved). The
 * tmpFactory returns each catalog's content in config order via a call counter:
 * resolveEffectiveCatalogFull fetches sources with the fake runner in lockstep
 * (identical code paths, all Promise.resolve), so the Nth tmpFactory call maps
 * to config.catalogs[N] deterministically — the only way to give each source
 * its own meta.recommended through the arg-less TmpDirFactory seam.
 */
async function makeIso(specs: CatalogSpec[]): Promise<Iso> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-b1b4-r4-home-'));
  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      catalogs: specs.map((s) => ({ name: s.name, url: `https://example.com/${s.name}.git` })),
    }),
    'utf8',
  );

  const env: Env = { RIGGER_HOME: homeDir };
  const targets = resolveUserTargets(env);
  const tmpDirs: string[] = [];

  const makeRunner = (): CommandRunner => (_cmd, args) => {
    const argv = args ?? [];
    if (argv[0] === 'ls-remote' && argv.includes('--tags')) {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\trefs/tags/${TAG}\n`, stderr: '' });
    }
    if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\tHEAD\n`, stderr: '' });
    }
    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };

  const makeTmpFactory = (): TmpDirFactory => {
    let fetchCount = 0;
    return async () => {
      const spec = specs[fetchCount++ % specs.length] as CatalogSpec;
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-b1b4-r4-checkout-'));
      tmpDirs.push(tmpDir);
      await fs.writeFile(
        path.join(tmpDir, 'catalog.json'),
        JSON.stringify({
          meta: {
            name: spec.name,
            ...(spec.recommended === undefined ? {} : { recommended: spec.recommended }),
          },
          entries: spec.entries,
        }),
        'utf8',
      );
      for (const e of spec.entries) {
        if (e.kind === 'artifact' && e.nature === 'skill') {
          const localName = e.id.replace(/^skill:/, '');
          await fs.mkdir(path.join(tmpDir, 'skills', localName), { recursive: true });
          await fs.writeFile(
            path.join(tmpDir, 'skills', localName, 'SKILL.md'),
            `# ${localName}\n${TAG}@${SHA}`,
            'utf8',
          );
        }
      }
      return {
        path: tmpDir,
        cleanup: async () => {
          await fs.rm(tmpDir, { recursive: true, force: true });
        },
      };
    };
  };

  const seedManifest: Iso['seedManifest'] = async (artifacts) => {
    await fs.writeFile(
      targets.stateJson,
      JSON.stringify({
        version: 1,
        artifacts: artifacts.map((a) => ({
          id: a.id,
          nature: 'skill',
          ref: a.ref,
          sha: a.sha ?? SHA,
          scope: 'user',
        })),
      }),
      'utf8',
    );
  };

  const cleanup = async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  };

  return { env, targets, makeRunner, makeTmpFactory, seedManifest, cleanup };
}

async function runPicker(iso: Iso): Promise<Captured> {
  const captured: Captured = { entries: null, opts: undefined, called: false };
  await runCli(['install'], {
    print: () => {},
    env: iso.env,
    prompts: makePrompts(captured),
    remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
  });
  return captured;
}

/** Pre-checked ids the picker would show, from the captured args. */
function prechecked(c: Captured): string[] {
  return buildStatusInitialValues(c.entries ?? [], c.opts);
}

// ---------------------------------------------------------------------------
// Scenario 1: recommandé pré-coché, non-recommandé décoché
// ---------------------------------------------------------------------------

describe('b1b4-R4: recommandé pré-coché, non-recommandé décoché', () => {
  it("b1b4-R4: catalogue avec recommended → seule l'entrée recommandée est pré-cochée", async () => {
    const iso = await makeIso([
      { name: 'cat', recommended: ['skill:a'], entries: [skill('a'), skill('b')] },
    ]);
    await iso.seedManifest([]); // both uninstalled → both 'install' → picker opens
    const c = await runPicker(iso);

    try {
      expect(c.called).toBe(true);
      expect(c.opts?.recommended).toEqual(new Set(['cat/skill:a']));
      expect(c.opts?.optingPrefixes).toEqual(new Set(['cat']));
      // Resulting pre-check: skill:a checked, skill:b listed but unchecked.
      expect(prechecked(c)).toEqual(['cat/skill:a']);
    } finally {
      await iso.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: les updates restent toujours pré-cochées
// ---------------------------------------------------------------------------

describe('b1b4-R4: les updates restent toujours pré-cochées', () => {
  it('b1b4-R4: un update non recommandé reste pré-coché', async () => {
    const iso = await makeIso([
      { name: 'cat', recommended: ['skill:a'], entries: [skill('a'), skill('c')] },
    ]);
    // skill:c installed at an older sha → 'update'; skill:a uninstalled → 'install'.
    await iso.seedManifest([{ id: 'cat/skill:c', ref: 'v0.9.0', sha: OLD_SHA }]);
    const c = await runPicker(iso);

    try {
      expect(c.called).toBe(true);
      // skill:c is not recommended, yet an update is always pre-checked.
      expect(prechecked(c)).toContain('cat/skill:c');
    } finally {
      await iso.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: un recommandé déjà à jour n'est pas pré-coché
// ---------------------------------------------------------------------------

describe('b1b4-R4: recommandé déjà à jour non pré-coché', () => {
  it('b1b4-R4: recommandé + current → décoché (pas de réinstallation implicite)', async () => {
    const iso = await makeIso([
      { name: 'cat', recommended: ['skill:a'], entries: [skill('a'), skill('b')] },
    ]);
    // skill:a recommended AND installed at latest → 'current'; skill:b uninstalled
    // keeps the picker open.
    await iso.seedManifest([{ id: 'cat/skill:a', ref: TAG }]);
    const c = await runPicker(iso);

    try {
      expect(c.called).toBe(true);
      expect(prechecked(c)).not.toContain('cat/skill:a');
    } finally {
      await iso.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: aucun recommended déclaré → comportement inchangé
// ---------------------------------------------------------------------------

describe('b1b4-R4: aucun recommended déclaré', () => {
  it('b1b4-R4: catalogue sans meta.recommended → tout install ∪ update pré-coché', async () => {
    const iso = await makeIso([
      { name: 'cat', entries: [skill('a'), skill('b')] }, // no recommended
    ]);
    await iso.seedManifest([]);
    const c = await runPicker(iso);

    try {
      expect(c.called).toBe(true);
      // The catalog declares no opinion → absent from optingPrefixes.
      expect(c.opts?.optingPrefixes.has('cat')).toBe(false);
      expect(new Set(prechecked(c))).toEqual(new Set(['cat/skill:a', 'cat/skill:b']));
    } finally {
      await iso.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: multi-catalogue, recommandations qualifiées par préfixe
// ---------------------------------------------------------------------------

describe('b1b4-R4: multi-catalogue règle par catalogue', () => {
  it('b1b4-R4: catA opte, catB non → recommandé de catA qualifié, catB garde son install', async () => {
    const iso = await makeIso([
      { name: 'catA', recommended: ['skill:a'], entries: [skill('a'), skill('b')] },
      { name: 'catB', entries: [skill('a'), skill('b')] }, // no opinion
    ]);
    await iso.seedManifest([]);
    const c = await runPicker(iso);

    try {
      expect(c.called).toBe(true);
      // Qualification is per-source; catB (no opinion) is absent from optingPrefixes.
      expect(c.opts?.recommended).toEqual(new Set(['catA/skill:a']));
      expect(c.opts?.optingPrefixes).toEqual(new Set(['catA']));
      // catA: only recommended pre-checked; catB (no opinion): all install pre-checked.
      expect(new Set(prechecked(c))).toEqual(
        new Set(['catA/skill:a', 'catB/skill:a', 'catB/skill:b']),
      );
    } finally {
      await iso.cleanup();
    }
  });
});
