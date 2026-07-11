/**
 * The doctor model: `Finding`, `RepairOp`, `Scanner`, `DoctorReport`.
 *
 * ADR-0025 ("doctor — réparation consentie de l'état installé") trims the
 * design panel's two explored angles to ONE decisive axis: consent is a
 * property of the ACT, carried by the DATA, not derivable from the finding's
 * `class`. R5 makes this load-bearing: adopting a skill (a `state.json`-only
 * mutation, reversible by `remove`) and adopting a guardrail (widens on
 * simple rule-inclusion — user rules coinciding with canon would become
 * "managed" and a later `remove` would delete them) are the SAME `untracked`
 * class, yet diverge on consent. So:
 *
 * - `Finding` is a union discriminated by `class` (untracked | manifest |
 *   dangling | phantom | lock | hygiene) — one member per requirement's
 *   named scenario, matching R8's grouped report.
 * - `evidence` is typed by class ONLY where a scenario actually reads it:
 *   lock (pid + mtime + identity, R6), phantom (store + candidates, R4),
 *   dangling (readlink, R3). Every other class carries plain descriptive
 *   fields — pragmatic modelling, not ceremony (design.md tempering #1).
 * - `RepairOp` is a union of KINDS (adopt | unlink-dangling | remove-store |
 *   break-lock | delete-residue | delete-bak | backup-state), each variant
 *   GRAVING its `consent: 'safe' | 'item-confirm'` as a LITERAL type, never
 *   the wide union. `adopt` bifurcates into two consent-graved variants for
 *   exactly the R5 divergence above. This makes "destructive is never
 *   covered by a global --yes" a fact the type checker enforces (see the
 *   negative `@ts-expect-error` assertions in the test file) rather than a
 *   discipline a reviewer must re-prove.
 * - A `repair` field is REQUIRED on the variants that carry one and ABSENT
 *   (not `undefined` — structurally missing) on report-only variants: a
 *   report-only finding is report-only by construction, not by convention.
 *
 * This module is pure: no I/O, no clock, no filesystem, no adapter calls.
 * Scanners (core/doctor/scanners/**, adapters/shared/doctor-scan.ts) build
 * Finding values with the constructors below; `diagnose()` (core/doctor/
 * diagnose.ts) composes Scanners; `applyRepairs()` (core/doctor/repair.ts)
 * interprets RepairOp values under a held run-lock. Neither lives here.
 */

import type { Env } from '../paths';
import type { Liveness } from '../run-lock';
import type { Assistant, Nature, Scope } from '../types';

// ---------------------------------------------------------------------------
// RepairOp — the repair action a Finding may carry, consent GRAVED per variant
// ---------------------------------------------------------------------------

/**
 * Consent required before a RepairOp may run under `--fix`.
 * - `'safe'`: a reversible, low-risk mutation — `--yes` alone authorises it
 *   (R5 nominal adoption; R7 tmp/checkout/stale-lock residue).
 * - `'item-confirm'`: `--yes` is NEVER sufficient — the CLI's consent-driver
 *   (cli/doctor-consent.ts, T5) must obtain an explicit per-item confirmation
 *   in a TTY, and skips + reports the op in non-TTY (R4, R5 guardrail, R6,
 *   R7 `.bak`).
 *
 * Deliberately NOT a property of `Finding.class`: R5 makes two `untracked`
 * findings diverge on this axis, so grading it per-class would have to
 * re-introduce per-finding logic inside the grader — the exact defect the
 * design panel rejected in the core-first alternative (see design.md
 * "Alternatives écartées").
 */
export type RepairConsent = 'safe' | 'item-confirm';

/**
 * Adopt an untracked-but-conforming artifact into the manifest via
 * `adapter.adopt` (R5) — present-strict, unchanged, no `--force`. Shared
 * shape between the two consent-graved variants below; never constructed
 * directly (use `RepairOpAdopt`, built by the `untrackedAdoptable`
 * constructor).
 */
interface RepairOpAdoptCommon {
  kind: 'adopt';
  nature: Nature;
  scope: Scope;
  assistant: Assistant;
  /** Absolute path(s) proven conforming — becomes ManifestEntry.files on adoption. */
  files: string[];
  /**
   * Catalog id candidate for R5's requalification: unqualified when the
   * scanner could not resolve it unambiguously against the configured
   * catalogs (repair-time prompt in TTY, skip + report otherwise);
   * already-qualified when resolution was unambiguous at scan time.
   */
  candidateId: string;
}

