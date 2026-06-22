/**
 * Agents handler for the Claude adapter.
 *
 * A Claude sub-agent is a single file ~/.claude/agents/<name>.md (vs a skill
 * which is a directory). It follows the same distribution mechanism as skills:
 * managed store (physical copy) + symlink at the target path via the linker.
 *
 * The op kind 'link' is already registered in opKindHandlers (E3/skills) so
 * agents reuse it without duplication. Only audit + plan are new here.
 *
 * Three functions mirror the skills handler shape:
 *   auditAgent  — read-only, returns NatureReport (nature:'agent')
 *   planAgent   — read-only, returns WriteOp[] (zero or one link op)
 *   (apply)     — shared with skills via the 'link' op kind in adapter.ts
 *
 * Path conventions:
 *   store  : ~/.config/agent-rigger/agents/<name>.md
 *   target : ~/.claude/agents/<name>.md                (scope:'user')
 *   target : <cwd>/.claude/agents/<name>.md            (scope:'project')
 *
 * Invariants:
 * - auditAgent and planAgent are read-only (no fs writes).
 * - The linker apply is idempotent (linkOrCopy handles existing symlinks).
 * - No while loops; no process.exit().
 * - All path resolution goes through resolveHome / resolveUserTargets.
 */

import { lstat } from 'node:fs/promises';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { assertSafeArtifactName } from '@agent-rigger/core/artifact-name';
import { unlink } from '@agent-rigger/core/linker';
import { resolveHome, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type {
  NatureReport,
  RemovalOp,
  Scope,
  WriteOp,
  WriteOpLink,
} from '@agent-rigger/core/types';

// ---------------------------------------------------------------------------
// agentName
// ---------------------------------------------------------------------------

/**
 * Derive the agent name from the entry id and assert it is safe for filesystem use.
 *
 * 'agent:tech-lead' → 'tech-lead'
 * 'my-agent'        → 'my-agent'
 *
 * Throws UnsafeArtifactNameError when the derived name contains path traversal
 * segments, dots-only names ('.', '..'), or characters outside [a-zA-Z0-9._-].
 * This guard runs before any path construction — plan() is rejected before any
 * store/target path is built, so no cp/rm/symlink is ever invoked on a bad name.
 */
export function agentName(entry: AdapterEntry): string {
  const prefix = 'agent:';
  const name = entry.id.startsWith(prefix) ? entry.id.slice(prefix.length) : entry.id;
  assertSafeArtifactName(name, entry.id);
  return name;
}

// ---------------------------------------------------------------------------
// Path resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the store path for an agent (always user-scope, managed store).
 * ~/.config/agent-rigger/agents/<name>.md
 */
function resolveStorePath(name: string, env: Env): string {
  const targets = resolveUserTargets(env);
  // skillsDir = ~/.config/agent-rigger/skills — replace 'skills' with 'agents'
  const agentsDir = path.join(path.dirname(targets.skillsDir), 'agents');
  return path.join(agentsDir, `${name}.md`);
}

/**
 * Resolve the target path where the agent .md file will be linked.
 *
 * - user scope:    ~/.claude/agents/<name>.md
 * - project scope: <cwd>/.claude/agents/<name>.md
 */
function resolveTargetPath(name: string, scope: Scope, env: Env, cwd?: string): string {
  if (scope === 'project') {
    const projectCwd = cwd ?? process.cwd();
    return path.join(projectCwd, '.claude', 'agents', `${name}.md`);
  }
  // user scope: ~/.claude/agents/<name>.md
  const home = resolveHome(env);
  return path.join(home, '.claude', 'agents', `${name}.md`);
}

// ---------------------------------------------------------------------------
// auditAgent
// ---------------------------------------------------------------------------

/**
 * Audit the current state of an agent artifact on disk.
 *
 * Returns:
 * - 'present' if the target .md path exists (symlink or file).
 * - 'missing' if the target path does not exist.
 *
 * Read-only: no filesystem writes.
 */
export async function auditAgent(
  entry: AdapterEntry,
  scope: Scope,
  env: Env,
  cwd?: string,
): Promise<NatureReport> {
  const name = agentName(entry);
  const targetPath = resolveTargetPath(name, scope, env, cwd);

  const exists = await lstat(targetPath).then(() => true).catch(() => false);

  return {
    id: entry.id,
    nature: 'agent',
    state: exists ? 'present' : 'missing',
  };
}

// ---------------------------------------------------------------------------
// planAgent
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// planRemoveAgent
// ---------------------------------------------------------------------------

/**
 * Compute the removal operations needed to uninstall a sub-agent.
 *
 * Returns [] when the agent target does not exist (not installed).
 * Returns [{ kind: 'unlink', target, store }] when the agent is present.
 *
 * Read-only: no filesystem writes.
 *
 * @param entry   Artifact entry (id carries the agent name).
 * @param scope   Installation scope.
 * @param env     Injectable env for HOME resolution.
 * @param cwd     Working directory (only used when scope is 'project').
 */
export async function planRemoveAgent(
  entry: AdapterEntry,
  scope: Scope,
  env: Env,
  cwd?: string,
): Promise<RemovalOp[]> {
  const report = await auditAgent(entry, scope, env, cwd);
  if (report.state !== 'present') {
    return [];
  }

  const name = agentName(entry);
  const store = resolveStorePath(name, env);
  const target = resolveTargetPath(name, scope, env, cwd);

  return [{ kind: 'unlink', target, store }];
}

// ---------------------------------------------------------------------------
// applyRemoveAgent
// ---------------------------------------------------------------------------

/**
 * Execute unlink removal operations produced by planRemoveAgent.
 *
 * For each unlink op: removes both the target (.md symlink or file) and the
 * store entry. Uses core unlink() which is tolerant to absence (force:true).
 *
 * Ops of any other kind are ignored (forward-compatibility).
 *
 * @param ops  Removal operations (only 'unlink' kind are processed).
 * @param env  Injectable env (kept for interface symmetry).
 */
export async function applyRemoveAgent(ops: RemovalOp[], _env: Env): Promise<void> {
  for (const op of ops) {
    if (op.kind !== 'unlink') {
      continue;
    }
    await unlink(op.target, op.store);
  }
}

// ---------------------------------------------------------------------------
// planAgent
// ---------------------------------------------------------------------------

/**
 * Compute the write operations needed to install a sub-agent.
 *
 * Returns [] when the agent is already present (idempotent).
 * Returns [{ kind: 'link', source, store, target }] when installation is needed.
 *
 * The apply for this op kind is shared with skills (applySkill / opKindHandlers['link']).
 *
 * Read-only: no filesystem writes.
 *
 * @param entry        Artifact entry (id carries the agent name).
 * @param scope        Installation scope.
 * @param env          Injectable env for HOME resolution.
 * @param agentSource  Resolver: entry → absolute path to the agent's source .md file.
 * @param cwd          Working directory (only used when scope is 'project').
 */
export async function planAgent(
  entry: AdapterEntry,
  scope: Scope,
  env: Env,
  agentSource: (entry: AdapterEntry) => string,
  cwd?: string,
): Promise<WriteOp[]> {
  const report = await auditAgent(entry, scope, env, cwd);
  if (report.state === 'present') {
    return [];
  }

  const name = agentName(entry);
  const source = agentSource(entry);
  const store = resolveStorePath(name, env);
  const target = resolveTargetPath(name, scope, env, cwd);

  const op: WriteOpLink = { kind: 'link', source, store, target };
  return [op];
}
