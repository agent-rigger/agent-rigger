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
import type { Assistant } from '@agent-rigger/core';
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
  hook: 'hook',
  hooks: 'hook',
  tool: 'tool',
  tools: 'tool',
  lib: 'lib',
  libs: 'lib',
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
  /**
   * Optional assistant filter (M3, E6, read-only — no fallback, no prompt).
   * When provided, "[installed]" only reflects THIS assistant's manifest
   * entries. When absent, an id installed for ANY assistant is "[installed]"
   * and every row still shows which assistant(s) it's installed for.
   */
  assistant?: Assistant;
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
 * Step 2 — Manifest: read state.json → build the per-id installed-assistants
 *   map (ALL assistants, scope-filtered), then derive installedIds — either
 *   "any assistant" or, when `assistant` is given, only that one (E6, R1).
 * Step 3 — Render: call renderCatalogList (pure), passing the assistants map
 *   so every row shows which assistant(s) it's installed for.
 * Step 4 — Return { output, count }.
 */
export async function runLs(opts: RunLsOptions): Promise<RunLsResult> {
  const { catalog, env, resourceFilter, scope = 'user', assistant } = opts;

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
  // Step 2: Read manifest to build the installed-assistants map + ids set
  // -------------------------------------------------------------------------

  const targets = resolveUserTargets(env);
  const stateJsonPath = scope === 'project'
    ? targets.stateJson // project scope uses same resolution in M0
    : targets.stateJson;

  const installedAssistants = new Map<string, Assistant[]>();
  // A lib entry writes assistant:'shared' (S2, lib-nature) — it has no
  // single-assistant identity and is never routed to an adapter, so it is
  // excluded from the per-assistant tally above and tracked here instead
  // (T7): a lib is a global singleton, so an --assistant filter must never
  // hide one that IS installed.
  const installedLibIds = new Set<string>();
  try {
    const manifest = await readManifest(stateJsonPath);
    for (const a of manifest.artifacts) {
      if (a.scope !== scope) continue;
      const entryAssistant = a.assistant ?? 'claude';
      if (entryAssistant === 'shared') {
        installedLibIds.add(a.id);
        continue;
      }
      const existing = installedAssistants.get(a.id);
      if (existing === undefined) {
        installedAssistants.set(a.id, [entryAssistant]);
      } else if (!existing.includes(entryAssistant)) {
        existing.push(entryAssistant);
      }
    }
  } catch {
    // Absent/corrupt manifest → nothing installed, every entry [available].
  }

  const installedIds = new Set([
    ...[...installedAssistants.entries()]
      .filter(([, assistants]) => assistant === undefined || assistants.includes(assistant))
      .map(([id]) => id),
    ...installedLibIds,
  ]);

  // -------------------------------------------------------------------------
  // Step 3: Render
  // -------------------------------------------------------------------------

  const hasLabel = resourceFilter !== undefined && resourceFilter !== 'catalog';
  const output = hasLabel
    ? renderCatalogList(filtered, {
      installedIds,
      installedAssistants,
      label: capitalize(resourceFilter),
    })
    : renderCatalogList(filtered, { installedIds, installedAssistants });

  return { output, count: filtered.length };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
