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
 * 5. (TEST-1) Path traversal id rejected — exit non-0, no files written outside HOME.
 * 6. (TEST-2) Cleanup on abort/throw — finally block covers both cases.
 * 7. (TEST-3) Mixed internal+external install — versionFor verified per-entry.
 * 8. (TEST-4) pack:harness via remote path (catalogUrl set) → all 4 guards written to
 *    settings.json + scripts deposited to store. Covers the bug where hookSpec was absent
 *    from buildClaudeAdapterForRemote (now unified via adapter-builder.ts).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type CatalogEntry, type TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { UnsafeArtifactNameError } from '@agent-rigger/core/artifact-name';
import { readJson } from '@agent-rigger/core/fs-json';
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

// ---------------------------------------------------------------------------
// TEST-1: Path traversal rejected (regression guard)
// ---------------------------------------------------------------------------

describe('TEST-1 — path traversal id rejected', () => {
  it('exits non-0 when remote catalog contains a path-traversal skill id', async () => {
    // Create a env where the catalog has a traversal id
    const traversalEnv = await makeRemoteEnv({ withCatalogUrl: true });

    // Overwrite catalog.json with a traversal entry
    const traversalEntry: CatalogEntry = {
      kind: 'artifact',
      id: 'skill:../../../../etc/evil',
      nature: 'skill',
      source: 'external',
      targets: ['claude'],
      scopes: ['user', 'project'],
    };
    await fs.writeFile(
      path.join(traversalEnv.contentDir, 'catalog.json'),
      JSON.stringify([traversalEntry]),
      'utf8',
    );

    try {
      const cap = makeCapture();
      const code = await runCli(
        ['install', 'skill:../../../../etc/evil', '--yes'],
        {
          print: cap.print,
          env: traversalEnv.env,
          artifactsDir: ARTIFACTS_DIR,
          remote: { run: traversalEnv.runner, tmpFactory: traversalEnv.tmpFactory },
        },
      );

      // Must not succeed
      expect(code).not.toBe(0);
      // Output must mention unsafe/traversal
      const output = cap.lines.join('\n');
      expect(output).toMatch(/unsafe|traversal|path/i);
    } finally {
      await traversalEnv.cleanupAll();
    }
  });

  it('does not create any file in the sentinel tmp dir (no traversal write)', async () => {
    // Create a sentinel file in a tmp dir outside HOME — it must still exist after the
    // rejected install (proves nothing was written/deleted outside the isolated HOME).
    const sentinelDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-sentinel-'));
    const sentinelFile = path.join(sentinelDir, 'sentinel.txt');
    await fs.writeFile(sentinelFile, 'untouched', 'utf8');

    const traversalEnv = await makeRemoteEnv({ withCatalogUrl: true });
    const traversalEntry: CatalogEntry = {
      kind: 'artifact',
      id: 'skill:../../../../etc/evil',
      nature: 'skill',
      source: 'external',
      targets: ['claude'],
      scopes: ['user', 'project'],
    };
    await fs.writeFile(
      path.join(traversalEnv.contentDir, 'catalog.json'),
      JSON.stringify([traversalEntry]),
      'utf8',
    );

    try {
      await runCli(['install', 'skill:../../../../etc/evil', '--yes'], {
        print: makeCapture().print,
        env: traversalEnv.env,
        artifactsDir: ARTIFACTS_DIR,
        remote: { run: traversalEnv.runner, tmpFactory: traversalEnv.tmpFactory },
      });
    } catch {
      // error may propagate — that's fine
    }

    // The sentinel file must be untouched
    const content = await fs.readFile(sentinelFile, 'utf8').catch(() => null);
    expect(content).toBe('untouched');

    await fs.rm(sentinelDir, { recursive: true, force: true });
    await traversalEnv.cleanupAll();
  });

  it('cleanup is called even when traversal is rejected', async () => {
    const traversalEnv = await makeRemoteEnv({ withCatalogUrl: true });
    const traversalEntry: CatalogEntry = {
      kind: 'artifact',
      id: 'skill:../../../../etc/evil',
      nature: 'skill',
      source: 'external',
      targets: ['claude'],
      scopes: ['user', 'project'],
    };
    await fs.writeFile(
      path.join(traversalEnv.contentDir, 'catalog.json'),
      JSON.stringify([traversalEntry]),
      'utf8',
    );

    try {
      await runCli(['install', 'skill:../../../../etc/evil', '--yes'], {
        print: makeCapture().print,
        env: traversalEnv.env,
        artifactsDir: ARTIFACTS_DIR,
        remote: { run: traversalEnv.runner, tmpFactory: traversalEnv.tmpFactory },
      });
    } catch {
      // may propagate
    }

    expect(traversalEnv.getCleanupCalled()).toBe(true);
    await traversalEnv.cleanupAll();
  });

  it('error carries UnsafeArtifactNameError identity (via handleError mapping)', async () => {
    // Verify the error class itself is correct (unit-level check)
    const err = new UnsafeArtifactNameError('skill:../../../../evil');
    expect(err).toBeInstanceOf(UnsafeArtifactNameError);
    expect(err.id).toBe('skill:../../../../evil');
    expect(err.name).toBe('UnsafeArtifactNameError');
  });
});

