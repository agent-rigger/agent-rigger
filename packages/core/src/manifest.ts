/**
 * Manifest helpers for agent-rigger.
 *
 * The manifest is the local source of truth of what is installed:
 *   ~/.config/agent-rigger/state.json
 *
 * Design invariants:
 * - readManifest never throws for an absent file (returns emptyManifest()).
 * - Malformed/incomplete JSON is coerced to emptyManifest() (robustness).
 * - upsertEntry is pure and immutable — never mutates its input.
 * - detectDrift checks file existence only (content/hash drift = B7).
 */

import { readJson, writeJson } from './fs-json';
import type { Manifest, ManifestEntry, Scope } from './types';

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
 * - File present + valid JSON with correct shape → parsed manifest.
 * - File present + valid JSON but wrong shape (missing/invalid version or artifacts)
 *   → emptyManifest() (robustness; not a crash condition).
 * - File present + invalid JSON → readJson throws InvalidJsonError; let it propagate
 *   (corrupted file is actionable by the caller / CLI exit 2).
 */
export async function readManifest(filePath: string): Promise<Manifest> {
  const raw = await readJson(filePath);

  // Coerce: require version to be a number and artifacts to be an array.
  if (typeof raw['version'] !== 'number' || !Array.isArray(raw['artifacts'])) {
    return emptyManifest();
  }

  return raw as unknown as Manifest;
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

  const artifacts = manifest.artifacts.map((existing) => {
    if (existing.id === entry.id && existing.scope === entry.scope) {
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
): ManifestEntry | undefined {
  return manifest.artifacts.find((e) => e.id === id && e.scope === scope);
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
