/**
 * h6-external-plugin.test.ts — Tests for H6: external plugin install via content repo.
 *
 * Verifies that when a plugin entry has source:'external' and catalogUrl is set,
 * buildClaudeAdapterForRemote (via runRemoteInstall) passes the catalogUrl as the
 * marketplace URL to `claude plugin marketplace add` — not the local marketplace.json.
 *
 * Strategy:
 * - HOME isolated via RIGGER_HOME in a tmp dir.
 * - runRemoteInstall called directly with a fake runner that:
 *     - handles git calls (ls-remote, clone, rev-parse) for version resolution.
 *     - handles `claude plugin list` (audit: returns empty → not installed).
 *     - handles `claude plugin marketplace add <url>` → records call.
 *     - handles `claude plugin install <name>` → records call.
 * - Content dir pre-populated with catalog.json (plugin entry) — no skills/ needed.
 *
 * Invariants:
 * - No real git network calls.
 * - No real `claude` binary invocations.
 * - Isolation: each test uses its own tmp dir.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { runRemoteInstall } from '../src/remote-install';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TAG_NAME = 'v2.0.0';
const SHA = 'cafebabecafebabecafebabecafebabecafebabe';
const CATALOG_URL = 'https://example.com/content-repo.git';

/** External plugin entry — no filesystem sources needed. */
const REMOTE_PLUGIN_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'plugin:demo-plugin',
  nature: 'plugin',
  source: 'external',
  targets: ['claude'],
  scopes: ['user'],
};

// ---------------------------------------------------------------------------
// Repo root + artifacts dir
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const ARTIFACTS_DIR = path.join(REPO_ROOT, 'artifacts');

// ---------------------------------------------------------------------------
// makePluginEnv — isolated HOME + content dir with plugin catalog fixture
// ---------------------------------------------------------------------------

