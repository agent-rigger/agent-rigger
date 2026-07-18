/**
 * Gitleaks-backed Scanner implementation for @agent-rigger/core.
 *
 * Delegates to the `gitleaks` CLI on the host; never shells out in tests
 * (inject a mock ScanRunner via opts.run).
 *
 * Behaviour:
 *  - gitleaks exit 0 → no secrets found → Verdict { ok: true }
 *  - gitleaks exit 1 → secrets found    → Verdict { ok: false, findings: [...] }
 *  - gitleaks exit >1 → tool error      → Verdict { ok: false, findings: ['gitleaks error: <stderr>'] }
 *    (fail-closed: we do NOT pass on tool errors)
 */

import path from 'node:path';

import type { Scanner } from '../scan';
import type { Verdict } from '../types';

// ---------------------------------------------------------------------------
// ScanRunner — minimal local runner type (core must not depend on catalog)
// ---------------------------------------------------------------------------

/**
 * Minimal runner abstraction for the scanner.
 * Mirrors catalog's CommandRunner but is local to core to keep packages independent.
 */
export type ScanRunner = (
  command: string,
  args: string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

// ---------------------------------------------------------------------------
// defaultScanRunner — production Bun.spawn-based runner
// ---------------------------------------------------------------------------

/**
 * Default runner for production use.
 * Spawns `command` directly with the given args (no shell).
 * Exported so callers can swap it out without re-implementing.
 */
export const defaultScanRunner: ScanRunner = async (command, args) => {
  const proc = Bun.spawn([command, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
};

// ---------------------------------------------------------------------------
// WhichFn — portable PATH lookup (no shell spawn)
// ---------------------------------------------------------------------------

/**
 * Abstraction over `Bun.which` for injecting a test double.
 * Returns the resolved executable path, or null when not found.
 */
export type WhichFn = (cmd: string) => string | null;

/**
 * Production implementation: delegates to `Bun.which`, which reads PATH
 * directly without spawning a shell process — portable on Linux and macOS.
 */
export const defaultWhich: WhichFn = (cmd) => Bun.which(cmd);

// ---------------------------------------------------------------------------
// isGitleaksAvailable
// ---------------------------------------------------------------------------

/**
 * Returns true when `gitleaks` is found on PATH.
 *
 * Uses `WhichFn` (default: `Bun.which`) instead of `command -v` to avoid
 * spawning a shell builtin — `command` is not a standalone executable and
 * causes ENOENT on Linux when used with Bun.spawn directly.
 *
 * Inject a mock WhichFn in tests.
 */
export async function isGitleaksAvailable(which: WhichFn = defaultWhich): Promise<boolean> {
  return which('gitleaks') !== null;
}

// ---------------------------------------------------------------------------
// GitleaksOpts
// ---------------------------------------------------------------------------

export interface GitleaksOpts {
  run?: ScanRunner;
}

// ---------------------------------------------------------------------------
// Internal: parse gitleaks JSON output
// ---------------------------------------------------------------------------

interface GitleaksFinding {
  Description: string;
  File: string;
  RuleID: string;
}

/**
 * Parses gitleaks JSON report output into findings.
 *
 * Returns `null` when `JSON.parse` throws (malformed/truncated output) so the
 * caller can fail-closed on it. Empty/`'[]'`/non-array reports still map to
 * `[]` (the "no parseable findings" anomaly is handled by the caller).
 */
function parseFindings(stdout: string): GitleaksFinding[] | null {
  const trimmed = stdout.trim();
  if (trimmed === '' || trimmed === '[]') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return [];
  return parsed as GitleaksFinding[];
}

/**
 * gitleaks 8.30.1 reports `File` as an ABSOLUTE path for `detect --source <dir>`
 * (probe T1). Since `dir` is the union staging mirror — a byte-faithful copy of
 * the checkout layout — relativising the absolute File against it yields the
 * exact checkout-relative path the attribution must carry (`skills/x/SKILL.md`,
 * R7). A File already relative (older gitleaks, or a mock) is passed through
 * unchanged.
 */
function formatFinding(f: GitleaksFinding, dir: string): string {
  const file = path.isAbsolute(f.File) ? path.relative(dir, f.File) : f.File;
  return `${f.RuleID}: ${f.Description} (${file})`;
}

// ---------------------------------------------------------------------------
// createGitleaksScanner
// ---------------------------------------------------------------------------

/**
 * Creates a Scanner backed by the gitleaks CLI.
 *
 * @param opts.run - Optional runner override; defaults to defaultScanRunner.
 */
export function createGitleaksScanner(opts?: GitleaksOpts): Scanner {
  const run = opts?.run ?? defaultScanRunner;

  return {
    async scan(dir: string): Promise<Verdict> {
      const { exitCode, stdout, stderr } = await run('gitleaks', [
        'detect',
        '--source',
        dir,
        '--no-git',
        '--report-format',
        'json',
        '--report-path',
        '-',
      ]);

      if (exitCode === 0) {
        return { ok: true };
      }

      if (exitCode === 1) {
        const raw = parseFindings(stdout);
        if (raw === null) {
          // stdout could not be parsed as JSON at all (truncated/garbled report) →
          // fail-closed on the anomaly instead of rejecting the scan promise.
          return {
            ok: false,
            findings: ['gitleaks: exit 1 with unparseable output (unexpected — fail-closed)'],
          };
        }
        if (raw.length === 0) {
          // exit 1 signals findings by contract; an empty/unparseable report is
          // anomalous (broken report flag, partial parse) → fail-closed, not clean.
          return {
            ok: false,
            findings: ['gitleaks: exit 1 with no parseable findings (unexpected — fail-closed)'],
          };
        }
        return { ok: false, findings: raw.map((f) => formatFinding(f, dir)) };
      }

      // exit > 1: tool-level error — fail-closed
      return { ok: false, findings: [`gitleaks error: ${stderr}`] };
    },
  };
}
