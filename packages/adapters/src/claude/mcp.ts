/**
 * MCP handler for the Claude adapter — delegate-first (R8, lot 6, branch A).
 *
 * A Claude Code MCP server is never hand-written into Claude's state file:
 * install and remove DELEGATE to the native CLI (`claude mcp add-json` /
 * `claude mcp remove`), mirroring the plugin nature's runner/ops pattern
 * (plugins.ts) — agent-rigger asks Claude Code to mutate its own config rather
 * than editing the large `~/.claude.json` state file by hand (ADR-0003
 * delegate-first, D6). A personal server the user added by hand is never a
 * target of any command, so it survives install AND remove untouched.
 *
 * READS, by contrast, inspect Claude's config file directly (read-only): this
 * is the robust way to answer "is my server present?" (audit → check) and "is
 * the on-disk descriptor deep-equal to my rendered canonical?" (adopt → FM5),
 * neither of which `claude mcp get`'s human-formatted, non-JSON output can give
 * cleanly. The mapping is Claude's own storage layout (T0):
 *   - user scope    → <home>/.claude.json, top-level `mcpServers`
 *   - project scope → <cwd>/.mcp.json,     top-level `mcpServers`
 *
 * Secrets (ADR-0019, R5): the caller (the adapter, via an `mcpSource` resolver)
 * resolves the server config; it already carries `${VAR}` env-refs rendered
 * VERBATIM — Claude Code expands them itself at server spawn (T0). This module
 * treats `config` verbatim: it never reads, resolves, or substitutes secret
 * values. `secretRefs` (ref→VAR, names only) rides through to the manifest.
 *
 * Invariants:
 * - auditMcp, planMcp, planRemoveMcp, adoptMcp are read-only (no fs writes; the
 *   native `claude` binary is never called in tests — inject a fake runner).
 * - applyMcp / applyRemoveMcp delegate the single named server; no bulk rewrite.
 * - No while loops; no process.exit().
 * - McpAddError / McpRemoveError carry the command string and native stderr verbatim.
 */

import { isDeepStrictEqual } from 'node:util';

import type { AdapterEntry, AdoptionResult } from '@agent-rigger/core/adapter';
import { readText } from '@agent-rigger/core/fs-json';
import type { Env } from '@agent-rigger/core/paths';
import { resolveHome } from '@agent-rigger/core/paths';
import type {
  ClaudeMcpServer,
  NatureReport,
  RemovalOp,
  RemovalOpMcpRemove,
  Scope,
  WriteOp,
  WriteOpMcpAdd,
} from '@agent-rigger/core/types';

import path from 'node:path';

// ---------------------------------------------------------------------------
// McpRunner
// ---------------------------------------------------------------------------

/**
 * Injectable command runner for mcp operations (structurally identical to
 * PluginRunner — both drive the same `claude` binary). Tests inject a fake so
 * the real CLI is never spawned.
 */
