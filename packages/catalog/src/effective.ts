/**
 * effective.ts — merge base ∪ remote catalog entries, fold N sources.
 *
 * Responsibilities:
 * - Merge two CatalogEntry arrays, base entries taking priority on id collision.
 * - Detect and report conflicts (ids present in both base and remote).
 * - Deduplicate entries within the remote array by id (first occurrence wins).
 * - Fold N sources into a single EffectiveCatalog via foldCatalogs.
 *
 * Constraints:
 * - Pure functions — no side effects, no I/O.
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
// Internal helper — mergeTwo
// ---------------------------------------------------------------------------

/**
 * Merges two entry arrays (base + incoming) into a running EffectiveCatalog.
 *
 * - `knownIds`: set of ids already present in the accumulated result (base).
 * - `base`: the already-accumulated entries array (passed through as-is).
 * - `incoming`: the next source entries to fold in.
 *
 * Returns the merged result accumulating new conflicts on top of existing ones.
 *
 * This is the shared primitive used by both `mergeCatalogs` and `foldCatalogs`.
 */
function mergeTwo(
  base: CatalogEntry[],
  baseIds: ReadonlySet<string>,
  incoming: CatalogEntry[],
  priorConflicts: string[],
): EffectiveCatalog {
  const newConflicts: string[] = incoming
    .filter((e) => baseIds.has(e.id))
    .map((e) => e.id);

  const seenIncomingIds = new Set<string>();
  const incomingOnlyDeduped = incoming.filter((e) => {
    if (baseIds.has(e.id)) return false;
    if (seenIncomingIds.has(e.id)) return false;
    seenIncomingIds.add(e.id);
    return true;
  });

  return {
    entries: [...base, ...incomingOnlyDeduped],
    conflicts: [...priorConflicts, ...newConflicts],
  };
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
  return mergeTwo(base, new Set(base.map((e) => e.id)), remote, []);
}

// ---------------------------------------------------------------------------
// foldCatalogs — pure, N sources
// ---------------------------------------------------------------------------

/**
 * Fold N sources into a single EffectiveCatalog.
 *
 * Sources are folded in order: the first source sets the initial ids;
 * each subsequent source only adds entries whose ids are not yet present.
 * An id already present (collision) is discarded and goes into `conflicts`.
 *
 * ADR-0017 §3: ids are already fully-qualified upstream (M2). Collision means
 * the exact same qualified id appears in two sources (true duplicate, e.g. the
 * same catalog added twice). Homonyms across catalogs have different prefixes
 * → different ids → no collision.
 *
 * - sources = []    → { entries: [], conflicts: [] }
 * - sources = [a]   → { entries: deduped(a), conflicts: [] }
 */
export function foldCatalogs(sources: CatalogEntry[][]): EffectiveCatalog {
  return sources.reduce<EffectiveCatalog>(
    (acc, incoming) => {
      const accIds = new Set(acc.entries.map((e) => e.id));
      return mergeTwo(acc.entries, accIds, incoming, acc.conflicts);
    },
    { entries: [], conflicts: [] },
  );
}
