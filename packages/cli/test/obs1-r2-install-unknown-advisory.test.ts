/**
 * obs1-plugin-reads — R2 fix (post-review finding #2): `install` surfaces the
 * unknown-ledger advisory that R2 scenario 4 requires.
 *
 * R2 scenario 4 ("layout illisible → unknown, jamais missing") requires: "AND
 * aucun plan de réinstallation n'est généré (install no-op sur cet artefact,
 * warning advisory affiché)". Before this fix, planPlugin correctly returned
 * [] on 'unknown' (no reinstall churn — see obs1-r2-ledger-truth.test.ts),
 * but an empty plan for an entry is never pushed into cmd-install's `groups`,
 * so there was no op left to carry a `warnings` array — `agent-rigger
 * install <id>` on a corrupted installed_plugins.json finished on an empty
 * plan in total silence. Only `check` (renderReport) showed the detail.
 *
 * Fixed by querying `adapter.audit` directly for entries whose plan came back
 * empty, and folding a `state === 'unknown'` report into the SAME warnings
 * channel already rendered pre-confirm (planText's "--- Warnings ---" block)
 * and returned as InstallResult.warnings — without emitting any op (still
 * literally `ops.length === 0`, so no churn, no manifest write).
 *
 * Real createClaudeAdapter + isolated RIGGER_HOME tmp dir; the real `claude`
 * binary is never invoked (no runner is even configured — the plan stays
 * empty, apply() is never reached).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { createClaudeAdapter, resolvePluginPaths } from '@agent-rigger/adapters';

import type { CatalogEntry } from '@agent-rigger/catalog';

import { runInstall } from '../src/cmd-install';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(): Promise<{ dir: string; env: Env; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-obs1-r2-install-'));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

async function writeLedgerRaw(env: Env, raw: string): Promise<void> {
  const { installedPluginsPath } = resolvePluginPaths(env);
  await fs.mkdir(path.dirname(installedPluginsPath), { recursive: true });
  await fs.writeFile(installedPluginsPath, raw, 'utf8');
}

const MARKETPLACE_NAME = 'obs1-install-marketplace';
const PLUGIN = 'obs1-install-plugin';
const PLUGIN_CATALOG_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: `plugin:${PLUGIN}`,
  nature: 'plugin',
  targets: ['claude'],
  scopes: ['user'],
};

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let manifestPath: string;

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
  manifestPath = resolveUserTargets(env).stateJson;
});

afterEach(async () => {
  await tmp.cleanup();
});

function makeAdapter() {
  return createClaudeAdapter({
    denyRef: [],
    pluginSource: (_e) => ({
      plugin: PLUGIN,
      marketplace: '/some/marketplace.json',
      marketplaceName: MARKETPLACE_NAME,
    }),
  });
}

describe('obs1-R2 (fix post-review): install surfaces the unknown-ledger advisory', () => {
  it('obs1-R2: install on an unparsable ledger reports a warning naming the entry', async () => {
    await writeLedgerRaw(env, '{ not valid json');
    const adapter = makeAdapter();

    const result = await runInstall({
      catalog: [PLUGIN_CATALOG_ENTRY],
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: [PLUGIN_CATALOG_ENTRY.id],
      confirm: true,
    });

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes(PLUGIN_CATALOG_ENTRY.id))).toBe(true);
  });

  it('obs1-R2: install on an unknown ledger stays a no-op — no plan, no manifest entry, no writes', async () => {
    await writeLedgerRaw(env, JSON.stringify({ version: 3 }));
    const adapter = makeAdapter();

    const result = await runInstall({
      catalog: [PLUGIN_CATALOG_ENTRY],
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: [PLUGIN_CATALOG_ENTRY.id],
      confirm: true,
    });

    // No churn (R2): applied stays false, nothing written — only the
    // advisory warning is new.
    expect(result.applied).toBe(false);
    expect(result.written).toHaveLength(0);
  });

  it('obs1-R2: the advisory warning is embedded in the rendered output before any confirm', async () => {
    await writeLedgerRaw(env, '{ still not valid json');
    const adapter = makeAdapter();

    const result = await runInstall({
      catalog: [PLUGIN_CATALOG_ENTRY],
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: [PLUGIN_CATALOG_ENTRY.id],
      // confirm is never even reached (up-to-date short-circuit) — proves the
      // warning surfaces regardless of user confirmation.
      confirm: false,
    });

    expect(result.output).toContain('Warnings');
    expect(result.output).toContain(PLUGIN_CATALOG_ENTRY.id);
  });

  it('obs1-R2: a healthy (present) ledger produces no advisory warning', async () => {
    // Non-regression: the new audit-on-empty-plan call must not fire a
    // warning for the ordinary "already installed" idempotent no-op.
    await writeLedgerRaw(
      env,
      JSON.stringify({
        version: 2,
        plugins: { [`${PLUGIN}@${MARKETPLACE_NAME}`]: [{ scope: 'user' }] },
      }),
    );
    const adapter = makeAdapter();

    const result = await runInstall({
      catalog: [PLUGIN_CATALOG_ENTRY],
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: [PLUGIN_CATALOG_ENTRY.id],
      confirm: true,
    });

    expect(result.warnings).toHaveLength(0);
  });
});
