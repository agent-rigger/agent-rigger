/**
 * cmd-update.test.ts — Tests for runUpdate (M1c-2).
 *
 * Strategy:
 * - HOME isolated via RIGGER_HOME in tmp dir.
 * - Pre-install via runCli to seed the manifest at v1.0.0.
 * - runner dispatches by args (ls-remote → tag, clone → no-op, rev-parse → sha).
 * - tmpFactory is version-aware: each invocation writes the CURRENT tag's content
 *   into a fresh tmp dir — so v1.0.0 and v1.1.0 checkouts produce different SKILL.md.
 * - No real git or network calls.
 *
 * Scenarios:
 * 1. stale      — remote v1.1.0 > installed v1.0.0 → id re-installed, manifest bumped,
 *                 AND store content is refreshed (proven by reading the store SKILL.md).
 * 2. up-to-date — remote == installed (v1.0.0) → upToDate, nothing written.
 * 3. internal   — runUpdate(['guardrails-claude']) → skipped "no remote version".
 * 4. no ids     — 2 externals, both stale → both updated.
 * 5. absent     — runUpdate(['skill:absent']) → skipped "not installed".
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
import { runUpdate } from '../src/cmd-update';

// ---------------------------------------------------------------------------
// Repo root + artifacts dir
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const ARTIFACTS_DIR = path.join(REPO_ROOT, 'artifacts');

// ---------------------------------------------------------------------------
// Fixed test fixtures
// ---------------------------------------------------------------------------

const SHA_V1_0_0 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_V1_1_0 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const TAG_V1_0_0 = 'v1.0.0';
const TAG_V1_1_0 = 'v1.1.0';

/** Versioned content for SKILL.md — distinct per tag so store refresh is provable. */
const SKILL_CONTENT_BY_TAG: Record<string, string> = {
  [TAG_V1_0_0]: '# Remote Demo Skill v1.0.0\nInitial release.',
  [TAG_V1_1_0]: '# Remote Demo Skill v1.1.0\nUpdated content — v1.1.0 proof.',
};

/** Minimal external skill entry for the remote catalog. */
const REMOTE_SKILL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:remote-demo',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

/** A second external skill for "no ids" test. */
const REMOTE_SKILL_B_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:remote-b',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

// ---------------------------------------------------------------------------
// makeIsolatedEnv — isolated HOME with catalog + skill fixtures
// ---------------------------------------------------------------------------

interface IsolatedEnv {
  env: Env;
  homeDir: string;
  /** Change which tag ls-remote returns (simulates remote advancing). */
  setRemoteTag: (tag: string, sha: string) => void;
  /** Runner that dispatches based on current mutable tag/sha. */
  makeRunner: () => CommandRunner;
  /**
   * Factory whose per-invocation tmp dir is populated with the CURRENT tag's content.
   * Tracks all created dirs for cleanup.
   */
  makeTmpFactory: () => TmpDirFactory;
  cleanupAll: () => Promise<void>;
}

