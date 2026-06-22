/**
 * Guardrail handler for the Claude adapter.
 *
 * Manages permissions.deny in Claude's settings.json (user-scope or project-scope).
 * Pattern: three functions (audit / plan / apply) that ClaudeAdapter dispatches to
 * based on nature. E2-E5 will follow the same shape for their own natures.
 *
 * Invariants:
 * - auditGuardrail and planGuardrail are read-only: no filesystem writes.
 * - applyGuardrail preserves all keys in settings.json; only permissions.deny is merged.
 * - All functions accept an injectable env for HOME isolation (tests use RIGGER_HOME).
 * - No while loops; async uses Promise.all / for...of / map.
 */

import {
  computeMissingDeny,
  mergeDeny,
  readJson,
  removeDeny,
  resolveProjectTargets,
  resolveUserTargets,
  writeJson,
} from '@agent-rigger/core';
import type {
  Env,
  NatureReport,
  RemovalOp,
  RemovalOpRemoveAllow,
  Scope,
  WriteOp,
  WriteOpMergeAllow,
  WriteOpMergeDeny,
} from '@agent-rigger/core';

// ---------------------------------------------------------------------------
// EmptyDenyArtifactError
// ---------------------------------------------------------------------------

/**
 * Thrown by loadCanonicalDeny when the deny artifact is absent, invalid, or
 * resolves to an empty array.
 *
 * A canonical security artifact must exist and contain at least one rule.
 * An empty deny ref would cause auditGuardrail to report 'present' even when
 * no protection is actually installed — a false confidence of security.
 */
export class EmptyDenyArtifactError extends Error {
  /** Absolute path of the deny.json artifact that was read (or expected). */
  readonly path: string;

