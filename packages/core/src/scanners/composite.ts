/**
 * Composite Scanner implementation for @agent-rigger/core.
 *
 * Detects which security tools are available on the host (gitleaks / trivy),
 * runs them in parallel, and aggregates verdicts.
 *
 * Policy (ADR-0018):
 *  - If neither tool is present → { ok: true, degraded: true }
 *    The install layer emits an actionable warning and proceeds (warn-only).
 *  - Each individual scanner's findings are prefixed with [gitleaks] or [trivy].
 *  - ok is true only when ALL running scanners return ok: true.
 */

import type { Scanner } from '../scan';
import type { Verdict } from '../types';
import type { ScanRunner, WhichFn } from './gitleaks';
import {
  createGitleaksScanner,
  defaultScanRunner,
  defaultWhich,
  isGitleaksAvailable,
} from './gitleaks';
import { createTrivyScanner, isTrivyAvailable } from './trivy';

// ---------------------------------------------------------------------------
// CompositeScannerOpts
// ---------------------------------------------------------------------------

export interface CompositeScannerOpts {
  /** Runner for actual scan commands (gitleaks detect / trivy fs). */
  run?: ScanRunner;
  /**
   * PATH-lookup function for tool presence detection.
   * Defaults to `Bun.which`-based `defaultWhich`.
   * Inject a mock in tests to avoid spawning any process.
   */
  which?: WhichFn;
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
  const which = opts?.which ?? defaultWhich;

  return {
    async scan(dir: string): Promise<Verdict> {
      const [gitleaksAvail, trivyAvail] = await Promise.all([
        isGitleaksAvailable(which),
        isTrivyAvailable(which),
      ]);

      if (!gitleaksAvail && !trivyAvail) {
        // ADR-0018: warn-only when no scanner is installed.
        // The install layer decides to block or warn; the scanner only signals the mode.
        return { ok: true, degraded: true };
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

      // Partial presence (ADR-0018 additive signal): exactly one of the two
      // tools is installed. Name the absent one so the install layer can warn
      // about it. Both-present and neither-present (handled above) never set this.
      const missingTools: ('gitleaks' | 'trivy')[] = [];
      if (!gitleaksAvail) missingTools.push('gitleaks');
      if (!trivyAvail) missingTools.push('trivy');
      const partialPresence = missingTools.length === 1;

      if (allOk) {
        return partialPresence ? { ok: true, missingTools } : { ok: true };
      }

      return partialPresence ? { ok: false, findings, missingTools } : { ok: false, findings };
    },
  };
}
