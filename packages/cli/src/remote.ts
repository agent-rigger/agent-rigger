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
 * - CatalogUrlMissingError when catalogUrl is undefined/empty.
 * - fetchRemoteCatalog propagates RemoteFetchError and CatalogParseError as-is.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type CatalogEntry,
  fetchCatalog,
  mergeCatalogs,
  resolveVersion,
  type TmpDirFactory,
} from '@agent-rigger/catalog';
import { type CommandRunner, defaultRunner } from '@agent-rigger/catalog/tool-check';

// ---------------------------------------------------------------------------
// CatalogUrlMissingError
// ---------------------------------------------------------------------------

/**
 * Thrown when fetchRemoteCatalog is called without a catalogUrl configured.
 * Actionable: tells the user to run `agent-rigger init`.
 */
export class CatalogUrlMissingError extends Error {
  constructor() {
    super(
      'Aucune URL de catalogue configurée. Lance `agent-rigger init` pour la configurer.',
    );
    this.name = 'CatalogUrlMissingError';
  }
}

// ---------------------------------------------------------------------------
// RemoteCatalog
// ---------------------------------------------------------------------------

/** Result of a successful remote catalog fetch. */
export interface RemoteCatalog {
  entries: CatalogEntry[];
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
 * - If catalogUrl is absent/empty → throws CatalogUrlMissingError.
 * - Resolves the latest semver tag (or HEAD fallback) via resolveVersion.
 * - Shallow-clones at that ref and parses catalog.json via fetchCatalog.
 * - Propagates RemoteFetchError or CatalogParseError on failure.
 */
export async function fetchRemoteCatalog(opts: {
  catalogUrl: string | undefined;
  run?: CommandRunner;
  tmpFactory?: TmpDirFactory;
}): Promise<RemoteCatalog> {
  const { catalogUrl, run = defaultRunner, tmpFactory = defaultTmpFactory } = opts;

  if (catalogUrl === undefined || catalogUrl === '') {
    throw new CatalogUrlMissingError();
  }

  const version = await resolveVersion(catalogUrl, run);
  const { entries, sha } = await fetchCatalog(catalogUrl, version.ref, version.isTag, run, {
    tmpFactory,
  });

  return {
    entries,
    version: { ref: version.ref, sha, isTag: version.isTag },
  };
}

// ---------------------------------------------------------------------------
// mergeCatalogs — re-exported from @agent-rigger/catalog
// ---------------------------------------------------------------------------

export { mergeCatalogs };
