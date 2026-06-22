/**
 * e2e-remote-install.test.ts — End-to-end tests for the remote install flow (M1b-4).
 *
 * Strategy:
 * - HOME isolated via a tmp dir (RIGGER_HOME env override — never touches real ~/.claude).
 * - deps.remote injected: runner dispatches by args, tmpFactory creates a real dir
 *   pre-populated with catalog.json + skills/remote-demo/SKILL.md.
 * - No real git network calls — runner is a deterministic fake.
 * - Config written to the tmp RIGGER_HOME so loadCliConfig picks it up.
 *
 * Scenarios:
 * 1. install skill:remote-demo --yes with catalogUrl configured
 *    → store populated, symlink created, manifest entry source:'external' with real ref/sha.
 * 2. install <builtin-id> --yes with catalogUrl configured
 *    → resolves via effective catalog, installs from local artifacts, manifest source:'internal'.
 * 3. install <builtin-id> --yes WITHOUT catalogUrl
 *    → local flow, runner never called.
 * 4. Cleanup: tmp checkout dir removed after install.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { runCli } from '../src/cli';

// ---------------------------------------------------------------------------
// Repo root + artifacts dir
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const ARTIFACTS_DIR = path.join(REPO_ROOT, 'artifacts');

// ---------------------------------------------------------------------------
// Fixed test fixtures
// ---------------------------------------------------------------------------

const TAG_NAME = 'v1.0.0';
const SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

/** Minimal external skill entry for the remote catalog fixture. */
const REMOTE_SKILL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:remote-demo',
  nature: 'skill',
  source: 'external',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

// ---------------------------------------------------------------------------
// makeRemoteEnv — isolated HOME + content dir with catalog + skill fixture
// ---------------------------------------------------------------------------

/**
 * Creates:
 *  - A tmp dir as RIGGER_HOME (config.json inside with catalogUrl).
 *  - A separate tmp dir as "content repo checkout" with:
 *    - catalog.json containing the remote skill entry.
 *    - skills/remote-demo/SKILL.md with fixture content.
 *
 * Returns:
 *  - env        : Env with RIGGER_HOME pointing to the tmp home.
 *  - contentDir : path to the pre-populated checkout dir.
 *  - runner     : fake CommandRunner dispatching by args.
 *  - tmpFactory : returns contentDir + tracks if cleanup was called.
 *  - cleanupAll : remove both tmp dirs.
 *  - cleanupCalled: getter for whether tmpFactory cleanup was invoked.
 */
