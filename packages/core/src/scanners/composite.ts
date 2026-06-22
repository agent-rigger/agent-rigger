/**
 * Composite Scanner implementation for @agent-rigger/core.
 *
 * Detects which security tools are available on the host (gitleaks / trivy),
 * runs them in parallel, and aggregates verdicts.
 *
 * Fail-closed policy:
 *  - If neither tool is present → { ok: false, findings: ['no security scanner available …'] }
 *  - Each individual scanner's findings are prefixed with [gitleaks] or [trivy].
 *  - ok is true only when ALL running scanners return ok: true.
 */

import type { Scanner } from '../scan';
import type { Verdict } from '../types';
import type { ScanRunner } from './gitleaks';
import { createGitleaksScanner, defaultScanRunner, isGitleaksAvailable } from './gitleaks';
import { createTrivyScanner, isTrivyAvailable } from './trivy';

// ---------------------------------------------------------------------------
// CompositeScannerOpts
// ---------------------------------------------------------------------------

export interface CompositeScannerOpts {
  run?: ScanRunner;
}

// ---------------------------------------------------------------------------
// Internal: prefix all findings from one scanner result
// ---------------------------------------------------------------------------

function prefixFindings(prefix: string, verdict: Verdict): string[] {
  return (verdict.findings ?? []).map((f) => `[${prefix}] ${f}`);
}

// ---------------------------------------------------------------------------
// createCompositeScanner
// ---------------------------------------------------------------------------

/**
 * Creates a composite Scanner that delegates to gitleaks and/or trivy,
 * depending on which tools are installed on the host.
 *
 * @param opts.run - Optional runner override (defaults to defaultScanRunner).
 */
export function createCompositeScanner(opts?: CompositeScannerOpts): Scanner {
  const run = opts?.run ?? defaultScanRunner;

  return {
    async scan(dir: string): Promise<Verdict> {
      const [gitleaksAvail, trivyAvail] = await Promise.all([
        isGitleaksAvailable(run),
        isTrivyAvailable(run),
      ]);

      if (!gitleaksAvail && !trivyAvail) {
        return {
          ok: false,
          findings: [
            'no security scanner available — install gitleaks or trivy to scan remote content',
          ],
        };
      }

      const tasks: Promise<{ prefix: string; verdict: Verdict }>[] = [];

      if (gitleaksAvail) {
        tasks.push(
          createGitleaksScanner({ run })
            .scan(dir)
            .then((verdict) => ({ prefix: 'gitleaks', verdict })),
        );
      }

      if (trivyAvail) {
        tasks.push(
          createTrivyScanner({ run })
            .scan(dir)
            .then((verdict) => ({ prefix: 'trivy', verdict })),
        );
      }

      const results = await Promise.all(tasks);

      const allOk = results.every(({ verdict }) => verdict.ok);
      const findings = results.flatMap(({ prefix, verdict }) => prefixFindings(prefix, verdict));

      if (allOk) {
        return { ok: true };
      }

      return { ok: false, findings };
    },
  };
}
