/**
 * cmd-install — implementation of the `install` command.
 *
 * Responsibilities:
 * - Resolve selected artifact ids (including packs) via the catalog resolver.
 * - Check required/recommended tools (advisory; never blocks installation).
 * - Build the full plan (WriteOp[]) via adapter.plan() for each resolved entry.
 * - Render the plan diff and confirm with the user (injectable for tests).
 * - If confirmed and plan is non-empty: apply (backup → write → manifest).
 * - Return a typed InstallResult (applied, written, backedUp, toolWarnings, output).
 *
 * Constraints:
 * - No process.exit — the CLI bin (F5) decides what to do after cancellation.
 * - No while loops — for...of / map / Promise.all only.
 * - No import of process directly — all paths are injectable.
 * - Human-in-the-loop: nothing is written without confirmation.
 */

import type { Adapter, AdapterEntry } from '@agent-rigger/core/adapter';
import { apply } from '@agent-rigger/core/engine';
import type { Env } from '@agent-rigger/core/paths';
import { resolveHome } from '@agent-rigger/core/paths';
import type { Scope, WriteOp } from '@agent-rigger/core/types';

import type { ArtifactEntry, CatalogEntry } from '@agent-rigger/catalog';
import { resolve } from '@agent-rigger/catalog/resolver';
import { checkTools, missingRecommended, missingRequired } from '@agent-rigger/catalog/tool-check';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';

import { renderPlan } from './ui';

// ---------------------------------------------------------------------------
// InstallResult
// ---------------------------------------------------------------------------

/**
 * Result returned by runInstall.
 *
 * - applied       true when writes were performed (plan non-empty + confirmed).
 * - written       Absolute paths of files written to disk.
 * - backedUp      Absolute paths of .bak-* files created before writes.
 * - toolWarnings  Advisory: ids of required/recommended tools absent from the host.
 * - output        Human-readable summary ready to print.
 */
export interface InstallResult {
  applied: boolean;
  written: string[];
  backedUp: string[];
  toolWarnings: {
    required: string[];
    recommended: string[];
  };
  output: string;
}

// ---------------------------------------------------------------------------
// RunInstallOptions
// ---------------------------------------------------------------------------

/**
 * Options for runInstall — all injectable for test isolation.
 *
 * In production, `selectedIds` comes from ui.selectArtifacts,
 * `scope` from ui.selectScope, and `confirm` from ui.confirmApply.
 * runInstall receives them as plain values so it is fully testable
 * without a TTY or @clack/prompts.
 */
export interface RunInstallOptions {
  /** Catalog to resolve ids from (e.g. BUILTIN_CATALOG or a test-local subset). */
  catalog: CatalogEntry[];
  /** Adapter used for plan() and apply() (e.g. createClaudeAdapter(...)). */
  adapter: Adapter;
  /** Installation scope. */
  scope: Scope;
  /** Injectable env for HOME resolution. */
  env: Env;
  /** Absolute path to state.json (the manifest file). */
  manifestPath: string;
  /** Artifact ids (or pack ids) selected by the user. */
  selectedIds: string[];
  /**
   * Confirmation source.
   *  - boolean true  → always apply without prompting.
   *  - boolean false → always abort without prompting.
   *  - async callback → called with the rendered plan text; returns true/false.
   */
  confirm: boolean | ((planText: string) => Promise<boolean>);
  /** Optional CommandRunner for advisory tool checks. Defaults to defaultRunner. */
  toolRunner?: CommandRunner;
  /** Working directory (reserved; unused in M0). */
  cwd?: string;
  /**
   * Optional seam for remote installs.
   * When provided, each entry's ref/sha in the manifest is derived
   * from this function instead of the defaults (v0.0.0/'').
   */
  versionFor?: (
    entry: AdapterEntry,
  ) => { ref: string; sha: string };
}

// ---------------------------------------------------------------------------
// runInstall
// ---------------------------------------------------------------------------

/**
 * Execute the install command end-to-end and return a typed InstallResult.
 *
 * Step 1 — Resolution: resolve(selectedIds, catalog) → ArtifactEntry[].
 *   UnknownEntryError / DependencyCycleError propagate as-is.
 *
 * Step 2 — Advisory tool checks: checkTools(entries) → toolWarnings.
 *   Missing tools are reported but never block installation.
 *
 * Step 3 — Plan: adapter.plan(entry, scope, env) for each resolved entry.
 *   Aggregated WriteOp[]. Empty plan → "already up to date", no confirm needed.
 *
 * Step 4 — Diff: renderPlan(ops) included in output.
 *
 * Step 5 — Confirm: resolve the `confirm` option.
 *   false → "aborted", no writes.
 *
 * Step 6 — Apply: apply(adapter, entries, scope, env, manifestPath).
 *   The engine handles backup → write → manifest update.
 *
 * Step 7 — Compose output with recap.
 */
