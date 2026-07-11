/**
 * Tests for planRemove / applyRemove on the ClaudeAdapter — TDD, written before implementation.
 *
 * Covers per-nature planRemove (read-only, returns correct RemovalOp or []) and
 * applyRemove dispatch per op kind, plus end-to-end via engine.remove().
 *
 * Isolation: each test uses a fresh RIGGER_HOME tmp dir. Never touches the real ~/.
 *
 * Tested natures / op kinds:
 *   guardrail  → remove-deny
 *   context    → delete-file + remove-block
 *   skill      → unlink
 *   agent      → unlink
 *   plugin     → plugin-uninstall
 *
 * End-to-end:
 *   install → engine.remove → files gone, manifest entry removed, backup created.
 *   2nd remove (not installed) → no-op.
 *   check after remove → missing (exit 3).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply, check, remove, reportExitCode } from '@agent-rigger/core/engine';
import { readJson, readText, writeJson, writeText } from '@agent-rigger/core/fs-json';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { createClaudeAdapter } from '../../src/claude/adapter';
import { resolvePluginPaths } from '../../src/claude/plugins';
import type { PluginRunner } from '../../src/claude/plugins';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-remove-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** Create a minimal skill fixture directory with a SKILL.md file. */
async function makeSkillFixture(baseDir: string, name: string): Promise<string> {
  const skillDir = path.join(baseDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `# ${name}\nFixture skill.`);
  return skillDir;
}

/** Create a minimal agent .md fixture file. */
async function makeAgentFixture(baseDir: string, name: string): Promise<string> {
  const agentFile = path.join(baseDir, `${name}.md`);
  await fs.mkdir(baseDir, { recursive: true });
  await fs.writeFile(agentFile, `# Agent: ${name}\nFixture agent.`);
  return agentFile;
}

// ---------------------------------------------------------------------------
// Spy plugin runner
// ---------------------------------------------------------------------------

interface RunnerCall {
  command: string;
  args: string[];
}

function makeSpyPluginRunner(opts: {
  listStdout?: string;
  applyExitCode?: number;
  applyStderr?: string;
} = {}): PluginRunner & { calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];

  function runner(
    command: string,
    args: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    calls.push({ command, args });
    if (args.includes('list')) {
      return Promise.resolve({ exitCode: 0, stdout: opts.listStdout ?? '', stderr: '' });
    }
    return Promise.resolve({
      exitCode: opts.applyExitCode ?? 0,
      stdout: '',
      stderr: opts.applyStderr ?? '',
    });
  }

  (runner as PluginRunner & { calls: RunnerCall[] }).calls = calls;
  return runner as PluginRunner & { calls: RunnerCall[] };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REF_DENY = ['Read(./.env)', 'Read(~/.ssh/**)', 'Read(./secrets/**)'];
const AGENTS_CONTENT = '# Managed AGENTS.md\nContent for testing.\n';
const PLUGIN_NAME = 'my-remove-plugin';
const MARKETPLACE_NAME = 'remove-marketplace';
/** The exact on-disk ledger key the plugin audit matches for the remove tests. */
const PLUGIN_LEDGER_KEY = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

