/**
 * Tests for opencode/mcp handler (TDD — written before implementation).
 *
 * Covers:
 * - auditMcp: opencode.json absent → missing; server absent from `mcp` map → missing;
 *   server declared → present.
 * - planMcp: absent → 1 merge-mcp op; already present → [] (idempotent, a pre-existing
 *   server of the same id is preserved).
 * - planRemoveMcp: installed → 1 remove-mcp op (exact server id); absent → [].
 * - applyMcp (merge-mcp): merges into opencode.json, preserves $schema/permission/other
 *   mcp servers; never overwrites a pre-existing server of the same id.
 * - applyRemoveMcp (remove-mcp): removes exactly the named server, preserves everything else.
 * - env-ref config round-trips verbatim (ADR-0019): no literal secret value is ever written.
 * - end-to-end via createOpencodeAdapter: check missing → apply → check present → remove →
 *   check missing, idempotent, opencode.json pre-populated survives the whole cycle.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { readJson, writeJson } from '@agent-rigger/core/fs-json';
import {
  resolveOpencodeProjectTargets,
  resolveOpencodeUserTargets,
} from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { OpencodeMcpServer, WriteOpMergeMcp } from '@agent-rigger/core/types';

import { createOpencodeAdapter } from '../../src/opencode/adapter';
import { applyMcp, applyRemoveMcp, auditMcp, planMcp, planRemoveMcp } from '../../src/opencode/mcp';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-opencode-mcp-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVER_ID = 'github';
const SERVER_CONFIG: OpencodeMcpServer = {
  type: 'local',
  command: ['npx', '-y', '@modelcontextprotocol/server-github'],
  environment: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
};

const PREPOPULATED = {
  $schema: 'https://opencode.ai/config.json',
  permission: { edit: 'ask' as const },
  mcp: { existing: { type: 'remote' as const, url: 'https://example.com/mcp' } },
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
// auditMcp
// ---------------------------------------------------------------------------

describe('auditMcp — user scope', () => {
  it('returns missing when opencode.json does not exist', async () => {
    const report = await auditMcp('user', env, SERVER_ID);

    expect(report.state).toBe('missing');
    expect(report.nature).toBe('mcp');
    expect(report.id).toBe(SERVER_ID);
  });

  it('returns missing when the mcp map exists but the server is absent', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await writeJson(targets.opencodeJson, PREPOPULATED);

    const report = await auditMcp('user', env, SERVER_ID);

    expect(report.state).toBe('missing');
  });

  it('returns present when the server is declared', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await writeJson(targets.opencodeJson, { mcp: { [SERVER_ID]: SERVER_CONFIG } });

    const report = await auditMcp('user', env, SERVER_ID);

    expect(report.state).toBe('present');
  });
});

describe('auditMcp — project scope', () => {
  it('returns present when project opencode.json has the server', async () => {
    const cwd = tmp.dir;
    const targets = resolveOpencodeProjectTargets(cwd);
    await writeJson(targets.opencodeJson, { mcp: { [SERVER_ID]: SERVER_CONFIG } });

    const report = await auditMcp('project', env, SERVER_ID, cwd);

    expect(report.state).toBe('present');
  });
});

// ---------------------------------------------------------------------------
// planMcp
// ---------------------------------------------------------------------------

describe('planMcp', () => {
  it('returns a merge-mcp op with the given server/config when opencode.json is absent', async () => {
    const ops = await planMcp('user', env, SERVER_ID, SERVER_CONFIG);

    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('merge-mcp');
    const op = ops[0] as WriteOpMergeMcp;
    expect(op.server).toBe(SERVER_ID);
    expect(op.config).toEqual(SERVER_CONFIG);
  });

  it('returns [] when the server is already present (idempotent)', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await writeJson(targets.opencodeJson, { mcp: { [SERVER_ID]: SERVER_CONFIG } });

    const ops = await planMcp('user', env, SERVER_ID, SERVER_CONFIG);

    expect(ops).toHaveLength(0);
  });

  it('op path targets the opencode.json path for the given scope', async () => {
    const targets = resolveOpencodeUserTargets(env);
    const ops = await planMcp('user', env, SERVER_ID, SERVER_CONFIG);

    const op = ops[0] as WriteOpMergeMcp;
    expect(op.path).toBe(targets.opencodeJson);
  });

  it('uses the project opencode.json path when scope is project', async () => {
    const cwd = tmp.dir;
    const targets = resolveOpencodeProjectTargets(cwd);
    const ops = await planMcp('project', env, SERVER_ID, SERVER_CONFIG, cwd);

    const op = ops[0] as WriteOpMergeMcp;
    expect(op.path).toBe(targets.opencodeJson);
  });
});

// ---------------------------------------------------------------------------
// planRemoveMcp
// ---------------------------------------------------------------------------

describe('planRemoveMcp', () => {
  it('returns [] when not installed', async () => {
    const ops = await planRemoveMcp('user', env, SERVER_ID);

    expect(ops).toHaveLength(0);
  });

  it('returns a remove-mcp op with the exact server id when installed', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await writeJson(targets.opencodeJson, { mcp: { [SERVER_ID]: SERVER_CONFIG } });

    const ops = await planRemoveMcp('user', env, SERVER_ID);

    expect(ops).toEqual([{ kind: 'remove-mcp', path: targets.opencodeJson, server: SERVER_ID }]);
  });
});

// ---------------------------------------------------------------------------
// applyMcp
// ---------------------------------------------------------------------------

describe('applyMcp', () => {
  it('merges the server while preserving $schema, permission, and other mcp servers', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await writeJson(targets.opencodeJson, PREPOPULATED);

    await applyMcp(
      [{
        kind: 'merge-mcp',
        path: targets.opencodeJson,
        server: SERVER_ID,
        config: SERVER_CONFIG,
        description: 'x',
      }],
      env,
    );

    const result = await readJson(targets.opencodeJson);
    expect(result['$schema']).toBe(PREPOPULATED.$schema);
    expect(result['permission']).toEqual(PREPOPULATED.permission);
    const mcp = result['mcp'] as Record<string, OpencodeMcpServer>;
    expect(mcp['existing']).toEqual(PREPOPULATED.mcp.existing);
    expect(mcp[SERVER_ID]).toEqual(SERVER_CONFIG);
  });

  it('preserves a pre-existing server of the same id (never overwrites)', async () => {
    const targets = resolveOpencodeUserTargets(env);
    const original: OpencodeMcpServer = { type: 'remote', url: 'https://original.example.com' };
    await writeJson(targets.opencodeJson, { mcp: { [SERVER_ID]: original } });

    await applyMcp(
      [{
        kind: 'merge-mcp',
        path: targets.opencodeJson,
        server: SERVER_ID,
        config: SERVER_CONFIG,
        description: 'x',
      }],
      env,
    );

    const result = await readJson(targets.opencodeJson);
    const mcp = result['mcp'] as Record<string, OpencodeMcpServer>;
    expect(mcp[SERVER_ID]).toEqual(original);
  });

  it('is idempotent: applying twice does not change the result', async () => {
    const targets = resolveOpencodeUserTargets(env);
    const op: WriteOpMergeMcp = {
      kind: 'merge-mcp',
      path: targets.opencodeJson,
      server: SERVER_ID,
      config: SERVER_CONFIG,
      description: 'x',
    };

    await applyMcp([op], env);
    const once = await readJson(targets.opencodeJson);
    await applyMcp([op], env);
    const twice = await readJson(targets.opencodeJson);

    expect(twice).toEqual(once);
  });

  it('never writes a literal secret value — the env-ref round-trips verbatim', async () => {
    const targets = resolveOpencodeUserTargets(env);

    await applyMcp(
      [{
        kind: 'merge-mcp',
        path: targets.opencodeJson,
        server: SERVER_ID,
        config: SERVER_CONFIG,
        description: 'x',
      }],
      env,
    );

    const raw = await fs.readFile(targets.opencodeJson, 'utf-8');
    expect(raw).toContain('${GITHUB_TOKEN}');

    const result = await readJson(targets.opencodeJson);
    const mcp = result['mcp'] as Record<string, OpencodeMcpServer>;
    const local = mcp[SERVER_ID] as { environment?: Record<string, string> };
    expect(local.environment).toEqual({ GITHUB_TOKEN: '${GITHUB_TOKEN}' });
  });
});

// ---------------------------------------------------------------------------
// applyRemoveMcp
// ---------------------------------------------------------------------------

describe('applyRemoveMcp', () => {
  it('removes exactly the named server, preserves $schema/permission/other mcp servers', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await writeJson(targets.opencodeJson, {
      ...PREPOPULATED,
      mcp: { ...PREPOPULATED.mcp, [SERVER_ID]: SERVER_CONFIG },
    });

    await applyRemoveMcp(
      [{ kind: 'remove-mcp', path: targets.opencodeJson, server: SERVER_ID }],
      env,
    );

    const result = await readJson(targets.opencodeJson);
    expect(result['$schema']).toBe(PREPOPULATED.$schema);
    expect(result['permission']).toEqual(PREPOPULATED.permission);
    const mcp = result['mcp'] as Record<string, OpencodeMcpServer>;
    expect(mcp['existing']).toEqual(PREPOPULATED.mcp.existing);
    expect(mcp[SERVER_ID]).toBeUndefined();
  });

  it('is a no-op when the server is already absent', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await writeJson(targets.opencodeJson, PREPOPULATED);

    await applyRemoveMcp(
      [{ kind: 'remove-mcp', path: targets.opencodeJson, server: SERVER_ID }],
      env,
    );

    const result = await readJson(targets.opencodeJson);
    expect(result['mcp']).toEqual(PREPOPULATED.mcp);
  });
});

// ---------------------------------------------------------------------------
// end-to-end via createOpencodeAdapter
// ---------------------------------------------------------------------------

describe('createOpencodeAdapter — mcp end-to-end', () => {
  const MCP_ENTRY: AdapterEntry = { id: 'mcp:github', nature: 'mcp', scope: 'user' };

  it('check missing → apply → check present → remove → check missing (opencode.json pre-populated survives)', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await writeJson(targets.opencodeJson, PREPOPULATED);

    const adapter = createOpencodeAdapter({
      mcpSource: (_e: AdapterEntry) => ({ server: SERVER_ID, config: SERVER_CONFIG }),
    });

    const report1 = await adapter.audit(MCP_ENTRY, 'user', env);
    expect(report1.state).toBe('missing');

    const ops = await adapter.plan(MCP_ENTRY, 'user', env);
    expect(ops).toHaveLength(1);
    await adapter.apply(ops, env);

    const report2 = await adapter.audit(MCP_ENTRY, 'user', env);
    expect(report2.state).toBe('present');

    const afterInstall = await readJson(targets.opencodeJson);
    expect(afterInstall['$schema']).toBe(PREPOPULATED.$schema);
    expect(afterInstall['permission']).toEqual(PREPOPULATED.permission);

    // 2nd plan is a no-op (idempotent)
    const ops2 = await adapter.plan(MCP_ENTRY, 'user', env);
    expect(ops2).toHaveLength(0);

    const removeOps = await adapter.planRemove(MCP_ENTRY, 'user', env);
    expect(removeOps).toHaveLength(1);
    await adapter.applyRemove(removeOps, env);

    const report3 = await adapter.audit(MCP_ENTRY, 'user', env);
    expect(report3.state).toBe('missing');

    const afterRemove = await readJson(targets.opencodeJson);
    expect(afterRemove['$schema']).toBe(PREPOPULATED.$schema);
    const mcp = afterRemove['mcp'] as Record<string, OpencodeMcpServer>;
    expect(mcp['existing']).toEqual(PREPOPULATED.mcp.existing);
  });

  it('planRemove reconstructs the server from entry.applied (offline, mcpSource not required)', async () => {
    const targets = resolveOpencodeUserTargets(env);
    const adapter = createOpencodeAdapter({
      mcpSource: (_e: AdapterEntry) => ({ server: SERVER_ID, config: SERVER_CONFIG }),
    });

    const ops = await adapter.plan(MCP_ENTRY, 'user', env);
    await adapter.apply(ops, env);

    const enriched: AdapterEntry = {
      ...MCP_ENTRY,
      applied: { kind: 'opencode-mcp', server: SERVER_ID, config: SERVER_CONFIG },
    };

    // Adapter WITHOUT mcpSource configured — must still work via entry.applied.
    const adapterNoSource = createOpencodeAdapter({});
    const removeOps = await adapterNoSource.planRemove(enriched, 'user', env);

    expect(removeOps).toEqual([
      { kind: 'remove-mcp', path: targets.opencodeJson, server: SERVER_ID },
    ]);
  });

  it('throws an actionable error when mcpSource is not configured and no applied payload exists', async () => {
    const adapter = createOpencodeAdapter({});

    await expect(adapter.plan(MCP_ENTRY, 'user', env)).rejects.toThrow(/mcpSource/);
  });
});
