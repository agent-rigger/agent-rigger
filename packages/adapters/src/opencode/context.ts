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
import path from 'node:path';

import type { AdoptionResult } from '@agent-rigger/core/adapter';
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
 * Three outcomes (mirrors claude/context.ts planRemoveContext, minus the
 * CLAUDE.md block dimension opencode does not have — ADR-0007):
 * - installed (content byte-identical to the canonical, non-empty) →
 *   [delete-file].
 * - drifted (AGENTS.md exists, non-empty, diverged from the canonical — the
 *   user enriched the managed file) → a warning-only [leave-alone] op. The
 *   engine treats a leave-alone-only plan as a NON-empty plan (plannedOps
 *   length > 0), so it does NOT fall into the R1 purge branch that would drop
 *   the manifest entry: the entry is PRESERVED, `check` keeps reporting the
 *   drift, and the enriched file is never deleted or hidden (R1 leave-alone
 *   contract from Lot 2 — an empty plan here would silently purge the entry and
 *   make the on-disk drift untracked and invisible to `check`).
 * - not installed (missing/empty) → [].
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

  if (installed) {
    return [{ kind: 'delete-file', path: agentsMd }];
  }

  // Drift: the file exists with foreign (user-enriched) content. Never delete
  // it and never purge the manifest entry — emit a warning-only leave-alone so
  // the engine conserves the entry (parity with claude/context.ts:377-386).
  const drifted = current !== '' && current !== agentsContent;
  if (drifted) {
    return [{
      kind: 'leave-alone',
      target: agentsMd,
      warnings: [
        `AGENTS.md at ${agentsMd} diverged from the managed content — left in place`
        + ' (remove never deletes user edits).',
      ],
    }];
  }

  return [];
}

// ---------------------------------------------------------------------------
// adoptContext
// ---------------------------------------------------------------------------

/**
 * Adopt gate for the opencode context nature (R5/D5, FM6).
 *
 * Adopts ONLY when AGENTS.md is byte-identical to the canonical `agentsContent`
 * (non-empty) — the same condition under which planContext returns [] (empty
 * plan). opencode reads AGENTS.md natively (ADR-0007): there is no CLAUDE.md
 * import block to check, unlike claude/context.ts. The recorded payload carries
 * the canonical `block` but NEVER a `previous` baseline (FM6): the on-disk
 * content is the canonical posted by an earlier install, not the user's
 * pre-install state, so remove must degrade to "no restore baseline" and delete,
 * never "restore" the canonical forever.
 *
 * Returns `undefined` (refusal) when AGENTS.md is missing, empty, or drifted.
 *
 * Read-only: no filesystem writes.
 *
 * @param scope          Installation scope.
 * @param env            Injectable env for HOME resolution.
 * @param agentsContent  Canonical AGENTS.md content.
 * @param cwd            Working directory (only used when scope is 'project').
 */
export async function adoptContext(
  scope: Scope,
  env: Env,
  agentsContent: string,
  cwd?: string,
): Promise<AdoptionResult | undefined> {
  const agentsMd = resolveAgentsMd(scope, env, cwd);
  const current = await readText(agentsMd);

  if (current !== agentsContent || agentsContent === '') {
    return undefined;
  }

  // Payload without `previous` — FM6: never fabricate a restore baseline from
  // the canonical already on disk.
  return {
    applied: { kind: 'context', block: agentsContent },
    files: [agentsMd],
  };
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
 * Shared-file gate (B5, parity with claude/context.ts): a delete whose path is
 * still referenced by the `files` of another manifest entry (e.g. the claude
 * context install of the same `<cwd>/AGENTS.md`) is SKIPPED — the engine hands
 * the files of every entry REMAINING after this removal, and the gate lives at
 * apply time, mirroring the store refcount. opencode's remove planner never
 * emits restore-file/remove-block (no restore baseline, no CLAUDE.md bridge —
 * ADR-0007), so delete-file is the only kind to gate.
 *
 * @param ops            Removal operations (only 'delete-file' is processed).
 * @param env            Injectable env (kept for interface symmetry).
 * @param manifestFiles  Files of the manifest entries remaining after this
 *                       removal (R4/R6 channel) — opaque reference candidates.
 */
export async function applyRemoveContext(
  ops: RemovalOp[],
  _env: Env,
  manifestFiles?: string[],
): Promise<void> {
  const referenced = new Set((manifestFiles ?? []).map((p) => path.resolve(p)));

  for (const op of ops) {
    if (op.kind === 'delete-file') {
      if (referenced.has(path.resolve(op.path))) continue;
      await rm(op.path, { force: true });
    }
  }
}
