/**
 * Hook handler for the Claude adapter.
 *
 * Manages hooks in Claude's settings.json (user-scope or project-scope)
 * under the `hooks` key. Relies on the pure mergeHook/removeHook/hasHook
 * functions from @agent-rigger/core for all hook logic.
 *
 * Pattern mirrors guardrails.ts: five functions (audit / plan / apply /
 * planRemove / applyRemove) that ClaudeAdapter dispatches to based on nature.
 *
 * Invariants:
 * - auditHook and planHook are read-only: no filesystem writes.
 * - applyHook preserves all keys in settings.json; only the hooks section is merged.
 * - applyRemoveHook preserves all other keys; only the target hook command is removed.
 * - All functions accept an injectable env for HOME isolation (tests use RIGGER_HOME).
 * - No while loops; async uses for...of.
 * - exactOptionalPropertyTypes: timeout is never set to undefined.
 */

import {
  hasHook,
  mergeHook,
  readJson,
  removeHook,
  resolveProjectTargets,
  resolveUserTargets,
  writeJson,
} from '@agent-rigger/core';
import type {
  AdapterEntry,
  Env,
  NatureReport,
  RemovalOp,
  RemovalOpRemoveHooks,
  Scope,
  WriteOp,
  WriteOpMergeHooks,
} from '@agent-rigger/core';
import { syncToStore } from '@agent-rigger/core/linker';
import type { SyncOptions } from '@agent-rigger/core/linker';

// ---------------------------------------------------------------------------
// ResolvedHook
// ---------------------------------------------------------------------------

/**
 * A concrete hook specification resolved from the catalog or an external source.
 *
 * In H3 this is provided as an opaque value by ClaudeAdapterConfig.hookSpec.
 * In H4 it will be resolved from the script catalogue + repository.
 *
 * exactOptionalPropertyTypes: timeout is omitted entirely when not provided.
 */
