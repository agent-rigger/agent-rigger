import { localId } from './qualify';
import type { ArtifactEntry, CatalogEntry } from './schema';

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/**
 * Thrown when an id (selected, required, or member) is absent from the catalog.
 *
 * `requiredBy` (R3/D3, lot 6) is the DFS chain from the top-level selection
 * down to (but excluding) the missing id — the SAME stack `DependencyCycleError`
 * already captures for its `cyclePath`. Empty when the missing id was itself a
 * top-level selection (no requirer to name).
 */
export class UnknownEntryError extends Error {
  readonly unknownId: string;
  readonly requiredBy: string[];

  constructor(id: string, requiredBy: string[] = []) {
    const chain = requiredBy.length > 0 ? ` (required by: ${requiredBy.join(' -> ')})` : '';
    super(`Unknown catalog entry: "${id}"${chain}`);
    this.name = 'UnknownEntryError';
    this.unknownId = id;
    this.requiredBy = requiredBy;
  }
}

/** Thrown when a dependency cycle is detected during resolution. */
export class DependencyCycleError extends Error {
  readonly cyclePath: string[];

  constructor(path: string[]) {
    super(`Dependency cycle detected: ${path.join(' → ')}`);
    this.name = 'DependencyCycleError';
    this.cyclePath = path;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type Index = Map<string, CatalogEntry>;

function buildIndex(catalog: CatalogEntry[]): Index {
  const index = new Map<string, CatalogEntry>();
  for (const entry of catalog) {
    index.set(entry.id, entry);
  }
  return index;
}

/**
 * DFS post-order visitor.
 *
 * - `visited`             Set of ids already emitted — guards dedup.
 * - `stack`               Set of ids currently on the DFS path — guards cycle detection.
 * - `out`                 Accumulator; artifacts pushed in post-order (deps-first).
 * - `externallySatisfied` (R3/D3, lot 6) ids the caller has already proven are
 *   installed elsewhere (a cross-catalogue require satisfied by the manifest).
 *   Skipped outright — no lookup, no throw, no traversal — since a foreign id
 *   is expected to be absent from THIS catalog's index by construction.
 */
function visit(
  id: string,
  index: Index,
  visited: Set<string>,
  stack: Set<string>,
  out: ArtifactEntry[],
  externallySatisfied: Set<string>,
): void {
  if (visited.has(id)) return;
  if (externallySatisfied.has(id)) return;

  if (stack.has(id)) {
    throw new DependencyCycleError([...stack, id]);
  }

  const entry = index.get(id);
  if (entry === undefined) {
    throw new UnknownEntryError(id, [...stack]);
  }

  stack.add(id);

  if (entry.kind === 'pack') {
    // Develop pack members recursively; packs are NOT emitted.
    for (const memberId of entry.members) {
      visit(memberId, index, visited, stack, out, externallySatisfied);
    }
    // Also follow pack-level requires (can point to artifacts or packs).
    for (const reqId of entry.requires ?? []) {
      visit(reqId, index, visited, stack, out, externallySatisfied);
    }
  } else {
    // Artifact: first resolve requires (deps-first order).
    for (const reqId of entry.requires ?? []) {
      visit(reqId, index, visited, stack, out, externallySatisfied);
    }
    // Post-order: emit after all deps are in.
    if (!visited.has(id)) {
      out.push(entry);
      visited.add(id);
    }
  }

  stack.delete(id);

  // Mark packs as visited so they are not re-expanded on subsequent selections.
  if (entry.kind === 'pack') {
    visited.add(id);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a list of selected catalog ids into the complete set of
 * ArtifactEntry values that must be installed.
 *
 * Packs are expanded to their members (recursively).
 * `requires` edges are followed transitively.
 * Output is deduplicated by id and ordered deps-first (post-order DFS).
 *
 * @param externallySatisfied (R3/D3, lot 6) ids to skip outright — a
 *   cross-catalogue require the caller has already confirmed is installed
 *   elsewhere (via `findEntry` against the manifest). Defaults to empty, so
 *   existing single-catalogue callers are unaffected.
 */
export function resolve(
  selectedIds: string[],
  catalog: CatalogEntry[],
  externallySatisfied: Set<string> = new Set(),
): ArtifactEntry[] {
  const index = buildIndex(catalog);
  const visited = new Set<string>();
  const out: ArtifactEntry[] = [];

  for (const id of selectedIds) {
    const stack = new Set<string>();
    visit(id, index, visited, stack, out, externallySatisfied);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Cross-catalogue requires (R3/D3, lot 6)
// ---------------------------------------------------------------------------

/**
 * One `requires` ref, reachable from the selection, that points at a
 * DIFFERENT catalogue than `sourceName` — a `/`-qualified ref whose prefix
 * isn't this catalogue's own name.
 */
export interface ForeignRequire {
  /** The foreign ref exactly as it appears in the local catalog's `requires[]`. */
  ref: string;
  /**
   * DFS chain from the top-level selection down to (and including) the entry
   * that declares `ref` — same shape as `DependencyCycleError.cyclePath` /
   * `UnknownEntryError.requiredBy`.
   */
  requiredBy: string[];
}

/**
 * Returns the catalogue prefix of a qualified ref (`<name>/<id>` → `<name>`),
 * or `undefined` when `ref` is unqualified (local). Derived from `localId`
 * (the qualification seam, ADR-0017 §1) — never a standalone slash-index
 * heuristic of its own.
 */
export function catalogPrefixOf(ref: string): string | undefined {
  const local = localId(ref);
  return local === ref ? undefined : ref.slice(0, ref.length - local.length - 1);
}

/**
 * Walk `selectedIds` through `catalog` (packs expanded, requires followed)
 * and collect every `requires` ref whose catalogue prefix differs from
 * `sourceName` — WITHOUT throwing (unlike `resolve`/`visit`): a foreign ref
 * is EXPECTED to be absent from `catalog` (a single-catalogue index), so it
 * is a leaf here rather than an error.
 *
 * A local ref that is genuinely missing (same prefix, or unqualified — a
 * typo) is left untouched: `resolve()` still throws its own
 * `requiredBy`-enriched `UnknownEntryError` for it.
 *
 * R3/D3 pre-pass: callers (remote-install.ts, cmd-update.ts) partition this
 * result by manifest presence (`findEntry`) BEFORE calling `resolve()` — a
 * satisfied foreign require is pruned via `externallySatisfied`; an absent
 * one fails with an actionable message before any resolution/writes happen.
 */
export function collectForeignRequires(
  selectedIds: string[],
  catalog: CatalogEntry[],
  sourceName: string,
): ForeignRequire[] {
  const index = buildIndex(catalog);
  const visited = new Set<string>();
  const foreign: ForeignRequire[] = [];

  const isForeign = (ref: string): boolean => {
    const prefix = catalogPrefixOf(ref);
    return prefix !== undefined && prefix !== sourceName;
  };

  const walk = (id: string, stack: string[]): void => {
    if (visited.has(id)) return;
    const entry = index.get(id);
    if (entry === undefined) return;
    visited.add(id);
    const nextStack = [...stack, id];

    for (const ref of entry.requires ?? []) {
      if (isForeign(ref)) {
        foreign.push({ ref, requiredBy: nextStack });
      } else {
        walk(ref, nextStack);
      }
    }

    if (entry.kind === 'pack') {
      for (const memberId of entry.members) {
        walk(memberId, nextStack);
      }
    }
  };

  for (const id of selectedIds) {
    walk(id, []);
  }

  return foreign;
}
