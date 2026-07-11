/**
 * doctor-R9 — claude/plugins.ts fix: marketplace resolution by reverse ledger
 * lookup on planRemove/adopt, and the enabledPlugins=false bit surfaced as
 * audit info (ADR-0025/R9, différé obs1).
 *
 * Before this fix, planRemovePlugin and adoptPlugin resolved the ledger key
 * via the exact cwd-guessed `<name>@<marketplaceName>` only (delegating to
 * auditPlugin). When the guessed marketplace name went stale — the catalog
 * re-registered the marketplace under a new name, or the plugin was
 * hand-installed under a different registry — a plugin genuinely present in
 * the ledger under a DIFFERENT (but uniquely identifiable by name) key was
 * silently reported `missing`: remove became a permanent no-op (the manifest
 * entry survives forever, `claude plugin uninstall` never runs) and adopt
 * refused forever (the plugin could never be recorded even though it is
 * demonstrably installed).
 *
 * auditPlugin's own exact-match contract is intentionally UNCHANGED (obs1-R2:
 * a mismatch there must stay `missing`, never assumed present) — these tests
 * assert planRemovePlugin/adoptPlugin diverge from it via the reverse lookup,
 * while auditPlugin itself is proven to still refuse the guess.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import type { Env } from '@agent-rigger/core/paths';

import {
  adoptPlugin,
  auditPlugin,
  planRemovePlugin,
  resolvePluginLedgerKey,
  resolvePluginPaths,
} from '../../src/claude/plugins';

async function makeTmpHome(): Promise<{ dir: string; env: Env; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-doctor-r9-claude-'));
  return {
    dir,
    env: { RIGGER_HOME: dir },
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

const PLUGIN = 'doctor-r9-plugin';
const GUESSED_MARKETPLACE = 'guessed-marketplace';
const ACTUAL_MARKETPLACE = 'actual-marketplace';
const ACTUAL_KEY = `${PLUGIN}@${ACTUAL_MARKETPLACE}`;
const ENTRY: AdapterEntry = { id: `plugin:${PLUGIN}`, nature: 'plugin', scope: 'user' };

async function writeLedger(env: Env, keys: string[]): Promise<void> {
  const { installedPluginsPath } = resolvePluginPaths(env);
  await fs.mkdir(path.dirname(installedPluginsPath), { recursive: true });
  const plugins: Record<string, unknown> = {};
  for (const key of keys) {
    plugins[key] = [{ scope: 'user', installPath: `/cache/${key}`, version: '1.0.0' }];
  }
  await fs.writeFile(
    installedPluginsPath,
    JSON.stringify({ version: 2, plugins }),
    'utf8',
  );
}

async function writeSettings(env: Env, enabledPlugins: Record<string, boolean>): Promise<void> {
  const { settingsPath } = resolvePluginPaths(env);
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify({ enabledPlugins }), 'utf8');
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

describe('doctor-R9: marketplace resolution by reverse ledger lookup', () => {
  it('doctor-R9: resolvePluginLedgerKey prefers the exact guess, falls back to a unique name match', () => {
    const keys = new Set([ACTUAL_KEY]);
    expect(resolvePluginLedgerKey(PLUGIN, keys, GUESSED_MARKETPLACE)).toBe(ACTUAL_KEY);
    expect(resolvePluginLedgerKey(PLUGIN, keys, ACTUAL_MARKETPLACE)).toBe(ACTUAL_KEY);
  });

  it('doctor-R9: resolvePluginLedgerKey refuses on genuine ambiguity (2+ candidates)', () => {
    const keys = new Set([`${PLUGIN}@one`, `${PLUGIN}@two`]);
    expect(resolvePluginLedgerKey(PLUGIN, keys, GUESSED_MARKETPLACE)).toBeUndefined();
  });

  it('doctor-R9: auditPlugin keeps exact-match-only — a stale guess stays missing', async () => {
    await writeLedger(env, [ACTUAL_KEY]);

    const report = await auditPlugin(ENTRY, env, GUESSED_MARKETPLACE);

    expect(report.state).toBe('missing');
  });

  it('doctor-R9: planRemovePlugin resolves a plugin keyed under a different marketplace (no silent no-op)', async () => {
    await writeLedger(env, [ACTUAL_KEY]);

    const ops = await planRemovePlugin(ENTRY, env, GUESSED_MARKETPLACE);

    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('plugin-uninstall');
  });

  it('doctor-R9: adoptPlugin resolves a plugin keyed under a different marketplace (no permanent refusal)', async () => {
    await writeLedger(env, [ACTUAL_KEY]);

    const adoption = await adoptPlugin(ENTRY, env, GUESSED_MARKETPLACE);

    expect(adoption).toBeDefined();
    expect(adoption?.files).toEqual([]);
  });

  it('doctor-R9: planRemovePlugin still refuses when the ledger has NO key for this plugin name', async () => {
    await writeLedger(env, ['someone-else@other']);

    const ops = await planRemovePlugin(ENTRY, env, GUESSED_MARKETPLACE);

    expect(ops).toHaveLength(0);
  });
});

describe('doctor-R9: enabledPlugins=false surfaced as audit info', () => {
  it('doctor-R9: a present-but-disabled plugin reports state present with an info detail', async () => {
    await writeLedger(env, [ACTUAL_KEY]);
    await writeSettings(env, { [ACTUAL_KEY]: false });

    const report = await auditPlugin(ENTRY, env, ACTUAL_MARKETPLACE);

    expect(report.state).toBe('present');
    expect(report.detail).toContain('disabled');
  });

  it('doctor-R9: an enabled plugin carries no disabled detail', async () => {
    await writeLedger(env, [ACTUAL_KEY]);
    await writeSettings(env, { [ACTUAL_KEY]: true });

    const report = await auditPlugin(ENTRY, env, ACTUAL_MARKETPLACE);

    expect(report.state).toBe('present');
    expect(report.detail).toBeUndefined();
  });

  it('doctor-R9: no settings.json at all carries no disabled detail (default enabled)', async () => {
    await writeLedger(env, [ACTUAL_KEY]);

    const report = await auditPlugin(ENTRY, env, ACTUAL_MARKETPLACE);

    expect(report.state).toBe('present');
    expect(report.detail).toBeUndefined();
  });
});
