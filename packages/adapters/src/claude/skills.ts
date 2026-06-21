/**
 * Skills handler for the Claude adapter.
 *
 * A skill is installed via the managed store (physical copy) + a symlink
 * at the target path. The scan seam is invoked before any file is written,
 * so a blocking scanner prevents installation entirely.
 *
 * Three functions follow the same shape as guardrails and context handlers:
 *   auditSkill  — read-only, returns NatureReport
 *   planSkill   — read-only, returns WriteOp[] (zero or one link op)
 *   applySkill  — writes: scanner → link (store + symlink)
 *
 * Invariants:
 * - auditSkill and planSkill are read-only (no fs writes).
 * - applySkill is idempotent (linkOrCopy handles existing symlinks).
 * - Scanner is called with the source path; blocked verdict → SkillScanBlockedError.
 * - No while loops; no process.exit().
 * - All path resolution goes through resolveUserTargets / resolveProjectTargets.
 */

import { lstat } from 'node:fs/promises';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { link, unlink } from '@agent-rigger/core/linker';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';
import type { Scanner } from '@agent-rigger/core/scan';
import type {
  NatureReport,
  RemovalOp,
  Scope,
  WriteOp,
  WriteOpLink,
} from '@agent-rigger/core/types';

// ---------------------------------------------------------------------------
// SkillScanBlockedError
// ---------------------------------------------------------------------------

/**
 * Thrown by applySkill when the scanner rejects the source.
 * No files are written when this error is raised.
 */
export class SkillScanBlockedError extends Error {
  readonly source: string;
  readonly findings: string[];

  constructor(source: string, findings: string[]) {
    super(
      `Skill scan blocked: "${source}". Findings: ${findings.join('; ')}`,
    );
    this.name = 'SkillScanBlockedError';
    this.source = source;
    this.findings = findings;
  }
}

// ---------------------------------------------------------------------------
// skillName
// ---------------------------------------------------------------------------

/**
 * Derive the skill name from the entry id.
 * 'skill:spec-workflow' → 'spec-workflow'
 * 'my-skill' → 'my-skill'
 */
export function skillName(entry: AdapterEntry): string {
  const prefix = 'skill:';
  if (entry.id.startsWith(prefix)) {
    return entry.id.slice(prefix.length);
  }
  return entry.id;
}

// ---------------------------------------------------------------------------
// Path resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the store path for a skill (always user-scope, managed store).
 * ~/.config/agent-rigger/skills/<name>
 */
function resolveStorePath(name: string, env: Env): string {
  return path.join(resolveUserTargets(env).skillsDir, name);
}

/**
 * Resolve the target path where the skill will be linked.
 *
 * - user scope:    ~/.claude/skills/<name>
 * - project scope: <cwd>/.claude/skills/<name>
 */
function resolveTargetPath(name: string, scope: Scope, env: Env, cwd?: string): string {
  if (scope === 'project') {
    const projectCwd = cwd ?? process.cwd();
    return path.join(projectCwd, '.claude', 'skills', name);
  }
  // user scope: ~/.claude/skills/<name>
  const home = path.dirname(resolveUserTargets(env).claudeSettings);
  return path.join(home, 'skills', name);
}

// ---------------------------------------------------------------------------
// auditSkill
// ---------------------------------------------------------------------------

/**
 * Audit the current state of a skill artifact on disk.
 *
 * Returns:
 * - 'present' if the target path exists (symlink or directory).
 * - 'missing' if the target path does not exist.
 *
 * Read-only: no filesystem writes.
 */
export async function auditSkill(
  entry: AdapterEntry,
  scope: Scope,
  env: Env,
  cwd?: string,
): Promise<NatureReport> {
  const name = skillName(entry);
  const targetPath = resolveTargetPath(name, scope, env, cwd);

  const exists = await lstat(targetPath).then(() => true).catch(() => false);

  return {
    id: entry.id,
    nature: 'skill',
    state: exists ? 'present' : 'missing',
  };
}

// ---------------------------------------------------------------------------
// planSkill
// ---------------------------------------------------------------------------

