/**
 * remote.ts — remote catalog fetching and merging for the agent-rigger CLI.
 *
 * Responsibilities:
 * - Provide a real TmpDirFactory using node:fs/promises mkdtemp + rm.
 * - Wrap resolveVersion + fetchCatalog into a single fetchRemoteCatalog call.
 * - Merge built-in and remote catalogs (built-in prioritaire on id collision).
 *
 * Constraints:
 * - No process.exit.
 * - No while loops.
 * - fetchRemoteCatalog propagates RemoteFetchError and CatalogParseError as-is.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type CatalogCanon,
  type CatalogEntry,
  type CatalogMeta,
  fetchCatalog,
  fetchCatalogCanon,
  mergeCatalogs,
  resolveVersion,
  type TmpDirFactory,
} from '@agent-rigger/catalog';
import { type CommandRunner, defaultRunner } from '@agent-rigger/catalog/tool-check';

// ---------------------------------------------------------------------------
// RemoteCatalog
// ---------------------------------------------------------------------------

/** Result of a successful remote catalog fetch. */
export interface RemoteCatalog {
  entries: CatalogEntry[];
  /** The catalog's `meta` block (name + required/recommended governance). */
  meta: CatalogMeta;
  version: { ref: string; sha: string; isTag: boolean };
}

// ---------------------------------------------------------------------------
// defaultTmpFactory — real node:fs/promises implementation
// ---------------------------------------------------------------------------

/**
 * Creates a real temporary directory in os.tmpdir() and returns a cleanup
 * function that deletes it recursively.
 */
export const defaultTmpFactory: TmpDirFactory = async () => {
  const path = await mkdtemp(join(tmpdir(), 'agent-rigger-catalog-'));
  return {
    path,
    cleanup: () => rm(path, { recursive: true, force: true }),
  };
};

// ---------------------------------------------------------------------------
// fetchRemoteCatalog
// ---------------------------------------------------------------------------

/**
 * Fetch catalog entries from a remote git repository.
 *
 * - Resolves the latest semver tag (or HEAD fallback) via resolveVersion.
 * - Shallow-clones at that ref and parses catalog.json via fetchCatalog.
 * - Propagates RemoteFetchError or CatalogParseError on failure.
 *
 * @param opts.url         The git URL of the catalog repository (required, non-empty).
 * @param opts.run         Optional CommandRunner override (defaults to defaultRunner).
 * @param opts.tmpFactory  Optional TmpDirFactory override (defaults to defaultTmpFactory).
 */
export async function fetchRemoteCatalog(opts: {
  url: string;
  run?: CommandRunner;
  tmpFactory?: TmpDirFactory;
}): Promise<RemoteCatalog> {
  const { url, run = defaultRunner, tmpFactory = defaultTmpFactory } = opts;

  const version = await resolveVersion(url, run);
  const { meta, entries, sha } = await fetchCatalog(url, version.ref, version.isTag, run, {
    tmpFactory,
  });

  return {
    entries,
    meta,
    version: { ref: version.ref, sha, isTag: version.isTag },
  };
}

// ---------------------------------------------------------------------------
// fetchRemoteCatalogCanon — the differential canon (doctor --remote, D1)
// ---------------------------------------------------------------------------

/**
 * Fetch the differential canon of one configured catalog (doctor --remote, D1).
 *
 * Same two-step resolution as {@link fetchRemoteCatalog} — resolveVersion then a
 * shallow checkout — but reads the per-nature content files (guardrail
 * deny/allow, context AGENTS.md) WHILE the checkout is on disk and returns them
 * in memory as a {@link CatalogCanon} (mcp config stays inline). The resolved
 * sha is passed through as `expectedSha` so the provenance check fires
 * (RefShaMismatchError → exit 2). The checkout is torn down before returning
 * (ADR-0012 — no persisted clone).
 *
 * Propagates RemoteFetchError / RefShaMismatchError / CatalogParseError as-is —
 * the doctor dispatch is fail-closed on any of them (D1).
 *
 * @param opts.name        The configured catalog name (the id doctor knows it by).
 * @param opts.url         The git URL of the catalog repository (required, non-empty).
 * @param opts.run         Optional CommandRunner override (defaults to defaultRunner).
 * @param opts.tmpFactory  Optional TmpDirFactory override (defaults to defaultTmpFactory).
 */
export async function fetchRemoteCatalogCanon(opts: {
  name: string;
  url: string;
  run?: CommandRunner;
  tmpFactory?: TmpDirFactory;
}): Promise<CatalogCanon> {
  const { name, url, run = defaultRunner, tmpFactory = defaultTmpFactory } = opts;

  const version = await resolveVersion(url, run);
  return fetchCatalogCanon(name, url, version, run, {
    tmpFactory,
    expectedSha: version.sha,
  });
}

// ---------------------------------------------------------------------------
// mergeCatalogs — re-exported from @agent-rigger/catalog
// ---------------------------------------------------------------------------

export { mergeCatalogs };
