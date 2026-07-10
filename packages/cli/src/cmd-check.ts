/**
 * cmd-check — implementation of the `check` command.
 *
 * `check` is a read-only audit. It MUST NOT have any shell side effect —
 * it used to also run the catalog's advisory `tool` `check` commands
 * (checkTools against untrusted catalog-declared shell strings), which made
 * a read-only audit command execute arbitrary shell on every run. That
 * plumbing has been removed structurally: this module has no dependency on
 * checkTools/CommandRunner/CatalogEntry, and RunCheckOptions has no
 * toolEntries/toolRunner field, so it is structurally incapable of running a
 * shell command — not just "not currently passed one".
 *
 * Responsibilities:
 * - Run the core audit (check/reportExitCode) against the provided adapter and entries.
 * - Catch InvalidJsonError and map it to exitCode 2 with an actionable message.
 * - Compose the final output string from renderReport.
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
 * - output    Human-readable string ready to print (renderReport(report)).
 */
export interface CheckResult {
  exitCode: 0 | 2 | 3;
  report: Report;
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
  /** Working directory (unused in M0; reserved for future project-scope checks). */
  cwd?: string;
  /**
   * Absolute path to state.json (the manifest). When provided, each entry is
   * enriched with its `applied` payload so the adapter can audit against the
   * exact canonical state recorded at install time (B-iii).
   */
  manifestPath?: string;
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
 * Step 3 — Compose output: renderReport(report).
 *
 * @param opts  Options controlling the adapter, entries, scope, and env.
 * @returns     A CheckResult with exitCode, report, and output.
 */
export async function runCheck(opts: RunCheckOptions): Promise<CheckResult> {
  const { adapter, entries, scope, env, manifestPath } = opts;

  // -------------------------------------------------------------------------
  // Step 1: Audit
  // -------------------------------------------------------------------------

  let report: Report;
  let exitCode: 0 | 2 | 3;

  try {
    report = await check(adapter, entries, scope, env, manifestPath);
    exitCode = reportExitCode(report);
  } catch (err) {
    if (err instanceof InvalidJsonError) {
      const output = buildInvalidJsonOutput(err);
      return { exitCode: 2, report: { entries: [] }, output };
    }
    throw err;
  }

  // -------------------------------------------------------------------------
  // Step 2: Compose output
  // -------------------------------------------------------------------------

  const output = renderReport(report);

  return { exitCode, report, output };
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
