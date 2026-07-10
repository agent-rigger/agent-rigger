/**
 * MCP handler for the opencode adapter.
 *
 * Manages the `mcp` key of opencode.json (user-scope or project-scope). Mirrors
 * opencode/guardrails.ts's shape (audit/plan/planRemove/apply/applyRemove)
 * applied to a different target: a map of server id → OpencodeMcpServer instead
 * of a permission fragment. Merge is at SERVER granularity (design.md §7.1, R7.3):
 * a pre-existing server of the same id is preserved, never overwritten — matching
 * core `mergeMcp`'s semantics.
 *
 * Secrets (ADR-0019): the caller (the adapter, via a `mcpSource` resolver) is
 * responsible for resolving the server config; it already carries `${VAR}`
 * env-refs, never literal values. This module treats `config` verbatim — it
 * never reads, resolves, or substitutes secret values.
 *
 * Invariants:
 * - auditMcp and planMcp/planRemoveMcp are read-only: no filesystem writes.
 * - applyMcp/applyRemoveMcp preserve every other key in opencode.json
 *   ($schema, permission, agent, other mcp servers); only the named server
 *   entry under `mcp` is touched.
 * - All functions accept an injectable env and optional cwd for HOME isolation in tests.
 * - No while loops; async uses for...of / map.
 */

import { isDeepStrictEqual } from 'node:util';

import { hasMcp, mergeMcp, removeMcp } from '@agent-rigger/core';
import type { AdoptionResult } from '@agent-rigger/core/adapter';
import {
  resolveOpencodeProjectTargets,
  resolveOpencodeUserTargets,
} from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type {
  NatureReport,
  OpencodeMcpServer,
  RemovalOp,
  Scope,
  WriteOp,
  WriteOpMergeMcp,
} from '@agent-rigger/core/types';
import { applyOpencodeKey, readOpencodeJson } from './opencode-json-io';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Resolve the opencode.json path for the given scope. */
function resolveOpencodeJsonPath(scope: Scope, env: Env, cwd?: string): string {
  if (scope === 'project') {
    return resolveOpencodeProjectTargets(cwd).opencodeJson;
  }
  return resolveOpencodeUserTargets(env).opencodeJson;
}

/** Extract the `mcp` key from a parsed opencode.json. Absent/invalid → {}. */
function extractMcp(settings: Record<string, unknown>): Record<string, OpencodeMcpServer> {
  const mcp = settings['mcp'];
  if (mcp === null || typeof mcp !== 'object' || Array.isArray(mcp)) {
    return {};
  }
  return mcp as Record<string, OpencodeMcpServer>;
}

// ---------------------------------------------------------------------------
// auditMcp
// ---------------------------------------------------------------------------

/**
 * Audit the current state of an MCP server declaration on disk.
 *
 * Reads opencode.json at the scope-appropriate path and checks whether `server`
 * is declared in the `mcp` map.
 *
 * Returns:
 * - state 'present' if the server id is declared (no drift check for now — the
 *   config is opaque server-side data, not a fragment we own leaf-by-leaf).
 * - state 'missing' otherwise.
 *
 * Read-only: no filesystem writes.
 *
 * @param scope   Installation scope.
 * @param env     Injectable env for HOME resolution.
 * @param server  The MCP server id (key under `mcp`) to verify.
 * @param cwd     Working directory (only used when scope is 'project').
 */
export async function auditMcp(
  scope: Scope,
  env: Env,
  server: string,
  cwd?: string,
): Promise<NatureReport> {
  const opencodeJsonPath = resolveOpencodeJsonPath(scope, env, cwd);
  const settings = await readOpencodeJson(opencodeJsonPath);
  const current = extractMcp(settings);

  return {
    id: server,
    nature: 'mcp',
    state: hasMcp(current, server) ? 'present' : 'missing',
  };
}

// ---------------------------------------------------------------------------
// planMcp
// ---------------------------------------------------------------------------

/**
 * Compute the write operations needed to install an MCP server.
 *
 * Returns [] when the server is already declared (idempotent — a pre-existing
 * server of the same id is preserved, matching `mergeMcp`'s semantics). Returns
 * [{ kind: 'merge-mcp', path, server, config, description }] otherwise.
 *
 * Read-only: no filesystem writes.
 *
 * @param scope   Installation scope.
 * @param env     Injectable env for HOME resolution.
 * @param server  The MCP server id to install.
 * @param config  The (already resolved) server config — env-refs only, never literal secrets.
 * @param cwd     Working directory (only used when scope is 'project').
 */
export async function planMcp(
  scope: Scope,
  env: Env,
  server: string,
  config: OpencodeMcpServer,
  cwd?: string,
): Promise<WriteOp[]> {
  const report = await auditMcp(scope, env, server, cwd);
  if (report.state === 'present') {
    return [];
  }

  const opencodeJsonPath = resolveOpencodeJsonPath(scope, env, cwd);
  const op: WriteOpMergeMcp = {
    kind: 'merge-mcp',
    path: opencodeJsonPath,
    server,
    config,
    description: `Merge opencode MCP server "${server}"`,
  };
  return [op];
}