/**
 * Adopting a skill / agent / context / hook / mcp artifact is a
 * `state.json`-only mutation, reversible by `remove` — `--yes` suffices
 * (R5 nominal scenario).
 */
export interface RepairOpAdoptSafe extends RepairOpAdoptCommon {
  consent: 'safe';
}

/**
 * Adopting a guardrail widens on simple rule-inclusion (`adoptGuardrail`):
 * deny rules the user wrote by hand that coincide with the catalog canon
 * would become "managed", and a later `remove` would delete them — item
 * confirmation is mandatory (R5 guardrail scenario).
 */
export interface RepairOpAdoptGuardrail extends RepairOpAdoptCommon {
  consent: 'item-confirm';
}

/** R5: adopt an untracked, proven-conforming artifact. Bifurcates on nature (see variants above). */
export type RepairOpAdopt = RepairOpAdoptSafe | RepairOpAdoptGuardrail;

/**
 * Remove a dangling symlink's bare metadata — no content lives behind it
 * (R3, untracked pendant). Always item-confirm: even though nothing is lost,
 * the act still removes a filesystem entry doctor was not asked to create.
 */
export interface RepairOpUnlinkDangling {
  kind: 'unlink-dangling';
  consent: 'item-confirm';
  /** The dead symlink itself (not the vanished path it used to resolve to). */
  target: string;
}

/**
 * Delete a phantom store directory via `backupDir` +
 * `removeStoreIfUnreferenced` (R4) — the predicate re-verifies referents at
 * the moment of acting (TOCTOU guard). The refcount that produced this
 * finding is a "probable" verdict, never "certain" (a project-scope referent
 * from another cwd is invisible by construction, R4) — `--yes` is never
 * sufficient, per-item confirmation always.
 */
export interface RepairOpRemoveStore {
  kind: 'remove-store';
  consent: 'item-confirm';
  /** Absolute path of the store directory to remove. */
  store: string;
}

/**
 * Break a run-lock via the rename+CAS primitive (`breakLockCas`, R6) —
 * re-verifies identity AND liveness at the moment of acting, never a bare
 * unlink. Always item-confirm: breaking another run's lock is the single
 * most dangerous act doctor can propose (it opens two engine writers onto
 * `settings.json`, protected only by this lock, ADR-0023).
 */
export interface RepairOpBreakLock {
  kind: 'break-lock';
  consent: 'item-confirm';
  /** Absolute path of the lockfile to break. */
  lockPath: string;
}

/**
 * Delete a datable, never-reread residue: an orphaned `.tmp-*` staging file,
 * an aged temporary catalog checkout (R7), or `.stale-<digits>-<8hex>`
 * lock-break debris (R6). Always safe — each is provably orphaned by
 * construction (age-gated, run-lock re-checked, strict pattern match) and
 * none ever carries user data.
 */
export interface RepairOpDeleteResidue {
  kind: 'delete-residue';
  consent: 'safe';
  /** Absolute path of the residue file or directory to delete. */
  path: string;
}

/**
 * Delete an aged `.bak-*` past the age + keep-last-N retention policy (R7).
 * Always item-confirm: a `.bak` is the sole reversibility net ADR-0016
 * relies on — the worst failure doctor could commit is destroying it, so
 * `--yes` never suffices, and a store `.bak` directory never skips its own
 * dedicated confirmation.
 */
export interface RepairOpDeleteBak {
  kind: 'delete-bak';
  consent: 'item-confirm';
  /** Absolute path of the `.bak-*` file or directory to delete. */
  path: string;
}

/**
 * Back up `state.json` before a human hand-edits its malformed shape (R8
 * salvage, T2). Never destructive — a byte-copy via `backup()`, nothing is
 * deleted or overwritten — so `--yes` always suffices. This does NOT fix the
 * shape violation itself (doctor cannot guess the intended shape from a
 * broken file): it only makes it safe to intervene by hand, replacing the
 * old "delete the file to start fresh" advice.
 *
 * T1 originally left `FindingManifestMalformed` without a `repair` (see its
 * docstring below) pending this exact decision; reopening `RepairOp` with
 * this kind — rather than overloading `delete-residue`'s shape for a
 * non-deleting act — keeps each kind's name truthful to what it does.
 */
export interface RepairOpBackupState {
  kind: 'backup-state';
  consent: 'safe';
  /** Absolute path of the state.json to back up. */
  path: string;
}

