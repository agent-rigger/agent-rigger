import type { ArtifactEntry, CatalogEntry } from './schema';

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Thrown when an id (selected, required, or member) is absent from the catalog. */
export class UnknownEntryError extends Error {
  readonly unknownId: string;

  constructor(id: string) {
    super(`Unknown catalog entry: "${id}"`);
    this.name = 'UnknownEntryError';
    this.unknownId = id;
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
 * - `visited`  Set of ids already emitted — guards dedup.
 * - `stack`    Set of ids currently on the DFS path — guards cycle detection.
 * - `out`      Accumulator; artifacts pushed in post-order (deps-first).
 */
function visit(
  id: string,
  index: Index,
  visited: Set<string>,
  stack: Set<string>,
  out: ArtifactEntry[],
): void {
  if (visited.has(id)) return;

  if (stack.has(id)) {
    throw new DependencyCycleError([...stack, id]);
  }

  const entry = index.get(id);
  if (entry === undefined) {
    throw new UnknownEntryError(id);
  }

  stack.add(id);

  if (entry.kind === 'pack') {
    // Develop pack members recursively; packs are NOT emitted.
    for (const memberId of entry.members) {
      visit(memberId, index, visited, stack, out);
    }
    // Also follow pack-level requires (can point to artifacts or packs).
    for (const reqId of entry.requires ?? []) {
      visit(reqId, index, visited, stack, out);
    }
  } else {
    // Artifact: first resolve requires (deps-first order).
    for (const reqId of entry.requires ?? []) {
      visit(reqId, index, visited, stack, out);
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
 */
export function resolve(selectedIds: string[], catalog: CatalogEntry[]): ArtifactEntry[] {
  const index = buildIndex(catalog);
  const visited = new Set<string>();
  const out: ArtifactEntry[] = [];

  for (const id of selectedIds) {
    const stack = new Set<string>();
    visit(id, index, visited, stack, out);
  }

  return out;
}