/** Write installed_plugins.json declaring the given keys under <RIGGER_HOME>/.claude. */
async function writeLedger(pluginEnv: Env, ...keys: string[]): Promise<void> {
  const { installedPluginsPath } = resolvePluginPaths(pluginEnv);
  await fs.mkdir(path.dirname(installedPluginsPath), { recursive: true });
  const plugins: Record<string, unknown> = {};
  for (const key of keys) {
    plugins[key] = [{ scope: 'user', installPath: `/cache/${key}`, version: '1.0.0' }];
  }
  await fs.writeFile(
    installedPluginsPath,
    JSON.stringify({ version: 2, plugins }, null, 2),
    'utf8',
  );
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
  tmp = await makeTmpHome('rigger-remove-');
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
// planRemove — guardrail
// ---------------------------------------------------------------------------

describe('planRemove — guardrail', () => {
  it('returns [] when guardrail is not installed', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });
    const entry: AdapterEntry = { id: 'guardrails-claude', nature: 'guardrail', scope: 'user' };

    const ops = await adapter.planRemove(entry, 'user', env);

    expect(ops).toHaveLength(0);
  });

  it('returns one remove-deny op when guardrail is installed', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });
    const entry: AdapterEntry = { id: 'guardrails-claude', nature: 'guardrail', scope: 'user' };

    // Install: write the canonical deny rules into settings.json
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, { permissions: { deny: REF_DENY } });

    const ops = await adapter.planRemove(entry, 'user', env);

    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('remove-deny');
  });

  it('remove-deny op carries the correct path and rules', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });
    const entry: AdapterEntry = { id: 'guardrails-claude', nature: 'guardrail', scope: 'user' };

    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, { permissions: { deny: REF_DENY } });

    const ops = await adapter.planRemove(entry, 'user', env);
    const op = ops[0] as { kind: string; path: string; rules: string[] };

    expect(op.path).toBe(targets.claudeSettings);
    expect(op.rules).toEqual(REF_DENY);
  });
});

// ---------------------------------------------------------------------------
// applyRemove — remove-deny
// ---------------------------------------------------------------------------

describe('applyRemove — remove-deny', () => {
  it('removes managed deny rules from settings.json', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });

    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, { permissions: { deny: REF_DENY } });

    const ops = [{ kind: 'remove-deny' as const, path: targets.claudeSettings, rules: REF_DENY }];
    await adapter.applyRemove(ops, env);

    const result = await readJson(targets.claudeSettings);
    const deny = ((result['permissions'] as Record<string, unknown>)['deny']) as string[];
    for (const rule of REF_DENY) {
      expect(deny).not.toContain(rule);
    }
  });

  it('preserves user deny rules that are not in ref', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });

    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      permissions: { deny: [...REF_DENY, 'Read(./user-custom/**)'] },
    });

    const ops = [{ kind: 'remove-deny' as const, path: targets.claudeSettings, rules: REF_DENY }];
    await adapter.applyRemove(ops, env);

    const result = await readJson(targets.claudeSettings);
    const deny = ((result['permissions'] as Record<string, unknown>)['deny']) as string[];
    expect(deny).toContain('Read(./user-custom/**)');
    for (const rule of REF_DENY) {
      expect(deny).not.toContain(rule);
    }
  });

  it('preserves other top-level keys in settings.json', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });

    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      model: 'claude-sonnet',
      theme: 'dark',
      permissions: { deny: REF_DENY, allowedTools: ['bash'] },
    });

    const ops = [{ kind: 'remove-deny' as const, path: targets.claudeSettings, rules: REF_DENY }];
    await adapter.applyRemove(ops, env);

    const result = await readJson(targets.claudeSettings);
    expect(result['model']).toBe('claude-sonnet');
    expect(result['theme']).toBe('dark');
    const perms = result['permissions'] as Record<string, unknown>;
    expect(perms['allowedTools'] as string[]).toContain('bash');
  });

  it('is idempotent: applying remove-deny twice yields same result', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });

    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, { permissions: { deny: REF_DENY } });

    const ops = [{ kind: 'remove-deny' as const, path: targets.claudeSettings, rules: REF_DENY }];
    await adapter.applyRemove(ops, env);
    await adapter.applyRemove(ops, env);

    const result = await readJson(targets.claudeSettings);
    const deny = ((result['permissions'] as Record<string, unknown>)['deny']) as string[];
    for (const rule of REF_DENY) {
      expect(deny).not.toContain(rule);
    }
  });
});

// ---------------------------------------------------------------------------
// planRemove — context
// ---------------------------------------------------------------------------

