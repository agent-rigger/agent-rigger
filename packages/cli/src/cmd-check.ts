/**
 * cmd-check — implementation of the `check` command.
 *
 * Responsibilities:
 * - Run the core audit (check/reportExitCode) against the provided adapter and entries.
 * - Catch InvalidJsonError and map it to exitCode 2 with an actionable message.
 * - Run advisory tool checks (checkTools) and render missing required/recommended tools.
 * - Compose the final output string from renderReport + tool advisory section.
 *
 * Constraints:
 * - No process.exit — the CLI bin (F5) calls process.exit(result.exitCode).
 * - No while loops.
 * - No import of process directly — exitCode is returned as a typed value.
 */

import type { Adapter, AdapterEntry } from '@agent-rigger/core/adapter';
import { check, reportExitCode } from '@agent-rigger/core/engine';
import { InvalidJsonError } from '@agent-rigger/core/fs-json';
import type { Env } from '@agent-rigger/core/paths';
import type { Report, Scope } from '@agent-rigger/core/types';

import type { CatalogEntry } from '@agent-rigger/catalog';
import { checkTools, missingRecommended, missingRequired } from '@agent-rigger/catalog/tool-check';
import type { CommandRunner, ToolCheckResult } from '@agent-rigger/catalog/tool-check';

import { renderReport } from './ui';

// ---------------------------------------------------------------------------
// CheckResult
// ---------------------------------------------------------------------------

/**
 * Result of a runCheck call.
 *
 * - exitCode  0 = all entries present
 *             2 = invalid JSON encountered (no report entries)
 *             3 = one or more entries missing or drifted
 * - report    Aggregated audit report (entries = [] when exitCode is 2).
 * - toolResults  Individual tool check outcomes (advisory; never affects exitCode).
 * - output    Human-readable string ready to print. Includes both the audit
 *             report and the tool advisory section.
 */
export interface CheckResult {
  exitCode: 0 | 2 | 3;
  report: Report;
  toolResults: ToolCheckResult[];
  output: string;
}

// ---------------------------------------------------------------------------
// runCheck options
// ---------------------------------------------------------------------------

export interface RunCheckOptions {
  /** Adapter to use for auditing (e.g. createClaudeAdapter(...)). */
  adapter: Adapter;
  /** Catalog entries to audit. */
  entries: AdapterEntry[];
  /** Installation scope. */
  scope: Scope;
  /** Injectable env for HOME resolution. */
  env: Env;
  /** Optional catalog entries for advisory tool checks. Defaults to []. */
  toolEntries?: CatalogEntry[];
  /** Optional CommandRunner for tool checks. Defaults to defaultRunner. */
  toolRunner?: CommandRunner;
  /** Working directory (unused in M0; reserved for future project-scope checks). */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// runCheck
// ---------------------------------------------------------------------------

/**
 * Execute the check command end-to-end and return a typed CheckResult.
 *
 * Step 1 — Audit: run check() via the engine.
 *   On InvalidJsonError: return exitCode 2 with an actionable message.
 *
 * Step 2 — Exit code: derive 0 or 3 from the report via reportExitCode().
 *
 * Step 3 — Advisory tools: run checkTools() against toolEntries.
 *   Missing tools are reported in the output but never affect exitCode.
 *
 * Step 4 — Compose output: renderReport(report) + tool advisory section.
 *
 * @param opts  Options controlling the adapter, entries, scope, env, and tools.
 * @returns     A CheckResult with exitCode, report, toolResults, and output.
 */
export async function runCheck(opts: RunCheckOptions): Promise<CheckResult> {
  const { adapter, entries, scope, env, toolEntries = [], toolRunner } = opts;

  // -------------------------------------------------------------------------
  // Step 1: Audit
  // -------------------------------------------------------------------------

  let report: Report;
  let exitCode: 0 | 2 | 3;

  try {
    report = await check(adapter, entries, scope, env);
    exitCode = reportExitCode(report);
  } catch (err) {
    if (err instanceof InvalidJsonError) {
      const output = buildInvalidJsonOutput(err);
      return { exitCode: 2, report: { entries: [] }, toolResults: [], output };
    }
    throw err;
  }

  // -------------------------------------------------------------------------
  // Step 2: Advisory tool checks
  // -------------------------------------------------------------------------

  const toolResults = await checkTools(toolEntries, toolRunner);

  // -------------------------------------------------------------------------
  // Step 3: Compose output
  // -------------------------------------------------------------------------

  const output = buildOutput(report, toolResults);

  return { exitCode, report, toolResults, output };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the actionable error message for an invalid JSON file.
 * Must mention the file path so the user knows what to fix.
 */
function buildInvalidJsonOutput(err: InvalidJsonError): string {
  const lines: string[] = [
    '[error] Invalid JSON detected — cannot run audit.',
    `  File: ${err.path}`,
    '  Fix the JSON syntax error in the file above and re-run check.',
  ];
  if (err.cause instanceof Error) {
    lines.push(`  Detail: ${err.cause.message}`);
  }
  return lines.join('\n');
}

/**
 * Compose the full output string from the audit report and tool advisory.
 *
 * Structure:
 *   <renderReport output>
 *
 *   --- Tools ---
 *   <tool advisory section>
 */
function buildOutput(report: Report, toolResults: ToolCheckResult[]): string {
  const parts: string[] = [];

  parts.push(renderReport(report));

  const toolSection = buildToolSection(toolResults);
  if (toolSection !== null) {
    parts.push('');
    parts.push('--- Tools ---');
    parts.push(toolSection);
  }

  return parts.join('\n');
}

/**
 * Build the tool advisory section.
 *
 * Returns null when toolResults is empty (no tool entries were provided).
 * Returns an "all tools present" line when every checked tool is present.
 * Otherwise lists missing required tools then missing recommended tools.
 */
function buildToolSection(toolResults: ToolCheckResult[]): string | null {
  if (toolResults.length === 0) {
    return null;
  }

  const required = missingRequired(toolResults);
  const recommended = missingRecommended(toolResults);

  if (required.length === 0 && recommended.length === 0) {
    return '  [tools ok] All tools present.';
  }

  const lines: string[] = [];

  for (const r of required) {
    lines.push(`  [missing required]  ${r.id}`);
  }

  for (const r of recommended) {
    lines.push(`  [missing recommended]  ${r.id}`);
  }

  return lines.join('\n');
}
