/**
 * interactive-remote-picker.test.ts — Tests for the interactive install remote picker.
 *
 * When no ids are passed to `install`, the multiselect should show the effective
 * catalog (built-in ∪ remote) and install via runRemoteInstall when catalogUrl
 * is configured.
 *
 * Strategy:
 * - RIGGER_HOME isolated.
 * - prompts injected (selectArtifacts captures its argument, returns chosen ids).
 * - deps.remote mocked (runner + tmpFactory, version-aware, no real git).
 * - No real network calls.
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

// ---------------------------------------------------------------------------
// Repo root
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fixed fixtures
// ---------------------------------------------------------------------------

const SHA_V1_0_0 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TAG_V1_0_0 = 'v1.0.0';

const EXTERNAL_SKILL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:remote-demo',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

// ---------------------------------------------------------------------------
// makeIsolatedEnv
// ---------------------------------------------------------------------------

interface IsolatedEnv {
  env: Env;
  homeDir: string;
  contentDir: string;
  makeRunner: () => CommandRunner;
  makeTmpFactory: () => TmpDirFactory;
  cleanupAll: () => Promise<void>;
}

async function makeIsolatedEnv(opts: {
  withCatalogUrl?: boolean;
  catalog?: CatalogEntry[];
  skillIds?: string[];
}): Promise<IsolatedEnv> {
  const {
    withCatalogUrl = true,
    catalog = [EXTERNAL_SKILL_ENTRY],
    skillIds = ['remote-demo'],
  } = opts;

  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-picker-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-picker-content-'));

  // Write catalog.json for the remote content repo.
  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 'picker-test-catalog' }, entries: catalog }),
    'utf8',
  );

  // Write skill fixtures.
  for (const skillId of skillIds) {
    await fs.mkdir(path.join(contentDir, 'skills', skillId), { recursive: true });
    await fs.writeFile(
      path.join(contentDir, 'skills', skillId, 'SKILL.md'),
      `# Skill ${skillId}\n${TAG_V1_0_0} content.`,
      'utf8',
    );
  }

  // Write config.
  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });
  if (withCatalogUrl) {
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({ catalogUrl: 'https://example.com/catalog.git' }),
      'utf8',
    );
  }

  const env: Env = { RIGGER_HOME: homeDir };

  const tmpDirs: string[] = [];

  // Runner: ls-remote → v1.0.0, clone → no-op, rev-parse → sha.
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

  // TmpFactory: returns contentDir (pre-populated, no real clone needed).
  const makeTmpFactory = (): TmpDirFactory => async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-picker-checkout-'));
    tmpDirs.push(tmpDir);
    // Copy catalog + skills into fresh tmpDir so each checkout is independent.
    await fs.writeFile(
      path.join(tmpDir, 'catalog.json'),
      JSON.stringify({ meta: { name: 'picker-test-catalog' }, entries: catalog }),
      'utf8',
    );
    for (const skillId of skillIds) {
      await fs.mkdir(path.join(tmpDir, 'skills', skillId), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, 'skills', skillId, 'SKILL.md'),
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

// ---------------------------------------------------------------------------
// Shared lifecycle
// ---------------------------------------------------------------------------

let iso: IsolatedEnv;
let targets: ReturnType<typeof resolveUserTargets>;

beforeEach(async () => {
  iso = await makeIsolatedEnv({});
  targets = resolveUserTargets(iso.env);
});

afterEach(async () => {
  await iso.cleanupAll();
});

// ---------------------------------------------------------------------------
// Scenario 1: interactive + catalogUrl → selectArtifacts receives effective catalog
// ---------------------------------------------------------------------------

describe('interactive install — with catalogUrl', () => {
  it('selectArtifacts receives the remote entry in its catalog argument', async () => {
    let capturedEntries: CatalogEntry[] | null = null;

    const prompts: CliPrompts = {
      selectArtifacts: async (entries) => {
        capturedEntries = entries as CatalogEntry[];
        return [];
      },
      selectScope: async () => 'user',
      confirmApply: async () => true,
      askUrl: async () => '',
      askMethod: async () => 'https',
    };

    await runCli(['install'], {
      print: () => {},
      env: iso.env,
      prompts,
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    expect(capturedEntries).not.toBeNull();
    // capturedEntries is non-null at this point (asserted above).
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const ids = capturedEntries!.map((e) => e.id);
    expect(ids).toContain('skill:remote-demo');
  });

  it('returns exit 0 when external skill is installed interactively', async () => {
    const prompts: CliPrompts = {
      selectArtifacts: async () => ['skill:remote-demo'],
      selectScope: async () => 'user',
      confirmApply: async () => true,
      askUrl: async () => '',
      askMethod: async () => 'https',
    };

    const code = await runCli(['install'], {
      print: () => {},
      env: iso.env,
      prompts,
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    expect(code).toBe(0);
  });

  it('manifest entry has real ref/sha after interactive remote install', async () => {
    const prompts: CliPrompts = {
      selectArtifacts: async () => ['skill:remote-demo'],
      selectScope: async () => 'user',
      confirmApply: async () => true,
      askUrl: async () => '',
      askMethod: async () => 'https',
    };

    await runCli(['install'], {
      print: () => {},
      env: iso.env,
      prompts,
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    const raw = await fs.readFile(targets.stateJson, 'utf8');
    const manifest = JSON.parse(raw) as {
      artifacts: Array<{ id: string; ref?: string; sha?: string }>;
    };
    const entry = manifest.artifacts.find((a) => a.id === 'skill:remote-demo');
    expect(entry).toBeDefined();
    expect(entry?.ref).toBe(TAG_V1_0_0);
    expect(entry?.sha).not.toBe('');
  });

  it('store SKILL.md is written after interactive remote install', async () => {
    const prompts: CliPrompts = {
      selectArtifacts: async () => ['skill:remote-demo'],
      selectScope: async () => 'user',
      confirmApply: async () => true,
      askUrl: async () => '',
      askMethod: async () => 'https',
    };

    await runCli(['install'], {
      print: () => {},
      env: iso.env,
      prompts,
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    const skillsDir = resolveUserTargets(iso.env).skillsDir;
    const storeFile = path.join(skillsDir, 'remote-demo', 'SKILL.md');
    const content = await fs.readFile(storeFile, 'utf8');
    expect(content).toMatch(/skill remote-demo|v1\.0\.0/i);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: interactive without catalogUrl → empty catalog + actionable message
// ---------------------------------------------------------------------------

describe('interactive install — without catalogUrl', () => {
  it('selectArtifacts is NOT called when no catalogUrl (empty catalog)', async () => {
    const noUrlIso = await makeIsolatedEnv({ withCatalogUrl: false });
    let selectCalled = false;

    try {
      const prompts: CliPrompts = {
        selectArtifacts: async () => {
          selectCalled = true;
          return [];
        },
        selectScope: async () => 'user',
        confirmApply: async () => true,
        askUrl: async () => '',
        askMethod: async () => 'https',
      };

      await runCli(['install'], {
        print: () => {},
        env: noUrlIso.env,
        prompts,
        remote: {
          run: noUrlIso.makeRunner(),
          tmpFactory: noUrlIso.makeTmpFactory(),
          scanner: stubScanner,
        },
      });

      // Without catalogUrl, catalog is empty → selectArtifacts must NOT be called
      expect(selectCalled).toBe(false);
    } finally {
      await noUrlIso.cleanupAll();
    }
  });

  it('exits 0 with actionable message when no catalogUrl configured', async () => {
    const noUrlIso = await makeIsolatedEnv({ withCatalogUrl: false });
    const lines: string[] = [];

    try {
      const prompts: CliPrompts = {
        selectArtifacts: async () => [],
        selectScope: async () => 'user',
        confirmApply: async () => true,
        askUrl: async () => '',
        askMethod: async () => 'https',
      };

      const code = await runCli(['install'], {
        print: (msg) => lines.push(msg),
        env: noUrlIso.env,
        prompts,
      });

      expect(code).toBe(0);
      const out = lines.join('\n');
      expect(out).toMatch(/aucun catalog|agent-rigger init/);
    } finally {
      await noUrlIso.cleanupAll();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: empty selection → nothing to install, exit 0
// ---------------------------------------------------------------------------

describe('interactive install — empty selection', () => {
  it('returns exit 0 when selectArtifacts returns empty array', async () => {
    const prompts: CliPrompts = {
      selectArtifacts: async () => [],
      selectScope: async () => 'user',
      confirmApply: async () => true,
      askUrl: async () => '',
      askMethod: async () => 'https',
    };

    const code = await runCli(['install'], {
      print: () => {},
      env: iso.env,
      prompts,
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    expect(code).toBe(0);
  });

  it('output mentions nothing to install on empty selection', async () => {
    const lines: string[] = [];

    const prompts: CliPrompts = {
      selectArtifacts: async () => [],
      selectScope: async () => 'user',
      confirmApply: async () => true,
      askUrl: async () => '',
      askMethod: async () => 'https',
    };

    await runCli(['install'], {
      print: (msg) => lines.push(msg),
      env: iso.env,
      prompts,
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    expect(lines.join('\n')).toMatch(/nothing|no artifacts/i);
  });
});