/**
 * The closed union of repair kinds doctor knows how to interpret
 * (`applyRepairs`, core/doctor/repair.ts, T4). Closed on purpose (YAGNI,
 * design.md "ce qu'on assume payer"): a future composed/multi-step act would
 * need the form reopened, not a fourth-wall `kind: 'other'` escape hatch.
 */
export type RepairOp =
  | RepairOpAdopt
  | RepairOpUnlinkDangling
  | RepairOpRemoveStore
  | RepairOpBreakLock
  | RepairOpDeleteResidue
  | RepairOpDeleteBak
  | RepairOpBackupState;

// ---------------------------------------------------------------------------
// Evidence — typed only where a scenario reads it (design.md tempering #1)
// ---------------------------------------------------------------------------

/**
 * Structured proof backing a `lock` finding (R6). `pid`/`startedAt`/`ageMs`/
 * `liveness` mirror `RunLockInspection` (run-lock.ts) verbatim — the scanner
 * is a thin wrapper around `inspectRunLock`, never a second source of truth.
 */
export interface LockEvidence {
  /** Recorded pid, or -1 when the lock is absent/unreadable/corrupt. */
  pid: number;
  /** Recorded startedAt, or undefined when absent/unreadable/corrupt. */
  startedAt: string | undefined;
  /** Age of the lock in ms, or undefined when mtime is unknown. */
  ageMs: number | undefined;
  /** Tri-state liveness of the recorded pid at diagnosis time. */
  liveness: Liveness;
  /**
   * Whether the live pid's process identity looks like a rigger/bun run
   * (`'rigger'`), a clearly different process (`'foreign'` — pid recycled),
   * or could not be determined (`'unknown'` — treated conservatively: never
   * eligible for repair, R6 refusal scenario).
   */
  identity: 'rigger' | 'foreign' | 'unknown';
}

/**
 * Structured proof backing a `phantom` finding (R4). Both fields are
 * NEGATIVE signals — `candidates` is what was checked and found wanting,
 * which is exactly why the verdict stays "probable", never "certain"
 * (a project-scope referent from another cwd is invisible by construction).
 */
export interface PhantomEvidence {
  /** Absolute path of the store directory being evaluated. */
  store: string;
  /**
   * Store-reference candidates enumerated at diagnosis time (live symlinks
   * resolved, manifest `files[]` entries consulted) — empty when none were
   * found.
   */
  candidates: string[];
}

/** Structured proof backing a `dangling` finding (R3): the raw readlink result. */
export interface DanglingEvidence {
  /** Raw symlink target as returned by readlink — the vanished path. */
  readlink: string;
}

// ---------------------------------------------------------------------------
// Finding — union discriminated by `class`
// ---------------------------------------------------------------------------

/** Fields shared by every Finding, regardless of class. */
interface FindingCommon {
  /**
   * Stable, deterministic identity built from the finding's defining fields
   * (never a random token or timestamp) — the same inputs always produce
   * the same id, so re-running `diagnose()` yields comparable reports.
   */
  id: string;
  /** One-line human-readable summary for the grouped report (R8). */
  summary: string;
}

// --- untracked (R1) ---------------------------------------------------------

export type UntrackedVerdict = 'adoptable' | 'drift' | 'host-diff';

interface FindingUntrackedCommon extends FindingCommon {
  class: 'untracked';
  nature: Nature;
  scope: Scope;
  assistant: Assistant;
}

/**
 * R1 nominal + mass-amputation scenarios: a conforming artifact (resolving
 * symlink or byte-identical copy) with no manifest entry — proposes
 * adoption (R5). Both scenarios route here identically; doctor never
 * speculates about WHY the manifest is missing the entry.
 */
export interface FindingUntrackedAdoptable extends FindingUntrackedCommon {
  verdict: 'adoptable';
  /** Absolute on-disk path proven conforming. */
  path: string;
  repair: RepairOpAdopt;
}

/**
 * R1 drift scenario: untracked AND diverges from its store (or has none).
 * Never adopted, never overwritten (adapter.adopt present-strict) — report
 * only; the two manual outsides (reinstall or hand-remove) live in `summary`.
 */
export interface FindingUntrackedDrift extends FindingUntrackedCommon {
  verdict: 'drift';
  path: string;
  // No `repair` field: report-only by construction (ADR-0016 red line —
  // adopting a drift would arm a future destructive remove).
}

