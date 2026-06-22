/**
 * effective.ts — merge base ∪ remote catalog entries.
 *
 * Responsibilities:
 * - Merge two CatalogEntry arrays, base entries taking priority on id collision.
 * - Detect and report conflicts (ids present in both base and remote).
 * - Deduplicate entries within the remote array by id (first occurrence wins).
 *
 * Constraints:
 * - Pure function — no side effects, no I/O.
 * - No while loops.
 * - No process.exit.
 */

import type { CatalogEntry } from './schema';

// ---------------------------------------------------------------------------
// EffectiveCatalog
// ---------------------------------------------------------------------------

export interface EffectiveCatalog {
  /** base entries first, then remote-only entries (deduped). */
  entries: CatalogEntry[];
  /** Ids present in BOTH base and remote — base entry kept, remote entry discarded. */
  conflicts: string[];
}

// ---------------------------------------------------------------------------
// mergeCatalogs — pure
// ---------------------------------------------------------------------------

/**
 * Merge base ∪ remote, base entries taking priority on id collision.
 *
 * The `base` parameter is always [] in the current single-catalog model
 * (reserved for a future multi-catalog composition scenario).
 *
 * - base entries are always preserved as-is.
 * - a remote entry whose id exists in base is DISCARDED; its id goes into `conflicts`.
 * - remaining remote entries are deduplicated by id (first occurrence wins).
 * - entries = [...base, ...remoteOnlyDeduped].
 */
export function mergeCatalogs(
  base: CatalogEntry[],
  remote: CatalogEntry[],
): EffectiveCatalog {
  const baseIds = new Set(base.map((e) => e.id));

  const conflicts: string[] = remote
    .filter((e) => baseIds.has(e.id))
    .map((e) => e.id);

  const seenRemoteIds = new Set<string>();
  const remoteOnlyDeduped = remote.filter((e) => {
    if (baseIds.has(e.id)) return false;
    if (seenRemoteIds.has(e.id)) return false;
    seenRemoteIds.add(e.id);
    return true;
  });

  return {
    entries: [...base, ...remoteOnlyDeduped],
    conflicts,
  };
}