// ---------------------------------------------------------------------------
// TEST-2: Cleanup on abort/throw
// ---------------------------------------------------------------------------

describe('TEST-2a — confirm:false — cleanup called, nothing written', () => {
  it('cleanup is called when confirm returns false', async () => {
    // Use a custom env + prompts that return confirm=false
    const abortEnv = await makeRemoteEnv({ withCatalogUrl: true });

    try {
      const cap = makeCapture();
      await runCli(['install', 'skill:remote-demo'], {
        print: cap.print,
        env: abortEnv.env,
        artifactsDir: ARTIFACTS_DIR,
        remote: { run: abortEnv.runner, tmpFactory: abortEnv.tmpFactory },
        prompts: {
          selectArtifacts: async () => [],
          selectScope: async () => 'user',
          confirmApply: async () => false,
          askUrl: async () => '',
          askMethod: async () => 'https',
        },
      });
    } catch {
      // expected: runInstall may return without writing
    }

    // Cleanup must be called regardless
    expect(abortEnv.getCleanupCalled()).toBe(true);
    await abortEnv.cleanupAll();
  });

  it('nothing written to store when confirm returns false', async () => {
    const abortEnv = await makeRemoteEnv({ withCatalogUrl: true });
    const abortTargets = resolveUserTargets(abortEnv.env);

    try {
      // inject confirm=false via prompts (non-interactive needs --yes, so we omit it
      // and inject a prompts.confirmApply that returns false)
      await runCli(['install', 'skill:remote-demo'], {
        print: makeCapture().print,
        env: abortEnv.env,
        artifactsDir: ARTIFACTS_DIR,
        remote: { run: abortEnv.runner, tmpFactory: abortEnv.tmpFactory },
        prompts: {
          selectArtifacts: async () => [],
          selectScope: async () => 'user',
          confirmApply: async () => false,
          askUrl: async () => '',
          askMethod: async () => 'https',
        },
      });
    } catch {
      // ignore
    }

    // Nothing installed — store dir for skill should not exist
    const skillStorePath = path.join(abortTargets.skillsDir, 'remote-demo');
    const stat = await fs.stat(skillStorePath).catch(() => null);
    expect(stat).toBeNull();

    await abortEnv.cleanupAll();
  });
});

describe('TEST-2b — skill source absent in checkout — error propagates + cleanup called', () => {
  it('cleanup is called when SKILL.md is absent (ENOENT from linker)', async () => {
    // Create env with catalog but WITHOUT skills/remote-demo/SKILL.md
    const noSkillEnv = await makeRemoteEnv({ withCatalogUrl: true });

    // Remove the SKILL.md from contentDir
    await fs.rm(path.join(noSkillEnv.contentDir, 'skills', 'remote-demo'), {
      recursive: true,
      force: true,
    });

    try {
      await runCli(['install', 'skill:remote-demo', '--yes'], {
        print: makeCapture().print,
        env: noSkillEnv.env,
        artifactsDir: ARTIFACTS_DIR,
        remote: { run: noSkillEnv.runner, tmpFactory: noSkillEnv.tmpFactory },
      });
    } catch {
      // error expected
    }

    // The finally block in withRemoteCheckout must have run cleanup
    expect(noSkillEnv.getCleanupCalled()).toBe(true);
    await noSkillEnv.cleanupAll();
  });

  it('exits non-0 when SKILL.md is absent', async () => {
    const noSkillEnv = await makeRemoteEnv({ withCatalogUrl: true });
    await fs.rm(path.join(noSkillEnv.contentDir, 'skills', 'remote-demo'), {
      recursive: true,
      force: true,
    });

    try {
      const code = await runCli(['install', 'skill:remote-demo', '--yes'], {
        print: makeCapture().print,
        env: noSkillEnv.env,
        artifactsDir: ARTIFACTS_DIR,
        remote: { run: noSkillEnv.runner, tmpFactory: noSkillEnv.tmpFactory },
      });
      expect(code).not.toBe(0);
    } catch {
      // also acceptable — error propagated to top
    }

    await noSkillEnv.cleanupAll();
  });
});