describe('planRemove — context', () => {
  it('returns [] when context is not installed', async () => {
    const adapter = createClaudeAdapter({ denyRef: [], agentsContent: AGENTS_CONTENT });
    const entry: AdapterEntry = { id: 'context-claude', nature: 'context', scope: 'user' };

    const ops = await adapter.planRemove(entry, 'user', env);

    expect(ops).toHaveLength(0);
  });

  it('returns delete-file + remove-block ops when context is installed', async () => {
    const adapter = createClaudeAdapter({ denyRef: [], agentsContent: AGENTS_CONTENT });
    const entry: AdapterEntry = { id: 'context-claude', nature: 'context', scope: 'user' };

    // Install context: write AGENTS.md and managed block in CLAUDE.md
    await fs.mkdir(path.dirname(targets.agentsMd), { recursive: true });
    await writeText(targets.agentsMd, AGENTS_CONTENT);
    await fs.mkdir(path.dirname(targets.claudeMd), { recursive: true });
    await writeText(
      targets.claudeMd,
      '# My config\n\n<!-- BEGIN agent-rigger (managed — do not edit) -->\n@~/.claude/harness/AGENTS.md\n<!-- END agent-rigger -->\n',
    );

    const ops = await adapter.planRemove(entry, 'user', env);

    expect(ops).toHaveLength(2);
    const kinds = ops.map((o) => o.kind);
    expect(kinds).toContain('delete-file');
    expect(kinds).toContain('remove-block');
  });

  it('delete-file op targets the agentsMd path', async () => {
    const adapter = createClaudeAdapter({ denyRef: [], agentsContent: AGENTS_CONTENT });
    const entry: AdapterEntry = { id: 'context-claude', nature: 'context', scope: 'user' };

    await fs.mkdir(path.dirname(targets.agentsMd), { recursive: true });
    await writeText(targets.agentsMd, AGENTS_CONTENT);
    await fs.mkdir(path.dirname(targets.claudeMd), { recursive: true });
    await writeText(
      targets.claudeMd,
      '<!-- BEGIN agent-rigger (managed — do not edit) -->\n@~/.claude/harness/AGENTS.md\n<!-- END agent-rigger -->\n',
    );

    const ops = await adapter.planRemove(entry, 'user', env);
    const deleteOp = ops.find((o) => o.kind === 'delete-file') as
      | { kind: string; path: string }
      | undefined;

    expect(deleteOp).toBeDefined();
    expect(deleteOp!.path).toBe(targets.agentsMd);
  });

  it('remove-block op targets the claudeMd path', async () => {
    const adapter = createClaudeAdapter({ denyRef: [], agentsContent: AGENTS_CONTENT });
    const entry: AdapterEntry = { id: 'context-claude', nature: 'context', scope: 'user' };

    await fs.mkdir(path.dirname(targets.agentsMd), { recursive: true });
    await writeText(targets.agentsMd, AGENTS_CONTENT);
    await fs.mkdir(path.dirname(targets.claudeMd), { recursive: true });
    await writeText(
      targets.claudeMd,
      '<!-- BEGIN agent-rigger (managed — do not edit) -->\n@~/.claude/harness/AGENTS.md\n<!-- END agent-rigger -->\n',
    );

    const ops = await adapter.planRemove(entry, 'user', env);
    const blockOp = ops.find((o) => o.kind === 'remove-block') as
      | { kind: string; path: string }
      | undefined;

    expect(blockOp).toBeDefined();
    expect(blockOp!.path).toBe(targets.claudeMd);
  });
});

// ---------------------------------------------------------------------------
// applyRemove — delete-file + remove-block
// ---------------------------------------------------------------------------