export interface ResolvedHook {
  /** Claude Code hook event (e.g. "PreToolUse", "UserPromptSubmit"). */
  event: string;
  /** Matcher string (e.g. "Bash", "*"). */
  matcher: string;
  /** Shell command registered as the hook (opaque string — the script path is H4's concern). */
  command: string;
  /** Optional timeout in seconds for the hook command. */
  timeout?: number;
  /** Source directory to copy scripts from at install time. Absent when not needed. */
  scriptSource?: string;
  /** Destination directory in the store for the scripts. Absent when not needed. */
  scriptStore?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// auditHook
// ---------------------------------------------------------------------------

/**
 * Audit the current state of the hook artifact on disk.
 *
 * Reads settings.json at the scope-appropriate path and checks whether
 * the hook described by `spec` is registered under hooks.<event>[matcher].
 *
 * Returns:
 * - state 'present' if the hook command is found.
 * - state 'missing' if it is absent (including when settings.json does not exist).
 *
 * Read-only: no filesystem writes.
 *
 * @param entry  Adapter entry carrying id and nature for the report.
 * @param scope  Installation scope.
 * @param env    Injectable env for HOME resolution.
 * @param spec   Resolved hook specification to check.
 * @param cwd    Working directory (only used when scope is 'project').
 */
export async function auditHook(
  entry: AdapterEntry,
  scope: Scope,
  env: Env,
  spec: ResolvedHook,
  cwd?: string,
): Promise<NatureReport> {
  const settingsPath = resolveSettingsPath(scope, env, cwd);
  const settings = await readJson(settingsPath);
  const present = hasHook(settings, spec);

  return {
    id: entry.id,
    nature: 'hook',
    state: present ? 'present' : 'missing',
  };
}

// ---------------------------------------------------------------------------
// planHook
// ---------------------------------------------------------------------------

/**
 * Compute the write operations needed to install the hook.
 *
 * Returns a single merge-hooks WriteOp when the hook is absent,
 * or an empty array when it is already registered (idempotent).
 *
 * Read-only: no filesystem writes.
 *
 * @param entry  Adapter entry (unused in the op; kept for interface symmetry).
 * @param scope  Installation scope.
 * @param env    Injectable env for HOME resolution.
 * @param spec   Resolved hook specification to install.
 * @param cwd    Working directory (only used when scope is 'project').
 */
export async function planHook(
  _entry: AdapterEntry,
  scope: Scope,
  env: Env,
  spec: ResolvedHook,
  cwd?: string,
): Promise<WriteOp[]> {
  const settingsPath = resolveSettingsPath(scope, env, cwd);
  const settings = await readJson(settingsPath);

  if (hasHook(settings, spec)) {
    return [];
  }

  // exactOptionalPropertyTypes: only include optional fields when they are defined.
  return [
    {
      kind: 'merge-hooks' as const,
      path: settingsPath,
      event: spec.event,
      matcher: spec.matcher,
      command: spec.command,
      ...(spec.timeout === undefined ? {} : { timeout: spec.timeout }),
      ...(spec.scriptSource === undefined ? {} : { scriptSource: spec.scriptSource }),
      ...(spec.scriptStore === undefined ? {} : { scriptStore: spec.scriptStore }),
    },
  ];
}

// ---------------------------------------------------------------------------
// applyHook
// ---------------------------------------------------------------------------

/**
 * Execute merge-hooks write operations produced by planHook.
 *
 * For each merge-hooks op:
 * 1. Read the current settings.json (returns {} if absent).
 * 2. Merge the hook using mergeHook (idempotent, deduplicates by command).
 * 3. Write back, preserving ALL other keys in settings.json.
 *
 * Ops of any other kind are ignored (forward-compatibility).
 *
 * The engine calls backup() before invoking apply, so no backup logic here.
 *
 * @param ops  Write operations (only merge-hooks are processed).
 * @param env  Injectable env (unused here; kept for interface symmetry).
 */
export async function applyHook(ops: WriteOp[], _env: Env): Promise<void> {
  for (const op of ops) {
    if (op.kind !== 'merge-hooks') {
      continue;
    }
    const mergeOp = op as WriteOpMergeHooks;

    // Deposit guard scripts to the store before merging settings.json.
    // exactOptionalPropertyTypes: both fields must be present (not merely defined).
    if (mergeOp.scriptSource !== undefined && mergeOp.scriptStore !== undefined) {
      // Preserve runtime guard-*.log files written by the guard scripts at execution
      // time. Without this, a plain rm-rf + cp would erase logs on every re-install.
      const syncOpts: SyncOptions = { preserveGlobs: ['guard-*.log'] };
      await syncToStore(mergeOp.scriptSource, mergeOp.scriptStore, syncOpts);
    }

    const settings = await readJson(mergeOp.path);

    // exactOptionalPropertyTypes: only include timeout when defined.
    const spec: ResolvedHook = mergeOp.timeout === undefined
      ? { event: mergeOp.event, matcher: mergeOp.matcher, command: mergeOp.command }
      : {
        event: mergeOp.event,
        matcher: mergeOp.matcher,
        command: mergeOp.command,
        timeout: mergeOp.timeout,
      };

    const next = mergeHook(settings, spec);
    await writeJson(mergeOp.path, next);
  }
}

// ---------------------------------------------------------------------------
// planRemoveHook
// ---------------------------------------------------------------------------

/**
 * Compute the removal operations needed to uninstall the hook.
 *
 * Returns a single remove-hooks RemovalOp when the hook command is present
 * in settings.json, or an empty array when it is not installed (idempotent).
 *
 * Read-only: no filesystem writes.
 *
 * @param entry  Adapter entry (unused in the op; kept for interface symmetry).
 * @param scope  Installation scope.
 * @param env    Injectable env for HOME resolution.
 * @param spec   Resolved hook specification to remove.
 * @param cwd    Working directory (only used when scope is 'project').
 */
export async function planRemoveHook(
  _entry: AdapterEntry,
  scope: Scope,
  env: Env,
  spec: ResolvedHook,
  cwd?: string,
): Promise<RemovalOp[]> {
  const settingsPath = resolveSettingsPath(scope, env, cwd);
  const settings = await readJson(settingsPath);

  if (!hasHook(settings, spec)) {
    return [];
  }

  return [
    {
      kind: 'remove-hooks',
      path: settingsPath,
      event: spec.event,
      matcher: spec.matcher,
      command: spec.command,
    },
  ];
}

// ---------------------------------------------------------------------------
// applyRemoveHook
// ---------------------------------------------------------------------------

/**
 * Execute remove-hooks removal operations produced by planRemoveHook.
 *
 * For each remove-hooks op:
 * 1. Read the current settings.json (returns {} if absent).
 * 2. Remove the hook using removeHook (pure, idempotent).
 * 3. Write back, preserving ALL other keys in settings.json.
 *
 * Ops of any other kind are ignored (forward-compatibility).
 *
 * @param ops  Removal operations (only remove-hooks are processed).
 * @param env  Injectable env (kept for interface symmetry).
 */
export async function applyRemoveHook(ops: RemovalOp[], _env: Env): Promise<void> {
  for (const op of ops) {
    if (op.kind !== 'remove-hooks') {
      continue;
    }
    const removeOp = op as RemovalOpRemoveHooks;
    const settings = await readJson(removeOp.path);
    const next = removeHook(settings, {
      event: removeOp.event,
      matcher: removeOp.matcher,
      command: removeOp.command,
    });
    await writeJson(removeOp.path, next);
  }
}
