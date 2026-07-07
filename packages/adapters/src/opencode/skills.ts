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

import { lstat } from 'node:fs/promises';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { assertSafeArtifactName } from '@agent-rigger/core/artifact-name';
import { link, removeStoreIfUnreferenced, unlinkTarget } from '@agent-rigger/core/linker';
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

/**
 * Enumerate every known install target path that may reference the shared
 * skill store for `name`: both assistants (claude, opencode) × both scopes
 * (user, project under `cwd`).
 *
 * Claude's paths mirror claude/skills.ts resolveTargetPath:
 * - user:    <home>/.claude/skills/<name>
 * - project: <cwd>/.claude/skills/<name>
 */
function skillTargetCandidates(name: string, env: Env, cwd: string): string[] {
  const claudeDir = path.dirname(resolveUserTargets(env).claudeSettings);
  return [
    path.join(claudeDir, 'skills', name),
    path.join(cwd, '.claude', 'skills', name),
    path.join(resolveOpencodeUserTargets(env).skillsDir, name),
    path.join(resolveOpencodeProjectTargets(cwd).skillsDir, name),
  ];
}

/**
 * Enumerate every known install target that may reference the shared *plugin*
 * store for `fileName`. Plugins are an opencode-only nature (no Claude
 * equivalent), so the candidates are the two opencode pluginDir paths — user and
 * project — mirroring plugins.ts's resolveTargetDir. `fileName` carries the
 * module extension (e.g. `enforce-tests.ts`), matching the on-disk symlink
 * basename verbatim.
 */
function pluginTargetCandidates(fileName: string, env: Env, cwd: string): string[] {
  return [
    path.join(resolveOpencodeUserTargets(env).pluginDir, fileName),
    path.join(resolveOpencodeProjectTargets(cwd).pluginDir, fileName),
  ];
}

/**
 * Enumerate ALL install targets that may keep `store` alive, spanning both
 * store families (skills and plugins). `applyRemoveSkill` is the shared unlink
 * handler for both natures (ADR-0020 §3 — one store, N symlinks), so the store
 * being removed can be either a skill store (`.../agent-rigger/skills/<name>`)
 * or a plugin store (`.../agent-rigger/plugins/<name>.<ext>`).
 *
 * Both families' candidates are enumerated unconditionally rather than branching
 * on the store's location: candidates that do not exist are skipped by
 * removeStoreIfUnreferenced (lstat → null), and a candidate that DOES exist only
 * counts as a reference when its symlink resolves to *this* store, so the extra
 * cross-family paths can never produce a false positive. This keeps the handler
 * nature-agnostic without coupling it to the exact store directory names.
 */
function storeReferenceCandidates(store: string, env: Env, cwd: string): string[] {
  const fileName = path.basename(store);
  return [
    ...skillTargetCandidates(fileName, env, cwd),
    ...pluginTargetCandidates(fileName, env, cwd),
  ];
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
 * For each unlink op (ADR-0020 §3 — one store, N symlinks):
 * 1. Always remove the requested target (symlink/file/directory).
 * 2. Remove the store ONLY when no other known install target still references
 *    it. Reference counting uses filesystem truth (offline): storeReferenceCandidates
 *    enumerates the skill target paths of BOTH assistants (claude, opencode) AND
 *    the opencode plugin target paths, across BOTH scopes (user, project under
 *    `cwd`); each is lstat'd/readlink'd, and any symlink resolving to the store
 *    keeps it alive. Copy-fallback installs (plain directories, no symlink) are
 *    not counted as references.
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
 * @param ops  Removal operations (only 'unlink' kind are processed).
 * @param env  Injectable env for HOME resolution (candidate enumeration).
 * @param cwd  Working directory for project-scope candidates. Defaults to
 *             process.cwd(), matching the adapter's project-scope convention.
 */
export async function applyRemoveSkill(
  ops: RemovalOp[],
  env: Env,
  cwd?: string,
): Promise<void> {
  for (const op of ops) {
    if (op.kind !== 'unlink') {
      continue;
    }
    await unlinkTarget(op.target);
    const candidates = storeReferenceCandidates(op.store, env, cwd ?? process.cwd());
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
