/**
 * obs1-plugin-reads — R2 fix (post-review finding #1): planRemovePlugin on an
 * 'unknown' ledger must NEVER purge the manifest entry.
 *
 * Before this fix, planRemovePlugin returned [] for BOTH 'missing' AND
 * 'unknown' — but engine.removeInner treats an empty plan as "confirmed
 * absent from disk" (the M1a phantom-purge convergence) and drops the
 * manifest entry, with no warning for the plugin nature (only 'hook' emits
 * one on that branch). An unreadable ledger confirms NOTHING about the
 * plugin's presence — a future Claude Code layout rigger cannot parse still
 * has the plugin installed — so purging silently orphans it: the plugin
 * stays on disk but agent-rigger stops tracking it (check/remove never see
 * it again). This is the exact "churn on a healthy install" R2 already
 * forbids on the install side, reached from the remove side instead.
 *
 * Fixed by returning a leave-alone op on 'unknown' — the established R3
 * Lot 2 conservation idiom already used for present-but-unmanaged targets:
 * plannedOps.length stays non-empty (removeInner's phantom-purge branch never
 * triggers), the post-leave-alone-filter ops stay empty (no destructive
 * action), and the manifest entry survives for a later run to re-evaluate
 * once the ledger becomes readable again.
 *
 * Fixtures fabricate the ledger on disk; the real `claude` binary is never
 * spawned (a counting spy runner asserts the read path never calls it).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply, remove } from '@agent-rigger/core/engine';
import { findEntry, readManifest } from '@agent-rigger/core/manifest';
import type { Env } from '@agent-rigger/core/paths';
import { resolveUserTargets } from '@agent-rigger/core/paths';

import { createClaudeAdapter } from '../../src/claude/adapter';
import { planRemovePlugin, resolvePluginPaths } from '../../src/claude/plugins';
import type { PluginRunner } from '../../src/claude/plugins';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(): Promise<{ dir: string; env: Env; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-obs1-r2-remove-'));
  return {
    dir,
    env: { RIGGER_HOME: dir },
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

const MARKETPLACE_NAME = 'obs1-remove-marketplace';
const PLUGIN = 'obs1-remove-plugin';
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

/** Spy PluginRunner: always succeeds (exit 0), counts every invocation. */
function makeSpyRunner(): PluginRunner & { calls: number } {
  const spy = Object.assign(
    async (): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      spy.calls += 1;
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    { calls: 0 },
  );
  return spy;
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
// planRemovePlugin — unit level
// ---------------------------------------------------------------------------

describe('obs1-R2 (fix post-review): planRemovePlugin never empties its plan on unknown', () => {
  it('obs1-R2: planRemovePlugin on unknown returns a leave-alone op, never an empty plan', async () => {
    await writeLedgerRaw(env, '{ not valid json');

    const ops = await planRemovePlugin(ENTRY, env, MARKETPLACE_NAME);

    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('leave-alone');
  });

  it('obs1-R2: the leave-alone op on unknown carries an advisory warning naming the entry', async () => {
    await writeLedgerRaw(env, JSON.stringify({ version: 3 }));

    const ops = await planRemovePlugin(ENTRY, env, MARKETPLACE_NAME);
    const op = ops[0] as { kind: string; warnings: string[] };

    expect(op.warnings.length).toBeGreaterThan(0);
    expect(op.warnings[0]).toContain(ENTRY.id);
  });

  it('obs1-R2: planRemovePlugin still returns [] on a genuinely missing plugin (no ledger)', async () => {
    // Contrast case: 'missing' (confirmed absent) is unaffected by the fix —
    // it must remain a real empty plan so the phantom-purge convergence still
    // reclaims a manifest entry whose target genuinely vanished.
    const ops = await planRemovePlugin(ENTRY, env, MARKETPLACE_NAME);

    expect(ops).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// engine.remove — end-to-end
// ---------------------------------------------------------------------------

describe('obs1-R2 (fix post-review): engine.remove never purges the manifest on unknown', () => {
  it('obs1-R2: the manifest entry survives remove() when the ledger becomes unknown', async () => {
    // Seed a real manifest entry the same way a genuine install would: the
    // ledger starts absent, apply() installs via the (spy) runner, recording
    // the entry in state.json exactly as a real `agent-rigger install` would.
    const runner = makeSpyRunner();
    const adapter = createClaudeAdapter({
      denyRef: [],
      pluginRunner: runner,
      pluginSource: PLUGIN_SOURCE,
    });
    const manifestPath = resolveUserTargets(env).stateJson;

    await apply(adapter, [ENTRY], 'user', env, manifestPath);
    const afterInstall = await readManifest(manifestPath);
    expect(findEntry(afterInstall, ENTRY.id, 'user', 'claude')).toBeDefined();

    // The plugin is genuinely still installed on disk — only rigger's read of
    // the ledger goes blind, simulating a future Claude Code layout change.
    await writeLedgerRaw(env, '{ corrupted by a future Claude Code layout');

    const result = await remove(adapter, [ENTRY], 'user', env, manifestPath);

    expect(result.purged).not.toContain(ENTRY.id);
    expect(result.removed).not.toContain(ENTRY.id);

    const afterRemove = await readManifest(manifestPath);
    expect(findEntry(afterRemove, ENTRY.id, 'user', 'claude')).toBeDefined();

    // Read path only: the native `claude plugin uninstall` is never invoked
    // for an unknown ledger (R1) — only the 2 install-time calls (marketplace
    // add + install) were ever made.
    expect(runner.calls).toBe(2);
  });

  it('obs1-R2: a genuinely absent plugin is still purged from the manifest (phantom convergence intact)', async () => {
    // Non-regression: confirm the fix did not disturb the 'missing' phantom-
    // purge path (M1a) — it must still reclaim a manifest entry whose target
    // truly vanished (e.g. hand-uninstalled outside rigger).
    const runner = makeSpyRunner();
    const adapter = createClaudeAdapter({
      denyRef: [],
      pluginRunner: runner,
      pluginSource: PLUGIN_SOURCE,
    });
    const manifestPath = resolveUserTargets(env).stateJson;

    await apply(adapter, [ENTRY], 'user', env, manifestPath);

    // Simulate a hand-uninstall: the ledger file is removed entirely.
    const { installedPluginsPath } = resolvePluginPaths(env);
    await fs.rm(installedPluginsPath, { force: true });

    const result = await remove(adapter, [ENTRY], 'user', env, manifestPath);

    expect(result.purged).toContain(ENTRY.id);

    const afterRemove = await readManifest(manifestPath);
    expect(findEntry(afterRemove, ENTRY.id, 'user', 'claude')).toBeUndefined();
  });
});