describe('applyRemove — context ops', () => {
  it('delete-file removes the AGENTS.md file', async () => {
    const adapter = createClaudeAdapter({ denyRef: [], agentsContent: AGENTS_CONTENT });

    await fs.mkdir(path.dirname(targets.agentsMd), { recursive: true });
    await writeText(targets.agentsMd, AGENTS_CONTENT);

    await adapter.applyRemove([{ kind: 'delete-file', path: targets.agentsMd }], env);

    const exists = await fs.lstat(targets.agentsMd).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it('delete-file is tolerant when the file does not exist (force:true)', async () => {
    const adapter = createClaudeAdapter({ denyRef: [], agentsContent: AGENTS_CONTENT });

    // Must not throw even when file is absent
    await expect(
      adapter.applyRemove(
        [{ kind: 'delete-file', path: path.join(tmp.dir, 'nonexistent.md') }],
        env,
      ),
    ).resolves.toBeUndefined();
  });

  it('remove-block removes the managed import block from CLAUDE.md', async () => {
    const adapter = createClaudeAdapter({ denyRef: [], agentsContent: AGENTS_CONTENT });

    const userContent = '# My existing config\n\nSome text here.\n';
    await fs.mkdir(path.dirname(targets.claudeMd), { recursive: true });
    await writeText(
      targets.claudeMd,
      userContent
        + '\n\n<!-- BEGIN agent-rigger (managed — do not edit) -->\n@~/.claude/harness/AGENTS.md\n<!-- END agent-rigger -->\n',
    );

    await adapter.applyRemove([{ kind: 'remove-block', path: targets.claudeMd }], env);

    const result = await readText(targets.claudeMd);
    expect(result).not.toContain('<!-- BEGIN agent-rigger (managed — do not edit) -->');
    expect(result).not.toContain('<!-- END agent-rigger -->');
  });

  it('remove-block preserves user content outside the managed block', async () => {
    const adapter = createClaudeAdapter({ denyRef: [], agentsContent: AGENTS_CONTENT });

    await fs.mkdir(path.dirname(targets.claudeMd), { recursive: true });
    await writeText(
      targets.claudeMd,
      '# My existing config\n\n@OTHER.md\n\n<!-- BEGIN agent-rigger (managed — do not edit) -->\n@~/.claude/harness/AGENTS.md\n<!-- END agent-rigger -->\n',
    );

    await adapter.applyRemove([{ kind: 'remove-block', path: targets.claudeMd }], env);

    const result = await readText(targets.claudeMd);
    expect(result).toContain('# My existing config');
    expect(result).toContain('@OTHER.md');
  });
});

// ---------------------------------------------------------------------------
// planRemove — skill
// ---------------------------------------------------------------------------

describe('planRemove — skill', () => {
  it('returns [] when skill is not installed', async () => {
    const skillSource = (e: AdapterEntry) => path.join(fixturesDir, e.id);
    const adapter = createClaudeAdapter({ denyRef: [], skillSource });
    const entry: AdapterEntry = { id: 'skill:my-skill', nature: 'skill', scope: 'user' };

    const ops = await adapter.planRemove(entry, 'user', env);

    expect(ops).toHaveLength(0);
  });

  it('returns one unlink op when skill is installed', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'my-skill');
    const skillSource = (_e: AdapterEntry) => srcDir;
    const adapter = createClaudeAdapter({ denyRef: [], skillSource });
    const entry: AdapterEntry = { id: 'skill:my-skill', nature: 'skill', scope: 'user' };

    // Install the skill first
    const installOps = await adapter.plan(entry, 'user', env);
    await adapter.apply(installOps, env);

    const removeOps = await adapter.planRemove(entry, 'user', env);

    expect(removeOps).toHaveLength(1);
    expect(removeOps[0]!.kind).toBe('unlink');
  });

  it('unlink op carries correct target and store paths', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'my-skill');
    const skillSource = (_e: AdapterEntry) => srcDir;
    const adapter = createClaudeAdapter({ denyRef: [], skillSource });
    const entry: AdapterEntry = { id: 'skill:my-skill', nature: 'skill', scope: 'user' };

    const installOps = await adapter.plan(entry, 'user', env);
    await adapter.apply(installOps, env);

    const removeOps = await adapter.planRemove(entry, 'user', env);
    const op = removeOps[0] as { kind: string; target: string; store: string };

    const expectedTarget = path.join(path.dirname(targets.claudeSettings), 'skills', 'my-skill');
    const expectedStore = path.join(targets.skillsDir, 'my-skill');
    expect(op.target).toBe(expectedTarget);
    expect(op.store).toBe(expectedStore);
  });
});

