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
import { backup, removeFile, restore } from './backup';
import { findEntry, readManifest, upsertEntry, writeManifest } from './manifest';
import type { Env } from './paths';
import type {
  AppliedPayload,
  Manifest,
  ManifestEntry,
  RemovalOp,
  Report,
  Scope,
  WriteOp,
} from './types';

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
 * When manifestPath is provided, each entry is enriched with its `applied`
 * payload from the manifest before being passed to adapter.audit(). This
 * allows the adapter to verify against the exact canonical payload recorded
 * at install time instead of reading from an external artifacts directory.
 *
 * @param adapter       The adapter to use for auditing.
 * @param entries       Catalog entries to audit.
 * @param scope         Installation scope ('user' | 'project').
 * @param env           Injectable env for HOME resolution.
 * @param manifestPath  Optional: absolute path to state.json. When provided,
 *                      entries are enriched with their manifest `applied` payload.
 */
export async function check(
  adapter: Adapter,
  entries: AdapterEntry[],
  scope: Scope,
  env: Env,
  manifestPath?: string,
): Promise<Report> {
  let manifest: Manifest | undefined;
  if (manifestPath !== undefined) {
    manifest = await readManifest(manifestPath);
  }

  const enriched = entries.map((entry) => enrichWithApplied(entry, manifest));

  // When we have a manifest, entries not found in it are definitively missing.
  // This avoids false-positive "present" from adapters that have no canonical
  // content (denyRef=[]) when no manifest `applied` is available.
  const natureReports = await Promise.all(
    enriched.map((entry): Promise<import('./types').NatureReport> => {
      if (manifest !== undefined && findEntry(manifest, entry.id, scope) === undefined) {
        return Promise.resolve({
          id: entry.id,
          nature: entry.nature,
          state: 'missing' as const,
          detail: 'not installed',
        });
      }
      return adapter.audit(entry, scope, env);
    }),
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
 * Atomicity (option A — scoped to backup-covered writes): if any step throws —
 * adapter.plan, adapter.apply, or the final writeManifest — the engine rolls
 * back every `path`-based file write to its pre-apply state (files restored from
 * their backup, newly-created files deleted) and re-throws the original error.
 * The manifest is persisted only on full success.
 *
 * KNOWN BOUNDARY (NOT rolled back — these are not backed up by the engine):
 *   - link ops (skills/agents): the linker's store copy + symlink target are
 *     created/overwritten in place; a failed run can leave an orphaned symlink
 *     and store dir, and a pre-existing target overwritten by the linker is not
 *     recoverable. (Backlog: extend the ledger or back up the store/target.)
 *   - merge-hooks script deposits (scriptStore): only the settings.json write is
 *     backed up; deposited guard scripts are not.
 *   - plugin-install: delegated to the `claude` CLI — an external side effect
 *     with no backup, intrinsically outside option A.
 *   - state.json itself: writeManifest is not part of the ledger; writeJson is
 *     atomic (tmp + rename, see fs-json) so a failed manifest write leaves the
 *     previous state.json intact, but its content is not restored by rollback.
 * See rollbackApply.
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

  // Rollback ledger (atomicity option A). Keyed by absolute target path; the
  // value is the backup path to restore from, or null when the file did not
  // exist before this run (→ delete on rollback). FIRST write wins per path, so
  // a path touched by several entries always rolls back to its ORIGINAL state,
  // never to an intermediate state produced earlier in the same run.
  const rollbackLedger = new Map<string, string | null>();

  try {
    for (const entry of entries) {
      const ops = await adapter.plan(entry, scope, env);

      // No ops → idempotent no-op; already installed.
      // Leave the manifest untouched for this entry (preserve existing record).
      if (ops.length === 0) {
        continue;
      }

      // Collect target paths from ops for tracking.
      // - Ops with 'path' use op.path (write-json, write-text, merge-deny, ensure-import).
      // - Link ops use op.target (symlink destination).
      // - Ops with neither 'path' nor 'target' (e.g. plugin-install) contribute no path.
      const targets = ops.flatMap((op) => {
        if ('path' in op) return [op.path as string];
        if ('target' in op) return [(op as { target: string }).target];
        return [];
      });

      // Backup every 'path'-based target that currently exists on disk; these are
      // the only writes the rollback ledger can undo. Link ops (store copy +
      // symlink) and plugin-install (external CLI) are NOT backed up — see the
      // KNOWN BOUNDARY note on apply().
      const backupTargets = ops
        .filter((op) => 'path' in op)
        .map((op) => (op as { path: string }).path);
      const bakResults = await Promise.all(backupTargets.map((p) => backup(p)));

      // Record the pre-write state for rollback (first-wins per path).
      // backup() returns the .bak path when the file existed, null when it did not.
      backupTargets.forEach((p, i) => {
        if (!rollbackLedger.has(p)) {
          rollbackLedger.set(p, bakResults[i] ?? null);
        }
      });

      const backedUp = bakResults.filter((b): b is string => b !== null);
      allBackedUp.push(...backedUp);

      // Delegate actual writes to the adapter
      await adapter.apply(ops, env);

      // Track written paths
      allWritten.push(...targets);

      // Capture the applied payload from the ops for manifest reversibility
      const applied = extractApplied(ops, targets);

      // Upsert manifest entry with the files written and the applied payload
      const version = versionFor === undefined ? undefined : versionFor(entry);
      manifest = upsertEntry(manifest, buildManifestEntry(entry, scope, targets, version, applied));
    }

    // Persist the manifest once after all entries have been processed
    await writeManifest(manifestPath, manifest);
  } catch (err) {
    // Atomicity option A: undo every backup-covered write back to the pre-apply
    // state, then re-throw the ORIGINAL error. The manifest is never persisted
    // on this path (writeManifest is the last statement in the try). If the
    // rollback itself partially failed, attach the failures to the error so a
    // resulting inconsistent disk state is observable rather than silent.
    const rollbackFailures = await rollbackApply(rollbackLedger);
    if (rollbackFailures.length > 0 && err instanceof Error) {
      (err as Error & { rollbackFailures?: RollbackFailure[] }).rollbackFailures = rollbackFailures;
    }
    throw err;
  }

  return { written: allWritten, backedUp: allBackedUp, manifest };
}

// ---------------------------------------------------------------------------
// rollbackApply — undo a partial apply() back to its pre-run state (option A)
// ---------------------------------------------------------------------------

/** A single path whose rollback (restore/delete) failed. */
export interface RollbackFailure {
  /** The original path whose restore/delete failed. */
  path: string;
  /** The error thrown by restore()/removeFile() for that path. */
  cause: unknown;
}

/**
 * Restore the on-disk state recorded in the rollback ledger.
 *
 * For each tracked path:
 *   - backup path present → restore the file from its .bak-* copy
 *   - null (file was created during the run) → delete it
 *
 * Best-effort and resilient: every restore/delete runs to completion via
 * Promise.allSettled, so one failing restore never aborts the others and never
 * masks the original error that triggered the rollback (the caller re-throws it).
 * Failures are NOT swallowed silently — they are returned so the caller can
 * surface them on the re-thrown error (a partial rollback leaves disk in an
 * inconsistent state and must be observable). The .bak-* copies are left in
 * place as a recovery artifact, consistent with the success path.
 *
 * @returns The list of paths whose rollback failed (empty when fully clean).
 */
export async function rollbackApply(
  ledger: Map<string, string | null>,
): Promise<RollbackFailure[]> {
  const tracked = [...ledger.entries()];
  const results = await Promise.allSettled(
    tracked.map(([originalPath, backupPath]) =>
      backupPath === null ? removeFile(originalPath) : restore(backupPath, originalPath)
    ),
  );

  const failures: RollbackFailure[] = [];
  results.forEach((result, i) => {
    const tracking = tracked[i];
    if (result.status === 'rejected' && tracking !== undefined) {
      failures.push({ path: tracking[0], cause: result.reason });
    }
  });
  return failures;
}

// ---------------------------------------------------------------------------
// planRemoval
// ---------------------------------------------------------------------------

/**
 * Compute the aggregated removal plan for a set of entries — read-only.
 *
 * Reads the manifest and enriches each entry with its `applied` payload (B-iii)
 * before calling adapter.planRemove(). This is what makes the plan PREVIEW match
 * what remove() will actually do: without enrichment the adapter falls back to an
 * empty canonical (denyRef=[]) and reports "nothing to remove" for an installed
 * entry whose canonical content lives only in the manifest.
 *
 * @param adapter       The adapter to use for planning.
 * @param entries       Catalog entries to plan removal for.
 * @param scope         Installation scope ('user' | 'project').
 * @param env           Injectable env for HOME resolution.
 * @param manifestPath  Absolute path to state.json.
 * @returns             Flattened RemovalOp[] across all entries.
 */
export async function planRemoval(
  adapter: Adapter,
  entries: AdapterEntry[],
  scope: Scope,
  env: Env,
  manifestPath: string,
): Promise<RemovalOp[]> {
  const manifest = await readManifest(manifestPath);

  const opsPerEntry = await Promise.all(
    entries.map((entry) => adapter.planRemove(enrichWithApplied(entry, manifest), scope, env)),
  );

  return opsPerEntry.flat();
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
    const ops = await adapter.planRemove(enrichWithApplied(entry, manifest), scope, env);

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
 * @param applied  Optional structured payload of the mutations applied.
 *                 When provided it enables reversible remove/check (B-iii).
 */
function buildManifestEntry(
  entry: AdapterEntry,
  scope: Scope,
  files: string[],
  version?: { ref: string; sha: string },
  applied?: AppliedPayload,
): ManifestEntry {
  const ref = version === undefined ? 'v0.0.0' : version.ref;
  const sha = version === undefined ? '' : version.sha;

  const base: ManifestEntry = {
    id: entry.id,
    nature: entry.nature,
    ref,
    sha,
    scope,
    installedAt: new Date().toISOString(),
    files,
  };

  if (applied !== undefined) {
    return { ...base, applied };
  }
  return base;
}

// ---------------------------------------------------------------------------
// extractApplied — derive AppliedPayload from resolved WriteOps (B-iii)
// ---------------------------------------------------------------------------

/**
 * Derive the AppliedPayload from the resolved WriteOp list for a single entry.
 *
 * Rules (first matching wins):
 * - merge-deny and/or merge-allow present → AppliedGuardrail
 *   (denyRules = all toAdd from merge-deny ops; allowRules = all toAdd from merge-allow ops)
 * - write-text op present → AppliedContext (block = op.content)
 * - merge-hooks op present → AppliedHook
 * - link op present → AppliedLink (files = targets collected by apply())
 *
 * Returns undefined when no recognisable ops are present.
 */
function extractApplied(ops: WriteOp[], targets: string[]): AppliedPayload | undefined {
  const hasDeny = ops.some((op) => op.kind === 'merge-deny');
  const hasAllow = ops.some((op) => op.kind === 'merge-allow');

  if (hasDeny || hasAllow) {
    const denyRules = ops
      .filter((op) => op.kind === 'merge-deny')
      .flatMap((op) => (op as { kind: 'merge-deny'; toAdd: string[] }).toAdd);
    const allowRules = ops
      .filter((op) => op.kind === 'merge-allow')
      .flatMap((op) => (op as { kind: 'merge-allow'; toAdd: string[] }).toAdd);
    return { kind: 'guardrail', denyRules, allowRules };
  }

  const writeTextOp = ops.find((op) => op.kind === 'write-text') as
    | { kind: 'write-text'; path: string; content: string; description: string }
    | undefined;
  if (writeTextOp !== undefined) {
    return { kind: 'context', block: writeTextOp.content };
  }

  const hookOp = ops.find((op) => op.kind === 'merge-hooks') as
    | {
      kind: 'merge-hooks';
      path: string;
      event: string;
      matcher: string;
      command: string;
      timeout?: number;
    }
    | undefined;
  if (hookOp !== undefined) {
    const base = {
      kind: 'hook' as const,
      event: hookOp.event,
      matcher: hookOp.matcher,
      command: hookOp.command,
    };
    if (hookOp.timeout !== undefined) {
      return { ...base, timeout: hookOp.timeout };
    }
    return base;
  }

  const hasLink = ops.some((op) => op.kind === 'link');
  if (hasLink) {
    return { kind: 'link', files: targets };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// enrichWithApplied — inject manifest `applied` into an AdapterEntry (B-iii)
// ---------------------------------------------------------------------------

/**
 * Return a new AdapterEntry enriched with the `applied` payload from the manifest.
 *
 * If the manifest is absent or the entry is not found, the original entry is
 * returned unchanged (legacy behaviour — no applied payload).
 */
function enrichWithApplied(entry: AdapterEntry, manifest: Manifest | undefined): AdapterEntry {
  if (manifest === undefined) {
    return entry;
  }
  const manifestEntry = findEntry(manifest, entry.id, entry.scope);
  if (manifestEntry === undefined || manifestEntry.applied === undefined) {
    return entry;
  }
  return { ...entry, applied: manifestEntry.applied };
}
