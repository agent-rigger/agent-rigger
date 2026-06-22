/**
 * Engine orchestrator for agent-rigger.
 *
 * Two public operations:
 *
 *   check(adapter, entries, scope, env)           → Report
 *   apply(adapter, entries, scope, env, manifestPath) → ApplyResult
 *
 * Exit code mapping (derived — CLI maps these):
 *   0 → all entries 'present'
 *   2 → JSON invalid (InvalidJsonError propagates; CLI catches it)
 *   3 → at least one entry 'missing' or 'drift'
 *
 * Design invariants:
 * - check() performs ZERO writes. InvalidJsonError from readJson propagates.
 * - apply() is idempotent: if adapter.plan() returns [] the entry is a no-op.
 * - backup-before-write: the engine calls backup() for every op target that
 *   exists on disk BEFORE calling adapter.apply().
 * - No process.exit() — the CLI maps typed errors to exit codes.
 * - No while loops — for...of / map / Promise.all only.
 */

import type { Adapter, AdapterEntry } from './adapter';
import { backup } from './backup';
import { readManifest, upsertEntry, writeManifest } from './manifest';
import type { Env } from './paths';
import type { Manifest, ManifestEntry, Report, Scope } from './types';

// ---------------------------------------------------------------------------
// RemoveResult
// ---------------------------------------------------------------------------

/**
 * Result returned by remove().
 *
 * - removed:   Ids of entries that were removed (planRemove returned ops).
 * - backedUp:  Paths of .bak-* files created before removals.
 * - manifest:  The manifest as it was persisted after this remove run.
 */
export interface RemoveResult {
  removed: string[];
  backedUp: string[];
  manifest: Manifest;
}

// ---------------------------------------------------------------------------
// ApplyResult
// ---------------------------------------------------------------------------

/**
 * Result returned by apply().
 *
 * - written:   Paths of files written by adapter.apply() (from WriteOp.path).
 * - backedUp:  Paths of .bak-* files created before writes.
 * - manifest:  The manifest as it was persisted after this apply run.
 */