async function makeIsolatedEnv(opts: {
  withCatalogUrl?: boolean;
  initialTag?: string;
  initialSha?: string;
  catalog?: CatalogEntry[];
  skillIds?: string[];
}): Promise<IsolatedEnv> {
  const {
    withCatalogUrl = true,
    initialTag = TAG_V1_0_0,
    initialSha = SHA_V1_0_0,
    catalog = [REMOTE_SKILL_ENTRY],
    skillIds = ['remote-demo'],
  } = opts;

  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-update-test-home-'));

  // Write config.json if needed
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

  // Mutable remote tag state (allows switching version between install+update)
  let currentTag = initialTag;
  let currentSha = initialSha;

  const setRemoteTag = (tag: string, sha: string) => {
    currentTag = tag;
    currentSha = sha;
  };

  // Track all tmp dirs created by makeTmpFactory for cleanup.
  const tmpDirsCreated: string[] = [];

  const makeRunner = (): CommandRunner => (_cmd, args) => {
    const argv = args ?? [];

    // git ls-remote --tags -- <url>
    if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${currentSha}\trefs/tags/${currentTag}\n`,
        stderr: '',
      });
    }

    // git ls-remote -- <url> HEAD
    if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${currentSha}\tHEAD\n`,
        stderr: '',
      });
    }

    // git clone → no-op (content pre-written in the tmp dir by the factory)
    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }

    // git -C <dir> rev-parse HEAD → current sha
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${currentSha}\n`, stderr: '' });
    }

    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };

  /**
   * Each call to the returned TmpDirFactory creates a fresh tmp dir populated with
   * the CURRENT tag's content. This ensures v1.0.0 and v1.1.0 checkouts differ.
   */
  const makeTmpFactory = (): TmpDirFactory => async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-update-checkout-'));
    tmpDirsCreated.push(tmpDir);

    // Write catalog.json
    await fs.writeFile(
      path.join(tmpDir, 'catalog.json'),
      JSON.stringify({ meta: { name: 'update-test-catalog' }, entries: catalog }),
      'utf8',
    );

    // Write versioned skill fixtures
    for (const skillId of skillIds) {
      await fs.mkdir(path.join(tmpDir, 'skills', skillId), { recursive: true });
      const content = SKILL_CONTENT_BY_TAG[currentTag]
        ?? `# Skill ${skillId}\n${currentTag} content.`;
      await fs.writeFile(path.join(tmpDir, 'skills', skillId, 'SKILL.md'), content, 'utf8');
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
    // Cleanup any leaked tmp dirs (in case tests fail before factory cleanup runs)
    for (const d of tmpDirsCreated) {
      await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    }
  };

  return {
    env,
    homeDir,
    setRemoteTag,
    makeRunner,
    makeTmpFactory,
    cleanupAll,
  };
}

