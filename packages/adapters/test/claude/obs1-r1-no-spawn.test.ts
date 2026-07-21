/**
 * obs1-plugin-reads — R1: plugin READS never spawn the `claude` binary.
 *
 * The engine promises plan/audit are read-only and side-effect-free — the
 * invariant that lets `check` run without consent and the plan render before
 * confirmation. Previously every plugin read spawned `claude plugin list`
 * (ENOENT crash without the binary, and a virgin config was bootstrapped with
 * `.claude.json` + backups). These tests pin the fix: a spy runner proves ZERO
 * spawns on every read path (audit / plan / planRemove / adopt / check /
 * adoption), and the probe creates NO file on a never-initialised config dir.
 *
 * Fixtures are files only — the real `claude` binary is never invoked.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply, check, reportExitCode } from '@agent-rigger/core/engine';
import type { Env } from '@agent-rigger/core/paths';
import { resolveUserTargets } from '@agent-rigger/core/paths';

import { createClaudeAdapter } from '../../src/claude/adapter';
import {
  adoptPlugin,
  auditPlugin,
  planPlugin,
  planRemovePlugin,
  resolvePluginPaths,
} from '../../src/claude/plugins';
import type { PluginRunner } from '../../src/claude/plugins';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(): Promise<{ dir: string; env: Env; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-obs1-r1-'));
  return {
    dir,
    env: { RIGGER_HOME: dir },
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

/** True iff the path exists on disk (stat-based; no callback fs.exists). */
async function pathExists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true).catch(() => false);
}

/**
 * A spy PluginRunner that records every call AND throws — so any spawn on a read
 * path both fails the run loudly and is counted. A clean read leaves `calls`
 * empty and never triggers the throw.
 */
function makeNoSpawnRunner(): PluginRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner: PluginRunner = (command, args) => {
    calls.push([command, ...args]);
    throw new Error(`obs1-R1 violation: a read path spawned "${command} ${args.join(' ')}"`);
  };
  (runner as PluginRunner & { calls: string[][] }).calls = calls;
  return runner as PluginRunner & { calls: string[][] };
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
// R1 scenarios
// ---------------------------------------------------------------------------

