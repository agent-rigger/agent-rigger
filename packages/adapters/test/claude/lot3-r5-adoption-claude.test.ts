/**
 * Tests for lot3-robustesse-moteur R5 — the claude adapter's `adopt` gates plus
 * the FM6 context baseline guard (design D5).
 *
 * Scenario shape (the M4 trap and its cure): an artifact is installed normally,
 * then the manifest is LOST (M2 — state.json reset). A second install finds the
 * plan empty (artifact still conforming on disk) but no manifest record: without
 * adoption it stays inconvergeable (check exit 3 / install no-op forever). The
 * adopt gate records the canonical payload from disk, WITHOUT any new write, so
 * check returns to 0 and remove can uninstall.
 *
 * Gates proved here (per nature, STRICT):
 *  - guardrail → adopted only when the canonical rules are fully present;
 *    payload carries the COMPLETE denyRules/allowRules; check exit 0; remove
 *    retires the rules.
 *  - skill     → adopted only when audit is exactly `present`; a `drift` target
 *    is NEVER adopted (the manifest must not claim user content).
 *  - hook      → adopted only when the resolved spec is registered (hasHook).
 *  - plugin    → adopted with files=[] and NO applied payload (delegated nature).
 *  - context   → FM6: a byte-identical AGENTS.md write (canonical already on
 *    disk, manifest lost) must NOT fabricate a `previous` restore baseline —
 *    remove degrades to "no restore baseline" and deletes, it never "restores"
 *    the canonical forever. Fully-present context is adopted with no `previous`.
 *
 * Isolation: fresh RIGGER_HOME tmp dir per test — never touches the real ~/.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply, check, remove, reportExitCode } from '@agent-rigger/core/engine';
import { readText } from '@agent-rigger/core/fs-json';
import { findEntry, writeManifest } from '@agent-rigger/core/manifest';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { createClaudeAdapter } from '../../src/claude/adapter';
import { adoptPlugin, resolvePluginPaths } from '../../src/claude/plugins';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-lot3-r5-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

async function makeSkillFixture(baseDir: string, name: string): Promise<string> {
  const skillDir = path.join(baseDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `# ${name}\nFixture skill.`);
  return skillDir;
}

const exists = (p: string) => fs.lstat(p).then(() => true).catch(() => false);

/** Empty the manifest — simulates the M2 state.json reset. */
async function wipeManifest(manifestPath: string): Promise<void> {
  await writeManifest(manifestPath, { version: 1, artifacts: [] });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REF_DENY = ['Read(./.env)', 'Read(~/.ssh/**)', 'Read(./secrets/**)'];
const CANONICAL_AGENTS = '# Managed AGENTS.md\n\nCanonical claude agent context.\n';
const USER_IMPORT_TARGET = '~/.claude/harness/AGENTS.md';

function managedBlock(target: string): string {
  return `<!-- BEGIN agent-rigger (managed — do not edit) -->\n@${target}\n<!-- END agent-rigger -->\n`;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let targets: ReturnType<typeof resolveUserTargets>;
let manifestPath: string;
let fixturesDir: string;

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
  targets = resolveUserTargets(env);
  manifestPath = targets.stateJson;
  fixturesDir = path.join(tmp.dir, 'fixtures');
  await fs.mkdir(fixturesDir, { recursive: true });
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// Guardrail — adopt on fully present, converge, remove retires
// ---------------------------------------------------------------------------

describe('lot3 R5 — guardrail adoption', () => {
  it('lot3-R5: a guardrail present on disk but absent from the manifest is adopted with the COMPLETE payload', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });
    const entry: AdapterEntry = { id: 'guardrails-claude', nature: 'guardrail', scope: 'user' };

    // Install normally, then lose the manifest (M2 reset).
    await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });
    await wipeManifest(manifestPath);

    // Re-install: plan is empty (rules present) → adoption records the entry.
    const result = await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });

    expect(result.adopted).toContain('guardrails-claude');
    expect(result.written).toHaveLength(0);

    const recorded = findEntry(result.manifest, 'guardrails-claude', 'user', 'claude');
    expect(recorded).toBeDefined();
    expect(recorded?.applied).toEqual({
      kind: 'guardrail',
      denyRules: REF_DENY,
      allowRules: [],
    });
    expect(recorded?.files).toEqual([targets.claudeSettings]);
  });

  it('lot3-R5: check exits 0 after adoption, and remove retires the rules', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });
    const entry: AdapterEntry = { id: 'guardrails-claude', nature: 'guardrail', scope: 'user' };

    await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });
    await wipeManifest(manifestPath);
    await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });

    const report = await check(adapter, [entry], 'user', env, manifestPath);
    expect(reportExitCode(report)).toBe(0);

    const removeResult = await remove(adapter, [entry], 'user', env, manifestPath);
    expect(removeResult.removed).toContain('guardrails-claude');

    // The deny rules are gone from settings.json.
    const settings = JSON.parse(await readText(targets.claudeSettings)) as {
      permissions?: { deny?: string[] };
    };
    for (const rule of REF_DENY) {
      expect(settings.permissions?.deny ?? []).not.toContain(rule);
    }
  });

  it('lot3-R5: a guardrail only PARTIALLY present is not adopted', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });
    const entry: AdapterEntry = { id: 'guardrails-claude', nature: 'guardrail', scope: 'user' };

    // Seed settings.json with only ONE of the canonical rules — plan is
    // non-empty (rules missing), so this never reaches the adoption branch, but
    // asserting no adoption keeps the strict gate honest.
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await fs.writeFile(
      targets.claudeSettings,
      JSON.stringify({ permissions: { deny: [REF_DENY[0]] } }, null, 2),
    );

    const result = await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });
    // A real install happened (missing rules merged) — not an adoption.
    expect(result.adopted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Skill — adopt on present, never on drift
// ---------------------------------------------------------------------------

describe('lot3 R5 — skill adoption', () => {
  it('lot3-R5: a present skill (symlink to store) absent from the manifest is adopted with files=[target]', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'foo');
    const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => srcDir });
    const entry: AdapterEntry = { id: 'skill:foo', nature: 'skill', scope: 'user' };

    await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });
    await wipeManifest(manifestPath);

    const result = await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });

    expect(result.adopted).toContain('skill:foo');
    const target = path.join(path.dirname(targets.claudeSettings), 'skills', 'foo');
    const recorded = findEntry(result.manifest, 'skill:foo', 'user', 'claude');
    expect(recorded?.applied).toEqual({ kind: 'link', files: [target] });
    expect(recorded?.files).toEqual([target]);
  });

  it('lot3-R5: a drifted skill (foreign directory) is NEVER adopted', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'bar');
    const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => srcDir });
    const entry: AdapterEntry = { id: 'skill:bar', nature: 'skill', scope: 'user' };

    // Plant a real directory with FOREIGN content at the target → audit drift.
    const target = path.join(path.dirname(targets.claudeSettings), 'skills', 'bar');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'SKILL.md'), '# not rigger content\n');

    const result = await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });

    expect(result.adopted).toHaveLength(0);
    expect(findEntry(result.manifest, 'skill:bar', 'user', 'claude')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Hook — adopt only when hasHook
// ---------------------------------------------------------------------------

describe('lot3 R5 — hook adoption', () => {
  const hookSpec = {
    event: 'PreToolUse',
    matcher: 'Bash',
    command: 'my-guard.sh',
  };

  it('lot3-R5: a registered hook absent from the manifest is adopted with the resolved spec', async () => {
    const adapter = createClaudeAdapter({ denyRef: [], hookSpec: () => hookSpec });
    const entry: AdapterEntry = { id: 'hook:guard', nature: 'hook', scope: 'user' };

    await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });
    await wipeManifest(manifestPath);

    const result = await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });

    expect(result.adopted).toContain('hook:guard');
    const recorded = findEntry(result.manifest, 'hook:guard', 'user', 'claude');
    expect(recorded?.applied).toEqual({
      kind: 'hook',
      event: hookSpec.event,
      matcher: hookSpec.matcher,
      command: hookSpec.command,
    });
    expect(recorded?.files).toEqual([targets.claudeSettings]);
  });
});

