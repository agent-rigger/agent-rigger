/**
 * `applyRepairs()` — the doctor repair interpreter (ADR-0025 §3–§5, T4).
 *
 * Runs under the run-lock ALREADY HELD by the CLI (never acquired here — the
 * lock's lifecycle is the CLI's, ADR-0025 §7 "2 temps": break-lock happens
 * PRE-acquire, then a fresh `acquireRunLock`, then this). It is strictly
 * NON-INTERACTIVE: it receives only `granted` — the subset the CLI's
 * consent-driver already consented (safe ops under `--yes`, item-confirm ops
 * per explicit confirmation) — and NEVER prompts. The core never prompts, by
 * construction; that is why consent lives at the CLI and re-verification lives
 * here, as two clean layers.
 *
 * The interpreter `switch`es on `op.kind`. Each branch RE-VERIFIES at the
 * moment of acting, independently of the consent it already carries — the
 * diagnosis is never the proof at act time (TOCTOU). Two shapes of re-check:
 *
 *  - Kinds backed by an engine primitive whose PRECONDITION is itself the
 *    act-time gate: `adopt` (→ `adapter.adopt`, present-strict, unchanged, no
 *    `--force`) and `remove-store` (→ `removeStoreIfUnreferenced`, whose
 *    predicate re-tests referents at the instant of destruction). We call the
 *    primitive and honour its refusal.
 *  - Kinds with NO engine primitive that re-tests — `unlink-dangling` and
 *    `delete-residue` (the engine only ever removes manifest-first) — carry
 *    their micro-re-check HERE (readlink still dangling? residue still the
 *    right pattern + age?), so they keep the TOCTOU guard the other kinds get
 *    for free. This asymmetry is deliberate (ADR-0025 §3) — two mono-use
 *    primitives were rejected in favour of the interpreter owning the check.
 *
 * Backup-first everywhere (ADR-0025 §4): `state.json` is backed up ONCE before
 * the first manifest-mutating op (`firstStateWrite` — the first path in the
 * repo to back up state.json), and a store is copied via `backupDir` before it
 * is removed (a phantom may be the sole copy of user edits made through the
 * install symlink).
 *
 * `break-lock` is NOT interpreted here: its subject IS the run-lock, so it
 * cannot run under the lock — the CLI breaks it pre-acquire (ADR-0025 §7). If
 * one ever reaches this interpreter it is a routing bug, reported as a skip
 * rather than silently executed.
 */

