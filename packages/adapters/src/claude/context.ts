/**
 * Context handler for the Claude adapter.
 *
 * Manages two artifacts in tandem:
 * 1. AGENTS.md — the canonical context file placed at the scope-appropriate path.
 * 2. A managed import block in CLAUDE.md — ensures Claude reads AGENTS.md automatically.
 *
 * The import target form differs by scope:
 * - user scope: `~/.claude/harness/AGENTS.md` — the tilde form is portable and avoids
 *   embedding the resolved absolute home path (which would break on other machines or
 *   when RIGGER_HOME is used in tests).
 * - project scope: relative path from .claude/CLAUDE.md to AGENTS.md (`../AGENTS.md`) —
 *   relative paths stay correct regardless of where the project is cloned.
 *
 * Pattern: three functions (audit / plan / apply) that ClaudeAdapter dispatches to
 * based on nature. Mirrors the guardrails handler shape (E1).
 *
 * Invariants:
 * - auditContext and planContext are read-only: no filesystem writes.
 * - applyContext is idempotent (relies on ensureImportBlock idempotence + writeText overwrite).
 * - All functions accept injectable env and optional cwd for HOME isolation in tests.
 * - No while loops; async uses for...of / map.
 */

import { rm } from 'node:fs/promises';
import path from 'node:path';

import {
  ensureImportBlock,
  readText,
  removeImportBlock,
  resolveProjectTargets,
  resolveUserTargets,
  writeText,
} from '@agent-rigger/core';
import type {
  Env,
  NatureReport,
  RemovalOp,
  Scope,
  WriteOp,
  WriteOpEnsureImport,
  WriteOpWriteText,
} from '@agent-rigger/core';
import type { AdoptionResult } from '@agent-rigger/core/adapter';

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Unique id used in NatureReport for the context nature. */
const CONTEXT_ID = 'context-claude';

/** Tilde-form import target for the user scope — portable, not absolute. */
const USER_IMPORT_TARGET = '~/.claude/harness/AGENTS.md';

/**
 * Relative import target from `.claude/CLAUDE.md` to `AGENTS.md` at project root.
 * The CLAUDE.md lives in `<cwd>/.claude/CLAUDE.md` and AGENTS.md in `<cwd>/AGENTS.md`,
 * so the relative path is always `../AGENTS.md`.
 */
const PROJECT_IMPORT_TARGET = '../AGENTS.md';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve agentsMd and claudeMd paths for the given scope.
 */
function resolvePaths(
  scope: Scope,
  env: Env,
  cwd?: string,
): { agentsMd: string; claudeMd: string } {
  if (scope === 'project') {
    const targets = resolveProjectTargets(cwd);
    return { agentsMd: targets.agentsMd, claudeMd: targets.claudeMd };
  }
  const targets = resolveUserTargets(env);
  return { agentsMd: targets.agentsMd, claudeMd: targets.claudeMd };
}

/**
 * Return the import target string (after `@`) for the given scope.
 * User: tilde form. Project: relative path.
 */
function importTarget(scope: Scope): string {
  return scope === 'project' ? PROJECT_IMPORT_TARGET : USER_IMPORT_TARGET;
}

/**
 * Check whether `claudeMdContent` contains a managed import block referencing `target`.
 */
function hasImportBlock(claudeMdContent: string, target: string): boolean {
  const importLine = `@${target}`;
  return (
    claudeMdContent.includes('<!-- BEGIN agent-rigger (managed — do not edit) -->')
    && claudeMdContent.includes(importLine)
    && claudeMdContent.includes('<!-- END agent-rigger -->')
  );
}

// ---------------------------------------------------------------------------
// loadCanonicalContext
// ---------------------------------------------------------------------------

/**
 * Read the canonical AGENTS.md content from the given path.
 *
 * - File absent → returns ''.
 * - File present → returns full UTF-8 content.
 */
