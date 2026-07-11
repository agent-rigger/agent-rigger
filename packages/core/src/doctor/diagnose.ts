/**
 * `diagnose()` — the read-only entry point of doctor (ADR-0025 §1).
 *
 * Composes the injected `Scanner[]` (core scanners: lock R6, manifest-audit
 * R2; adapter scanners: untracked R1, dangling R3, phantom R4, hygiene R7 —
 * T3) sequentially and aggregates their findings into a single
 * `DoctorReport`. Absolute read-only: `diagnose()` itself performs no I/O
 * beyond invoking the scanners it is handed — no write, no run-lock, no
 * spawn, no catalog execution. That invariant is only as strong as every
 * scanner composed into it; each scanner in this repo carries the same
 * contract in its own docstring (see `scanners/lock.ts`,
 * `scanners/manifest-audit.ts`).
 *
 * Two behaviours live here rather than in any single scanner, because both
 * are cross-scanner decisions read off the accumulated DATA, not off which
 * scanner produced it (the same "consent is data, not position" spirit as
 * `finding.ts`'s `RepairOp`):
 *
 * 1. **R8 manifest salvage.** `readManifest` fails closed
 *    (`MalformedManifestError`) on a present-but-wrong-shape `state.json`.
 *    Several scanners need the manifest (manifest-audit here; untracked/
 *    dangling/phantom in T3) and would each throw the SAME error
 *    independently. `diagnose()` catches it at the first scanner that
 *    throws, converts it into ONE `manifestMalformed` Finding (never a
 *    per-scanner duplicate), and stops — with the manifest unreadable,
 *    every other state scanner's result would be built on missing
 *    information, so nothing past this point is trustworthy. Findings
 *    already collected from scanners that ran BEFORE the failure (e.g. the
 *    lock scanner, which never reads the manifest) are kept.
 *
 * 2. **R6 "scan pendant un run vivant".** A `lock` Finding with
 *    `verdict: 'refused'` means the recorded pid is alive and either
 *    plausibly a rigger run or its identity could not be ruled out
 *    (EPERM) — ADR-0025 §7 requires abstaining from the rest of the state
 *    scan in that case (every other scanner's result would be transient
 *    against a run in flight). `diagnose()` stops as soon as it sees one.
 *
 * ORDERING CONTRACT: because both short-circuits act on findings already
 * collected and never re-run earlier scanners, `diagnose()` must run
 * `scanners` in the given array order (never `Promise.all`), and the
 * caller assembling `Scanner[]` (the CLI, T5) MUST place the lock scanner
 * FIRST — otherwise a state scanner could already have produced (transient)
 * findings before the live-run signal is even observed. This is a call-site
 * contract, not something the `DoctorScanner` type can express (the array
 * is opaque by design, ADR-0025 "Scanner[] composed").
 */

import { MalformedManifestError } from '../manifest';
import { manifestMalformed } from './finding';
import type { DoctorContext, DoctorReport, DoctorScanner, Finding } from './finding';

export async function diagnose(
  scanners: DoctorScanner[],
  ctx: DoctorContext,
): Promise<DoctorReport> {
  const findings: Finding[] = [];

  for (const scanner of scanners) {
    let result: Finding[];
    try {
      // Sequential by contract (see docstring) — never Promise.all.
      result = await scanner(ctx);
    } catch (err) {
      if (err instanceof MalformedManifestError) {
        findings.push(manifestMalformed({ reason: err.reason, path: err.path }));
        return { findings };
      }
      throw err;
    }

    findings.push(...result);

    if (result.some((finding) => finding.class === 'lock' && finding.verdict === 'refused')) {
      return { findings };
    }
  }

  return { findings };
}