describe('obs1-R1 — plugin reads never spawn', () => {
  it('obs1-R1: check renders plugin state from disk without spawning claude (binary can be absent)', async () => {
    // A present ledger key: check must report present, purely from disk.
    await writeLedger(env, LEDGER_KEY);
    const runner = makeNoSpawnRunner();
    const adapter = createClaudeAdapter({
      denyRef: [],
      pluginSource: PLUGIN_SOURCE,
      pluginRunner: runner,
    });

    const report = await check(adapter, [ENTRY], 'user', env);

    expect(report.entries[0]!.state).toBe('present');
    expect(reportExitCode(report)).toBe(0);
    // No crash, and the runner (the only path to `claude`) was never called.
    expect(runner.calls).toHaveLength(0);
  });

  it('obs1-R1: check on a virgin config reports missing without spawning and without crashing', async () => {
    const runner = makeNoSpawnRunner();
    const adapter = createClaudeAdapter({
      denyRef: [],
      pluginSource: PLUGIN_SOURCE,
      pluginRunner: runner,
    });

    const report = await check(adapter, [ENTRY], 'user', env);

    expect(report.entries[0]!.state).toBe('missing');
    expect(runner.calls).toHaveLength(0);
  });

  it('obs1-R1: adapter.plan (install) produces the plan without spawning', async () => {
    const runner = makeNoSpawnRunner();
    const adapter = createClaudeAdapter({
      denyRef: [],
      pluginSource: PLUGIN_SOURCE,
      pluginRunner: runner,
    });

    const ops = await adapter.plan(ENTRY, 'user', env);

    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('plugin-install');
    expect(runner.calls).toHaveLength(0);
  });

  it('obs1-R1: adapter.planRemove (remove) plans without spawning', async () => {
    await writeLedger(env, LEDGER_KEY);
    const runner = makeNoSpawnRunner();
    const adapter = createClaudeAdapter({
      denyRef: [],
      pluginSource: PLUGIN_SOURCE,
      pluginRunner: runner,
    });

    const ops = await adapter.planRemove(ENTRY, 'user', env);

    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('plugin-uninstall');
    expect(runner.calls).toHaveLength(0);
  });

  it('obs1-R1: the update flow (planRemove then plan on the same entry) plans without spawning', async () => {
    // Mirrors cmd-update.ts's real planning sequence for a single stale entry:
    // 1. The pre-confirm preview calls adapter.plan() to collect op warnings
    //    (cmd-update.ts step 3f) — read-only, safe to call again later (its
    //    own comment: "adapter.plan() is read-only, so calling it again
    //    inside apply() is a safe, side-effect-free duplicate").
    // 2. Post-confirm, engine.remove() calls adapter.planRemove() (then
    //    applyRemove — spawns, out of scope here: update is a remove-then-
    //    apply, and only the PLANNING half is read-only/spawn-free per R1).
    // 3. engine.apply() then calls adapter.plan() again to compute the fresh
    //    install ops.
    // Both planning calls read the SAME still-untouched ledger (neither
    // planRemove nor plan performs a write), so plan() before and after
    // planRemove() see the same 'present' state and both correctly report
    // idempotent ops — the assertion that matters is zero spawns throughout.
    await writeLedger(env, LEDGER_KEY);
    const runner = makeNoSpawnRunner();
    const adapter = createClaudeAdapter({
      denyRef: [],
      pluginSource: PLUGIN_SOURCE,
      pluginRunner: runner,
    });

    // Step 1 / step 3g equivalent: the pre-confirm plan preview.
    const previewOps = await adapter.plan(ENTRY, 'user', env);
    expect(previewOps).toHaveLength(0); // already present → idempotent no-op

    // Step 2: engine.remove()'s planning half.
    const removeOps = await adapter.planRemove(ENTRY, 'user', env);
    expect(removeOps).toHaveLength(1);
    expect(removeOps[0]!.kind).toBe('plugin-uninstall');

    // Step 3: engine.apply()'s planning half — planRemove was a read-only
    // PLAN, nothing was actually uninstalled, so the ledger is unchanged.
    const applyOps = await adapter.plan(ENTRY, 'user', env);
    expect(applyOps).toHaveLength(0);

    // The entire remove-then-apply PLANNING sequence never spawned.
    expect(runner.calls).toHaveLength(0);
  });

  it('obs1-R1: the adoption branch (install of an already-installed plugin) reads disk, zero spawn', async () => {
    // Ledger has the plugin present but the manifest does NOT → apply takes the
    // empty-plan adoption branch (adapter.plan → [], adapter.adopt reads disk).
    await writeLedger(env, LEDGER_KEY);
    const runner = makeNoSpawnRunner();
    const adapter = createClaudeAdapter({
      denyRef: [],
      pluginSource: PLUGIN_SOURCE,
      pluginRunner: runner,
    });
    const manifestPath = resolveUserTargets(env).stateJson;

    const result = await apply({ adapter, entries: [ENTRY], scope: 'user', env, manifestPath });

    expect(result.adopted).toContain(ENTRY.id);
    // Adoption spawned nothing — the plugin was already on disk.
    expect(runner.calls).toHaveLength(0);
  });

  it('obs1-R1: the probe is truly read-only on a virgin config — no file is created', async () => {
    // A never-initialised config dir: a read must NOT bootstrap any file.
    const { configDir, installedPluginsPath } = resolvePluginPaths(env);

    const report = await auditPlugin(ENTRY, env, MARKETPLACE_NAME);
    await planPlugin(ENTRY, env, PLUGIN_SOURCE);
    await planRemovePlugin(ENTRY, env, MARKETPLACE_NAME);
    await adoptPlugin(ENTRY, env, MARKETPLACE_NAME);

    expect(report.state).toBe('missing');
    // Neither the ledger file nor the config dir were created by the reads.
    expect(await pathExists(installedPluginsPath)).toBe(false);
    expect(await pathExists(configDir)).toBe(false);
  });

  it('obs1-R1: an explicit CLAUDE_CONFIG_DIR is never bootstrapped by a read', async () => {
    const configDir = path.join(tmp.dir, 'explicit-claude-config');
    const configEnv: Env = { CLAUDE_CONFIG_DIR: configDir };

    const report = await auditPlugin(ENTRY, configEnv, MARKETPLACE_NAME);

    expect(report.state).toBe('missing');
    expect(await pathExists(configDir)).toBe(false);
  });
});
