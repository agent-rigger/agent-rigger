/**
 * End-to-end lifecycle integration tests for opencode nature 'mcp'.
 *
 * These drive the REAL adapter (createOpencodeAdapter) through the REAL
 * core/engine (apply → check → remove) so the manifest round-trip is exercised
 * alongside the on-disk opencode.json mutation — the dimensions the unit-level
 * mcp.test.ts intentionally leaves out.
 *
 * Non-duplication with mcp.test.ts:
 * - mcp.test.ts already covers the USER-scope adapter-direct E2E (audit/plan/
 *   apply/planRemove/applyRemove, no engine) and applyMcp-direct env-ref survival
 *   after a single apply. This file ADDS:
 *   (a) PROJECT-scope full lifecycle through the engine, with a pre-filled
 *       project opencode.json whose foreign $schema / permission / other mcp
 *       server all survive BOTH the merge AND the remove, plus manifest tracking.
 *   (b) Explicit idempotence at the engine layer (2nd apply writes nothing) AND
 *       at the plan layer (2nd plan → []), at PROJECT scope.
 *   (c) An env-indirection secret "${SOME_TOKEN}" that round-trips verbatim
 *       through apply → remove — on disk AND in the manifest applied payload —
 *       while the real value it would expand to never appears in any artifact.
 *
 * Every assertion is load-bearing: a no-op install, a no-op remove, a merge that
 * drops foreign content, or an env-ref expansion would each fail a check here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply, check, remove } from '@agent-rigger/core/engine';
import { readJson, writeJson } from '@agent-rigger/core/fs-json';
import { findEntry, readManifest } from '@agent-rigger/core/manifest';
import {
  resolveOpencodeProjectTargets,
  resolveOpencodeUserTargets,
  resolveUserTargets,
} from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { AppliedOpencodeMcp, OpencodeMcpServer } from '@agent-rigger/core/types';

import { createOpencodeAdapter } from '../../src/opencode/adapter';

// ---------------------------------------------------------------------------
// Helpers (inlined per opencode-adapter test convention — no shared helper)
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-opencode-e2e-mcp-'): Promise<{
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

/**
 * A project opencode.json with third-party content the adapter does NOT own:
 * a foreign $schema, a user permission, and a pre-existing unrelated mcp server.
 * All three must survive both the merge and the remove.
 */
