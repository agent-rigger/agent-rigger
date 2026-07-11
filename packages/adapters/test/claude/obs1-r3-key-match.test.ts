/**
 * obs1-plugin-reads — R3: matching is keyed `<name>@<marketplace>`.
 *
 * The audit builds the exact ledger key from the catalog entry's plugin name and
 * its marketplace name, then matches it against installed_plugins.json. Previously
 * the stdout token-match compared a bare `<name>` against the ledger token
 * `<name>@<marketplace>` — never equal → a latent false `missing` independent of
 * the spawn (ADR-0022 OBS-1). This pins the qualified-key match.
 *
 * Fixtures fabricate the ledger on disk; the real `claude` binary is never invoked.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';

import type { Env } from '@agent-rigger/core/paths';
import { auditPlugin, pluginLedgerKey, resolvePluginPaths } from '../../src/claude/plugins';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(): Promise<{ dir: string; env: Env; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-obs1-r3-'));
  return {
    dir,
    env: { RIGGER_HOME: dir },
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

async function writeLedger(env: Env, ...keys: string[]): Promise<void> {
  const { installedPluginsPath } = resolvePluginPaths(env);
  await fs.mkdir(path.dirname(installedPluginsPath), { recursive: true });
  const plugins: Record<string, unknown> = {};
  for (const key of keys) {
    plugins[key] = [{ scope: 'user', installPath: `/c/${key}`, version: '1' }];
  }
  await fs.writeFile(installedPluginsPath, JSON.stringify({ version: 2, plugins }), 'utf8');
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
// R3 scenarios
// ---------------------------------------------------------------------------

describe('obs1-R3 — matching keyed name@marketplace', () => {
  it('obs1-R3: a simple id plugin:<name> matches the qualified ledger entry <name>@<m>', async () => {
    const marketplace = 'my-marketplace';
    const name = 'my-plugin';
    const entry: AdapterEntry = { id: `plugin:${name}`, nature: 'plugin', scope: 'user' };
    // The ledger stores the QUALIFIED key, exactly as Claude Code writes it.
    await writeLedger(env, `${name}@${marketplace}`);

    const report = await auditPlugin(entry, env, marketplace);

    // Previously a bare-name token-match could never equal `<name>@<m>` → false
    // missing. The qualified key matches → present.
    expect(report.state).toBe('present');
  });

  it('obs1-R3: pluginLedgerKey builds the exact `<name>@<marketplace>` key', () => {
    expect(pluginLedgerKey('my-plugin', 'my-marketplace')).toBe('my-plugin@my-marketplace');
  });

  it('obs1-R3: the same name under a different marketplace does not match (exact key only)', async () => {
    const name = 'my-plugin';
    const entry: AdapterEntry = { id: `plugin:${name}`, nature: 'plugin', scope: 'user' };
    await writeLedger(env, `${name}@some-other-marketplace`);

    const report = await auditPlugin(entry, env, 'my-marketplace');

    expect(report.state).toBe('missing');
  });

  it('obs1-R3: a source-qualified id (principal/plugin:<name>) still keys on the local name', async () => {
    const marketplace = 'my-marketplace';
    const name = 'my-plugin';
    const entry: AdapterEntry = { id: `principal/plugin:${name}`, nature: 'plugin', scope: 'user' };
    await writeLedger(env, `${name}@${marketplace}`);

    const report = await auditPlugin(entry, env, marketplace);

    expect(report.state).toBe('present');
  });
});
