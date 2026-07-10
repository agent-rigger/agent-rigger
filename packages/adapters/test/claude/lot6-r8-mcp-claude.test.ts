/**
 * lot6-r8-mcp-claude.test.ts — R8: the mcp nature exists for Claude Code
 * (D6 branch A, delegate-first). TDD — written before adapters/src/claude/mcp.ts.
 *
 * Covers the R8 contract at the adapter + engine layer:
 *  - mcpServerName: strips 'mcp:' + a source qualifier.
 *  - auditMcp: reads ~/.claude.json mcpServers → present/missing (read-only).
 *  - planMcp / planRemoveMcp: emit exactly one delegated op (mcp-add / mcp-remove)
 *    or [] (idempotent).
 *  - applyMcp / applyRemoveMcp: delegate `claude mcp add-json` / `claude mcp remove`
 *    with the exact args; a non-zero exit throws McpAddError / McpRemoveError
 *    carrying the native stderr — nothing swallowed.
 *  - adoptMcp (FM5): identical rendered config on disk → adopted; a divergent
 *    config for the same id → NEVER adopted; absent → refused.
 *  - end-to-end via createClaudeAdapter + engine: check(3) → apply → server
 *    registered + manifest entry (id, scope=user, assistant=claude, applied
 *    'claude-mcp') → check(0) → 2nd apply no-op → remove → a PERSONAL neighbour
 *    server survives untouched, the manifest entry is gone → check(3).
 *  - a "${VAR}" env-ref rides verbatim through apply → disk → manifest; the
 *    real value it would expand to never leaks into any written artifact.
 *
 * The fake McpRunner FAITHFULLY simulates Claude's native behaviour: add-json
 * leaf-merges the one server into ~/.claude.json's mcpServers (preserving every
 * other key), remove deletes exactly the named server. This lets the file-read
 * audit/adopt observe the delegated mutation and lets the neighbour-survival
 * assertion be real.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply, check, remove, reportExitCode } from '@agent-rigger/core/engine';
import { findEntry, readManifest } from '@agent-rigger/core/manifest';
import type { Env } from '@agent-rigger/core/paths';
import { resolveHome, resolveUserTargets } from '@agent-rigger/core/paths';
import type { AppliedClaudeMcp, ClaudeMcpServer } from '@agent-rigger/core/types';

import { createClaudeAdapter } from '../../src/claude/adapter';
import {
  adoptMcp,
  applyMcp,
  applyRemoveMcp,
  auditMcp,
  McpAddError,
  McpRemoveError,
  mcpServerName,
  planMcp,
  planRemoveMcp,
} from '../../src/claude/mcp';
import type { McpRunner } from '../../src/claude/mcp';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-r8-mcp-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

interface RunnerCall {
  command: string;
  args: string[];
}

/** Read the whole ~/.claude.json object (or {} if absent/invalid). */
async function readClaudeJson(env: Env): Promise<Record<string, unknown>> {
  const p = path.join(resolveHome(env), '.claude.json');
  try {
    return JSON.parse(await fs.readFile(p, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeClaudeJson(env: Env, obj: Record<string, unknown>): Promise<void> {
  const p = path.join(resolveHome(env), '.claude.json');
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2), 'utf-8');
}

/**
 * A fake McpRunner that faithfully simulates `claude mcp add-json`/`remove` on
 * a real ~/.claude.json (user scope): a leaf-merge into `mcpServers` that
 * preserves every other key, and an exact-name delete. Records all calls.
 */
function makeFakeClaudeMcpRunner(env: Env): McpRunner & { calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];

  const runner: McpRunner = async (command, args) => {
    calls.push({ command, args });

    if (args[0] === 'mcp' && args[1] === 'add-json') {
      const server = args[2]!;
      const json = args[3]!;
      const current = await readClaudeJson(env);
      const servers = (current['mcpServers'] as Record<string, unknown>) ?? {};
      if (Object.prototype.hasOwnProperty.call(servers, server)) {
        return { exitCode: 1, stdout: '', stderr: `MCP server ${server} already exists` };
      }
      servers[server] = JSON.parse(json);
      current['mcpServers'] = servers;
      await writeClaudeJson(env, current);
      return { exitCode: 0, stdout: `Added ${server}`, stderr: '' };
    }

    if (args[0] === 'mcp' && args[1] === 'remove') {
      const server = args[2]!;
      const current = await readClaudeJson(env);
      const servers = (current['mcpServers'] as Record<string, unknown>) ?? {};
      if (!Object.prototype.hasOwnProperty.call(servers, server)) {
        return { exitCode: 1, stdout: '', stderr: `No MCP server named ${server}` };
      }
      delete servers[server];
      current['mcpServers'] = servers;
      await writeClaudeJson(env, current);
      return { exitCode: 0, stdout: `Removed ${server}`, stderr: '' };
    }

    return { exitCode: 0, stdout: '', stderr: '' };
  };

  (runner as McpRunner & { calls: RunnerCall[] }).calls = calls;
  return runner as McpRunner & { calls: RunnerCall[] };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SERVER_ID = 'github';
const RENDERED_CONFIG: ClaudeMcpServer = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
};
const MCP_ENTRY: AdapterEntry = { id: 'mcp:github', nature: 'mcp', scope: 'user' };
const MCP_SOURCE = () => ({ server: SERVER_ID, config: RENDERED_CONFIG });

/** Module-level failing runners (consistent-function-scoping: no captured vars). */
const failingAddRunner: McpRunner = () =>
  Promise.resolve({ exitCode: 1, stdout: '', stderr: 'native add failure' });
const failingRemoveRunner: McpRunner = () =>
  Promise.resolve({ exitCode: 1, stdout: '', stderr: 'native remove failure' });

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
// mcpServerName
// ---------------------------------------------------------------------------

describe('lot6-R8: mcpServerName', () => {
  it('strips the "mcp:" prefix', () => {
    expect(mcpServerName({ id: 'mcp:github', nature: 'mcp', scope: 'user' })).toBe('github');
  });

  it('strips a source qualifier and the prefix', () => {
    expect(mcpServerName({ id: 'principal/mcp:github', nature: 'mcp', scope: 'user' })).toBe(
      'github',
    );
  });

  it('returns the id unchanged when no prefix', () => {
    expect(mcpServerName({ id: 'github', nature: 'mcp', scope: 'user' })).toBe('github');
  });
});

// ---------------------------------------------------------------------------
// auditMcp — reads ~/.claude.json (read-only)
// ---------------------------------------------------------------------------

describe('lot6-R8: auditMcp reads the claude config file', () => {
  it('present when the server is declared under mcpServers', async () => {
    await writeClaudeJson(env, { mcpServers: { [SERVER_ID]: RENDERED_CONFIG } });
    const report = await auditMcp('user', env, SERVER_ID);
    expect(report.state).toBe('present');
    expect(report.nature).toBe('mcp');
  });

  it('missing when the file is absent', async () => {
    const report = await auditMcp('user', env, SERVER_ID);
    expect(report.state).toBe('missing');
  });

  it('missing when a different server is declared', async () => {
    await writeClaudeJson(env, { mcpServers: { other: { type: 'stdio', command: 'x' } } });
    const report = await auditMcp('user', env, SERVER_ID);
    expect(report.state).toBe('missing');
  });
});

// ---------------------------------------------------------------------------
// planMcp / planRemoveMcp
// ---------------------------------------------------------------------------

describe('lot6-R8: planMcp / planRemoveMcp', () => {
  it('planMcp emits one mcp-add op when the server is absent', async () => {
    const ops = await planMcp('user', env, SERVER_ID, RENDERED_CONFIG, undefined, {
      GITHUB_TOKEN: 'GITHUB_TOKEN',
    });
    expect(ops).toHaveLength(1);
    const op = ops[0] as {
      kind: string;
      server: string;
      scope: string;
      config: ClaudeMcpServer;
      secretRefs?: Record<string, string>;
    };
    expect(op.kind).toBe('mcp-add');
    expect(op.server).toBe(SERVER_ID);
    expect(op.scope).toBe('user');
    expect(op.config).toEqual(RENDERED_CONFIG);
    expect(op.secretRefs).toEqual({ GITHUB_TOKEN: 'GITHUB_TOKEN' });
  });

  it('planMcp returns [] when the server is already present (idempotent)', async () => {
    await writeClaudeJson(env, { mcpServers: { [SERVER_ID]: RENDERED_CONFIG } });
    const ops = await planMcp('user', env, SERVER_ID, RENDERED_CONFIG);
    expect(ops).toHaveLength(0);
  });

  it('planRemoveMcp emits one mcp-remove op when present, [] when absent', async () => {
    await writeClaudeJson(env, { mcpServers: { [SERVER_ID]: RENDERED_CONFIG } });
    const present = await planRemoveMcp('user', env, SERVER_ID);
    expect(present).toHaveLength(1);
    expect((present[0] as { kind: string; scope: string }).kind).toBe('mcp-remove');
    expect((present[0] as { kind: string; scope: string }).scope).toBe('user');

    await writeClaudeJson(env, { mcpServers: {} });
    const absent = await planRemoveMcp('user', env, SERVER_ID);
    expect(absent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// applyMcp / applyRemoveMcp — delegate with exact args; errors not swallowed
// ---------------------------------------------------------------------------

describe('lot6-R8: applyMcp / applyRemoveMcp delegate to claude mcp', () => {
  it('applyMcp calls `claude mcp add-json <server> <json> -s <scope>`', async () => {
    const runner = makeFakeClaudeMcpRunner(env);
    await applyMcp(
      [{ kind: 'mcp-add', server: SERVER_ID, config: RENDERED_CONFIG, scope: 'user' }],
      env,
      { run: runner },
    );
    expect(runner.calls).toHaveLength(1);
    const call = runner.calls[0]!;
    expect(call.command).toBe('claude');
    expect(call.args.slice(0, 3)).toEqual(['mcp', 'add-json', SERVER_ID]);
    expect(JSON.parse(call.args[3]!)).toEqual(RENDERED_CONFIG);
    expect(call.args.slice(4)).toEqual(['-s', 'user']);
  });

  it('applyMcp throws McpAddError carrying the native stderr on non-zero exit', async () => {
    let caught: unknown;
    try {
      await applyMcp(
        [{ kind: 'mcp-add', server: SERVER_ID, config: RENDERED_CONFIG, scope: 'user' }],
        env,
        { run: failingAddRunner },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpAddError);
    expect((caught as McpAddError).stderr).toBe('native add failure');
  });

  it('applyRemoveMcp calls `claude mcp remove <server> -s <scope>`', async () => {
    const runner = makeFakeClaudeMcpRunner(env);
    await writeClaudeJson(env, { mcpServers: { [SERVER_ID]: RENDERED_CONFIG } });
    await applyRemoveMcp([{ kind: 'mcp-remove', server: SERVER_ID, scope: 'user' }], env, {
      run: runner,
    });
    expect(runner.calls[0]!.args).toEqual(['mcp', 'remove', SERVER_ID, '-s', 'user']);
  });

  it('applyRemoveMcp throws McpRemoveError carrying the native stderr on non-zero exit', async () => {
    await expect(
      applyRemoveMcp([{ kind: 'mcp-remove', server: SERVER_ID, scope: 'user' }], env, {
        run: failingRemoveRunner,
      }),
    ).rejects.toBeInstanceOf(McpRemoveError);
  });
});

// ---------------------------------------------------------------------------
// adoptMcp (FM5): deep-equal only
// ---------------------------------------------------------------------------

describe('lot6-R8: adoptMcp adopts only on a deep-equal rendered config', () => {
  it('adopts an on-disk server identical to the rendered config', async () => {
    await writeClaudeJson(env, { mcpServers: { [SERVER_ID]: RENDERED_CONFIG } });
    const result = await adoptMcp('user', env, SERVER_ID, RENDERED_CONFIG, undefined, {
      GITHUB_TOKEN: 'GITHUB_TOKEN',
    });
    expect(result).toBeDefined();
    const applied = result!.applied as AppliedClaudeMcp;
    expect(applied.kind).toBe('claude-mcp');
    expect(applied.server).toBe(SERVER_ID);
    expect(applied.scope).toBe('user');
    expect(applied.secretRefs).toEqual({ GITHUB_TOKEN: 'GITHUB_TOKEN' });
  });

  it('NEVER adopts a divergent config for the same server id', async () => {
    await writeClaudeJson(env, {
      mcpServers: { [SERVER_ID]: { type: 'stdio', command: 'DIFFERENT', args: [] } },
    });
    const result = await adoptMcp('user', env, SERVER_ID, RENDERED_CONFIG);
    expect(result).toBeUndefined();
  });

  it('refuses when the server is absent', async () => {
    const result = await adoptMcp('user', env, SERVER_ID, RENDERED_CONFIG);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// end-to-end via createClaudeAdapter + engine
// ---------------------------------------------------------------------------

describe('lot6-R8: mcp claude end-to-end via engine', () => {
  it('check(3) → apply → registered + manifest entry → check(0) → 2nd apply no-op → remove → neighbour survives → check(3)', async () => {
    const runner = makeFakeClaudeMcpRunner(env);
    const adapter = createClaudeAdapter({
      denyRef: [],
      mcpSource: MCP_SOURCE,
      mcpRunner: runner,
    });
    const manifestPath = resolveUserTargets(env).stateJson;

    // A personal MCP server the user added by hand — must survive install AND remove.
    const PERSONAL = { type: 'stdio', command: 'my-personal-server', args: ['--flag'] };
    await writeClaudeJson(env, { numStartups: 7, mcpServers: { personal: PERSONAL } });

    // 1. check: missing → exit 3.
    const c1 = await check(adapter, [MCP_ENTRY], 'user', env, manifestPath);
    expect(reportExitCode(c1)).toBe(3);

    // 2. apply → delegated add-json; server registered, foreign keys preserved.
    await apply(adapter, [MCP_ENTRY], 'user', env, manifestPath);
    const afterInstall = await readClaudeJson(env);
    const serversAfter = afterInstall['mcpServers'] as Record<string, unknown>;
    expect(serversAfter[SERVER_ID]).toEqual(RENDERED_CONFIG);
    // Neighbour + unrelated top-level key intact (byte-for-byte on the untouched parts).
    expect(serversAfter['personal']).toEqual(PERSONAL);
    expect(afterInstall['numStartups']).toBe(7);

    // Manifest tracks (id, user, claude) with a 'claude-mcp' applied payload.
    const manifest = await readManifest(manifestPath);
    const tracked = findEntry(manifest, MCP_ENTRY.id, 'user', 'claude');
    expect(tracked).toBeDefined();
    expect(tracked!.assistant).toBe('claude');
    const applied = tracked!.applied as AppliedClaudeMcp;
    expect(applied.kind).toBe('claude-mcp');
    expect(applied.server).toBe(SERVER_ID);
    expect(applied.scope).toBe('user');

    // 3. check: present → exit 0.
    const c2 = await check(adapter, [MCP_ENTRY], 'user', env, manifestPath);
    expect(reportExitCode(c2)).toBe(0);

    // 4. 2nd apply: plan is [] (present) → no additional add-json call.
    const addCallsBefore = runner.calls.filter((c) => c.args[1] === 'add-json').length;
    await apply(adapter, [MCP_ENTRY], 'user', env, manifestPath);
    const addCallsAfter = runner.calls.filter((c) => c.args[1] === 'add-json').length;
    expect(addCallsAfter).toBe(addCallsBefore);

    // 5. remove → delegated remove of OUR server only; personal survives.
    await remove(adapter, [MCP_ENTRY], 'user', env, manifestPath);
    const removeCalls = runner.calls.filter((c) => c.args[1] === 'remove');
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0]!.args[2]).toBe(SERVER_ID);
    // No remove was ever issued for the personal server.
    expect(runner.calls.some((c) => c.args[1] === 'remove' && c.args[2] === 'personal')).toBe(
      false,
    );

    const afterRemove = await readClaudeJson(env);
    const serversRemoved = afterRemove['mcpServers'] as Record<string, unknown>;
    expect(serversRemoved[SERVER_ID]).toBeUndefined();
    expect(serversRemoved['personal']).toEqual(PERSONAL);
    expect(afterRemove['numStartups']).toBe(7);

    // Manifest no longer tracks the entry.
    const manifestAfter = await readManifest(manifestPath);
    expect(findEntry(manifestAfter, MCP_ENTRY.id, 'user', 'claude')).toBeUndefined();

    // 6. check: missing again → exit 3.
    const c3 = await check(adapter, [MCP_ENTRY], 'user', env, manifestPath);
    expect(reportExitCode(c3)).toBe(3);
  });

  it('env-ref ${GITHUB_TOKEN} rides verbatim through apply → disk → manifest; real value never leaks', async () => {
    const SENTINEL = 'ghp-real-secret-DO-NOT-PERSIST-42';
    const runner = makeFakeClaudeMcpRunner(env);
    const adapter = createClaudeAdapter({
      denyRef: [],
      mcpSource: () => ({
        server: SERVER_ID,
        config: RENDERED_CONFIG,
        secretRefs: { GITHUB_TOKEN: 'GITHUB_TOKEN' },
      }),
      mcpRunner: runner,
    });
    const manifestPath = resolveUserTargets(env).stateJson;

    const hadToken = Object.prototype.hasOwnProperty.call(process.env, 'GITHUB_TOKEN');
    const prev = process.env['GITHUB_TOKEN'];
    process.env['GITHUB_TOKEN'] = SENTINEL;
    try {
      await apply(adapter, [MCP_ENTRY], 'user', env, manifestPath);

      const claudeJsonRaw = await fs.readFile(
        path.join(resolveHome(env), '.claude.json'),
        'utf-8',
      );
      expect(claudeJsonRaw).toContain('${GITHUB_TOKEN}');
      expect(claudeJsonRaw).not.toContain(SENTINEL);

      const manifestRaw = await fs.readFile(manifestPath, 'utf-8');
      expect(manifestRaw).toContain('${GITHUB_TOKEN}');
      expect(manifestRaw).not.toContain(SENTINEL);

      const manifest = await readManifest(manifestPath);
      const applied = findEntry(manifest, MCP_ENTRY.id, 'user', 'claude')!
        .applied as AppliedClaudeMcp;
      expect((applied.config as { env?: Record<string, string> }).env).toEqual({
        GITHUB_TOKEN: '${GITHUB_TOKEN}',
      });
      expect(applied.secretRefs).toEqual({ GITHUB_TOKEN: 'GITHUB_TOKEN' });
    } finally {
      if (hadToken) {
        process.env['GITHUB_TOKEN'] = prev;
      } else {
        delete process.env['GITHUB_TOKEN'];
      }
    }
  });
});