/**
 * R1 offline-invisible natures: a guardrail rule / context block / mcp
 * server present at the host with no disk signature, detected only via a
 * reachable catalog differential. Report-only — the disk-only detector
 * cannot distinguish these from legitimate user content offline.
 */
export interface FindingUntrackedHostDiff extends FindingUntrackedCommon {
  verdict: 'host-diff';
  detail: string;
  // No `repair` field: report-only by construction.
}

export type FindingUntracked =
  | FindingUntrackedAdoptable
  | FindingUntrackedDrift
  | FindingUntrackedHostDiff;

// --- manifest (R2 + R8 salvage) ---------------------------------------------

export type ManifestIssue =
  | 'orphan-catalog'
  | 'missing-sha'
  | 'missing-file'
  | 'applied-drift'
  | 'malformed';

interface FindingManifestCommon extends FindingCommon {
  class: 'manifest';
}

/** R2: the manifest entry's catalog prefix no longer matches any configured catalog. */
export interface FindingManifestOrphanCatalog extends FindingManifestCommon {
  issue: 'orphan-catalog';
  entryId: string;
  nature: Nature;
  scope: Scope;
  // No `repair`: R2 is "rapportées" — report + suggestion, never executed.
}

/** R2: the manifest entry has an empty/missing `sha` (historic adoption). */
export interface FindingManifestMissingSha extends FindingManifestCommon {
  issue: 'missing-sha';
  entryId: string;
  nature: Nature;
  scope: Scope;
}

/** R2: a `files[]` path recorded by the entry no longer exists on disk. */
export interface FindingManifestMissingFile extends FindingManifestCommon {
  issue: 'missing-file';
  entryId: string;
  nature: Nature;
  scope: Scope;
  missingPath: string;
}

/** R2: the recorded `applied` payload no longer matches the live host config. */
export interface FindingManifestAppliedDrift extends FindingManifestCommon {
  issue: 'applied-drift';
  entryId: string;
  nature: Nature;
  scope: Scope;
}

/**
 * R8 salvage scenario: `state.json` is present but its top-level shape is
 * invalid (`MalformedManifestError`). Carries a `backup-state` repair (T2):
 * always actionable, never report-only — backing up the file is safe
 * regardless of what its shape violation turns out to be, replacing the old
 * "delete the file to start fresh" advice with "back it up, then look".
 */
export interface FindingManifestMalformed extends FindingManifestCommon {
  issue: 'malformed';
  /** `MalformedManifestError.reason` — the shape violation, verbatim. */
  reason: string;
  repair: RepairOpBackupState;
}

export type FindingManifest =
  | FindingManifestOrphanCatalog
  | FindingManifestMissingSha
  | FindingManifestMissingFile
  | FindingManifestAppliedDrift
  | FindingManifestMalformed;

// --- dangling (R3) -----------------------------------------------------------

interface FindingDanglingCommon extends FindingCommon {
  class: 'dangling';
  evidence: DanglingEvidence;
}

/**
 * R3 tracked pendant: a manifest entry's `files[]` contains a dead symlink.
 * `--fix` SUGGESTS reinstalling the entry — it never runs the install itself
 * (install has its own gates, ADR-0018/0022) — so this variant carries no
 * executable `repair`; the suggestion lives in `summary`.
 */
export interface FindingDanglingTracked extends FindingDanglingCommon {
  tracked: true;
  entryId: string;
}

/**
 * R3 untracked pendant: bare symlink metadata under a rigger root, no
 * manifest entry, target absent. Removable with item confirmation.
 */
export interface FindingDanglingUntracked extends FindingDanglingCommon {
  tracked: false;
  /** The dead symlink itself. */
  path: string;
  repair: RepairOpUnlinkDangling;
}

export type FindingDangling = FindingDanglingTracked | FindingDanglingUntracked;

// --- phantom (R4) ------------------------------------------------------------

/**
 * R4: a store directory with no enumerable referent. Single variant — every
 * scenario (crash orphan, indeterminate-cause) reaches the same "probable
 * ghost" verdict and the same removal op; only `evidence.candidates` and
 * `summary` vary.
 */
export interface FindingPhantom extends FindingCommon {
  class: 'phantom';
  evidence: PhantomEvidence;
  repair: RepairOpRemoveStore;
}

// --- lock (R6) -----------------------------------------------------------

export type LockVerdict = 'crash-probable' | 'pid-recycled-probable' | 'refused' | 'stale-debris';

