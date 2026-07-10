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

import { lstat, stat } from 'node:fs/promises';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { assertSafeArtifactName } from '@agent-rigger/core/artifact-name';
import { contentMatchesStore, resolvesToStore } from '@agent-rigger/core/linker';
import { resolveHome, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type {
  NatureReport,
  RemovalOp,
  Scope,
  WriteOp,
  WriteOpLink,
} from '@agent-rigger/core/types';

import { planRemoveGate } from '../shared/remove-gate';

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
  // Strip source qualifier if present (ADR-0017: ids may be 'principal/agent:foo')
  const localPart = entry.id.includes('/') ? entry.id.slice(entry.id.indexOf('/') + 1) : entry.id;
  const name = localPart.startsWith(prefix) ? localPart.slice(prefix.length) : localPart;
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
 * Returns (same contract as auditSkill):
 * - 'present' if the target is a symlink resolving to the rigger store, or a
 *   plain .md file byte-identical to it (linkOrCopy copy fallback).
 * - 'drift' if the target exists but is NOT rigger's install shape (real file
 *   with foreign content, symlink pointing outside the store) — R3: the
 *   removal gate refuses such a target, so the audit must keep the divergence
 *   visible (`check` exits 3).
 * - 'missing' if the target path does not exist, or is a DANGLING symlink
 *   (store deleted) — R4: a dead link must be reported broken (check exit 3)
 *   and repairable (the next install re-plans the link op).
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
  const storePath = resolveStorePath(name, env);

  const targetStat = await lstat(targetPath).catch(() => null);
  if (targetStat === null) {
    return { id: entry.id, nature: 'agent', state: 'missing' };
  }

  if (targetStat.isSymbolicLink()) {
    // stat() follows the link: null → the link value resolves to nothing.
    const resolved = await stat(targetPath).catch(() => null);
    if (resolved === null) {
      return {
        id: entry.id,
        nature: 'agent',
        state: 'missing',
        detail: `dangling symlink: ${targetPath}`,
      };
    }
    if (await resolvesToStore(targetPath, storePath)) {
      return { id: entry.id, nature: 'agent', state: 'present' };
    }
    return {
      id: entry.id,
      nature: 'agent',
      state: 'drift',
      detail: `${targetPath} is a symlink resolving outside the rigger store — not managed`,
    };
  }

  // Plain file: a byte-identical copy of the store is a legitimate
  // copy-fallback install; anything else is user content rigger must not claim.
  if (await contentMatchesStore(targetPath, storePath)) {
    return { id: entry.id, nature: 'agent', state: 'present' };
  }
  return {
    id: entry.id,
    nature: 'agent',
    state: 'drift',
    detail: `${targetPath} diverges from the rigger store (not a rigger symlink) — not managed`,
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
 * Returns [{ kind: 'unlink', target, store }] ONLY when the target is a
 * symlink resolving to the rigger store or a byte-identical copy of it
 * (linkOrCopy copy fallback) — R3 gate, shared/remove-gate.ts. Any other
 * present target (real file, foreign symlink) yields a warning-only
 * leave-alone op and nothing is deleted.
 *
 * The apply for the unlink op is shared with skills (applyRemoveSkill via the
 * 'unlink' op kind in adapter.ts) — agents have no removal executor of their
 * own (the former applyRemoveAgent was dead code, deleted by lot2 T6).
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
  const name = agentName(entry);
  const store = resolveStorePath(name, env);
  const target = resolveTargetPath(name, scope, env, cwd);

  return planRemoveGate(entry.id, target, store);
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
  // 'present' → nothing to do; 'drift' → the target carries content rigger
  // does not manage — install must NOT clobber it (link() would rm -f the
  // target). Only 'missing' (absent or dangling symlink) plans the link op.
  if (report.state !== 'missing') {
    return [];
  }

  const name = agentName(entry);
  const source = agentSource(entry);
  const store = resolveStorePath(name, env);
  const target = resolveTargetPath(name, scope, env, cwd);

  const op: WriteOpLink = { kind: 'link', source, store, target };
  return [op];
}
