/**
 * Manifest helpers for agent-rigger.
 *
 * The manifest is the local source of truth of what is installed:
 *   ~/.config/agent-rigger/state.json
 *
 * Design invariants:
 * - readManifest never throws for an absent file (returns emptyManifest()).
 * - readManifest FAILS CLOSED on a present-but-top-level-invalid file: it throws
 *   MalformedManifestError instead of coercing to emptyManifest() and letting a
 *   later writeManifest overwrite the cumulated `applied` payloads and `previous`
 *   baselines (Lot 3 R3 / M2). The fail-closed frontier is TOP-LEVEL ONLY —
 *   entry-level shape stays tolerant (legacy entries with no `assistant`, no
 *   `applied`, a stray `source` field remain readable).
 * - upsertEntry is pure and immutable — never mutates its input.
 * - detectDrift checks file existence only (content/hash drift = B7).
 */

import { InvalidJsonError, writeJson } from './fs-json';
import type { Manifest, ManifestAssistant, ManifestEntry, Scope } from './types';

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

/**
 * Thrown by readManifest when a state.json file EXISTS but its top-level shape is
 * invalid: not a JSON object, `version` not the number 1, or `artifacts` not an
 * array. This is a fail-closed guard (Lot 3 R3): the manifest carries the source
 * of truth (cumulated `applied` payloads, `previous` restore baselines) and must
 * never be silently coerced to empty and then overwritten.
 *
 * The CLI maps this error to exit code 2. Never call process.exit() here — keep
 * the core testable and runtime-agnostic. Distinct from InvalidJsonError, which
 * covers syntactically broken JSON; MalformedManifestError is valid-JSON /
 * wrong-shape.
 */
export class MalformedManifestError extends Error {
  /** Absolute path of the malformed manifest file. */
  readonly path: string;
  /** Human-readable reason describing which top-level invariant was violated. */
  readonly reason: string;

  constructor(filePath: string, reason: string) {
    super(`Malformed manifest at "${filePath}": ${reason}`);
    this.name = 'MalformedManifestError';
    this.path = filePath;
    this.reason = reason;
  }
}

/**
 * The assistant an entry belongs to, defaulting legacy entries (written before
 * M3, with no `assistant` field) to 'claude'. Manifest identity is the triple
 * (id, scope, assistant): the same artifact can be installed for both claude and
 * opencode without one clobbering the other.
 *
 * The `?? 'claude'` fallback fires ONLY when `assistant` is absent (legacy
 * entries) — a PRESENT value is always returned verbatim, `'shared'` included
 * (S2, lib-nature): a lib entry always writes `assistant: 'shared'`, so it is
 * never silently coerced into the 'claude' bucket. This is what makes
 * `(id, scope, 'shared')` a stable global singleton identity for upsertEntry.
 */
function entryAssistant(entry: ManifestEntry): ManifestAssistant {
  return entry.assistant ?? 'claude';
}

// ---------------------------------------------------------------------------
// emptyManifest
// ---------------------------------------------------------------------------

/**
 * Returns a fresh, valid empty manifest.
 * Pure: each call produces a new object with no shared references.
 */
export function emptyManifest(): Manifest {
  return { version: 1, artifacts: [] };
}

// ---------------------------------------------------------------------------
// readManifest
// ---------------------------------------------------------------------------

/**
 * Read and parse the manifest at `filePath`.
 *
 * - File absent → emptyManifest() (no error; a fresh install has no state.json yet).
 * - File present + valid JSON with correct top-level shape → parsed manifest.
 * - File present + valid JSON but INVALID top-level shape (non-object, `version`
 *   not the number 1, or `artifacts` not an array) → throws MalformedManifestError
 *   (fail-closed; never coerce-then-overwrite, Lot 3 R3 / M2).
 * - File present + syntactically invalid JSON → throws InvalidJsonError
 *   (corrupted file is actionable by the caller / CLI exit 2).
 *
 * Existence is tested here directly (not delegated to readJson) because readJson
 * conflates an absent file and a top-level-non-object value (both → {}); R3 must
 * distinguish them: absent = fresh install (emptyManifest), present-non-object =
 * malformed (fail-closed). Entry-level tolerance is preserved: no per-entry
 * validation happens here (legacy entries stay readable).
 */
export async function readManifest(filePath: string): Promise<Manifest> {
  const file = Bun.file(filePath);
  const exists = await file.exists();

  // Absent → fresh install, never an error.
  if (!exists) {
    return emptyManifest();
  }

  // Present: parse. Syntactically broken JSON keeps its typed rejection.
  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch (cause) {
    throw new InvalidJsonError(filePath, cause);
  }

  // Top-level must be a plain object (not null, not an array).
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MalformedManifestError(
      filePath,
      'top-level value is not a JSON object (expected {"version":1,"artifacts":[...]})',
    );
  }

  const obj = parsed as Record<string, unknown>;
  const version = obj['version'];

  // `version` must be a number, and specifically 1 — a future schema bump will
  // require an explicit migration, not a silent coercion.
  if (typeof version !== 'number') {
    throw new MalformedManifestError(
      filePath,
      `"version" must be the number 1 (found ${typeof version})`,
    );
  }
  if (version !== 1) {
    throw new MalformedManifestError(
      filePath,
      `unsupported manifest version ${version} (expected 1)`,
    );
  }

  if (!Array.isArray(obj['artifacts'])) {
    throw new MalformedManifestError(filePath, '"artifacts" must be an array');
  }

  return parsed as unknown as Manifest;
}

