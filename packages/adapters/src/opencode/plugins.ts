/**
 * Plugins handler for the opencode adapter.
 *
 * opencode has no native plugin install (delegate-first, ADR-0003, does not
 * apply — ADR-0020 §4): a plugin is a JS/TS module (API `tool.execute.before/
 * after`) that the CATALOG provides verbatim; the adapter only copies it into
 * `pluginDir`. This mirrors skills.ts's store+symlink mechanism (core/linker's
 * `link`/`unlink`) — a plugin module is a FILE rather than a directory, but
 * `syncToStore`/`linkOrCopy` handle files the same way (cp / symlink), so the
 * 'link'/'unlink' op kinds and their existing opKindHandlers (applySkill /
 * applyRemoveSkill, already wired in adapter.ts) are reused verbatim: applySkill
 * is nature-agnostic (scans op.source, then links store→target) — no new apply
 * function is needed here, and no new op kind either (tasks.md A2).
 *
 * Store: ~/.config/agent-rigger/plugins/<name>.<ext> — a sibling of the shared
 * skills store (derived from resolveUserTargets(env).skillsDir's parent; kept
 * OUT of core/paths.ts since it is opencode-specific and core stays frozen
 * post-review). Target: resolveOpencode{User,Project}Targets().pluginDir/<name>.<ext>.
 *
 * Three functions mirror skills.ts's shape:
 *   auditPlugin       — read-only, returns NatureReport
 *   planPlugin        — read-only, returns WriteOp[] (zero or one link op)
 *   planRemovePlugin  — read-only, returns RemovalOp[] (zero or one unlink op)
 *
 * The target filename carries an extension resolved from the source module, so
 * unlike skillName-only lookups, audit/planRemove locate the installed file by
 * searching pluginDir for any entry whose basename (extension stripped) equals
 * the plugin name — this keeps planRemove fully offline (no `pluginSource`
 * resolver required, R12.1) and keeps auditPlugin's signature aligned with
 * auditSkill's (no source needed for a read-only presence check either).
 *
 * Invariants:
 * - auditPlugin and planPlugin/planRemovePlugin are read-only (no fs writes).
 * - The scanner runs at apply time (applySkill's responsibility, not this module's).
 * - No while loops; no process.exit().
 * - All path resolution goes through resolveUserTargets / resolveOpencodeUserTargets /
 *   resolveOpencodeProjectTargets.
 */

import { lstat, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { AdapterEntry, AdoptionResult } from '@agent-rigger/core/adapter';
import { assertSafeArtifactName } from '@agent-rigger/core/artifact-name';
import {
  resolveOpencodeProjectTargets,
  resolveOpencodeUserTargets,
  resolveUserTargets,
} from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type {
  NatureReport,
  RemovalOp,
  Scope,
  WriteOp,
  WriteOpLink,
} from '@agent-rigger/core/types';

// ---------------------------------------------------------------------------
// pluginName
// ---------------------------------------------------------------------------

/**
 * Derive the plugin name from the entry id and assert it is safe for filesystem use.
 *
 * 'plugin:enforce-tests' → 'enforce-tests'
 * 'my-plugin'            → 'my-plugin'
 *
 * Throws UnsafeArtifactNameError when the derived name contains path traversal
 * segments (e.g. '../../../../etc/evil'), dots-only names ('.', '..'), or
 * characters outside [a-zA-Z0-9._-].
 */
export function pluginName(entry: AdapterEntry): string {
  const prefix = 'plugin:';
  // Strip source qualifier if present (ADR-0017: ids may be 'principal/plugin:foo')
  const localPart = entry.id.includes('/') ? entry.id.slice(entry.id.indexOf('/') + 1) : entry.id;
  const name = localPart.startsWith(prefix) ? localPart.slice(prefix.length) : localPart;
  assertSafeArtifactName(name, entry.id);
  return name;
}

// ---------------------------------------------------------------------------
// requiresLib
// ---------------------------------------------------------------------------

/**
 * True when the entry declares an edge to a shared lib (R4, lib-nature). The
 * nature is encoded in the ref prefix (`lib:<name>`, qualified as
 * `<catalog>/lib:<name>`), so a manifest/catalog lookup is unnecessary — the
 * same local qualifier-strip `pluginName` uses is enough. This is the ONE place
 * an opencode nature reads `AdapterEntry.requires`: a plugin that depends on a
 * lib is only correct as a real symlink (its `../libs/<name>/…` import resolves
 * against the store), so its pose and audit must both fail closed on a copy.
 */
export function requiresLib(entry: AdapterEntry): boolean {
  return (entry.requires ?? []).some((ref) => {
    const local = ref.includes('/') ? ref.slice(ref.indexOf('/') + 1) : ref;
    return local.startsWith('lib:');
  });
}

// ---------------------------------------------------------------------------
// Path resolution helpers
// ---------------------------------------------------------------------------

/** Derive the store/target filename: the artifact name plus the source module's extension. */
function fileNameFor(name: string, source: string): string {
  return `${name}${path.extname(source)}`;
}

/**
 * Resolve the store path for a plugin (always user-scope, sibling of the
 * shared skills store under ~/.config/agent-rigger/).
 * ~/.config/agent-rigger/plugins/<name>.<ext>
 */
function resolveStorePath(fileName: string, env: Env): string {
  const skillsDir = resolveUserTargets(env).skillsDir;
  return path.join(path.dirname(skillsDir), 'plugins', fileName);
}

/**
 * Resolve the directory where the plugin is linked (opencode-owned).
 *
 * - user scope:    ~/.config/opencode/plugin/
 * - project scope: <cwd>/.opencode/plugin/
 */
function resolveTargetDir(scope: Scope, env: Env, cwd?: string): string {
  if (scope === 'project') {
    return resolveOpencodeProjectTargets(cwd).pluginDir;
  }
  return resolveOpencodeUserTargets(env).pluginDir;
}

/**
 * Search `dir` for a file whose basename (extension stripped) equals `name`.
 * Returns the matching filename, or undefined when none is found (dir absent
 * or no match) — never throws.
 */
async function findInstalledFile(dir: string, name: string): Promise<string | undefined> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries.find((entry) => path.parse(entry).name === name);
}

