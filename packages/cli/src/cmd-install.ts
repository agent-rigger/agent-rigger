/**
 * cmd-install — implementation of the `install` command.
 *
 * Responsibilities:
 * - Resolve selected artifact ids (including packs) via the catalog resolver.
 * - Build the full plan (WriteOp[]) via adapter.plan() for each resolved entry.
 * - Render the plan diff — including the raw `check` command of any selected
 *   tool entry, for visibility — and confirm with the user (injectable for tests).
 * - Only AFTER confirmation: check required/recommended tools (advisory; never
 *   blocks installation) for the resolved selection, then apply (backup → write
 *   → manifest). A `check` command is arbitrary shell content sourced from the
 *   catalog — it must never run before the user has seen and confirmed the plan.
 * - Return a typed InstallResult (applied, written, backedUp, toolWarnings, output).
 *
 * Constraints:
 * - No process.exit — the CLI bin (F5) decides what to do after cancellation.
 * - No while loops — for...of / map / Promise.all only.
 * - No import of process directly — all paths are injectable.
 * - Human-in-the-loop: nothing is written without confirmation, and no tool
 *   `check` command is executed without confirmation either.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { Adapter, AdapterEntry } from '@agent-rigger/core/adapter';
import { apply } from '@agent-rigger/core/engine';
import { findEntry, readManifest } from '@agent-rigger/core/manifest';
import type { Env } from '@agent-rigger/core/paths';
import { resolveHome } from '@agent-rigger/core/paths';
import type { Scope } from '@agent-rigger/core/types';

import type { ArtifactEntry, CatalogEntry } from '@agent-rigger/catalog';
import { resolve } from '@agent-rigger/catalog/resolver';
import { checkTools, missingRecommended, missingRequired } from '@agent-rigger/catalog/tool-check';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';

import { renderPlan } from './ui';
import type { PlanGroup } from './ui';

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
 * - skipped       Entries excluded because their `targets` doesn't include the
 *                  adapter's assistant (R1.5/R9.2 — never silent).
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
  skipped: { id: string; targets: string[] }[];
  /** Translation warnings collected from planned ops (guardrail/agent), shown to the user. */
  warnings: string[];
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
// Git repo detection (project-scope footgun warning)
// ---------------------------------------------------------------------------

/**
 * Return true when the given directory is the root of a git repository.
 * A git repo is detected by the presence of a `.git` entry (file or directory)
 * at the root of `dir`. Uses fs.access() which works for both files (git
 * worktrees) and directories (regular clones).
 */
async function isGitRepo(dir: string): Promise<boolean> {
  return fs.access(path.join(dir, '.git')).then(
    () => true,
    () => false,
  );
}

/**
 * Build the project-scope note prepended to planText.
 *
 * Always emits the target cwd. Adds a repo-pollution warning when a `.git`
 * entry is detected at the cwd root.
 *
 * @param targetCwd  Effective cwd (opts.cwd ?? process.cwd()).
 */
