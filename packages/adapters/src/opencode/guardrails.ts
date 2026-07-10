/**
 * Guardrail handler for the opencode adapter.
 *
 * Manages the `permission` key of opencode.json (user-scope or project-scope).
 * The canonical source is a NATIVE opencode `permission` descriptor authored in
 * the catalog (`guardrails/<name>/permission.json`, ADR-0020 "Option A") — there
 * is NO Claude-rule translation. loadCanonicalOpencodePermission reads that
 * descriptor; the ADAPTER (opencode/adapter.ts) resolves `entry.applied` vs the
 * canonical fragment and calls into these handlers, which operate on an
 * `OpencodePermission` fragment directly, mirroring claude/guardrails.ts's shape
 * (audit/plan/planRemove/apply/applyRemove) applied to a different target.
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
  readJson,
  removePermission,
} from '@agent-rigger/core';
import type { AdoptionResult } from '@agent-rigger/core/adapter';
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
// Glob-overlap (cross-pattern) conflict detection (review F4, R10.4/R5.3)
// ---------------------------------------------------------------------------

/**
 * Faithful port of opencode's `Wildcard.match` (`util/wildcard.ts`, v1.17.14)
 * that resolves `read`/`edit`/`external_directory` path permissions.
 *
 * Verified against the opencode source: `\` is normalised to `/`, regex
 * specials are escaped, `*` becomes `.*` (NOT segment-bounded — a single `*`
 * crosses `/`), `?` becomes `.`, a trailing " *" is made optional, and the
 * whole thing is anchored `^…$` with the `s` (dotall) flag. Replicated EXACTLY
 * so the overlap simulation below matches opencode's real precedence.
 */
