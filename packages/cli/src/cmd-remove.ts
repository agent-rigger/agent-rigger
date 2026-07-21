/**
 * cmd-remove — implementation of the `remove` command.
 *
 * Responsibilities:
 * - Validate requested ids against the manifest (R5: manifest-first, offline —
 *   the catalog plays no role on the remove path).
 * - Build the removal plan (RemovalOp[]) via adapter.planRemove() for each entry.
 * - Render the plan and confirm with the user (injectable for tests).
 * - If confirmed and plan is non-empty: apply (backup → remove → manifest).
 * - Return a typed RemoveCommandResult (applied, removed, backedUp, output).
 *
 * Constraints:
 * - No process.exit — the CLI bin decides what to do after cancellation.
 * - No while loops — for...of / map / Promise.all only.
 * - No import of process directly — all paths are injectable.
 * - Human-in-the-loop: nothing is removed without confirmation.
 * - Zero network: validation, planning and execution read the manifest and the
 *   disk only (ADR-0016, realized by lot2-remove-reversible R5).
 */

import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { isStoreReferenced, storeReferenceCandidates } from '@agent-rigger/adapters';
import { localId } from '@agent-rigger/catalog';
import type { Adapter, AdapterEntry } from '@agent-rigger/core/adapter';
import type { SharedNatureStore } from '@agent-rigger/core/engine';
import { enrichWithApplied, remove } from '@agent-rigger/core/engine';
import { findEntry, findLibEntry, readManifest, requiresIndex } from '@agent-rigger/core/manifest';
import type { Env } from '@agent-rigger/core/paths';
import { resolveHome } from '@agent-rigger/core/paths';
import type { Manifest, ManifestEntry, RemovalOpUnlink, Scope } from '@agent-rigger/core/types';

import { hookScriptStorePath } from './adapter-builder';
import { abbreviatePath, renderRemovalPlan } from './ui';
import type { PlanRemovalGroup } from './ui';

/** True if `p` exists on disk (file, dir, or symlink); false otherwise. */
const pathExists = (p: string): Promise<boolean> => lstat(p).then(() => true).catch(() => false);

// ---------------------------------------------------------------------------
// RemoveCommandResult
// ---------------------------------------------------------------------------

/**
 * Result returned by runRemove.
 *
 * - applied   true when removals were performed (plan non-empty + confirmed).
 * - removed   Ids of entries that were removed.
 * - backedUp  Absolute paths of .bak-* files created before removals.
 * - output    Human-readable summary ready to print.
 */
export interface RemoveCommandResult {
  applied: boolean;
  removed: string[];
  backedUp: string[];
  output: string;
}

// ---------------------------------------------------------------------------
// RunRemoveOptions
// ---------------------------------------------------------------------------

/**
 * Options for runRemove — all injectable for test isolation.
 */
export interface RunRemoveOptions {
  /** Adapter used for planRemove() and applyRemove(). */
  adapter: Adapter;
  /** Removal scope. */
  scope: Scope;
  /** Injectable env for HOME resolution. */
  env: Env;
  /** Absolute path to state.json (the manifest file). */
  manifestPath: string;
  /** Artifact ids to remove. */
  selectedIds: string[];
  /**
   * Confirmation source.
   *  - boolean true  → always remove without prompting.
   *  - boolean false → always abort without prompting.
   *  - async callback → called with the rendered plan text; returns true/false.
   */
  confirm: boolean | ((planText: string) => Promise<boolean>);
  /** Working directory (used for path abbreviation in plan output). */
  cwd?: string;
  /**
   * Compact output mode (plan-compact-summary D3/D4, T2). Threaded to
   * renderRemovalPlan (one recap line per artefact) and to buildOutput (the
   * Result section drops the per-item `- id` list of removed/purged entries but
   * keeps the aggregated status lines and the per-file backup lines). Absent/
   * false → the full output, byte-identical to before. The `[warning]` lines
   * stay integral in both modes.
   */
  summary?: boolean;
  /**
   * R6 --force: bypass the refcount gate (remove an entry still required by a
   * remaining one) with a loud per-dependent warning instead of a refusal.
   * Absent/false → the gate fails closed (exit 2). Same "noisy, never silent"
   * semantics as the scan `--force`.
   */
  force?: boolean;
}