export async function runInstall(opts: RunInstallOptions): Promise<InstallResult> {
  const { catalog, adapter, scope, env, manifestPath, selectedIds, confirm, toolRunner } = opts;
  const { versionFor } = opts;

  // -------------------------------------------------------------------------
  // Step 1: Resolve selected ids → concrete artifact entries
  // -------------------------------------------------------------------------

  const entries: ArtifactEntry[] = resolve(selectedIds, catalog);

  // -------------------------------------------------------------------------
  // Step 2: Advisory tool checks
  // -------------------------------------------------------------------------

  const toolResults = await checkTools(entries, toolRunner);
  const requiredMissing = missingRequired(toolResults);
  const recommendedMissing = missingRecommended(toolResults);

  const toolWarnings = {
    required: requiredMissing.map((r) => r.id),
    recommended: recommendedMissing.map((r) => r.id),
  };

  // -------------------------------------------------------------------------
  // Step 3: Plan — aggregate WriteOps from all entries
  //
  // Tool-nature entries are host-system dependencies: they have no adapter
  // plan/apply (the adapter has no 'tool' handler). They are checked via
  // checkTools (advisory) but never installed by the adapter.
  // -------------------------------------------------------------------------

  const adapterEntries: AdapterEntry[] = entries
    .filter((e) => e.nature !== 'tool')
    .map((e) => ({
      id: e.id,
      nature: e.nature,
      scope,
    }));

  const allOps: WriteOp[] = [];
  for (const entry of adapterEntries) {
    const ops = await adapter.plan(entry, scope, env);
    allOps.push(...ops);
  }

  // -------------------------------------------------------------------------
  // Step 4: Diff (plan rendering)
  // -------------------------------------------------------------------------

  const planText = renderPlan(allOps, {
    home: resolveHome(env),
    cwd: opts.cwd ?? process.cwd(),
  });

  // -------------------------------------------------------------------------
  // Empty plan → already up to date, skip confirm + apply
  // -------------------------------------------------------------------------

  if (allOps.length === 0) {
    const output = buildOutput({
      planText,
      reason: 'up-to-date',
      toolWarnings,
      written: [],
      backedUp: [],
    });

    return {
      applied: false,
      written: [],
      backedUp: [],
      toolWarnings,
      output,
    };
  }

  // -------------------------------------------------------------------------
  // Step 5: Confirm
  // -------------------------------------------------------------------------

  const confirmed = typeof confirm === 'boolean' ? confirm : await confirm(planText);

  if (!confirmed) {
    const output = buildOutput({
      planText,
      reason: 'aborted',
      toolWarnings,
      written: [],
      backedUp: [],
    });

    return {
      applied: false,
      written: [],
      backedUp: [],
      toolWarnings,
      output,
    };
  }

  // -------------------------------------------------------------------------
  // Step 6: Apply (backup → write → manifest)
  // -------------------------------------------------------------------------

  const applyResult = versionFor === undefined
    ? await apply(adapter, adapterEntries, scope, env, manifestPath)
    : await apply(adapter, adapterEntries, scope, env, manifestPath, versionFor);

  // -------------------------------------------------------------------------
  // Step 7: Compose output
  // -------------------------------------------------------------------------

  const output = buildOutput({
    planText,
    reason: 'applied',
    toolWarnings,
    written: applyResult.written,
    backedUp: applyResult.backedUp,
  });

  return {
    applied: true,
    written: applyResult.written,
    backedUp: applyResult.backedUp,
    toolWarnings,
    output,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface BuildOutputOpts {
  planText: string;
  reason: 'applied' | 'aborted' | 'up-to-date';
  toolWarnings: { required: string[]; recommended: string[] };
  written: string[];
  backedUp: string[];
}

/**
 * Compose the final human-readable output string.
 *
 * Structure:
 *   --- Plan ---
 *   <renderPlan output>
 *
 *   --- Result ---
 *   <status line>
 *   <written files>
 *   <backed-up files>
 *
 *   --- Tool Warnings ---   (omitted when empty)
 *   <missing required tools>
 *   <missing recommended tools>
 */
function buildOutput(opts: BuildOutputOpts): string {
  const { planText, reason, toolWarnings, written, backedUp } = opts;
  const parts: string[] = [];

  // Plan section
  parts.push('--- Plan ---');
  parts.push(planText);
  parts.push('');

  // Result section
  parts.push('--- Result ---');

  if (reason === 'up-to-date') {
    parts.push('  [ok] Already up to date — nothing to install.');
  } else if (reason === 'aborted') {
    parts.push('  [aborted] Installation cancelled by user.');
  } else {
    parts.push(`  [ok] Applied ${written.length} file(s).`);

    for (const f of written) {
      parts.push(`    + ${f}`);
    }

    if (backedUp.length > 0) {
      parts.push(`  [backup] ${backedUp.length} file(s) backed up.`);
      for (const b of backedUp) {
        parts.push(`    ~ ${b}`);
      }
    }
  }

  // Tool warnings section
  const hasToolWarnings = toolWarnings.required.length > 0 || toolWarnings.recommended.length > 0;

  if (hasToolWarnings) {
    parts.push('');
    parts.push('--- Tool Warnings ---');

    for (const id of toolWarnings.required) {
      parts.push(`  [missing required]    ${id}`);
    }

    for (const id of toolWarnings.recommended) {
      parts.push(`  [missing recommended] ${id}`);
    }
  }

  return parts.join('\n');
}
