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

import {
  ensureImportBlock,
  readText,
  resolveProjectTargets,
  resolveUserTargets,
  writeText,
} from '@agent-rigger/core';
import type {
  Env,
  NatureReport,
  Scope,
  WriteOp,
  WriteOpEnsureImport,
  WriteOpWriteText,
} from '@agent-rigger/core';

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
 * Returns:
 * - state 'present' if:
 *     (1) AGENTS.md exists AND its content matches `agentsContent`
 *     AND
 *     (2) CLAUDE.md contains a managed import block with the correct import target.
 * - state 'missing' otherwise.
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

  return {
    id: CONTEXT_ID,
    nature: 'context',
    state: agentsMatch && blockPresent ? 'present' : 'missing',
  };
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

  const writeTextOp: WriteOpWriteText = {
    kind: 'write-text',
    path: agentsMd,
    content: agentsContent,
    description: `Write canonical AGENTS.md to ${agentsMd}`,
  };

  const ensureImportOp: WriteOpEnsureImport = {
    kind: 'ensure-import',
    path: claudeMd,
    importLine: `@${target}`,
  };

  return [writeTextOp, ensureImportOp];
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
