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

/** Dedup a ref list, preserving first-occurrence order. */
function dedupe(refs: readonly string[]): string[] {
  return [...new Set(refs)];
}

/**
 * DFS post-order visitor.
 *
 * - `packInherited`       Per-pack memo of the UNION of `inherited` sets already
 *   propagated through that pack. A pack is (re-)walked only while this set
 *   GROWS; once an `inherited` brings nothing new it short-circuits. The set
 *   grows monotonically, bounded by the number of distinct refs → the re-walk
 *   is polynomial, never the exponential blow-up a hostile deep-diamond pack
 *   graph would cause with unmemoised re-expansion.
 * - `emittedById`         Per-artifact memo of the emitted `ResolvedEntry`. An
 *   artifact is emitted ONCE (deps-first); a later re-visit UNIONs the new
 *   inherited into its stored requires in place — no re-emission.
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
  packInherited: Map<string, string[]>,
  emittedById: Map<string, ResolvedEntry>,
  stack: Set<string>,
  out: ResolvedEntry[],
  externallySatisfied: Set<string>,
  inherited: readonly string[],
): void {
  if (externallySatisfied.has(id)) return;

  // Already-emitted artifact re-reached via a DIFFERENT path (a diamond, or a
  // member shared — directly or through a pack — by two packs with divergent
  // pack-level requires). UNION the newly-inherited edges into its stored
  // requires rather than freezing them at the first emitter: over-retention is
  // always safe, under-retention would silently drop a real edge AND make the
  // persisted manifest order-dependent (a member of {pack:a, pack:b} must carry
  // both packs' requires regardless of selection order — review T2). No
  // re-emission, so deps-first order holds.
  const emitted = emittedById.get(id);
  if (emitted !== undefined) {
    if (inherited.length > 0) {
      emitted.requires = dedupe([...emitted.requires, ...inherited]);
    }
    return;
  }

  if (stack.has(id)) {
    throw new DependencyCycleError([...stack, id]);
  }

  const entry = index.get(id);
  if (entry === undefined) {
    throw new UnknownEntryError(id, [...stack]);
  }

  if (entry.kind === 'pack') {
    // Memoised union of every `inherited` this pack has propagated. Re-walk it
    // only when the current `inherited` GROWS that union — otherwise short-
    // circuit (this is the hostile-graph bound). On a growth, the members are
    // re-walked with the FULL union so an already-emitted artifact receives the
    // delta via emittedById (idempotent), and a nested pack grows its own memo
    // and re-propagates transitively.
    const prev = packInherited.get(id);
    const union = prev === undefined ? dedupe(inherited) : dedupe([...prev, ...inherited]);
    if (prev !== undefined && union.length === prev.length) {
      return;
    }
    packInherited.set(id, union);

    stack.add(id);
    // Pack-level requires propagate to every MEMBER (S4): a pack is never
    // emitted, so its requires must land on the artifacts it pulls in, on top of
    // the accumulated ancestor union.
    const memberInherited = dedupe([...union, ...(entry.requires ?? [])]);
    for (const memberId of entry.members) {
      visit(
        memberId,
        index,
        packInherited,
        emittedById,
        stack,
        out,
        externallySatisfied,
        memberInherited,
      );
    }
    // Pack-level requires are ALSO emitted as their own entries (they may point
    // at artifacts or packs). They are dependencies, not members, so they start
    // a fresh inheritance context — a pack requiring `lib:x` must not stamp a
    // self-edge onto `lib:x`.
    for (const reqId of entry.requires ?? []) {
      visit(reqId, index, packInherited, emittedById, stack, out, externallySatisfied, []);
    }
    stack.delete(id);
    return;
  }

  // Artifact: first resolve requires (deps-first order). A requires target is a
  // shared dependency emitted on its own, so it starts a fresh inheritance
  // context — pack requires attach to members, not transitively through requires
  // edges.
  stack.add(id);
  for (const reqId of entry.requires ?? []) {
    visit(reqId, index, packInherited, emittedById, stack, out, externallySatisfied, []);
  }
  stack.delete(id);

  // Post-order: emit after all deps are in. The resolved requires are the
  // entry's own declared requires PLUS every pack-inherited require, deduped
  // (own first). This is what T2 persists onto ManifestEntry.requires (S4). The
  // emittedById guard above makes this reachable only once per artifact.
  const resolved: ResolvedEntry = {
    entry,
    requires: dedupe([...(entry.requires ?? []), ...inherited]),
  };
  out.push(resolved);
  emittedById.set(id, resolved);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * An emitted artifact plus the requires edges to persist on it (S4, lib-nature
 * R5). `requires` is the entry's OWN declared requires plus every pack-level
 * requires inherited on the membership path that reached it — qualified and
 * stamped onto `ManifestEntry.requires` by the install path. A ref that appears
 * here may itself be pruned from the install graph (a cross-catalogue require
 * already satisfied) yet stays recorded on its requirer: the capture is
 * PRE-prune by construction, because it reads the raw resolution.
 */
export interface ResolvedEntry {
  entry: ArtifactEntry;
  requires: string[];
}

/**
 * Resolve a list of selected catalog ids into the emitted artifacts, each
 * paired with its resolved requires edges (its own declared requires plus any
 * pack-inherited ones — S4).
 *
 * Same graph walk as `resolve()` (packs expanded recursively, requires followed
 * transitively, output deduplicated by id and ordered deps-first): this is the
 * single owner of edge propagation (design §5, GATE DESIGN point 2), so no
 * second graph walk is duplicated CLI-side.
 *
 * @param externallySatisfied (R3/D3, lot 6) ids to skip outright — a
 *   cross-catalogue require already installed elsewhere. A skipped ref is not
 *   emitted, but stays present in the `requires` of whoever declared it (the
 *   PRE-prune capture, R5 cross-catalogue scenario). Defaults to empty.
 */
export function resolveWithEdges(
  selectedIds: string[],
  catalog: CatalogEntry[],
  externallySatisfied: Set<string> = new Set(),
): ResolvedEntry[] {
  const index = buildIndex(catalog);
  const packInherited = new Map<string, string[]>();
  const emittedById = new Map<string, ResolvedEntry>();
  const out: ResolvedEntry[] = [];

  for (const id of selectedIds) {
    const stack = new Set<string>();
    visit(id, index, packInherited, emittedById, stack, out, externallySatisfied, []);
  }

  return out;
}

/**
 * Resolve a list of selected catalog ids into the complete set of
 * ArtifactEntry values that must be installed.
 *
 * Packs are expanded to their members (recursively).
 * `requires` edges are followed transitively.
 * Output is deduplicated by id and ordered deps-first (post-order DFS).
 *
 * Re-derived from `resolveWithEdges` (drops the edges) so both contracts share
 * one graph walk — behaviour is unchanged and pinned by resolver.test.ts.
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
  return resolveWithEdges(selectedIds, catalog, externallySatisfied).map((r) => r.entry);
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
