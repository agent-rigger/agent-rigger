/**
 * effective.ts — merge built-in ∪ remote catalog entries.
 *
 * Responsibilities:
 * - Merge two CatalogEntry arrays, built-in entries taking priority on id collision.
 * - Detect and report conflicts (ids present in both built-in and remote).
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
  /** built-in entries first, then remote-only entries (deduped). */
  entries: CatalogEntry[];
  /** Ids present in BOTH built-in and remote — built-in kept, remote shadowed. */
  conflicts: string[];
}

// ---------------------------------------------------------------------------
// mergeCatalogs — pure
// ---------------------------------------------------------------------------

/**
 * Merge built-in ∪ remote, built-in prioritaire.
 *
 * - built-in entries are always preserved as-is.
 * - a remote entry whose id exists in built-in is DISCARDED; its id goes into `conflicts`.
 * - remaining remote entries are deduplicated by id (first occurrence wins).
 * - entries = [...builtin, ...remoteOnlyDeduped].
 */
export function mergeCatalogs(
  builtin: CatalogEntry[],
  remote: CatalogEntry[],
): EffectiveCatalog {
  const builtinIds = new Set(builtin.map((e) => e.id));

  const conflicts: string[] = remote
    .filter((e) => builtinIds.has(e.id))
    .map((e) => e.id);

  const seenRemoteIds = new Set<string>();
  const remoteOnlyDeduped = remote.filter((e) => {
    if (builtinIds.has(e.id)) return false;
    if (seenRemoteIds.has(e.id)) return false;
    seenRemoteIds.add(e.id);
    return true;
  });

  return {
    entries: [...builtin, ...remoteOnlyDeduped],
    conflicts,
  };
}
