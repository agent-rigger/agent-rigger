/**
 * Smoke tests for claude/mcp.ts's defaultMcpRunner and claude/plugins.ts's
 * defaultPluginRunner — the real Bun.spawn-backed runners used in production
 * (mcp.ts:71, plugins.ts:68). Every other test in this package injects a fake
 * runner, so these two defaults have never been exercised by a real spawn
 * before this file (M16 residual, lot7). Env merge (opts.env layered over
 * process.env — plugins.ts merges GITLAB_TOKEN this way in applyPlugin) is
 * asserted with a sentinel variable, and checked to NOT mutate process.env
 * itself (the merge builds a new object; it never assigns back).
 */

import { describe, expect, it } from 'bun:test';

import { defaultMcpRunner } from '../../src/claude/mcp';
import { defaultPluginRunner } from '../../src/claude/plugins';

// ---------------------------------------------------------------------------
// defaultMcpRunner — real spawn
// ---------------------------------------------------------------------------

describe('defaultMcpRunner — real spawn', () => {
  it('captures stdout and exit 0 via echo', async () => {
    const result = await defaultMcpRunner('echo', ['hello-mcp']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello-mcp\n');
  });

  it('returns the exact exit code of the spawned command', async () => {
    const result = await defaultMcpRunner('sh', ['-c', 'exit 5']);
    expect(result.exitCode).toBe(5);
  });

  it('merges opts.env into the child env without mutating process.env', async () => {
    const SENTINEL = 'AGENT_RIGGER_MCP_SMOKE_SENTINEL';
    expect(process.env[SENTINEL]).toBeUndefined();

    const result = await defaultMcpRunner('sh', ['-c', `printf "%s" "$${SENTINEL}"`], {
      env: { [SENTINEL]: 'mcp-value' },
    });

    expect(result.stdout).toBe('mcp-value');
    expect(process.env[SENTINEL]).toBeUndefined();
  });

  it('inherits the AMBIENT process.env when no opts.env is passed (lot7 Low-2)', async () => {
    process.env.LOT7_AMBIENT_SENTINEL = 'mcp-ambient-value';
    try {
      const result = await defaultMcpRunner('sh', ['-c', 'printf "%s" "$LOT7_AMBIENT_SENTINEL"']);

      expect(result.stdout).toBe('mcp-ambient-value');
    } finally {
      delete process.env.LOT7_AMBIENT_SENTINEL;
    }
  });
});

// ---------------------------------------------------------------------------
// defaultPluginRunner — real spawn
// ---------------------------------------------------------------------------

describe('defaultPluginRunner — real spawn', () => {
  it('captures stdout and exit 0 via echo', async () => {
    const result = await defaultPluginRunner('echo', ['hello-plugin']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello-plugin\n');
  });

  it('returns the exact exit code of the spawned command', async () => {
    const result = await defaultPluginRunner('sh', ['-c', 'exit 6']);
    expect(result.exitCode).toBe(6);
  });

  it('merges opts.env (e.g. GITLAB_TOKEN) into the child env without mutating process.env', async () => {
    const SENTINEL = 'AGENT_RIGGER_PLUGIN_SMOKE_SENTINEL';
    expect(process.env[SENTINEL]).toBeUndefined();

    const result = await defaultPluginRunner('sh', ['-c', `printf "%s" "$${SENTINEL}"`], {
      env: { [SENTINEL]: 'plugin-value' },
    });

    expect(result.stdout).toBe('plugin-value');
    expect(process.env[SENTINEL]).toBeUndefined();
  });

  it('inherits the AMBIENT process.env when no opts.env is passed (lot7 Low-2)', async () => {
    process.env.LOT7_AMBIENT_SENTINEL = 'plugin-ambient-value';
    try {
      const result = await defaultPluginRunner(
        'sh',
        ['-c', 'printf "%s" "$LOT7_AMBIENT_SENTINEL"'],
      );

      expect(result.stdout).toBe('plugin-ambient-value');
    } finally {
      delete process.env.LOT7_AMBIENT_SENTINEL;
    }
  });
});