import { lstat, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import type { Adapter, AdapterEntry } from '../adapter';
import { assertNever } from '../assert-never';
import { backup, backupDir } from '../backup';
import { removeStoreIfUnreferenced, resolvesToStore, unlinkTarget } from '../linker';
import { readManifest, upsertEntry, writeManifest } from '../manifest';
import type { Env } from '../paths';
import type { RunLock } from '../run-lock';
import type { Manifest, ManifestEntry } from '../types';
import type {
  RepairOp,
  RepairOpAdopt,
  RepairOpBackupState,
  RepairOpBreakLock,
  RepairOpDeleteBak,
  RepairOpDeleteResidue,
  RepairOpRemoveStore,
  RepairOpUnlinkDangling,
} from './finding';

// ---------------------------------------------------------------------------
// Id requalification (R5)
// ---------------------------------------------------------------------------

/**
 * Outcome of requalifying an adopt op's `candidateId` against the configured
 * catalogs (R5). NON-PROMPTING — the core never prompts; the CLI injects a
 * resolver (`ApplyRepairsDeps.resolveAdoptionId`) that may itself have prompted
 * earlier, or resolves deterministically.
 *
 * - `'unique'`: exactly one catalog claims the name → adopt under the returned
 *   qualified id (`<catalog>/<localId>`).
 * - `'ambiguous'`: two or more catalogs offer the name → the interpreter
 *   SKIPS + reports (never guess: adopting under the wrong id would arm
 *   update/remove on the wrong canonical, R5 "requalification ambiguë").
 * - `'none'`: no configured catalog claims it → adopt under DEFAULTS (the raw
 *   unqualified candidateId, `v0.0.0` / empty sha), surfaced by R2's missing-sha
 *   audit at the next run (R5 "aucun → adoption sous defaults").
 */
export type AdoptionIdResolution =
  | { kind: 'unique'; id: string }
  | { kind: 'ambiguous' }
  | { kind: 'none' };

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Injected collaborators for `applyRepairs`. The interpreter stays
 * assistant-agnostic (ADR-0020): every piece of path knowledge and catalog
 * knowledge it needs arrives through this seam, never derived in core.
 */
export interface ApplyRepairsDeps {
  /** Injectable env for HOME/CWD resolution — same seam as the adapter methods. */
  env: Env;
  /**
   * Absolute path of `state.json`. Backed up once before the first
   * manifest-mutating op (`firstStateWrite`) and rewritten on each adoption.
   */
  manifestPath: string;
  /** Requalify an adopt op's `candidateId` against the configured catalogs (R5). */
  resolveAdoptionId: (candidateId: string) => Promise<AdoptionIdResolution>;
  /**
   * Fresh enumeration of a store's reference-candidate target paths at ACT
   * time (R4 TOCTOU). Path-aware, so it is injected (the CLI wires it to
   * `storeReferenceCandidates`); `removeStoreIfUnreferenced` then re-tests
   * `resolvesToStore` on each at the instant of destruction — a referent that
   * appeared since diagnosis is caught here, not trusted from the finding.
   */
  enumerateStoreReferents: (store: string) => Promise<string[]>;
  /** Injectable clock (ms since epoch) for the residue age re-check. Defaults to Date.now. */
  now?: () => number;
  /** Age threshold (ms) past which an age-gated residue stays deletable. Defaults to 24h. */
  maxAgeMs?: number;
  /**
   * Shared `state.json` backup guard (Low2 fix). `applyRepairs` is called
   * ONCE PER ASSISTANT by the CLI (`adopt` uses each finding's own assistant's
   * adapter, cmd-doctor.ts's `runStateRepairs`), all under the SAME held run-lock
   * within a single `--fix` run. Without a guard shared across those calls,
   * each call's own `firstStateWrite` would fire once, producing one
   * `state.json.bak-*` per assistant instead of one per run. The CLI creates
   * ONE `{ backedUp: false }` object and passes the SAME reference into every
   * per-assistant `ApplyRepairsDeps`; a standalone/test caller that omits it
   * gets a fresh guard local to that single call (unchanged behaviour).
   */
  stateBackupGuard?: { backedUp: boolean };
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/**
 * The result of interpreting one `RepairOp`. The CLI derives the exit code
 * from the collection (ADR-0024 amended): all `repaired` → 0, any `skipped`
 * (TOCTOU refusal / ambiguous id / present-strict refusal) → 3 (findings
 * remain), any `failed` → 1.
 */
export type RepairOutcome =
  | { status: 'repaired'; op: RepairOp; detail?: string }
  | { status: 'skipped'; op: RepairOp; reason: string }
  | { status: 'failed'; op: RepairOp; error: string };

// ---------------------------------------------------------------------------
// Residue / bak patterns (act-time micro-re-check, R6/R7)
// ---------------------------------------------------------------------------

/** `.stale-<digits>-<8hex>` — a prior CAS lock-break (run-lock.ts). Never re-read → no age gate. */
const STALE_SUFFIX_RE = /\.stale-\d+-[0-9a-f]{8}$/;
/** `.tmp-<8hex>` — an orphaned atomic-write staging sibling (fs-json.ts / backup.ts). Age-gated. */
const TMP_SUFFIX_RE = /\.tmp-[0-9a-f]{8}$/;
/** Prefix of a temporary catalog checkout dir (cli/src/remote.ts). Age-gated. */
const CATALOG_CHECKOUT_PREFIX = 'agent-rigger-catalog-';
/** `.bak-<ISO>-<8hex>` — the reversibility net of ADR-0016 (backup.ts `backupDest`). */
const BAK_SUFFIX_RE = /\.bak-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f]{8}$/;

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// applyRepairs
// ---------------------------------------------------------------------------

/**
 * Interpret `granted` (already-consented repair ops) under the HELD `lock`.
 *
 * @param granted  The consent-cleared ops (never contains a kind the CLI did
 *                 not gate — the type does not enforce this; the CLI does).
 * @param adapter  The assistant adapter, for `adopt` (present-strict re-check).
 * @param lock     The run-lock ALREADY HELD by the CLI — a proof-of-hold marker;
 *                 never acquired or released here.
 * @param deps     Injected env, manifest path, id resolver, store-referent
 *                 enumerator, and clock (ADR-0020 — no path knowledge in core).
 */
export async function applyRepairs(
  granted: RepairOp[],
  adapter: Adapter,
  lock: RunLock,
  deps: ApplyRepairsDeps,
): Promise<RepairOutcome[]> {
  // The held lock MUST be THIS manifest's lock — otherwise the caller acquired
  // the wrong lock and the state mutations below are unserialised. A programming
  // error, surfaced eagerly rather than after a half-applied run.
  const expectedLock = `${deps.manifestPath}.lock`;
  if (lock.path !== expectedLock) {
    throw new Error(
      `applyRepairs called under the wrong run-lock: held "${lock.path}", `
        + `expected "${expectedLock}" for manifest "${deps.manifestPath}".`,
    );
  }

  const now = deps.now ?? Date.now;
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

  // Lazily-loaded, in-memory manifest shared across adopt ops in this run, and
  // the one-shot state.json backup guard (firstStateWrite, ADR-0025 §4). The
  // guard object itself is SHARED across per-assistant calls when the CLI
  // injects one (Low2 fix) — a fresh, call-local guard otherwise.
  const manifestState: ManifestState = {
    manifest: undefined,
    backupGuard: deps.stateBackupGuard ?? { backedUp: false },
  };

  const outcomes: RepairOutcome[] = [];

  for (const op of granted) {
    try {
      outcomes.push(await interpret(op, adapter, deps, manifestState, now, maxAgeMs));
    } catch (err) {
      // One op's failure never aborts the rest (each repair is independent) —
      // the CLI maps any `failed` to exit 1 regardless of order.
      outcomes.push({ status: 'failed', op, error: errorMessage(err) });
    }
  }

  return outcomes;
}

// ---------------------------------------------------------------------------
// Per-kind interpretation
// ---------------------------------------------------------------------------

interface ManifestState {
  manifest: Manifest | undefined;
  /** Shared across per-assistant `applyRepairs` calls when injected (Low2 fix). */
  backupGuard: { backedUp: boolean };
}

async function interpret(
  op: RepairOp,
  adapter: Adapter,
  deps: ApplyRepairsDeps,
  manifestState: ManifestState,
  now: () => number,
  maxAgeMs: number,
): Promise<RepairOutcome> {
  switch (op.kind) {
    case 'adopt':
      return adopt(op, adapter, deps, manifestState);
    case 'remove-store':
      return removeStore(op, deps);
    case 'unlink-dangling':
      return unlinkDangling(op);
    case 'delete-residue':
      return deleteResidue(op, now, maxAgeMs);
    case 'delete-bak':
      return deleteBak(op);
    case 'backup-state':
      return backupState(op);
    case 'break-lock':
      return breakLockNotHere(op);
    default:
      return assertNever(op);
  }
}

// --- adopt (R5) -------------------------------------------------------------

async function adopt(
  op: RepairOpAdopt,
  adapter: Adapter,
  deps: ApplyRepairsDeps,
  manifestState: ManifestState,
): Promise<RepairOutcome> {
  if (adapter.adopt === undefined) {
    return { status: 'skipped', op, reason: `adapter "${adapter.id}" does not support adoption` };
  }

  // Requalify the id against the configured catalogs (R5) — never guess.
  const resolution = await deps.resolveAdoptionId(op.candidateId);
  if (resolution.kind === 'ambiguous') {
    return {
      status: 'skipped',
      op,
      reason: `id "${op.candidateId}" is offered by more than one configured catalog — `
        + 'skipped in non-interactive mode (adopting under the wrong id would arm '
        + 'update/remove on the wrong canonical).',
    };
  }
  const recordedId = resolution.kind === 'unique' ? resolution.id : op.candidateId;

  // Present-strict re-check AT ACT TIME: adapter.adopt returns undefined for
  // anything but a strictly-`present` audit (drift, divergent, partial) — the
  // manifest must never claim content rigger did not put there (ADR-0016 red
  // line). This is the TOCTOU guard for adoption; it is `adapter.adopt`,
  // unchanged, no `--force`.
  const entry: AdapterEntry = { id: recordedId, nature: op.nature, scope: op.scope };
  const adoption = await adapter.adopt(entry, op.scope, deps.env);
  if (adoption === undefined) {
    return {
      status: 'skipped',
      op,
      reason: `"${recordedId}" is no longer strictly present on disk — `
        + 'present-strict adoption refused (drift / divergent / partial).',
    };
  }

  // First manifest mutation of the run → back up state.json ONCE, before the
  // write (firstStateWrite, ADR-0025 §4 — the first path in the repo to do so).
  if (manifestState.manifest === undefined) {
    manifestState.manifest = await readManifest(deps.manifestPath);
  }
  if (!manifestState.backupGuard.backedUp) {
    await backup(deps.manifestPath);
    manifestState.backupGuard.backedUp = true;
  }

  const manifestEntry = buildAdoptedEntry(recordedId, op, adoption.files, adoption.applied);
  manifestState.manifest = upsertEntry(manifestState.manifest, manifestEntry);
  await writeManifest(deps.manifestPath, manifestState.manifest);

  // Context adoption degrades reversibility: the on-disk block is the canonical
  // posted by an earlier install, NOT the user's pre-install baseline, so the
  // adapter records no `previous` (adapter.ts FM6) and remove will degrade to
  // delete-on-exact-match. Surface it so the CLI never presents context
  // adoption as a complete repair (R5 "adoption context — dégradation affichée").
  const detail = op.nature === 'context'
    ? `adopted "${recordedId}" WITHOUT a restore baseline — remove will degrade to `
      + 'delete-on-exact-match ("no restore baseline").'
    : `adopted "${recordedId}".`;

  return { status: 'repaired', op, detail };
}

/**
 * Build the ManifestEntry an adoption records. Mirrors the engine's
 * `buildManifestEntry` defaults verbatim (that helper is module-private in
 * engine.ts): doctor never knows a catalog version, so ref/sha are ALWAYS the
 * defaults (`v0.0.0` / empty) — R2's missing-sha audit flags it next run
 * (R5 "adoption sous defaults ... signalée en R2").
 */
function buildAdoptedEntry(
  id: string,
  op: RepairOpAdopt,
  files: string[],
  applied: ManifestEntry['applied'],
): ManifestEntry {
  const base: ManifestEntry = {
    id,
    nature: op.nature,
    ref: 'v0.0.0',
    sha: '',
    scope: op.scope,
    installedAt: new Date().toISOString(),
    files,
    assistant: op.assistant,
  };
  return applied === undefined ? base : { ...base, applied };
}

// --- remove-store (R4) ------------------------------------------------------

/** The (unchanging) refusal reason for both the pre-check and the final gate below. */
const REMOVE_STORE_TOCTOU_REASON = 'a live referent appeared between diagnosis and action — '
  + 'store kept (removeStoreIfUnreferenced refused).';

async function removeStore(
  op: RepairOpRemoveStore,
  deps: ApplyRepairsDeps,
): Promise<RepairOutcome> {
  // Fresh referent enumeration at ACT time (R4 TOCTOU) — path-aware, injected.
  const referents = await deps.enumerateStoreReferents(op.store);

  // Pre-backup TOCTOU re-check (Low1 fix): reuse the SAME primitive
  // `removeStoreIfUnreferenced` calls internally (`resolvesToStore`) to refuse
  // BEFORE touching disk when a referent has already appeared — a store we
  // are not going to remove must never be backed up, or its `.bak` becomes an
  // orphaned residue sitting next to a store that is still alive and in use.
  for (const candidate of referents) {
    if (await resolvesToStore(candidate, op.store)) {
      return { status: 'skipped', op, reason: REMOVE_STORE_TOCTOU_REASON };
    }
  }

  // Backup-first (ADR-0025 §4): a phantom store may be the sole copy of user
  // edits made through the install symlink — copy the whole tree before the rm.
  const backupPath = await backupDir(op.store);

  // removeStoreIfUnreferenced remains the act's actual precondition (ADR-0025
  // §3) — it re-tests `resolvesToStore` on each referent ONE LAST TIME,
  // immediately before the rm. A referent appearing in the sub-millisecond
  // window between the pre-check above and this call is vanishingly unlikely
  // but still handled correctly: the backup just made is removed so no
  // orphaned `.bak` survives a refusal reached through EITHER gate.
  const removed = await removeStoreIfUnreferenced(op.store, referents);
  if (!removed) {
    if (backupPath !== null) {
      await rm(backupPath, { recursive: true, force: true });
    }
    return { status: 'skipped', op, reason: REMOVE_STORE_TOCTOU_REASON };
  }

  return {
    status: 'repaired',
    op,
    detail: backupPath === null
      ? `removed "${op.store}" (nothing to back up).`
      : `removed "${op.store}" (backed up to "${backupPath}").`,
  };
}

// --- unlink-dangling (R3) ---------------------------------------------------

async function unlinkDangling(op: RepairOpUnlinkDangling): Promise<RepairOutcome> {
  // Micro-re-check owned by the interpreter (no engine primitive re-tests this):
  // the target must STILL be a dangling symlink at act time.
  const lst = await lstat(op.target).catch(() => null);
  if (lst === null) {
    // Already gone — the dangling link was removed since diagnosis (idempotent).
    return { status: 'repaired', op, detail: `"${op.target}" was already gone.` };
  }
  if (!lst.isSymbolicLink()) {
    return {
      status: 'skipped',
      op,
      reason: `"${op.target}" is no longer a symlink — refusing to remove a real entry.`,
    };
  }
  // stat() follows the link: non-null means it now resolves — a referent
  // (re-install, hand re-link) appeared; it is no longer dangling.
  const resolved = await stat(op.target).catch(() => null);
  if (resolved !== null) {
    return {
      status: 'skipped',
      op,
      reason: `"${op.target}" now resolves to an existing target — no longer dangling.`,
    };
  }

  await unlinkTarget(op.target);
  return { status: 'repaired', op, detail: `unlinked dangling symlink "${op.target}".` };
}

// --- delete-residue (R6 .stale / R7 .tmp + checkout) ------------------------

async function deleteResidue(
  op: RepairOpDeleteResidue,
  now: () => number,
  maxAgeMs: number,
): Promise<RepairOutcome> {
  const base = path.basename(op.path);
  const st = await lstat(op.path).catch(() => null);
  if (st === null) {
    return { status: 'repaired', op, detail: `"${op.path}" was already gone.` };
  }

  const isStale = STALE_SUFFIX_RE.test(base);
  const isAgeGated = TMP_SUFFIX_RE.test(base) || base.startsWith(CATALOG_CHECKOUT_PREFIX);

  if (!isStale && !isAgeGated) {
    return {
      status: 'skipped',
      op,
      reason: `"${op.path}" no longer matches a residue pattern — refusing to delete.`,
    };
  }

  // Age re-check for the age-gated patterns (.stale is never re-read by
  // construction, so it carries no age gate — R6). A residue that got YOUNGER
  // than the threshold since diagnosis (a freshly re-created staging file) is
  // refused: never delete an in-flight write.
  if (isAgeGated) {
    const ageMs = now() - st.mtimeMs;
    if (ageMs <= maxAgeMs) {
      return {
        status: 'skipped',
        op,
        reason: `"${op.path}" is now younger than the age threshold — `
          + 'refusing to delete a possibly in-flight residue.',
      };
    }
  }

  await rm(op.path, { recursive: true, force: true });
  return { status: 'repaired', op, detail: `deleted residue "${op.path}".` };
}

// --- delete-bak (R7) --------------------------------------------------------

async function deleteBak(op: RepairOpDeleteBak): Promise<RepairOutcome> {
  const base = path.basename(op.path);
  const st = await lstat(op.path).catch(() => null);
  if (st === null) {
    return { status: 'repaired', op, detail: `"${op.path}" was already gone.` };
  }
  // Re-verify the pattern at act time: a `.bak` is ADR-0016's reversibility net;
  // refuse to delete anything whose name is no longer a `.bak-*` sibling.
  if (!BAK_SUFFIX_RE.test(base)) {
    return {
      status: 'skipped',
      op,
      reason: `"${op.path}" is no longer a .bak sibling — refusing to delete.`,
    };
  }

  await rm(op.path, { recursive: true, force: true });
  return { status: 'repaired', op, detail: `deleted aged backup "${op.path}".` };
}

// --- backup-state (R8 salvage) ----------------------------------------------

async function backupState(op: RepairOpBackupState): Promise<RepairOutcome> {
  // A pure byte-copy — never destructive, never mutates state.json (so it does
  // NOT trip the firstStateWrite guard). Replaces the old "delete the file to
  // start fresh" advice on a malformed manifest (R8 salvage).
  const backupPath = await backup(op.path);
  if (backupPath === null) {
    return { status: 'skipped', op, reason: `"${op.path}" does not exist — nothing to back up.` };
  }
  return { status: 'repaired', op, detail: `backed up "${op.path}" to "${backupPath}".` };
}

// --- break-lock (never here) ------------------------------------------------

function breakLockNotHere(op: RepairOpBreakLock): RepairOutcome {
  // break-lock's subject IS the run-lock, so it cannot run under the held lock:
  // the CLI breaks it PRE-acquire (ADR-0025 §7 "2 temps"). Reaching here means a
  // routing bug — report it as a skip rather than execute it under the lock.
  return {
    status: 'skipped',
    op,
    reason: `break-lock for "${op.lockPath}" must be handled pre-acquire by the CLI (2-temps), `
      + 'never under the held run-lock — not executed here.',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
