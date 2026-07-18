/**
 * cmd-doctor — implementation of the `doctor` command (ADR-0025).
 *
 * TWO phases, in order (R8 "phase env-deps inchangée + phase état-installé"):
 *
 *  1. env-deps (runDoctor, UNCHANGED): lists external dependencies with their
 *     availability status so the user knows whether agent-rigger operates in
 *     "full scan" or "warn-only" mode before installing (see ADR-0018).
 *  2. installed-state (runDoctorState, NEW): assembles the `DoctorScanner[]`
 *     (core scanners + path-aware adapter scanners), runs `diagnose`
 *     (read-only), renders the findings grouped by class, and — under `--fix`
 *     — drives consent and applies the repairs (2-temps lock break pre-acquire,
 *     then a fresh run-lock, then `applyRepairs`).
 *
 * Deps checked (phase 1):
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

import {
  applyRepairs,
  type ApplyRepairsDeps,
  type Assistant,
  createLockScanner,
  defaultIdentify,
  defaultWhich,
  diagnose,
  type DoctorContext,
  type DoctorScanner,
  type Finding,
  isReportOnly,
  manifestAuditScanner,
  type RepairOp,
  type RepairOutcome,
  type WhichFn,
} from '@agent-rigger/core';
import type { Adapter } from '@agent-rigger/core/adapter';
import { readManifest } from '@agent-rigger/core/manifest';
import type { Env } from '@agent-rigger/core/paths';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import {
  acquireRunLock,
  breakLockCas,
  type BreakLockResult,
  ConcurrentRunError,
  type RunLock,
} from '@agent-rigger/core/run-lock';

import { type CatalogCanon, localId, qualifyRef } from '@agent-rigger/catalog';

import {
  createAppliedDriftScanner,
  createDanglingScanner,
  createHostDiffScanner,
  createHygieneScanner,
  createPhantomScanner,
  createUntrackedScanner,
  storeReferenceCandidates,
} from '@agent-rigger/adapters';

import { buildAdapter } from './adapter-dispatch';
import { CLI_COMMAND } from './cli';
import { driveConsent } from './doctor-consent';
import {
  ANSI,
  chooseAdoptionCatalog as defaultChooseAdoptionCatalog,
  confirmDoctorRepair,
  paint,
  renderDoctorReport,
  renderRepairOutcomes,
  shouldColor,
} from './ui';

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

  print(paint(`--- ${CLI_COMMAND} doctor ---`, ANSI.bold, colorOn));
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

// ---------------------------------------------------------------------------
// Phase 2 — installed-state diagnosis and consented repair (R8, ADR-0025)
// ---------------------------------------------------------------------------

/** The assistants whose on-disk conventions doctor scans (R1 "les deux assistants"). */
const SCANNED_ASSISTANTS: Assistant[] = ['claude', 'opencode'];

/**
 * Prompt an ambiguous adoption's owning catalog (D5). Given the unqualified
 * candidate and the names of the catalogs that all offer it, returns the chosen
 * name. Same injection family as `confirmItem`: a clack `select` by default, a
 * fake in tests — and, like `confirmItem`, only ever invoked in a TTY.
 */
type ChooseAdoptionCatalog = (candidateId: string, catalogNames: string[]) => Promise<string>;

export interface RunDoctorStateOpts {
  /** Injectable environment for path resolution. */
  env: Env;
  /** Output sink. */
  print: (s: string) => void;
  /** `--fix` requested: diagnose AND repair (consent-driven). */
  fix: boolean;
  /** `--yes` requested: auto-grants `safe` ops (never `item-confirm`). */
  yes: boolean;
  /** Whether stdin is an interactive TTY — the per-item consent surface. */
  isTTY: boolean;
  /**
   * Catalog ids currently configured (R2 orphan-catalog prefix check, R5 id
   * requalification). Passed in by the CLI (which owns config loading), so this
   * module never duplicates the config plumbing.
   */
  configuredCatalogIds: string[];
  /**
   * The differential canon of every configured catalog, fetched by the CLI
   * under `--remote` (D1). When present, the host-diff scanners (D2+D3) are
   * assembled per assistant. Absent (undefined) means no `--remote` — the run
   * stays byte-identical to v1 (no host-diff, no network access).
   */
  catalogCanons?: CatalogCanon[];
  /** Enable ANSI colour. Defaults to TTY auto-detection; pass false in tests. */
  color?: boolean;

