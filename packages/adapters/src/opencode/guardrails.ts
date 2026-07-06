/**
 * Guardrail handler for the opencode adapter.
 *
 * Manages the `permission` key of opencode.json (user-scope or project-scope).
 * The canonical source stays Claude-style deny/allow rule arrays (one source of
 * truth, design.md §7.1) — the ADAPTER (opencode/adapter.ts) is responsible for
 * calling `translateRules` and resolving `entry.applied` vs canonical config;
 * this module only operates on an already-translated `OpencodePermission`
 * fragment, mirroring claude/guardrails.ts's shape (audit/plan/planRemove/apply/
 * applyRemove) applied to a different target.
 *
 * Invariants:
 * - auditGuardrail and planGuardrail/planRemoveGuardrail are read-only: no filesystem writes.
 * - applyGuardrail/applyRemoveGuardrail preserve every other key in opencode.json
 *   ($schema, mcp, agent, pre-existing user permission leaves); only `permission` is touched.
 * - All functions accept an injectable env and optional cwd for HOME isolation in tests.
 * - No while loops; async uses for...of / map.
 */

import {
  computeMissingPermission,
  hasPermission,
  mergePermission,
  removePermission,
} from '@agent-rigger/core';
import {
  resolveOpencodeProjectTargets,
  resolveOpencodeUserTargets,
} from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type {
  NatureReport,
  OpencodePermission,
  RemovalOp,
  Scope,
  WriteOp,
  WriteOpMergePermission,
} from '@agent-rigger/core/types';
import { applyOpencodeKey, readOpencodeJson } from './opencode-json-io';

// ---------------------------------------------------------------------------
// Internal constants / helpers
// ---------------------------------------------------------------------------

/** Unique id used in NatureReport for the guardrail nature. */
const GUARDRAIL_ID = 'guardrails-opencode';

/** Resolve the opencode.json path for the given scope. */
function resolveOpencodeJsonPath(scope: Scope, env: Env, cwd?: string): string {
  if (scope === 'project') {
    return resolveOpencodeProjectTargets(cwd).opencodeJson;
  }
  return resolveOpencodeUserTargets(env).opencodeJson;
}

/** Extract the `permission` key from a parsed opencode.json. Absent/invalid → {}. */
function extractPermission(settings: Record<string, unknown>): OpencodePermission {
  const perm = settings['permission'];
  if (perm === null || typeof perm !== 'object' || Array.isArray(perm)) {
    return {};
  }
  return perm as OpencodePermission;
}

// ---------------------------------------------------------------------------
// auditGuardrail
// ---------------------------------------------------------------------------

/**
 * Audit the current state of the guardrail artifact on disk.
 *
 * Reads opencode.json at the scope-appropriate path and checks whether every
 * leaf of `permission` (already translated by the caller) is present.
 *
 * Returns:
 * - state 'present' if every leaf of `permission` is present with the same state.
 * - state 'missing' otherwise.
 *
 * Read-only: no filesystem writes.
 *
 * @param scope       Installation scope.
 * @param env         Injectable env for HOME resolution.
 * @param permission  The (already translated) canonical permission fragment to verify against.
 * @param cwd         Working directory (only used when scope is 'project').
 */
export async function auditGuardrail(
  scope: Scope,
  env: Env,
  permission: OpencodePermission,
  cwd?: string,
): Promise<NatureReport> {
  const opencodeJsonPath = resolveOpencodeJsonPath(scope, env, cwd);
  const settings = await readOpencodeJson(opencodeJsonPath);
  const current = extractPermission(settings);

  return {
    id: GUARDRAIL_ID,
    nature: 'guardrail',
    state: hasPermission(current, permission) ? 'present' : 'missing',
  };
}

// ---------------------------------------------------------------------------
// planGuardrail
// ---------------------------------------------------------------------------

/**
 * Compute the write operations needed to install the guardrail.
 *
 * Emits a single merge-permission op carrying only the MISSING subset of
 * `permission` (so the resulting `applied` payload — derived by the engine —
 * is exactly what was added, enabling exact reversibility, ADR-0016). Returns
 * [] when nothing is missing (idempotent).
 *
 * Read-only: no filesystem writes.
 *
 * @param scope       Installation scope.
 * @param env         Injectable env for HOME resolution.
 * @param permission  The (already translated) canonical permission fragment to install.
 * @param cwd         Working directory (only used when scope is 'project').
 * @param warnings    Translation warnings (R5.3 / HIGH-2) attached to the emitted
 *                    op's `warnings` field so the CLI renders them before confirm.
 */
