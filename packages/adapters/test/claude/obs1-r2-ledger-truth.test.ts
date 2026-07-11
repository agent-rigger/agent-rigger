/**
 * obs1-plugin-reads — R2: the on-disk probe tells the truth of the ledger.
 *
 * The audit derives state from installed_plugins.json (version: 2):
 * - present when the exact `<name>@<marketplace>` key exists (installed by rigger
 *   OR by hand; an enabled=false entry is still present — the ledger is the truth
 *   of the install, not settings.json's enabledPlugins bit);
 * - missing when the file, or the key, is absent (including plugins: {} and a
 *   virgin config);
 * - unknown (NEVER missing) when the file exists but does not parse, carries
 *   version !== 2, or has a non-object `plugins` — and unknown produces NO
 *   reinstall plan and NO check drift.
 *
 * Fixtures fabricate the ledger on disk (malformed + version-3 cases included);
 * the real `claude` binary is never invoked.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { check, reportExitCode } from '@agent-rigger/core/engine';
import type { Env } from '@agent-rigger/core/paths';

import { createClaudeAdapter } from '../../src/claude/adapter';
import { auditPlugin, planPlugin, resolvePluginPaths } from '../../src/claude/plugins';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(): Promise<{ dir: string; env: Env; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-obs1-r2-'));
  return {
    dir,
    env: { RIGGER_HOME: dir },
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

const MARKETPLACE_NAME = 'obs1-marketplace';
const PLUGIN = 'obs1-plugin';
const LEDGER_KEY = `${PLUGIN}@${MARKETPLACE_NAME}`;
const ENTRY: AdapterEntry = { id: `plugin:${PLUGIN}`, nature: 'plugin', scope: 'user' };
const PLUGIN_SOURCE = (_e: AdapterEntry) => ({
  plugin: PLUGIN,
  marketplace: '/some/marketplace.json',
  marketplaceName: MARKETPLACE_NAME,
});

/** Write the raw contents of installed_plugins.json verbatim (may be malformed). */
async function writeLedgerRaw(env: Env, raw: string): Promise<void> {
  const { installedPluginsPath } = resolvePluginPaths(env);
  await fs.mkdir(path.dirname(installedPluginsPath), { recursive: true });
  await fs.writeFile(installedPluginsPath, raw, 'utf8');
}

/** Write a version-2 ledger declaring the given keys. */
async function writeLedger(env: Env, ...keys: string[]): Promise<void> {
  const plugins: Record<string, unknown> = {};
  for (const key of keys) {
    plugins[key] = [{ scope: 'user', installPath: `/c/${key}`, version: '1' }];
  }
  await writeLedgerRaw(env, JSON.stringify({ version: 2, plugins }));
}

/** Write settings.json with an enabledPlugins bit (which the audit must ignore). */
async function writeSettings(env: Env, enabled: Record<string, boolean>): Promise<void> {
  const { settingsPath } = resolvePluginPaths(env);
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify({ enabledPlugins: enabled }), 'utf8');
}

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// R2 scenarios
// ---------------------------------------------------------------------------

describe('obs1-R2 — the probe tells the ledger truth', () => {
  it('obs1-R2: a plugin present in the ledger (even installed by hand) is present', async () => {
    // Provenance is adopt's concern, not audit's (parity with mcp): a key in the
    // ledger is present regardless of who put it there.
    await writeLedger(env, LEDGER_KEY);

    const report = await auditPlugin(ENTRY, env, MARKETPLACE_NAME);

    expect(report.state).toBe('present');
  });

  it('obs1-R2: a disabled plugin stays present (settings.json enabledPlugins is ignored)', async () => {
    await writeLedger(env, LEDGER_KEY);
    await writeSettings(env, { [LEDGER_KEY]: false });

    const report = await auditPlugin(ENTRY, env, MARKETPLACE_NAME);

    // The ledger is the truth of the install; the enabled bit is a doctor concern.
    expect(report.state).toBe('present');
  });

  it('obs1-R2: absent → missing (no file)', async () => {
    const report = await auditPlugin(ENTRY, env, MARKETPLACE_NAME);
    expect(report.state).toBe('missing');
  });

  it('obs1-R2: absent → missing (plugins: {})', async () => {
    await writeLedgerRaw(env, JSON.stringify({ version: 2, plugins: {} }));

    const report = await auditPlugin(ENTRY, env, MARKETPLACE_NAME);
    expect(report.state).toBe('missing');
  });

  it('obs1-R2: absent → missing (file present, our key absent)', async () => {
    await writeLedger(env, 'someone-else@other');

    const report = await auditPlugin(ENTRY, env, MARKETPLACE_NAME);
    expect(report.state).toBe('missing');
  });

  it('obs1-R2: invalid JSON → unknown, never missing', async () => {
    await writeLedgerRaw(env, '{ this is not valid json ');

    const report = await auditPlugin(ENTRY, env, MARKETPLACE_NAME);
    expect(report.state).toBe('unknown');
  });

  it('obs1-R2: version: 3 → unknown, never missing (no coercion)', async () => {
    await writeLedgerRaw(env, JSON.stringify({ version: 3, plugins: { [LEDGER_KEY]: [] } }));

    const report = await auditPlugin(ENTRY, env, MARKETPLACE_NAME);
    expect(report.state).toBe('unknown');
  });

  it('obs1-R2: non-object plugins → unknown, never missing', async () => {
    await writeLedgerRaw(env, JSON.stringify({ version: 2, plugins: ['not', 'an', 'object'] }));

    const report = await auditPlugin(ENTRY, env, MARKETPLACE_NAME);
    expect(report.state).toBe('unknown');
  });

  it('obs1-R2: unknown produces NO reinstall plan (install no-op — no churn)', async () => {
    await writeLedgerRaw(env, '{ corrupt');

    const ops = await planPlugin(ENTRY, env, PLUGIN_SOURCE);
    expect(ops).toHaveLength(0);
  });

  it('obs1-R2: unknown is advisory — check never exits 3 for it', async () => {
    await writeLedgerRaw(env, JSON.stringify({ version: 42 }));
    const adapter = createClaudeAdapter({
      denyRef: [],
      pluginSource: PLUGIN_SOURCE,
    });

    const report = await check(adapter, [ENTRY], 'user', env);

    expect(report.entries[0]!.state).toBe('unknown');
    expect(reportExitCode(report)).toBe(0);
  });

  it('obs1-R2: an orphan cache after native uninstall is missing (the probe never reads the cache)', async () => {
    // The cache dir survives an uninstall, but the ledger key is gone → missing.
    const { installedPluginsPath } = resolvePluginPaths(env);
    const cacheDir = path.join(
      path.dirname(installedPluginsPath),
      'cache',
      MARKETPLACE_NAME,
      PLUGIN,
    );
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, 'plugin.json'), '{}', 'utf8');
    // Ledger exists but no longer declares the key.
    await writeLedger(env, 'still-here@other');

    const report = await auditPlugin(ENTRY, env, MARKETPLACE_NAME);
    expect(report.state).toBe('missing');
  });
});