const PROJECT_PREPOPULATED = {
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
// (a)+(b) PROJECT scope full lifecycle through the real engine
// ---------------------------------------------------------------------------

describe('opencode mcp — project-scope lifecycle through the real engine', () => {
  const PROJECT_ENTRY: AdapterEntry = { id: 'mcp:github', nature: 'mcp', scope: 'project' };

  it('apply→check→remove: foreign project content survives merge AND remove; idempotent', async () => {
    // The opencode adapter resolves project targets from process.cwd(), so the
    // whole engine round-trip must run with cwd chdir'd into the tmp home. We
    // read cwd back AFTER chdir (macOS resolves /var → /private/var) so the path
    // we pre-fill and assert on is byte-for-byte the one the adapter computes.
    const originalCwd = process.cwd();
    try {
      process.chdir(tmp.dir);
      const projectCwd = process.cwd();
      const targets = resolveOpencodeProjectTargets(projectCwd);
      const manifestPath = resolveUserTargets(env).stateJson;

      await writeJson(targets.opencodeJson, PROJECT_PREPOPULATED);

      const adapter = createOpencodeAdapter({
        mcpSource: () => ({ server: SERVER_ID, config: SERVER_CONFIG }),
      });

      // BEFORE — the adapter reads the pre-filled file and does not confuse the
      // foreign 'existing' server for ours.
      const auditBefore = await adapter.audit(PROJECT_ENTRY, 'project', env);
      expect(auditBefore.state).toBe('missing');
      const checkBefore = await check(adapter, [PROJECT_ENTRY], 'project', env, manifestPath);
      expect(checkBefore.entries[0]!.state).toBe('missing');

      // APPLY — writes the project opencode.json and records a manifest entry.
      const applyResult = await apply({
        adapter,
        entries: [PROJECT_ENTRY],
        scope: 'project',
        env,
        manifestPath,
      });
      expect(applyResult.written).toContain(targets.opencodeJson);

      const checkAfter = await check(adapter, [PROJECT_ENTRY], 'project', env, manifestPath);
      expect(checkAfter.entries[0]!.state).toBe('present');

      // Manifest tracks (id, project, opencode) with the verbatim applied payload.
      const manifest = await readManifest(manifestPath);
      const tracked = findEntry(manifest, PROJECT_ENTRY.id, 'project', 'opencode');
      expect(tracked).toBeDefined();
      const applied = tracked!.applied as AppliedOpencodeMcp;
      expect(applied.kind).toBe('opencode-mcp');
      expect(applied.server).toBe(SERVER_ID);

      // Foreign content survives the merge; our server is present with its config.
      const merged = await readJson(targets.opencodeJson);
      expect(merged['$schema']).toBe(PROJECT_PREPOPULATED.$schema);
      expect(merged['permission']).toEqual(PROJECT_PREPOPULATED.permission);
      const mcpMerged = merged['mcp'] as Record<string, OpencodeMcpServer>;
      expect(mcpMerged['existing']).toEqual(PROJECT_PREPOPULATED.mcp.existing);
      expect(mcpMerged[SERVER_ID]).toEqual(SERVER_CONFIG);

      // IDEMPOTENCE — a 2nd engine apply writes nothing, and the 2nd plan is [].
      const applyAgain = await apply({
        adapter,
        entries: [PROJECT_ENTRY],
        scope: 'project',
        env,
        manifestPath,
      });
      expect(applyAgain.written).toHaveLength(0);
      const replan = await adapter.plan(PROJECT_ENTRY, 'project', env);
      expect(replan).toHaveLength(0);

      // REMOVE — drops exactly our server; keeps every foreign key.
      const removeResult = await remove(adapter, [PROJECT_ENTRY], 'project', env, manifestPath);
      expect(removeResult.removed).toContain(PROJECT_ENTRY.id);

      const checkRemoved = await check(adapter, [PROJECT_ENTRY], 'project', env, manifestPath);
      expect(checkRemoved.entries[0]!.state).toBe('missing');

      const cleaned = await readJson(targets.opencodeJson);
      expect(cleaned['$schema']).toBe(PROJECT_PREPOPULATED.$schema);
      expect(cleaned['permission']).toEqual(PROJECT_PREPOPULATED.permission);
      const mcpCleaned = cleaned['mcp'] as Record<string, OpencodeMcpServer>;
      expect(mcpCleaned['existing']).toEqual(PROJECT_PREPOPULATED.mcp.existing);
      expect(mcpCleaned[SERVER_ID]).toBeUndefined();

      // Manifest no longer tracks the entry after remove.
      const manifestAfter = await readManifest(manifestPath);
      expect(findEntry(manifestAfter, PROJECT_ENTRY.id, 'project', 'opencode')).toBeUndefined();
    } finally {
      process.chdir(originalCwd);
    }
  });
});

// ---------------------------------------------------------------------------
// (c) env-indirection secret round-trips verbatim, never expanded (ADR-0019)
// ---------------------------------------------------------------------------

describe('opencode mcp — env-indirection secret round-trips verbatim', () => {
  const SECRET_REF = '${SOME_TOKEN}';
  const SENTINEL = 'super-secret-literal-value-DO-NOT-WRITE';
  const SECRET_SERVER = 'secret-svc';
  const SECRET_CONFIG: OpencodeMcpServer = {
    type: 'local',
    command: ['npx', '-y', 'some-mcp-server'],
    environment: { SOME_TOKEN: SECRET_REF },
  };
  const SECRET_ENTRY: AdapterEntry = { id: 'mcp:secret-svc', nature: 'mcp', scope: 'user' };

  it('apply→remove keeps ${SOME_TOKEN} literal on disk AND in the manifest; the real value never leaks', async () => {
    const targets = resolveOpencodeUserTargets(env);
    const manifestPath = resolveUserTargets(env).stateJson;
    const adapter = createOpencodeAdapter({
      mcpSource: () => ({ server: SECRET_SERVER, config: SECRET_CONFIG }),
    });

    // A real env var whose value WOULD be substituted if the adapter ever
    // expanded env-refs. It must never surface in any written artifact.
    const hadToken = Object.prototype.hasOwnProperty.call(process.env, 'SOME_TOKEN');
    const prevToken = process.env['SOME_TOKEN'];
    process.env['SOME_TOKEN'] = SENTINEL;
    try {
      await apply({ adapter, entries: [SECRET_ENTRY], scope: 'user', env, manifestPath });

      // On disk: the env-ref is preserved literally; the real value never appears.
      const rawAfterApply = await fs.readFile(targets.opencodeJson, 'utf-8');
      expect(rawAfterApply).toContain(SECRET_REF);
      expect(rawAfterApply).not.toContain(SENTINEL);

      const parsed = await readJson(targets.opencodeJson);
      const mcp = parsed['mcp'] as Record<string, OpencodeMcpServer>;
      const server = mcp[SECRET_SERVER] as { environment?: Record<string, string> };
      expect(server.environment).toEqual({ SOME_TOKEN: SECRET_REF });

      // In the manifest applied payload: env-ref preserved verbatim (round-trip),
      // real value absent.
      const manifest = await readManifest(manifestPath);
      const tracked = findEntry(manifest, SECRET_ENTRY.id, 'user', 'opencode');
      expect(tracked).toBeDefined();
      const applied = tracked!.applied as AppliedOpencodeMcp;
      const appliedEnv = (applied.config as { environment?: Record<string, string> }).environment;
      expect(appliedEnv).toEqual({ SOME_TOKEN: SECRET_REF });
      const rawManifest = await fs.readFile(manifestPath, 'utf-8');
      expect(rawManifest).toContain(SECRET_REF);
      expect(rawManifest).not.toContain(SENTINEL);

      // REMOVE — our server is dropped, and the real value leaked at no point.
      const removeResult = await remove(adapter, [SECRET_ENTRY], 'user', env, manifestPath);
      expect(removeResult.removed).toContain(SECRET_ENTRY.id);

      const rawAfterRemove = await fs.readFile(targets.opencodeJson, 'utf-8');
      expect(rawAfterRemove).not.toContain(SENTINEL);
      const parsedAfter = await readJson(targets.opencodeJson);
      const mcpAfter = (parsedAfter['mcp'] ?? {}) as Record<string, OpencodeMcpServer>;
      expect(mcpAfter[SECRET_SERVER]).toBeUndefined();
    } finally {
      if (hadToken) {
        process.env['SOME_TOKEN'] = prevToken;
      } else {
        delete process.env['SOME_TOKEN'];
      }
    }
  });
});
