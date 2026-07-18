/**
 * Trivy-backed Scanner implementation for @agent-rigger/core.
 *
 * Delegates to the `trivy` CLI on the host; never shells out in tests
 * (inject a mock ScanRunner via opts.run).
 *
 * Behaviour:
 *  - trivy exit 0 → tool ran → parse JSON stdout for secrets / blocking misconfigs
 *  - trivy exit != 0 → tool error → fail-closed { ok: false, findings: ['trivy error: <stderr>'] }
 *
 * Blocking conditions:
 *  - ANY secret found in Results[].Secrets
 *  - Misconfigurations with Severity ∈ {HIGH, CRITICAL} AND Status === 'FAIL'
 *
 * JSON tolerance:
 *  - empty stdout / { Results: [] } → { ok: true }
 *  - unparseable JSON on exit 0 → fail-closed { ok: false, findings: ['trivy: unparseable output'] }
 */

import path from 'node:path';

import type { Scanner } from '../scan';
import type { Verdict } from '../types';
import { defaultScanRunner, defaultWhich } from './gitleaks';
import type { ScanRunner, WhichFn } from './gitleaks';

// ---------------------------------------------------------------------------
// isTrivyAvailable
// ---------------------------------------------------------------------------

/**
 * Returns true when `trivy` is found on PATH.
 *
 * Uses `WhichFn` (default: `Bun.which`) instead of `command -v` to avoid
 * spawning a shell builtin — portable on Linux and macOS.
 *
 * Inject a mock WhichFn in tests.
 */
export async function isTrivyAvailable(which: WhichFn = defaultWhich): Promise<boolean> {
  return which('trivy') !== null;
}

// ---------------------------------------------------------------------------
// TrivyOpts
// ---------------------------------------------------------------------------

export interface TrivyOpts {
  run?: ScanRunner;
}

// ---------------------------------------------------------------------------
// Internal trivy JSON shape
// ---------------------------------------------------------------------------

type BlockingSeverity = 'HIGH' | 'CRITICAL';

const BLOCKING_SEVERITIES = new Set<string>(['HIGH', 'CRITICAL']);

interface TrivySecret {
  RuleID: string;
  Title: string;
  Severity: string;
}

interface TrivyMisconfig {
  ID: string;
  Title: string;
  Severity: string;
  Status: string;
}

interface TrivyResult {
  Target: string;
  Secrets?: TrivySecret[];
  Misconfigurations?: TrivyMisconfig[];
}

interface TrivyReport {
  Results?: TrivyResult[];
}

// ---------------------------------------------------------------------------
// Internal: parse trivy JSON output
// ---------------------------------------------------------------------------

function parseTrivyReport(stdout: string): TrivyReport | null {
  const trimmed = stdout.trim();
  if (trimmed === '') return { Results: [] };
  try {
    return JSON.parse(trimmed) as TrivyReport;
  } catch {
    return null;
  }
}

function collectFindings(results: TrivyResult[], dir: string): string[] {
  const findings: string[] = [];

  for (const result of results) {
    // Defensive R7 rebase: trivy 0.72.0 already emits a relative Target (probe
    // T1), so the isAbsolute guard is a no-op today; it hardens attribution
    // against a version drift that would start reporting an absolute path under
    // the scanned staging dir — relativising it keeps the finding checkout-
    // relative like gitleaks.
    const target = path.isAbsolute(result.Target)
      ? path.relative(dir, result.Target)
      : result.Target;

    for (const secret of result.Secrets ?? []) {
      findings.push(`${secret.RuleID}: ${secret.Title} (${target})`);
    }

    for (const mc of result.Misconfigurations ?? []) {
      if (BLOCKING_SEVERITIES.has(mc.Severity) && mc.Status === 'FAIL') {
        findings.push(`${mc.ID} [${mc.Severity as BlockingSeverity}]: ${mc.Title} (${target})`);
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// createTrivyScanner
// ---------------------------------------------------------------------------

/**
 * Creates a Scanner backed by the trivy CLI.
 *
 * @param opts.run - Optional runner override; defaults to defaultScanRunner.
 */
export function createTrivyScanner(opts?: TrivyOpts): Scanner {
  const run = opts?.run ?? defaultScanRunner;

  return {
    async scan(dir: string): Promise<Verdict> {
      const { exitCode, stdout, stderr } = await run('trivy', [
        'fs',
        '--format',
        'json',
        '--scanners',
        'secret,misconfig',
        dir,
      ]);

      if (exitCode !== 0) {
        return { ok: false, findings: [`trivy error: ${stderr}`] };
      }

      const report = parseTrivyReport(stdout);

      if (report === null) {
        return { ok: false, findings: ['trivy: unparseable output'] };
      }

      const findings = collectFindings(report.Results ?? [], dir);

      if (findings.length === 0) {
        return { ok: true };
      }

      return { ok: false, findings };
    },
  };
}