export async function loadCanonicalContext(agentsMdPath: string): Promise<string> {
  return readText(agentsMdPath);
}

// ---------------------------------------------------------------------------
// auditContext
// ---------------------------------------------------------------------------

/**
 * Audit the current state of the context artifact on disk.
 *
 * Three states (R6 — mirrors opencode/context.ts, plus the CLAUDE.md block
 * dimension specific to claude):
 * - 'present' — AGENTS.md content matches `agentsContent` AND CLAUDE.md
 *   carries the managed import block with the correct target.
 * - 'drift'   — AGENTS.md exists with content diverging from `agentsContent`
 *   (detail names the path). Never reported as 'missing': "missing" invites a
 *   re-install that would overwrite the user's work.
 * - 'missing' — AGENTS.md absent/empty, or content matches but the CLAUDE.md
 *   block is gone (re-installing only re-adds the block — nothing destroyed).
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
  const { agentsMd, claudeMd } = resolvePaths(scope, env, cwd);
  const target = importTarget(scope);

  const [currentAgents, currentClaudeMd] = await Promise.all([
    readText(agentsMd),
    readText(claudeMd),
  ]);

  const agentsMatch = currentAgents === agentsContent;
  const blockPresent = hasImportBlock(currentClaudeMd, target);

  if (agentsMatch && blockPresent) {
    return { id: CONTEXT_ID, nature: 'context', state: 'present' };
  }
  if (currentAgents !== '' && !agentsMatch) {
    return {
      id: CONTEXT_ID,
      nature: 'context',
      state: 'drift',
      detail: `AGENTS.md diverges from canonical content at ${agentsMd}`,
    };
  }
  return { id: CONTEXT_ID, nature: 'context', state: 'missing' };
}

// ---------------------------------------------------------------------------
// planContext
// ---------------------------------------------------------------------------

/**
 * Compute the write operations needed to install the context artifact.
 *
 * Returns [] when the artifact is already present (idempotent).
 * Returns [write-text, ensure-import] when installation is needed.
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
  const { agentsMd, claudeMd } = resolvePaths(scope, env, cwd);
  const target = importTarget(scope);

  const [currentAgents, currentClaudeMd] = await Promise.all([
    readText(agentsMd),
    readText(claudeMd),
  ]);

  const agentsMatch = currentAgents === agentsContent;
  const blockPresent = hasImportBlock(currentClaudeMd, target);

  if (agentsMatch && blockPresent) {
    return [];
  }

  // R6: an install over existing foreign content must be signalled before
  // confirm — same plan-warning channel as WriteOpMergeAllow.warnings.
  const overwriting = currentAgents !== '' && !agentsMatch;

  // FM6 (lot3 R5/D5): capture a restore baseline ONLY when the write actually
  // CHANGES the content. When AGENTS.md is already byte-identical to the
  // canonical (agentsMatch — the block is what is missing, so the plan still
  // runs), the on-disk content is the canonical a previous install posted, NOT
  // the user's pre-install state. Recording it as `previous` would let remove
  // "restore" the canonical forever instead of deleting — after a manifest loss
  // the artifact would become un-uninstallable. Absent baseline → extractApplied
  // omits `previous`, and remove degrades to "no restore baseline" (delete on
  // exact match). Empty ≡ absent (readText returns '' for both) → null so remove
  // deletes; foreign content overwrite → the foreign content, restored on remove.
  const captureBaseline = currentAgents !== agentsContent;

  const writeTextOp: WriteOpWriteText = {
    kind: 'write-text',
    path: agentsMd,
    content: agentsContent,
    description: `Write canonical AGENTS.md to ${agentsMd}`,
    ...(captureBaseline ? { previous: currentAgents === '' ? null : currentAgents } : {}),
    ...(overwriting
      ? {
        warnings: [
          `AGENTS.md at ${agentsMd} has existing content that will be overwritten`
          + ' — the current content is recorded and restored on remove.',
        ],
      }
      : {}),
  };

  const ensureImportOp: WriteOpEnsureImport = {
    kind: 'ensure-import',
    path: claudeMd,
    importLine: `@${target}`,
  };

  return [writeTextOp, ensureImportOp];
}

// ---------------------------------------------------------------------------
// adoptContext
// ---------------------------------------------------------------------------

/**
 * Adopt gate for the context nature (R5/D5).
 *
 * Adopts ONLY when the artifact is fully present: AGENTS.md byte-identical to
 * the canonical `agentsContent` (non-empty) AND the managed import block is in
 * CLAUDE.md — the same condition under which planContext returns [] (empty
 * plan). The recorded payload carries the canonical `block` but NEVER a
 * `previous` baseline (FM6): the on-disk content is the canonical, not a user's
 * pre-install state, so remove must degrade to "no restore baseline" and delete,
 * never "restore" the canonical forever.
 *
 * Returns `undefined` (refusal) in every other state — a drifted AGENTS.md, a
 * missing block, an empty canonical.
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
  const { agentsMd, claudeMd } = resolvePaths(scope, env, cwd);
  const target = importTarget(scope);

  const [currentAgents, currentClaudeMd] = await Promise.all([
    readText(agentsMd),
    readText(claudeMd),
  ]);

  const agentsMatch = currentAgents === agentsContent && agentsContent !== '';
  const blockPresent = hasImportBlock(currentClaudeMd, target);

  if (!agentsMatch || !blockPresent) {
    return undefined;
  }

  // Payload without `previous` — FM6: never fabricate a restore baseline from
  // the canonical already on disk. files mirror a normal install (AGENTS.md +
  // CLAUDE.md), the shared-file refcount candidates remove relies on.
  return {
    applied: { kind: 'context', block: agentsContent },
    files: [agentsMd, claudeMd],
  };
}

// ---------------------------------------------------------------------------
// planRemoveContext
// ---------------------------------------------------------------------------

/**
 * Compute the removal operations needed to uninstall the context artifact (R6).
 *
 * AGENTS.md fate — decided against the manifest trace, never against mere
 * disk presence (the M5 fix):
 * - content === `agentsContent` (the applied block) →
 *     - `previous` is a string → restore-file (pre-install content written back);
 *     - `previous` is null     → delete-file (the file did not exist before install);
 *     - `previous` undefined   → delete-file + "no restore baseline" warning
 *       (legacy entry recorded before previous-content capture — safe degraded
 *       mode: deletion happens on exact content match ONLY).
 * - content diverged (user enriched the file) → warning-only leave-alone op:
 *   the file is never deleted or overwritten; the engine drops the op before
 *   applyRemove and PRESERVES the manifest entry when nothing else is removable.
 *
 * The CLAUDE.md import block is removed whenever present, in ALL cases above:
 * a marker-fenced block is unambiguously managed (gate 2026-07-10: decoupled).
 *
 * Returns [] when neither artifact is installed (idempotent).
 *
 * Read-only: no filesystem writes.
 *
 * @param scope          Installation scope.
 * @param env            Injectable env for HOME resolution.
 * @param agentsContent  Canonical AGENTS.md content (used to detect installed state).
 * @param cwd            Working directory (only used when scope is 'project').
 * @param previous       Restore baseline from AppliedContext.previous:
 *                       string = pre-install content, null = file was absent,
 *                       undefined = legacy entry without a baseline.
 */