// ---------------------------------------------------------------------------
// applyRemove — unlink (skill)
// ---------------------------------------------------------------------------

describe('applyRemove — unlink (skill)', () => {
  it('removes target and store when skill is unlinked', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'rm-skill');
    const skillSource = (_e: AdapterEntry) => srcDir;
    const adapter = createClaudeAdapter({ denyRef: [], skillSource });
    const entry: AdapterEntry = { id: 'skill:rm-skill', nature: 'skill', scope: 'user' };

    const installOps = await adapter.plan(entry, 'user', env);
    await adapter.apply(installOps, env);

    const removeOps = await adapter.planRemove(entry, 'user', env);
    await adapter.applyRemove(removeOps, env);

    const op = removeOps[0] as { kind: string; target: string; store: string };
    const targetExists = await fs.lstat(op.target).then(() => true).catch(() => false);
    const storeExists = await fs.lstat(op.store).then(() => true).catch(() => false);

    expect(targetExists).toBe(false);
    expect(storeExists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// planRemove — agent
// ---------------------------------------------------------------------------

describe('planRemove — agent', () => {
  it('returns [] when agent is not installed', async () => {
    const agentSource = (e: AdapterEntry) => path.join(fixturesDir, `${e.id}.md`);
    const adapter = createClaudeAdapter({ denyRef: [], agentSource });
    const entry: AdapterEntry = { id: 'agent:my-agent', nature: 'agent', scope: 'user' };

    const ops = await adapter.planRemove(entry, 'user', env);

    expect(ops).toHaveLength(0);
  });

  it('returns one unlink op when agent is installed', async () => {
    const agentFile = await makeAgentFixture(fixturesDir, 'my-agent');
    const agentSource = (_e: AdapterEntry) => agentFile;
    const adapter = createClaudeAdapter({ denyRef: [], agentSource });
    const entry: AdapterEntry = { id: 'agent:my-agent', nature: 'agent', scope: 'user' };

    // Install the agent first
    const installOps = await adapter.plan(entry, 'user', env);
    await adapter.apply(installOps, env);

    const removeOps = await adapter.planRemove(entry, 'user', env);

    expect(removeOps).toHaveLength(1);
    expect(removeOps[0]!.kind).toBe('unlink');
  });

  it('unlink op carries correct target and store paths for agent', async () => {
    const agentFile = await makeAgentFixture(fixturesDir, 'my-agent');
    const agentSource = (_e: AdapterEntry) => agentFile;
    const adapter = createClaudeAdapter({ denyRef: [], agentSource });
    const entry: AdapterEntry = { id: 'agent:my-agent', nature: 'agent', scope: 'user' };

    const installOps = await adapter.plan(entry, 'user', env);
    await adapter.apply(installOps, env);

    const removeOps = await adapter.planRemove(entry, 'user', env);
    const op = removeOps[0] as { kind: string; target: string; store: string };

    // target: ~/.claude/agents/my-agent.md
    // store: ~/.config/agent-rigger/agents/my-agent.md
    const home = path.dirname(path.dirname(targets.claudeSettings));
    const expectedTarget = path.join(home, '.claude', 'agents', 'my-agent.md');
    const expectedStore = path.join(path.dirname(targets.skillsDir), 'agents', 'my-agent.md');
    expect(op.target).toBe(expectedTarget);
    expect(op.store).toBe(expectedStore);
  });
});

// ---------------------------------------------------------------------------
// planRemove — plugin
// ---------------------------------------------------------------------------

describe('planRemove — plugin', () => {
  it('returns [] when plugin is not installed (ledger says absent)', async () => {
    await writeLedger(env, 'other-plugin@x');
    const runner = makeSpyPluginRunner();
    const adapter = createClaudeAdapter({
      denyRef: [],
      pluginRunner: runner,
      pluginSource: (_e) => ({
        plugin: PLUGIN_NAME,
        marketplace: '/some/path',
        marketplaceName: MARKETPLACE_NAME,
      }),
    });
    const entry: AdapterEntry = { id: `plugin:${PLUGIN_NAME}`, nature: 'plugin', scope: 'user' };

    const ops = await adapter.planRemove(entry, 'user', env);

    expect(ops).toHaveLength(0);
    // Read path never spawns (obs1 R1): the runner is untouched.
    expect(runner.calls).toHaveLength(0);
  });

  it('returns one plugin-uninstall op when plugin is present', async () => {
    await writeLedger(env, PLUGIN_LEDGER_KEY);
    const runner = makeSpyPluginRunner();
    const adapter = createClaudeAdapter({
      denyRef: [],
      pluginRunner: runner,
      pluginSource: (_e) => ({
        plugin: PLUGIN_NAME,
        marketplace: '/some/path',
        marketplaceName: MARKETPLACE_NAME,
      }),
    });
    const entry: AdapterEntry = { id: `plugin:${PLUGIN_NAME}`, nature: 'plugin', scope: 'user' };

    const ops = await adapter.planRemove(entry, 'user', env);

    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('plugin-uninstall');
    expect(runner.calls).toHaveLength(0);
  });

  it('plugin-uninstall op carries the correct plugin name', async () => {
    await writeLedger(env, PLUGIN_LEDGER_KEY);
    const runner = makeSpyPluginRunner();
    const adapter = createClaudeAdapter({
      denyRef: [],
      pluginRunner: runner,
      pluginSource: (_e) => ({
        plugin: PLUGIN_NAME,
        marketplace: '/some/path',
        marketplaceName: MARKETPLACE_NAME,
      }),
    });
    const entry: AdapterEntry = { id: `plugin:${PLUGIN_NAME}`, nature: 'plugin', scope: 'user' };

    const ops = await adapter.planRemove(entry, 'user', env);
    const op = ops[0] as { kind: string; plugin: string };

    expect(op.plugin).toBe(PLUGIN_NAME);
  });
});

// ---------------------------------------------------------------------------
// applyRemove — plugin-uninstall
// ---------------------------------------------------------------------------

describe('applyRemove — plugin-uninstall', () => {
  it('calls claude plugin uninstall <name> via the runner', async () => {
    const runner = makeSpyPluginRunner({ listStdout: '' });
    const adapter = createClaudeAdapter({
      denyRef: [],
      pluginRunner: runner,
      pluginSource: (_e) => ({
        plugin: PLUGIN_NAME,
        marketplace: '/some/path',
        marketplaceName: MARKETPLACE_NAME,
      }),
    });

    const ops = [{ kind: 'plugin-uninstall' as const, plugin: PLUGIN_NAME }];
    await adapter.applyRemove(ops, env);

    // Filter out any list calls from other operations; find the uninstall call
    const uninstallCall = runner.calls.find((c) => c.args.includes('uninstall'));
    expect(uninstallCall).toBeDefined();
    expect(uninstallCall!.command).toBe('claude');
    expect(uninstallCall!.args).toEqual(['plugin', 'uninstall', PLUGIN_NAME]);
  });

  it('throws when runner exits with non-zero code during uninstall', async () => {
    const runner = makeSpyPluginRunner({
      listStdout: '',
      applyExitCode: 1,
      applyStderr: 'uninstall failed',
    });
    const adapter = createClaudeAdapter({
      denyRef: [],
      pluginRunner: runner,
      pluginSource: (_e) => ({
        plugin: PLUGIN_NAME,
        marketplace: '/some/path',
        marketplaceName: MARKETPLACE_NAME,
      }),
    });

    const ops = [{ kind: 'plugin-uninstall' as const, plugin: PLUGIN_NAME }];

    await expect(adapter.applyRemove(ops, env)).rejects.toThrow();
  });

  it('error message contains the native stderr from the runner', async () => {
    const nativeStderr = 'plugin not found in registry';
    const runner = makeSpyPluginRunner({
      listStdout: '',
      applyExitCode: 1,
      applyStderr: nativeStderr,
    });
    const adapter = createClaudeAdapter({
      denyRef: [],
      pluginRunner: runner,
      pluginSource: (_e) => ({
        plugin: PLUGIN_NAME,
        marketplace: '/some/path',
        marketplaceName: MARKETPLACE_NAME,
      }),
    });

    const ops = [{ kind: 'plugin-uninstall' as const, plugin: PLUGIN_NAME }];

    let caught: unknown;
    try {
      await adapter.applyRemove(ops, env);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect((caught as Error).message).toContain(nativeStderr);
  });
});

// ---------------------------------------------------------------------------
// End-to-end via engine.remove — guardrail
// ---------------------------------------------------------------------------

describe('engine.remove — guardrail end-to-end', () => {
  it('install → remove → guardrail rules no longer in settings.json', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });
    const entry: AdapterEntry = { id: 'guardrails-claude', nature: 'guardrail', scope: 'user' };

    // Install
    await apply(adapter, [entry], 'user', env, manifestPath);
    const afterInstall = await readJson(targets.claudeSettings);
    const deny1 = ((afterInstall['permissions'] as Record<string, unknown>)['deny']) as string[];
    expect(deny1).toContain(REF_DENY[0]!);

    // Remove
    await remove(adapter, [entry], 'user', env, manifestPath);

    const afterRemove = await readJson(targets.claudeSettings);
    const deny2 = ((afterRemove['permissions'] as Record<string, unknown>)['deny']) as string[];
    for (const rule of REF_DENY) {
      expect(deny2).not.toContain(rule);
    }
  });

  it('remove creates a backup file for settings.json', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });
    const entry: AdapterEntry = { id: 'guardrails-claude', nature: 'guardrail', scope: 'user' };

    await apply(adapter, [entry], 'user', env, manifestPath);
    const result = await remove(adapter, [entry], 'user', env, manifestPath);

    expect(result.backedUp.length).toBeGreaterThan(0);
  });

  it('guardrail entry is removed from the manifest after remove()', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });
    const entry: AdapterEntry = { id: 'guardrails-claude', nature: 'guardrail', scope: 'user' };

    await apply(adapter, [entry], 'user', env, manifestPath);
    await remove(adapter, [entry], 'user', env, manifestPath);

    const { readManifest } = await import('@agent-rigger/core/manifest');
    const manifest = await readManifest(manifestPath);
    const found = manifest.artifacts.find((e) =>
      e.id === 'guardrails-claude' && e.scope === 'user'
    );
    expect(found).toBeUndefined();
  });

  it('2nd remove is a no-op (idempotent)', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });
    const entry: AdapterEntry = { id: 'guardrails-claude', nature: 'guardrail', scope: 'user' };

    await apply(adapter, [entry], 'user', env, manifestPath);
    await remove(adapter, [entry], 'user', env, manifestPath);

    // Second remove: planRemove must return [] (rules are gone)
    const result2 = await remove(adapter, [entry], 'user', env, manifestPath);
    expect(result2.removed).toHaveLength(0);
    expect(result2.backedUp).toHaveLength(0);
  });

  it('check after remove returns missing (exit 3)', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });
    const entry: AdapterEntry = { id: 'guardrails-claude', nature: 'guardrail', scope: 'user' };

    await apply(adapter, [entry], 'user', env, manifestPath);
    await remove(adapter, [entry], 'user', env, manifestPath);

    const report = await check(adapter, [entry], 'user', env);
    expect(reportExitCode(report)).toBe(3);
    expect(report.entries[0]!.state).toBe('missing');
  });
});

