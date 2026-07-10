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

import path from 'node:path';

import { isStoreReferenced, storeReferenceCandidates } from '@agent-rigger/adapters';
import { localId } from '@agent-rigger/catalog';
import type { Adapter, AdapterEntry } from '@agent-rigger/core/adapter';
import { enrichWithApplied, remove } from '@agent-rigger/core/engine';
import { findEntry, readManifest } from '@agent-rigger/core/manifest';
import type { Env } from '@agent-rigger/core/paths';
import { resolveHome } from '@agent-rigger/core/paths';
import type { RemovalOpUnlink, Scope } from '@agent-rigger/core/types';

import { hookScriptStorePath } from './adapter-builder';
import { renderRemovalPlan } from './ui';
import type { PlanRemovalGroup } from './ui';

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

  // -------------------------------------------------------------------------
  // Step 1 + 2: Validate ids against the manifest (identity triple) and build
  // adapter entries from the manifest's own nature (skip tool-nature).
  // -------------------------------------------------------------------------

  const manifest = await readManifest(manifestPath);

  const adapterEntries: AdapterEntry[] = [];
  for (const id of selectedIds) {
    const entry = findEntry(manifest, id, scope, adapter.id);
    if (entry === undefined) {
      const installedIds = [...new Set(manifest.artifacts.map((e) => e.id))];
      throw new NotInstalledError(id, installedIds);
    }
    if (entry.nature === 'tool') continue;
    adapterEntries.push({ id: entry.id, nature: entry.nature, scope });
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

  const planText = renderRemovalPlan(groups, {
    home: resolveHome(env),
    cwd,
    scope,
    storeFates,
  }) + warningsBlock;

  // -------------------------------------------------------------------------
  // Nothing to do → neither disk destruction nor a phantom to purge.
  // -------------------------------------------------------------------------

  if (groups.length === 0 && purgeCandidates.length === 0) {
    const output = buildOutput({
      planText,
      reason: 'not-installed',
      removed: [],
      purged: [],
      backedUp: [],
      warnings: [],
    });
    return { applied: false, removed: [], backedUp: [], output };
  }

  // -------------------------------------------------------------------------
  // Step 5: Confirm — only when the plan destroys something on disk. A pure
  // purge (only phantom manifest entries, no group) mutates state.json alone,
  // so it proceeds without a prompt (R1 scenario: "no confirmation but listed").
  // -------------------------------------------------------------------------

  if (groups.length > 0) {
    const confirmed = typeof confirm === 'boolean' ? confirm : await confirm(planText);
    if (!confirmed) {
      const output = buildOutput({
        planText,
        reason: 'aborted',
        removed: [],
        purged: [],
        backedUp: [],
        warnings: [],
      });
      return { applied: false, removed: [], backedUp: [], output };
    }
  }

  // -------------------------------------------------------------------------
  // Step 6: Apply (backup → remove → manifest)
  // -------------------------------------------------------------------------

  // R7: hook guard scripts are copies shared through one user-level directory
  // (path derivable from the env — design D6, same seam as adapter-builder).
  // The engine deletes it, backed up as a whole, when the run removes the
  // last hook-nature manifest entry (all scopes — hooks are claude-only, so
  // passing the descriptor to any adapter is inert for the others).
  const removeResult = await remove(adapter, adapterEntries, scope, env, manifestPath, [
    { nature: 'hook', dir: hookScriptStorePath(env) },
  ]);

  // -------------------------------------------------------------------------
  // Step 7: Compose output
  // -------------------------------------------------------------------------

  const output = buildOutput({
    planText,
    reason: 'applied',
    removed: removeResult.removed,
    purged: removeResult.purged,
    backedUp: removeResult.backedUp,
    warnings: removeResult.warnings,
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
}

function buildOutput(opts: BuildOutputOpts): string {
  const { planText, reason, removed, purged, backedUp, warnings } = opts;
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
      for (const id of removed) {
        parts.push(`    - ${id}`);
      }
    }

    // R1/D1: entries whose target had already vanished — purged from the
    // manifest without touching the disk.
    if (purged.length > 0) {
      parts.push(`  [ok] Purged ${purged.length} entry(s) — purged (already absent).`);
      for (const id of purged) {
        parts.push(`    - ${id}`);
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
