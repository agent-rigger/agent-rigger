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

import { lstat } from 'node:fs/promises';
import path from 'node:path';

import type { Adapter, AdapterEntry } from './adapter';
import { mergeApplied, mergeFiles } from './applied-merge';
import { backup, backupDir, removeDir, removeFile, restore } from './backup';
import { findEntry, readManifest, upsertEntry, writeManifest } from './manifest';
import { mergePermission } from './opencode-json';
import type { Env } from './paths';
import type {
  AppliedPayload,
  Assistant,
  Manifest,
  ManifestEntry,
  Nature,
  OpencodeMcpServer,
  OpencodePermission,
  RemovalOp,
  RemovalOpUnlink,
  Report,
  Scope,
  WriteOp,
} from './types';

// ---------------------------------------------------------------------------
// SharedNatureStore
// ---------------------------------------------------------------------------

/**
 * Descriptor of an on-disk directory shared by every artifact of one nature
 * (R7, lot2-remove-reversible). The canonical case is the claude hook
 * scriptStore: guard scripts are COPIES deposited in a single user-level
 * directory, so no symlink refcount can tell when the store becomes garbage —
 * the manifest is the only reliable counter.
 *
 * remove() deletes the directory (after a backupDir) when the run removes the
 * LAST manifest entry of `nature`, all scopes and assistants confounded. Core
 * stays assistant-agnostic: it knows neither which natures share a store nor
 * where that store lives — the caller (the CLI remove command) declares both.
 */