interface FindingLockCommon extends FindingCommon {
  class: 'lock';
}

/** R6: the recorded pid is dead — a previous run likely crashed. */
export interface FindingLockCrashProbable extends FindingLockCommon {
  verdict: 'crash-probable';
  evidence: LockEvidence;
  repair: RepairOpBreakLock;
}

/** R6: the recorded pid is alive but its process identity does not look like rigger/bun. */
export interface FindingLockPidRecycledProbable extends FindingLockCommon {
  verdict: 'pid-recycled-probable';
  evidence: LockEvidence;
  repair: RepairOpBreakLock;
}

/**
 * R6 refusal scenario: pid alive and plausibly a rigger run, OR liveness
 * indeterminate (EPERM). Diagnostic only — breaking the lock is NEVER
 * proposed (casting aside a live run's lock opens two engine writers onto
 * `settings.json`).
 */
export interface FindingLockRefused extends FindingLockCommon {
  verdict: 'refused';
  reason: 'live' | 'eperm';
  evidence: LockEvidence;
}

/**
 * R6 debris scenario: a `<lockPath>.stale-<digits>-<8hex>` file left by a
 * prior CAS break. Matched by the strict pattern only (never a looser glob)
 * and never re-read — removable under `--yes`.
 */
export interface FindingLockStaleDebris extends FindingLockCommon {
  verdict: 'stale-debris';
  /** Absolute path of the matched debris file. */
  path: string;
  repair: RepairOpDeleteResidue;
}

export type FindingLock =
  | FindingLockCrashProbable
  | FindingLockPidRecycledProbable
  | FindingLockRefused
  | FindingLockStaleDebris;

// --- hygiene (R7) --------------------------------------------------------

interface FindingHygieneCommon extends FindingCommon {
  class: 'hygiene';
  path: string;
  ageMs: number;
}

/**
 * R7: an orphaned `.tmp-*` staging file or an aged temporary catalog
 * checkout under the tmpdir. Always safe — staging is never reused once
 * orphaned, and the age + run-lock gate rules out an in-flight run.
 */
export interface FindingHygieneResidue extends FindingHygieneCommon {
  kind: 'residue';
  repair: RepairOpDeleteResidue;
}

/**
 * R7: a `.bak-*` past the age + keep-last-N retention policy. A RECENT
 * `.bak` is never even surfaced as a finding (it may be the sole copy of
 * user edits) — this variant only ever represents an AGED one, and even
 * then removal always requires item confirmation.
 */
export interface FindingHygieneBak extends FindingHygieneCommon {
  kind: 'bak';
  repair: RepairOpDeleteBak;
}

export type FindingHygiene = FindingHygieneResidue | FindingHygieneBak;

// --- Finding union -----------------------------------------------------------

/**
 * The doctor finding: one union, discriminated by `class`, spanning every
 * requirement (R1–R4, R6, R7 — R5 is adoption of an R1 finding, R8/R9 add no
 * class of their own). A `repair` field present ⇒ actionable; absent ⇒
 * report-only, both facts checkable at the type level, never by convention.
 */
export type Finding =
  | FindingUntracked
  | FindingManifest
  | FindingDangling
  | FindingPhantom
  | FindingLock
  | FindingHygiene;

/** The six finding classes, derived from the union (never redeclared separately). */
export type FindingClass = Finding['class'];

/**
 * True when `finding` carries no `repair` — report-only by construction.
 * A pure structural check (`in`), never a heuristic over `class`: R5 proves
 * `class` alone cannot answer this question for `untracked`.
 */
export function isReportOnly(finding: Finding): boolean {
  return !('repair' in finding);
}

// ---------------------------------------------------------------------------
// Constructors — pure, one per named scenario. No I/O, no clock, no randomness.
// ---------------------------------------------------------------------------

/**
 * Build the consent-graved adopt op for `nature` (R5). Branches on nature so
 * the RETURNED literal is exactly `RepairOpAdoptSafe` or
 * `RepairOpAdoptGuardrail` — never a value merged early into the wider
 * `RepairOpAdopt` union, which would blur the graving this module exists to
 * enforce.
 */
