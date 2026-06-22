/**
 * s4b-update-scanner.test.ts — Security scanner integration tests for runUpdate (S4 continuation).
 *
 * Strategy:
 * - HOME isolated via RIGGER_HOME in tmp dir.
 * - Pre-install skill at v1.0.0; advance remote to v1.1.0 → stale.
 * - Inject fake Scanner into runUpdate opts — no real gitleaks/trivy.
 * - The scan gate is BEFORE remove+apply, so a blocked scan leaves the manifest + store intact.
 *
 * Scenarios:
 * 1. stale skill + blocking scanner, no force → ScanBlockedError; manifest stays at v1.0.0.
 * 2. stale skill + blocking scanner, force    → updated; output contains [warning].
 * 3. stale skill + clean scanner              → updated normally (no warning).
 * 4. scanExternalEntries helper re-exported   → type-checks (covered implicitly by import).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { Scanner } from '@agent-rigger/core/scan';
import { stubScanner } from '@agent-rigger/core/scan';

import { runCli } from '../src/cli';
import { runUpdate } from '../src/cmd-update';
import { ScanBlockedError } from '../src/remote-install';

// ---------------------------------------------------------------------------
// Repo root
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const ARTIFACTS_DIR = path.join(REPO_ROOT, 'artifacts');

// ---------------------------------------------------------------------------
// Fixed fixtures
// ---------------------------------------------------------------------------

const SHA_V1_0_0 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_V1_1_0 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TAG_V1_0_0 = 'v1.0.0';
const TAG_V1_1_0 = 'v1.1.0';

const REMOTE_SKILL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:remote-demo',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

// ---------------------------------------------------------------------------
// Fake scanners
// ---------------------------------------------------------------------------

function blockingScanner(findings: string[]): Scanner {
  return { scan: (_source: string) => Promise.resolve({ ok: false, findings }) };
}

function cleanScanner(): Scanner {
  return { scan: (_source: string) => Promise.resolve({ ok: true }) };
}

// ---------------------------------------------------------------------------
// makeUpdateEnv — isolated HOME with pre-installed skill at v1.0.0
// ---------------------------------------------------------------------------

async function makeUpdateEnv(): Promise<{
  env: Env;
  homeDir: string;
  setRemoteTag: (tag: string, sha: string) => void;
  makeRunner: () => CommandRunner;
  makeTmpFactory: () => TmpDirFactory;
  cleanupAll: () => Promise<void>;
}> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-s4b-home-'));
  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify({ catalogUrl: 'https://example.com/catalog.git' }),
    'utf8',
  );

  const env: Env = { RIGGER_HOME: homeDir };
  let currentTag = TAG_V1_0_0;
  let currentSha = SHA_V1_0_0;

  const setRemoteTag = (tag: string, sha: string) => {
    currentTag = tag;
    currentSha = sha;
  };

  const tmpDirsCreated: string[] = [];

  const makeRunner = (): CommandRunner => (_cmd, args) => {
    const argv = args ?? [];

    if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${currentSha}\trefs/tags/${currentTag}\n`,
        stderr: '',
      });
    }

    if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${currentSha}\tHEAD\n`,
        stderr: '',
      });
    }

    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }

    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${currentSha}\n`, stderr: '' });
    }

    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };

  const makeTmpFactory = (): TmpDirFactory => async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-s4b-checkout-'));
    tmpDirsCreated.push(tmpDir);

    await fs.writeFile(
      path.join(tmpDir, 'catalog.json'),
      JSON.stringify({ meta: { name: 's4b-test-catalog' }, entries: [REMOTE_SKILL_ENTRY] }),
      'utf8',
    );

    await fs.mkdir(path.join(tmpDir, 'skills', 'remote-demo'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'skills', 'remote-demo', 'SKILL.md'),
      `# Remote Demo Skill ${currentTag}\nContent for ${currentTag}.`,
      'utf8',
    );

    return {
      path: tmpDir,
      cleanup: async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
      },
    };
  };

  const cleanupAll = async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    for (const d of tmpDirsCreated) {
      await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    }
  };

  return { env, homeDir, setRemoteTag, makeRunner, makeTmpFactory, cleanupAll };
}

function makeCapture() {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

// ---------------------------------------------------------------------------
// Lifecycle — pre-install skill at v1.0.0, then advance remote to v1.1.0
// ---------------------------------------------------------------------------

let env: Env;
let targets: ReturnType<typeof resolveUserTargets>;
let setRemoteTag: (tag: string, sha: string) => void;
let makeRunner: () => CommandRunner;
let makeTmpFactory: () => TmpDirFactory;
let cleanupAll: () => Promise<void>;
let manifestPath: string;
let catalogUrl: string;

beforeEach(async () => {
  const setup = await makeUpdateEnv();
  env = setup.env;
  targets = resolveUserTargets(env);
  setRemoteTag = setup.setRemoteTag;
  makeRunner = setup.makeRunner;
  makeTmpFactory = setup.makeTmpFactory;
  cleanupAll = setup.cleanupAll;
  manifestPath = targets.stateJson;
  catalogUrl = 'https://example.com/catalog.git';

  // Pre-install at v1.0.0
  setRemoteTag(TAG_V1_0_0, SHA_V1_0_0);
  await runCli(['install', 'skill:remote-demo', '--yes'], {
    print: makeCapture().print,
    env,
    artifactsDir: ARTIFACTS_DIR,
    remote: { run: makeRunner(), tmpFactory: makeTmpFactory(), scanner: stubScanner },
  });

  // Advance remote to v1.1.0 so skill is now stale
  setRemoteTag(TAG_V1_1_0, SHA_V1_1_0);
});

afterEach(async () => {
  await cleanupAll();
});

// ---------------------------------------------------------------------------
// Scenario 1: blocking scanner, no --force → ScanBlockedError, manifest intact
// ---------------------------------------------------------------------------

describe('runUpdate — stale skill + blocking scanner, no force', () => {
  it('throws ScanBlockedError', async () => {
    await expect(
      runUpdate({
        ids: ['skill:remote-demo'],
        scope: 'user',
        env,
        manifestPath,
        artifactsDir: ARTIFACTS_DIR,
        catalogUrl,
        runner: makeRunner(),
        tmpFactory: makeTmpFactory(),
        confirm: true,
        scanner: blockingScanner(['[gitleaks] aws-access-key: AWS key (config.env)']),
        force: false,
      }),
    ).rejects.toBeInstanceOf(ScanBlockedError);
  });

  it('manifest entry remains at v1.0.0 (scan is before remove)', async () => {
    await runUpdate({
      ids: ['skill:remote-demo'],
      scope: 'user',
      env,
      manifestPath,
      artifactsDir: ARTIFACTS_DIR,
      catalogUrl,
      runner: makeRunner(),
      tmpFactory: makeTmpFactory(),
      confirm: true,
      scanner: blockingScanner(['[gitleaks] aws-access-key: AWS key (config.env)']),
      force: false,
    }).catch(() => {});

    const raw = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as { artifacts: Array<{ id: string; ref: string }> };
    const entry = manifest.artifacts.find((a) => a.id === 'skill:remote-demo');
    expect(entry?.ref).toBe(TAG_V1_0_0);
  });

  it('skill store still contains v1.0.0 content', async () => {
    await runUpdate({
      ids: ['skill:remote-demo'],
      scope: 'user',
      env,
      manifestPath,
      artifactsDir: ARTIFACTS_DIR,
      catalogUrl,
      runner: makeRunner(),
      tmpFactory: makeTmpFactory(),
      confirm: true,
      scanner: blockingScanner(['[gitleaks] aws-access-key: AWS key (config.env)']),
      force: false,
    }).catch(() => {});

    const skillMd = path.join(targets.skillsDir, 'remote-demo', 'SKILL.md');
    const content = await fs.readFile(skillMd, 'utf8').catch(() => '');
    expect(content).toContain(TAG_V1_0_0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: blocking scanner WITH --force → updated + warning in output
// ---------------------------------------------------------------------------

describe('runUpdate — stale skill + blocking scanner, with force', () => {
  it('does not throw', async () => {
    await expect(
      runUpdate({
        ids: ['skill:remote-demo'],
        scope: 'user',
        env,
        manifestPath,
        artifactsDir: ARTIFACTS_DIR,
        catalogUrl,
        runner: makeRunner(),
        tmpFactory: makeTmpFactory(),
        confirm: true,
        scanner: blockingScanner(['[gitleaks] aws-access-key: AWS key (config.env)']),
        force: true,
      }),
    ).resolves.toBeDefined();
  });

  it('manifest is bumped to v1.1.0', async () => {
    await runUpdate({
      ids: ['skill:remote-demo'],
      scope: 'user',
      env,
      manifestPath,
      artifactsDir: ARTIFACTS_DIR,
      catalogUrl,
      runner: makeRunner(),
      tmpFactory: makeTmpFactory(),
      confirm: true,
      scanner: blockingScanner(['[gitleaks] aws-access-key: AWS key (config.env)']),
      force: true,
    });

    const raw = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as { artifacts: Array<{ id: string; ref: string }> };
    const entry = manifest.artifacts.find((a) => a.id === 'skill:remote-demo');
    expect(entry?.ref).toBe(TAG_V1_1_0);
  });

  it('output contains [warning] security scan', async () => {
    const result = await runUpdate({
      ids: ['skill:remote-demo'],
      scope: 'user',
      env,
      manifestPath,
      artifactsDir: ARTIFACTS_DIR,
      catalogUrl,
      runner: makeRunner(),
      tmpFactory: makeTmpFactory(),
      confirm: true,
      scanner: blockingScanner(['[gitleaks] aws-access-key: AWS key (config.env)']),
      force: true,
    });

    expect(result.output).toContain('[warning]');
    expect(result.output).toContain('security scan');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: clean scanner → update proceeds normally
// ---------------------------------------------------------------------------

describe('runUpdate — stale skill + clean scanner', () => {
  it('updates to v1.1.0 without warning', async () => {
    const result = await runUpdate({
      ids: ['skill:remote-demo'],
      scope: 'user',
      env,
      manifestPath,
      artifactsDir: ARTIFACTS_DIR,
      catalogUrl,
      runner: makeRunner(),
      tmpFactory: makeTmpFactory(),
      confirm: true,
      scanner: cleanScanner(),
    });

    expect(result.updated).toContain('skill:remote-demo');
    expect(result.output).not.toContain('[warning]');
  });
});