  // --- injectable seams (default to the real assembly / primitives) --------
  /**
   * Override the assembled `DoctorScanner[]` (tests). The lock scanner MUST be
   * first (diagnose ordering contract) when overriding.
   */
  scanners?: DoctorScanner[];
  /** Adapters per assistant for `adopt` (tests inject fakes; built otherwise). */
  adapters?: Map<Assistant, Adapter>;
  /** Per-item confirmation prompt (TTY only). Defaults to a clack confirm. */
  confirmItem?: (message: string) => Promise<boolean>;
  /**
   * Catalog-choice prompt for an ambiguous adoption (D5, TTY only). Reached only
   * under `--remote` (`catalogCanons` present) when a candidate's nature+name is
   * offered by more than one catalog. Defaults to a clack select; a fake in
   * tests. Never invoked in a non-TTY session (the resolver returns `ambiguous`
   * there — skip + report).
   */
  chooseAdoptionCatalog?: ChooseAdoptionCatalog;
  /** Acquire the fresh state-repair run-lock. Defaults to `acquireRunLock`. */
  acquireLock?: (manifestPath: string) => Promise<RunLock>;
  /** Break a lock pre-acquire (2 temps). Defaults to `breakLockCas`. */
  breakLock?: (
    lockPath: string,
    observed: { pid: number; startedAt: string | undefined },
  ) => Promise<BreakLockResult>;
  /**
   * Process-identity re-check for a consented "pid recyclé" lock break (R6):
   * the default breaker passes this to `breakLockCas`'s `identify` option so
   * an alive-but-confirmed-foreign pid does not refuse the break (without
   * it, `break-lock` on a pid-recycled finding would always refuse
   * `pid-alive` — dead code). Defaults to the real `/proc`-comm probe; tests
   * inject a fake to avoid depending on the process table while still
   * exercising the REAL `breakLockCas` (not a fully-mocked `breakLock`).
   * Ignored when `breakLock` is overridden.
   */
  identify?: (pid: number) => Promise<'rigger' | 'foreign' | 'unknown'>;
  /** Injectable clock for the residue age re-check (applyRepairs / hygiene). */
  now?: () => number;
}

/** Resolve the manifest (state.json) path — re-derived to keep this module cli-free. */
function manifestPathFor(env: Env): string {
  return resolveUserTargets(env).stateJson;
}

/** The catalog knowledge `resolveAdoptionId` requalifies a candidate against. */
interface AdoptionResolverCtx {
  /** Configured catalog ids — the v1 prefix check for an already-qualified id. */
  configuredCatalogIds: string[];
  /**
   * The fetched catalog canons (D5, `--remote`). Absent (undefined/empty) keeps
   * the v1 posture: an unqualified candidate resolves `none` (adopt under
   * defaults). Present: an unqualified candidate is searched by content.
   */
  canons?: CatalogCanon[];
  /** Whether stdin is a TTY — gates the ambiguity prompt vs `ambiguous`. */
  isTTY: boolean;
  /** The catalog-choice prompt (TTY only) — see {@link ChooseAdoptionCatalog}. */
  chooseCatalog: ChooseAdoptionCatalog;
}

/**
 * Requalify an adopt op's `candidateId` against the configured catalogs.
 *
 * An ALREADY-QUALIFIED id (`<prefix>/…`) resolves by prefix, exactly as v1: a
 * configured prefix → `unique`, otherwise → `none` (adopt under defaults,
 * `v0.0.0`/empty sha, surfaced by R2's missing-sha audit next run).
 *
 * An UNQUALIFIED candidate (the scanner's `<nature>:<name>` id) depends on
 * whether catalog content is available (D5):
 *   - no canons (`doctor` without `--remote`) → `none`, byte-identical to v1:
 *     the `ambiguous` branch was "unreachable here by design" precisely because
 *     it needs catalog content.
 *   - with canons: search each canon's entries for the same nature+name.
 *     0 matches → `none`; 1 match → `unique` under that catalog's qualified id;
 *     >1 match → in a TTY, prompt for the owning catalog and resolve `unique`
 *     under the chosen id; in a non-TTY, `ambiguous` — the interpreter skips +
 *     reports (never guess: adopting under the wrong id would arm update/remove
 *     on the wrong canonical, R5 "requalification ambiguë").
 */