export async function planRemoveContext(
  scope: Scope,
  env: Env,
  agentsContent: string,
  cwd?: string,
  previous?: string | null,
): Promise<RemovalOp[]> {
  const { agentsMd, claudeMd } = resolvePaths(scope, env, cwd);
  const target = importTarget(scope);

  const [currentAgents, currentClaudeMd] = await Promise.all([
    readText(agentsMd),
    readText(claudeMd),
  ]);

  const blockInstalled = hasImportBlock(currentClaudeMd, target);
  const agentsInstalled = currentAgents === agentsContent && agentsContent !== '';
  const agentsDrifted = currentAgents !== '' && currentAgents !== agentsContent;

  const ops: RemovalOp[] = [];

  if (agentsInstalled) {
    if (previous === undefined) {
      ops.push({
        kind: 'delete-file',
        path: agentsMd,
        warnings: [
          `No restore baseline recorded for ${agentsMd} (entry predates previous-content capture)`
          + ' — deleting the managed file; the pre-install content cannot be restored.',
        ],
      });
    } else if (previous === null) {
      ops.push({ kind: 'delete-file', path: agentsMd });
    } else {
      ops.push({ kind: 'restore-file', path: agentsMd, content: previous });
    }
  } else if (agentsDrifted) {
    ops.push({
      kind: 'leave-alone',
      target: agentsMd,
      warnings: [
        `AGENTS.md at ${agentsMd} diverged from the managed content — left in place`
        + ' (remove never deletes user edits).',
      ],
    });
  }

  if (blockInstalled) {
    ops.push({ kind: 'remove-block', path: claudeMd });
  }

  return ops;
}

