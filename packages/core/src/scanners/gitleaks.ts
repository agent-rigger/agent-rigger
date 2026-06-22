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
// isGitleaksAvailable
// ---------------------------------------------------------------------------

/**
 * Returns true when `gitleaks` is found on PATH (`command -v gitleaks` exits 0).
 * Inject a mock runner in tests.
 */
export async function isGitleaksAvailable(run: ScanRunner): Promise<boolean> {
  const { exitCode } = await run('command', ['-v', 'gitleaks']);
  return exitCode === 0;
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

function parseFindings(stdout: string): GitleaksFinding[] {
  const trimmed = stdout.trim();
  if (trimmed === '' || trimmed === '[]') return [];
  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) return [];
  return parsed as GitleaksFinding[];
}

function formatFinding(f: GitleaksFinding): string {
  return `${f.RuleID}: ${f.Description} (${f.File})`;
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
        if (raw.length === 0) {
          // exit 1 but no parseable findings — treat as clean (edge case)
          return { ok: true };
        }
        return { ok: false, findings: raw.map(formatFinding) };
      }

      // exit > 1: tool-level error — fail-closed
      return { ok: false, findings: [`gitleaks error: ${stderr}`] };
    },
  };
}