export type McpRunner = (
  command: string,
  args: string[],
  opts?: { env?: Record<string, string | undefined> },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/**
 * Default McpRunner backed by Bun.spawn. Spawns the command with piped
 * stdout/stderr, waits for exit, and returns the full output.
 */
export const defaultMcpRunner: McpRunner = async (
  command: string,
  args: string[],
  opts?: { env?: Record<string, string | undefined> },
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const mergedEnv = opts?.env === undefined
    ? process.env
    : { ...process.env, ...opts.env };

  const proc = Bun.spawn([command, ...args], {
    env: mergedEnv as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by applyMcp when `claude mcp add-json` exits non-zero. Carries the
 * command string and native stderr verbatim so callers surface the original
 * error untransformed.
 */
export class McpAddError extends Error {
  readonly command: string;
  readonly stderr: string;

  constructor(command: string, stderr: string) {
    super(`MCP add failed: ${command}\n${stderr}`);
    this.name = 'McpAddError';
    this.command = command;
    this.stderr = stderr;
  }
}

/**
 * Thrown by applyRemoveMcp when `claude mcp remove` exits non-zero. Carries the
 * command string and native stderr verbatim.
 */
export class McpRemoveError extends Error {
  readonly command: string;
  readonly stderr: string;

  constructor(command: string, stderr: string) {
    super(`MCP remove failed: ${command}\n${stderr}`);
    this.name = 'McpRemoveError';
    this.command = command;
    this.stderr = stderr;
  }
}

// ---------------------------------------------------------------------------
// mcpServerName
// ---------------------------------------------------------------------------

/**
 * Derive the MCP server name from the entry id.
 * 'mcp:github'            → 'github'
 * 'principal/mcp:github'  → 'github'
 * 'github'               → 'github'
 */
export function mcpServerName(entry: AdapterEntry): string {
  const prefix = 'mcp:';
  const localPart = entry.id.includes('/') ? entry.id.slice(entry.id.indexOf('/') + 1) : entry.id;
  return localPart.startsWith(prefix) ? localPart.slice(prefix.length) : localPart;
}

// ---------------------------------------------------------------------------
// Internal: on-disk read (read-only inspection)
// ---------------------------------------------------------------------------

/** Resolve the Claude config file that holds the `mcpServers` map for a scope. */
function resolveClaudeMcpConfigPath(scope: Scope, env: Env, cwd?: string): string {
  if (scope === 'project') {
    return path.join(cwd ?? process.cwd(), '.mcp.json');
  }
  return path.join(resolveHome(env), '.claude.json');
}

/** Read the `mcpServers` record from a Claude config file. Absent/invalid → {}. */
async function readClaudeMcpServers(configPath: string): Promise<Record<string, ClaudeMcpServer>> {
  let raw: string;
  try {
    raw = await readText(configPath);
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  const servers = (parsed as Record<string, unknown>)['mcpServers'];
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    return {};
  }
  return servers as Record<string, ClaudeMcpServer>;
}

// ---------------------------------------------------------------------------
// auditMcp
// ---------------------------------------------------------------------------

/**
 * Audit the current state of a Claude MCP server (read-only).
 *
 * Reads Claude's config file at the scope-appropriate path and reports
 * 'present' when the server id is declared under `mcpServers`, 'missing'
 * otherwise. Key-only (no drift check) — the drift gate lives in adoptMcp.
 */
export async function auditMcp(
  scope: Scope,
  env: Env,
  server: string,
  cwd?: string,
): Promise<NatureReport> {
  const configPath = resolveClaudeMcpConfigPath(scope, env, cwd);
  const servers = await readClaudeMcpServers(configPath);
  return {
    id: server,
    nature: 'mcp',
    state: Object.prototype.hasOwnProperty.call(servers, server) ? 'present' : 'missing',
  };
}

// ---------------------------------------------------------------------------
// planMcp
// ---------------------------------------------------------------------------

/**
 * Compute the write operations needed to install a Claude MCP server.
 *
 * Returns [] when the server is already declared (idempotent). Returns
 * [{ kind: 'mcp-add', server, config, scope, secretRefs? }] otherwise — the
 * engine delegates it to `claude mcp add-json` at apply time.
 *
 * @param config      The (already RENDERED) server descriptor — env-refs only.
 * @param secretRefs  ref→VAR mapping (names only) carried to the manifest.
 */
export async function planMcp(
  scope: Scope,
  env: Env,
  server: string,
  config: ClaudeMcpServer,
  cwd?: string,
  secretRefs?: Record<string, string>,
): Promise<WriteOp[]> {
  const report = await auditMcp(scope, env, server, cwd);
  if (report.state === 'present') {
    return [];
  }
  const op: WriteOpMcpAdd = {
    kind: 'mcp-add',
    server,
    config,
    scope,
    ...(secretRefs === undefined ? {} : { secretRefs }),
  };
  return [op];
}

// ---------------------------------------------------------------------------
// planRemoveMcp
// ---------------------------------------------------------------------------

/**
 * Compute the removal operations needed to uninstall a Claude MCP server.
 *
 * Returns [{ kind: 'mcp-remove', server, scope }] when the server is declared,
 * [] when absent (idempotent inverse of install).
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
  const op: RemovalOpMcpRemove = { kind: 'mcp-remove', server, scope };
  return [op];
}

// ---------------------------------------------------------------------------
// adoptMcp
// ---------------------------------------------------------------------------

/**
 * Adopt gate for the claude mcp nature (R5/D5, FM5).
 *
 * Adopts ONLY when the server is declared on disk AND its descriptor
 * DEEP-EQUALS the canonical RENDERED config. Presence alone is NOT enough: a
 * personal, divergent config for the same server id must NEVER be adopted —
 * recording the canonical would let `remove` strip the user's real server.
 * Comparing the RENDERED form (env-refs, not values) avoids a false drift
 * against a pre-E-secrets install.
 *
 * Returns `undefined` (refusal) when the server is absent, or present with ANY
 * difference from the canonical descriptor. Read-only: no fs writes.
 */
export async function adoptMcp(
  scope: Scope,
  env: Env,
  server: string,
  config: ClaudeMcpServer,
  cwd?: string,
  secretRefs?: Record<string, string>,
): Promise<AdoptionResult | undefined> {
  const configPath = resolveClaudeMcpConfigPath(scope, env, cwd);
  const servers = await readClaudeMcpServers(configPath);

  const onDisk = servers[server];
  if (onDisk === undefined || !isDeepStrictEqual(onDisk, config)) {
    return undefined;
  }

  return {
    applied: {
      kind: 'claude-mcp',
      server,
      config,
      scope,
      ...(secretRefs === undefined ? {} : { secretRefs }),
    },
    files: [configPath],
  };
}

// ---------------------------------------------------------------------------
// applyMcp
// ---------------------------------------------------------------------------

/**
 * Execute mcp-add ops by delegating to `claude mcp add-json <server> <json> -s <scope>`.
 * A non-zero exit throws McpAddError with the native stderr. Ops of any other
 * kind are skipped (forward-compatibility).
 */
export async function applyMcp(
  ops: WriteOp[],
  _env: Env,
  opts?: { run?: McpRunner },
): Promise<void> {
  const run = opts?.run ?? defaultMcpRunner;

  for (const op of ops) {
    if (op.kind !== 'mcp-add') {
      continue;
    }
    const json = JSON.stringify(op.config);
    const args = ['mcp', 'add-json', op.server, json, '-s', op.scope];
    const cmd = `claude mcp add-json ${op.server} <json> -s ${op.scope}`;
    const result = await run('claude', args);
    if (result.exitCode !== 0) {
      throw new McpAddError(cmd, result.stderr);
    }
  }
}

// ---------------------------------------------------------------------------
// applyRemoveMcp
// ---------------------------------------------------------------------------

/**
 * Execute mcp-remove ops by delegating to `claude mcp remove <server> -s <scope>`.
 * Targets exactly one server by name+scope — a personal server is never named.
 * A non-zero exit throws McpRemoveError with the native stderr. Ops of any
 * other kind are skipped (forward-compatibility).
 */
export async function applyRemoveMcp(
  ops: RemovalOp[],
  _env: Env,
  opts?: { run?: McpRunner },
): Promise<void> {
  const run = opts?.run ?? defaultMcpRunner;

  for (const op of ops) {
    if (op.kind !== 'mcp-remove') {
      continue;
    }
    const args = ['mcp', 'remove', op.server, '-s', op.scope];
    const cmd = `claude mcp remove ${op.server} -s ${op.scope}`;
    const result = await run('claude', args);
    if (result.exitCode !== 0) {
      throw new McpRemoveError(cmd, result.stderr);
    }
  }
}
