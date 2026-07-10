/**
 * mcp-source.ts — shared mcp config resolver + secret render for BOTH adapter
 * builders (R5/R8, lot 6, D5). The single seam that turns a catalog mcp entry's
 * raw `config` into a host-rendered descriptor, factored out so opencode
 * (`{env:VAR}` native form) and claude (verbatim `${VAR}`, expanded at spawn —
 * T0) differ ONLY in the per-var render function they pass, never in the
 * fail-closed secret orchestration around it (renderSecretRefs +
 * substituteSecretRefs, secret-render.ts).
 *
 * Constraints:
 * - No I/O — `env` is injected for the presence check only.
 * - No while loops.
 */

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import type { Env } from '@agent-rigger/core/paths';

import { type CatalogEntry, localId } from '@agent-rigger/catalog';

import { renderSecretRefs, substituteSecretRefs } from './secret-render';

/** Options for renderMcpConfig. */
export interface RenderMcpConfigOpts {
  /** Lookup map (id → CatalogEntry) for the resolved effective catalog. */
  effectiveEntries?: Map<string, CatalogEntry>;
  /** Injectable environment for the secret presence check. */
  env: Env;
  /**
   * ref→VAR overrides (--secret-env flags on install, or replayed from a
   * manifest's secretRefs on update). A ref absent here defaults to its own name.
   */
  secretOverrides?: Record<string, string>;
  /**
   * Host-native rendering of an effective var name:
   *   opencode → `(v) => \`{env:${v}}\``
   *   claude   → `(v) => \`\${${v}}\`` (verbatim — Claude expands at spawn, T0)
   */
  renderVar: (envVar: string) => string;
}

/**
 * Resolve the mcp server id + RENDERED config for an entry, failing closed
 * (MissingRequiredSecretError) BEFORE returning anything when a `required`
 * secret's resolved var is absent from `env` (R5, D5 point 3).
 *
 * @throws {Error} when the entry is not an mcp artifact in effectiveEntries or
 *                 has no `config` field (actionable messages).
 * @throws {MissingRequiredSecretError} from renderSecretRefs (re-exported via secret-render).
 */
export function renderMcpConfig(
  entry: AdapterEntry,
  opts: RenderMcpConfigOpts,
): { server: string; config: Record<string, unknown>; secretRefs?: Record<string, string> } {
  const catalogEntry = opts.effectiveEntries?.get(entry.id);

  if (
    catalogEntry === undefined
    || catalogEntry.kind !== 'artifact'
    || catalogEntry.nature !== 'mcp'
  ) {
    throw new Error(
      `mcpSource: cannot resolve mcp server "${entry.id}" — entry not found in effective `
        + 'catalog. Pass effectiveEntries with the mcp entry when building the adapter.',
    );
  }

  const rawConfig = catalogEntry.config;
  if (rawConfig === undefined) {
    throw new Error(
      `mcpSource: mcp entry "${entry.id}" has no "config" field in the catalog. `
        + 'An mcp artifact must declare its server configuration.',
    );
  }

  // R5 (D5): resolve the ref→VAR mapping for every declared secret and
  // fail-closed BEFORE any config is rendered/written when a `required`
  // secret's resolved var is absent. Runs on EVERY plan/adopt — install,
  // re-install, and update (whose secretOverrides replay the manifest's
  // secretRefs, never re-prompting).
  const secrets = catalogEntry.secrets ?? [];
  const secretRefs = renderSecretRefs({
    entryId: entry.id,
    secrets,
    ...(opts.secretOverrides === undefined ? {} : { overrides: opts.secretOverrides }),
    env: opts.env,
  });

  // Substitute every exact "${REF}" value in the secret-bearing fields with the
  // host-native form. `environment`/`headers` are the schema's MCP_SECRET_FIELDS
  // (opencode canonical, R6); `env` is Claude Code's native stdio field — a
  // claude-targeted entry writes its refs there and Claude expands them at spawn
  // (T0), so an override (`--secret-env GITHUB_TOKEN=MY_PAT`) must reach it too.
  const renderedRaw: Record<string, unknown> = { ...(rawConfig as Record<string, unknown>) };
  for (const field of ['environment', 'headers', 'env'] as const) {
    const sub = renderedRaw[field];
    if (typeof sub === 'object' && sub !== null && !Array.isArray(sub)) {
      renderedRaw[field] = substituteSecretRefs(
        sub as Record<string, string>,
        secretRefs,
        opts.renderVar,
      );
    }
  }

  const server = localId(entry.id).replace(/^mcp:/, '');

  return Object.keys(secretRefs).length === 0
    ? { server, config: renderedRaw }
    : { server, config: renderedRaw, secretRefs };
}