// ---------------------------------------------------------------------------
// applyRemoveContext
// ---------------------------------------------------------------------------

/**
 * Execute delete-file, restore-file and remove-block operations produced by
 * planRemoveContext.
 *
 * For each delete-file op: removes the file at op.path with force:true (tolerant to absence).
 * For each restore-file op: writes op.content (the pre-install baseline) back to op.path (R6).
 * For each remove-block op: reads the Markdown file, calls removeImportBlock, writes back.
 *
 * Shared-file gate (R6): a delete/restore whose path is still referenced by
 * the `files` of another manifest entry (e.g. the opencode context install of
 * the same `<cwd>/AGENTS.md`) is SKIPPED — only the claude-specific CLAUDE.md
 * block goes. Reuses the R4 manifestFiles channel: the engine hands the files
 * of every entry REMAINING after this removal, and the gate lives at apply
 * time, mirroring the store refcount (T7). remove-block is never gated —
 * CLAUDE.md's marker-fenced block belongs to claude alone.
 *
 * Ops of any other kind are ignored (forward-compatibility).
 *
 * @param ops            Removal operations (delete-file, restore-file, remove-block).
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
    } else if (op.kind === 'restore-file') {
      if (referenced.has(path.resolve(op.path))) continue;
      await writeText(op.path, op.content);
    } else if (op.kind === 'remove-block') {
      const current = await readText(op.path);
      const updated = removeImportBlock(current);
      await writeText(op.path, updated);
    }
  }
}

// ---------------------------------------------------------------------------
// applyContext
// ---------------------------------------------------------------------------

/**
 * Execute write-text and ensure-import operations produced by planContext.
 *
 * For each write-text op: writes op.content to op.path (creates parent dirs).
 * For each ensure-import op: reads current CLAUDE.md content, calls ensureImportBlock,
 * then writes the updated content back. Idempotent (ensureImportBlock guarantees exactly
 * one managed block).
 *
 * Ops of any other kind are ignored (forward-compatibility).
 *
 * @param ops  Write operations (write-text and ensure-import are processed).
 * @param env  Injectable env (kept for interface symmetry with other handlers).
 */
export async function applyContext(ops: WriteOp[], _env: Env): Promise<void> {
  for (const op of ops) {
    if (op.kind === 'write-text') {
      const writeOp = op as WriteOpWriteText;
      await writeText(writeOp.path, writeOp.content);
    } else if (op.kind === 'ensure-import') {
      const importOp = op as WriteOpEnsureImport;
      // importLine is '@<target>'; strip the leading '@' to get the target
      const target = importOp.importLine.slice(1);
      const current = await readText(importOp.path);
      const updated = ensureImportBlock(current, target);
      await writeText(importOp.path, updated);
    }
  }
}