/**
 * Compute the write operations needed to install a skill.
 *
 * Returns [] when the skill is already present (idempotent).
 * Returns [{ kind: 'link', source, store, target }] when installation is needed.
 *
 * Read-only: no filesystem writes.
 *
 * @param entry        Artifact entry (id carries the skill name).
 * @param scope        Installation scope.
 * @param env          Injectable env for HOME resolution.
 * @param skillSource  Resolver: entry → absolute path to the skill's source directory.
 * @param cwd          Working directory (only used when scope is 'project').
 */
export async function planSkill(
  entry: AdapterEntry,
  scope: Scope,
  env: Env,
  skillSource: (entry: AdapterEntry) => string,
  cwd?: string,
): Promise<WriteOp[]> {
  const report = await auditSkill(entry, scope, env, cwd);
  if (report.state === 'present') {
    return [];
  }

  const name = skillName(entry);
  const source = skillSource(entry);
  const store = resolveStorePath(name, env);
  const target = resolveTargetPath(name, scope, env, cwd);

  const op: WriteOpLink = { kind: 'link', source, store, target };
  return [op];
}

// ---------------------------------------------------------------------------
// planRemoveSkill
// ---------------------------------------------------------------------------

/**
 * Compute the removal operations needed to uninstall a skill.
 *
 * Returns [] when the skill target does not exist (not installed).
 * Returns [{ kind: 'unlink', target, store }] when the skill is present.
 *
 * Read-only: no filesystem writes.
 *
 * @param entry   Artifact entry (id carries the skill name).
 * @param scope   Installation scope.
 * @param env     Injectable env for HOME resolution.
 * @param cwd     Working directory (only used when scope is 'project').
 */
export async function planRemoveSkill(
  entry: AdapterEntry,
  scope: Scope,
  env: Env,
  cwd?: string,
): Promise<RemovalOp[]> {
  const report = await auditSkill(entry, scope, env, cwd);
  if (report.state !== 'present') {
    return [];
  }

  const name = skillName(entry);
  const store = resolveStorePath(name, env);
  const target = resolveTargetPath(name, scope, env, cwd);

  return [{ kind: 'unlink', target, store }];
}

// ---------------------------------------------------------------------------
// applyRemoveSkill
// ---------------------------------------------------------------------------

/**
 * Execute unlink removal operations produced by planRemoveSkill.
 *
 * For each unlink op: removes both the target (symlink/file/directory) and the
 * store entry. Uses core unlink() which is tolerant to absence (force:true).
 *
 * Ops of any other kind are ignored (forward-compatibility).
 *
 * @param ops  Removal operations (only 'unlink' kind are processed).
 * @param env  Injectable env (kept for interface symmetry).
 */
export async function applyRemoveSkill(ops: RemovalOp[], _env: Env): Promise<void> {
  for (const op of ops) {
    if (op.kind !== 'unlink') {
      continue;
    }
    await unlink(op.target, op.store);
  }
}

// ---------------------------------------------------------------------------
// applySkill
// ---------------------------------------------------------------------------

/**
 * Execute link operations produced by planSkill.
 *
 * For each link op:
 * 1. Call scanner.scan(op.source) — if verdict.ok is false, throw SkillScanBlockedError
 *    and do NOT write anything.
 * 2. Call link(op.source, op.store, op.target) — syncs source to store, then
 *    creates a symlink (or copy fallback) from target to store.
 *
 * Ops of any other kind are ignored (forward-compatibility).
 *
 * @param ops      Write operations (only 'link' kind are processed).
 * @param env      Injectable env (kept for interface symmetry).
 * @param scanner  Security scanner — stubScanner by default (M0: always passes).
 */
export async function applySkill(
  ops: WriteOp[],
  _env: Env,
  scanner: Scanner = stubScanner,
): Promise<void> {
  for (const op of ops) {
    if (op.kind !== 'link') {
      continue;
    }
    const linkOp = op as WriteOpLink;

    const verdict = await scanner.scan(linkOp.source);
    if (!verdict.ok) {
      throw new SkillScanBlockedError(linkOp.source, verdict.findings ?? []);
    }

    await link(linkOp.source, linkOp.store, linkOp.target);
  }
}