export async function planGuardrail(
  scope: Scope,
  env: Env,
  permission: OpencodePermission,
  cwd?: string,
  warnings: string[] = [],
): Promise<WriteOp[]> {
  const opencodeJsonPath = resolveOpencodeJsonPath(scope, env, cwd);
  const settings = await readOpencodeJson(opencodeJsonPath);
  const current = extractPermission(settings);

  const missing = computeMissingPermission(permission, current);
  if (Object.keys(missing).length === 0) {
    return [];
  }

  const op: WriteOpMergePermission = {
    kind: 'merge-permission',
    path: opencodeJsonPath,
    permission: missing,
    description: 'Merge opencode permission rules from guardrail',
  };
  // Surface translation warnings on the op (R5.3 / HIGH-2): the CLI renders them
  // in the plan/confirm/output so a non-translatable deny rule is never silently
  // dropped. exactOptionalPropertyTypes: only set the key when there are warnings.
  if (warnings.length > 0) {
    op.warnings = warnings;
  }
  return [op];
}

// ---------------------------------------------------------------------------
// planRemoveGuardrail
// ---------------------------------------------------------------------------

/**
 * Compute the removal operations needed to uninstall the guardrail.
 *
 * Returns [{ kind: 'remove-permission', path, permission }] when every leaf of
 * `permission` is currently present (idempotent inverse of a full install).
 * Returns [] when the fragment is empty or not (fully) installed.
 *
 * Read-only: no filesystem writes.
 *
 * @param scope       Installation scope.
 * @param env         Injectable env for HOME resolution.
 * @param permission  The exact fragment to remove (from entry.applied, or the
 *                    translated canonical fragment as a fallback).
 * @param cwd         Working directory (only used when scope is 'project').
 */
export async function planRemoveGuardrail(
  scope: Scope,
  env: Env,
  permission: OpencodePermission,
  cwd?: string,
): Promise<RemovalOp[]> {
  if (Object.keys(permission).length === 0) {
    return [];
  }

  const opencodeJsonPath = resolveOpencodeJsonPath(scope, env, cwd);
  const settings = await readOpencodeJson(opencodeJsonPath);
  const current = extractPermission(settings);

  if (!hasPermission(current, permission)) {
    return [];
  }

  return [{ kind: 'remove-permission', path: opencodeJsonPath, permission }];
}

// ---------------------------------------------------------------------------
// applyGuardrail
// ---------------------------------------------------------------------------

/**
 * Execute merge-permission write operations produced by planGuardrail.
 *
 * For each merge-permission op:
 * 1. Read the current opencode.json (returns {} if absent).
 * 2. Merge op.permission into the current `permission` key via mergePermission
 *    (existing leaves are never overwritten).
 * 3. Write back, preserving ALL other keys ($schema, mcp, agent, ...).
 *
 * Ops of any other kind are ignored (forward-compatibility).
 *
 * @param ops  Write operations (only 'merge-permission' are processed).
 * @param env  Injectable env (kept for interface symmetry).
 */
export async function applyGuardrail(ops: WriteOp[], _env: Env): Promise<void> {
  for (const op of ops) {
    if (op.kind === 'merge-permission') {
      const settings = await readOpencodeJson(op.path);
      const current = extractPermission(settings);
      const merged = mergePermission(current, op.permission);
      await applyOpencodeKey(op.path, 'permission', merged);
    }
  }
}

// ---------------------------------------------------------------------------
// applyRemoveGuardrail
// ---------------------------------------------------------------------------

/**
 * Execute remove-permission removal operations produced by planRemoveGuardrail.
 *
 * For each remove-permission op:
 * 1. Read the current opencode.json.
 * 2. Remove exactly the managed leaves via removePermission (user leaves untouched).
 * 3. Write back, preserving ALL other keys ($schema, mcp, agent, ...).
 *
 * Ops of any other kind are ignored (forward-compatibility).
 *
 * @param ops  Removal operations (only 'remove-permission' are processed).
 * @param env  Injectable env (kept for interface symmetry).
 */
export async function applyRemoveGuardrail(ops: RemovalOp[], _env: Env): Promise<void> {
  for (const op of ops) {
    if (op.kind === 'remove-permission') {
      const settings = await readOpencodeJson(op.path);
      const current = extractPermission(settings);
      const updated = removePermission(current, op.permission);
      await applyOpencodeKey(op.path, 'permission', updated);
    }
  }
}
