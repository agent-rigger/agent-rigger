/**
 * Adapter interface for agent-rigger.
 *
 * The engine (core/engine.ts) is assistant-agnostic: it orchestrates through
 * this interface. Concrete adapters live in packages/adapters/. The core
 * package knows nothing about Claude, OpenCode, or Copilot specifics.
 *
 * Invariants:
 * - `audit` and `plan` are read-only: they MUST NOT write to the filesystem.
 * - `apply` performs the actual writes; backup is the engine's responsibility.
 * - All three methods receive the injectable `env` for HOME isolation.
 * - No process.exit() calls; errors propagate as typed exceptions.
 * - No while loops; async operations use Promise.all / for...of / map.
 */

import type { Env } from './paths';
import type { AppliedPayload, NatureReport, RemovalOp, Scope, WriteOp } from './types';

/**
 * An installable artifact entry passed to the adapter methods.
 * Mirrors the catalog entry shape that the engine receives; kept minimal
 * here (core does not depend on packages/catalog).
 *
 * `applied` is set by the engine when calling planRemove / audit so that
 * handlers can reconstruct the canonical state from the manifest payload
 * instead of reading from an external artifacts directory.
 * Absent on legacy entries installed before B-iii.
 */
export interface AdapterEntry {
  id: string;
  nature: NatureReport['nature'];
  scope: Scope;
  /** Applied payload from the manifest (set by the engine for remove/check). */
  applied?: AppliedPayload;
}

/**
 * Result of a successful adoption (R5/D5).
 *
 * Returned by Adapter.adopt when the artifact is already conforming on disk
 * (its audit is strictly `present`) so the engine can record a manifest entry
 * WITHOUT any disk write — the sole convergence path out of the "installed but
 * unrecorded" state (M4, typically after a manifest loss). The engine builds
 * the ManifestEntry from these fields exactly as a fresh install would.
 *
 * - `applied`: the canonical AppliedPayload (the COMPLETE trace, not a delta) so
 *   a later remove/check reverses against it. Absent for natures with no
 *   payload (plugins are delegated to the native CLI — nothing to reverse
 *   offline). NEVER carries a context `previous` baseline (FM6): the on-disk
 *   content is the canonical posted by an earlier install, not a user's
 *   pre-install state, so recording it would make remove "restore" the
 *   canonical forever instead of uninstalling.
 * - `files`: the target paths the manifest entry claims (ManifestEntry.files) —
 *   the store refcount / shared-file candidates for remove.
 */
export interface AdoptionResult {
  /** Canonical applied payload; absent for payload-less natures (plugin). */
  applied?: AppliedPayload;
  /** Target paths recorded as ManifestEntry.files. */
  files: string[];
}

/**
 * The Adapter interface — one implementation per supported assistant.
 *
 * M0 registers only 'claude'. 'opencode' and 'copilot' are reserved identifiers
 * for future adapters (open/closed principle).
 *
 * Method contracts:
 *
 * ### audit(entry, scope, env): Promise<NatureReport>
 * Inspect the filesystem and return the current state of the artifact.
 * - 'missing': artifact not installed; check will exit 3.
 * - 'present': installed and matches expectations; check exits 0.
 * - 'drift':   installed but diverged (file modified / sha mismatch); check exits 3.
 * MUST NOT write to the filesystem.
 *
 * ### plan(entry, scope, env): Promise<WriteOp[]>
 * Compute the write operations needed to install/repair the artifact.
 * Returns an empty array if the artifact is already up-to-date (idempotence).
 * MUST NOT write to the filesystem — this is a pure planning step used for
 * the dry-run diff display before the user confirms.
 *
 * ### apply(ops, env): Promise<void>
 * Execute the write operations produced by plan(). The engine handles backup
 * before calling apply; this method only performs the actual writes.
 *
 * ### planRemove(entry, scope, env): Promise<RemovalOp[]>
 * Compute the removal operations needed to uninstall the artifact.
 * Returns an empty array if the artifact is not currently installed (idempotence).
 * This is the read-only counterpart to plan() — used for the dry-run diff display
 * before the user confirms removal.
 * MUST NOT write to the filesystem.
 *
 * ### applyRemove(ops, env, manifestFiles?): Promise<void>
 * Execute the removal operations produced by planRemove(). The engine handles
 * backup before calling applyRemove; this method only performs the actual removals.
 * This is the inverse of apply().
 */