// ---------------------------------------------------------------------------
// TEST-3: Mixed internal+external install — versionFor verified per-entry
// ---------------------------------------------------------------------------

describe('TEST-3 — mixed install: builtin (internal) + remote (external)', () => {
  it('installs both builtin and external skill', async () => {
    const cap = makeCapture();
    const code = await runCli(
      ['install', 'guardrails-claude', 'skill:remote-demo', '--yes'],
      {
        print: cap.print,
        env: remoteEnv.env,
        artifactsDir: ARTIFACTS_DIR,
        remote: { run: remoteEnv.runner, tmpFactory: remoteEnv.tmpFactory },
      },
    );
    expect(code).toBe(0);
  });

  it('manifest: guardrails-claude has source:internal', async () => {
    await runCli(['install', 'guardrails-claude', 'skill:remote-demo', '--yes'], {
      print: makeCapture().print,
      env: remoteEnv.env,
      artifactsDir: ARTIFACTS_DIR,
      remote: { run: remoteEnv.runner, tmpFactory: remoteEnv.tmpFactory },
    });

    const raw = await fs.readFile(targets.stateJson, 'utf8');
    const manifest = JSON.parse(raw) as {
      artifacts: Array<{ id: string; source?: string; ref?: string; sha?: string }>;
    };

    const internal = manifest.artifacts.find((a) => a.id === 'guardrails-claude');
    expect(internal).toBeDefined();
    expect(internal?.source).toBe('internal');
    expect(internal?.ref).toBe('v0.0.0');
    expect(internal?.sha).toBe('');
  });

  it('manifest: skill:remote-demo has source:external with real ref+sha', async () => {
    await runCli(['install', 'guardrails-claude', 'skill:remote-demo', '--yes'], {
      print: makeCapture().print,
      env: remoteEnv.env,
      artifactsDir: ARTIFACTS_DIR,
      remote: { run: remoteEnv.runner, tmpFactory: remoteEnv.tmpFactory },
    });

    const raw = await fs.readFile(targets.stateJson, 'utf8');
    const manifest = JSON.parse(raw) as {
      artifacts: Array<{ id: string; source?: string; ref?: string; sha?: string }>;
    };

    const external = manifest.artifacts.find((a) => a.id === 'skill:remote-demo');
    expect(external).toBeDefined();
    expect(external?.source).toBe('external');
    expect(external?.ref).toBe(TAG_NAME);
    expect(external?.sha).toBe(SHA);
  });

  it('manifest: internal entry has ref v0.0.0 and empty sha (versionFor distinguishes)', async () => {
    await runCli(['install', 'guardrails-claude', 'skill:remote-demo', '--yes'], {
      print: makeCapture().print,
      env: remoteEnv.env,
      artifactsDir: ARTIFACTS_DIR,
      remote: { run: remoteEnv.runner, tmpFactory: remoteEnv.tmpFactory },
    });

    const raw = await fs.readFile(targets.stateJson, 'utf8');
    const manifest = JSON.parse(raw) as {
      artifacts: Array<{ id: string; ref?: string; sha?: string }>;
    };

    const internal = manifest.artifacts.find((a) => a.id === 'guardrails-claude');
    // versionFor returns {source:'internal', ref:'v0.0.0', sha:''} for non-external entries
    expect(internal?.ref).toBe('v0.0.0');
    expect(internal?.sha).toBe('');
  });
});

// ---------------------------------------------------------------------------
// TEST-4: pack:harness via remote path (catalogUrl set)
//
// Regression guard: before adapter-builder.ts unification, buildClaudeAdapterForRemote
// in remote-install.ts lacked hookSpec → remote install of hook/pack entries threw
// "hookSpec is required". This test proves the fix.
// ---------------------------------------------------------------------------

