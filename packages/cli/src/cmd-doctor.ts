/**
 * cmd-doctor — implementation of the `doctor` command.
 *
 * Lists external dependencies with their availability status so the user knows
 * whether agent-rigger operates in "full scan" or "warn-only" mode before
 * installing (see ADR-0018).
 *
 * Deps checked:
 *   gitleaks — secret scanner (optional, full scan when present)
 *   trivy    — vulnerability scanner (optional, full scan when present)
 *   glab     — GitLab auth CLI (recommended, ADR-0006)
 *   git      — version control (required for most workflows)
 *
 * Constraints:
 *   - No process.exit.
 *   - No while loops.
 *   - All I/O injectable via opts for test isolation.
 */

import { defaultWhich, type WhichFn } from '@agent-rigger/core';

import { ANSI, paint, shouldColor } from './ui';

// ---------------------------------------------------------------------------
// DoctorDep — descriptor for each checked dependency
// ---------------------------------------------------------------------------

interface DoctorDep {
  /** Binary name passed to which(). */
  name: string;
  /** Short install hint shown when binary is absent. */
  installHint: string;
}

const DOCTOR_DEPS: DoctorDep[] = [
  {
    name: 'git',
    installHint: 'install git: https://git-scm.com/downloads',
  },
  {
    name: 'glab',
    installHint: 'install glab: https://gitlab.com/gitlab-org/cli#installation',
  },
  {
    name: 'gitleaks',
    installHint: 'install gitleaks: https://github.com/gitleaks/gitleaks#install',
  },
  {
    name: 'trivy',
    installHint:
      'install trivy: https://aquasecurity.github.io/trivy/latest/getting-started/installation/',
  },
];

// ---------------------------------------------------------------------------
// RunDoctorOpts
// ---------------------------------------------------------------------------

export interface RunDoctorOpts {
  /**
   * Injectable PATH lookup function.
   * Defaults to Bun.which — inject a mock in tests.
   */
  which?: WhichFn;
  /** Output sink. */
  print: (s: string) => void;
  /**
   * Enable ANSI colour codes.
   * Defaults to TTY auto-detection (see {@link shouldColor}).
   * Pass `false` in tests for deterministic plain-text output.
   */
  color?: boolean;
}

// ---------------------------------------------------------------------------
// runDoctor
// ---------------------------------------------------------------------------

/**
 * Execute the doctor command end-to-end.
 *
 * For each dependency:
 *   present → "✓ <name> (<path>)"
 *   absent  → "✗ <name> — missing  hint: <installHint>"
 *
 * Mode line (printed after the dep list):
 *   gitleaks OR trivy present → "mode : full scan"
 *   neither present           → "mode : warn-only (external content not scanned — install gitleaks or trivy)"
 */
export async function runDoctor(opts: RunDoctorOpts): Promise<void> {
  const which = opts.which ?? defaultWhich;
  const { print } = opts;
  const colorOn = shouldColor(opts.color);

  print(paint('--- agent-rigger doctor ---', ANSI.bold, colorOn));
  print('');

  let gitleaksPresent = false;
  let trivyPresent = false;

  for (const dep of DOCTOR_DEPS) {
    const resolved = which(dep.name);
    if (resolved === null) {
      // Paint "✗ <name>" as one unit (red) and the hint dim — keeps the
      // "✗ <name>" substring contiguous for assertions.
      print(
        `${paint(`✗ ${dep.name}`, ANSI.red, colorOn)} — missing  `
          + paint(`hint: ${dep.installHint}`, ANSI.dim, colorOn),
      );
    } else {
      print(
        `${paint(`✓ ${dep.name}`, ANSI.green, colorOn)} ${
          paint(`(${resolved})`, ANSI.dim, colorOn)
        }`,
      );
      if (dep.name === 'gitleaks') gitleaksPresent = true;
      if (dep.name === 'trivy') trivyPresent = true;
    }
  }

  print('');

  if (gitleaksPresent || trivyPresent) {
    print(paint('mode : full scan', ANSI.green, colorOn));
  } else {
    print(
      paint(
        'mode : warn-only (external content not scanned — install gitleaks or trivy)',
        ANSI.yellow,
        colorOn,
      ),
    );
  }
}