// ---------------------------------------------------------------------------
// End-to-end via engine.remove — context
// ---------------------------------------------------------------------------

describe('engine.remove — context end-to-end', () => {
  it('install → remove → AGENTS.md deleted + managed block removed from CLAUDE.md', async () => {
    const adapter = createClaudeAdapter({ denyRef: [], agentsContent: AGENTS_CONTENT });
    const entry: AdapterEntry = { id: 'context-claude', nature: 'context', scope: 'user' };

    await apply(adapter, [entry], 'user', env, manifestPath);
    await remove(adapter, [entry], 'user', env, manifestPath);

    const agentsExists = await fs.lstat(targets.agentsMd).then(() => true).catch(() => false);
    expect(agentsExists).toBe(false);

    const claudeMd = await readText(targets.claudeMd);
    expect(claudeMd).not.toContain('<!-- BEGIN agent-rigger (managed — do not edit) -->');
  });

  it('user content in CLAUDE.md is preserved after context remove', async () => {
    const adapter = createClaudeAdapter({ denyRef: [], agentsContent: AGENTS_CONTENT });
    const entry: AdapterEntry = { id: 'context-claude', nature: 'context', scope: 'user' };

    // Write user content before install
    await fs.mkdir(path.dirname(targets.claudeMd), { recursive: true });
    await writeText(targets.claudeMd, '# My personal config\n@MY-OTHER.md\n');

    await apply(adapter, [entry], 'user', env, manifestPath);
    await remove(adapter, [entry], 'user', env, manifestPath);

    const claudeMd = await readText(targets.claudeMd);
    expect(claudeMd).toContain('# My personal config');
    expect(claudeMd).toContain('@MY-OTHER.md');
  });
});

