/**
 * lot5-r6-scope.test.ts — R6: --scope honored by the interactive install flow.
 *
 * WHEN `--scope` is passed to interactive `install`, the CLI must use that
 * scope without showing the scope-selection prompt; statuses/picker are
 * computed on the requested scope. Without the flag, the prompt is unchanged.
 *
 * Strategy: RIGGER_HOME isolated, remote catalog mocked (no real git), and
 * `confirmApply` used both as the confirmation hook AND as a probe — it
 * captures the rendered plan text (which embeds `scope: <user|project> (...)`,
 * see ui.ts renderPlan) then returns false so nothing is actually written to
 * disk (no real filesystem mutation for project scope, no reliance on
 * process.cwd()).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import type { Env } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';

import { runCli } from '../src/cli';
import type { CliPrompts } from '../src/cli';

const SHA_V1_0_0 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TAG_V1_0_0 = 'v1.0.0';

const EXTERNAL_SKILL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:remote-demo',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

interface IsolatedEnv {
  env: Env;
  homeDir: string;
  contentDir: string;
  makeRunner: () => CommandRunner;
  makeTmpFactory: () => TmpDirFactory;
  cleanupAll: () => Promise<void>;
}

async function makeIsolatedEnv(): Promise<IsolatedEnv> {
  const catalog = [EXTERNAL_SKILL_ENTRY];
  const skillIds = ['remote-demo'];

  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-r6-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-r6-content-'));

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 'r6-test-catalog' }, entries: catalog }),
    'utf8',
  );

  for (const skillId of skillIds) {
    await fs.mkdir(path.join(contentDir, 'common', 'skills', skillId), { recursive: true });
    await fs.writeFile(
      path.join(contentDir, 'common', 'skills', skillId, 'SKILL.md'),
      `# Skill ${skillId}\n${TAG_V1_0_0} content.`,
      'utf8',
    );
  }

  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }] }),
    'utf8',
  );

  const env: Env = { RIGGER_HOME: homeDir };
  const tmpDirs: string[] = [];

  const makeRunner = (): CommandRunner => (_cmd, args) => {
    const argv = args ?? [];
    if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${SHA_V1_0_0}\trefs/tags/${TAG_V1_0_0}\n`,
        stderr: '',
      });
    }
    if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA_V1_0_0}\tHEAD\n`, stderr: '' });
    }
    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA_V1_0_0}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };

  const makeTmpFactory = (): TmpDirFactory => async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-r6-checkout-'));
    tmpDirs.push(tmpDir);
    await fs.writeFile(
      path.join(tmpDir, 'catalog.json'),
      JSON.stringify({ meta: { name: 'r6-test-catalog' }, entries: catalog }),
      'utf8',
    );
    for (const skillId of skillIds) {
      await fs.mkdir(path.join(tmpDir, 'common', 'skills', skillId), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, 'common', 'skills', skillId, 'SKILL.md'),
        `# Skill ${skillId}\n${TAG_V1_0_0} content.`,
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

  const cleanupAll = async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(contentDir, { recursive: true, force: true });
    for (const d of tmpDirs) {
      await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    }
  };

  return { env, homeDir, contentDir, makeRunner, makeTmpFactory, cleanupAll };
}

let iso: IsolatedEnv;

beforeEach(async () => {
  iso = await makeIsolatedEnv();
});

afterEach(async () => {
  await iso.cleanupAll();
});

describe('lot5-R6: --scope honored by interactive install', () => {
  it('with --scope=project, selectScope is never called and the plan is built for project scope', async () => {
    let selectScopeCalled = false;
    let capturedPlanText = '';

    const prompts: CliPrompts = {
      selectArtifacts: async () => ['principal/skill:remote-demo'],
      selectScope: async () => {
        selectScopeCalled = true;
        throw new Error('selectScope must not be called when --scope is provided (R6)');
      },
      confirmApply: async (planText) => {
        capturedPlanText = planText;
        return false; // abort before any real write — pure probe.
      },
      askUrl: async () => '',
      askMethod: async () => 'https',
    };

    const code = await runCli(['install', '--scope=project'], {
      print: () => {},
      env: iso.env,
      prompts,
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    expect(selectScopeCalled).toBe(false);
    expect(code).toBe(0);
    expect(capturedPlanText).toContain('scope: project');
  });

  it('without --scope, the prompt is shown and its answer drives the plan scope', async () => {
    let selectScopeCalled = false;
    let capturedPlanText = '';

    const prompts: CliPrompts = {
      selectArtifacts: async () => ['principal/skill:remote-demo'],
      selectScope: async () => {
        selectScopeCalled = true;
        return 'project';
      },
      confirmApply: async (planText) => {
        capturedPlanText = planText;
        return false;
      },
      askUrl: async () => '',
      askMethod: async () => 'https',
    };

    const code = await runCli(['install'], {
      print: () => {},
      env: iso.env,
      prompts,
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    expect(selectScopeCalled).toBe(true);
    expect(code).toBe(0);
    expect(capturedPlanText).toContain('scope: project');
  });

  it('with --scope=user, selectScope is never called and the plan is built for user scope', async () => {
    let selectScopeCalled = false;
    let capturedPlanText = '';

    const prompts: CliPrompts = {
      selectArtifacts: async () => ['principal/skill:remote-demo'],
      selectScope: async () => {
        selectScopeCalled = true;
        throw new Error('selectScope must not be called when --scope is provided (R6)');
      },
      confirmApply: async (planText) => {
        capturedPlanText = planText;
        return false;
      },
      askUrl: async () => '',
      askMethod: async () => 'https',
    };

    const code = await runCli(['install', '--scope=user'], {
      print: () => {},
      env: iso.env,
      prompts,
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    expect(selectScopeCalled).toBe(false);
    expect(code).toBe(0);
    expect(capturedPlanText).toContain('scope: user');
  });
});
