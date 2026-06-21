/**
 * Adapter interface for agent-rigger (design.md §3, ADR-0002).
 *
 * The engine (core/engine.ts) is assistant-agnostic: it orchestrates through
 * this interface. Concrete adapters live in packages/adapters/. The core
 * package knows nothing about Claude, OpenCode, or Copilot specifics.
 *
 * Design invariants:
 * - `audit` and `plan` are read-only: they MUST NOT write to the filesystem.
 * - `apply` performs the actual writes; backup is the engine's responsibility.
 * - All three methods receive the injectable `env` for HOME isolation (R12.1).
 * - No process.exit() calls; errors propagate as typed exceptions.
 * - No while loops; async operations use Promise.all / for...of / map.
 */

import type { Env } from './paths';
import type { NatureReport, Scope, WriteOp } from './types';

/**
 * An installable artifact entry passed to the adapter methods.
 * Mirrors the catalog entry shape that the engine receives; kept minimal
 * here (core does not depend on packages/catalog).
 */
export interface AdapterEntry {
  id: string;
  nature: NatureReport['nature'];
  scope: Scope;
}

/**
 * The Adapter interface — one implementation per supported assistant.
 *
 * M0 registers only 'claude'. 'opencode' and 'copilot' are reserved identifiers
 * for future adapters (open/closed principle, ADR-0002).
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
}