function matchOpencodeGlob(str: string, pattern: string): boolean {
  const target = str.replace(/\\/g, '/');
  const escaped = pattern
    .replace(/\\/g, '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const body = escaped.endsWith(' .*') ? `${escaped.slice(0, -3)}( .*)?` : escaped;
  return new RegExp(`^${body}$`, 's').test(target);
}

/** Whether a pattern names a literal path (opencode's only wildcards are `*`/`?`). */
function isConcretePattern(pattern: string): boolean {
  return !pattern.includes('*') && !pattern.includes('?');
}

/** The LAST leaf whose pattern matches `path` (opencode's `findLast` precedence). */
function findLastMatch(
  leaves: readonly [string, OpencodePermissionState][],
  path: string,
): { pattern: string; state: OpencodePermissionState } | undefined {
  let result: { pattern: string; state: OpencodePermissionState } | undefined;
  for (const [pattern, state] of leaves) {
    if (matchOpencodeGlob(path, pattern)) {
      result = { pattern, state };
    }
  }
  return result;
}

/** Build one glob-overlap warning naming both patterns and the sample path. */
function globOverlapWarning(
  tool: string,
  witness: string,
  userDecision: { pattern: string; state: OpencodePermissionState },
  ourDecision: { pattern: string; state: OpencodePermissionState },
): string {
  return `Permission "${tool}" > "${ourDecision.pattern}" = "${ourDecision.state}" overlaps your `
    + `existing "${tool}" > "${userDecision.pattern}" = "${userDecision.state}": opencode resolves `
    + `a path by last-match precedence and this guardrail leaf is written after yours, so for a `
    + `path such as "${witness}" the guardrail's "${ourDecision.state}" wins over your `
    + `"${userDecision.state}". No leaf was silently dropped, but the effective permission on the `
    + `overlapping path is the guardrail's — review this overlap manually.`;
}

/**
 * Warnings for guardrail leaves whose GLOB overlaps a DIFFERENTLY-SPELLED user
 * leaf under opencode's last-match (`findLast`) precedence (review F4, R10.4).
 *
 * `computePermissionConflicts` only flags leaves the user claims under the SAME
 * key. But opencode resolves a path by the LAST matching pattern across the
 * flattened `[default, agent, user]` rulesets (verified against opencode
 * v1.17.14 `permission/index.ts` + `util/wildcard.ts`), and the merge appends
 * its leaves AFTER the user's within the same map (jsonc-parser inserts new keys
 * last). So a guardrail pattern that path-overlaps a differently-spelled user
 * pattern silently wins for the overlapping paths — e.g. our `.env.example:
 * allow` overriding a user `*.example: deny` (fail-open), or our `*.env: deny`
 * overriding a user `config/prod.env: allow` (fail-secure). Neither is caught by
 * the exact-key detector, contradicting R10.4/R5.3 ("never fail silently").
 *
 * Detection SIMULATES opencode's resolution on witness paths — the CONCRETE
 * pattern keys (no `*`/`?`, opencode's only wildcards) named on either side. For
 * each witness the user's own last-match decision is compared to the merged
 * last-match decision; when the appended leaves flip it, a warning is emitted so
 * the override is never silent.
 *
 * Residual (documented) limitation: an overlap that manifests ONLY on paths
 * where BOTH patterns are globbed (no concrete witness names it) is not flagged.
 * This never hides the fail-OPEN direction of this descriptor — its sole `allow`
 * carve-out (`.env.example`) is a concrete key, so every user `deny` overlapping
 * it IS witnessed; only the fail-SECURE direction (our `deny` winning over a
 * user `allow`, the safe direction) could hide a both-globbed overlap.
 */
function computeGlobOverlapConflicts(
  fragment: OpencodePermission,
  current: OpencodePermission,
): string[] {
  const warnings: string[] = [];
  for (const [tool, wanted] of Object.entries(fragment)) {
    const existing = current[tool];
    // Cross-pattern overlap only exists when BOTH sides are nested glob maps.
    // Flat shapes (string states) are fully covered by computePermissionConflicts.
    if (typeof wanted === 'string' || existing === undefined || typeof existing === 'string') {
      continue;
    }
    const userLeaves = Object.entries(existing);
    // Leaves the merge will APPEND: our keys absent from the user map (present
    // keys are untouched and reported by computePermissionConflicts instead).
    const appended = Object.entries(wanted).filter(([pattern]) => !(pattern in existing));
    if (appended.length === 0) {
      continue;
    }
    // Witnesses: concrete (wildcard-free) keys from either side — the only paths
    // opencode names literally, hence the only ones we can resolve precisely.
    const witnesses = new Set<string>();
    for (const [pattern] of [...userLeaves, ...appended]) {
      if (isConcretePattern(pattern)) {
        witnesses.add(pattern);
      }
    }
    for (const witness of witnesses) {
      const userDecision = findLastMatch(userLeaves, witness);
      if (userDecision === undefined) {
        continue; // the user's config does not decide this path — no override
      }
      const ourDecision = findLastMatch(appended, witness);
      if (ourDecision === undefined || ourDecision.state === userDecision.state) {
        continue; // merge does not change the effective resolution for this path
      }
      warnings.push(globOverlapWarning(tool, witness, userDecision, ourDecision));
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// MissingOpencodePermissionError
// ---------------------------------------------------------------------------

/**
 * Thrown by loadCanonicalOpencodePermission when the descriptor file is absent,
 * has no `permission` object, or that object is empty.
 *
 * A native opencode guardrail REQUIRES a hand-authored `permission` descriptor:
 * there is no translation fallback (ADR-0020 "Option A"). An empty/absent
 * descriptor would cause auditGuardrail to report 'present' when no protection
 * is actually installed — a false confidence of security — so it fails loudly
 * instead of silently degrading to a no-op.
 */
export class MissingOpencodePermissionError extends Error {
  /** Absolute path of the permission.json descriptor that was read (or expected). */
  readonly path: string;

  constructor(path: string) {
    super(
      `Canonical opencode permission descriptor is missing or empty: ${path}. `
        + 'Ensure the file exists, contains a non-empty "permission" object, and is '
        + 'never silently replaced by a Claude-rule translation.',
    );
    this.name = 'MissingOpencodePermissionError';
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// loadCanonicalOpencodePermission
// ---------------------------------------------------------------------------

/**
 * Read the canonical NATIVE opencode permission descriptor from a permission.json
 * file (the catalog's `guardrails/<name>/permission.json`, ADR-0020 "Option A").
 *
 * - Valid, non-empty `permission` object → returns it verbatim as an OpencodePermission.
 * - File absent, `permission` missing/non-object/array, or empty object → throws
 *   MissingOpencodePermissionError (a native guardrail must ship a descriptor;
 *   there is NEVER a fallback to Claude-rule translation).
 *
 * Note: syntactically invalid JSON continues to throw InvalidJsonError from readJson.
 *
 * Mirrors loadCanonicalDeny in claude/guardrails.ts (same hard-requirement rationale).
 */
export async function loadCanonicalOpencodePermission(
  permissionJsonPath: string,
): Promise<OpencodePermission> {
  const raw = await readJson(permissionJsonPath);
  const permission = raw['permission'];
  if (
    permission === null
    || typeof permission !== 'object'
    || Array.isArray(permission)
    || Object.keys(permission).length === 0
  ) {
    throw new MissingOpencodePermissionError(permissionJsonPath);
  }
  return permission as OpencodePermission;
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
/** Whether a permission fragment carries no actual leaf (no tool state, no pattern). */
function isEmptyPermission(permission: OpencodePermission): boolean {
  for (const value of Object.values(permission)) {
    if (typeof value === 'string') return false;
    if (value !== undefined && Object.keys(value).length > 0) return false;
  }
  return true;
}

export async function auditGuardrail(
  scope: Scope,
  env: Env,
  permission: OpencodePermission,
  cwd?: string,
): Promise<NatureReport> {
  // A guardrail with no permission leaf is not "installed": an empty fragment
  // must never audit as 'present'. hasPermission(current, {}) is vacuously true,
  // so guard it here to keep the invariant symmetric with the load path, where
  // MissingOpencodePermissionError already forbids an empty/absent descriptor
  // (both prevent reporting protection that is not actually enforced).
  if (isEmptyPermission(permission)) {
    return { id: GUARDRAIL_ID, nature: 'guardrail', state: 'missing' };
  }

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
  const overlaps = computeGlobOverlapConflicts(permission, current);
  if (Object.keys(missing).length === 0 && conflicts.length === 0 && overlaps.length === 0) {
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
  // Surface translation warnings (R5.3 / HIGH-2), dropped-leaf conflict warnings
  // (M7) and cross-pattern glob-overlap warnings (F4, R10.4) on the op: the CLI
  // renders them in the plan/confirm/output so a non-translatable, conflict-
  // dropped, or last-match-overridden rule is never silently lost.
  // exactOptionalPropertyTypes: only set the key when there are warnings.
  const allWarnings = [...warnings, ...conflicts, ...overlaps];
  if (allWarnings.length > 0) {
    op.warnings = allWarnings;
  }
  return [op];
}

// ---------------------------------------------------------------------------
// adoptGuardrail
// ---------------------------------------------------------------------------

/**
 * Adopt gate for the opencode guardrail (permission) nature (R5/D5, FM5-adjacent).
 *
 * Adopts ONLY when the FULL canonical fragment is already in opencode.json with
 * NO divergence — the same condition under which planGuardrail returns [] (empty
 * plan): every leaf present (missing = {}), none conflicting (M7), none
 * glob-overlapping (F4). The recorded payload carries the COMPLETE canonical
 * fragment (not a delta): remove must reverse the full set, check must verify it.
 *
 * Returns `undefined` (refusal) when the descriptor is empty, or when any leaf
 * is missing / conflicts / overlaps — the manifest must never claim a permission
 * rigger did not actually enforce.
 *
 * Read-only: no filesystem writes.
 *
 * @param scope       Installation scope.
 * @param env         Injectable env for HOME resolution.
 * @param permission  The canonical native permission fragment.
 * @param cwd         Working directory (only used when scope is 'project').
 */
export async function adoptGuardrail(
  scope: Scope,
  env: Env,
  permission: OpencodePermission,
  cwd?: string,
): Promise<AdoptionResult | undefined> {
  // An empty descriptor is never "installed" (mirrors auditGuardrail): refuse.
  if (isEmptyPermission(permission)) {
    return undefined;
  }

  const opencodeJsonPath = resolveOpencodeJsonPath(scope, env, cwd);
  const settings = await readOpencodeJson(opencodeJsonPath);
  const current = extractPermission(settings);

  const missing = computeMissingPermission(permission, current);
  const conflicts = computePermissionConflicts(permission, current);
  const overlaps = computeGlobOverlapConflicts(permission, current);
  if (Object.keys(missing).length !== 0 || conflicts.length !== 0 || overlaps.length !== 0) {
    return undefined;
  }

  return {
    applied: { kind: 'opencode-permission', permission },
    files: [opencodeJsonPath],
  };
}

// ---------------------------------------------------------------------------
// planRemoveGuardrail
// ---------------------------------------------------------------------------

/**
 * Classify the leaves of the recorded `fragment` against the on-disk `current`
 * permission object (R1 fusion — the recorded payload is CUMULATIVE across
 * re-installs, so a single hand-edited leaf must never block the whole
 * removal):
 * - `removable`: leaves present on disk with the EXACT recorded state —
 *   removePermission will strip them;
 * - `drifted`: leaves the disk still claims but with a DIFFERENT value or
 *   shape (user modification) — removePermission leaves them intact, so the
 *   plan surfaces a warning naming each one instead of failing silently;
 * - leaves entirely absent from disk are neither (already gone, idempotent).
 */
function classifyRemovalLeaves(
  fragment: OpencodePermission,
  current: OpencodePermission,
): { removable: number; drifted: string[] } {
  let removable = 0;
  const drifted: string[] = [];
  for (const [tool, wanted] of Object.entries(fragment)) {
    const existing = current[tool];
    if (typeof wanted === 'string') {
      if (existing === wanted) {
        removable += 1;
      } else if (existing !== undefined) {
        drifted.push(
          `"${tool}" (recorded "${wanted}", found ${renderPermissionValue(existing)})`,
        );
      }
      continue;
    }
    for (const [pattern, state] of Object.entries(wanted)) {
      if (existing === undefined) {
        continue; // whole tool key gone — nothing left to remove or warn about
      }
      if (typeof existing === 'string') {
        drifted.push(
          `"${tool}" > "${pattern}" (recorded "${state}", found ${
            renderPermissionValue(existing)
          })`,
        );
        continue;
      }
      const found = existing[pattern];
      if (found === state) {
        removable += 1;
      } else if (found !== undefined) {
        drifted.push(`"${tool}" > "${pattern}" (recorded "${state}", found "${found}")`);
      }
    }
  }
  return { removable, drifted };
}

/**
 * Compute the removal operations needed to uninstall the guardrail.
 *
 * The recorded fragment (entry.applied) cumulates across re-installs (R1), so
 * removal is decided LEAF BY LEAF — never all-or-nothing. A single leaf the
 * user hand-edited must not turn remove into a silent no-op that leaves every
 * other rigger-managed leaf (including privilege-widening `allow` carve-outs)
 * orphaned in opencode.json forever:
 * - at least one leaf still matches exactly → one remove-permission op with
 *   the FULL recorded fragment (removePermission is exact-per-leaf and
 *   idempotent: matching leaves are stripped, drifted/absent leaves are left
 *   intact);
 * - leaves present with a DIFFERENT value (user drift) additionally yield a
 *   warning-only leave-alone op naming each one — same plan-warning channel as
 *   the R3 gate, so nothing is ever silently left behind;
 * - no leaf matches and none drifted (fragment empty or fully absent) → []
 *   (idempotent no-op);
 * - no leaf matches but some drifted → leave-alone only: the engine treats the
 *   plan as empty, preserves the manifest entry, and the warnings surface.
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

  const { removable, drifted } = classifyRemovalLeaves(permission, current);

  const ops: RemovalOp[] = [];
  if (removable > 0) {
    ops.push({ kind: 'remove-permission', path: opencodeJsonPath, permission });
  }
  if (drifted.length > 0) {
    ops.push({
      kind: 'leave-alone',
      target: opencodeJsonPath,
      warnings: drifted.map(
        (leaf) =>
          `Permission ${leaf} was not removed: the current value in opencode.json differs `
          + `from what rigger recorded at install time (user modification preserved) — `
          + `remove it manually if desired.`,
      ),
    });
  }
  return ops;
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