async function buildProjectScopeNote(targetCwd: string): Promise<string> {
  const lines: string[] = [
    `--- Project Scope Target ---`,
    `  Target directory: ${targetCwd}`,
  ];

  const gitRepo = await isGitRepo(targetCwd);
  if (gitRepo) {
    lines.push(
      `  [warning] This directory is a git repo — files written here will appear`,
      `            in version control. Commit or .gitignore them intentionally.`,
    );
  }

  lines.push('');
  return lines.join('\n');
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
 * Step 1b — Target routing (E-targets, R1.5/R9.2): entries whose `targets`
 *   doesn't include the adapter's assistant (adapter.id) are excluded from
 *   installation and reported in `skipped` + a visible `[skipped]` line in
 *   `output` — never silently dropped.
 *
 * Step 2 — Tool presence-checks (selection-scoped, NOT executed): compute
 *   toolEntries from the resolved selection. Their raw `check` command is
 *   rendered in the plan for visibility, but nothing runs yet.
 *
 * Step 3 — Plan: adapter.plan(entry, scope, env) for each resolved entry.
 *   Aggregated WriteOp[]. Empty plan → "already up to date", no confirm needed.
 *
 * Step 4 — Diff: renderPlan(ops) included in output, plus the tool-checks block.
 *
 * Step 5 — Confirm: resolve the `confirm` option.
 *   false → "aborted", no writes, no tool checks executed.
 *
 * Step 5b — Advisory tool checks: only once confirmed, checkTools(toolEntries)
 *   → toolWarnings. Missing tools are reported but never block installation.
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

  const resolved: ArtifactEntry[] = resolve(selectedIds, catalog);

  // -------------------------------------------------------------------------
  // Step 1b: Target routing — split by assistant compatibility (E-targets)
  // -------------------------------------------------------------------------

  const entries: ArtifactEntry[] = [];
  const skipped: { id: string; targets: string[] }[] = [];
  for (const e of resolved) {
    if (e.targets.includes(adapter.id)) {
      entries.push(e);
    } else {
      skipped.push({ id: e.id, targets: e.targets });
    }
  }

  // -------------------------------------------------------------------------
  // Step 2: Tool presence-checks — SELECTION-scoped, NOT executed yet.
  //
  // `check` is an arbitrary shell command sourced from catalog content. It is
  // only ever executed after the user has confirmed the plan (Step 5b) — never
  // before. Here we only compute which entries are eligible (tool-nature,
  // selection-scoped, with a check command) so the raw command can be shown in
  // the plan for visibility ahead of confirmation.
  // -------------------------------------------------------------------------

  const toolEntries: ArtifactEntry[] = entries.filter(
    (e): e is ArtifactEntry & { check: string } => e.nature === 'tool' && Boolean(e.check),
  );

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

  // Read manifest once to determine action (install vs update) per entry.
  const manifest = await readManifest(manifestPath);
  const groups: PlanGroup[] = [];
  for (const entry of adapterEntries) {
    const ops = await adapter.plan(entry, scope, env);
    if (ops.length > 0) {
      const action: 'install' | 'update' =
        findEntry(manifest, entry.id, scope, adapter.id) === undefined
          ? 'install'
          : 'update';
      groups.push({ id: entry.id, nature: entry.nature, action, ops });
    }
  }

  // -------------------------------------------------------------------------
  // Step 4: Diff (plan rendering)
  // -------------------------------------------------------------------------

  const effectiveCwd = opts.cwd ?? process.cwd();

  const renderedPlan = renderPlan(groups, {
    home: resolveHome(env),
    cwd: effectiveCwd,
    scope,
  });

  // Prepend project-scope note (cwd + optional git-repo warning) when relevant.
  // The note is included in planText so it is visible in both the confirm prompt
  // and the final output, across all branches (up-to-date / aborted / applied).
  const projectNote = scope === 'project'
    ? await buildProjectScopeNote(effectiveCwd)
    : '';

  // Collect translation warnings from planned ops (guardrail/agent → opencode).
  // Rendered in planText so they are visible in the confirm prompt AND the final
  // output — a non-translatable rule is never silently dropped (R5.3/R6.3, HIGH-2).
  const warnings = [
    ...new Set(
      groups
        .flatMap((g) => g.ops)
        .flatMap((op) => ('warnings' in op && Array.isArray(op.warnings) ? op.warnings : [])),
    ),
  ];
  const warningsBlock = warnings.length > 0
    ? '\n--- Warnings ---\n' + warnings.map((w) => `  [warning] ${w}`).join('\n') + '\n'
    : '';

  // Render the raw `check` command of every selection-scoped tool entry so it
  // is visible BEFORE confirmation — a malicious catalog command must be
  // readable by the user, not silently executed.
  const toolChecksBlock = toolEntries.length > 0
    ? '\n--- Tool presence-checks (run after you confirm) ---\n'
      + toolEntries.map((e) => `  ${e.id}  →  ${e.check}`).join('\n') + '\n'
    : '';

  const planText = projectNote + renderedPlan + warningsBlock + toolChecksBlock;

  // -------------------------------------------------------------------------
  // Empty plan → already up to date, skip confirm + apply
  // -------------------------------------------------------------------------

  // No-execution tool warnings — used whenever the run ends WITHOUT the user
  // confirming (up-to-date short-circuit, or explicit abort below). A `check`
  // command never runs unless the user has confirmed the plan.
  const noExecToolWarnings = { required: [] as string[], recommended: [] as string[] };

  if (groups.length === 0) {
    const output = buildOutput({
      planText,
      reason: 'up-to-date',
      toolWarnings: noExecToolWarnings,
      skipped,
      assistantId: adapter.id,
      written: [],
      backedUp: [],
    });

    return {
      applied: false,
      written: [],
      backedUp: [],
      toolWarnings: noExecToolWarnings,
      skipped,
      warnings,
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
      toolWarnings: noExecToolWarnings,
      skipped,
      assistantId: adapter.id,
      written: [],
      backedUp: [],
    });

    return {
      applied: false,
      written: [],
      backedUp: [],
      toolWarnings: noExecToolWarnings,
      skipped,
      warnings,
      output,
    };
  }

  // -------------------------------------------------------------------------
  // Step 5b: Post-confirmation tool presence-checks (advisory).
  //
  // The `check` command only runs once the user has confirmed the plan, and
  // only for the resolved selection (toolEntries) — never the full catalog.
  // A missing tool is reported but never blocks the install (exit 0).
  // -------------------------------------------------------------------------

  const toolResults = await checkTools(toolEntries, toolRunner);
  const toolWarnings = {
    required: missingRequired(toolResults).map((r) => r.id),
    recommended: missingRecommended(toolResults).map((r) => r.id),
  };

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
    skipped,
    assistantId: adapter.id,
    written: applyResult.written,
    backedUp: applyResult.backedUp,
  });

  return {
    applied: true,
    written: applyResult.written,
    backedUp: applyResult.backedUp,
    toolWarnings,
    skipped,
    warnings,
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
  /** Entries excluded from this transaction because of a `targets` mismatch (E-targets). */
  skipped: { id: string; targets: string[] }[];
  /** adapter.id — the assistant this transaction targeted, shown in the skipped line. */
  assistantId: string;
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
 *   --- Skipped (assistant mismatch) ---   (omitted when empty — R1.5/R9.2)
 *   <one [skipped] line per excluded entry>
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
  const { planText, reason, toolWarnings, skipped, assistantId, written, backedUp } = opts;
  const parts: string[] = [];

  // Plan section
  parts.push('--- Plan ---');
  parts.push(planText);
  parts.push('');

  // Skipped section — never silent (R1.5/R9.2): an entry excluded by target
  // routing must be visible, even though it never reaches the plan above.
  if (skipped.length > 0) {
    parts.push('--- Skipped (assistant mismatch) ---');
    for (const s of skipped) {
      parts.push(`  [skipped] ${s.id} — targets [${s.targets.join(', ')}], not ${assistantId}`);
    }
    parts.push('');
  }

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
