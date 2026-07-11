/**
 * obs1-plugin-reads — R3 fix (post-review Low A): the cwd-guessed
 * marketplaceName is corrected against the REAL ledger keys before it feeds
 * the exact `<name>@<marketplace>` match (R3).
 *
 * buildClaudeAdapter (adapter-builder.ts) guesses marketplaceName from
 * `<process.cwd()>/.claude-plugin/marketplace.json`, falling back to
 * 'agent-rigger'. That guess is only correct when the cwd IS the rig's own
 * checkout. From a project cwd with no marketplace.json (or a foreign one),
 * the guess degraded to 'agent-rigger', which never matched a plugin
 * genuinely installed under a different marketplace name — a false `missing`
 * (exit 3 on a healthy install), independent of the exact-key-match R3 already
 * pinned in obs1-r3-key-match.test.ts (which exercises auditPlugin directly
 * with an already-correct marketplaceName, not this cwd-guessing layer).
 *
 * resolvePluginLedgerMarketplace (adapter-builder.ts) closes this gap: when
 * the guessed key misses, it searches installed_plugins.json for any OTHER
 * key sharing the plugin's name. Exactly one alternate → corrected and used
 * (present). More than one → ambiguous, never guessed → reported `unknown`
 * with a detail (parity with R2's ledger-parse-failure honesty).
 *
 * Fixtures are files only; the real `claude` binary is never invoked (no
 * pluginRunner is even configured — these scenarios never reach apply()).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolvePluginPaths } from '@agent-rigger/adapters';
import type { AdapterEntry } from '@agent-rigger/core/adapter';
import type { Env } from '@agent-rigger/core/paths';

import { buildClaudeAdapter } from '../src/adapter-builder';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(): Promise<{ dir: string; env: Env; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-obs1-r3-cwd-'));
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

const PLUGIN = 'obs1-cwd-plugin';
const ENTRY: AdapterEntry = { id: `plugin:${PLUGIN}`, nature: 'plugin', scope: 'user' };

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let cwdDir: string;
const originalCwd = process.cwd();

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
  // A project cwd with NO .claude-plugin/marketplace.json — the fallback
  // guess degrades to 'agent-rigger', which is the bug this fix corrects.
  cwdDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-obs1-r3-project-'));
  process.chdir(cwdDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await tmp.cleanup();
  await fs.rm(cwdDir, { recursive: true, force: true });
});

describe('obs1-R3 (fix Low A): cross-cwd marketplaceName resolution', () => {
  it(
    'obs1-R3: ledger has <name>@foreign, cwd carries no marketplace.json → present, not missing',
    async () => {
      // The plugin is genuinely installed, but under a marketplace name the
      // cwd guess ('agent-rigger') never mentions.
      await writeLedger(env, `${PLUGIN}@foreign-marketplace`);

      const adapter = await buildClaudeAdapter(env);
      const report = await adapter.audit(ENTRY, 'user', env);

      expect(report.state).toBe('present');
    },
  );

  it(
    'obs1-R3: plan() is idempotent (empty) once the cross-cwd marketplaceName is resolved',
    async () => {
      await writeLedger(env, `${PLUGIN}@foreign-marketplace`);

      const adapter = await buildClaudeAdapter(env);
      const ops = await adapter.plan(ENTRY, 'user', env);

      // Present (via the corrected marketplaceName) → no reinstall proposed.
      expect(ops).toHaveLength(0);
    },
  );

  it(
    'obs1-R3: two marketplaces installing the same plugin name → unknown, never guessed',
    async () => {
      await writeLedger(env, `${PLUGIN}@marketplace-a`, `${PLUGIN}@marketplace-b`);

      const adapter = await buildClaudeAdapter(env);
      const report = await adapter.audit(ENTRY, 'user', env);

      expect(report.state).toBe('unknown');
      expect(report.detail).toContain(PLUGIN);
      expect(report.detail).toContain('marketplace-a');
      expect(report.detail).toContain('marketplace-b');
    },
  );

  it(
    'obs1-R3: the ambiguous case proposes no install (no churn, parity with R2)',
    async () => {
      await writeLedger(env, `${PLUGIN}@marketplace-a`, `${PLUGIN}@marketplace-b`);

      const adapter = await buildClaudeAdapter(env);
      const ops = await adapter.plan(ENTRY, 'user', env);

      expect(ops).toHaveLength(0);
    },
  );

  it(
    'obs1-R3: a plugin genuinely absent from every marketplace still reports missing',
    async () => {
      // Non-regression: an unrelated plugin in the ledger must not create a
      // false alternate match.
      await writeLedger(env, 'some-other-plugin@marketplace-a');

      const adapter = await buildClaudeAdapter(env);
      const report = await adapter.audit(ENTRY, 'user', env);

      expect(report.state).toBe('missing');
    },
  );

  it(
    'obs1-R3: the fast path is unaffected — cwd IS the catalogue, exact key matches directly',
    async () => {
      // cwd carries its own marketplace.json (the common/local case) — the
      // guess hits the exact key on the FIRST ledger read, never reaching
      // the by-name search.
      await fs.mkdir(path.join(cwdDir, '.claude-plugin'), { recursive: true });
      await fs.writeFile(
        path.join(cwdDir, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({ name: 'my-local-catalogue' }),
        'utf8',
      );
      await writeLedger(env, `${PLUGIN}@my-local-catalogue`);

      const adapter = await buildClaudeAdapter(env);
      const report = await adapter.audit(ENTRY, 'user', env);

      expect(report.state).toBe('present');
    },
  );
});