// ---------------------------------------------------------------------------
// planRemoveMcp
// ---------------------------------------------------------------------------

/**
 * Compute the removal operations needed to uninstall an MCP server.
 *
 * Returns [{ kind: 'remove-mcp', path, server }] when the server is currently
 * declared. Returns [] when absent (idempotent inverse of a full install).
 *
 * Read-only: no filesystem writes.
 *
 * @param scope   Installation scope.
 * @param env     Injectable env for HOME resolution.
 * @param server  The MCP server id to remove.
 * @param cwd     Working directory (only used when scope is 'project').
 */
export async function planRemoveMcp(
  scope: Scope,
  env: Env,
  server: string,
  cwd?: string,
): Promise<RemovalOp[]> {
  const report = await auditMcp(scope, env, server, cwd);
  if (report.state !== 'present') {
    return [];
  }

  const opencodeJsonPath = resolveOpencodeJsonPath(scope, env, cwd);
  return [{ kind: 'remove-mcp', path: opencodeJsonPath, server }];
}

// ---------------------------------------------------------------------------
// adoptMcp
// ---------------------------------------------------------------------------

/**
 * Adopt gate for the opencode mcp nature (R5/D5, FM5).
 *
 * Adopts ONLY when the server is declared on disk AND its config DEEP-EQUALS the
 * canonical config. Presence alone is NOT enough here (unlike auditMcp, which is
 * key-only): a personal, divergent config for the same server id must NEVER be
 * adopted — recording the canonical would let `remove` strip the user's real
 * config and "restore" a wrong one (FM5). The recorded payload carries the
 * canonical server + config so remove subtracts exactly what was installed.
 *
 * Returns `undefined` (refusal) when the server key is absent, or present with
 * ANY difference from the canonical config.
 *
 * Read-only: no filesystem writes.
 *
 * @param scope   Installation scope.
 * @param env     Injectable env for HOME resolution.
 * @param server  The canonical MCP server id.
 * @param config  The canonical server config to deep-compare against disk.
 * @param cwd     Working directory (only used when scope is 'project').
 */
export async function adoptMcp(
  scope: Scope,
  env: Env,
  server: string,
  config: OpencodeMcpServer,
  cwd?: string,
): Promise<AdoptionResult | undefined> {
  const opencodeJsonPath = resolveOpencodeJsonPath(scope, env, cwd);
  const settings = await readOpencodeJson(opencodeJsonPath);
  const current = extractMcp(settings);

  const onDisk = current[server];
  if (onDisk === undefined || !isDeepStrictEqual(onDisk, config)) {
    return undefined;
  }

  return {
    applied: { kind: 'opencode-mcp', server, config },
    files: [opencodeJsonPath],
  };
}

// ---------------------------------------------------------------------------
// applyMcp
// ---------------------------------------------------------------------------

/**
 * Execute merge-mcp write operations produced by planMcp.
 *
 * For each merge-mcp op:
 * 1. Read the current opencode.json (returns {} if absent).
 * 2. Merge op.server/op.config into the current `mcp` map via mergeMcp
 *    (a pre-existing server of the same id is never overwritten).
 * 3. Write back, preserving ALL other keys ($schema, permission, agent, ...).
 *
 * Ops of any other kind are ignored (forward-compatibility).
 *
 * @param ops  Write operations (only 'merge-mcp' are processed).
 * @param env  Injectable env (kept for interface symmetry).
 */
export async function applyMcp(ops: WriteOp[], _env: Env): Promise<void> {
  for (const op of ops) {
    if (op.kind === 'merge-mcp') {
      const settings = await readOpencodeJson(op.path);
      const current = extractMcp(settings);
      const merged = mergeMcp(current, op.server, op.config);
      await applyOpencodeKey(op.path, 'mcp', merged);
    }
  }
}

// ---------------------------------------------------------------------------
// applyRemoveMcp
// ---------------------------------------------------------------------------

/**
 * Execute remove-mcp removal operations produced by planRemoveMcp.
 *
 * For each remove-mcp op:
 * 1. Read the current opencode.json.
 * 2. Remove exactly the named server via removeMcp (other servers untouched).
 * 3. Write back, preserving ALL other keys ($schema, permission, agent, ...).
 *
 * Ops of any other kind are ignored (forward-compatibility).
 *
 * @param ops  Removal operations (only 'remove-mcp' are processed).
 * @param env  Injectable env (kept for interface symmetry).
 */
export async function applyRemoveMcp(ops: RemovalOp[], _env: Env): Promise<void> {
  for (const op of ops) {
    if (op.kind === 'remove-mcp') {
      const settings = await readOpencodeJson(op.path);
      const current = extractMcp(settings);
      const updated = removeMcp(current, op.server);
      await applyOpencodeKey(op.path, 'mcp', updated);
    }
  }
}