async function resolveAdoptionId(
  candidateId: string,
  ctx: AdoptionResolverCtx,
): Promise<{ kind: 'unique'; id: string } | { kind: 'ambiguous' } | { kind: 'none' }> {
  const slash = candidateId.indexOf('/');
  if (slash !== -1) {
    const prefix = candidateId.slice(0, slash);
    return ctx.configuredCatalogIds.includes(prefix)
      ? { kind: 'unique', id: candidateId }
      : { kind: 'none' };
  }

  // Unqualified. Without catalog content, keep the v1 defaults posture.
  const canons = ctx.canons;
  if (canons === undefined || canons.length === 0) return { kind: 'none' };

  // With content: the catalogs whose entries offer this exact nature+name. Canon
  // entry ids are raw/unqualified, so `localId` is the nature+name to compare.
  const offeringNames = canons
    .filter((canon) =>
      canon.entries.some((entry) => entry.kind === 'artifact' && localId(entry.id) === candidateId)
    )
    .map((canon) => canon.name);

  const [first, ...rest] = offeringNames;
  if (first === undefined) return { kind: 'none' };
  if (rest.length === 0) return { kind: 'unique', id: qualifyRef(first, candidateId) };

  // Two or more catalogs offer it: prompt in a TTY, else ambiguous (skip+report).
  if (!ctx.isTTY) return { kind: 'ambiguous' };
  const chosen = await ctx.chooseCatalog(candidateId, offeringNames);
  return { kind: 'unique', id: qualifyRef(chosen, candidateId) };
}

/**
 * Fresh enumeration of a store's reference-candidate target paths at ACT time
 * (R4 TOCTOU): re-reads the manifest so a referent that appeared since
 * diagnosis is included, then widens `storeReferenceCandidates` with every
 * entry's `files[]` (R4 "candidats élargis").
 */
async function enumerateStoreReferents(
  store: string,
  env: Env,
  manifestPath: string,
): Promise<string[]> {
  const manifest = await readManifest(manifestPath);
  const files = manifest.artifacts.flatMap((entry) => entry.files);
  return storeReferenceCandidates(store, env, process.cwd(), files);
}

/**
 * Apply the consented state ops under the HELD lock. `adopt` uses the adapter
 * of its OWN assistant (findings carry it), so ops are partitioned by assistant
 * and `applyRepairs` is called once per assistant — all under the same held
 * lock. Non-adopt ops are assistant-agnostic and ride with the default
 * (`claude`) adapter. Sequential by construction (each `applyRepairs` re-reads
 * the manifest at its first adopt), so the writes compose without lost updates.
 *
 * ONE `stateBackupGuard` is created here and shared across every per-assistant
 * `applyRepairs` call (Low2 fix): without it, each call's own `firstStateWrite`
 * guard would fire independently, producing one `state.json.bak-*` per
 * assistant touched instead of one for the whole `--fix` run.
 */
async function runStateRepairs(
  stateOps: RepairOp[],
  adapters: Map<Assistant, Adapter>,
  lock: RunLock,
  cfg: {
    env: Env;
    manifestPath: string;
    configuredCatalogIds: string[];
    canons?: CatalogCanon[];
    isTTY: boolean;
    chooseCatalog: ChooseAdoptionCatalog;
    now?: () => number;
  },
): Promise<RepairOutcome[]> {
  const byAssistant = new Map<Assistant, RepairOp[]>();
  for (const op of stateOps) {
    const assistant: Assistant = op.kind === 'adopt' ? op.assistant : 'claude';
    const bucket = byAssistant.get(assistant) ?? [];
    bucket.push(op);
    byAssistant.set(assistant, bucket);
  }

  const stateBackupGuard = { backedUp: false };

  const outcomes: RepairOutcome[] = [];
  for (const [assistant, ops] of byAssistant) {
    const adapter = adapters.get(assistant) ?? adapters.get('claude');
    if (adapter === undefined) {
      for (const op of ops) {
        outcomes.push({
          status: 'skipped',
          op,
          reason: `no adapter available for "${assistant}".`,
        });
      }
      continue;
    }
    const deps: ApplyRepairsDeps = {
      env: cfg.env,
      manifestPath: cfg.manifestPath,
      resolveAdoptionId: (candidateId) =>
        resolveAdoptionId(candidateId, {
          configuredCatalogIds: cfg.configuredCatalogIds,
          ...(cfg.canons === undefined ? {} : { canons: cfg.canons }),
          isTTY: cfg.isTTY,
          chooseCatalog: cfg.chooseCatalog,
        }),
      enumerateStoreReferents: (store) => enumerateStoreReferents(store, cfg.env, cfg.manifestPath),
      stateBackupGuard,
      ...(cfg.now === undefined ? {} : { now: cfg.now }),
    };
    outcomes.push(...(await applyRepairs(ops, adapter, lock, deps)));
  }
  return outcomes;
}