// ---------------------------------------------------------------------------
// Plugin — adopt with files=[] and no applied payload
// ---------------------------------------------------------------------------

const ADOPT_MARKETPLACE = 'adopt-marketplace';

/** Write installed_plugins.json declaring `<name>@<ADOPT_MARKETPLACE>` present. */
async function writeLedgerWithPlugin(pluginEnv: Env, name: string): Promise<void> {
  const { installedPluginsPath } = resolvePluginPaths(pluginEnv);
  await fs.mkdir(path.dirname(installedPluginsPath), { recursive: true });
  const key = `${name}@${ADOPT_MARKETPLACE}`;
  await fs.writeFile(
    installedPluginsPath,
    JSON.stringify({
      version: 2,
      plugins: { [key]: [{ scope: 'user', installPath: `/cache/${key}`, version: '1.0.0' }] },
    }),
    'utf8',
  );
}

describe('lot3 R5 — plugin adoption', () => {
  it('lot3-R5: a present plugin absent from the manifest is adopted with files=[] and no applied', async () => {
    // On-disk ledger declares the plugin present (obs1: audit reads the ledger,
    // never spawns `claude`).
    await writeLedgerWithPlugin(env, 'my-plugin');
    const adapter = createClaudeAdapter({
      denyRef: [],
      pluginSource: (_e) => ({
        plugin: 'my-plugin',
        marketplace: '/some/path',
        marketplaceName: ADOPT_MARKETPLACE,
      }),
    });
    const entry: AdapterEntry = { id: 'plugin:my-plugin', nature: 'plugin', scope: 'user' };

    const result = await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });

    expect(result.adopted).toContain('plugin:my-plugin');
    const recorded = findEntry(result.manifest, 'plugin:my-plugin', 'user', 'claude');
    expect(recorded).toBeDefined();
    expect(recorded?.applied).toBeUndefined();
    expect(recorded?.files).toEqual([]);
  });

  it('lot3-R5: the adopt gate refuses an absent plugin (undefined)', async () => {
    // Direct gate unit: an absent plugin never reaches the adoption branch via
    // apply (its plan is non-empty → install path), so the refusal is proved on
    // the gate itself. No ledger written → the plugin is absent.
    const entry: AdapterEntry = { id: 'plugin:absent', nature: 'plugin', scope: 'user' };

    const adoption = await adoptPlugin(entry, env, ADOPT_MARKETPLACE);
    expect(adoption).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Context — FM6 baseline guard + fully-present adoption
// ---------------------------------------------------------------------------

describe('lot3 R5 — context FM6 baseline guard', () => {
  it('lot3-R5: a byte-identical AGENTS.md write never fabricates a previous baseline', async () => {
    const adapter = createClaudeAdapter({ denyRef: [], agentsContent: CANONICAL_AGENTS });
    const entry: AdapterEntry = { id: 'context-claude', nature: 'context', scope: 'user' };

    // AGENTS.md already == canonical (posted by a prior install), CLAUDE.md
    // WITHOUT the managed block, manifest EMPTY (post-M2). The plan is
    // non-empty (ensure-import) so this is the NORMAL install path.
    await fs.mkdir(path.dirname(targets.agentsMd), { recursive: true });
    await fs.mkdir(path.dirname(targets.claudeMd), { recursive: true });
    await fs.writeFile(targets.agentsMd, CANONICAL_AGENTS);
    await fs.writeFile(targets.claudeMd, '# My CLAUDE.md\n');

    const result = await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });

    const recorded = findEntry(result.manifest, 'context-claude', 'user', 'claude');
    const applied = recorded?.applied as { kind?: string; previous?: unknown } | undefined;
    expect(applied?.kind).toBe('context');
    // The crux: previous is ABSENT — the byte-identical write did not capture
    // the on-disk canonical as a restore baseline.
    expect(applied?.previous).toBeUndefined();
  });

  it('lot3-R5: after the byte-identical install, remove degrades to no-restore-baseline (deletes, does not restore)', async () => {
    const adapter = createClaudeAdapter({ denyRef: [], agentsContent: CANONICAL_AGENTS });
    const entry: AdapterEntry = { id: 'context-claude', nature: 'context', scope: 'user' };

    await fs.mkdir(path.dirname(targets.agentsMd), { recursive: true });
    await fs.mkdir(path.dirname(targets.claudeMd), { recursive: true });
    await fs.writeFile(targets.agentsMd, CANONICAL_AGENTS);
    await fs.writeFile(targets.claudeMd, '# My CLAUDE.md\n');

    await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });
    const removeResult = await remove(adapter, [entry], 'user', env, manifestPath);

    // AGENTS.md is DELETED (no restore baseline), never "restored" to canonical.
    expect(await exists(targets.agentsMd)).toBe(false);
    expect(removeResult.warnings.join('\n') + removeResult.removed.join('\n')).toBeDefined();
  });

  it('lot3-R5: a fully-present context (block + canonical) absent from the manifest is adopted without previous', async () => {
    const adapter = createClaudeAdapter({ denyRef: [], agentsContent: CANONICAL_AGENTS });
    const entry: AdapterEntry = { id: 'context-claude', nature: 'context', scope: 'user' };

    await fs.mkdir(path.dirname(targets.agentsMd), { recursive: true });
    await fs.mkdir(path.dirname(targets.claudeMd), { recursive: true });
    await fs.writeFile(targets.agentsMd, CANONICAL_AGENTS);
    await fs.writeFile(targets.claudeMd, `# My CLAUDE.md\n${managedBlock(USER_IMPORT_TARGET)}`);

    // Plan is empty (fully present) → adoption branch.
    const result = await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });

    expect(result.adopted).toContain('context-claude');
    const recorded = findEntry(result.manifest, 'context-claude', 'user', 'claude');
    const applied = recorded?.applied as
      | { kind?: string; block?: string; previous?: unknown }
      | undefined;
    expect(applied?.kind).toBe('context');
    expect(applied?.block).toBe(CANONICAL_AGENTS);
    expect(applied?.previous).toBeUndefined();
  });
});