export interface SharedNatureStore {
  /** Manifest nature whose artifacts share the directory (e.g. 'hook'). */
  nature: Nature;
  /** Absolute path of the shared store directory on disk. */
  dir: string;
}

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

  const enriched = entries.map((entry) => enrichWithApplied(entry, manifest, adapter.id));

  // When we have a manifest, entries not found in it are definitively missing.
  // This avoids false-positive "present" from adapters that have no canonical
  // content (denyRef=[]) when no manifest `applied` is available.
  const natureReports = await Promise.all(
    enriched.map((entry): Promise<import('./types').NatureReport> => {
      if (
        manifest !== undefined && findEntry(manifest, entry.id, scope, adapter.id) === undefined
      ) {
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
 * Atomicity — if any step throws (adapter.plan, adapter.apply, or the final
 * writeManifest) the engine rolls back to the pre-apply state and re-throws the
 * original error. The manifest is persisted only on full success. Three layers:
 *   A. path-based file writes (write-text/json, merge-deny/allow, ensure-import,
 *      settings.json) → restored from backup / deleted if newly created.
 *   B. non-path side effects of FRESH installs (skill/agent symlink+store via
 *      link ops; plugin via plugin-install) → compensated by replaying their
 *      inverse RemovalOps through adapter.applyRemove, in reverse order.
 *   C. shared dirs created this run (hook scriptStore) → removed.
 *
 * KNOWN BOUNDARY (Tier 1 — orphan-safe, NOT data-safe):
 *   - Re-install / update of an ALREADY-tracked entry is NOT rolled back: the
 *     overwritten previous content is not restored (only fresh installs are
 *     compensated). The affected dirs are managed (skills/<name>, scriptStore),
 *     recreatable by re-running install.
 *   - plugin-install: the compensating `claude plugin uninstall` is best-effort
 *     and does NOT undo the `marketplace add`; a failure is surfaced via
 *     err.rollbackFailures, not thrown.
 *   - state.json: writeJson is atomic (tmp+rename), so a failed manifest write
 *     leaves the previous state.json intact (its content is not restored here).
 * See rollbackApply / rollbackCreatedDirs / rollbackCompensations.
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

  // Snapshot the ids tracked BEFORE this run. Drives compensation eligibility
  // (fresh install vs re-install) independently of the manifest being mutated
  // by upsertEntry during the loop — robust even if an id appears twice.
  const preExistingIds = new Set(
    manifest.artifacts.filter((a) => a.scope === scope).map((a) => a.id),
  );

  const allWritten: string[] = [];
  const allBackedUp: string[] = [];

  // Rollback ledger (atomicity option A). Keyed by absolute target path; the
  // value is the backup path to restore from, or null when the file did not
  // exist before this run (→ delete on rollback). FIRST write wins per path, so
  // a path touched by several entries always rolls back to its ORIGINAL state,
  // never to an intermediate state produced earlier in the same run.
  const rollbackLedger = new Map<string, string | null>();

  // Compensations for non-path side effects (atomicity option B, Tier 1
  // orphan-safe). Only entries ABSENT from the pre-apply manifest are recorded:
  // a fresh install is fully undone, while a re-install/update of an already
  // tracked entry is left in place (Tier 1 does not restore overwritten content).
  // Replayed in REVERSE order on rollback via adapter.applyRemove.
  const compensations: RemovalOp[] = [];
  // Shared directories (the hook scriptStore) that did NOT exist before this run
  // and must be removed on rollback. First-wins: a dir already present when first
  // touched is left untouched — other already-installed entries may depend on it.
  const createdDirs = new Set<string>();
  const seenDirs = new Set<string>();

  try {
    for (const entry of entries) {
      // Enrich the entry with its pre-existing manifest `applied` payload
      // before planning (R1/D8). Additive: handlers that ignore `applied` are
      // unchanged. The claude hook handler compares the canonical spec against
      // it to plan a traced migration (remove-hooks(old) + merge-hooks(new))
      // when the spec changed. Reads the loop-mutated manifest, so an id
      // repeated within a run sees the payload of its previous occurrence.
      const plannedOps = await adapter.plan(
        enrichWithApplied(entry, manifest, adapter.id),
        scope,
        env,
      );

      // Drop warning-only ops before applying: a merge-permission op with an
      // EMPTY fragment applies nothing — the opencode guardrail plan emits it
      // solely to carry conflict warnings into the plan preview (review M7,
      // R10.4). Applying it would upsert a phantom manifest entry whose empty
      // `applied` payload makes `check` vacuously 'present' (hasPermission(_, {})
      // is true) and `remove` a permanent silent no-op, so such ops are treated
      // exactly like an empty plan instead: no write, no backup, no manifest entry.
      const ops = plannedOps.filter(
        (op) => !(op.kind === 'merge-permission' && Object.keys(op.permission).length === 0),
      );

      // No (effective) ops → idempotent no-op; already installed or warning-only.
      // Leave the manifest untouched for this entry (preserve existing record).
      if (ops.length === 0) {
        continue;
      }

      // Fresh install (entry not tracked before this run) vs re-install of a
      // tracked entry. Drives whether non-path side effects are compensated on
      // rollback. Uses the pre-run snapshot, not the loop-mutated manifest.
      const isFreshInstall = !preExistingIds.has(entry.id);

      // Collect target paths from ops for tracking.
      // - Ops with 'path' use op.path (write-json, write-text, merge-deny, ensure-import).
      // - Link ops use op.target (symlink destination).
      // - Ops with neither 'path' nor 'target' (e.g. plugin-install) contribute no path.
      const targets = ops.flatMap((op) => {
        if ('path' in op) return [op.path as string];
        if ('target' in op) return [(op as { target: string }).target];
        return [];
      });

      // Backup every 'path'-based target that currently exists on disk — but
      // only ONCE per path per run. A file touched by several ops within this
      // entry, or by several entries (e.g. settings.json hit by guardrails
      // deny+allow and again by every hook merge), must produce a SINGLE .bak,
      // not one backup per op. The rollback ledger is the dedup key: a path it
      // already records was backed up earlier this run, so skip it here. Link
      // ops (store copy + symlink) and plugin-install (external CLI) are NOT
      // backed up — see the KNOWN BOUNDARY note on apply().
      const backupTargets = ops
        .filter((op) => 'path' in op)
        .map((op) => (op as { path: string }).path)
        .filter((p, i, arr) => arr.indexOf(p) === i && !rollbackLedger.has(p));
      const bakResults = await Promise.all(backupTargets.map((p) => backup(p)));

      // Record the pre-write state for rollback. Every target here is new to the
      // ledger (filtered above), so this is the first-wins entry for each path —
      // rollback always restores the ORIGINAL pre-run state, never an
      // intermediate one. backup() returns the .bak path when the file existed,
      // null when it did not.
      backupTargets.forEach((p, i) => {
        rollbackLedger.set(p, bakResults[i] ?? null);
      });

      const backedUp = bakResults.filter((b): b is string => b !== null);
      allBackedUp.push(...backedUp);

      // Track shared directories created by this run (hook scriptStore) so a
      // rollback can remove them. Checked BEFORE apply, first-wins per dir: a
      // store already present is NOT tracked (other installed hooks share it).
      for (const op of ops) {
        if (
          op.kind === 'merge-hooks' && op.scriptStore !== undefined && !seenDirs.has(op.scriptStore)
        ) {
          seenDirs.add(op.scriptStore);
          if (!(await pathExists(op.scriptStore))) {
            createdDirs.add(op.scriptStore);
          }
        }
      }

      // Delegate actual writes to the adapter
      await adapter.apply(ops, env);

      // Track written paths
      allWritten.push(...targets);

      // Record compensations for the non-path side effects of a FRESH install,
      // so a later failure can undo them (skill/agent symlink+store, plugin).
      if (isFreshInstall) {
        for (const op of ops) {
          if (op.kind === 'link') {
            compensations.push({ kind: 'unlink', target: op.target, store: op.store });
          } else if (op.kind === 'plugin-install') {
            compensations.push({ kind: 'plugin-uninstall', plugin: op.plugin });
          }
        }
      }

      // Capture the applied payload from the ops for manifest reversibility.
      // R1: a re-install (drift repair, catalog update) plans only the DELTA,
      // so the payload of this run is merged with the pre-existing `applied`
      // of the same (id, scope, assistant) identity BEFORE the upsert — the
      // manifest keeps the CUMULATIVE trace of everything rigger has applied,
      // which is what remove/check reverse against. ManifestEntry.files gets
      // the same dedup union. findEntry reads the loop-mutated manifest, so an
      // id repeated within a single run cumulates too. upsertEntry itself
      // stays a kind-agnostic replacement (per-kind semantics: applied-merge.ts).
      const previous = findEntry(manifest, entry.id, scope, adapter.id);
      const extracted = extractApplied(ops, targets);
      // R6: an entry that EXISTS without an `applied` payload (pre-B-iii
      // manifest) is a RE-install, not a first install — but mergeApplied only
      // sees `previous?.applied`, which collapses both cases into undefined and
      // would adopt the run payload wholesale, including a context `previous`
      // captured from the POST-install disk (the canonical block itself on a
      // repair). That capture must never become the restore baseline: strip it
      // and carry the absence forward, exactly like mergeApplied's
      // applied-without-previous legacy branch — remove then degrades to
      // delete-on-exact-match with the "no restore baseline" notice.
      const next = previous !== undefined
          && previous.applied === undefined
          && extracted?.kind === 'context'
          && extracted.previous !== undefined
        ? { kind: 'context' as const, block: extracted.block }
        : extracted;
      const applied = mergeApplied(previous?.applied, next);
      const files = previous === undefined ? targets : mergeFiles(previous.files, targets);

      // Upsert manifest entry with the files written and the applied payload.
      // Stamp the target assistant (adapter.id) so the manifest identity is
      // (id, scope, assistant) — a claude and an opencode install of the same id
      // coexist instead of clobbering each other.
      const version = versionFor === undefined ? undefined : versionFor(entry);
      manifest = upsertEntry(
        manifest,
        buildManifestEntry(entry, scope, files, adapter.id, version, applied),
      );
    }

    // Persist the manifest once after all entries have been processed
    await writeManifest(manifestPath, manifest);
  } catch (err) {
    // Roll back to the pre-apply state, then re-throw the ORIGINAL error. The
    // manifest is never persisted on this path (writeManifest is the last
    // statement in the try). Three layers, all best-effort and resilient:
    //   1. path-based file writes (option A) → restore .bak / delete
    //   2. shared dirs created this run (hook scriptStore) → remove
    //   3. non-path side effects of fresh installs (link, plugin) → compensate
    //      via adapter.applyRemove, replayed in REVERSE order
    // Any failure is aggregated onto err.rollbackFailures so a resulting
    // inconsistent disk state is observable rather than silent.
    const fileFailures = await rollbackApply(rollbackLedger);
    const dirFailures = await rollbackCreatedDirs(createdDirs);
    const compFailures = await rollbackCompensations(adapter, compensations, env);
    const rollbackFailures = [...fileFailures, ...dirFailures, ...compFailures];
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

/** True if `p` exists on disk (file, dir, or symlink); false otherwise. */
async function pathExists(p: string): Promise<boolean> {
  return lstat(p).then(() => true).catch(() => false);
}

/**
 * Remove the shared directories created during a failed run (atomicity option B,
 * Tier 1). Best-effort via Promise.allSettled; failures are returned, not thrown.
 */
async function rollbackCreatedDirs(dirs: Set<string>): Promise<RollbackFailure[]> {
  const tracked = [...dirs];
  const results = await Promise.allSettled(tracked.map((d) => removeDir(d)));

  const failures: RollbackFailure[] = [];
  results.forEach((result, i) => {
    const dir = tracked[i];
    if (result.status === 'rejected' && dir !== undefined) {
      failures.push({ path: dir, cause: result.reason });
    }
  });
  return failures;
}

/**
 * Undo the non-path side effects of fresh installs by replaying their inverse
 * RemovalOps (unlink, plugin-uninstall) through adapter.applyRemove, in REVERSE
 * order (later side effects undone first). Each op runs in isolation via
 * Promise.allSettled so one failure (e.g. an external `claude plugin uninstall`)
 * neither aborts the others nor masks the original error. Failures are returned.
 */
async function rollbackCompensations(
  adapter: Adapter,
  compensations: RemovalOp[],
  env: Env,
): Promise<RollbackFailure[]> {
  const reversed = compensations.toReversed();
  const results = await Promise.allSettled(reversed.map((op) => adapter.applyRemove([op], env)));

  const failures: RollbackFailure[] = [];
  results.forEach((result, i) => {
    const op = reversed[i];
    if (result.status === 'rejected' && op !== undefined) {
      const id = op.kind === 'unlink'
        ? op.target
        : op.kind === 'plugin-uninstall'
        ? `plugin:${op.plugin}`
        : op.kind;
      failures.push({ path: id, cause: result.reason });
    }
  });
  return failures;
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

/**
 * Remove all entries: planRemove → backup → applyRemove → manifest update.
 *
 * For each entry:
 *   1. Call adapter.planRemove() to get the set of RemovalOps, then drop
 *      warning-only leave-alone ops (R3 gate: an unmanaged target is never
 *      deleted — the op only carries warnings into the preview).
 *   2. If the effective plan is empty → no-op (idempotent; not installed,
 *      already removed, or unmanaged target left alone — entry preserved).
 *   3. Otherwise: backup every op target that carries a `path` field and
 *      exists on disk — parity with apply() (R8). Every RemovalOp kind except
 *      `unlink` (delegates to the primitive) and `plugin-uninstall` (no file)
 *      carries `path`, so this is "any op targeting a config file", not a
 *      per-kind whitelist. A path already backed up earlier THIS RUN (another
 *      op, another entry) is skipped — one .bak per file per run, same dedup
 *      key as apply() (engine.ts apply(), backupTargets/rollbackLedger).
 *      Additionally, the store of every unlink op is backed up as a whole
 *      (backupDir → <store>.bak-<ISO>-<token>) before the removal (R3).
 *   4. Call adapter.applyRemove(ops, env, manifestFiles) to perform the
 *      removals. `manifestFiles` (R4) is every path the manifest still claims
 *      after this removal: the `files` of every remaining entry PLUS the
 *      removed entry's own files that this run's ops do not touch (mergeFiles
 *      can fold several install targets into one entry) — opaque paths the
 *      adapter uses as extra store reference candidates (a project-scope
 *      symlink installed from another cwd is only discoverable through the
 *      manifest, ADR-0020 §3). Core does not interpret them.
 *   5. Remove the entry from the manifest (filter by id + scope).
 * After all entries: persist the updated manifest, then delete every shared
 * nature store whose LAST manifest entry left in this run (R7) — backed up
 * as a whole first (backupDir).
 *
 * Idempotent: if the effective plan is [] (artifact not installed) → no-op,
 * manifest unchanged.
 *
 * @param adapter       The adapter to use for planning and removing.
 * @param entries       Catalog entries to remove.
 * @param scope         Installation scope ('user' | 'project').
 * @param env           Injectable env for HOME resolution.
 * @param manifestPath  Absolute path to state.json.
 * @param sharedStores  Optional shared-store descriptors (R7): directories
 *                      shared by every artifact of one nature, deleted with
 *                      the last manifest entry of that nature.
 */
export async function remove(
  adapter: Adapter,
  entries: AdapterEntry[],
  scope: Scope,
  env: Env,
  manifestPath: string,
  sharedStores?: SharedNatureStore[],
): Promise<RemoveResult> {
  let manifest = await readManifest(manifestPath);

  const allRemoved: string[] = [];
  const allBackedUp: string[] = [];

  // Paths already backed up this run — persists across entries so a file hit
  // by several entries' remove ops (e.g. settings.json hit by both a hook
  // removal and a guardrail removal) is backed up exactly once, capturing the
  // ORIGINAL pre-run state (R8).
  const backedUpPaths = new Set<string>();

  // Natures of the entries actually removed this run — gates the shared-store
  // cleanup below (R7).
  const removedNatures = new Set<Nature>();

  for (const entry of entries) {
    const plannedOps = await adapter.planRemove(
      enrichWithApplied(entry, manifest, adapter.id),
      scope,
      env,
    );

    // Drop warning-only ops before the empty-plan check — mirror of apply()'s
    // warning-only merge-permission filter (review M7). A leave-alone op
    // performs no removal: it only carries the R3 gate warnings ("present but
    // not managed") into the plan preview. An entry whose plan contains ONLY
    // leave-alone ops is treated exactly like an empty plan: no write, no
    // backup, and the manifest entry is PRESERVED so `check` keeps reporting
    // the divergence.
    const ops = plannedOps.filter((op) => op.kind !== 'leave-alone');

    // No (effective) ops → not installed; leave the manifest untouched for
    // this entry.
    if (ops.length === 0) {
      continue;
    }

    // Backup every op target that carries a `path` — parity with apply()
    // (R8). Ops with `target` (unlink) delegate removal to the primitive;
    // `plugin-uninstall` has neither path nor target — nothing to back up.
    const backupTargets = ops
      .filter((op) => 'path' in op)
      .map((op) => (op as { path: string }).path)
      .filter((p, i, arr) => arr.indexOf(p) === i && !backedUpPaths.has(p));

    const bakResults = await Promise.all(backupTargets.map((p) => backup(p)));
    backupTargets.forEach((p) => backedUpPaths.add(p));
    const backedUp = bakResults.filter((b): b is string => b !== null);
    allBackedUp.push(...backedUp);

    // Backup the store of every unlink op before the primitive rm's it (R3,
    // gate ratified 2026-07-10): edits made through the install symlink live
    // in the store, so the whole store tree (or single-file agent store) is
    // preserved as <store>.bak-<ISO>-<token>. Same dedup-per-run and same
    // backedUp reporting channel as the config-file backups above.
    const storeBackupTargets = ops
      .filter((op): op is RemovalOpUnlink => op.kind === 'unlink')
      .map((op) => op.store)
      .filter((p, i, arr) => arr.indexOf(p) === i && !backedUpPaths.has(p));

    const storeBakResults = await Promise.all(storeBackupTargets.map((p) => backupDir(p)));
    storeBackupTargets.forEach((p) => backedUpPaths.add(p));
    allBackedUp.push(...storeBakResults.filter((b): b is string => b !== null));

    // R4: hand the adapter every path the manifest will STILL claim after this
    // removal — the files of every other entry, PLUS the files of the removed
    // entry that this run's ops do NOT touch. mergeFiles (R1) can fold several
    // install targets into ONE entry (e.g. the same project-scope skill
    // installed from two different cwds), so enumerating only the remaining
    // entries would hide a sibling target that still references the shared
    // store: the store would be deleted under a live symlink while the
    // confirmed preview (cmd-remove) showed "kept — still referenced".
    // Subtracting exactly the op paths/targets keeps apply aligned with that
    // preview, and keeps the context shared-file gate intact (a path it must
    // protect belongs to a REMAINING entry, never to the removed one's ops).
    // Core stays assistant-agnostic — it only transports paths.
    const nextManifest = removeEntry(manifest, entry.id, scope, adapter.id);
    const removedEntry = findEntry(manifest, entry.id, scope, adapter.id);
    const touchedPaths = new Set(
      ops.flatMap((op) => {
        if ('path' in op) return [path.resolve((op as { path: string }).path)];
        if ('target' in op) return [path.resolve((op as { target: string }).target)];
        return [];
      }),
    );
    const survivingOwnFiles = (removedEntry?.files ?? []).filter(
      (f) => !touchedPaths.has(path.resolve(f)),
    );
    const remainingFiles = [
      ...nextManifest.artifacts.flatMap((a) => a.files),
      ...survivingOwnFiles,
    ];

    // Delegate actual removals to the adapter
    await adapter.applyRemove(ops, env, remainingFiles);

    // Remove this entry from the manifest (keyed by assistant so we only drop
    // the record for the assistant being operated on).
    manifest = nextManifest;
    allRemoved.push(entry.id);
    removedNatures.add(entry.nature);
  }

  // Persist the manifest once after all entries have been processed
  await writeManifest(manifestPath, manifest);

  // R7: a shared nature store leaves the disk with the LAST manifest entry of
  // its nature — all scopes and assistants confounded (the manifest is one
  // user-level file, so `manifest.artifacts` covers them all). Two gates:
  //   1. this run actually removed an entry of that nature — a run that never
  //      touched the nature must not delete scripts that a legacy (truncated)
  //      manifest fails to track but that are still live in the assistant
  //      config;
  //   2. no entry of that nature remains at the manifest.
  // Runs AFTER writeManifest so the cleanup acts on the persisted truth: a
  // cleanup failure never leaves the manifest claiming entries whose config
  // mutations were already reverted. The whole directory is preserved first
  // (backupDir, <dir>.bak-<ISO>-<token>) on the same reporting channel as the
  // per-store backups (R3).
  for (const store of sharedStores ?? []) {
    const natureRemains = manifest.artifacts.some((a) => a.nature === store.nature);
    if (!removedNatures.has(store.nature) || natureRemains) {
      continue;
    }
    const dirBak = await backupDir(store.dir);
    if (dirBak !== null) {
      allBackedUp.push(dirBak);
    }
    await removeDir(store.dir);
  }

  return { removed: allRemoved, backedUp: allBackedUp, manifest };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Return a new Manifest with the entry matching both `id` and `scope` removed.
 * Pure / immutable: the input manifest is not mutated.
 */
function removeEntry(
  manifest: Manifest,
  id: string,
  scope: Scope,
  assistant: Assistant = 'claude',
): Manifest {
  return {
    ...manifest,
    artifacts: manifest.artifacts.filter(
      (e) => !(e.id === id && e.scope === scope && (e.assistant ?? 'claude') === assistant),
    ),
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
  assistant: Assistant,
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
    assistant,
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

  // opencode guardrail: one or more merge-permission ops → AppliedOpencodePermission.
  // Fold every fragment into a single permission object for exact reversal.
  const hasPermission = ops.some((op) => op.kind === 'merge-permission');
  if (hasPermission) {
    const permission = ops
      .filter((op) => op.kind === 'merge-permission')
      .reduce(
        (acc, op) =>
          mergePermission(
            acc,
            (op as { kind: 'merge-permission'; permission: OpencodePermission }).permission,
          ),
        {} as OpencodePermission,
      );
    return { kind: 'opencode-permission', permission };
  }

  // opencode mcp: a merge-mcp op → AppliedOpencodeMcp.
  const mcpOp = ops.find((op) => op.kind === 'merge-mcp') as
    | {
      kind: 'merge-mcp';
      path: string;
      server: string;
      config: OpencodeMcpServer;
      description: string;
    }
    | undefined;
  if (mcpOp !== undefined) {
    return { kind: 'opencode-mcp', server: mcpOp.server, config: mcpOp.config };
  }

  const writeTextOp = ops.find((op) => op.kind === 'write-text') as
    | {
      kind: 'write-text';
      path: string;
      content: string;
      description: string;
      previous?: string | null;
    }
    | undefined;
  if (writeTextOp !== undefined) {
    // R6: the restore baseline captured at plan time rides on the op and is
    // persisted as AppliedContext.previous. Left absent when the writer did
    // not capture one (legacy plans, opencode agent write-text) so remove can
    // tell "no baseline" apart from "file was absent" (null).
    if (writeTextOp.previous !== undefined) {
      return { kind: 'context', block: writeTextOp.content, previous: writeTextOp.previous };
    }
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
export function enrichWithApplied(
  entry: AdapterEntry,
  manifest: Manifest | undefined,
  assistant: Assistant = 'claude',
): AdapterEntry {
  if (manifest === undefined) {
    return entry;
  }
  const manifestEntry = findEntry(manifest, entry.id, entry.scope, assistant);
  if (manifestEntry === undefined || manifestEntry.applied === undefined) {
    return entry;
  }
  return { ...entry, applied: manifestEntry.applied };
}