export interface ApplyResult {
  written: string[];
  backedUp: string[];
  manifest: Manifest;
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

/**
 * Audit all entries and aggregate results into a Report.
 *
 * Pure read operation — no writes, no backups.
 * If any adapter.audit() call throws (e.g. InvalidJsonError from readJson),
 * the error propagates as-is. The CLI maps it to exit code 2.
 *
 * @param adapter  The adapter to use for auditing.
 * @param entries  Catalog entries to audit.
 * @param scope    Installation scope ('user' | 'project').
 * @param env      Injectable env for HOME resolution.
 */
export async function check(
  adapter: Adapter,
  entries: AdapterEntry[],
  scope: Scope,
  env: Env,
): Promise<Report> {
  const natureReports = await Promise.all(
    entries.map((entry) => adapter.audit(entry, scope, env)),
  );

  return { entries: natureReports };
}

// ---------------------------------------------------------------------------
// reportExitCode
// ---------------------------------------------------------------------------

/**
 * Derive the CLI exit code from a Report.
 *
 * Returns 0 if every entry is 'present'; 3 if any entry is 'missing' or 'drift'.
 * Exit code 2 (invalid JSON / usage error) is never produced here — it comes
 * from InvalidJsonError propagating through check() to the CLI.
 */
export function reportExitCode(report: Report): 0 | 3 {
  const allPresent = report.entries.every((e) => e.state === 'present');
  return allPresent ? 0 : 3;
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

/**
 * Apply all entries: plan → backup → write → manifest.
 *
 * For each entry:
 *   1. Call adapter.plan() to get the set of WriteOps.
 *   2. If plan is empty → no-op (idempotent; already installed).
 *   3. Otherwise: backup every op target that exists on disk.
 *   4. Call adapter.apply(ops, env) to perform the writes.
 *   5. Upsert a ManifestEntry for this artifact.
 * After all entries: persist the updated manifest.
 *
 * @param adapter       The adapter to use for planning and writing.
 * @param entries       Catalog entries to install.
 * @param scope         Installation scope ('user' | 'project').
 * @param env           Injectable env for HOME resolution.
 * @param manifestPath  Absolute path to state.json (e.g. from resolveUserTargets).
 * @param versionFor    Optional seam: maps an entry to its ref/sha for the
 *                      manifest. When omitted the defaults apply (ref:'v0.0.0', sha:'').
 */
export async function apply(
  adapter: Adapter,
  entries: AdapterEntry[],
  scope: Scope,
  env: Env,
  manifestPath: string,
  versionFor?: (
    entry: AdapterEntry,
  ) => { ref: string; sha: string },
): Promise<ApplyResult> {
  let manifest = await readManifest(manifestPath);

  const allWritten: string[] = [];
  const allBackedUp: string[] = [];

  for (const entry of entries) {
    const ops = await adapter.plan(entry, scope, env);

    // No ops → idempotent no-op; already installed.
    // Leave the manifest untouched for this entry (preserve existing record).
    if (ops.length === 0) {
      continue;
    }

    // Collect target paths from ops for tracking.
    // - Ops with 'path' use op.path (write-json, write-text, merge-deny, ensure-import).
    // - Link ops use op.target (symlink destination); the linker is atomic, no backup needed.
    // - Ops with neither 'path' nor 'target' (e.g. plugin-install) contribute no path;
    //   they perform no direct file write, so nothing to track or back up.
    const targets = ops.flatMap((op) => {
      if ('path' in op) return [op.path as string];
      if ('target' in op) return [(op as { target: string }).target];
      return [];
    });

    // Backup every target that currently exists on disk.
    // Skip link ops (linker is atomic) and plugin-install ops (no file written).
    const backupTargets = ops
      .filter((op) => 'path' in op)
      .map((op) => (op as { path: string }).path);
    const bakResults = await Promise.all(backupTargets.map((p) => backup(p)));
    const backedUp = bakResults.filter((b): b is string => b !== null);
    allBackedUp.push(...backedUp);

    // Delegate actual writes to the adapter
    await adapter.apply(ops, env);

    // Track written paths
    allWritten.push(...targets);

    // Upsert manifest entry with the files written
    const version = versionFor === undefined ? undefined : versionFor(entry);
    manifest = upsertEntry(manifest, buildManifestEntry(entry, scope, targets, version));
  }

  // Persist the manifest once after all entries have been processed
  await writeManifest(manifestPath, manifest);

  return { written: allWritten, backedUp: allBackedUp, manifest };
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

/**
 * Remove all entries: planRemove → backup → applyRemove → manifest update.
 *
 * For each entry:
 *   1. Call adapter.planRemove() to get the set of RemovalOps.
 *   2. If plan is empty → no-op (idempotent; not installed or already removed).
 *   3. Otherwise: backup every op target that exists on disk.
 *      - Ops with a `path` field (remove-deny, remove-block, delete-file) are backed up.
 *      - Ops with `target` (unlink) and `plugin-uninstall` ops are not backed up
 *        (unlink is handled by the primitive; plugin-uninstall has no file).
 *   4. Call adapter.applyRemove(ops, env) to perform the removals.
 *   5. Remove the entry from the manifest (filter by id + scope).
 * After all entries: persist the updated manifest.
 *
 * Idempotent: if planRemove returns [] (artifact not installed) → no-op,
 * manifest unchanged.
 *
 * @param adapter       The adapter to use for planning and removing.
 * @param entries       Catalog entries to remove.
 * @param scope         Installation scope ('user' | 'project').
 * @param env           Injectable env for HOME resolution.
 * @param manifestPath  Absolute path to state.json.
 */
export async function remove(
  adapter: Adapter,
  entries: AdapterEntry[],
  scope: Scope,
  env: Env,
  manifestPath: string,
): Promise<RemoveResult> {
  let manifest = await readManifest(manifestPath);

  const allRemoved: string[] = [];
  const allBackedUp: string[] = [];

  for (const entry of entries) {
    const ops = await adapter.planRemove(entry, scope, env);

    // No ops → not installed; leave the manifest untouched for this entry.
    if (ops.length === 0) {
      continue;
    }

    // Backup targets with a `path` field before removal.
    // Ops with `target` (unlink) delegate removal to the primitive.
    // `plugin-uninstall` has neither path nor target — nothing to back up.
    const backupTargets = ops.flatMap((op) => {
      if (op.kind === 'remove-deny' || op.kind === 'remove-block' || op.kind === 'delete-file') {
        return [op.path];
      }
      return [];
    });

    const bakResults = await Promise.all(backupTargets.map((p) => backup(p)));
    const backedUp = bakResults.filter((b): b is string => b !== null);
    allBackedUp.push(...backedUp);

    // Delegate actual removals to the adapter
    await adapter.applyRemove(ops, env);

    // Remove this entry from the manifest
    manifest = removeEntry(manifest, entry.id, scope);
    allRemoved.push(entry.id);
  }

  // Persist the manifest once after all entries have been processed
  await writeManifest(manifestPath, manifest);

  return { removed: allRemoved, backedUp: allBackedUp, manifest };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Return a new Manifest with the entry matching both `id` and `scope` removed.
 * Pure / immutable: the input manifest is not mutated.
 */
function removeEntry(manifest: Manifest, id: string, scope: Scope): Manifest {
  return {
    ...manifest,
    artifacts: manifest.artifacts.filter((e) => !(e.id === id && e.scope === scope)),
  };
}

/**
 * Build a ManifestEntry from an AdapterEntry + the paths written.
 * Defaults: ref 'v0.0.0', sha '' (no remote fetch yet).
 *
 * @param version  Optional override for ref/sha. When omitted the
 *                 defaults apply. Provided by the versionFor seam in apply().
 */
function buildManifestEntry(
  entry: AdapterEntry,
  scope: Scope,
  files: string[],
  version?: { ref: string; sha: string },
): ManifestEntry {
  const ref = version === undefined ? 'v0.0.0' : version.ref;
  const sha = version === undefined ? '' : version.sha;

  return {
    id: entry.id,
    nature: entry.nature,
    ref,
    sha,
    scope,
    installedAt: new Date().toISOString(),
    files,
  };
}