// ---------------------------------------------------------------------------
// auditPlugin
// ---------------------------------------------------------------------------

/**
 * Audit the current state of a plugin artifact on disk.
 *
 * Returns:
 * - 'present' if pluginDir contains a file whose name (any extension) matches
 *   AND it resolves to real content (plain file, or a symlink whose target
 *   exists).
 * - 'missing' if no matching file exists, OR the match is a DANGLING symlink
 *   (store deleted) — R9 (doctor): a bare `readdir` name-match sees the link's
 *   directory entry regardless of whether it resolves, so it used to report
 *   `present` on a dead link (the file/plugin is NOT usable). `lstat`+`stat`
 *   mirrors the skill/agent handlers' truthful-audit contract (R4): a dead
 *   link must be reported broken and repairable, not silently `present`.
 * - 'missing' ALSO when the match is a PLAIN COPY (not a symlink) and the entry
 *   requires a lib (R4, lib-nature, Finding 3): the copy's `../libs/<name>/…`
 *   import resolves against the copy's own directory, not the store — broken at
 *   runtime. Reported broken-and-repairable (a symlink-capable reinstall heals
 *   it) so `check` surfaces it (exit 3) instead of vouching for it. A copy of a
 *   lib-FREE plugin stays `present` — the copy fallback is legitimate there.
 *
 * Read-only: no filesystem writes.
 *
 * @param entry  Artifact entry (id carries the plugin name).
 * @param scope  Installation scope.
 * @param env    Injectable env for HOME resolution.
 * @param cwd    Working directory (only used when scope is 'project').
 */
export async function auditPlugin(
  entry: AdapterEntry,
  scope: Scope,
  env: Env,
  cwd?: string,
): Promise<NatureReport> {
  const name = pluginName(entry);
  const targetDir = resolveTargetDir(scope, env, cwd);
  const found = await findInstalledFile(targetDir, name);

  if (found === undefined) {
    return { id: entry.id, nature: 'plugin', state: 'missing' };
  }

  const targetPath = path.join(targetDir, found);
  const targetStat = await lstat(targetPath).catch(() => null);
  if (targetStat === null) {
    return { id: entry.id, nature: 'plugin', state: 'missing' };
  }

  if (targetStat.isSymbolicLink()) {
    // stat() follows the link: null → the link value resolves to nothing.
    const resolved = await stat(targetPath).catch(() => null);
    if (resolved === null) {
      return {
        id: entry.id,
        nature: 'plugin',
        state: 'missing',
        detail: `dangling symlink: ${targetPath}`,
      };
    }
  } else if (requiresLib(entry)) {
    // Plain copy of a plugin that requires a shared lib (R4, Finding 3): the
    // copy's relative lib import cannot resolve — broken. Reported as a
    // repairable `missing` (a symlink-capable reinstall re-poses it as a link).
    return {
      id: entry.id,
      nature: 'plugin',
      state: 'missing',
      detail: `copy-installed but requires a shared lib — its relative import cannot `
        + `resolve; reinstall on a symlink-capable host: ${targetPath}`,
    };
  }

  return { id: entry.id, nature: 'plugin', state: 'present' };
}

// ---------------------------------------------------------------------------
// planPlugin
// ---------------------------------------------------------------------------

