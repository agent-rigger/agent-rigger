/**
 * cmd-remove — implementation of the `remove` command.
 *
 * Responsibilities:
 * - Validate requested ids against the catalog.
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
 */

import type { Adapter, AdapterEntry } from '@agent-rigger/core/adapter';
import { enrichWithApplied, remove } from '@agent-rigger/core/engine';
import { readManifest } from '@agent-rigger/core/manifest';
import type { Env } from '@agent-rigger/core/paths';
import { resolveHome } from '@agent-rigger/core/paths';
import type { Scope } from '@agent-rigger/core/types';

import type { CatalogEntry } from '@agent-rigger/catalog';

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
  /** Catalog to look up ids from. */
  catalog: CatalogEntry[];
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
// UnknownRemoveIdError
// ---------------------------------------------------------------------------

/**
 * Thrown when a requested id is not found in the catalog.
 */
export class UnknownRemoveIdError extends Error {
  constructor(public readonly id: string) {
    super(`Unknown artifact id "${id}". Run "agent-rigger ls" to see available entries.`);
    this.name = 'UnknownRemoveIdError';
  }
}

// ---------------------------------------------------------------------------
// runRemove
// ---------------------------------------------------------------------------

/**
 * Execute the remove command end-to-end and return a typed RemoveCommandResult.
 *
 * Step 1 — Validation: each id must exist in the catalog.
 *   Unknown ids throw UnknownRemoveIdError immediately.
 *
 * Step 2 — Build AdapterEntries: { id, nature, scope } for each id.
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
  const { catalog, adapter, scope, env, manifestPath, selectedIds, confirm } = opts;

  // -------------------------------------------------------------------------
  // Step 1: Validate ids against catalog
  // -------------------------------------------------------------------------

  const catalogEntries: CatalogEntry[] = [];
  for (const id of selectedIds) {
    const entry = catalog.find((e) => e.id === id);
    if (entry === undefined) {
      throw new UnknownRemoveIdError(id);
    }
    catalogEntries.push(entry);
  }

  // -------------------------------------------------------------------------
  // Step 2: Build adapter entries (skip tool-nature)
  // -------------------------------------------------------------------------

  const adapterEntries: AdapterEntry[] = catalogEntries.flatMap((entry) => {
    if (entry.kind === 'pack') return [];
    if (entry.nature === 'tool') return [];
    return [{ id: entry.id, nature: entry.nature, scope }];
  });

  // -------------------------------------------------------------------------
  // Step 3: Plan — build per-entry removal groups.
  // Entries are enriched with their manifest `applied` payload so the preview
  // matches what remove() will actually do.
  // -------------------------------------------------------------------------

  const manifest = await readManifest(manifestPath);
  const groups: PlanRemovalGroup[] = [];
  for (const entry of adapterEntries) {
    const enriched = enrichWithApplied(entry, manifest);
    const ops = await adapter.planRemove(enriched, scope, env);
    if (ops.length > 0) {
      groups.push({ id: entry.id, nature: entry.nature, ops });
    }
  }

  // -------------------------------------------------------------------------
  // Step 4: Render plan
  // -------------------------------------------------------------------------

  const planText = renderRemovalPlan(groups, {
    home: resolveHome(env),
    cwd: opts.cwd ?? process.cwd(),
    scope,
  });

  // -------------------------------------------------------------------------
  // Empty plan → nothing to remove, skip confirm + apply
  // -------------------------------------------------------------------------

  if (groups.length === 0) {
    const output = buildOutput({ planText, reason: 'not-installed', removed: [], backedUp: [] });
    return { applied: false, removed: [], backedUp: [], output };
  }

  // -------------------------------------------------------------------------
  // Step 5: Confirm
  // -------------------------------------------------------------------------

  const confirmed = typeof confirm === 'boolean' ? confirm : await confirm(planText);

  if (!confirmed) {
    const output = buildOutput({ planText, reason: 'aborted', removed: [], backedUp: [] });
    return { applied: false, removed: [], backedUp: [], output };
  }

  // -------------------------------------------------------------------------
  // Step 6: Apply (backup → remove → manifest)
  // -------------------------------------------------------------------------

  const removeResult = await remove(adapter, adapterEntries, scope, env, manifestPath);

  // -------------------------------------------------------------------------
  // Step 7: Compose output
  // -------------------------------------------------------------------------

  const output = buildOutput({
    planText,
    reason: 'applied',
    removed: removeResult.removed,
    backedUp: removeResult.backedUp,
  });

  return {
    applied: true,
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
  backedUp: string[];
}

function buildOutput(opts: BuildOutputOpts): string {
  const { planText, reason, removed, backedUp } = opts;
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
    parts.push(`  [ok] Removed ${removed.length} entry(s).`);

    for (const id of removed) {
      parts.push(`    - ${id}`);
    }

    if (backedUp.length > 0) {
      parts.push(`  [backup] ${backedUp.length} file(s) backed up.`);
      for (const b of backedUp) {
        parts.push(`    ~ ${b}`);
      }
    }
  }

  return parts.join('\n');
}
