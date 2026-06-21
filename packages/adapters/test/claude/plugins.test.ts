/**
 * Tests for claude/plugins handler (TDD — written before implementation).
 *
 * Covers:
 * - pluginName: strips 'plugin:' prefix from entry id.
 * - auditPlugin: fake runner stdout contains plugin → present; absent → missing.
 *   Assert the command passed to runner is 'claude plugin list'.
 * - planPlugin: absent → 1 op plugin-install (correct plugin + marketplace);
 *   present → [].
 * - applyPlugin: success → 2 runs in order (marketplace add then install) with
 *   correct args (asserted via spy runner).
 * - applyPlugin: failure (exitCode ≠ 0) → PluginInstallError carrying stderr.
 * - applyPlugin: nothing swallows the PluginInstallError.
 * - gitlabToken: when provided, passed in env to runner.
 * - end-to-end via createClaudeAdapter: check missing → apply → 2nd apply no-op.
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
  applyPlugin,
  auditPlugin,
  planPlugin,
  PluginInstallError,
  pluginName,
} from '../../src/claude/plugins';
import type { PluginRunner } from '../../src/claude/plugins';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-plugins-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Fake / spy runner factory
// ---------------------------------------------------------------------------

interface RunnerCall {
  command: string;
  args: string[];
  // env is truly optional: absent when the runner receives no opts.env
  env?: Record<string, string | undefined> | undefined;
}

/**
 * Build a fake PluginRunner that records all calls and returns the configured result.
 *
 * PluginRunner is a function: (command, args, opts?) => Promise<{exitCode, stdout, stderr}>.
 *
 * - listStdout: stdout returned when args include 'list'.
 * - applyExitCode: exit code returned for non-list calls (default 0).
 * - applyStderr: stderr returned for non-list calls (default '').
 */
function makeSpyRunner(opts: {
  listStdout?: string;
  applyExitCode?: number;
  applyStderr?: string;
} = {}): PluginRunner & { calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];

  function runner(
    command: string,
    args: string[],
    runOpts?: { env?: Record<string, string | undefined> },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const call: RunnerCall = { command, args };
    if (runOpts?.env !== undefined) {
      call.env = runOpts.env;
    }
    calls.push(call);

    const isListCall = args.includes('list');
    if (isListCall) {
      return Promise.resolve({
        exitCode: 0,
        stdout: opts.listStdout ?? '',
        stderr: '',
      });
    }

    return Promise.resolve({
      exitCode: opts.applyExitCode ?? 0,
      stdout: '',
      stderr: opts.applyStderr ?? '',
    });
  }

  // Attach spy state to the function for test assertions
  (runner as PluginRunner & { calls: RunnerCall[] }).calls = calls;
  return runner as PluginRunner & { calls: RunnerCall[] };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PLUGIN_NAME = 'my-rigger-plugin';
const MARKETPLACE = '/path/to/.claude-plugin/marketplace.json';

const PLUGIN_ENTRY: AdapterEntry = {
  id: `plugin:${PLUGIN_NAME}`,
  nature: 'plugin',
  scope: 'user',
};

const PLUGIN_SOURCE = (_entry: AdapterEntry) => ({
  plugin: PLUGIN_NAME,
  marketplace: MARKETPLACE,
});

/**
 * Module-level fake runner that always fails on non-list calls.
 * Defined outside test scope to satisfy consistent-function-scoping lint rule.
 */
const failingPluginRunner: PluginRunner = (
  _command: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  if (args.includes('list')) {
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  }
  return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'native error from claude' });
};

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;

