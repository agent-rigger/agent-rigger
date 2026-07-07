/**
 * Context handler for the opencode adapter.
 *
 * opencode reads AGENTS.md **natively** (ADR-0007): unlike Claude, there is no
 * managed import block and no CLAUDE.md bridge. The canonical AGENTS.md content
 * is written as-is at the scope-appropriate opencode path.
 *
 * Pattern: five functions (audit / plan / planRemove / apply / applyRemove) that
 * OpencodeAdapter dispatches to based on nature. Mirrors claude/context.ts shape
 * minus the import-block machinery.
 *
 * Invariants:
 * - auditContext, planContext and planRemoveContext are read-only: no filesystem writes.
 * - applyContext / applyRemoveContext are idempotent.
 * - All functions accept injectable env and optional cwd for HOME isolation in tests.
 * - No while loops; async uses for...of / map.
 */

import { rm } from 'node:fs/promises';

import { readText, writeText } from '@agent-rigger/core/fs-json';
import {
  resolveOpencodeProjectTargets,
  resolveOpencodeUserTargets,
} from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type {
  NatureReport,
  RemovalOp,
  Scope,
  WriteOp,
  WriteOpWriteText,
} from '@agent-rigger/core/types';

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Unique id used in NatureReport for the context nature. */
const CONTEXT_ID = 'context-opencode';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the scope-appropriate AGENTS.md path for opencode.
 */
function resolveAgentsMd(scope: Scope, env: Env, cwd?: string): string {
  if (scope === 'project') {
    return resolveOpencodeProjectTargets(cwd).agentsMd;
  }
  return resolveOpencodeUserTargets(env).agentsMd;
}

// ---------------------------------------------------------------------------
// auditContext
// ---------------------------------------------------------------------------

/**
 * Audit the current state of the context artifact on disk.
 *
 * Returns:
 * - 'present' if AGENTS.md exists AND its content matches `agentsContent`.
 * - 'missing' if AGENTS.md does not exist.
 * - 'drift'   if AGENTS.md exists but its content diverges from `agentsContent`.
 *
 * Read-only: no filesystem writes.
 *
 * @param scope          Installation scope.
 * @param env            Injectable env for HOME resolution.
 * @param agentsContent  Canonical AGENTS.md content to verify against.
 * @param cwd            Working directory (only used when scope is 'project').
 */
export async function auditContext(
  scope: Scope,
  env: Env,
  agentsContent: string,
  cwd?: string,
): Promise<NatureReport> {
  const agentsMd = resolveAgentsMd(scope, env, cwd);
  const current = await readText(agentsMd);

  if (current === agentsContent) {
    return { id: CONTEXT_ID, nature: 'context', state: 'present' };
  }
  if (current === '') {
    return { id: CONTEXT_ID, nature: 'context', state: 'missing' };
  }
  return {
    id: CONTEXT_ID,
    nature: 'context',
    state: 'drift',
    detail: `AGENTS.md diverges from canonical content at ${agentsMd}`,
  };
}

// ---------------------------------------------------------------------------
// planContext
// ---------------------------------------------------------------------------

/**
 * Compute the write operations needed to install the context artifact.
 *
 * Returns [] when the artifact is already present (idempotent).
 * Returns [write-text] when installation or drift repair is needed.
 *
 * Read-only: no filesystem writes.
 *
 * @param scope          Installation scope.
 * @param env            Injectable env for HOME resolution.
 * @param agentsContent  Canonical AGENTS.md content to install.
 * @param cwd            Working directory (only used when scope is 'project').
 */
export async function planContext(
  scope: Scope,
  env: Env,
  agentsContent: string,
  cwd?: string,
): Promise<WriteOp[]> {
  const report = await auditContext(scope, env, agentsContent, cwd);
  if (report.state === 'present') {
    return [];
  }

  const agentsMd = resolveAgentsMd(scope, env, cwd);
  const op: WriteOpWriteText = {
    kind: 'write-text',
    path: agentsMd,
    content: agentsContent,
    description: `Write canonical AGENTS.md to ${agentsMd}`,
  };

  return [op];
}

// ---------------------------------------------------------------------------
// planRemoveContext
// ---------------------------------------------------------------------------

/**
 * Compute the removal operations needed to uninstall the context artifact.
 *
 * Returns [delete-file] when the managed AGENTS.md is installed (content
 * matches the canonical content and is non-empty). Returns [] otherwise
 * (not installed, or drifted — a diverged file is left alone offline).
 *
 * Read-only: no filesystem writes.
 *
 * @param scope          Installation scope.
 * @param env            Injectable env for HOME resolution.
 * @param agentsContent  Canonical AGENTS.md content (used to detect installed state).
 * @param cwd            Working directory (only used when scope is 'project').
 */
export async function planRemoveContext(
  scope: Scope,
  env: Env,
  agentsContent: string,
  cwd?: string,
): Promise<RemovalOp[]> {
  const agentsMd = resolveAgentsMd(scope, env, cwd);
  const current = await readText(agentsMd);
  const installed = current === agentsContent && agentsContent !== '';

  if (!installed) {
    return [];
  }

  return [{ kind: 'delete-file', path: agentsMd }];
}

// ---------------------------------------------------------------------------
// applyContext
// ---------------------------------------------------------------------------

/**
 * Execute write-text operations produced by planContext.
 *
 * For each write-text op: writes op.content to op.path verbatim (creates parent dirs).
 * Ops of any other kind are ignored (forward-compatibility).
 *
 * @param ops  Write operations (only 'write-text' is processed).
 * @param env  Injectable env (kept for interface symmetry with other handlers).
 */
export async function applyContext(ops: WriteOp[], _env: Env): Promise<void> {
  for (const op of ops) {
    if (op.kind === 'write-text') {
      await writeText(op.path, op.content);
    }
  }
}

// ---------------------------------------------------------------------------
// applyRemoveContext
// ---------------------------------------------------------------------------

/**
 * Execute delete-file operations produced by planRemoveContext.
 *
 * For each delete-file op: removes the file at op.path with force:true (tolerant to absence).
 * Ops of any other kind are ignored (forward-compatibility).
 *
 * @param ops  Removal operations (only 'delete-file' is processed).
 * @param env  Injectable env (kept for interface symmetry).
 */
export async function applyRemoveContext(ops: RemovalOp[], _env: Env): Promise<void> {
  for (const op of ops) {
    if (op.kind === 'delete-file') {
      await rm(op.path, { force: true });
    }
  }
}