/**
 * Compute the write operations needed to install a plugin.
 *
 * Returns [] when the plugin is already present (idempotent).
 * Returns [{ kind: 'link', source, store, target }] when installation is needed.
 *
 * Read-only: no filesystem writes.
 *
 * @param entry         Artifact entry (id carries the plugin name).
 * @param scope         Installation scope.
 * @param env           Injectable env for HOME resolution.
 * @param pluginSource  Resolver: entry → absolute path to the plugin's `.ts`/`.js` source module.
 * @param cwd           Working directory (only used when scope is 'project').
 */
export async function planPlugin(
  entry: AdapterEntry,
  scope: Scope,
  env: Env,
  pluginSource: (entry: AdapterEntry) => string,
  cwd?: string,
): Promise<WriteOp[]> {
  const report = await auditPlugin(entry, scope, env, cwd);
  if (report.state === 'present') {
    return [];
  }

  const name = pluginName(entry);
  const source = pluginSource(entry);
  const fileName = fileNameFor(name, source);
  const store = resolveStorePath(fileName, env);
  const target = path.join(resolveTargetDir(scope, env, cwd), fileName);

  // Flag the pose as symlink-required when the entry depends on a lib (R4,
  // Finding 3): applySkill then fails closed if link() falls back to a copy.
  const op: WriteOpLink = requiresLib(entry)
    ? { kind: 'link', source, store, target, requiresSymlink: true }
    : { kind: 'link', source, store, target };
  return [op];
}

// ---------------------------------------------------------------------------
// planRemovePlugin
// ---------------------------------------------------------------------------

/**
 * Compute the removal operations needed to uninstall a plugin.
 *
 * Discovers the actually installed file (and its extension) from disk — fully
 * offline, no `pluginSource` resolver required (R12.1). Returns [] when nothing
 * is installed. Returns [{ kind: 'unlink', target, store }] otherwise.
 *
 * Read-only: no filesystem writes.
 *
 * @param entry  Artifact entry (id carries the plugin name).
 * @param scope  Installation scope.
 * @param env    Injectable env for HOME resolution.
 * @param cwd    Working directory (only used when scope is 'project').
 */
export async function planRemovePlugin(
  entry: AdapterEntry,
  scope: Scope,
  env: Env,
  cwd?: string,
): Promise<RemovalOp[]> {
  const name = pluginName(entry);
  const targetDir = resolveTargetDir(scope, env, cwd);
  const fileName = await findInstalledFile(targetDir, name);
  if (fileName === undefined) {
    return [];
  }

  const store = resolveStorePath(fileName, env);
  const target = path.join(targetDir, fileName);
  return [{ kind: 'unlink', target, store }];
}

// ---------------------------------------------------------------------------
// adoptPlugin
// ---------------------------------------------------------------------------

/**
 * Adopt gate for the opencode plugin nature (R5/D5).
 *
 * Adopts ONLY when auditPlugin is `present` (pluginDir holds a file matching the
 * name) — the same condition under which planPlugin returns [] (empty plan).
 *
 * The AdoptionResult MUST record the installed target in both `applied`
 * (AppliedLink) and `files`, exactly as a normal install does (engine
 * extractApplied maps a link WriteOp → { kind: 'link', files: [target] }). An
 * opencode plugin is a store+symlink artifact sharing ONE user-level store
 * (~/.config/agent-rigger/plugins/<name>.<ext>) across scopes and cwds — NOT a
 * native-CLI delegate like the claude plugin nature. The store's cross-cwd
 * refcount (R4/D4) is enumerated from the manifest `files` of the entries that
 * remain after a removal (storeReferenceCandidates): a project-scope reference
 * installed from a DIFFERENT cwd is discoverable ONLY through those files.
 * Returning `files: []` here would drop this entry's target from the refcount,
 * so removing a sibling reference from another cwd would delete the still-shared
 * store and leave the adopted reference a dangling symlink. Recording the target
 * (mirror of adoptSkill) keeps the adopted reference counted.
 *
 * Read-only: no filesystem writes.
 *
 * @param entry  Artifact entry (id carries the plugin name).
 * @param scope  Installation scope.
 * @param env    Injectable env for HOME resolution.
 * @param cwd    Working directory (only used when scope is 'project').
 */
export async function adoptPlugin(
  entry: AdapterEntry,
  scope: Scope,
  env: Env,
  cwd?: string,
): Promise<AdoptionResult | undefined> {
  const report = await auditPlugin(entry, scope, env, cwd);
  if (report.state !== 'present') {
    return undefined;
  }

  // Discover the actually installed file (and its extension) from disk — fully
  // offline, same lookup planRemovePlugin uses. Present per auditPlugin above,
  // so findInstalledFile resolves; fall back defensively to the extension-less
  // name if a concurrent removal raced the audit.
  const name = pluginName(entry);
  const targetDir = resolveTargetDir(scope, env, cwd);
  const fileName = (await findInstalledFile(targetDir, name)) ?? name;
  const target = path.join(targetDir, fileName);

  return { applied: { kind: 'link', files: [target] }, files: [target] };
}