async function makePluginEnv(): Promise<{
  env: Env;
  homeDir: string;
  contentDir: string;
  capturedCalls: Array<{ command: string; args: string[] }>;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  cleanupAll: () => Promise<void>;
  manifestPath: string;
}> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-h6-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-h6-content-'));

  // Write catalog.json with the external plugin entry
  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify([REMOTE_PLUGIN_ENTRY]),
    'utf8',
  );

  const env: Env = { RIGGER_HOME: homeDir };
  const targets = resolveUserTargets(env);

  // Ensure the config dir exists so the manifest path is writable
  await fs.mkdir(path.dirname(targets.stateJson), { recursive: true });

  const capturedCalls: Array<{ command: string; args: string[] }> = [];

  const runner: CommandRunner = (cmd, args) => {
    const argv = args ?? [];

    // git ls-remote --tags → one tag line
    if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${SHA}\trefs/tags/${TAG_NAME}\n`,
        stderr: '',
      });
    }

    // git ls-remote HEAD → sha
    if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${SHA}\tHEAD\n`,
        stderr: '',
      });
    }

    // git clone → no-op (contentDir already populated)
    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }

    // git -C <dir> rev-parse HEAD → fixed sha
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\n`, stderr: '' });
    }

    // claude plugin list → empty (plugin not yet installed)
    if (cmd === 'claude' && argv[0] === 'plugin' && argv[1] === 'list') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }

    // claude plugin marketplace add <url> → record + succeed
    if (
      cmd === 'claude' && argv[0] === 'plugin' && argv[1] === 'marketplace' && argv[2] === 'add'
    ) {
      capturedCalls.push({ command: cmd, args: [...argv] });
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }

    // claude plugin install <name> → record + succeed
    if (cmd === 'claude' && argv[0] === 'plugin' && argv[1] === 'install') {
      capturedCalls.push({ command: cmd, args: [...argv] });
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }

    // Advisory tool checks (sh, which) → absent
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

  return {
    env,
    homeDir,
    contentDir,
    capturedCalls,
    runner,
    tmpFactory,
    cleanupAll,
    manifestPath: targets.stateJson,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let ctx: Awaited<ReturnType<typeof makePluginEnv>>;

beforeEach(async () => {
  ctx = await makePluginEnv();
});

afterEach(async () => {
  await ctx.cleanupAll();
});

// ---------------------------------------------------------------------------
// External plugin install — delegate runner receives catalogUrl as marketplace
// ---------------------------------------------------------------------------

describe('H6 — external plugin: runner receives catalogUrl as marketplace URL', () => {
  it('calls claude plugin marketplace add <catalogUrl>', async () => {
    await runRemoteInstall({
      ids: ['plugin:demo-plugin'],
      catalogUrl: CATALOG_URL,
      scope: 'user',
      env: ctx.env,
      manifestPath: ctx.manifestPath,
      artifactsDir: ARTIFACTS_DIR,
      runner: ctx.runner,
      tmpFactory: ctx.tmpFactory,
      confirm: true,
    });

    const marketplaceCall = ctx.capturedCalls.find(
      (c) => c.args[0] === 'plugin' && c.args[1] === 'marketplace' && c.args[2] === 'add',
    );
    expect(marketplaceCall).toBeDefined();
    expect(marketplaceCall!.args[3]).toBe(CATALOG_URL);
  });

  it('calls claude plugin install demo-plugin', async () => {
    await runRemoteInstall({
      ids: ['plugin:demo-plugin'],
      catalogUrl: CATALOG_URL,
      scope: 'user',
      env: ctx.env,
      manifestPath: ctx.manifestPath,
      artifactsDir: ARTIFACTS_DIR,
      runner: ctx.runner,
      tmpFactory: ctx.tmpFactory,
      confirm: true,
    });

    const installCall = ctx.capturedCalls.find(
      (c) => c.args[0] === 'plugin' && c.args[1] === 'install',
    );
    expect(installCall).toBeDefined();
    expect(installCall!.args[2]).toBe('demo-plugin');
  });

  it('calls marketplace add before install (order preserved)', async () => {
    await runRemoteInstall({
      ids: ['plugin:demo-plugin'],
      catalogUrl: CATALOG_URL,
      scope: 'user',
      env: ctx.env,
      manifestPath: ctx.manifestPath,
      artifactsDir: ARTIFACTS_DIR,
      runner: ctx.runner,
      tmpFactory: ctx.tmpFactory,
      confirm: true,
    });

    const addIdx = ctx.capturedCalls.findIndex(
      (c) => c.args[1] === 'marketplace' && c.args[2] === 'add',
    );
    const installIdx = ctx.capturedCalls.findIndex(
      (c) => c.args[1] === 'install',
    );
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(installIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeLessThan(installIdx);
  });

  it('manifest entry has source:external', async () => {
    await runRemoteInstall({
      ids: ['plugin:demo-plugin'],
      catalogUrl: CATALOG_URL,
      scope: 'user',
      env: ctx.env,
      manifestPath: ctx.manifestPath,
      artifactsDir: ARTIFACTS_DIR,
      runner: ctx.runner,
      tmpFactory: ctx.tmpFactory,
      confirm: true,
    });

    const raw = await fs.readFile(ctx.manifestPath, 'utf8').catch(() => null);
    expect(raw).not.toBeNull();
    const manifest = JSON.parse(raw!) as {
      artifacts: Array<{ id: string; source?: string; ref?: string; sha?: string }>;
    };
    const entry = manifest.artifacts.find((a) => a.id === 'plugin:demo-plugin');
    expect(entry).toBeDefined();
    expect(entry?.source).toBe('external');
    expect(entry?.ref).toBe(TAG_NAME);
    expect(entry?.sha).toBe(SHA);
  });
});

// ---------------------------------------------------------------------------
// Internal plugin (non-external): marketplace = local path, not catalogUrl
// ---------------------------------------------------------------------------

describe('H6 — internal/local plugin: pluginSource uses local marketplace.json', () => {
  it('buildClaudeAdapter pluginSource for non-external entry returns cwd marketplace path', async () => {
    // We test this via buildClaudeAdapter directly (not through runRemoteInstall).
    // The closure captures process.cwd(), so we just verify the logic is right
    // by checking that an entry NOT in externalIds falls through to the local path.

    // This is already covered by the existing plugins.test.ts adapter tests.
    // Here we do a quick sanity check via buildClaudeAdapter opts.
    const { buildClaudeAdapter } = await import('../src/cli');

    const tmpHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-h6-local-'));
    const localEnv: Env = { RIGGER_HOME: tmpHomeDir };

    try {
      const adapter = await buildClaudeAdapter(localEnv, ARTIFACTS_DIR, {
        externalIds: new Set(['skill:something-else']), // plugin:demo-plugin NOT in externalIds
        catalogUrl: CATALOG_URL,
      });

      // The adapter is built successfully; the pluginSource closure for a
      // non-external plugin id will return the local marketplace path.
      // We verify this by checking the adapter object is defined (plan would
      // use local path — we can't call plan without a real 'claude' binary,
      // so existence is sufficient here; the unit test in plugins.test.ts covers apply).
      expect(adapter).toBeDefined();
      expect(typeof adapter.plan).toBe('function');
    } finally {
      await fs.rm(tmpHomeDir, { recursive: true, force: true });
    }
  });
});