/**
 * Assemble the real `DoctorScanner[]` — lock FIRST (diagnose ordering contract).
 *
 * `canons` (D1, `--remote`) adds one host-diff scanner per scanned assistant,
 * grouped right after untracked (same "untracked" class — untracked host-diff
 * D2 + divergent mcp D3). When `canons` is undefined (no `--remote`), no
 * host-diff scanner exists in the run and the pipeline is byte-identical to v1.
 */
function assembleScanners(
  adapters: Map<Assistant, Adapter>,
  now: (() => number) | undefined,
  canons?: CatalogCanon[],
): DoctorScanner[] {
  const scanned = SCANNED_ASSISTANTS.filter((assistant) => adapters.has(assistant));
  const appliedDrift = scanned
    .map((assistant) => createAppliedDriftScanner(adapters.get(assistant) as Adapter, assistant));
  const untracked = scanned
    .map((assistant) => createUntrackedScanner(adapters.get(assistant) as Adapter, assistant));
  const hostDiff = canons === undefined
    ? []
    : scanned
      .map((assistant) =>
        createHostDiffScanner(adapters.get(assistant) as Adapter, assistant, canons)
      );

  return [
    createLockScanner(),
    manifestAuditScanner,
    ...appliedDrift,
    ...untracked,
    ...hostDiff,
    createDanglingScanner(),
    createPhantomScanner(),
    createHygieneScanner(now === undefined ? {} : { now }),
  ];
}

/**
 * Print the R8 salvage guidance for a malformed `state.json`: the shape
 * violation verbatim + the new way out. The old "delete the file to start
 * fresh" advice DELIBERATELY does not appear — doctor backs the file up and
 * asks the user to fix the shape by hand (ADR-0025 "Conséquences").
 */
function printMalformedGuidance(
  print: (s: string) => void,
  findings: Finding[],
  colorOn: boolean,
): void {
  const malformed = findings.find(
    (f): f is Extract<Finding, { class: 'manifest'; issue: 'malformed' }> =>
      f.class === 'manifest' && f.issue === 'malformed',
  );
  if (malformed === undefined) return;
  print('');
  print(paint('state.json is unreadable (wrong shape):', ANSI.yellow, colorOn));
  print(`  reason: ${malformed.reason}`);
  print('  expected shape: {"version":1,"artifacts":[...]}');
  print(
    '  next: back it up (doctor --fix does this), then fix the top-level shape by hand and re-run.',
  );
}

/**
 * Phase 2 — diagnose the installed state and, under `--fix`, repair it.
 *
 * Exit contract (R8, ADR-0024 amended):
 *   diagnose : 0 healthy · 3 findings · 2 manifest unreadable · (1 runtime, 130
 *              cancel — surfaced as thrown errors mapped by the CLI's handleError)
 *   --fix    : 0 all repaired · 3 findings remain (irreparable / refused /
 *              skipped) · 1 a repair failed · 2 manifest unreadable
 *
 * A live/indeterminate run-lock makes `diagnose` abstain from the state scan
 * (its findings would be transient) — reported, exit 0 (R6 "scan pendant un run
 * vivant").
 */
