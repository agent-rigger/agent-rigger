/**
 * s4-scanner-remote.test.ts — Security scanner integration tests (S4).
 *
 * Strategy:
 * - HOME isolated via tmp dir (RIGGER_HOME override — never touches real ~/.claude).
 * - Fake Scanner injected into runRemoteInstall — no real gitleaks/trivy spawned.
 * - Fake runner handles git operations (same pattern as e2e-remote-install.test.ts).
 * - Tests verify fail-closed policy (no --force) and warn+proceed policy (--force).
 *
 * Scenarios:
 * 1. External skill + scanner { ok: false } without --force → ScanBlockedError, nothing written.
 * 2. External skill + scanner { ok: false } with --force   → installed, warning in output.
 * 3. External skill + scanner { ok: true }                 → installed normally.
 * 4. Internal-only install via runRemoteInstall            → scanner never called.
 * 5. parseArgs recognizes --force flag.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type CatalogEntry, type TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { Scanner } from '@agent-rigger/core/scan';

import { parseArgs } from '../src/cli';
import { runRemoteInstall, ScanBlockedError } from '../src/remote-install';

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

const REMOTE_SKILL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:remote-demo',
  nature: 'skill',
  source: 'external',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

// ---------------------------------------------------------------------------
// makeRemoteEnv — isolated HOME + content dir
// ---------------------------------------------------------------------------

async function makeRemoteEnv(): Promise<{
  env: Env;
  homeDir: string;
  contentDir: string;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  cleanupAll: () => Promise<void>;
}> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-s4-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-s4-content-'));

  // Write catalog.json
  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 's4-test-catalog' }, entries: [REMOTE_SKILL_ENTRY] }),
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
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify({ catalogUrl: 'https://example.com/catalog.git' }),
    'utf8',
  );

  const env: Env = { RIGGER_HOME: homeDir };

  const runner: CommandRunner = (_cmd, args) => {
    const argv = args ?? [];

    if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${SHA}\trefs/tags/${TAG_NAME}\n`,
        stderr: '',
      });
    }

    if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${SHA}\tHEAD\n`,
        stderr: '',
      });
    }

    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }

    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\n`, stderr: '' });
    }

    // tool advisory checks — report absent
    return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' });
  };

  const tmpFactory: TmpDirFactory = async () => ({
    path: contentDir,
    cleanup: async () => {},
  });

  const cleanupAll = async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(contentDir, { recursive: true, force: true });
  };

  return { env, homeDir, contentDir, runner, tmpFactory, cleanupAll };
}

// ---------------------------------------------------------------------------
// Fake scanner builders
// ---------------------------------------------------------------------------

function blockingScanner(findings: string[]): Scanner {
  return { scan: (_source: string) => Promise.resolve({ ok: false, findings }) };
}

function cleanScanner(): Scanner {
  return { scan: (_source: string) => Promise.resolve({ ok: true }) };
}

/** Scanner that records every path it was called with. */
function spyScanner(): { scanner: Scanner; calls: string[] } {
  const calls: string[] = [];
  const scanner: Scanner = {
    scan: (source: string) => {
      calls.push(source);
      return Promise.resolve({ ok: true });
    },
  };
  return { scanner, calls };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let remoteEnv: Awaited<ReturnType<typeof makeRemoteEnv>>;
let targets: ReturnType<typeof resolveUserTargets>;

beforeEach(async () => {
  remoteEnv = await makeRemoteEnv();
  targets = resolveUserTargets(remoteEnv.env);
});

afterEach(async () => {
  await remoteEnv.cleanupAll();
});

// ---------------------------------------------------------------------------
// Scenario 1: external skill + blocking scanner without --force → ScanBlockedError
// ---------------------------------------------------------------------------

describe('S4 — external skill + blocking scanner, no --force', () => {
  it('throws ScanBlockedError', async () => {
    await expect(
      runRemoteInstall({
        ids: ['skill:remote-demo'],
        catalogUrl: 'https://example.com/catalog.git',
        scope: 'user',
        env: remoteEnv.env,
        manifestPath: targets.stateJson,
        artifactsDir: ARTIFACTS_DIR,
        runner: remoteEnv.runner,
        tmpFactory: remoteEnv.tmpFactory,
        confirm: true,
        scanner: blockingScanner(['[gitleaks] aws-access-key: AWS key (config.env)']),
        force: false,
      }),
    ).rejects.toBeInstanceOf(ScanBlockedError);
  });

  it('does not write skill to store when scan blocks', async () => {
    await runRemoteInstall({
      ids: ['skill:remote-demo'],
      catalogUrl: 'https://example.com/catalog.git',
      scope: 'user',
      env: remoteEnv.env,
      manifestPath: targets.stateJson,
      artifactsDir: ARTIFACTS_DIR,
      runner: remoteEnv.runner,
      tmpFactory: remoteEnv.tmpFactory,
      confirm: true,
      scanner: blockingScanner(['[gitleaks] aws-access-key: AWS key (config.env)']),
      force: false,
    }).catch(() => {});

    const skillStorePath = path.join(targets.skillsDir, 'remote-demo');
    const stat = await fs.stat(skillStorePath).catch(() => null);
    expect(stat).toBeNull();
  });

  it('ScanBlockedError message mentions findings', async () => {
    let caught: unknown;
    await runRemoteInstall({
      ids: ['skill:remote-demo'],
      catalogUrl: 'https://example.com/catalog.git',
      scope: 'user',
      env: remoteEnv.env,
      manifestPath: targets.stateJson,
      artifactsDir: ARTIFACTS_DIR,
      runner: remoteEnv.runner,
      tmpFactory: remoteEnv.tmpFactory,
      confirm: true,
      scanner: blockingScanner(['[gitleaks] aws-access-key: AWS key (config.env)']),
      force: false,
    }).catch((e) => {
      caught = e;
    });

    expect(caught).toBeInstanceOf(ScanBlockedError);
    expect((caught as ScanBlockedError).message).toContain('aws-access-key');
  });

  it('ScanBlockedError message mentions --force hint', async () => {
    let caught: unknown;
    await runRemoteInstall({
      ids: ['skill:remote-demo'],
      catalogUrl: 'https://example.com/catalog.git',
      scope: 'user',
      env: remoteEnv.env,
      manifestPath: targets.stateJson,
      artifactsDir: ARTIFACTS_DIR,
      runner: remoteEnv.runner,
      tmpFactory: remoteEnv.tmpFactory,
      confirm: true,
      scanner: blockingScanner(['[gitleaks] aws-access-key: AWS key (config.env)']),
      force: false,
    }).catch((e) => {
      caught = e;
    });

    expect((caught as ScanBlockedError).message).toContain('--force');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: external skill + blocking scanner WITH --force → installed + warning
// ---------------------------------------------------------------------------

describe('S4 — external skill + blocking scanner, with --force', () => {
  it('does not throw', async () => {
    await expect(
      runRemoteInstall({
        ids: ['skill:remote-demo'],
        catalogUrl: 'https://example.com/catalog.git',
        scope: 'user',
        env: remoteEnv.env,
        manifestPath: targets.stateJson,
        artifactsDir: ARTIFACTS_DIR,
        runner: remoteEnv.runner,
        tmpFactory: remoteEnv.tmpFactory,
        confirm: true,
        scanner: blockingScanner(['[gitleaks] aws-access-key: AWS key (config.env)']),
        force: true,
      }),
    ).resolves.toBeDefined();
  });

  it('skill is installed in store despite blocking scan', async () => {
    await runRemoteInstall({
      ids: ['skill:remote-demo'],
      catalogUrl: 'https://example.com/catalog.git',
      scope: 'user',
      env: remoteEnv.env,
      manifestPath: targets.stateJson,
      artifactsDir: ARTIFACTS_DIR,
      runner: remoteEnv.runner,
      tmpFactory: remoteEnv.tmpFactory,
      confirm: true,
      scanner: blockingScanner(['[gitleaks] aws-access-key: AWS key (config.env)']),
      force: true,
    });

    const skillStorePath = path.join(targets.skillsDir, 'remote-demo');
    const stat = await fs.stat(skillStorePath).catch(() => null);
    expect(stat).not.toBeNull();
  });

  it('output contains [warning] security scan findings', async () => {
    const result = await runRemoteInstall({
      ids: ['skill:remote-demo'],
      catalogUrl: 'https://example.com/catalog.git',
      scope: 'user',
      env: remoteEnv.env,
      manifestPath: targets.stateJson,
      artifactsDir: ARTIFACTS_DIR,
      runner: remoteEnv.runner,
      tmpFactory: remoteEnv.tmpFactory,
      confirm: true,
      scanner: blockingScanner(['[gitleaks] aws-access-key: AWS key (config.env)']),
      force: true,
    });

    expect(result.output).toContain('[warning]');
    expect(result.output).toContain('security scan');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: external skill + clean scanner → installed normally
// ---------------------------------------------------------------------------

describe('S4 — external skill + clean scanner', () => {
  it('exits cleanly and installs', async () => {
    const result = await runRemoteInstall({
      ids: ['skill:remote-demo'],
      catalogUrl: 'https://example.com/catalog.git',
      scope: 'user',
      env: remoteEnv.env,
      manifestPath: targets.stateJson,
      artifactsDir: ARTIFACTS_DIR,
      runner: remoteEnv.runner,
      tmpFactory: remoteEnv.tmpFactory,
      confirm: true,
      scanner: cleanScanner(),
    });

    expect(result.applied).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: internal-only install → scanner never called
// ---------------------------------------------------------------------------

describe('S4 — internal-only install, scanner never called', () => {
  it('does not call the scanner for internal entries', async () => {
    const { scanner, calls } = spyScanner();

    // guardrails-claude is source:'internal' in BUILTIN_CATALOG
    await runRemoteInstall({
      ids: ['guardrails-claude'],
      catalogUrl: 'https://example.com/catalog.git',
      scope: 'user',
      env: remoteEnv.env,
      manifestPath: targets.stateJson,
      artifactsDir: ARTIFACTS_DIR,
      runner: remoteEnv.runner,
      tmpFactory: remoteEnv.tmpFactory,
      confirm: true,
      scanner,
    });

    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: parseArgs recognises --force
// ---------------------------------------------------------------------------

describe('parseArgs — --force flag', () => {
  it('sets flags.force = true when --force is passed', () => {
    const parsed = parseArgs(['install', 'skill:remote-demo', '--yes', '--force']);
    expect(parsed.flags['force']).toBe(true);
  });

  it('flags.force is absent when --force is not passed', () => {
    const parsed = parseArgs(['install', 'skill:remote-demo', '--yes']);
    expect(parsed.flags['force']).toBeUndefined();
  });
});