// ---------------------------------------------------------------------------
// writeManifest
// ---------------------------------------------------------------------------

/**
 * Serialize and write the manifest to `filePath`.
 * Parent directories are created automatically (delegated to writeJson).
 */
export async function writeManifest(filePath: string, manifest: Manifest): Promise<void> {
  await writeJson(filePath, manifest);
}

// ---------------------------------------------------------------------------
// upsertEntry
// ---------------------------------------------------------------------------

/**
 * Return a new Manifest with `entry` inserted or replacing the existing entry
 * that shares the same `id` AND `scope`.
 *
 * Pure / immutable:
 * - The input `manifest` is not mutated.
 * - The returned manifest is a new object with a new artifacts array.
 * - Entries not matching (id, scope) are preserved in their original order.
 */
export function upsertEntry(manifest: Manifest, entry: ManifestEntry): Manifest {
  let replaced = false;
  const targetAssistant = entryAssistant(entry);

  const artifacts = manifest.artifacts.map((existing) => {
    if (
      existing.id === entry.id
      && existing.scope === entry.scope
      && entryAssistant(existing) === targetAssistant
    ) {
      replaced = true;
      return entry;
    }
    return existing;
  });

  return {
    ...manifest,
    artifacts: replaced ? artifacts : [...artifacts, entry],
  };
}

// ---------------------------------------------------------------------------
// findEntry
// ---------------------------------------------------------------------------

/**
 * Return the ManifestEntry matching both `id` and `scope`, or `undefined`.
 * Pure (no side effects).
 */
export function findEntry(
  manifest: Manifest,
  id: string,
  scope: Scope,
  assistant: ManifestAssistant = 'claude',
): ManifestEntry | undefined {
  return manifest.artifacts.find(
    (e) => e.id === id && e.scope === scope && entryAssistant(e) === assistant,
  );
}

// ---------------------------------------------------------------------------
// Lib singleton identity (S2, lib-nature) — the ONE place (id,'user','shared')
// is named, so no call site re-hardcodes the triple (adversarial-close F4).
// ---------------------------------------------------------------------------

/**
 * The scope every lib manifest entry is recorded under. A lib is scope-agnostic
 * (S2): it lives once, globally, regardless of which consumer transaction (any
 * scope, any assistant) pulled it in.
 */
export const LIB_SCOPE = 'user' as const satisfies Scope;

/**
 * The assistant sentinel every lib manifest entry is recorded under (S2): a lib
 * is depended upon, never routed to an adapter, so it carries no per-assistant
 * identity. Together with LIB_SCOPE this makes `(id, LIB_SCOPE, LIB_ASSISTANT)`
 * the stable global-singleton identity of a lib.
 */
export const LIB_ASSISTANT = 'shared' as const satisfies ManifestAssistant;

/**
 * The manifest identity triple of the lib `id` (S2) — the single assembly point
 * of the `(id, 'user', 'shared')` singleton, consumed by the engine's lib
 * materialise/remove channel (upsert/remove mutations).
 */
export function libManifestIdentity(
  id: string,
): { id: string; scope: Scope; assistant: ManifestAssistant } {
  return { id, scope: LIB_SCOPE, assistant: LIB_ASSISTANT };
}

/**
 * Find the installed lib entry for `id` at its singleton identity (S2), or
 * `undefined` when the lib is not installed. Thin, intentional wrapper over
 * findEntry so no call site re-hardcodes the `'user'`/`'shared'` literals.
 */
export function findLibEntry(manifest: Manifest, id: string): ManifestEntry | undefined {
  return findEntry(manifest, id, LIB_SCOPE, LIB_ASSISTANT);
}

// ---------------------------------------------------------------------------
// requiresIndex — the persisted requires graph, inverted
// ---------------------------------------------------------------------------

/**
 * Invert the persisted `requires` edges of `entries` into a map from a required
 * ref to the ids that require it (R5/R6/R7). The single primitive behind the
 * three requires-graph consumers — cmd-remove's refcount-block and GC-lib checks
 * and the doctor edge-integrity scanner — so "who still requires X" is computed
 * one way. Keys are the persisted require refs VERBATIM (qualified as stored, no
 * localId reduction) — the exact posture every consumer already took, so their
 * lookups match by the same string identity a lib's singleton entry carries.
 */
export function requiresIndex(entries: ManifestEntry[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const entry of entries) {
    for (const req of entry.requires ?? []) {
      const requirers = index.get(req) ?? new Set<string>();
      requirers.add(entry.id);
      index.set(req, requirers);
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// detectDrift
// ---------------------------------------------------------------------------

/**
 * Check whether the files declared in `entry.files` still exist on disk.
 *
 * Returns `{ missing }` where `missing` is the list of paths that are absent.
 * `missing.length > 0` means drift was detected.
 *
 * Scope of M0 drift detection: **existence only**.
 * Content/hash drift (modified files) is handled by the audit adapter (B7).
 */
export async function detectDrift(entry: ManifestEntry): Promise<{ missing: string[] }> {
  const checks = await Promise.all(
    entry.files.map(async (filePath) => {
      const exists = await Bun.file(filePath).exists();
      return exists ? null : filePath;
    }),
  );

  const missing = checks.filter((p): p is string => p !== null);
  return { missing };
}