beforeEach(async () => {
  tmp = await makeTmpHome('rigger-plugins-');
  env = tmp.env;
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// pluginName
// ---------------------------------------------------------------------------

describe('pluginName', () => {
  it("strips 'plugin:' prefix from entry id", () => {
    const entry: AdapterEntry = { id: 'plugin:my-plugin', nature: 'plugin', scope: 'user' };
    expect(pluginName(entry)).toBe('my-plugin');
  });

  it('returns the id unchanged when no prefix', () => {
    const entry: AdapterEntry = { id: 'my-plugin', nature: 'plugin', scope: 'user' };
    expect(pluginName(entry)).toBe('my-plugin');
  });

  it('handles ids with multiple colons (keeps everything after first plugin:)', () => {
    const entry: AdapterEntry = { id: 'plugin:a:b', nature: 'plugin', scope: 'user' };
    expect(pluginName(entry)).toBe('a:b');
  });
});

// ---------------------------------------------------------------------------
// auditPlugin
// ---------------------------------------------------------------------------

describe('auditPlugin', () => {
  it('returns present when plugin name appears in list stdout', async () => {
    const runner = makeSpyRunner({ listStdout: `some-other\n${PLUGIN_NAME}\nfoo` });

    const report = await auditPlugin(PLUGIN_ENTRY, env, { run: runner });

    expect(report.state).toBe('present');
    expect(report.nature).toBe('plugin');
    expect(report.id).toBe(PLUGIN_ENTRY.id);
  });

  it('returns missing when plugin name is absent from list stdout', async () => {
    const runner = makeSpyRunner({ listStdout: 'other-plugin\nanother-one' });

    const report = await auditPlugin(PLUGIN_ENTRY, env, { run: runner });

    expect(report.state).toBe('missing');
    expect(report.nature).toBe('plugin');
  });

  it('returns missing when list stdout is empty', async () => {
    const runner = makeSpyRunner({ listStdout: '' });

    const report = await auditPlugin(PLUGIN_ENTRY, env, { run: runner });

    expect(report.state).toBe('missing');
  });

  it('calls runner with "claude plugin list" command and args', async () => {
    const runner = makeSpyRunner({ listStdout: '' });

    await auditPlugin(PLUGIN_ENTRY, env, { run: runner });

    expect(runner.calls).toHaveLength(1);
    const call = runner.calls[0]!;
    expect(call.command).toBe('claude');
    expect(call.args).toContain('plugin');
    expect(call.args).toContain('list');
  });
});

// ---------------------------------------------------------------------------
// planPlugin
// ---------------------------------------------------------------------------

describe('planPlugin', () => {
  it('returns one plugin-install op when plugin is absent', async () => {
    const runner = makeSpyRunner({ listStdout: 'other-plugin' });

    const ops = await planPlugin(PLUGIN_ENTRY, PLUGIN_SOURCE, { run: runner });

    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('plugin-install');
  });

  it('plugin-install op carries correct plugin and marketplace', async () => {
    const runner = makeSpyRunner({ listStdout: '' });

    const ops = await planPlugin(PLUGIN_ENTRY, PLUGIN_SOURCE, { run: runner });
    const op = ops[0] as { kind: string; plugin: string; marketplace: string };

    expect(op.plugin).toBe(PLUGIN_NAME);
    expect(op.marketplace).toBe(MARKETPLACE);
  });

  it('returns empty array when plugin is already present', async () => {
    const runner = makeSpyRunner({ listStdout: PLUGIN_NAME });

    const ops = await planPlugin(PLUGIN_ENTRY, PLUGIN_SOURCE, { run: runner });

    expect(ops).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// applyPlugin
// ---------------------------------------------------------------------------

describe('applyPlugin', () => {
  it('executes marketplace add then plugin install in order', async () => {
    const runner = makeSpyRunner();
    const ops = [{
      kind: 'plugin-install' as const,
      plugin: PLUGIN_NAME,
      marketplace: MARKETPLACE,
    }];

    await applyPlugin(ops, env, { run: runner });

    // 2 calls: marketplace add + plugin install
    expect(runner.calls).toHaveLength(2);

    const [addCall, installCall] = runner.calls as [RunnerCall, RunnerCall];

    // First: claude plugin marketplace add <marketplace>
    expect(addCall.command).toBe('claude');
    expect(addCall.args).toEqual(['plugin', 'marketplace', 'add', MARKETPLACE]);

    // Second: claude plugin install <plugin>
    expect(installCall.command).toBe('claude');
    expect(installCall.args).toEqual(['plugin', 'install', PLUGIN_NAME]);
  });

  it('throws PluginInstallError when marketplace add fails', async () => {
    const runner = makeSpyRunner({ applyExitCode: 1, applyStderr: 'marketplace not found' });
    const ops = [{
      kind: 'plugin-install' as const,
      plugin: PLUGIN_NAME,
      marketplace: MARKETPLACE,
    }];

    await expect(applyPlugin(ops, env, { run: runner })).rejects.toThrow(PluginInstallError);
  });

  it('PluginInstallError carries the native stderr', async () => {
    const nativeStderr = 'connection refused to marketplace';
    const runner = makeSpyRunner({ applyExitCode: 2, applyStderr: nativeStderr });
    const ops = [{
      kind: 'plugin-install' as const,
      plugin: PLUGIN_NAME,
      marketplace: MARKETPLACE,
    }];

    let caught: unknown;
    try {
      await applyPlugin(ops, env, { run: runner });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PluginInstallError);
    const err = caught as PluginInstallError;
    expect(err.stderr).toBe(nativeStderr);
  });

  it('PluginInstallError carries the command that failed', async () => {
    const runner = makeSpyRunner({ applyExitCode: 1, applyStderr: 'some error' });
    const ops = [{
      kind: 'plugin-install' as const,
      plugin: PLUGIN_NAME,
      marketplace: MARKETPLACE,
    }];

    let caught: unknown;
    try {
      await applyPlugin(ops, env, { run: runner });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PluginInstallError);
    const err = caught as PluginInstallError;
    expect(err.command).toContain('claude');
  });

  it('does not swallow PluginInstallError (propagates to caller)', async () => {
    const runner = makeSpyRunner({ applyExitCode: 1, applyStderr: 'fatal error' });
    const ops = [{
      kind: 'plugin-install' as const,
      plugin: PLUGIN_NAME,
      marketplace: MARKETPLACE,
    }];

    const result = applyPlugin(ops, env, { run: runner });
    await expect(result).rejects.toBeInstanceOf(PluginInstallError);
  });

  it('stops after marketplace add failure and does not call install', async () => {
    const runner = makeSpyRunner({ applyExitCode: 1, applyStderr: 'marketplace error' });
    const ops = [{
      kind: 'plugin-install' as const,
      plugin: PLUGIN_NAME,
      marketplace: MARKETPLACE,
    }];

    try {
      await applyPlugin(ops, env, { run: runner });
    } catch {
      // expected
    }

    // Only one call: marketplace add (install must not be called after failure)
    expect(runner.calls).toHaveLength(1);
  });

  it('ignores ops that are not plugin-install kind (forward compat)', async () => {
    const runner = makeSpyRunner();
    const ops = [{ kind: 'write-json' as const, path: '/tmp/x.json', description: 'noop' }];

    // Must not throw, runner must not be called
    await applyPlugin(ops as never, env, { run: runner });
    expect(runner.calls).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // gitlabToken
  // ---------------------------------------------------------------------------

  it('passes GITLAB_TOKEN in env when gitlabToken is provided', async () => {
    const runner = makeSpyRunner();
    const ops = [{
      kind: 'plugin-install' as const,
      plugin: PLUGIN_NAME,
      marketplace: MARKETPLACE,
    }];

    await applyPlugin(ops, env, { run: runner, gitlabToken: 'glpat-secret' });

    for (const call of runner.calls) {
      expect(call.env?.['GITLAB_TOKEN']).toBe('glpat-secret');
    }
  });

  it('does not inject GITLAB_TOKEN when gitlabToken is not provided', async () => {
    const runner = makeSpyRunner();
    const ops = [{
      kind: 'plugin-install' as const,
      plugin: PLUGIN_NAME,
      marketplace: MARKETPLACE,
    }];

    await applyPlugin(ops, env, { run: runner });

    for (const call of runner.calls) {
      expect(call.env?.['GITLAB_TOKEN']).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// end-to-end via createClaudeAdapter + engine
// ---------------------------------------------------------------------------

describe('createClaudeAdapter — plugin end-to-end via engine', () => {
  it('check missing → apply (fake runner OK) → check present → 2nd apply no-op', async () => {
    let installCount = 0;

    // Fake runner: list returns empty until install is triggered
    const runner: PluginRunner = (
      _command: string,
      args: string[],
    ) => {
      if (args.includes('list')) {
        const stdout = installCount > 0 ? PLUGIN_NAME : '';
        return Promise.resolve({ exitCode: 0, stdout, stderr: '' });
      }
      if (args.includes('install')) {
        installCount++;
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    };

    const adapter = createClaudeAdapter({
      denyRef: [],
      pluginSource: PLUGIN_SOURCE,
      pluginRunner: runner,
    });

    const targets = resolveUserTargets(env);
    const manifestPath = targets.stateJson;

    // 1. check: missing
    const report1 = await check(adapter, [PLUGIN_ENTRY], 'user', env);
    expect(reportExitCode(report1)).toBe(3);
    expect(report1.entries[0]!.state).toBe('missing');

    // 2. apply: triggers marketplace add + install
    await apply(adapter, [PLUGIN_ENTRY], 'user', env, manifestPath);
    expect(installCount).toBe(1);

    // 3. check after apply: present
    const report2 = await check(adapter, [PLUGIN_ENTRY], 'user', env);
    expect(reportExitCode(report2)).toBe(0);
    expect(report2.entries[0]!.state).toBe('present');

    // 4. 2nd apply: plan returns [] (already present) → no additional installs
    const prevInstallCount = installCount;
    await apply(adapter, [PLUGIN_ENTRY], 'user', env, manifestPath);
    expect(installCount).toBe(prevInstallCount);
  });

  it('apply calls correct claude commands for plugin install', async () => {
    const spyRunner = makeSpyRunner({ listStdout: '' });

    const adapter = createClaudeAdapter({
      denyRef: [],
      pluginSource: PLUGIN_SOURCE,
      pluginRunner: spyRunner,
    });

    const targets = resolveUserTargets(env);
    const manifestPath = targets.stateJson;

    await apply(adapter, [PLUGIN_ENTRY], 'user', env, manifestPath);

    // Filter list calls (from audit in plan), keep only apply calls
    const applyCalls = spyRunner.calls.filter((c) => !c.args.includes('list'));
    expect(applyCalls).toHaveLength(2);

    const [addCall, installCall] = applyCalls as [RunnerCall, RunnerCall];
    expect(addCall.args).toEqual(['plugin', 'marketplace', 'add', MARKETPLACE]);
    expect(installCall.args).toEqual(['plugin', 'install', PLUGIN_NAME]);
  });

  it('PluginInstallError from runner is not swallowed by engine', async () => {
    const adapter = createClaudeAdapter({
      denyRef: [],
      pluginSource: PLUGIN_SOURCE,
      pluginRunner: failingPluginRunner,
    });

    const targets = resolveUserTargets(env);
    const manifestPath = targets.stateJson;

    await expect(
      apply(adapter, [PLUGIN_ENTRY], 'user', env, manifestPath),
    ).rejects.toBeInstanceOf(PluginInstallError);
  });
});
