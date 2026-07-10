/**
 * Skills handler for the opencode adapter.
 *
 * Mirrors claude/skills.ts: a skill is installed via the managed store
 * (physical copy) + a symlink at the target path. Only the target path
 * differs from Claude — the store is the SAME physical location
 * (~/.config/agent-rigger/skills/<name>, resolveUserTargets().skillsDir),
 * shared between assistants: one store, N symlinks, so removing the opencode
 * symlink never impacts Claude's. The scan seam is invoked before any file is
 * written, so a blocking scanner prevents installation entirely.
 *
 * Three functions follow the same shape as the claude handlers:
 *   auditSkill  — read-only, returns NatureReport
 *   planSkill   — read-only, returns WriteOp[] (zero or one link op)
 *   applySkill  — writes: scanner → link (store + symlink)
 *
 * Invariants:
 * - auditSkill and planSkill are read-only (no fs writes).
 * - applySkill is idempotent (linkOrCopy handles existing symlinks).
 * - applyRemoveSkill removes the requested symlink but deletes the shared store
 *   ONLY when no other install target (claude/opencode × user/project) still
 *   references it (ADR-0020 §3 — remove opencode never impacts Claude).
 * - Scanner is called with the source path; blocked verdict → SkillScanBlockedError.
 * - No while loops; no process.exit().
 * - All path resolution goes through resolveUserTargets / resolveOpencodeUserTargets /
 *   resolveOpencodeProjectTargets.
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
import {
  resolveOpencodeProjectTargets,
  resolveOpencodeUserTargets,
  resolveUserTargets,
} from '@agent-rigger/core/paths';
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
 * Resolve the store path for a skill (always user-scope, shared with Claude).
 * ~/.config/agent-rigger/skills/<name>
 */
function resolveStorePath(name: string, env: Env): string {
  return path.join(resolveUserTargets(env).skillsDir, name);
}

/**
 * Resolve the target path where the skill will be linked (opencode-owned).
 *
 * - user scope:    ~/.config/opencode/skills/<name>
 * - project scope: <cwd>/.opencode/skills/<name>
 */
function resolveTargetPath(name: string, scope: Scope, env: Env, cwd?: string): string {
  if (scope === 'project') {
    return path.join(resolveOpencodeProjectTargets(cwd).skillsDir, name);
  }
  return path.join(resolveOpencodeUserTargets(env).skillsDir, name);
}

// ---------------------------------------------------------------------------
// auditSkill
// ---------------------------------------------------------------------------

/**
 * Audit the current state of a skill artifact on disk.
 *
 * Returns (same contract as the claude handler):
 * - 'present' if the target is a symlink resolving to the rigger store, or a
 *   plain directory byte-identical to it (linkOrCopy copy fallback).
 * - 'drift' if the target exists but is NOT rigger's install shape (real
 *   directory with foreign content, symlink pointing outside the store) — R3:
 *   the removal gate refuses such a target, so the audit must keep the
 *   divergence visible (`check` exits 3).
 * - 'missing' if the target path does not exist, or is a DANGLING symlink
 *   (store deleted) — R4: same truthful-audit contract as the claude handler;
 *   a dead link must be reported broken (check exit 3) and repairable (the
 *   next install re-plans the link op, link() heals store and symlink).
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
  // target). Only 'missing' (absent or dangling symlink) plans the link op.
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
 * Adopt gate for the opencode skill nature (R5/D5).
 *
 * Adopts ONLY when auditSkill is EXACTLY `present` (a symlink resolving to the
 * rigger store, or a byte-identical copy). Stricter than planSkill's empty-plan
 * condition (which returns [] for `present` AND `drift`): a drifted target is
 * NEVER adopted — the manifest must not claim the user's foreign directory, and
 * remove must not destroy it. files record the target symlink path only (parity
 * with a link-op install's AppliedLink). Mirrors claude/skills.ts adoptSkill.
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
 * symlink resolving to the rigger store — including a DANGLING one (the audit
 * reports a dead link as `missing`, R4, but remove must still clean it up:
 * resolvesToStore compares paths without requiring the store to exist) — or a
 * byte-identical copy of the store (linkOrCopy copy fallback). Any other
 * present target (hand-made directory, foreign symlink) yields a warning-only
 * leave-alone op and nothing is deleted — same R3 gate as the claude handler
 * (shared/remove-gate.ts): an unmanaged target replacing the install symlink
 * is user content, never rm -rf'd.
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
 * Execute unlink removal operations produced by planRemoveSkill.
 *
 * For each unlink op (ADR-0020 §3 — one store, N symlinks):
 * 1. Always remove the requested target (symlink/file/directory).
 * 2. Remove the store ONLY when no other known install target still references
 *    it. Reference counting uses filesystem truth (offline): the shared
 *    storeReferenceCandidates helper (shared/store-refs.ts, common with the
 *    claude adapter — R4 de-duplication) enumerates the claude skill/agent and
 *    opencode skill/plugin target paths across BOTH scopes (user, project
 *    under `cwd`), PLUS the `manifestFiles` handed down by the engine (targets
 *    of the manifest entries remaining after this removal — a project install
 *    from another cwd is only discoverable there). Each candidate is
 *    lstat'd/readlink'd, and any symlink resolving to the store keeps it
 *    alive. Copy-fallback installs (plain directories, no symlink) are not
 *    counted as references.
 *
 * Plugin unlink ops also flow through this function (shared 'unlink' op kind,
 * see adapter.ts). Their store lives under ~/.config/agent-rigger/plugins/ and
 * is ref-counted the SAME way as a skill store: a plugin installed at both
 * scopes shares one user-scope store, so removing one scope's symlink must NOT
 * delete the store while the other scope still references it (ADR-0020 §3).
 *
 * Both removals are tolerant to absence (rm force).
 * Ops of any other kind are ignored (forward-compatibility).
 *
 * @param ops            Removal operations (only 'unlink' kind are processed).
 * @param env            Injectable env for HOME resolution (candidate enumeration).
 * @param cwd            Working directory for project-scope candidates. Defaults to
 *                       process.cwd(), matching the adapter's project-scope convention.
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