// ---------------------------------------------------------------------------
// NotInstalledError
// ---------------------------------------------------------------------------

/** True when the id's local part (after the catalog qualifier) is a pack id. */
function isPackId(id: string): boolean {
  return localId(id).startsWith('pack:');
}

function buildNotInstalledMessage(id: string, installedIds: string[]): string {
  const installed = installedIds.length > 0
    ? `Installed entries: ${installedIds.join(', ')}.`
    : 'Nothing is installed.';

  if (isPackId(id)) {
    return (
      `Pack "${id}" is not installed — packs are expanded at install time; `
      + `remove their member artifacts instead. ${installed}`
    );
  }

  return `Artifact "${id}" is not installed. ${installed}`;
}

/**
 * Thrown when a requested id has no manifest entry for the target
 * (id, scope, assistant) identity — R5: the manifest is the sole source of
 * truth for remove; the message lists what IS installed so the user can pick
 * the right id without any catalog fetch.
 */
export class NotInstalledError extends Error {
  constructor(public readonly id: string, installedIds: string[]) {
    super(buildNotInstalledMessage(id, installedIds));
    this.name = 'NotInstalledError';
  }
}

// ---------------------------------------------------------------------------
// RequiredByError — R6 refcount gate
// ---------------------------------------------------------------------------

/**
 * One blocked removal: the qualified id the run would remove and the qualified
 * ids of the remaining manifest entries that still `require` it.
 */
export interface RemoveBlock {
  id: string;
  dependents: string[];
}

function buildRequiredByMessage(blocks: RemoveBlock[]): string {
  const lines = blocks.map(
    (b) => `  - "${b.id}" is still required by ${b.dependents.map((d) => `"${d}"`).join(', ')}`,
  );
  return (
    'Cannot remove — still required by installed artifacts:\n'
    + lines.join('\n')
    + '\nRemove the dependents in the same run, or pass --force to remove anyway '
    + '(their imports/dependencies will break).'
  );
}

/**
 * Thrown BEFORE any confirm or write when a remove run would drop an entry a
 * remaining manifest entry still `requires` (R6 — a GENERIC refcount over the
 * persisted requires graph, every nature, not lib-only). Manifest-first and
 * offline (R5 of the stock): the graph is read from state.json, no catalog fetch.
 * The CLI maps it to exit code 2 (validation). `--force` bypasses the throw with
 * a loud per-dependent warning instead.
 */
export class RequiredByError extends Error {
  constructor(public readonly blocks: RemoveBlock[]) {
    super(buildRequiredByMessage(blocks));
    this.name = 'RequiredByError';
  }
}

// ---------------------------------------------------------------------------
// Refcount graph helpers (R6 gate + R7.1 GC)
// ---------------------------------------------------------------------------

/** Manifest identity key — the (id, scope, assistant) triple upsert/remove use. */
function manifestEntryKey(entry: ManifestEntry): string {
  return `${entry.id}\u0000${entry.scope}\u0000${entry.assistant ?? 'claude'}`;
}

/**
 * R6 gate — evaluate the requires graph at RUN level (S5): after the WHOLE run is
 * hypothetically removed, does any REMAINING entry still require one of the
 * removed ids? The refcount is GLOBAL (S2) — an id kept by another scope/assistant
 * copy still satisfies the edge, so only an id with NO remaining entry counts as a
 * block. A `requires` ref this run did not remove is ignored: a pre-existing
 * broken edge is doctor's job (R7), not a break this removal caused.
 */