function adoptRepairFor(params: {
  nature: Nature;
  scope: Scope;
  assistant: Assistant;
  files: string[];
  candidateId: string;
}): RepairOpAdopt {
  if (params.nature === 'guardrail') {
    return {
      kind: 'adopt',
      consent: 'item-confirm',
      nature: params.nature,
      scope: params.scope,
      assistant: params.assistant,
      files: params.files,
      candidateId: params.candidateId,
    };
  }
  return {
    kind: 'adopt',
    consent: 'safe',
    nature: params.nature,
    scope: params.scope,
    assistant: params.assistant,
    files: params.files,
    candidateId: params.candidateId,
  };
}

/** R1 (nominal + mass-amputation scenarios): a conforming untracked artifact. */
export function untrackedAdoptable(params: {
  nature: Nature;
  scope: Scope;
  assistant: Assistant;
  path: string;
  candidateId: string;
  files?: string[];
}): FindingUntrackedAdoptable {
  const files = params.files ?? [params.path];
  return {
    class: 'untracked',
    verdict: 'adoptable',
    id: `untracked:${params.assistant}:${params.scope}:${params.nature}:${params.path}`,
    summary:
      `${params.nature} "${params.path}" is untracked but conforms to its store — adoptable.`,
    nature: params.nature,
    scope: params.scope,
    assistant: params.assistant,
    path: params.path,
    repair: adoptRepairFor({ ...params, files }),
  };
}

/** R1 drift scenario: untracked and diverges — never adopted. */
export function untrackedDrift(params: {
  nature: Nature;
  scope: Scope;
  assistant: Assistant;
  path: string;
}): FindingUntrackedDrift {
  return {
    class: 'untracked',
    verdict: 'drift',
    id: `untracked:${params.assistant}:${params.scope}:${params.nature}:${params.path}`,
    summary: `${params.nature} "${params.path}" is untracked and diverges from its store — `
      + 'not adopted (drift is not damage): reinstall it, or remove it by hand.',
    nature: params.nature,
    scope: params.scope,
    assistant: params.assistant,
    path: params.path,
  };
}

/** R1 offline-invisible-nature scenario: host-only differential, no disk signature. */
export function untrackedHostDiff(params: {
  nature: Nature;
  scope: Scope;
  assistant: Assistant;
  detail: string;
}): FindingUntrackedHostDiff {
  return {
    class: 'untracked',
    verdict: 'host-diff',
    id: `untracked:${params.assistant}:${params.scope}:${params.nature}:host-diff`,
    summary: `${params.nature} present at the host, not tracked by the manifest.`,
    nature: params.nature,
    scope: params.scope,
    assistant: params.assistant,
    detail: params.detail,
  };
}

/** R2: entry references a catalog no longer configured. */
export function manifestOrphanCatalog(params: {
  entryId: string;
  nature: Nature;
  scope: Scope;
}): FindingManifestOrphanCatalog {
  return {
    class: 'manifest',
    issue: 'orphan-catalog',
    id: `manifest:orphan-catalog:${params.entryId}`,
    summary: `"${params.entryId}" references a catalog no longer configured — `
      + 'inauditable by check.',
    entryId: params.entryId,
    nature: params.nature,
    scope: params.scope,
  };
}

/** R2: entry has an empty/missing sha (historic adoption). */
export function manifestMissingSha(params: {
  entryId: string;
  nature: Nature;
  scope: Scope;
}): FindingManifestMissingSha {
  return {
    class: 'manifest',
    issue: 'missing-sha',
    id: `manifest:missing-sha:${params.entryId}`,
    summary: `"${params.entryId}" has no recorded sha (historic adoption) — `
      + `re-stamp it with "update ${params.entryId}".`,
    entryId: params.entryId,
    nature: params.nature,
    scope: params.scope,
  };
}

/** R2: a files[] path recorded by the entry no longer exists on disk. */
export function manifestMissingFile(params: {
  entryId: string;
  nature: Nature;
  scope: Scope;
  missingPath: string;
}): FindingManifestMissingFile {
  return {
    class: 'manifest',
    issue: 'missing-file',
    id: `manifest:missing-file:${params.entryId}:${params.missingPath}`,
    summary: `"${params.entryId}" records "${params.missingPath}" but it is gone from disk.`,
    entryId: params.entryId,
    nature: params.nature,
    scope: params.scope,
    missingPath: params.missingPath,
  };
}

/** R2: the recorded applied payload no longer matches the live host config. */
export function manifestAppliedDrift(params: {
  entryId: string;
  nature: Nature;
  scope: Scope;
}): FindingManifestAppliedDrift {
  return {
    class: 'manifest',
    issue: 'applied-drift',
    id: `manifest:applied-drift:${params.entryId}`,
    summary: `"${params.entryId}"'s recorded applied payload no longer matches the live config.`,
    entryId: params.entryId,
    nature: params.nature,
    scope: params.scope,
  };
}