  constructor(path: string) {
    super(
      `Canonical deny artifact is missing or empty: ${path}. `
        + 'Ensure the artifact file exists, contains a "deny" array, and has at least one rule.',
    );
    this.name = 'EmptyDenyArtifactError';
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Unique id used in NatureReport for the guardrail nature. */
const GUARDRAIL_ID = 'guardrails-claude';

/**
 * Resolve the settings.json path for the given scope.
 *
 * - 'user'    → ~/.claude/settings.json (via resolveUserTargets)
 * - 'project' → <cwd>/.claude/settings.json (via resolveProjectTargets)
 */
function resolveSettingsPath(scope: Scope, env: Env, cwd?: string): string {
  if (scope === 'project') {
    return resolveProjectTargets(cwd).claudeSettings;
  }
  return resolveUserTargets(env).claudeSettings;
}

/**
 * Extract permissions.deny from a parsed settings object.
 * Returns [] if the field is absent or not an array.
 */
function extractDeny(settings: Record<string, unknown>): string[] {
  const perms = settings['permissions'];
  if (perms === null || typeof perms !== 'object') {
    return [];
  }
  const deny = (perms as Record<string, unknown>)['deny'];
  if (!Array.isArray(deny)) {
    return [];
  }
  return deny.filter((x): x is string => typeof x === 'string');
}

/**
 * Extract permissions.allow from a parsed settings object.
 * Returns [] if the field is absent or not an array.
 */
function extractAllow(settings: Record<string, unknown>): string[] {
  const perms = settings['permissions'];
  if (perms === null || typeof perms !== 'object') {
    return [];
  }
  const allow = (perms as Record<string, unknown>)['allow'];
  if (!Array.isArray(allow)) {
    return [];
  }
  return allow.filter((x): x is string => typeof x === 'string');
}

// ---------------------------------------------------------------------------
// loadCanonicalDeny
// ---------------------------------------------------------------------------

/**
 * Read the canonical deny rules from a deny.json artifact file.
 *
 * - Valid deny array with at least one rule → returns the array of string rules.
 * - File absent, deny field missing/non-array, or array empty → throws EmptyDenyArtifactError.
 *
 * A non-empty deny artifact is a hard requirement: an empty denyRef would cause
 * auditGuardrail to report 'present' when no protection is installed (false confidence).
 *
 * Note: syntactically invalid JSON continues to throw InvalidJsonError from readJson.
 */
export async function loadCanonicalDeny(denyJsonPath: string): Promise<string[]> {
  const raw = await readJson(denyJsonPath);
  const deny = raw['deny'];
  if (!Array.isArray(deny)) {
    throw new EmptyDenyArtifactError(denyJsonPath);
  }
  const rules = deny.filter((x): x is string => typeof x === 'string');
  if (rules.length === 0) {
    throw new EmptyDenyArtifactError(denyJsonPath);
  }
  return rules;
}

// ---------------------------------------------------------------------------
// loadCanonicalAllow
// ---------------------------------------------------------------------------

/**
 * Read the canonical allow rules from an allow.json artifact file.
 *
 * Unlike loadCanonicalDeny, an empty or absent allow artifact is valid —
 * it simply means no additional allow rules are configured. Returns [] in all
 * absent/empty/missing-field cases without throwing.
 *
 * Note: syntactically invalid JSON continues to throw InvalidJsonError from readJson.
 */
export async function loadCanonicalAllow(allowJsonPath: string): Promise<string[]> {
  const raw = await readJson(allowJsonPath);
  const allow = raw['allow'];
  if (!Array.isArray(allow)) {
    return [];
  }
  return allow.filter((x): x is string => typeof x === 'string');
}

// ---------------------------------------------------------------------------
// auditGuardrail
// ---------------------------------------------------------------------------

/**
 * Audit the current state of the guardrail artifact on disk.
 *
 * Reads settings.json at the scope-appropriate path and compares
 * permissions.deny against denyRef and permissions.allow against allowRef.
 *
 * Returns:
 * - state 'present' if all ref rules are present (nothing missing).
 * - state 'missing' if any ref rules are absent.
 *
 * Read-only: no filesystem writes.
 *
 * @param scope     Installation scope.
 * @param env       Injectable env for HOME resolution.
 * @param denyRef   Canonical deny rules to verify against.
 * @param cwd       Working directory (only used when scope is 'project').
 * @param allowRef  Canonical allow rules to verify against (default []).
 */
export async function auditGuardrail(
  scope: Scope,
  env: Env,
  denyRef: string[],
  cwd?: string,
  allowRef: string[] = [],
): Promise<NatureReport> {
  const settingsPath = resolveSettingsPath(scope, env, cwd);
  const settings = await readJson(settingsPath);
  const currentDeny = extractDeny(settings);
  const missingDeny = computeMissingDeny(denyRef, currentDeny);

  const currentAllow = extractAllow(settings);
  const missingAllow = computeMissingDeny(allowRef, currentAllow);

  return {
    id: GUARDRAIL_ID,
    nature: 'guardrail',
    state: missingDeny.length === 0 && missingAllow.length === 0 ? 'present' : 'missing',
  };
}

// ---------------------------------------------------------------------------
// planGuardrail
// ---------------------------------------------------------------------------

/**
 * Compute the write operations needed to install the guardrail.
 *
 * Returns merge-deny and/or merge-allow WriteOps when rules are missing,
 * or an empty array when the artifact is already up-to-date (idempotent).
 *
 * Read-only: no filesystem writes.
 *
 * @param scope     Installation scope.
 * @param env       Injectable env for HOME resolution.
 * @param denyRef   Canonical deny rules to install.
 * @param cwd       Working directory (only used when scope is 'project').
 * @param allowRef  Canonical allow rules to install (default []).
 */
export async function planGuardrail(
  scope: Scope,
  env: Env,
  denyRef: string[],
  cwd?: string,
  allowRef: string[] = [],
): Promise<WriteOp[]> {
  const settingsPath = resolveSettingsPath(scope, env, cwd);
  const settings = await readJson(settingsPath);
  const currentDeny = extractDeny(settings);
  const missingDeny = computeMissingDeny(denyRef, currentDeny);

  const currentAllow = extractAllow(settings);
  const missingAllow = computeMissingDeny(allowRef, currentAllow);

  const ops: WriteOp[] = [];

  if (missingDeny.length > 0) {
    ops.push({ kind: 'merge-deny', path: settingsPath, toAdd: missingDeny });
  }

  if (missingAllow.length > 0) {
    const allowOp: WriteOpMergeAllow = {
      kind: 'merge-allow',
      path: settingsPath,
      toAdd: missingAllow,
    };
    ops.push(allowOp);
  }

  return ops;
}

// ---------------------------------------------------------------------------
// applyGuardrail
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// planRemoveGuardrail
// ---------------------------------------------------------------------------

/**
 * Compute the removal operations needed to uninstall the guardrail artifact.
 *
 * Returns remove-deny and/or remove-allow RemovalOps when the canonical rules
 * are present in settings.json, or an empty array when none are installed
 * (idempotent).
 *
 * Read-only: no filesystem writes.
 *
 * @param scope     Installation scope.
 * @param env       Injectable env for HOME resolution.
 * @param denyRef   Canonical deny rules to remove.
 * @param cwd       Working directory (only used when scope is 'project').
 * @param allowRef  Canonical allow rules to remove (default []).
 */
export async function planRemoveGuardrail(
  scope: Scope,
  env: Env,
  denyRef: string[],
  cwd?: string,
  allowRef: string[] = [],
): Promise<RemovalOp[]> {
  const settingsPath = resolveSettingsPath(scope, env, cwd);
  const settings = await readJson(settingsPath);
  const currentDeny = extractDeny(settings);

  const ops: RemovalOp[] = [];

  // Check whether any of the deny ref rules are actually present
  const denyRefSet = new Set(denyRef);
  const anyDenyPresent = currentDeny.some((rule) => denyRefSet.has(rule));

  if (anyDenyPresent) {
    ops.push({ kind: 'remove-deny', path: settingsPath, rules: denyRef });
  }

  if (allowRef.length > 0) {
    const currentAllow = extractAllow(settings);
    const allowRefSet = new Set(allowRef);
    const anyAllowPresent = currentAllow.some((rule) => allowRefSet.has(rule));
    if (anyAllowPresent) {
      const allowOp: RemovalOpRemoveAllow = {
        kind: 'remove-allow',
        path: settingsPath,
        rules: allowRef,
      };
      ops.push(allowOp);
    }
  }

  return ops;
}

// ---------------------------------------------------------------------------
// applyRemoveGuardrail
// ---------------------------------------------------------------------------

/**
 * Execute remove-deny removal operations produced by planRemoveGuardrail.
 *
 * For each remove-deny op:
 * 1. Read the current settings.json (returns {} if absent).
 * 2. Extract the current deny array.
 * 3. Remove managed rules using removeDeny, keeping user rules intact.
 * 4. Write back, preserving ALL other keys in settings.json.
 *
 * Ops of any other kind are ignored (forward-compatibility).
 *
 * @param ops  Removal operations (only remove-deny are processed).
 * @param env  Injectable env (kept for interface symmetry).
 */
export async function applyRemoveGuardrail(ops: RemovalOp[], _env: Env): Promise<void> {
  for (const op of ops) {
    if (op.kind === 'remove-deny') {
      const settings = await readJson(op.path);
      const currentDeny = extractDeny(settings);
      const updated = removeDeny(currentDeny, op.rules);

      const existingPerms = settings['permissions'];
      const basePerms =
        existingPerms !== null && typeof existingPerms === 'object' && !Array.isArray(existingPerms)
          ? (existingPerms as Record<string, unknown>)
          : {};

      await writeJson(op.path, {
        ...settings,
        permissions: { ...basePerms, deny: updated },
      });
    } else if (op.kind === 'remove-allow') {
      const removeAllowOp = op as RemovalOpRemoveAllow;
      const settings = await readJson(removeAllowOp.path);
      const currentAllow = extractAllow(settings);
      const updated = removeDeny(currentAllow, removeAllowOp.rules);

      const existingPerms = settings['permissions'];
      const basePerms =
        existingPerms !== null && typeof existingPerms === 'object' && !Array.isArray(existingPerms)
          ? (existingPerms as Record<string, unknown>)
          : {};

      await writeJson(removeAllowOp.path, {
        ...settings,
        permissions: { ...basePerms, allow: updated },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// applyGuardrail
// ---------------------------------------------------------------------------

/**
 * Execute merge-deny write operations produced by planGuardrail.
 *
 * For each merge-deny op:
 * 1. Read the current settings.json (returns {} if absent).
 * 2. Extract the current deny array.
 * 3. Merge with op.toAdd using mergeDeny (preserves current order, deduplicates).
 * 4. Write back, preserving ALL other keys in settings.json.
 *
 * Ops of any other kind are ignored (forward-compatibility with E2-E5 ops).
 *
 * The engine calls backup() before invoking apply, so no backup logic here.
 *
 * @param ops  Write operations (only merge-deny are processed).
 * @param env  Injectable env (unused here; kept for interface symmetry).
 */
export async function applyGuardrail(ops: WriteOp[], _env: Env): Promise<void> {
  for (const op of ops) {
    if (op.kind === 'merge-deny') {
      const mergeDenyOp = op as WriteOpMergeDeny;
      const settings = await readJson(mergeDenyOp.path);
      const currentDeny = extractDeny(settings);
      const merged = mergeDeny(currentDeny, mergeDenyOp.toAdd);

      const existingPerms = settings['permissions'];
      const basePerms =
        existingPerms !== null && typeof existingPerms === 'object' && !Array.isArray(existingPerms)
          ? (existingPerms as Record<string, unknown>)
          : {};

      await writeJson(mergeDenyOp.path, {
        ...settings,
        permissions: { ...basePerms, deny: merged },
      });
    } else if (op.kind === 'merge-allow') {
      const mergeAllowOp = op as WriteOpMergeAllow;
      const settings = await readJson(mergeAllowOp.path);
      const currentAllow = extractAllow(settings);
      const merged = mergeDeny(currentAllow, mergeAllowOp.toAdd);

      const existingPerms = settings['permissions'];
      const basePerms =
        existingPerms !== null && typeof existingPerms === 'object' && !Array.isArray(existingPerms)
          ? (existingPerms as Record<string, unknown>)
          : {};

      await writeJson(mergeAllowOp.path, {
        ...settings,
        permissions: { ...basePerms, allow: merged },
      });
    }
  }
}
