/**
 * cmd-install — implementation of the `install` command.
 *
 * Responsibilities:
 * - Resolve selected artifact ids (including packs) via the catalog resolver.
 * - Build the full plan (WriteOp[]) via adapter.plan() for each resolved entry.
 * - Render the plan diff — including the raw `check` command of any selected
 *   tool entry, for visibility — and confirm with the user (injectable for tests).
 * - Only AFTER plan confirmation: resolve GRANULAR consent for each tool's
 *   `check` command against the ledger (@agent-rigger/core/consent) — a
 *   command already approved for the same (id, command) pair is never
 *   re-prompted; a changed command always is. Only consented commands are
 *   executed; a refused command is reported 'unverified', never 'absent',
 *   and the install still proceeds (advisory; never blocks installation).
 *   Then apply (backup → write → manifest). A `check` command is arbitrary
 *   shell content sourced from the catalog — it must never run before both
 *   the plan AND its own execution have been separately consented to.
 * - Return a typed InstallResult (applied, written, backedUp, toolWarnings, output).
 *
 * Constraints:
 * - No process.exit — the CLI bin (F5) decides what to do after cancellation.
 * - No while loops — for...of / map / Promise.all only.
 * - No import of process directly — all paths are injectable.
 * - Human-in-the-loop: nothing is written without confirmation, and no tool
 *   `check` command is executed without its own separate, granular consent.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { Adapter, AdapterEntry } from '@agent-rigger/core/adapter';
import { isConsented, recordConsent } from '@agent-rigger/core/consent';
import { apply, enrichWithApplied } from '@agent-rigger/core/engine';
import { findEntry, readManifest } from '@agent-rigger/core/manifest';
import type { Env } from '@agent-rigger/core/paths';
import { resolveHome } from '@agent-rigger/core/paths';
import type { Manifest, Scope } from '@agent-rigger/core/types';

import type { ArtifactEntry, CatalogEntry } from '@agent-rigger/catalog';
import { resolve } from '@agent-rigger/catalog/resolver';
import {
  checkTools,
  missingRecommended,
  missingRequired,
  unverifiedTools,
} from '@agent-rigger/catalog/tool-check';
import type { CommandRunner, ToolCheckResult } from '@agent-rigger/catalog/tool-check';

import { confirmToolChecks as promptConfirmToolChecks, renderPlan } from './ui';
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
  /**
   * Optional batch consent prompt for tool presence-check commands not yet
   * recorded in the consent ledger (@agent-rigger/core/consent).
   *
   * Confirming the plan (`confirm`) is a SEPARATE decision from consenting to
   * run a tool's `check` command. This callback is only invoked when:
   *  - `confirm` resolved interactively (a function, not a boolean), AND
   *  - at least one selection-scoped tool entry is not already consented.
   *
   * Defaults to the real interactive ui.confirmToolChecks when omitted.
   * Tests should always inject a fake here to avoid touching @clack/prompts.
   */
  confirmToolChecks?: (commands: { id: string; command: string }[]) => Promise<boolean>;
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
// Adoption detection (R5/D5)
// ---------------------------------------------------------------------------

/**
 * Whether any selected entry is due for adoption (R5/D5): an artifact whose plan
 * is empty (caller only invokes this when every group is empty), with NO manifest
 * record for (id, scope, adapter.id), whose adapter.adopt returns a result (strict
 * per-nature gate: only when the audit is exactly `present`).
 *
 * Read-only: adapter.adopt performs no filesystem writes. The engine calls adopt
 * AGAIN inside apply() to perform the actual record — this second read-only call
 * is the pre-detection that decides whether apply() must be reached at all
 * (otherwise the "up-to-date" short-circuit would skip it).
 *
 * Returns false immediately for an adapter without an `adopt` method (legacy
 * fakes, or an assistant with no adoption support): the caller keeps the
 * historical empty-plan no-op.
 */