// ---------------------------------------------------------------------------
// End-to-end via engine.remove — skill
// ---------------------------------------------------------------------------

describe('engine.remove — skill end-to-end', () => {
  it('install → remove → skill target and store are deleted', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'e2e-skill');
    const skillSource = (_e: AdapterEntry) => srcDir;
    const adapter = createClaudeAdapter({ denyRef: [], skillSource });
    const entry: AdapterEntry = { id: 'skill:e2e-skill', nature: 'skill', scope: 'user' };

    await apply(adapter, [entry], 'user', env, manifestPath);

    const expectedTarget = path.join(path.dirname(targets.claudeSettings), 'skills', 'e2e-skill');
    const expectedStore = path.join(targets.skillsDir, 'e2e-skill');

    // Confirm installed
    expect(await fs.lstat(expectedTarget).then(() => true).catch(() => false)).toBe(true);

    await remove(adapter, [entry], 'user', env, manifestPath);

    expect(await fs.lstat(expectedTarget).then(() => true).catch(() => false)).toBe(false);
    expect(await fs.lstat(expectedStore).then(() => true).catch(() => false)).toBe(false);
  });

  it('2nd remove of skill is a no-op (idempotent)', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'idempotent-skill');
    const skillSource = (_e: AdapterEntry) => srcDir;
    const adapter = createClaudeAdapter({ denyRef: [], skillSource });
    const entry: AdapterEntry = { id: 'skill:idempotent-skill', nature: 'skill', scope: 'user' };

    await apply(adapter, [entry], 'user', env, manifestPath);
    await remove(adapter, [entry], 'user', env, manifestPath);

    const result2 = await remove(adapter, [entry], 'user', env, manifestPath);
    expect(result2.removed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Non-regression: existing install / check / apply still work
// ---------------------------------------------------------------------------

describe('non-regression — existing operations unaffected', () => {
  it('install guardrail still works after remove implementation', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });
    const entry: AdapterEntry = { id: 'guardrails-claude', nature: 'guardrail', scope: 'user' };

    await apply(adapter, [entry], 'user', env, manifestPath);
    const report = await check(adapter, [entry], 'user', env);

    expect(reportExitCode(report)).toBe(0);
    expect(report.entries[0]!.state).toBe('present');
  });

  it('install skill still works after remove implementation', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'check-skill');
    const skillSource = (_e: AdapterEntry) => srcDir;
    const adapter = createClaudeAdapter({ denyRef: [], skillSource });
    const entry: AdapterEntry = { id: 'skill:check-skill', nature: 'skill', scope: 'user' };

    await apply(adapter, [entry], 'user', env, manifestPath);
    const report = await check(adapter, [entry], 'user', env);

    expect(reportExitCode(report)).toBe(0);
    expect(report.entries[0]!.state).toBe('present');
  });
});
