/**
 * status-aware-picker.test.ts — Tests for the status-aware interactive install picker.
 *
 * When `prompts.selectArtifactsByStatus` is injected, the interactive `install`
 * flow asks for scope first, classifies each effective entry against the manifest
 * + remote version (install / update / current), short-circuits when nothing is
 * actionable, and renders the grouped picker.
 *
 * Strategy:
 * - RIGGER_HOME isolated; config + (optionally) a pre-seeded manifest.
 * - prompts injected (selectArtifactsByStatus captures its argument).
 * - deps.remote runner mocked: ls-remote --tags → a fixed tag.
 * - The picker returns [] so the test focuses on classification, not install.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';

import { runCli } from '../src/cli';
import type { CliPrompts } from '../src/cli';
import type { StatusedEntry } from '../src/ui';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REMOTE_TAG = 'v1.0.0';

const ENTRY_A: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:remote-demo',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user', 'project'],
};
const ENTRY_B: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:remote-b',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

const CATALOG = [ENTRY_A, ENTRY_B];
const SKILL_IDS = ['remote-demo', 'remote-b'];

// ---------------------------------------------------------------------------
// Isolated env
// ---------------------------------------------------------------------------

interface Iso {
  env: Env;
  targets: ReturnType<typeof resolveUserTargets>;
  makeRunner: () => CommandRunner;
  makeTmpFactory: () => TmpDirFactory;
  seedManifest: (artifacts: Array<{ id: string; ref: string; scope?: string }>) => Promise<void>;
  cleanup: () => Promise<void>;
}

async function makeIso(): Promise<Iso> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-status-home-'));
  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }] }),
    'utf8',
  );

  const env: Env = { RIGGER_HOME: homeDir };
  const targets = resolveUserTargets(env);
  const tmpDirs: string[] = [];

  const makeRunner = (): CommandRunner => (_cmd, args) => {
    const argv = args ?? [];
    if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${SHA}\trefs/tags/${REMOTE_TAG}\n`,
        stderr: '',
      });
    }
    if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\tHEAD\n`, stderr: '' });
    }
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };

  const makeTmpFactory = (): TmpDirFactory => async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-status-checkout-'));
    tmpDirs.push(tmpDir);
    await fs.writeFile(
      path.join(tmpDir, 'catalog.json'),
      JSON.stringify({ meta: { name: 'status-test-catalog' }, entries: CATALOG }),
      'utf8',
    );
    for (const skillId of SKILL_IDS) {
      await fs.mkdir(path.join(tmpDir, 'skills', skillId), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, 'skills', skillId, 'SKILL.md'),
        `# Skill ${skillId}\n${REMOTE_TAG} content.`,
        'utf8',
      );
    }
    return {
      path: tmpDir,
      cleanup: async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
      },
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
          sha: SHA,
          scope: a.scope ?? 'user',
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

let iso: Iso;
beforeEach(async () => {
  iso = await makeIso();
});
afterEach(async () => {
  await iso.cleanup();
});

// Build prompts with a capturing status picker. order[] records prompt sequence.
function makePrompts(
  order: string[],
  captured: { value: StatusedEntry[] | null; called: boolean },
): CliPrompts {
  return {
    selectArtifacts: async () => {
      order.push('selectArtifacts');
      return [];
    },
    selectArtifactsByStatus: async (entries) => {
      order.push('selectArtifactsByStatus');
      captured.value = entries;
      captured.called = true;
      return [];
    },
    selectScope: async () => {
      order.push('selectScope');
      return 'user';
    },
    confirmApply: async () => true,
    askUrl: async () => '',
    askMethod: async () => 'https',
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe('status-aware picker — classification', () => {
  it('flags not-installed as install and installed-at-latest as current', async () => {
    await iso.seedManifest([{ id: 'principal/skill:remote-demo', ref: REMOTE_TAG }]);
    const order: string[] = [];
    const captured = { value: null as StatusedEntry[] | null, called: false };

    await runCli(['install'], {
      print: () => {},
      env: iso.env,
      prompts: makePrompts(order, captured),
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    expect(captured.called).toBe(true);
    const byId = new Map(captured.value!.map((s) => [s.id, s]));
    expect(byId.get('principal/skill:remote-demo')?.status).toBe('current');
    expect(byId.get('principal/skill:remote-b')?.status).toBe('install');
  });

  it('flags installed-at-older-ref as update with installed/remote refs', async () => {
    await iso.seedManifest([{ id: 'principal/skill:remote-demo', ref: 'v0.9.0' }]);
    const order: string[] = [];
    const captured = { value: null as StatusedEntry[] | null, called: false };

    await runCli(['install'], {
      print: () => {},
      env: iso.env,
      prompts: makePrompts(order, captured),
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    const demo = captured.value!.find((s) => s.id === 'principal/skill:remote-demo');
    expect(demo?.status).toBe('update');
    expect(demo?.installedRef).toBe('v0.9.0');
    expect(demo?.remoteRef).toBe(REMOTE_TAG);
  });

  it('asks scope before the status picker', async () => {
    await iso.seedManifest([{ id: 'principal/skill:remote-demo', ref: 'v0.9.0' }]);
    const order: string[] = [];
    const captured = { value: null as StatusedEntry[] | null, called: false };

    await runCli(['install'], {
      print: () => {},
      env: iso.env,
      prompts: makePrompts(order, captured),
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    expect(order.indexOf('selectScope')).toBeLessThan(order.indexOf('selectArtifactsByStatus'));
  });
});

// ---------------------------------------------------------------------------
// Short-circuit
// ---------------------------------------------------------------------------

describe('status-aware picker — all current short-circuit', () => {
  it('skips the picker and reports up-to-date when everything is current', async () => {
    await iso.seedManifest([
      { id: 'principal/skill:remote-demo', ref: REMOTE_TAG },
      { id: 'principal/skill:remote-b', ref: REMOTE_TAG },
    ]);
    const order: string[] = [];
    const captured = { value: null as StatusedEntry[] | null, called: false };
    const lines: string[] = [];

    const code = await runCli(['install'], {
      print: (m) => lines.push(m),
      env: iso.env,
      prompts: makePrompts(order, captured),
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    expect(code).toBe(0);
    expect(captured.called).toBe(false);
    expect(lines.join('\n')).toMatch(/up-to-date/i);
  });
});
