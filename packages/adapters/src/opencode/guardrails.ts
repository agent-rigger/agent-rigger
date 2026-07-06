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
  OpencodePermissionState,
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

/** Render a permission value (flat state or pattern map) for a warning message. */
function renderPermissionValue(
  value: OpencodePermissionState | Record<string, OpencodePermissionState>,
): string {
  return typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
}

/** Build one dropped-leaf warning naming the rule and the conflicting user value. */
function conflictWarning(
  leafLabel: string,
  state: OpencodePermissionState,
  tool: string,
  existing: OpencodePermissionState | Record<string, OpencodePermissionState>,
): string {
  return `Permission ${leafLabel} = "${state}" was not applied: it conflicts with the `
    + `existing user setting "${tool}" = ${renderPermissionValue(existing)} in opencode.json `
    + `(existing config is never overwritten); adjust it manually to enforce this rule.`;
}

/**
 * Warnings for the leaves of `fragment` that the additive merge will DROP
 * because the user's config already claims the leaf with a different value
 * (review M7, R10.4/R5.3: never fail silently).
 *
 * A leaf is dropped-with-conflict when it cannot be applied AND the existing
 * user value differs from the wanted state:
 * - flat leaf vs existing flat state of a DIFFERENT value → conflict;
 * - flat leaf vs existing nested map → shape conflict;
 * - nested leaf vs existing flat state of a DIFFERENT value → shape conflict;
 * - nested leaf vs existing map carrying the pattern with a DIFFERENT state → conflict.
 *
 * A leaf whose existing value already matches the wanted state (exactly, or a
 * flat state equal to a nested leaf's state — broader but same enforcement)
 * is genuinely installed: no warning.
 */
function computePermissionConflicts(
  fragment: OpencodePermission,
  current: OpencodePermission,
): string[] {
  const warnings: string[] = [];
  for (const [tool, wanted] of Object.entries(fragment)) {
    const existing = current[tool];
    if (existing === undefined) {
      continue; // absent → mergeable, not a conflict
    }
    if (typeof wanted === 'string') {
      if (typeof existing === 'string' ? existing !== wanted : true) {
        warnings.push(conflictWarning(`"${tool}"`, wanted, tool, existing));
      }
      continue;
    }
    for (const [pattern, state] of Object.entries(wanted)) {
      const blocked = typeof existing === 'string'
        ? existing !== state
        : pattern in existing && existing[pattern] !== state;
      if (blocked) {
        warnings.push(conflictWarning(`"${tool}" > "${pattern}"`, state, tool, existing));
      }
    }
  }
  return warnings;
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
 * [] when nothing is missing AND nothing conflicts (idempotent).
 *
 * Leaves the additive merge would drop because the user's config claims them
 * with a different value (shape or state conflict, review M7) produce a warning
 * on the op — even when the missing subset is empty, so a fully-conflicting
 * install is never a silent no-op (R10.4/R5.3). An op with an EMPTY fragment is
 * warning-only: applyGuardrail skips it and the engine treats it like an empty
 * plan (no write, no manifest entry), so `check` keeps truthfully reporting
 * 'missing' and no phantom install is ever recorded.
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
  const conflicts = computePermissionConflicts(permission, current);
  if (Object.keys(missing).length === 0 && conflicts.length === 0) {
    return [];
  }

  const op: WriteOpMergePermission = {
    kind: 'merge-permission',
    path: opencodeJsonPath,
    permission: missing,
    description: Object.keys(missing).length > 0
      ? 'Merge opencode permission rules from guardrail'
      : 'Skip conflicting opencode permission rules (see warnings)',
  };
  // Surface translation warnings (R5.3 / HIGH-2) and dropped-leaf conflict
  // warnings (M7) on the op: the CLI renders them in the plan/confirm/output so
  // a non-translatable or conflict-dropped deny rule is never silently lost.
  // exactOptionalPropertyTypes: only set the key when there are warnings.
  const allWarnings = [...warnings, ...conflicts];
  if (allWarnings.length > 0) {
    op.warnings = allWarnings;
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
      // Warning-only op (M7): an empty fragment merges nothing — skip the
      // write entirely so the user's opencode.json is never rewritten as a
      // pure no-op. The engine also filters these ops out before applying.
      if (Object.keys(op.permission).length === 0) {
        continue;
      }
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