function computeRefcountBlocks(manifest: Manifest, removedEntries: ManifestEntry[]): RemoveBlock[] {
  const removedKeys = new Set(removedEntries.map(manifestEntryKey));
  const remaining = manifest.artifacts.filter((e) => !removedKeys.has(manifestEntryKey(e)));
  const removedIds = new Set(removedEntries.map((e) => e.id));
  const remainingIds = new Set(remaining.map((e) => e.id));

  // Who among the SURVIVING entries still requires a removed-and-now-gone id.
  const index = requiresIndex(remaining);
  const blocks: RemoveBlock[] = [];
  for (const [req, requirers] of index) {
    if (removedIds.has(req) && !remainingIds.has(req)) {
      blocks.push({ id: req, dependents: [...requirers].sort() });
    }
  }
  return blocks.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * R7.1/S9 GC — libs whose LAST dependent leaves in this run. A lib qualifies when
 * a removed entry required it (it WAS a dependent) AND no remaining entry still
 * requires it. A lib already orphaned before the run (no removed dependent) is NOT
 * collected — that is a doctor finding (R7.2), not a same-run proposal.
 */
function computeGcLibs(manifest: Manifest, removedEntries: ManifestEntry[]): ManifestEntry[] {
  const removedKeys = new Set(removedEntries.map(manifestEntryKey));
  const remaining = manifest.artifacts.filter((e) => !removedKeys.has(manifestEntryKey(e)));
  const removedReqIds = new Set(removedEntries.flatMap((e) => e.requires ?? []));
  const stillRequired = requiresIndex(remaining);

  return remaining.filter(
    (lib) =>
      lib.nature === 'lib'
      && removedReqIds.has(lib.id)
      && !stillRequired.has(lib.id),
  );
}

// ---------------------------------------------------------------------------
// Lib removal preview (display-only — the engine computes the real removal)
// ---------------------------------------------------------------------------

interface LibRemovalPreview {
  id: string;
  dirs: string[];
  present: boolean;
  orphaned: boolean;
}

async function buildLibPreviews(
  libEntries: ManifestEntry[],
  gcIds: Set<string>,
): Promise<LibRemovalPreview[]> {
  return Promise.all(
    libEntries.map(async (e) => {
      const present = (await Promise.all(e.files.map((f) => pathExists(f)))).some((p) => p);
      return { id: e.id, dirs: e.files, present, orphaned: gcIds.has(e.id) };
    }),
  );
}

function renderLibRemovalBlock(
  previews: LibRemovalPreview[],
  home: string,
  cwd: string,
): string {
  if (previews.length === 0) return '';
  const lines = previews.map((p) => {
    const dir = p.dirs.map((d) => abbreviatePath(d, { home, cwd })).join(', ');
    const action = p.present ? `delete  ${dir}` : 'purge (already absent)';
    const orphanTag = p.orphaned ? '  (orphaned — no remaining dependents)' : '';
    return `  - ${p.id}   ${action}${orphanTag}`;
  });
  return '\n\n--- Libraries ---\n' + lines.join('\n');
}

// ---------------------------------------------------------------------------
// runRemove
// ---------------------------------------------------------------------------

/**
 * Execute the remove command end-to-end and return a typed RemoveCommandResult.
 *
 * Step 1 — Validation (R5, manifest-first): each id must have a manifest entry
 *   for the (id, scope, assistant) identity triple. Ids the manifest does not
 *   know throw NotInstalledError immediately — no catalog, no network.
 *
 * Step 2 — Build AdapterEntries: { id, nature, scope } from the manifest entry
 *   (ManifestEntry.nature is required — the catalog is not needed for nature).
 *   Tool-nature entries have no adapter planRemove — they are skipped.
 *
 * Step 3 — Plan: adapter.planRemove(entry, scope, env) for each entry.
 *   Aggregated RemovalOp[]. Empty plan → "nothing to remove", no confirm needed.
 *
 * Step 4 — Render: renderRemovalPlan(ops) included in output.
 *
 * Step 5 — Confirm: resolve the `confirm` option.
 *   false → "aborted", no removals.
 *
 * Step 6 — Apply: remove(adapter, entries, scope, env, manifestPath).
 *   The engine handles backup → removal → manifest update.
 *
 * Step 7 — Compose output with recap.
 */
export async function runRemove(opts: RunRemoveOptions): Promise<RemoveCommandResult> {
  const { adapter, scope, env, manifestPath, selectedIds, confirm } = opts;
  const summary = opts.summary === true;
  const force = opts.force === true;

  // -------------------------------------------------------------------------
  // Step 1 + 2: Validate ids against the manifest (identity triple) and route
  // each entry. A lib lives under the global singleton (id, 'user', 'shared')
  // (S2), so it is looked up on THAT triple — not the run's scope/adapter.id —
  // and removed on the engine's lib channel (never the adapter, S3). Tool
  // entries carry no adapter ops. `removedEntries` keeps the FULL manifest entry
  // of every resolved id (tool and lib included): the R6 gate reads the requires
  // graph over ALL natures, not just the adapter-routed ones.
  // -------------------------------------------------------------------------

  const manifest = await readManifest(manifestPath);

  const adapterEntries: AdapterEntry[] = [];
  const libEntries: ManifestEntry[] = [];
  const removedEntries: ManifestEntry[] = [];
  for (const id of selectedIds) {
    const isLib = localId(id).startsWith('lib:');
    const entry = isLib
      ? findLibEntry(manifest, id)
      : findEntry(manifest, id, scope, adapter.id);
    if (entry === undefined) {
      const installedIds = [...new Set(manifest.artifacts.map((e) => e.id))];
      throw new NotInstalledError(id, installedIds);
    }
    removedEntries.push(entry);
    if (entry.nature === 'tool') continue;
    if (entry.nature === 'lib') {
      libEntries.push(entry);
      continue;
    }
    adapterEntries.push({ id: entry.id, nature: entry.nature, scope });
  }

  // -------------------------------------------------------------------------
  // Step 2b: R6 gate — run-level refcount over the persisted requires graph,
  // evaluated BEFORE any confirm or write (offline, manifest-first). `--force`
  // downgrades the refusal to a loud per-dependent warning.
  // -------------------------------------------------------------------------

  const blocks = computeRefcountBlocks(manifest, removedEntries);
  if (blocks.length > 0 && !force) {
    throw new RequiredByError(blocks);
  }
  const forceWarnings = blocks.length > 0
    ? blocks.map(
      (b) =>
        `--force: "${b.id}" removed while still required by ${
          b.dependents.map((d) => `"${d}"`).join(', ')
        } — their imports/dependencies will break`,
    )
    : [];

  // -------------------------------------------------------------------------
  // Step 2c: R7.1/S9 GC — a lib whose LAST dependent leaves in this run is
  // proposed for removal in the SAME run, under the same confirm: it joins both
  // the removal set and the plan preview.
  // -------------------------------------------------------------------------

  const gcLibs = computeGcLibs(manifest, removedEntries);
  const gcIds = new Set(gcLibs.map((e) => e.id));
  for (const gcLib of gcLibs) {
    libEntries.push(gcLib);
    removedEntries.push(gcLib);
  }

  // -------------------------------------------------------------------------
  // Step 3: Plan — build per-entry removal groups.
  // Entries are enriched with their manifest `applied` payload so the preview
  // matches what remove() will actually do.
  // -------------------------------------------------------------------------

  const groups: PlanRemovalGroup[] = [];
  const planWarnings: string[] = [];
  // Entries whose plan is empty while still recorded in the manifest — their
  // target vanished from disk (R1/D1). remove() converges them via the purge
  // channel: no disk mutation, so no confirmation is required, but the recap
  // still lists them ("purged (already absent)").
  const purgeCandidates: string[] = [];
  for (const entry of adapterEntries) {
    // Keyed by adapter.id (E6): the preview must enrich from the SAME manifest
    // identity (id, scope, assistant) that the real remove() call below will
    // read — otherwise a two-assistant manifest would preview one assistant's
    // `applied` payload while removing the other's.
    const enriched = enrichWithApplied(entry, manifest, adapter.id);
    const plannedOps = await adapter.planRemove(enriched, scope, env);

    // Collect plan warnings — same channel as install plans (cmd-install):
    // any op carrying a `warnings` array surfaces it to the user before
    // confirm. The R3 leave-alone ops (unmanaged target left in place) carry
    // ONLY warnings: they are excluded from the rendered groups since nothing
    // will be removed for them (the engine drops them the same way).
    planWarnings.push(
      ...plannedOps.flatMap((op) =>
        'warnings' in op && Array.isArray(op.warnings) ? op.warnings : []
      ),
    );
    const ops = plannedOps.filter((op) => op.kind !== 'leave-alone');
    if (ops.length > 0) {
      groups.push({ id: entry.id, nature: entry.nature, ops });
    } else if (plannedOps.length === 0) {
      // Empty raw plan → target absent from disk. The entry is validated as
      // manifest-present (step 1), so this is a phantom the engine will purge.
      // A leave-alone (plannedOps NON-empty, ops empty) falls through: preserved,
      // no group, no purge — the R3 Lot 2 conservation contract.
      purgeCandidates.push(entry.id);
    }
  }

  // -------------------------------------------------------------------------
  // Step 4: Render plan (+ warnings block, visible before confirm)
  // -------------------------------------------------------------------------

  const warningsBlock = planWarnings.length > 0
    ? '\n\n--- Warnings ---\n' + planWarnings.map((w) => `  [warning] ${w}`).join('\n')
    : '';

  const cwd = opts.cwd ?? process.cwd();

  // R4: preview the fate of each unlink op's store — deleted with the last
  // reference, or kept because still referenced. The candidates are the same
  // the adapter will use at apply time (shared helper + ALL manifest files),
  // minus the targets being unlinked in THIS run: they still resolve at plan
  // time but will be gone before the store decision is made.
  const unlinkOps = groups
    .flatMap((g) => g.ops)
    .filter((op): op is RemovalOpUnlink => op.kind === 'unlink');
  const plannedTargets = new Set(unlinkOps.map((op) => path.resolve(op.target)));
  const manifestFiles = manifest.artifacts.flatMap((e) => e.files);
  const storeFates: Record<string, 'delete' | 'keep'> = {};
  for (const op of unlinkOps) {
    const candidates = storeReferenceCandidates(op.store, env, cwd, manifestFiles)
      .filter((candidate) => !plannedTargets.has(path.resolve(candidate)));
    storeFates[op.store] = (await isStoreReferenced(op.store, candidates)) ? 'keep' : 'delete';
  }

  // Lib removals (explicit + GC-proposed) are display-only in the preview: the
  // engine computes the real removal on its lib channel. A present dir is a
  // delete; a vanished dir is a manifest-only purge (R6.5).
  const libPreviews = await buildLibPreviews(libEntries, gcIds);
  const libBlock = renderLibRemovalBlock(libPreviews, resolveHome(env), cwd);
  const libDestroysDisk = libPreviews.some((p) => p.present);

  const planText = renderRemovalPlan(groups, {
    home: resolveHome(env),
    cwd,
    scope,
    assistant: adapter.id,
    storeFates,
    summary,
  }) + warningsBlock + libBlock;

  // -------------------------------------------------------------------------
  // Nothing to do → neither disk destruction nor a phantom to purge.
  // -------------------------------------------------------------------------

  if (groups.length === 0 && purgeCandidates.length === 0 && libEntries.length === 0) {
    const output = buildOutput({
      planText,
      reason: 'not-installed',
      removed: [],
      purged: [],
      backedUp: [],
      warnings: [],
      summary,
    });
    return { applied: false, removed: [], backedUp: [], output };
  }

  // -------------------------------------------------------------------------
  // Step 5: Confirm — only when the plan destroys something on disk: an adapter
  // group OR a lib dir present on disk. A pure purge (only phantom entries, no
  // group, no present lib) mutates state.json alone, so it proceeds without a
  // prompt (R1 scenario: "no confirmation but listed").
  // -------------------------------------------------------------------------

  if (groups.length > 0 || libDestroysDisk) {
    const confirmed = typeof confirm === 'boolean' ? confirm : await confirm(planText);
    if (!confirmed) {
      const output = buildOutput({
        planText,
        reason: 'aborted',
        removed: [],
        purged: [],
        backedUp: [],
        warnings: [],
        summary,
      });
      return { applied: false, removed: [], backedUp: [], output };
    }
  }

  // -------------------------------------------------------------------------
  // Step 6: Apply (backup → remove → manifest)
  // -------------------------------------------------------------------------

  // Lib entries ride alongside the adapter entries but the engine routes them to
  // its lib channel by nature (never the adapter, S3). Scope is nominal here —
  // the engine hardcodes the (id, 'user', 'shared') identity for a lib.
  const libRemovalEntries: AdapterEntry[] = libEntries.map((e) => ({
    id: e.id,
    nature: 'lib',
    scope: 'user',
  }));

  // Shared-store cleanup (R7): the hook scriptStore leaves with the last hook
  // (D6, ONE user-level dir of copies — the manifest is the only refcount).
  //
  // A lib is NOT such a store: each lib owns its OWN dir under libs/, and the
  // engine's lib channel already backs it up whole (`libs/<name>.bak-…`, a
  // sibling INSIDE libs/) and removes it per-entry. Passing `{nature:'lib', dir:
  // libsDir}` here would make the end-of-run cleanup back up the WHOLE libs/
  // (relocating that per-lib backup under `libs.bak-…/`) and then remove libs/ —
  // reporting a `backedUp` path that no longer exists and duplicating the bytes.
  // So the libs/ root is NOT a shared store: the per-entry channel is the sole,
  // correct owner of lib backup+removal (stable reported path), and the small
  // libs/ container lingers holding its backups, exactly as skill/agent store
  // backups already linger in their store dirs.
  const sharedStores: SharedNatureStore[] = [
    { nature: 'hook', dir: hookScriptStorePath(env) },
  ];
  const removeResult = await remove(
    adapter,
    [...adapterEntries, ...libRemovalEntries],
    scope,
    env,
    manifestPath,
    sharedStores,
  );

  // -------------------------------------------------------------------------
  // Step 7: Compose output
  // -------------------------------------------------------------------------

  const output = buildOutput({
    planText,
    reason: 'applied',
    removed: removeResult.removed,
    purged: removeResult.purged,
    backedUp: removeResult.backedUp,
    warnings: [...forceWarnings, ...removeResult.warnings],
    summary,
  });

  return {
    applied: removeResult.removed.length > 0 || removeResult.purged.length > 0,
    removed: removeResult.removed,
    backedUp: removeResult.backedUp,
    output,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface BuildOutputOpts {
  planText: string;
  reason: 'applied' | 'aborted' | 'not-installed';
  removed: string[];
  purged: string[];
  backedUp: string[];
  warnings: string[];
  /**
   * Compact mode (D3): drop the per-item `- id` lists (removed AND purged) in
   * the Result section. The aggregated status lines, the per-file backup lines
   * (`~ b`) and the `[warning]` lines are kept — same rationale as install.
   */
  summary?: boolean;
}

function buildOutput(opts: BuildOutputOpts): string {
  const { planText, reason, removed, purged, backedUp, warnings } = opts;
  const summary = opts.summary === true;
  const parts: string[] = [];

  parts.push('--- Removal Plan ---');
  parts.push(planText);
  parts.push('');

  parts.push('--- Result ---');

  if (reason === 'not-installed') {
    parts.push('  [ok] Nothing to remove — not installed.');
  } else if (reason === 'aborted') {
    parts.push('  [aborted] Removal cancelled by user.');
  } else {
    if (removed.length > 0) {
      parts.push(`  [ok] Removed ${removed.length} entry(s).`);
      // D3: the per-item list repeats ids the Plan section just named — summary
      // drops it, keeping the aggregated count above.
      if (!summary) {
        for (const id of removed) {
          parts.push(`    - ${id}`);
        }
      }
    }

    // R1/D1: entries whose target had already vanished — purged from the
    // manifest without touching the disk.
    if (purged.length > 0) {
      parts.push(`  [ok] Purged ${purged.length} entry(s) — purged (already absent).`);
      if (!summary) {
        for (const id of purged) {
          parts.push(`    - ${id}`);
        }
      }
    }

    if (backedUp.length > 0) {
      parts.push(`  [backup] ${backedUp.length} file(s) backed up.`);
      for (const b of backedUp) {
        parts.push(`    ~ ${b}`);
      }
    }

    for (const w of warnings) {
      parts.push(`  [warning] ${w}`);
    }
  }

  return parts.join('\n');
}