async function makeRemoteEnv(opts: { withCatalogUrl: boolean }): Promise<{
  env: Env;
  homeDir: string;
  contentDir: string;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  cleanupAll: () => Promise<void>;
  getCleanupCalled: () => boolean;
}> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-remote-e2e-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-remote-e2e-content-'));

  // Write catalog.json
  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify([REMOTE_SKILL_ENTRY]),
    'utf8',
  );

  // Write skills/remote-demo/SKILL.md
  await fs.mkdir(path.join(contentDir, 'skills', 'remote-demo'), { recursive: true });
  await fs.writeFile(
    path.join(contentDir, 'skills', 'remote-demo', 'SKILL.md'),
    '# Remote Demo Skill\n\nThis is a remote skill fixture.',
    'utf8',
  );

  // Write config.json to RIGGER_HOME
  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });
  if (opts.withCatalogUrl) {
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({ catalogUrl: 'https://example.com/catalog.git' }),
      'utf8',
    );
  }

  const env: Env = { RIGGER_HOME: homeDir };

  // Fake runner: dispatches by args
  const runner: CommandRunner = (_cmd, args) => {
    const argv = args ?? [];

    // git ls-remote --tags -- <url>  → one tag
    if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${SHA}\trefs/tags/${TAG_NAME}\n`,
        stderr: '',
      });
    }

    // git ls-remote -- <url> HEAD  → sha
    if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${SHA}\tHEAD\n`,
        stderr: '',
      });
    }

    // git clone ... → no-op (content already in contentDir)
    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }

    // git -C <dir> rev-parse HEAD → fixed sha
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\n`, stderr: '' });
    }

    // which <tool>: advisory tool check — report absent
    if (_cmd === 'sh' || argv.length === 0) {
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' });
    }

    // Default: success (e.g. tool advisory checks)
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };

  let cleanupCalled = false;

  const tmpFactory: TmpDirFactory = async () => ({
    path: contentDir,
    cleanup: async () => {
      cleanupCalled = true;
    },
  });

  const cleanupAll = async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(contentDir, { recursive: true, force: true });
  };

  return {
    env,
    homeDir,
    contentDir,
    runner,
    tmpFactory,
    cleanupAll,
    getCleanupCalled: () => cleanupCalled,
  };
}

function makeCapture(): { lines: string[]; print: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

// ---------------------------------------------------------------------------
// Shared lifecycle
// ---------------------------------------------------------------------------

let remoteEnv: Awaited<ReturnType<typeof makeRemoteEnv>>;
let targets: ReturnType<typeof resolveUserTargets>;

beforeEach(async () => {
  remoteEnv = await makeRemoteEnv({ withCatalogUrl: true });
  targets = resolveUserTargets(remoteEnv.env);
});

afterEach(async () => {
  await remoteEnv.cleanupAll();
});

// ---------------------------------------------------------------------------
// Scenario 1: install skill:remote-demo --yes with catalogUrl
// ---------------------------------------------------------------------------

describe('remote install — skill:remote-demo --yes with catalogUrl', () => {
  it('exits 0', async () => {
    const cap = makeCapture();
    const code = await runCli(['install', 'skill:remote-demo', '--yes'], {
      print: cap.print,
      env: remoteEnv.env,
      artifactsDir: ARTIFACTS_DIR,
      remote: { run: remoteEnv.runner, tmpFactory: remoteEnv.tmpFactory },
    });
    expect(code).toBe(0);
  });

  it('creates skill store directory', async () => {
    await runCli(['install', 'skill:remote-demo', '--yes'], {
      print: makeCapture().print,
      env: remoteEnv.env,
      artifactsDir: ARTIFACTS_DIR,
      remote: { run: remoteEnv.runner, tmpFactory: remoteEnv.tmpFactory },
    });

    // store: <RIGGER_HOME>/.config/agent-rigger/skills/remote-demo
    const skillStorePath = path.join(targets.skillsDir, 'remote-demo');
    const stat = await fs.stat(skillStorePath).catch(() => null);
    expect(stat).not.toBeNull();
  });

  it('copies SKILL.md to store', async () => {
    await runCli(['install', 'skill:remote-demo', '--yes'], {
      print: makeCapture().print,
      env: remoteEnv.env,
      artifactsDir: ARTIFACTS_DIR,
      remote: { run: remoteEnv.runner, tmpFactory: remoteEnv.tmpFactory },
    });

    const skillMdPath = path.join(targets.skillsDir, 'remote-demo', 'SKILL.md');
    const content = await fs.readFile(skillMdPath, 'utf8').catch(() => null);
    expect(content).toContain('Remote Demo Skill');
  });

  it('creates symlink in ~/.claude/skills', async () => {
    await runCli(['install', 'skill:remote-demo', '--yes'], {
      print: makeCapture().print,
      env: remoteEnv.env,
      artifactsDir: ARTIFACTS_DIR,
      remote: { run: remoteEnv.runner, tmpFactory: remoteEnv.tmpFactory },
    });

    // symlink: <RIGGER_HOME>/.claude/skills/remote-demo
    const claudeDir = path.dirname(targets.claudeSettings);
    const symlinkPath = path.join(claudeDir, 'skills', 'remote-demo');
    const stat = await fs.lstat(symlinkPath).catch(() => null);
    expect(stat).not.toBeNull();
  });

  it('manifest entry has source:external', async () => {
    await runCli(['install', 'skill:remote-demo', '--yes'], {
      print: makeCapture().print,
      env: remoteEnv.env,
      artifactsDir: ARTIFACTS_DIR,
      remote: { run: remoteEnv.runner, tmpFactory: remoteEnv.tmpFactory },
    });

    const raw = await fs.readFile(targets.stateJson, 'utf8');
    const manifest = JSON.parse(raw) as {
      artifacts: Array<{ id: string; source?: string; ref?: string; sha?: string }>;
    };
    const entry = manifest.artifacts.find((a) => a.id === 'skill:remote-demo');
    expect(entry).toBeDefined();
    expect(entry?.source).toBe('external');
  });

  it('manifest entry has real ref (tag name)', async () => {
    await runCli(['install', 'skill:remote-demo', '--yes'], {
      print: makeCapture().print,
      env: remoteEnv.env,
      artifactsDir: ARTIFACTS_DIR,
      remote: { run: remoteEnv.runner, tmpFactory: remoteEnv.tmpFactory },
    });

    const raw = await fs.readFile(targets.stateJson, 'utf8');
    const manifest = JSON.parse(raw) as {
      artifacts: Array<{ id: string; ref?: string }>;
    };
    const entry = manifest.artifacts.find((a) => a.id === 'skill:remote-demo');
    expect(entry?.ref).toBe(TAG_NAME);
  });

  it('manifest entry has real sha', async () => {
    await runCli(['install', 'skill:remote-demo', '--yes'], {
      print: makeCapture().print,
      env: remoteEnv.env,
      artifactsDir: ARTIFACTS_DIR,
      remote: { run: remoteEnv.runner, tmpFactory: remoteEnv.tmpFactory },
    });

    const raw = await fs.readFile(targets.stateJson, 'utf8');
    const manifest = JSON.parse(raw) as {
      artifacts: Array<{ id: string; sha?: string }>;
    };
    const entry = manifest.artifacts.find((a) => a.id === 'skill:remote-demo');
    expect(entry?.sha).toBe(SHA);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: install builtin --yes with catalogUrl → source:'internal'
// ---------------------------------------------------------------------------

describe('remote install — builtin id with catalogUrl → source:internal', () => {
  it('exits 0 for guardrails-claude', async () => {
    const cap = makeCapture();
    const code = await runCli(['install', 'guardrails-claude', '--yes'], {
      print: cap.print,
      env: remoteEnv.env,
      artifactsDir: ARTIFACTS_DIR,
      remote: { run: remoteEnv.runner, tmpFactory: remoteEnv.tmpFactory },
    });
    expect(code).toBe(0);
  });

  it('manifest entry for guardrails-claude has source:internal', async () => {
    await runCli(['install', 'guardrails-claude', '--yes'], {
      print: makeCapture().print,
      env: remoteEnv.env,
      artifactsDir: ARTIFACTS_DIR,
      remote: { run: remoteEnv.runner, tmpFactory: remoteEnv.tmpFactory },
    });

    const raw = await fs.readFile(targets.stateJson, 'utf8');
    const manifest = JSON.parse(raw) as {
      artifacts: Array<{ id: string; source?: string }>;
    };
    const entry = manifest.artifacts.find((a) => a.id === 'guardrails-claude');
    expect(entry).toBeDefined();
    expect(entry?.source).toBe('internal');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: install builtin --yes WITHOUT catalogUrl → local flow, runner unused
// ---------------------------------------------------------------------------

describe('remote install — builtin id WITHOUT catalogUrl → local flow', () => {
  it('exits 0 without calling remote runner', async () => {
    // Create a separate env without catalogUrl
    const localEnv = await makeRemoteEnv({ withCatalogUrl: false });

    let runnerCallCount = 0;
    const countingRunner: CommandRunner = (cmd, args) => {
      runnerCallCount++;
      return localEnv.runner(cmd, args);
    };

    try {
      const cap = makeCapture();
      const code = await runCli(['install', 'guardrails-claude', '--yes'], {
        print: cap.print,
        env: localEnv.env,
        artifactsDir: ARTIFACTS_DIR,
        remote: { run: countingRunner, tmpFactory: localEnv.tmpFactory },
      });
      expect(code).toBe(0);
      expect(runnerCallCount).toBe(0);
    } finally {
      await localEnv.cleanupAll();
    }
  });

  it('manifest entry has source:internal when no catalogUrl', async () => {
    const localEnv = await makeRemoteEnv({ withCatalogUrl: false });
    const localTargets = resolveUserTargets(localEnv.env);

    try {
      await runCli(['install', 'guardrails-claude', '--yes'], {
        print: makeCapture().print,
        env: localEnv.env,
        artifactsDir: ARTIFACTS_DIR,
        remote: { run: localEnv.runner, tmpFactory: localEnv.tmpFactory },
      });

      const raw = await fs.readFile(localTargets.stateJson, 'utf8');
      const manifest = JSON.parse(raw) as {
        artifacts: Array<{ id: string; source?: string }>;
      };
      const entry = manifest.artifacts.find((a) => a.id === 'guardrails-claude');
      expect(entry?.source).toBe('internal');
    } finally {
      await localEnv.cleanupAll();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: cleanup — tmp checkout dir removed after install
// ---------------------------------------------------------------------------

describe('remote install — cleanup: tmp checkout removed after install', () => {
  it('tmpFactory cleanup is called after successful remote install', async () => {
    await runCli(['install', 'skill:remote-demo', '--yes'], {
      print: makeCapture().print,
      env: remoteEnv.env,
      artifactsDir: ARTIFACTS_DIR,
      remote: { run: remoteEnv.runner, tmpFactory: remoteEnv.tmpFactory },
    });

    expect(remoteEnv.getCleanupCalled()).toBe(true);
  });
});