export interface Adapter {
  /** Identifier for the target assistant. */
  readonly id: 'claude' | 'opencode' | 'copilot';

  /**
   * Audit the current state of an artifact on disk.
   * Read-only — no filesystem mutations.
   *
   * @param entry  The artifact to audit.
   * @param scope  Installation scope ('user' | 'project').
   * @param env    Injectable env for HOME resolution (RIGGER_HOME override).
   * @returns      NatureReport with state 'missing' | 'present' | 'drift'.
   */
  audit(entry: AdapterEntry, scope: Scope, env: Env): Promise<NatureReport>;

  /**
   * Compute the write operations needed to install/repair the artifact.
   * Read-only — no filesystem mutations.
   *
   * @param entry  The artifact to plan for.
   * @param scope  Installation scope.
   * @param env    Injectable env for HOME resolution.
   * @returns      Array of WriteOps (empty when artifact is already up-to-date).
   */
  plan(entry: AdapterEntry, scope: Scope, env: Env): Promise<WriteOp[]>;

  /**
   * Execute the provided write operations.
   * Called by the engine AFTER it has performed backups.
   *
   * @param ops  Write operations produced by plan().
   * @param env  Injectable env for HOME resolution.
   */
  apply(ops: WriteOp[], env: Env): Promise<void>;

  /**
   * Compute the removal operations needed to uninstall the artifact.
   * Read-only — no filesystem mutations.
   *
   * Returns an empty array if the artifact is not currently installed.
   * This is the logical inverse of plan().
   *
   * @param entry  The artifact to plan removal for.
   * @param scope  Installation scope.
   * @param env    Injectable env for HOME resolution.
   * @returns      Array of RemovalOps (empty when artifact is not installed).
   */
  planRemove(entry: AdapterEntry, scope: Scope, env: Env): Promise<RemovalOp[]>;

  /**
   * Execute the provided removal operations.
   * Called by the engine AFTER it has performed backups.
   *
   * This is the logical inverse of apply().
   *
   * @param ops  Removal operations produced by planRemove().
   * @param env  Injectable env for HOME resolution.
   * @param manifestFiles  Optional (R4): target paths (`ManifestEntry.files`)
   *                       of the entries REMAINING in the manifest after the
   *                       current removal. Opaque to core — the engine only
   *                       transports them; adapters use them as extra store
   *                       reference candidates (a project-scope symlink
   *                       installed from another cwd is only discoverable
   *                       through the manifest, ADR-0020 §3).
   */
  applyRemove(ops: RemovalOp[], env: Env, manifestFiles?: string[]): Promise<void>;

  /**
   * Adopt an artifact that is already conforming on disk but absent from the
   * manifest (R5/D5). OPTIONAL — an adapter that does not implement it never
   * adopts (the engine keeps the empty-plan no-op), and test fakes stay valid
   * without it.
   *
   * Called by the engine ONLY in the empty-plan branch of apply() and ONLY when
   * the manifest has NO record for (id, scope, this assistant): a non-empty plan
   * means the artifact is not yet conforming (install proceeds normally), and an
   * existing record means it is already tracked (idempotent no-op).
   *
   * Contract — the gate is per-nature and STRICT:
   * - return an AdoptionResult ONLY when the artifact's audit is exactly
   *   `present` (canonical content fully on disk). Any other state — `drift`,
   *   a divergent config, a partial install — MUST return `undefined` (refuse):
   *   the manifest must never claim content rigger did not put there, otherwise
   *   remove would destroy the user's work.
   * - MUST be read-only: no filesystem writes (the engine persists only
   *   state.json, from the returned payload).
   *
   * @param entry  The artifact to consider for adoption.
   * @param scope  Installation scope.
   * @param env    Injectable env for HOME resolution.
   * @returns      AdoptionResult when adoptable, `undefined` to refuse.
   */
  adopt?(entry: AdapterEntry, scope: Scope, env: Env): Promise<AdoptionResult | undefined>;
}