async function isAdoptionDue(
  adapter: Adapter,
  entries: AdapterEntry[],
  scope: Scope,
  env: Env,
  manifest: Manifest,
): Promise<boolean> {
  if (adapter.adopt === undefined) {
    return false;
  }
  for (const entry of entries) {
    if (findEntry(manifest, entry.id, scope, adapter.id) !== undefined) {
      continue;
    }
    const adoption = await adapter.adopt(entry, scope, env);
    if (adoption !== undefined) {
      return true;
    }
  }
  return false;
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
 * Step 5b — Granular consent + advisory tool checks: only once the plan is
 *   confirmed, each toolEntry's `check` command is looked up in the consent
 *   ledger (isConsented, keyed by id + sha256(command)). Not-yet-consented
 *   commands are batch-prompted (confirmToolChecks) unless `confirm` was the
 *   boolean `true` (--yes), in which case consent is implicit. Newly granted
 *   consent is persisted (recordConsent) BEFORE running checkTools on the
 *   consented subset. Refused commands never run any shell and are reported
 *   'unverified' (never 'absent'). toolWarnings (missing required/recommended)
 *   and unverifiedIds are both advisory — neither ever blocks installation.
 *
 * Step 6 — Apply: apply(adapter, entries, scope, env, manifestPath).
 *   The engine handles backup → write → manifest update.
 *
 * Step 7 — Compose output with recap.
 */
export async function runInstall(opts: RunInstallOptions): Promise<InstallResult> {
  const { catalog, adapter, scope, env, manifestPath, selectedIds, confirm } = opts;
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

  const toolEntries: (ArtifactEntry & { check: string })[] = entries.filter(
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
  // Advisory warnings for entries whose plan came back empty because the
  // audit could not confirm a state — e.g. a plugin nature whose
  // installed_plugins.json is unparsable / an unrecognised version (obs1 R2
  // 'unknown'). planPlugin deliberately returns [] there (no reinstall
  // churn), so there is no op left to carry a `warnings` array; audit is
  // queried directly so the install run still surfaces the advisory
  // ("install no-op on this artefact, advisory warning shown" — R2 scenario 4)
  // instead of finishing in silence.
  const advisoryWarnings: string[] = [];
  for (const entry of adapterEntries) {
    // Enrich with the manifest `applied` payload — same seam as engine.apply
    // (R1/D8): the previewed plan must match the executed one, including the
    // remove-hooks op of a traced hook migration.
    const enriched = enrichWithApplied(entry, manifest, adapter.id);
    const ops = await adapter.plan(enriched, scope, env);
    if (ops.length > 0) {
      const action: 'install' | 'update' =
        findEntry(manifest, entry.id, scope, adapter.id) === undefined
          ? 'install'
          : 'update';
      groups.push({ id: entry.id, nature: entry.nature, action, ops });
    } else if (entry.nature === 'plugin') {
      const report = await adapter.audit(enriched, scope, env);
      if (report.state === 'unknown') {
        advisoryWarnings.push(
          `"${entry.id}": ${
            report.detail ?? 'state unknown (advisory) — no install plan generated'
          }`,
        );
      }
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
    assistant: adapter.id,
  });

  // Prepend project-scope note (cwd + optional git-repo warning) when relevant.
  // The note is included in planText so it is visible in both the confirm prompt
  // and the final output, across all branches (up-to-date / aborted / applied).
  const projectNote = scope === 'project'
    ? await buildProjectScopeNote(effectiveCwd)
    : '';

  // Collect translation warnings from planned ops (guardrail/agent → opencode),
  // plus the audit-derived advisory warnings collected above (obs1 R2 unknown).
  // Rendered in planText so they are visible in the confirm prompt AND the final
  // output — a non-translatable rule is never silently dropped (R5.3/R6.3, HIGH-2).
  const warnings = [
    ...new Set([
      ...groups
        .flatMap((g) => g.ops)
        .flatMap((op) => ('warnings' in op && Array.isArray(op.warnings) ? op.warnings : [])),
      ...advisoryWarnings,
    ]),
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

  // No-execution tool warnings — used only on the explicit ABORT branch below,
  // where the user declined the plan outright: no `check` command runs when the
  // whole plan is rejected. (The empty-plan branch DOES run the checks, under
  // their own separate consent gate — B10/D5 — so it no longer uses these.)
  const noExecToolWarnings = { required: [] as string[], recommended: [] as string[] };

  // No-execution unverified list — mirrors noExecToolWarnings for the abort
  // branch: consent is never evaluated when the plan is rejected, so nothing is
  // ever "refused" there either.
  const noExecUnverified: string[] = [];

  if (groups.length === 0) {
    // B10/D5: an empty write-plan does NOT skip the tool presence-checks. Their
    // execution has its OWN consent gate (ledger + batch prompt), independent of
    // any plan confirmation — which is absent here precisely because there is
    // nothing to write. A tools-only selection (or an up-to-date / adoption run
    // that still carries tool entries) must still verify and report them. Run
    // the same sequence as the non-empty path (never a synthetic plan confirm).
    const { toolWarnings, unverifiedIds } = await runToolPresenceChecks(toolEntries, opts);

    // R5/D5: an empty plan does NOT always mean "nothing to do". An artifact
    // present on disk but ABSENT from the manifest (M4, typically after a
    // manifest loss) must be ADOPTED — recorded in state.json with no config
    // write. The engine does this in its own empty-plan branch, but only if
    // apply() is reached; the historical "up-to-date" short-circuit below skips
    // apply entirely. So detect whether any adoption is due (read-only) and, if
    // so, reach apply — WITHOUT a confirmation prompt (only state.json changes).
    const adoptionDue = await isAdoptionDue(adapter, adapterEntries, scope, env, manifest);

    if (adoptionDue) {
      const applyResult = versionFor === undefined
        ? await apply(adapter, adapterEntries, scope, env, manifestPath)
        : await apply(adapter, adapterEntries, scope, env, manifestPath, versionFor);

      const output = buildOutput({
        planText,
        // Fall back to up-to-date if, against expectation, nothing was adopted
        // (e.g. a TOCTOU change between detection and apply) — never claim a
        // phantom adoption.
        reason: applyResult.adopted.length > 0 ? 'adopted' : 'up-to-date',
        toolWarnings,
        unverifiedIds,
        skipped,
        assistantId: adapter.id,
        written: applyResult.written,
        backedUp: applyResult.backedUp,
        adopted: applyResult.adopted,
      });

      return {
        // No config file was written — only state.json changed — so `applied`
        // (the "writes were performed" signal) stays false.
        applied: false,
        written: applyResult.written,
        backedUp: applyResult.backedUp,
        toolWarnings,
        skipped,
        warnings,
        output,
      };
    }

    const output = buildOutput({
      planText,
      reason: 'up-to-date',
      toolWarnings,
      unverifiedIds,
      skipped,
      assistantId: adapter.id,
      written: [],
      backedUp: [],
    });

    return {
      applied: false,
      written: [],
      backedUp: [],
      toolWarnings,
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
      unverifiedIds: noExecUnverified,
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
  // Step 5b: Post-confirmation tool presence-checks (advisory), gated by a
  // SEPARATE granular consent (see runToolPresenceChecks).
  //
  // Confirming the plan above is not consent to run a tool's `check` command —
  // that consent is per-command, looked up (or prompted) here, only for the
  // resolved selection (toolEntries), only after plan confirmation. A refused
  // command never runs any shell: it is reported 'unverified', never 'absent'.
  // A missing (verified-absent) tool is reported but never blocks the install.
  // The empty-plan branch above runs this exact same sequence under the same
  // consent gate (B10/D5) — the checks are detached from a non-empty write plan.
  // -------------------------------------------------------------------------

  const { toolWarnings, unverifiedIds } = await runToolPresenceChecks(toolEntries, opts);

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
    unverifiedIds,
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

/**
 * Granular consent + advisory tool presence-checks for the resolved selection.
 *
 * Confirming the install plan is a SEPARATE decision from consenting to run a
 * tool's `check` command: this gate is per-command, memoized in the consent
 * ledger keyed by (id, sha256(command)). Each toolEntry is looked up
 * (isConsented); not-yet-consented commands are batch-prompted
 * (confirmToolChecks) unless `confirm` is the boolean `true` (--yes), where
 * consent is implicit. Newly granted consent is persisted (recordConsent)
 * BEFORE running checkTools on the consented subset. Refused commands never run
 * any shell and are reported 'unverified' (never 'absent').
 *
 * Both the returned toolWarnings (missing required/recommended) and unverifiedIds
 * are advisory — neither ever blocks installation. This is the SAME sequence
 * whether the write-plan is empty (tools-only / up-to-date / adoption) or not
 * (post plan-confirmation): a `check` command is arbitrary shell content sourced
 * from the catalog and must never run without its own recorded consent.
 */
async function runToolPresenceChecks(
  toolEntries: (ArtifactEntry & { check: string })[],
  opts: RunInstallOptions,
): Promise<{
  toolWarnings: { required: string[]; recommended: string[] };
  unverifiedIds: string[];
}> {
  const { env, scope, confirm, toolRunner, versionFor } = opts;

  const consentChecks = await Promise.all(
    toolEntries.map(async (e) => ({
      entry: e,
      consented: await isConsented(env, { id: e.id, command: e.check }),
    })),
  );
  const alreadyConsented = consentChecks.filter((c) => c.consented).map((c) => c.entry);
  const needConsent = consentChecks.filter((c) => !c.consented).map((c) => c.entry);

  let newlyConsented: (ArtifactEntry & { check: string })[] = [];
  let refused: (ArtifactEntry & { check: string })[] = [];

  if (needConsent.length > 0) {
    // confirm === true (boolean, e.g. --yes): the plan — which already lists
    // every one of these commands — was pre-accepted non-interactively, so
    // consent is implicit. Otherwise, batch-prompt for the not-yet-consented
    // subset only.
    const consentGranted = typeof confirm === 'boolean'
      ? true
      : await (opts.confirmToolChecks ?? promptConfirmToolChecks)(
        needConsent.map((e) => ({ id: e.id, command: e.check })),
      );

    if (consentGranted) {
      newlyConsented = needConsent;
    } else {
      refused = needConsent;
    }
  }

  // Persist newly granted consent — the ledger records the approval decision
  // itself, independent of what the check's presence result turns out to be.
  for (const e of newlyConsented) {
    const rawSha = versionFor?.({ id: e.id, nature: e.nature, scope }).sha;
    const sha = rawSha === undefined || rawSha === '' ? undefined : rawSha;
    await recordConsent(env, {
      id: e.id,
      command: e.check,
      ...(sha === undefined ? {} : { sha }),
    });
  }

  const consentedEntries = [...alreadyConsented, ...newlyConsented];
  const checkedResults = await checkTools(consentedEntries, toolRunner);
  const unverifiedResults: ToolCheckResult[] = refused.map((e) => ({
    id: e.id,
    level: e.level,
    presence: 'unverified',
  }));
  const allToolResults = [...checkedResults, ...unverifiedResults];

  return {
    toolWarnings: {
      required: missingRequired(allToolResults).map((r) => r.id),
      recommended: missingRecommended(allToolResults).map((r) => r.id),
    },
    unverifiedIds: unverifiedTools(allToolResults).map((r) => r.id),
  };
}

interface BuildOutputOpts {
  planText: string;
  reason: 'applied' | 'aborted' | 'up-to-date' | 'adopted';
  toolWarnings: { required: string[]; recommended: string[] };
  /**
   * Ids of tool checks whose consent was declined — never executed, and
   * distinct from `toolWarnings` (which only ever holds VERIFIED-absent
   * tools). Rendered as "not verified", never conflated with "missing".
   */
  unverifiedIds: string[];
  /** Entries excluded from this transaction because of a `targets` mismatch (E-targets). */
  skipped: { id: string; targets: string[] }[];
  /** adapter.id — the assistant this transaction targeted, shown in the skipped line. */
  assistantId: string;
  written: string[];
  backedUp: string[];
  /**
   * Ids adopted this run (R5/D5): artifacts already present on disk but absent
   * from the manifest, recorded WITHOUT any config write (only state.json).
   * Rendered under the "adopted" result line. Absent on non-adoption runs.
   */
  adopted?: string[];
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
 *   <not verified tools — consent declined, never executed>
 */
function buildOutput(opts: BuildOutputOpts): string {
  const { planText, reason, toolWarnings, unverifiedIds, skipped, assistantId, written, backedUp } =
    opts;
  const adopted = opts.adopted ?? [];
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
  } else if (reason === 'adopted') {
    // R5/D5: the artifact was already conforming on disk; only state.json was
    // updated (no config write, no confirmation). Never conflated with a real
    // install (`applied`) nor with a plain up-to-date no-op.
    parts.push('  [ok] adopted (already present on disk) — state.json updated, no files written.');
    for (const id of adopted) {
      parts.push(`    = ${id}`);
    }
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
  const hasToolWarnings = toolWarnings.required.length > 0 || toolWarnings.recommended.length > 0
    || unverifiedIds.length > 0;

  if (hasToolWarnings) {
    parts.push('');
    parts.push('--- Tool Warnings ---');

    for (const id of toolWarnings.required) {
      parts.push(`  [missing required]    ${id}`);
    }

    for (const id of toolWarnings.recommended) {
      parts.push(`  [missing recommended] ${id}`);
    }

    for (const id of unverifiedIds) {
      parts.push(`  [not verified]        ${id}`);
    }
  }

  return parts.join('\n');
}
