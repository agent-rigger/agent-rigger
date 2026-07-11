/**
 * doctor-consent — the consent-driver (R8, ADR-0025 §2).
 *
 * It READS `op.consent` and decides, per repairable finding, whether that
 * finding's `RepairOp` may run under `--fix`. It NEVER decides the policy
 * (which acts are safe vs item-confirm is graved into the `RepairOp` variant
 * at T1) — it only APPLIES that policy against the two runtime signals it is
 * handed: whether `--yes` was passed, and whether stdin is an interactive TTY.
 *
 * The rules (design.md flowchart "consent-driver (CLI) — LIT op.consent") :
 *   - `safe`         → granted when `--yes`, or when a TTY and the user
 *                      confirms the per-item prompt. Never a hang, never an
 *                      auto-destructive act (safe ops never destroy).
 *   - `item-confirm` → `--yes` is NEVER sufficient (ADR-0025: "destructif
 *                      jamais sous --yes global"). Prompted per item in a TTY;
 *                      SKIPPED + reported in non-TTY. Never prompted under
 *                      `--yes` alone — that would silently auto-destroy.
 *   - report-only    → no `repair` field → nothing to consent to (skipped by
 *                      construction, isReportOnly).
 *
 * The non-TTY-without-`--yes` case never reaches here: the CLI's `--fix` gate
 * (mirroring the lot5 stdin gate) exits 2 before any repair work. So in
 * non-TTY this driver only ever sees `--yes === true`, and it prompts NOTHING
 * (safe → auto-granted, item-confirm → skipped) — the "jamais de hang" bound.
 *
 * `break-lock` is routed OUT of the granted state ops: its subject IS the
 * run-lock, so the CLI must break it PRE-acquire (ADR-0025 §7 "2 temps"),
 * never under a held lock. The driver surfaces the consented break separately,
 * carrying the observed `{pid, startedAt}` from the finding's evidence so
 * `breakLockCas` can compare-and-swap against the exact record `diagnose` saw.
 */

import type {
  Finding,
  FindingLockCrashProbable,
  FindingLockPidRecycledProbable,
  RepairOp,
} from '@agent-rigger/core';
import { isReportOnly } from '@agent-rigger/core';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Runtime consent signals + the injectable per-item prompt (TTY only). */
export interface ConsentDriverDeps {
  /** Whether `--yes` was passed — auto-grants `safe`, never `item-confirm`. */
  yes: boolean;
  /** Whether stdin is an interactive TTY — the only place a per-item prompt is possible. */
  isTTY: boolean;
  /**
   * Per-item confirmation prompt, called ONLY in a TTY (never in non-TTY, so
   * the driver can never hang). Returns `true` to grant, `false` to decline.
   * Injected by the CLI (clack confirm), a fake in tests.
   */
  confirmItem: (message: string) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/** The observed lock identity a consented break must compare-and-swap against. */
export interface ConsentedBreakLock {
  lockPath: string;
  observed: { pid: number; startedAt: string | undefined };
}

/** A repair op the driver did NOT grant, with a human-readable reason (report, exit 3). */
export interface SkippedConsent {
  op: RepairOp;
  reason: string;
}

/** The consent-driver's verdict over one `DoctorReport`. */
export interface ConsentGrant {
  /**
   * State-repair ops the CLI passes to `applyRepairs` under the HELD run-lock.
   * NEVER contains a `break-lock` op (routed to `breakLock` below).
   */
  stateOps: RepairOp[];
  /**
   * The single consented lock break, handled PRE-acquire (2 temps). Present
   * only when a `break-lock` finding's op was consented. At most one — there
   * is a single run-lock.
   */
  breakLock?: ConsentedBreakLock;
  /** Repairable ops that were NOT granted (item-confirm in non-TTY, or declined). */
  skipped: SkippedConsent[];
}

// ---------------------------------------------------------------------------
// driveConsent
// ---------------------------------------------------------------------------

/**
 * Build the per-item prompt message from the finding. The summary already
 * states WHAT is wrong and the proposed act; the prompt only adds the verb.
 */
function promptFor(finding: Finding, op: RepairOp): string {
  const verb = op.consent === 'safe' ? 'Apply' : 'Confirm';
  return `${verb} repair?  ${finding.summary}`;
}

/**
 * Extract the observed lock identity a `break-lock` op must CAS against — read
 * from the finding's `LockEvidence` (pid + startedAt), never from the op
 * (which carries only the path). Only the two lock findings that carry a
 * `break-lock` repair reach here.
 */
function observedFromLockFinding(finding: Finding): { pid: number; startedAt: string | undefined } {
  const lock = finding as FindingLockCrashProbable | FindingLockPidRecycledProbable;
  return { pid: lock.evidence.pid, startedAt: lock.evidence.startedAt };
}

/**
 * Decide, per repairable finding, which `RepairOp`s are consented. Pure w.r.t.
 * policy (reads `op.consent`, never re-derives it); the only side effects are
 * the injected TTY prompts, and those happen ONLY in a TTY.
 */
export async function driveConsent(
  findings: Finding[],
  deps: ConsentDriverDeps,
): Promise<ConsentGrant> {
  const stateOps: RepairOp[] = [];
  const skipped: SkippedConsent[] = [];
  let breakLock: ConsentedBreakLock | undefined;

  for (const finding of findings) {
    if (isReportOnly(finding)) continue; // no repair → nothing to consent to
    // isReportOnly is a structural `'repair' in finding` check; narrow it.
    const op = (finding as Extract<Finding, { repair: RepairOp }>).repair;

    let granted: boolean;
    if (op.consent === 'safe') {
      // safe: `--yes` auto-grants; otherwise a TTY prompt; non-TTY-without-yes
      // never reaches here (CLI gate), so `false` is unreachable-but-safe.
      granted = deps.yes
        ? true
        : deps.isTTY
        ? await deps.confirmItem(promptFor(finding, op))
        : false;
    } else {
      // item-confirm: `--yes` is NEVER enough. Prompt in a TTY; skip in non-TTY.
      if (!deps.isTTY) {
        skipped.push({
          op,
          reason: 'needs per-item confirmation (never granted by --yes alone) — '
            + 'skipped in non-interactive mode.',
        });
        continue;
      }
      granted = await deps.confirmItem(promptFor(finding, op));
    }

    if (!granted) {
      skipped.push({ op, reason: 'not confirmed by the user.' });
      continue;
    }

    if (op.kind === 'break-lock') {
      // Routed pre-acquire (2 temps). At most one — a single run-lock exists.
      breakLock = { lockPath: op.lockPath, observed: observedFromLockFinding(finding) };
      continue;
    }

    stateOps.push(op);
  }

  return breakLock === undefined ? { stateOps, skipped } : { stateOps, breakLock, skipped };
}