/** R8 salvage: state.json is present but its top-level shape is invalid. */
export function manifestMalformed(
  params: { reason: string; path: string },
): FindingManifestMalformed {
  return {
    class: 'manifest',
    issue: 'malformed',
    id: 'manifest:malformed:state.json',
    summary: 'state.json is present but its shape is invalid — back it up before editing by hand.',
    reason: params.reason,
    repair: { kind: 'backup-state', consent: 'safe', path: params.path },
  };
}

/** R3 tracked pendant: manifest entry exists, its files[] symlink is dead. */
export function danglingTracked(params: {
  entryId: string;
  readlink: string;
}): FindingDanglingTracked {
  return {
    class: 'dangling',
    tracked: true,
    id: `dangling:tracked:${params.entryId}`,
    summary: `"${params.entryId}" has a dangling symlink — reinstall it to re-populate the store `
      + '(doctor never re-links silently).',
    entryId: params.entryId,
    evidence: { readlink: params.readlink },
  };
}

/** R3 untracked pendant: bare dead symlink, no manifest entry, under a rigger root. */
export function danglingUntracked(params: {
  path: string;
  readlink: string;
}): FindingDanglingUntracked {
  return {
    class: 'dangling',
    tracked: false,
    id: `dangling:untracked:${params.path}`,
    summary: `"${params.path}" is a dangling symlink with no manifest entry — removable.`,
    path: params.path,
    evidence: { readlink: params.readlink },
    repair: { kind: 'unlink-dangling', consent: 'item-confirm', target: params.path },
  };
}

/** R4: a store directory with no enumerable referent — probable ghost. */
export function phantomProbable(params: {
  store: string;
  candidates: string[];
}): FindingPhantom {
  return {
    class: 'phantom',
    id: `phantom:${params.store}`,
    summary: `"${params.store}" has no enumerable referent — probable ghost store `
      + '(a project-scope referent from another cwd cannot be ruled out).',
    evidence: { store: params.store, candidates: params.candidates },
    repair: { kind: 'remove-store', consent: 'item-confirm', store: params.store },
  };
}

/**
 * Human-readable age for a lock's summary (R6 "(pid, startedAt, âge)" — the
 * evidence a human must see before consenting to break a lock, the single
 * most destructive act doctor can propose). Pure formatting, no clock read:
 * `evidence.ageMs` was already computed at diagnosis time by `inspectRunLock`.
 * `undefined` (mtime unknown) renders as "unknown" rather than a bogus "0s".
 */
