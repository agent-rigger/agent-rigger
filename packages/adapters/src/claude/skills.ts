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
 * - applyRemoveSkill removes the requested target but deletes the shared store
 *   ONLY when no other install target (any assistant, any scope, any manifest
 *   -recorded cwd) still references it (R4, ADR-0020 §3).
 * - Scanner is called with the source path; blocked verdict → SkillScanBlockedError.
 * - No while loops; no process.exit().
 * - All path resolution goes through resolveUserTargets / resolveProjectTargets.
 */

import { lstat, stat } from 'node:fs/promises';
import path from 'node:path';

import type { AdapterEntry, AdoptionResult } from '@agent-rigger/core/adapter';
import { assertSafeArtifactName } from '@agent-rigger/core/artifact-name';
import {
  contentMatchesStore,
  link,
  removeStoreIfUnreferenced,
  resolvesToStore,
  unlinkTarget,
} from '@agent-rigger/core/linker';
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

import { isRemovableTarget, planRemoveGate } from '../shared/remove-gate';
import { storeReferenceCandidates } from '../shared/store-refs';

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
 * Derive the skill name from the entry id and assert it is safe for filesystem use.
 *
 * 'skill:spec-workflow' → 'spec-workflow'
 * 'my-skill'            → 'my-skill'
 *
 * Throws UnsafeArtifactNameError when the derived name contains path traversal
 * segments (e.g. '../../../../etc/evil'), dots-only names ('.', '..'), or
 * characters outside [a-zA-Z0-9._-]. This guard runs before any path construction,
 * making it impossible to construct a store, target, or symlink path outside the
 * expected directories.
 */
