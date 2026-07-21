/**
 * lib-nature-t7-surfaces.test.ts — R8: ls/info/picker/exhaustiveness surfaces,
 * plus the T3-differed dedicated `update lib:x` direct message.
 *
 * Contract (requirements.md R8, design.md § Surfaces R8):
 *  - `rigger ls` / `rigger libs ls` list a lib with its nature; `[installed]`
 *    reflects the manifest's `assistant:'shared'` entry regardless of any
 *    --assistant filter (a lib is a global singleton, S2).
 *  - `rigger libs info <id>` shows the installed dependents (consumers whose
 *    persisted `requires` edge names the lib, S4).
 *  - The 4 interactive picker feeds (grouped/status-aware, flat fallback,
 *    ad-hoc, post-init/catalog-add proposal) never offer a lib for direct
 *    selection; selecting a CONSUMER still resolves and materialises the lib
 *    (D1, post-selection).
 *  - `install <catalog>/lib:x` explicit stays refused end-to-end through the
 *    full CLI path (non-regression of S7/T3, unit-level coverage already in
 *    lib-nature-t3-materialize.test.ts).
 *  - `update lib:x` direct: the skip reason is a dedicated, actionable
 *    message instead of the incidental "not installed" (T3 differed this to
 *    T7). The T3 pin (`updated === []`, id in `skipped`) stays green — only
 *    the message text changes.
 *  - `libs check` is rejected (a lib has no per-assistant state) instead of
 *    silently reaching the adapter-check filter with an unhandled nature.
 *  - Exhaustiveness (R8.4): every nature in NATURES is either covered by
 *    RESOURCE_NATURE_MAP / PREFIX_TO_NATURE / ADAPTER_CHECK_NATURES, or a
 *    declared exclusion — never a silent gap when a future 10th nature lands.
 *
 * Harness mirrors lib-nature-t3-e2e.test.ts (lib + consumer catalog, real
 * checkout via tmpFactory) combined with b1b4-r3-pack-status.test.ts /
 * govid-r1-own-ids-only.test.ts's picker-capture pattern (injected prompts
 * record what they're offered, no real clack).
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type CatalogEntry, NATURES, type TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { readManifest, writeManifest } from '@agent-rigger/core/manifest';
import { libsDir, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';

import { ADAPTER_CHECK_NATURES, type CliDeps, PREFIX_TO_NATURE, runCli } from '../src/cli';
import { RESOURCE_NATURE_MAP, runLs } from '../src/cmd-ls';
import { runUpdate } from '../src/cmd-update';
import type { StatusedEntry } from '../src/ui';
import { pinStdoutIsTTY, setStdoutIsTTY } from './fixtures/tty';

// Injected prompts drive every interactive scenario below; pin non-TTY at the
// file level (govid/b1b4-r3 convention) — the one propose-install test that
// needs a real TTY flips it locally via setStdoutIsTTY, restored by this hook.
pinStdoutIsTTY(false);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TAG = 'v1.0.0';
const SHA = 'c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff';
const CATALOG_URL = 'https://example.com/principal.git';

const LIB_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'lib:rules-common',
  nature: 'lib',
  scopes: ['user'],
} as CatalogEntry;

const CONSUMER_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:consumer',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user'],
  requires: ['lib:rules-common'],
};

const CATALOG_ENTRIES: CatalogEntry[] = [LIB_ENTRY, CONSUMER_ENTRY];

const CHECKOUT_FILES: Record<string, string> = {
  'common/skills/consumer/SKILL.md': '# consumer\n',
  'common/libs/rules-common/rules.ts': 'export const rule = 1;\n',
};

function makeRunner(): CommandRunner {
  return (_cmd, args) => {
    const argv = args ?? [];
    if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\trefs/tags/${TAG}\n`, stderr: '' });
    }
    if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\tHEAD\n`, stderr: '' });
    }
    if (argv[0] === 'clone') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };
}

async function dirExists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true).catch(() => false);
}

// ---------------------------------------------------------------------------
// Harness 1 — configured catalog ('principal'), used by the main install flow
// (grouped/flat picker feeds, D1, info, non-regression explicit-install).
// ---------------------------------------------------------------------------

interface Harness {
  env: Env;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  stateJson: string;
  cleanup: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t7-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t7-content-'));

  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify({ catalogs: [{ name: 'principal', url: CATALOG_URL }] }),
    'utf8',
  );

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 'principal' }, entries: CATALOG_ENTRIES }),
    'utf8',
  );
  for (const [rel, content] of Object.entries(CHECKOUT_FILES)) {
    const dest = path.join(contentDir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content, 'utf8');
  }

  const env: Env = { RIGGER_HOME: homeDir };
  return {
    env,
    runner: makeRunner(),
    tmpFactory: async () => ({ path: contentDir, cleanup: async () => {} }),
    stateJson: resolveUserTargets(env).stateJson,
    cleanup: async () => {
      await fs.rm(homeDir, { recursive: true, force: true });
      await fs.rm(contentDir, { recursive: true, force: true });
    },
  };
}

function basePrompts(overrides: Partial<NonNullable<CliDeps['prompts']>> = {}) {
  return {
    selectArtifacts: async () => [],
    selectScope: async () => 'user' as const,
    confirmApply: async () => true,
    askUrl: async () => '',
    askMethod: async () => 'https' as const,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scenario: ls et info (RESOURCE_NATURE_MAP gains lib/libs, info shows edges)
// ---------------------------------------------------------------------------

describe('R8 scenario "ls et info"', () => {
  it('RESOURCE_NATURE_MAP maps lib/libs to nature "lib" — `libs ls` filters to the lib only', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t7-ls-'));
    try {
      expect(RESOURCE_NATURE_MAP['libs']).toBe('lib');
      expect(RESOURCE_NATURE_MAP['lib']).toBe('lib');
      const result = await runLs({
        catalog: CATALOG_ENTRIES,
        env: { RIGGER_HOME: tmp },
        scope: 'user',
        resourceFilter: 'lib',
      });
      expect(result.count).toBe(1);
      expect(result.output).toContain('lib:rules-common');
      expect(result.output).not.toContain('skill:consumer');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('`rigger ls` (unfiltered) shows the lib among all entries, with nature "lib"', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t7-ls-'));
    try {
      const result = await runLs({
        catalog: CATALOG_ENTRIES,
        env: { RIGGER_HOME: tmp },
        scope: 'user',
      });
      const libLine = result.output.split('\n').find((l) => l.includes('lib:rules-common'));
      expect(libLine).toBeDefined();
      expect(libLine).toContain('lib');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('an installed lib (assistant:"shared") shows [installed] regardless of an --assistant filter', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t7-ls-'));
    try {
      const configDir = path.join(tmp, '.config', 'agent-rigger');
      await fs.mkdir(configDir, { recursive: true });
      const stateJson = path.join(configDir, 'state.json');
      await writeManifest(stateJson, {
        version: 1,
        artifacts: [
          {
            id: 'lib:rules-common',
            nature: 'lib',
            ref: TAG,
            sha: SHA,
            scope: 'user',
            installedAt: new Date().toISOString(),
            files: [],
            assistant: 'shared',
          },
        ],
      });

      const result = await runLs({
        catalog: CATALOG_ENTRIES,
        env: { RIGGER_HOME: tmp },
        scope: 'user',
        assistant: 'opencode',
      });
      const libLine = result.output.split('\n').find((l) => l.includes('lib:rules-common'));
      expect(libLine).toContain('[installed]');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('`rigger libs info <id>` shows the installed dependent(s) via the persisted requires edge', async () => {
    const h = await makeHarness();
    try {
      await writeManifest(h.stateJson, {
        version: 1,
        artifacts: [
          {
            id: 'principal/lib:rules-common',
            nature: 'lib',
            ref: TAG,
            sha: SHA,
            scope: 'user',
            installedAt: new Date().toISOString(),
            files: [],
            assistant: 'shared',
          },
          {
            id: 'principal/skill:consumer',
            nature: 'skill',
            ref: TAG,
            sha: SHA,
            scope: 'user',
            installedAt: new Date().toISOString(),
            files: [],
            assistant: 'claude',
            requires: ['principal/lib:rules-common'],
          },
        ],
      });

      const lines: string[] = [];
      const code = await runCli(['libs', 'info', 'principal/lib:rules-common'], {
        print: (m) => lines.push(m),
        env: h.env,
        remote: { run: h.runner, tmpFactory: h.tmpFactory, scanner: stubScanner },
      });

      expect(code).toBe(0);
      const output = lines.join('\n');
      expect(output).toContain('used by:');
      expect(output).toContain('principal/skill:consumer');
    } finally {
      await h.cleanup();
    }
  });

  it('a consumer installed for two assistants is listed once in "used by:" (dedup)', async () => {
    const h = await makeHarness();
    try {
      await writeManifest(h.stateJson, {
        version: 1,
        artifacts: [
          {
            id: 'principal/lib:rules-common',
            nature: 'lib',
            ref: TAG,
            sha: SHA,
            scope: 'user',
            installedAt: new Date().toISOString(),
            files: [],
            assistant: 'shared',
          },
          {
            id: 'principal/skill:consumer',
            nature: 'skill',
            ref: TAG,
            sha: SHA,
            scope: 'user',
            installedAt: new Date().toISOString(),
            files: [],
            assistant: 'claude',
            requires: ['principal/lib:rules-common'],
          },
          {
            id: 'principal/skill:consumer',
            nature: 'skill',
            ref: TAG,
            sha: SHA,
            scope: 'user',
            installedAt: new Date().toISOString(),
            files: [],
            assistant: 'opencode',
            requires: ['principal/lib:rules-common'],
          },
        ],
      });

      const lines: string[] = [];
      const code = await runCli(['libs', 'info', 'principal/lib:rules-common'], {
        print: (m) => lines.push(m),
        env: h.env,
        remote: { run: h.runner, tmpFactory: h.tmpFactory, scanner: stubScanner },
      });

      expect(code).toBe(0);
      const output = lines.join('\n');
      const usedByLine = output.split('\n').find((l) => l.includes('used by:'));
      expect(usedByLine).toBeDefined();
      // Exactly one occurrence of the consumer id on the line — not "id, id".
      const occurrences = usedByLine?.split('principal/skill:consumer').length ?? 0;
      expect(occurrences - 1).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  it('info omits the "used by:" line when the lib has no installed dependent', async () => {
    const h = await makeHarness();
    try {
      const lines: string[] = [];
      const code = await runCli(['libs', 'info', 'principal/lib:rules-common'], {
        print: (m) => lines.push(m),
        env: h.env,
        remote: { run: h.runner, tmpFactory: h.tmpFactory, scanner: stubScanner },
      });
      expect(code).toBe(0);
      expect(lines.join('\n')).not.toContain('used by:');
    } finally {
      await h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario: picker sans libs — feed 1 (install groupé / status-aware picker)
// ---------------------------------------------------------------------------

describe('R8 scenario "picker sans libs" — feed 1: grouped/status-aware picker', () => {
  it('never offers the lib for direct selection (the consumer IS offered)', async () => {
    const h = await makeHarness();
    try {
      const captured: { value: StatusedEntry[] | null } = { value: null };
      const code = await runCli(['install'], {
        print: () => {},
        env: h.env,
        prompts: basePrompts({
          selectArtifactsByStatus: async (entries) => {
            captured.value = entries;
            return [];
          },
        }),
        remote: { run: h.runner, tmpFactory: h.tmpFactory, scanner: stubScanner },
      });

      expect(code).toBe(0);
      expect(captured.value).not.toBeNull();
      expect(captured.value?.some((s) => s.id === 'principal/lib:rules-common')).toBe(false);
      expect(captured.value?.some((s) => s.id === 'principal/skill:consumer')).toBe(true);
    } finally {
      await h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario: picker sans libs — feed 2 (fallback plat, legacy selectArtifacts)
// ---------------------------------------------------------------------------

describe('R8 scenario "picker sans libs" — feed 2: flat fallback picker', () => {
  it('never offers the lib for direct selection (the consumer IS offered)', async () => {
    const h = await makeHarness();
    try {
      const captured: { value: CatalogEntry[] | null } = { value: null };
      const code = await runCli(['install'], {
        print: () => {},
        env: h.env,
        prompts: basePrompts({
          selectArtifacts: async (entries) => {
            captured.value = entries;
            return [];
          },
        }),
        remote: { run: h.runner, tmpFactory: h.tmpFactory, scanner: stubScanner },
      });

      expect(code).toBe(0);
      expect(captured.value).not.toBeNull();
      expect(captured.value?.some((e) => e.id === 'principal/lib:rules-common')).toBe(false);
      expect(captured.value?.some((e) => e.id === 'principal/skill:consumer')).toBe(true);
    } finally {
      await h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario: picker sans libs — feed 3 (ad-hoc)
// ---------------------------------------------------------------------------

describe('R8 scenario "picker sans libs" — feed 3: ad-hoc install', () => {
  it('the interactive ad-hoc picker never offers the lib for direct selection', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t7-adhoc-home-'));
    const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t7-adhoc-content-'));
    try {
      await fs.writeFile(
        path.join(contentDir, 'catalog.json'),
        JSON.stringify({ meta: { name: 'adhoc-lib-catalog' }, entries: CATALOG_ENTRIES }),
        'utf8',
      );
      for (const [rel, content] of Object.entries(CHECKOUT_FILES)) {
        const dest = path.join(contentDir, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, content, 'utf8');
      }
      await fs.mkdir(path.join(homeDir, '.config', 'agent-rigger'), { recursive: true });
      const env: Env = { RIGGER_HOME: homeDir };
      const tmpFactory: TmpDirFactory = async () => ({ path: contentDir, cleanup: async () => {} });

      const captured: { value: CatalogEntry[] | null } = { value: null };
      const code = await runCli(['install', 'https://github.com/owner/lib-catalog.git'], {
        print: () => {},
        env,
        prompts: basePrompts({
          selectArtifacts: async (entries) => {
            captured.value = entries;
            return [];
          },
        }),
        remote: { run: makeRunner(), tmpFactory, scanner: stubScanner },
      });

      expect(code).toBe(0);
      expect(captured.value).not.toBeNull();
      expect(captured.value?.some((e) => e.id.endsWith('lib:rules-common'))).toBe(false);
      expect(captured.value?.some((e) => e.id.endsWith('skill:consumer'))).toBe(true);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      await fs.rm(contentDir, { recursive: true, force: true });
    }
  });

  it('--yes installs the consumer and transitively pulls the lib (no ExplicitLibInstallError)', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t7-adhoc-home-'));
    const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t7-adhoc-content-'));
    try {
      await fs.writeFile(
        path.join(contentDir, 'catalog.json'),
        JSON.stringify({ meta: { name: 'adhoc-lib-catalog' }, entries: CATALOG_ENTRIES }),
        'utf8',
      );
      for (const [rel, content] of Object.entries(CHECKOUT_FILES)) {
        const dest = path.join(contentDir, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, content, 'utf8');
      }
      await fs.mkdir(path.join(homeDir, '.config', 'agent-rigger'), { recursive: true });
      const env: Env = { RIGGER_HOME: homeDir };
      const tmpFactory: TmpDirFactory = async () => ({ path: contentDir, cleanup: async () => {} });

      const code = await runCli(
        ['install', 'https://github.com/owner/lib-catalog.git', '--yes'],
        { print: () => {}, env, remote: { run: makeRunner(), tmpFactory, scanner: stubScanner } },
      );

      expect(code).toBe(0);
      const manifest = await readManifest(resolveUserTargets(env).stateJson);
      expect(manifest.artifacts.some((a) => a.nature === 'skill')).toBe(true);
      expect(manifest.artifacts.some((a) => a.nature === 'lib' && a.assistant === 'shared'))
        .toBe(true);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      await fs.rm(contentDir, { recursive: true, force: true });
    }
  });

  it('--yes on a catalog containing ONLY libs: the message names the reason, not "empty"', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t7-adhoc-libonly-home-'));
    const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t7-adhoc-libonly-content-'));
    try {
      await fs.writeFile(
        path.join(contentDir, 'catalog.json'),
        JSON.stringify({ meta: { name: 'adhoc-libonly-catalog' }, entries: [LIB_ENTRY] }),
        'utf8',
      );
      const libFile = path.join(contentDir, 'common', 'libs', 'rules-common', 'rules.ts');
      await fs.mkdir(path.dirname(libFile), { recursive: true });
      await fs.writeFile(libFile, 'export const rule = 1;\n', 'utf8');
      await fs.mkdir(path.join(homeDir, '.config', 'agent-rigger'), { recursive: true });
      const env: Env = { RIGGER_HOME: homeDir };
      const tmpFactory: TmpDirFactory = async () => ({ path: contentDir, cleanup: async () => {} });

      const lines: string[] = [];
      const code = await runCli(
        ['install', 'https://github.com/owner/libonly-catalog.git', '--yes'],
        {
          print: (m) => lines.push(m),
          env,
          remote: { run: makeRunner(), tmpFactory, scanner: stubScanner },
        },
      );

      expect(code).toBe(0);
      const output = lines.join('\n');
      expect(output).toContain('contains only libraries');
      expect(output).not.toContain('Remote catalog is empty');

      // Nothing installed: a lib alone was never a selectable/installable target.
      const manifest = await readManifest(resolveUserTargets(env).stateJson);
      expect(manifest.artifacts).toEqual([]);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      await fs.rm(contentDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario: picker sans libs — feed 4 (propose-install: init TTY / catalog add)
// ---------------------------------------------------------------------------

describe('R8 scenario "picker sans libs" — feed 4: post-init proposal picker', () => {
  it('never offers the lib for direct selection', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t7-init-home-'));
    const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t7-init-content-'));
    try {
      await fs.writeFile(
        path.join(contentDir, 'catalog.json'),
        JSON.stringify({ meta: { name: 'principal' }, entries: CATALOG_ENTRIES }),
        'utf8',
      );
      for (const [rel, content] of Object.entries(CHECKOUT_FILES)) {
        const dest = path.join(contentDir, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, content, 'utf8');
      }
      const env: Env = { RIGGER_HOME: homeDir };
      const tmpFactory: TmpDirFactory = async () => ({ path: contentDir, cleanup: async () => {} });

      const captured: { value: CatalogEntry[] | null } = { value: null };
      setStdoutIsTTY(true); // real-TTY branch (runInteractiveProposeInstall) — reset by the file-level pin's afterEach
      const code = await runCli(['init'], {
        env,
        print: () => {},
        remote: { run: makeRunner(), tmpFactory, scanner: stubScanner },
        prompts: basePrompts({
          askUrl: async () => CATALOG_URL,
          askAssistants: async () => ['claude'],
          selectArtifactsWithDefaults: async (entries) => {
            captured.value = entries;
            return [];
          },
        }),
      });

      expect(code).toBe(0);
      expect(captured.value).not.toBeNull();
      expect(captured.value?.some((e) => e.id.includes('lib:rules-common'))).toBe(false);
      expect(captured.value?.some((e) => e.id.includes('skill:consumer'))).toBe(true);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      await fs.rm(contentDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario D1 — selecting the consumer resolves + materialises the lib too
// ---------------------------------------------------------------------------

describe('R8/D1 — selecting a consumer in the picker still pulls its lib (post-selection)', () => {
  it('the lib is never offered but IS materialised once its consumer is selected', async () => {
    const h = await makeHarness();
    try {
      const code = await runCli(['install'], {
        print: () => {},
        env: h.env,
        prompts: basePrompts({
          selectArtifactsByStatus: async (entries) => {
            const consumer = entries.find((e) => e.id === 'principal/skill:consumer');
            return consumer === undefined ? [] : [consumer.id];
          },
        }),
        remote: { run: h.runner, tmpFactory: h.tmpFactory, scanner: stubScanner },
      });

      expect(code).toBe(0);

      const manifest = await readManifest(h.stateJson);
      expect(manifest.artifacts.some((a) => a.id === 'principal/skill:consumer')).toBe(true);
      const libEntry = manifest.artifacts.find((a) => a.id === 'principal/lib:rules-common');
      expect(libEntry).toBeDefined();
      expect(libEntry?.assistant).toBe('shared');
    } finally {
      await h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Non-regression (S7/T3) — explicit `install <catalog>/lib:x` still refused,
// full CLI path (unit-level coverage already in lib-nature-t3-materialize.test.ts).
// ---------------------------------------------------------------------------

describe('R8 non-regression — explicit lib install stays refused end-to-end', () => {
  it('exit 2, actionable message, nothing materialised on disk', async () => {
    const h = await makeHarness();
    try {
      const lines: string[] = [];
      const code = await runCli(['install', 'principal/lib:rules-common', '--yes'], {
        print: (m) => lines.push(m),
        env: h.env,
        remote: { run: h.runner, tmpFactory: h.tmpFactory, scanner: stubScanner },
      });

      expect(code).toBe(2);
      expect(lines.join('\n')).toContain('installed through the artifacts that require it');
      expect(await dirExists(libsDir(h.env))).toBe(false);
    } finally {
      await h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// R8 — "libs check" is rejected (a lib has no per-assistant state)
// ---------------------------------------------------------------------------

describe('R8 — "libs check" is not supported', () => {
  it('exit 2 with an actionable message, before any catalog/env access', async () => {
    const lines: string[] = [];
    const code = await runCli(['libs', 'check'], {
      print: (m) => lines.push(m),
      env: { RIGGER_HOME: '/nonexistent-t7-guard-should-never-be-touched' },
    });
    expect(code).toBe(2);
    expect(lines.join('\n')).toContain('libs check');
  });
});

// ---------------------------------------------------------------------------
// R8 (T3 differed) — update lib:<name> direct: dedicated skip message
// ---------------------------------------------------------------------------

describe('R8 (T3 differed) — `update lib:x` direct: dedicated skip message', () => {
  it('names the real reason instead of "not installed"; the T3 pin (updated=[], skipped) stays green', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t7-update-msg-'));
    try {
      const env: Env = { RIGGER_HOME: tmpHome };
      const stateJson = resolveUserTargets(env).stateJson;
      await fs.mkdir(path.dirname(stateJson), { recursive: true });
      await writeManifest(stateJson, {
        version: 1,
        artifacts: [
          {
            id: 'principal/lib:rules-common',
            nature: 'lib',
            ref: TAG,
            sha: SHA,
            scope: 'user',
            installedAt: new Date().toISOString(),
            files: [],
            assistant: 'shared',
          },
        ],
      });

      const result = await runUpdate({
        ids: ['principal/lib:rules-common'],
        scope: 'user',
        env,
        manifestPath: stateJson,
        catalogUrl: CATALOG_URL,
        runner: makeRunner(),
        tmpFactory: async () => ({ path: '/should-not-be-used', cleanup: async () => {} }),
        confirm: true,
        scanner: stubScanner,
      });

      // The pin (T3, unchanged): a lib named directly on update is skipped, never updated.
      expect(result.updated).toEqual([]);
      expect(result.skipped).toContain('principal/lib:rules-common');
      // What changes (T7): the reason is dedicated, not the incidental "not installed".
      expect(result.output).toContain('a lib is updated through the artifacts that require it');
      expect(result.output).not.toContain('not installed');
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// R8.4 — exhaustiveness: no silent nature gap in manual per-nature structures
// ---------------------------------------------------------------------------

describe('R8.4 — exhaustiveness: RESOURCE_NATURE_MAP / PREFIX_TO_NATURE / ADAPTER_CHECK_NATURES', () => {
  // Declared exclusions (T7 choice: freeze pre-existing gaps rather than fix
  // them — this change adds lib coverage, it does not audit-and-fix the rest
  // of the CLI's hook/mcp surface). Each set below must name EVERY nature
  // that structure doesn't cover; a future 10th nature covered by neither the
  // structure NOR this set fails the corresponding assertion.
  const RESOURCE_NATURE_MAP_EXCLUSIONS = new Set<string>(['mcp']);
  const PREFIX_TO_NATURE_EXCLUSIONS = new Set<string>(['hook', 'mcp']);
  const ADAPTER_CHECK_NATURES_EXCLUSIONS = new Set<string>(['hook', 'lib']);

  it('RESOURCE_NATURE_MAP covers every nature except the declared exclusion ("mcp")', () => {
    const covered = new Set(Object.values(RESOURCE_NATURE_MAP));
    for (const nature of NATURES) {
      if (RESOURCE_NATURE_MAP_EXCLUSIONS.has(nature)) {
        expect(covered.has(nature)).toBe(false);
        continue;
      }
      expect(covered.has(nature)).toBe(true);
    }
  });

  it('PREFIX_TO_NATURE covers every nature except the declared exclusions ("hook", "mcp")', () => {
    const covered = new Set(Object.values(PREFIX_TO_NATURE));
    for (const nature of NATURES) {
      if (PREFIX_TO_NATURE_EXCLUSIONS.has(nature)) {
        expect(covered.has(nature)).toBe(false);
        continue;
      }
      expect(covered.has(nature)).toBe(true);
    }
  });

  it('ADAPTER_CHECK_NATURES covers every nature except the declared exclusions ("hook", "lib")', () => {
    const covered = new Set<string>(ADAPTER_CHECK_NATURES);
    for (const nature of NATURES) {
      if (ADAPTER_CHECK_NATURES_EXCLUSIONS.has(nature)) {
        expect(covered.has(nature)).toBe(false);
        continue;
      }
      expect(covered.has(nature)).toBe(true);
    }
  });
});