function formatLockAge(ageMs: number | undefined): string {
  if (ageMs === undefined) return 'unknown';
  const totalSeconds = Math.floor(ageMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

/**
 * Render the evidence tail every lock summary carries: `startedAt` (or
 * "unknown" when unreadable/corrupt) and the formatted age. `pid` is NOT
 * repeated here — every call site already states it in the sentence proper.
 */
function lockEvidenceTail(evidence: LockEvidence): string {
  return `startedAt ${evidence.startedAt ?? 'unknown'}, age ${formatLockAge(evidence.ageMs)}`;
}

/** R6 crash scenario: the recorded pid is dead. */
export function lockCrashProbable(params: {
  lockPath: string;
  evidence: LockEvidence;
}): FindingLockCrashProbable {
  return {
    class: 'lock',
    verdict: 'crash-probable',
    id: 'lock:crash-probable',
    summary: `Lock held by pid ${params.evidence.pid} looks dead — a previous run likely crashed `
      + `(${lockEvidenceTail(params.evidence)}).`,
    evidence: params.evidence,
    repair: { kind: 'break-lock', consent: 'item-confirm', lockPath: params.lockPath },
  };
}

/** R6 pid-recycled scenario: the recorded pid is alive but foreign. */
export function lockPidRecycledProbable(params: {
  lockPath: string;
  evidence: LockEvidence;
}): FindingLockPidRecycledProbable {
  return {
    class: 'lock',
    verdict: 'pid-recycled-probable',
    id: 'lock:pid-recycled-probable',
    summary: `Pid ${params.evidence.pid} is alive but does not look like a rigger/bun run — `
      + `probable pid recycling (${lockEvidenceTail(params.evidence)}).`,
    evidence: params.evidence,
    repair: { kind: 'break-lock', consent: 'item-confirm', lockPath: params.lockPath },
  };
}

/** R6 refusal scenario: pid alive-and-plausibly-rigger, or liveness indeterminate (EPERM). */
export function lockRefused(params: {
  reason: 'live' | 'eperm';
  evidence: LockEvidence;
}): FindingLockRefused {
  return {
    class: 'lock',
    verdict: 'refused',
    id: `lock:refused:${params.reason}`,
    summary: params.reason === 'live'
      ? `Lock held by pid ${params.evidence.pid} is alive and plausibly a rigger run — `
        + `breaking it is never proposed (${lockEvidenceTail(params.evidence)}).`
      : `Pid ${params.evidence.pid}'s liveness could not be determined (EPERM) — `
        + `breaking it is never proposed (${lockEvidenceTail(params.evidence)}).`,
    reason: params.reason,
    evidence: params.evidence,
  };
}

/** R6 debris scenario: a single `.stale-<digits>-<8hex>` file. */
export function lockStaleDebris(params: { path: string }): FindingLockStaleDebris {
  return {
    class: 'lock',
    verdict: 'stale-debris',
    id: `lock:stale-debris:${params.path}`,
    summary: `"${params.path}" is stale lock-break debris — removable, never re-read.`,
    path: params.path,
    repair: { kind: 'delete-residue', consent: 'safe', path: params.path },
  };
}

/** R7: orphaned `.tmp-*` staging file or aged temporary catalog checkout. */
export function hygieneResidue(params: { path: string; ageMs: number }): FindingHygieneResidue {
  return {
    class: 'hygiene',
    kind: 'residue',
    id: `hygiene:residue:${params.path}`,
    summary: `"${params.path}" is orphaned staging/checkout residue — removable under --yes.`,
    path: params.path,
    ageMs: params.ageMs,
    repair: { kind: 'delete-residue', consent: 'safe', path: params.path },
  };
}

/** R7: a `.bak-*` past the age + keep-last-N retention policy. */
export function hygieneBak(params: { path: string; ageMs: number }): FindingHygieneBak {
  return {
    class: 'hygiene',
    kind: 'bak',
    id: `hygiene:bak:${params.path}`,
    summary: `"${params.path}" is past the .bak retention policy — removable with confirmation.`,
    path: params.path,
    ageMs: params.ageMs,
    repair: { kind: 'delete-bak', consent: 'item-confirm', path: params.path },
  };
}

// ---------------------------------------------------------------------------
// Scanner / DoctorContext / DoctorReport
// ---------------------------------------------------------------------------

/**
 * Read-only context injected into every Scanner. Deliberately adapter-free
 * (design.md "Scanner[] composed bat la ScanSurface monolithique"): a
 * scanner that needs an `Adapter` is already bound to one as a closure when
 * the CLI assembles `Scanner[]` (T5) — adding an assistant means adding a
 * Scanner, never widening this shape.
 */
export interface DoctorContext {
  /** Injectable env for HOME/CWD resolution — same seam as Adapter methods. */
  env: Env;
  /** Absolute path of state.json — scanners derive `${manifestPath}.lock` etc. from it. */
  manifestPath: string;
  /** Catalog ids currently configured (R2 orphan-catalog check; R5 id requalification). */
  configuredCatalogIds: string[];
}

/**
 * A diagnosis source. Assistant-agnostic scanners live in
 * `core/doctor/scanners/` (R2, R6); path-aware scanners live in
 * `adapters/shared/doctor-scan.ts` (R1, R3, R4, R7) and are injected by the
 * CLI, never imported by the core (ADR-0020). MUST be read-only: no write,
 * no lock, no spawn, no catalog execution — `diagnose()` is read-only
 * absolute (ADR-0025 §1), and that invariant is only as strong as every
 * scanner it composes.
 *
 * Named `DoctorScanner`, not `Scanner`: `core/scan.ts` already exports a
 * `Scanner` (the gitleaks/trivy security-scan interface) through the same
 * barrel (`core/src/index.ts`) — reusing the name would collide there. The
 * design/tasks docs write it as `Scanner`; this is a deliberate, minimal
 * rename to avoid ambiguity, not a semantic change.
 */
export type DoctorScanner = (ctx: DoctorContext) => Promise<Finding[]>;

/** Aggregated result of `diagnose()` — the CLI derives exit codes and the grouped report from it. */
export interface DoctorReport {
  findings: Finding[];
}
