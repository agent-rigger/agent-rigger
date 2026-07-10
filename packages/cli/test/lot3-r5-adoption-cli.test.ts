/**
 * Tests for lot3-robustesse-moteur R5 — the CLI wiring of adoption (design D5,
 * task T7).
 *
 * The `groups.length === 0` short-circuit in cmd-install used to return
 * "up-to-date" WITHOUT ever reaching apply() — so an artifact present on disk
 * but absent from the manifest (M4, typically after a manifest loss) could never
 * be adopted through the CLI. This test proves that:
 *
 *  - a guardrail already on disk with an empty manifest is ADOPTED (the apply is
 *    reached even though the plan is empty), the "adopted (already present on
 *    disk)" line is rendered, NO confirmation is requested (only state.json
 *    changes), and a following `check` exits 0;
 *  - an mcp server whose disk config DIVERGES from the canonical is NOT adopted
 *    (FM5) — the run stays a truthful "up to date" no-op;
 *  - a genuinely up-to-date run (entry already tracked) keeps the unchanged
 *    "already up to date" short-circuit (no confirm, no adoption).
 *
 * Isolation: fresh RIGGER_HOME tmp dir per test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { check, reportExitCode } from '@agent-rigger/core/engine';
import { writeJson } from '@agent-rigger/core/fs-json';
import { findEntry, readManifest, writeManifest } from '@agent-rigger/core/manifest';
import { resolveOpencodeUserTargets, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { OpencodeMcpServer, OpencodePermission } from '@agent-rigger/core/types';

import { createOpencodeAdapter } from '@agent-rigger/adapters';

import type { CatalogEntry } from '@agent-rigger/catalog';

import { runInstall } from '../src/cmd-install';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-lot3-r5-cli-'): Promise<{
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

const REF_PERMISSION: OpencodePermission = {
  read: { '.env.local': 'deny', '.env.example': 'allow' },
  edit: { '.env.local': 'deny', '.env.example': 'allow' },
};

const CANONICAL_MCP: OpencodeMcpServer = {
  type: 'remote',
  url: 'https://mcp.context7.com/mcp',
};

const DIVERGENT_MCP: OpencodeMcpServer = {
  type: 'remote',
  url: 'https://mcp.context7.com/mcp',
  headers: { Authorization: 'Bearer personal-token' },
};

const OPENCODE_GUARDRAIL: CatalogEntry = {
  kind: 'artifact',
  id: 'guardrails-opencode',
  nature: 'guardrail',
  targets: ['opencode'],
  scopes: ['user', 'project'],
};

const OPENCODE_MCP: CatalogEntry = {
  kind: 'artifact',
  id: 'mcp:context7',
  nature: 'mcp',
  targets: ['opencode'],
  scopes: ['user', 'project'],
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let manifestPath: string;
let opencodeTargets: ReturnType<typeof resolveOpencodeUserTargets>;

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
  manifestPath = resolveUserTargets(env).stateJson;
  opencodeTargets = resolveOpencodeUserTargets(env);
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// Guardrail adoption via the CLI
// ---------------------------------------------------------------------------

describe('runInstall — lot3 R5 adoption (opencode guardrail)', () => {
  it('lot3-R5: a guardrail on disk with an empty manifest is adopted (apply reached, "adopted" line, no confirm)', async () => {
    const adapter = createOpencodeAdapter({ permission: REF_PERMISSION });

    // Install normally, then lose the manifest (M2 reset).
    await runInstall({
      catalog: [OPENCODE_GUARDRAIL],
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['guardrails-opencode'],
      confirm: true,
    });
    await writeManifest(manifestPath, { version: 1, artifacts: [] });

    let confirmCallCount = 0;
    const result = await runInstall({
      catalog: [OPENCODE_GUARDRAIL],
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['guardrails-opencode'],
      confirm: async () => {
        confirmCallCount++;
        return true;
      },
    });

    // Adoption is due → the empty-plan short-circuit no longer skips apply.
    // No confirmation is requested (only state.json changes).
    expect(confirmCallCount).toBe(0);
    expect(result.output).toContain('adopted (already present on disk)');

    // The entry is recorded in state.json with the canonical payload.
    const persisted = await readManifest(manifestPath);
    const recorded = findEntry(persisted, 'guardrails-opencode', 'user', 'opencode');
    expect(recorded).toBeDefined();
    expect(recorded?.applied).toEqual({ kind: 'opencode-permission', permission: REF_PERMISSION });
  });

  it('lot3-R5: check exits 0 after CLI adoption', async () => {
    const adapter = createOpencodeAdapter({ permission: REF_PERMISSION });

    await runInstall({
      catalog: [OPENCODE_GUARDRAIL],
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['guardrails-opencode'],
      confirm: true,
    });
    await writeManifest(manifestPath, { version: 1, artifacts: [] });

    await runInstall({
      catalog: [OPENCODE_GUARDRAIL],
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['guardrails-opencode'],
      confirm: true,
    });

    const entry: AdapterEntry = { id: 'guardrails-opencode', nature: 'guardrail', scope: 'user' };
    const report = await check(adapter, [entry], 'user', env, manifestPath);
    expect(reportExitCode(report)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// mcp divergent — NOT adopted (FM5)
// ---------------------------------------------------------------------------

describe('runInstall — lot3 R5 adoption gate (opencode mcp FM5)', () => {
  it('lot3-R5: an mcp server whose disk config diverges from the canonical is NOT adopted', async () => {
    const adapter = createOpencodeAdapter({
      mcpSource: () => ({ server: 'context7', config: CANONICAL_MCP }),
    });

    // Seed opencode.json with the SAME server id but a PERSONAL divergent config,
    // and an empty manifest → the plan is empty (server present) but adoption
    // must be refused (deep-equal fails, FM5).
    await writeJson(opencodeTargets.opencodeJson, { mcp: { context7: DIVERGENT_MCP } });

    let confirmCallCount = 0;
    const result = await runInstall({
      catalog: [OPENCODE_MCP],
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['mcp:context7'],
      confirm: async () => {
        confirmCallCount++;
        return true;
      },
    });

    // No adoption: the run stays a truthful "up to date" no-op, no confirm.
    expect(confirmCallCount).toBe(0);
    expect(result.output).not.toContain('adopted');
    expect(result.output.toLowerCase()).toContain('already up to date');

    const persisted = await readManifest(manifestPath);
    expect(findEntry(persisted, 'mcp:context7', 'user', 'opencode')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Genuinely up-to-date — unchanged short-circuit
// ---------------------------------------------------------------------------

describe('runInstall — lot3 R5 up-to-date short-circuit preserved', () => {
  it('lot3-R5: a tracked entry (no adoption due) keeps the "already up to date" no-op without confirm', async () => {
    const adapter = createOpencodeAdapter({ permission: REF_PERMISSION });

    // First install records the entry in the manifest.
    await runInstall({
      catalog: [OPENCODE_GUARDRAIL],
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['guardrails-opencode'],
      confirm: true,
    });

    let confirmCallCount = 0;
    const result = await runInstall({
      catalog: [OPENCODE_GUARDRAIL],
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['guardrails-opencode'],
      confirm: async () => {
        confirmCallCount++;
        return true;
      },
    });

    expect(confirmCallCount).toBe(0);
    expect(result.output.toLowerCase()).toContain('already up to date');
    expect(result.output).not.toContain('adopted');
  });
});