export async function runDoctorState(opts: RunDoctorStateOpts): Promise<number> {
  const { env, print, fix, yes, isTTY, configuredCatalogIds } = opts;
  const colorOn = shouldColor(opts.color);
  const manifestPath = manifestPathFor(env);

  // Adapters: injected (tests) or built for every scanned assistant.
  let adapters = opts.adapters;
  if (adapters === undefined) {
    adapters = new Map<Assistant, Adapter>();
    for (const assistant of SCANNED_ASSISTANTS) {
      adapters.set(assistant, await buildAdapter(assistant, env));
    }
  }

  const scanners = opts.scanners ?? assembleScanners(adapters, opts.now, opts.catalogCanons);

  const ctx: DoctorContext = { env, manifestPath, configuredCatalogIds };
  const report = await diagnose(scanners, ctx);

  print('');
  print(renderDoctorReport(report.findings, opts.color === undefined ? {} : { color: opts.color }));

  const malformed = report.findings.some(
    (f) => f.class === 'manifest' && f.issue === 'malformed',
  );
  const lockRefused = report.findings.some(
    (f) => f.class === 'lock' && f.verdict === 'refused',
  );

  if (malformed) printMalformedGuidance(print, report.findings, colorOn);

  // A live (or indeterminate) run-lock: diagnose abstained from the state scan —
  // its findings would be transient. Report and exit 0 (R6). Applies to --fix too.
  if (lockRefused) {
    print('  A run appears to be in progress — installed-state scan skipped (findings transient).');
    return 0;
  }

  if (!fix) {
    if (malformed) return 2;
    return report.findings.length > 0 ? 3 : 0;
  }

  // ----- --fix path -----

  // Gate (mirrors the lot5 stdin gate): a non-TTY session cannot answer a
  // per-item prompt, and `--yes` is required to auto-grant even the safe ops —
  // exit 2 before any repair work (R8 "--fix en non-TTY sans --yes → exit 2").
  if (!isTTY && !yes) {
    print(
      '[error] doctor --fix needs an interactive terminal (per-item confirmation), '
        + 'or --yes to apply the safe repairs only.',
    );
    return 2;
  }

  const confirmItem = opts.confirmItem ?? confirmDoctorRepair;
  const grant = await driveConsent(report.findings, { yes, isTTY, confirmItem });

  // 2 temps: break the consented lock PRE-acquire (never under a held lock),
  // re-verifying identity + liveness at the moment of acting (ADR-0025 §7).
  let breakLockRefused = false;
  if (grant.breakLock !== undefined) {
    const identify = opts.identify ?? defaultIdentify;
    const breaker = opts.breakLock
      ?? ((lockPath, observed) => breakLockCas(lockPath, observed, { identify }));
    const result = await breaker(grant.breakLock.lockPath, grant.breakLock.observed);
    if (result.broken) {
      print('  Broke the run lock (identity + liveness re-verified).');
    } else {
      breakLockRefused = true;
      print(`  Lock break refused (${result.reason}) — the lock was left in place.`);
    }
  }

  // Acquire a FRESH run-lock and run the state repairs (only when there is work).
  let outcomes: RepairOutcome[] = [];
  if (grant.stateOps.length > 0) {
    const acquire = opts.acquireLock ?? ((mp: string) => acquireRunLock(mp));
    let lock: RunLock;
    try {
      lock = await acquire(manifestPath);
    } catch (err) {
      if (err instanceof ConcurrentRunError) {
        print(`[error] ${err.message}`);
        return 1;
      }
      throw err;
    }
    try {
      outcomes = await runStateRepairs(grant.stateOps, adapters, lock, {
        env,
        manifestPath,
        configuredCatalogIds,
        ...(opts.catalogCanons === undefined ? {} : { canons: opts.catalogCanons }),
        isTTY,
        chooseCatalog: opts.chooseAdoptionCatalog ?? defaultChooseAdoptionCatalog,
        ...(opts.now === undefined ? {} : { now: opts.now }),
      });
    } finally {
      await lock.release();
    }
  }

  const outcomeText = renderRepairOutcomes(
    outcomes,
    opts.color === undefined ? {} : { color: opts.color },
  );
  if (outcomeText !== '') print(outcomeText);

  // Exit computation (R8 --fix contract).
  if (malformed) return 2; // backed up, but state.json is still unreadable
  if (outcomes.some((o) => o.status === 'failed')) return 1;

  const remaining = report.findings.filter((f) => isReportOnly(f)).length
    + grant.skipped.length
    + outcomes.filter((o) => o.status === 'skipped').length
    + (breakLockRefused ? 1 : 0);
  return remaining > 0 ? 3 : 0;
}
