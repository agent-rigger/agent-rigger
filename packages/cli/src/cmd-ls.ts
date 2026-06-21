/**
 * cmd-ls — implementation of the `ls` command.
 *
 * Responsibilities:
 * - Read the manifest to determine which catalog entries are installed.
 * - Filter catalog entries by resourceFilter (nature or pack kind).
 * - Render the result via renderCatalogList (pure).
 * - Return { output, count } for the caller to print.
 *
 * Constraints:
 * - No process.exit.
 * - No while loops.
 * - All I/O is injectable via opts.env for test isolation.
 */

import type { CatalogEntry } from '@agent-rigger/catalog';
import { readManifest } from '@agent-rigger/core/manifest';
import type { Env } from '@agent-rigger/core/paths';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Scope } from '@agent-rigger/core/types';

import { renderCatalogList } from './ui';

// ---------------------------------------------------------------------------
// RESOURCE_NATURE_MAP — canonical mapping from resource name to nature/kind
// ---------------------------------------------------------------------------

/**
 * Maps a resource token (singular or plural) to its catalog filter value.
 * "pack"/"packs" filters by kind:'pack'; all others filter artifact nature.
 */
export const RESOURCE_NATURE_MAP: Record<string, string> = {
  skill: 'skill',
  skills: 'skill',
  agent: 'agent',
  agents: 'agent',
  guardrail: 'guardrail',
  guardrails: 'guardrail',
  context: 'context',
  contexts: 'context',
  plugin: 'plugin',
  plugins: 'plugin',
  tool: 'tool',
  tools: 'tool',
  pack: 'pack',
  packs: 'pack',
  catalog: 'catalog',
};

// ---------------------------------------------------------------------------
// RunLsOptions
// ---------------------------------------------------------------------------

/** Options for runLs — all injectable for test isolation. */
export interface RunLsOptions {
  /** Catalog entries to list. */
  catalog: CatalogEntry[];
  /** Injectable env for HOME resolution. */
  env: Env;
  /**
   * When provided, filter by this nature value (for artifacts) or 'pack'.
   * Corresponds to the canonical nature string (e.g. 'skill', 'guardrail', 'pack').
   */
  resourceFilter?: string;
  /** Scope used to resolve the manifest path. Defaults to 'user'. */
  scope?: Scope;
}

// ---------------------------------------------------------------------------
// RunLsResult
// ---------------------------------------------------------------------------

/** Result returned by runLs. */
export interface RunLsResult {
  /** Human-readable listing ready to print. */
  output: string;
  /** Number of entries shown after filtering. */
  count: number;
}

// ---------------------------------------------------------------------------
// runLs
// ---------------------------------------------------------------------------

/**
 * List catalog entries, marking installed ones from the manifest.
 *
 * Step 1 — Filter: apply resourceFilter to narrow entries.
 * Step 2 — Manifest: read state.json → build Set of installed ids.
 * Step 3 — Render: call renderCatalogList (pure).
 * Step 4 — Return { output, count }.
 */
export async function runLs(opts: RunLsOptions): Promise<RunLsResult> {
  const { catalog, env, resourceFilter, scope = 'user' } = opts;

  // -------------------------------------------------------------------------
  // Step 1: Filter entries by resource
  // -------------------------------------------------------------------------

  const filtered = resourceFilter === undefined || resourceFilter === 'catalog'
    ? catalog
    : catalog.filter((entry) => {
      if (resourceFilter === 'pack') {
        return entry.kind === 'pack';
      }
      return entry.kind === 'artifact' && entry.nature === resourceFilter;
    });

  // -------------------------------------------------------------------------
  // Step 2: Read manifest to build installed ids set
  // -------------------------------------------------------------------------

  const targets = resolveUserTargets(env);
  const stateJsonPath = scope === 'project'
    ? targets.stateJson // project scope uses same resolution in M0
    : targets.stateJson;

  let installedIds: Set<string>;
  try {
    const manifest = await readManifest(stateJsonPath);
    installedIds = new Set(
      manifest.artifacts
        .filter((a) => a.scope === scope)
        .map((a) => a.id),
    );
  } catch {
    installedIds = new Set();
  }

  // -------------------------------------------------------------------------
  // Step 3: Render
  // -------------------------------------------------------------------------

  const hasLabel = resourceFilter !== undefined && resourceFilter !== 'catalog';
  const output = hasLabel
    ? renderCatalogList(filtered, { installedIds, label: capitalize(resourceFilter) })
    : renderCatalogList(filtered, { installedIds });

  return { output, count: filtered.length };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