function makeCapture() {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

// ---------------------------------------------------------------------------
// Shared lifecycle — used by Scenario 1, 2, 3
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
// Helper: pre-install skill:remote-demo at a given tag
// ---------------------------------------------------------------------------

async function preInstallRemote(env: Env, tag: string, sha: string) {
  iso.setRemoteTag(tag, sha);

  await runCli(['install', 'skill:remote-demo', '--yes'], {
    print: makeCapture().print,
    env,
    artifactsDir: ARTIFACTS_DIR,
    remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
  });
}

// ---------------------------------------------------------------------------
// Scenario 1: stale — re-install when remote is newer
// ---------------------------------------------------------------------------

describe('runUpdate — stale: re-installs when remote is newer', () => {
  it('returns updated array containing the skill id', async () => {
    await preInstallRemote(iso.env, TAG_V1_0_0, SHA_V1_0_0);
    iso.setRemoteTag(TAG_V1_1_0, SHA_V1_1_0);

    const result = await runUpdate({
      ids: ['skill:remote-demo'],
      scope: 'user',
      env: iso.env,
      manifestPath: targets.stateJson,
      artifactsDir: ARTIFACTS_DIR,
      catalogUrl: 'https://example.com/catalog.git',
      runner: iso.makeRunner(),
      tmpFactory: iso.makeTmpFactory(),
      scanner: stubScanner,
      confirm: true,
    });

    expect(result.updated).toContain('skill:remote-demo');
  });

  it('manifest ref is bumped to v1.1.0 after update', async () => {
    await preInstallRemote(iso.env, TAG_V1_0_0, SHA_V1_0_0);
    iso.setRemoteTag(TAG_V1_1_0, SHA_V1_1_0);

    await runUpdate({
      ids: ['skill:remote-demo'],
      scope: 'user',
      env: iso.env,
      manifestPath: targets.stateJson,
      artifactsDir: ARTIFACTS_DIR,
      catalogUrl: 'https://example.com/catalog.git',
      runner: iso.makeRunner(),
      tmpFactory: iso.makeTmpFactory(),
      scanner: stubScanner,
      confirm: true,
    });

    const raw = await fs.readFile(targets.stateJson, 'utf8');
    const manifest = JSON.parse(raw) as {
      artifacts: Array<{ id: string; ref?: string; sha?: string }>;
    };
    const entry = manifest.artifacts.find((a) => a.id === 'skill:remote-demo');
    expect(entry?.ref).toBe(TAG_V1_1_0);
    expect(entry?.sha).toBe(SHA_V1_1_0);
  });

  it('store SKILL.md content is refreshed to v1.1.0 (proves actual content update)', async () => {
    // Pre-install at v1.0.0 — store should contain v1.0.0 content.
    await preInstallRemote(iso.env, TAG_V1_0_0, SHA_V1_0_0);

    const skillsDir = resolveUserTargets(iso.env).skillsDir;
    const storeFile = path.join(skillsDir, 'remote-demo', 'SKILL.md');

    const contentV1 = await fs.readFile(storeFile, 'utf8');
    expect(contentV1).toContain('v1.0.0');

    // Advance remote to v1.1.0 and run update.
    iso.setRemoteTag(TAG_V1_1_0, SHA_V1_1_0);

    await runUpdate({
      ids: ['skill:remote-demo'],
      scope: 'user',
      env: iso.env,
      manifestPath: targets.stateJson,
      artifactsDir: ARTIFACTS_DIR,
      catalogUrl: 'https://example.com/catalog.git',
      runner: iso.makeRunner(),
      tmpFactory: iso.makeTmpFactory(),
      scanner: stubScanner,
      confirm: true,
    });

    // Store must now contain v1.1.0 content — not the stale v1.0.0.
    const contentV2 = await fs.readFile(storeFile, 'utf8');
    expect(contentV2).toContain('v1.1.0');
    expect(contentV2).not.toContain('v1.0.0');
  });

  it('upToDate is empty when only stale entries', async () => {
    await preInstallRemote(iso.env, TAG_V1_0_0, SHA_V1_0_0);
    iso.setRemoteTag(TAG_V1_1_0, SHA_V1_1_0);

    const result = await runUpdate({
      ids: ['skill:remote-demo'],
      scope: 'user',
      env: iso.env,
      manifestPath: targets.stateJson,
      artifactsDir: ARTIFACTS_DIR,
      catalogUrl: 'https://example.com/catalog.git',
      runner: iso.makeRunner(),
      tmpFactory: iso.makeTmpFactory(),
      scanner: stubScanner,
      confirm: true,
    });

    expect(result.upToDate).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: up-to-date — no write when remote == installed
// ---------------------------------------------------------------------------

describe('runUpdate — up-to-date: no write when versions match', () => {
  it('returns upToDate containing the skill id', async () => {
    await preInstallRemote(iso.env, TAG_V1_0_0, SHA_V1_0_0);

    const manifestPath = targets.stateJson;
    const contentBefore = await fs.readFile(manifestPath, 'utf8');

    const result = await runUpdate({
      ids: ['skill:remote-demo'],
      scope: 'user',
      env: iso.env,
      manifestPath,
      artifactsDir: ARTIFACTS_DIR,
      catalogUrl: 'https://example.com/catalog.git',
      runner: iso.makeRunner(),
      tmpFactory: iso.makeTmpFactory(),
      scanner: stubScanner,
      confirm: true,
    });

    expect(result.upToDate).toContain('skill:remote-demo');
    expect(result.updated).toHaveLength(0);

    // Manifest must be unchanged
    const contentAfter = await fs.readFile(manifestPath, 'utf8');
    expect(contentAfter).toBe(contentBefore);
  });

  it('output mentions up-to-date status', async () => {
    await preInstallRemote(iso.env, TAG_V1_0_0, SHA_V1_0_0);

    const result = await runUpdate({
      ids: ['skill:remote-demo'],
      scope: 'user',
      env: iso.env,
      manifestPath: targets.stateJson,
      artifactsDir: ARTIFACTS_DIR,
      catalogUrl: 'https://example.com/catalog.git',
      runner: iso.makeRunner(),
      tmpFactory: iso.makeTmpFactory(),
      scanner: stubScanner,
      confirm: true,
    });

    expect(result.output).toMatch(/up.to.date|already/i);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: internal — skipped with reason "no remote version"
// ---------------------------------------------------------------------------

describe('runUpdate — internal entry: skipped', () => {
  it('skipped array contains guardrails-claude', async () => {
    const result = await runUpdate({
      ids: ['guardrails-claude'],
      scope: 'user',
      env: iso.env,
      manifestPath: targets.stateJson,
      artifactsDir: ARTIFACTS_DIR,
      catalogUrl: 'https://example.com/catalog.git',
      runner: iso.makeRunner(),
      tmpFactory: iso.makeTmpFactory(),
      scanner: stubScanner,
      confirm: true,
    });

    expect(result.skipped).toContain('guardrails-claude');
  });

  it('neither updated nor upToDate when all ids are internal', async () => {
    const result = await runUpdate({
      ids: ['guardrails-claude'],
      scope: 'user',
      env: iso.env,
      manifestPath: targets.stateJson,
      artifactsDir: ARTIFACTS_DIR,
      catalogUrl: 'https://example.com/catalog.git',
      runner: iso.makeRunner(),
      tmpFactory: iso.makeTmpFactory(),
      scanner: stubScanner,
      confirm: true,
    });

    expect(result.updated).toHaveLength(0);
    expect(result.upToDate).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: no ids — 2 externals, both stale → both updated
// ---------------------------------------------------------------------------

describe('runUpdate — no ids: auto-selects external installed entries', () => {
  it('updates both stale externals when no ids given', async () => {
    const dualIso = await makeIsolatedEnv({
      catalog: [REMOTE_SKILL_ENTRY, REMOTE_SKILL_B_ENTRY],
      skillIds: ['remote-demo', 'remote-b'],
    });
    const dualTargets = resolveUserTargets(dualIso.env);

    try {
      dualIso.setRemoteTag(TAG_V1_0_0, SHA_V1_0_0);

      await runCli(['install', 'skill:remote-demo', 'skill:remote-b', '--yes'], {
        print: makeCapture().print,
        env: dualIso.env,
        artifactsDir: ARTIFACTS_DIR,
        remote: {
          run: dualIso.makeRunner(),
          tmpFactory: dualIso.makeTmpFactory(),
          scanner: stubScanner,
        },
      });

      dualIso.setRemoteTag(TAG_V1_1_0, SHA_V1_1_0);

      const result = await runUpdate({
        ids: [],
        scope: 'user',
        env: dualIso.env,
        manifestPath: dualTargets.stateJson,
        artifactsDir: ARTIFACTS_DIR,
        catalogUrl: 'https://example.com/catalog.git',
        runner: dualIso.makeRunner(),
        tmpFactory: dualIso.makeTmpFactory(),
        scanner: stubScanner,
        confirm: true,
      });

      expect(result.updated).toContain('skill:remote-demo');
      expect(result.updated).toContain('skill:remote-b');
      expect(result.upToDate).toHaveLength(0);
    } finally {
      await dualIso.cleanupAll();
    }
  });

  it('selects only external entries when no ids given (up-to-date case)', async () => {
    await preInstallRemote(iso.env, TAG_V1_0_0, SHA_V1_0_0);

    const result = await runUpdate({
      ids: [],
      scope: 'user',
      env: iso.env,
      manifestPath: targets.stateJson,
      artifactsDir: ARTIFACTS_DIR,
      catalogUrl: 'https://example.com/catalog.git',
      runner: iso.makeRunner(),
      tmpFactory: iso.makeTmpFactory(),
      scanner: stubScanner,
      confirm: true,
    });

    expect(result.upToDate).toContain('skill:remote-demo');
    expect(result.updated).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: id not installed → skipped "not installed"
// ---------------------------------------------------------------------------

describe('runUpdate — id not installed: skipped', () => {
  it('skipped contains the absent id', async () => {
    const result = await runUpdate({
      ids: ['skill:absent'],
      scope: 'user',
      env: iso.env,
      manifestPath: targets.stateJson,
      artifactsDir: ARTIFACTS_DIR,
      catalogUrl: 'https://example.com/catalog.git',
      runner: iso.makeRunner(),
      tmpFactory: iso.makeTmpFactory(),
      scanner: stubScanner,
      confirm: true,
    });

    expect(result.skipped).toContain('skill:absent');
  });

  it('output mentions the absent id', async () => {
    const result = await runUpdate({
      ids: ['skill:absent'],
      scope: 'user',
      env: iso.env,
      manifestPath: targets.stateJson,
      artifactsDir: ARTIFACTS_DIR,
      catalogUrl: 'https://example.com/catalog.git',
      runner: iso.makeRunner(),
      tmpFactory: iso.makeTmpFactory(),
      scanner: stubScanner,
      confirm: true,
    });

    expect(result.output).toMatch(/absent|not installed/i);
  });
});

// ---------------------------------------------------------------------------
// Transactional safety — confirm=false and clone failure
// ---------------------------------------------------------------------------

describe('runUpdate — transactional: confirm=false leaves artifact intact', () => {
  it('artifact stays installed at v1.0.0 when confirm returns false', async () => {
    await preInstallRemote(iso.env, TAG_V1_0_0, SHA_V1_0_0);
    iso.setRemoteTag(TAG_V1_1_0, SHA_V1_1_0);

    const skillsDir = resolveUserTargets(iso.env).skillsDir;
    const storeFile = path.join(skillsDir, 'remote-demo', 'SKILL.md');

    // Record state before the aborted update.
    const manifestBefore = await fs.readFile(targets.stateJson, 'utf8');
    const contentBefore = await fs.readFile(storeFile, 'utf8');
    expect(contentBefore).toContain('v1.0.0');

    // confirm=false → user declines.
    const result = await runUpdate({
      ids: ['skill:remote-demo'],
      scope: 'user',
      env: iso.env,
      manifestPath: targets.stateJson,
      artifactsDir: ARTIFACTS_DIR,
      catalogUrl: 'https://example.com/catalog.git',
      runner: iso.makeRunner(),
      tmpFactory: iso.makeTmpFactory(),
      scanner: stubScanner,
      confirm: false,
    });

    // updated must be empty — nothing was reinstalled.
    expect(result.updated).toHaveLength(0);

    // Manifest ref MUST remain v1.0.0 — nothing was removed.
    const manifestAfter = await fs.readFile(targets.stateJson, 'utf8');
    const parsed = JSON.parse(manifestAfter) as {
      artifacts: Array<{ id: string; ref?: string }>;
    };
    const entry = parsed.artifacts.find((a) => a.id === 'skill:remote-demo');
    expect(entry?.ref).toBe(TAG_V1_0_0);

    // Manifest bytes unchanged.
    expect(manifestAfter).toBe(manifestBefore);

    // Store content is still v1.0.0.
    const contentAfter = await fs.readFile(storeFile, 'utf8');
    expect(contentAfter).toContain('v1.0.0');
    expect(contentAfter).toBe(contentBefore);
  });

  it('confirm callback returning false leaves artifact intact', async () => {
    await preInstallRemote(iso.env, TAG_V1_0_0, SHA_V1_0_0);
    iso.setRemoteTag(TAG_V1_1_0, SHA_V1_1_0);

    const manifestBefore = await fs.readFile(targets.stateJson, 'utf8');

    const result = await runUpdate({
      ids: ['skill:remote-demo'],
      scope: 'user',
      env: iso.env,
      manifestPath: targets.stateJson,
      artifactsDir: ARTIFACTS_DIR,
      catalogUrl: 'https://example.com/catalog.git',
      runner: iso.makeRunner(),
      tmpFactory: iso.makeTmpFactory(),
      scanner: stubScanner,
      confirm: () => Promise.resolve(false),
    });

    expect(result.updated).toHaveLength(0);

    const manifestAfter = await fs.readFile(targets.stateJson, 'utf8');
    expect(manifestAfter).toBe(manifestBefore);
  });

  it('output mentions aborted when user declines', async () => {
    await preInstallRemote(iso.env, TAG_V1_0_0, SHA_V1_0_0);
    iso.setRemoteTag(TAG_V1_1_0, SHA_V1_1_0);

    const result = await runUpdate({
      ids: ['skill:remote-demo'],
      scope: 'user',
      env: iso.env,
      manifestPath: targets.stateJson,
      artifactsDir: ARTIFACTS_DIR,
      catalogUrl: 'https://example.com/catalog.git',
      runner: iso.makeRunner(),
      tmpFactory: iso.makeTmpFactory(),
      scanner: stubScanner,
      confirm: false,
    });

    expect(result.output).toMatch(/aborted/i);
  });
});

describe('runUpdate — transactional: clone failure leaves artifact intact', () => {
  it('artifact stays installed at v1.0.0 when git clone fails', async () => {
    await preInstallRemote(iso.env, TAG_V1_0_0, SHA_V1_0_0);
    iso.setRemoteTag(TAG_V1_1_0, SHA_V1_1_0);

    const skillsDir = resolveUserTargets(iso.env).skillsDir;
    const storeFile = path.join(skillsDir, 'remote-demo', 'SKILL.md');

    const manifestBefore = await fs.readFile(targets.stateJson, 'utf8');
    const contentBefore = await fs.readFile(storeFile, 'utf8');
    expect(contentBefore).toContain('v1.0.0');

    // Runner: ls-remote succeeds (resolveVersion), clone fails (withRemoteCheckout throws).
    const cloneFailRunner: CommandRunner = (_cmd, args) => {
      const argv = args ?? [];
      if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
        return Promise.resolve({
          exitCode: 0,
          stdout: `${SHA_V1_1_0}\trefs/tags/${TAG_V1_1_0}\n`,
          stderr: '',
        });
      }
      if (argv[0] === 'clone') {
        return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'network error' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    };

    // runUpdate must throw (RemoteFetchError from clone) — caller handles it.
    await expect(
      runUpdate({
        ids: ['skill:remote-demo'],
        scope: 'user',
        env: iso.env,
        manifestPath: targets.stateJson,
        artifactsDir: ARTIFACTS_DIR,
        catalogUrl: 'https://example.com/catalog.git',
        runner: cloneFailRunner,
        tmpFactory: iso.makeTmpFactory(),
        scanner: stubScanner,
        confirm: true,
      }),
    ).rejects.toThrow();

    // Manifest must be untouched — remove never executed.
    const manifestAfter = await fs.readFile(targets.stateJson, 'utf8');
    expect(manifestAfter).toBe(manifestBefore);

    // Store content still v1.0.0.
    const contentAfter = await fs.readFile(storeFile, 'utf8');
    expect(contentAfter).toContain('v1.0.0');
    expect(contentAfter).toBe(contentBefore);
  });
});

describe('runUpdate — interactive confirm: installs when confirmed', () => {
  it('updates skill when confirm callback returns true', async () => {
    await preInstallRemote(iso.env, TAG_V1_0_0, SHA_V1_0_0);
    iso.setRemoteTag(TAG_V1_1_0, SHA_V1_1_0);

    const result = await runUpdate({
      ids: ['skill:remote-demo'],
      scope: 'user',
      env: iso.env,
      manifestPath: targets.stateJson,
      artifactsDir: ARTIFACTS_DIR,
      catalogUrl: 'https://example.com/catalog.git',
      runner: iso.makeRunner(),
      tmpFactory: iso.makeTmpFactory(),
      scanner: stubScanner,
      confirm: () => Promise.resolve(true),
    });

    expect(result.updated).toContain('skill:remote-demo');

    // Manifest ref bumped.
    const raw = await fs.readFile(targets.stateJson, 'utf8');
    const parsed = JSON.parse(raw) as { artifacts: Array<{ id: string; ref?: string }> };
    const entry = parsed.artifacts.find((a) => a.id === 'skill:remote-demo');
    expect(entry?.ref).toBe(TAG_V1_1_0);
  });

  it('confirm callback receives a plan text describing the update', async () => {
    await preInstallRemote(iso.env, TAG_V1_0_0, SHA_V1_0_0);
    iso.setRemoteTag(TAG_V1_1_0, SHA_V1_1_0);

    let capturedPlanText = '';

    await runUpdate({
      ids: ['skill:remote-demo'],
      scope: 'user',
      env: iso.env,
      manifestPath: targets.stateJson,
      artifactsDir: ARTIFACTS_DIR,
      catalogUrl: 'https://example.com/catalog.git',
      runner: iso.makeRunner(),
      tmpFactory: iso.makeTmpFactory(),
      scanner: stubScanner,
      confirm: (planText) => {
        capturedPlanText = planText;
        return Promise.resolve(true);
      },
    });

    // planText must mention the id and the version transition.
    expect(capturedPlanText).toMatch(/remote-demo/i);
    expect(capturedPlanText).toMatch(/v1\.0\.0/);
    expect(capturedPlanText).toMatch(/v1\.1\.0/);
  });
});