export function skillName(entry: AdapterEntry): string {
  const prefix = 'skill:';
  // Strip source qualifier if present (ADR-0017: ids may be 'principal/skill:foo')
  const localPart = entry.id.includes('/') ? entry.id.slice(entry.id.indexOf('/') + 1) : entry.id;
  const name = localPart.startsWith(prefix) ? localPart.slice(prefix.length) : localPart;
  assertSafeArtifactName(name, entry.id);
  return name;
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
 * - 'present' if the target is a symlink resolving to the rigger store, or a
 *   plain directory byte-identical to it (linkOrCopy copy fallback).
 * - 'drift' if the target exists but is NOT rigger's install shape (real
 *   directory with foreign content, symlink pointing outside the store) — R3:
 *   the removal gate refuses such a target ("present but not managed"), so the
 *   audit must keep the divergence visible: `check` exits 3 instead of lying
 *   'present' about content rigger no longer controls.
 * - 'missing' if the target path does not exist, or is a DANGLING symlink
 *   (store deleted) — R4: a dead link is not an install; reporting it present
 *   made the breakage both undetectable (check exit 0) and unrepairable
 *   (planSkill saw "present" → no-op). With `missing`, check exits 3 and the
 *   next install re-plans the link op, which heals store and symlink.
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
  const storePath = resolveStorePath(name, env);

  const targetStat = await lstat(targetPath).catch(() => null);
  if (targetStat === null) {
    return { id: entry.id, nature: 'skill', state: 'missing' };
  }

  if (targetStat.isSymbolicLink()) {
    // stat() follows the link: null → the link value resolves to nothing.
    const resolved = await stat(targetPath).catch(() => null);
    if (resolved === null) {
      return {
        id: entry.id,
        nature: 'skill',
        state: 'missing',
        detail: `dangling symlink: ${targetPath}`,
      };
    }
    if (await resolvesToStore(targetPath, storePath)) {
      return { id: entry.id, nature: 'skill', state: 'present' };
    }
    return {
      id: entry.id,
      nature: 'skill',
      state: 'drift',
      detail: `${targetPath} is a symlink resolving outside the rigger store — not managed`,
    };
  }

  // Plain directory/file: a byte-identical copy of the store is a legitimate
  // copy-fallback install; anything else is user content rigger must not claim.
  if (await contentMatchesStore(targetPath, storePath)) {
    return { id: entry.id, nature: 'skill', state: 'present' };
  }
  return {
    id: entry.id,
    nature: 'skill',
    state: 'drift',
    detail: `${targetPath} diverges from the rigger store (not a rigger symlink) — not managed`,
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
  // 'present' → nothing to do; 'drift' → the target carries content rigger
  // does not manage — install must NOT clobber it (link() would rm -rf the
  // target), same never-destroy posture as the R3 removal gate. Only
  // 'missing' (absent or dangling symlink) plans the link op.
  if (report.state !== 'missing') {
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
// adoptSkill
// ---------------------------------------------------------------------------

/**
 * Adopt gate for the skill nature (R5/D5).
 *
 * Adopts ONLY when auditSkill is EXACTLY `present` (a symlink resolving to the
 * rigger store, or a byte-identical copy). This is STRICTER than planSkill's
 * empty-plan condition: planSkill returns [] for both `present` AND `drift` (it
 * refuses to clobber unmanaged content), so the adoption branch would otherwise
 * see a drifted target too — but a drift MUST NOT be adopted (the manifest would
 * claim the user's foreign directory, and remove would destroy it). files record
 * the target symlink path only (parity with a link-op install's AppliedLink).
 *
 * Read-only: no filesystem writes.
 *
 * @param entry  Artifact entry (id carries the skill name).
 * @param scope  Installation scope.
 * @param env    Injectable env for HOME resolution.
 * @param cwd    Working directory (only used when scope is 'project').
 */
export async function adoptSkill(
  entry: AdapterEntry,
  scope: Scope,
  env: Env,
  cwd?: string,
): Promise<AdoptionResult | undefined> {
  const report = await auditSkill(entry, scope, env, cwd);
  if (report.state !== 'present') {
    return undefined;
  }
  const name = skillName(entry);
  const target = resolveTargetPath(name, scope, env, cwd);
  return { applied: { kind: 'link', files: [target] }, files: [target] };
}

// ---------------------------------------------------------------------------
// planRemoveSkill
// ---------------------------------------------------------------------------

/**
 * Compute the removal operations needed to uninstall a skill.
 *
 * Returns [] when the skill target does not exist (not installed).
 * Returns [{ kind: 'unlink', target, store }] ONLY when the target is a
 * symlink resolving to the rigger store or a byte-identical copy of it
 * (linkOrCopy copy fallback) — R3 gate, shared/remove-gate.ts. Any other
 * present target (hand-made directory, foreign symlink) yields a warning-only
 * leave-alone op and nothing is deleted.
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
  const name = skillName(entry);
  const store = resolveStorePath(name, env);
  const target = resolveTargetPath(name, scope, env, cwd);

  return planRemoveGate(entry.id, target, store);
}

// ---------------------------------------------------------------------------
// applyRemoveSkill
// ---------------------------------------------------------------------------

/**
 * Execute unlink removal operations produced by planRemoveSkill / planRemoveAgent.
 *
 * For each unlink op (R4, ADR-0020 §3 — one store, N symlinks):
 * 0. Re-verify the R3 gate decision at the moment of destruction
 *    (isRemovableTarget): the window between planRemoveGate and this rm spans
 *    the config backups and the store backupDir, long enough for the symlink
 *    to be swapped for a real directory (no inter-process lock before Lot 3).
 *    A target that no longer resolves to the store (nor matches it byte for
 *    byte) is NOT rigger's anymore — the op is skipped, nothing is deleted,
 *    same posture as the plan-time gate.
 * 1. Remove the requested target (symlink/file/directory).
 * 2. Remove the store ONLY when no other install target still references it.
 *    Reference counting is filesystem truth at the moment of the remove
 *    (offline, never divergent from disk): the shared storeReferenceCandidates
 *    helper enumerates the claude skill/agent and opencode skill/plugin target
 *    paths of both scopes under `cwd`, PLUS the `manifestFiles` handed down by
 *    the engine (targets of the manifest entries remaining after this removal
 *    — a project install from another cwd is only discoverable there). Each
 *    candidate is lstat'd/readlink'd; copy-fallback installs (plain
 *    directories, no symlink) never count as references.
 *
 * Both removals are tolerant to absence (rm force).
 * Ops of any other kind are ignored (forward-compatibility).
 *
 * @param ops            Removal operations (only 'unlink' kind are processed).
 * @param env            Injectable env for HOME resolution (candidate enumeration).
 * @param cwd            Working directory for project-scope candidates.
 *                       Defaults to process.cwd(), matching the adapter's
 *                       project-scope convention.
 * @param manifestFiles  Extra reference candidates from the manifest (R4),
 *                       passed through Adapter.applyRemove by the engine.
 */
export async function applyRemoveSkill(
  ops: RemovalOp[],
  env: Env,
  cwd?: string,
  manifestFiles: string[] = [],
): Promise<void> {
  for (const op of ops) {
    if (op.kind !== 'unlink') {
      continue;
    }
    // R3 TOCTOU re-check: the plan gate's verdict must still hold NOW. A
    // target swapped for unmanaged content since plan time is left in place
    // (skip the whole op — the store stays too, exactly like a plan-time
    // leave-alone). An ABSENT target passes: nothing to destroy, and rollback
    // compensations / dangling cleanups still need the store removal below.
    if (!(await isRemovableTarget(op.target, op.store))) {
      continue;
    }
    await unlinkTarget(op.target);
    const candidates = storeReferenceCandidates(
      op.store,
      env,
      cwd ?? process.cwd(),
      manifestFiles,
    );
    await removeStoreIfUnreferenced(op.store, candidates);
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