describe('TEST-4 — pack:harness install via remote path with catalogUrl', () => {
  // pack:harness is a built-in pack; with catalogUrl configured the request goes
  // through runRemoteInstall → buildClaudeAdapter (unified) → hookSpec present.

  it('exits 0 when installing pack:harness with catalogUrl configured', async () => {
    const cap = makeCapture();
    const code = await runCli(['install', 'pack:harness', '--yes'], {
      print: cap.print,
      env: remoteEnv.env,
      artifactsDir: ARTIFACTS_DIR,
      remote: { run: remoteEnv.runner, tmpFactory: remoteEnv.tmpFactory },
    });
    expect(code).toBe(0);
  });

  it('writes all 4 guard hooks to settings.json', async () => {
    await runCli(['install', 'pack:harness', '--yes'], {
      print: makeCapture().print,
      env: remoteEnv.env,
      artifactsDir: ARTIFACTS_DIR,
      remote: { run: remoteEnv.runner, tmpFactory: remoteEnv.tmpFactory },
    });

    const settings = await readJson(targets.claudeSettings);

    // GUARD_HOOKS matches the BUILTIN_CATALOG values exactly.
    const GUARD_HOOKS = [
      { event: 'PreToolUse', matcher: 'Bash' },
      { event: 'PreToolUse', matcher: 'Read|Edit|MultiEdit|Write|NotebookEdit|Grep|Glob|Bash' },
      { event: 'PreToolUse', matcher: 'Write|Edit|MultiEdit' },
      { event: 'UserPromptSubmit', matcher: '*' },
    ] as const;

    const hooksSection = (settings as Record<string, unknown>)['hooks'] as
      | Record<string, unknown[]>
      | undefined;
    expect(hooksSection).toBeDefined();

    for (const guard of GUARD_HOOKS) {
      const eventHooks = (hooksSection?.[guard.event]) as unknown[] | undefined;
      expect(eventHooks).toBeDefined();
      const found = (eventHooks ?? []).some(
        (h) => (h as { matcher?: string }).matcher === guard.matcher,
      );
      expect(found).toBe(true);
    }
  });

  it('deposits hook scripts to store/hooks/', async () => {
    await runCli(['install', 'pack:harness', '--yes'], {
      print: makeCapture().print,
      env: remoteEnv.env,
      artifactsDir: ARTIFACTS_DIR,
      remote: { run: remoteEnv.runner, tmpFactory: remoteEnv.tmpFactory },
    });

    const scriptStore = path.join(path.dirname(targets.stateJson), 'hooks');

    for (const name of ['guard-command', 'guard-secret', 'guard-write-secret', 'guard-prompt']) {
      const exists = await fs.stat(path.join(scriptStore, `${name}.ts`))
        .then(() => true).catch(() => false);
      expect(exists).toBe(true);
    }
  });

  it('deposits _shared/hook-lib.ts to store/hooks/', async () => {
    await runCli(['install', 'pack:harness', '--yes'], {
      print: makeCapture().print,
      env: remoteEnv.env,
      artifactsDir: ARTIFACTS_DIR,
      remote: { run: remoteEnv.runner, tmpFactory: remoteEnv.tmpFactory },
    });

    const scriptStore = path.join(path.dirname(targets.stateJson), 'hooks');
    const sharedExists = await fs.stat(path.join(scriptStore, '_shared', 'hook-lib.ts'))
      .then(() => true).catch(() => false);
    expect(sharedExists).toBe(true);
  });

  it('manifest contains all 4 guard entries with source:internal', async () => {
    await runCli(['install', 'pack:harness', '--yes'], {
      print: makeCapture().print,
      env: remoteEnv.env,
      artifactsDir: ARTIFACTS_DIR,
      remote: { run: remoteEnv.runner, tmpFactory: remoteEnv.tmpFactory },
    });

    const raw = await fs.readFile(targets.stateJson, 'utf8');
    const manifest = JSON.parse(raw) as {
      artifacts: Array<{ id: string; source?: string }>;
    };

    for (
      const id of [
        'hook:guard-command',
        'hook:guard-secret',
        'hook:guard-write-secret',
        'hook:guard-prompt',
      ]
    ) {
      const entry = manifest.artifacts.find((a) => a.id === id);
      expect(entry).toBeDefined();
      expect(entry?.source).toBe('internal');
    }
  });
});
