/**
 * adapter-builder.ts — shared factory for ClaudeAdapter instances.
 *
 * Extracted from cli.ts so that both the CLI entry point and the remote-install
 * orchestrator share a single, consistent adapter construction path.
 *
 * Responsibilities:
 * - Load denyRef + agentsContent from externalBaseDir (checkout) when provided.
 * - Build all source/spec closures: skillSource, agentSource, pluginSource, hookSpec.
 * - Accept an optional manifest to build a getApplied resolver for reversible
 *   remove/check (B-iii): adapter reads canonical payload from the manifest instead
 *   of from local artifact files.
 * - Accept an optional pluginRunner so callers can inject a CommandRunner-based
 *   runner (remote-install.ts) without coupling to the default PluginRunner.
 *
 * Constraints:
 * - No circular imports: does not import from cli.ts or remote-install.ts.
 * - exactOptionalPropertyTypes: never assigns undefined to optional fields.
 * - No BUILTIN_CATALOG dependency: all hook resolution must come from effectiveEntries.
 */

import path from 'node:path';

import { createClaudeAdapter, loadCanonicalAllow, loadCanonicalDeny } from '@agent-rigger/adapters';
import type { PluginRunner, ResolvedHook } from '@agent-rigger/adapters';
import type { Adapter, AdapterEntry } from '@agent-rigger/core/adapter';
import { assertSafeArtifactName } from '@agent-rigger/core/artifact-name';
import { readText } from '@agent-rigger/core/fs-json';
import type { Env } from '@agent-rigger/core/paths';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';

import type { CatalogEntry } from '@agent-rigger/catalog';

// ---------------------------------------------------------------------------
// BuildClaudeAdapterOpts
// ---------------------------------------------------------------------------

/**
 * Options for the external-resolver seam in buildClaudeAdapter.
 *
 * @param externalIds      Set of artifact ids (e.g. 'skill:x', 'agent:y') whose
 *                         source should be resolved from externalBaseDir.
 *                         Both fields must be provided together for the seam to activate.
 * @param externalBaseDir  Absolute path to the root of a remote checkout. Expected
 *                         layout: skills/<name>/, agents/<name>.md,
 *                         hooks/<name>.ts, guardrails/<n>/deny.json + allow.json,
 *                         contexts/<n>/AGENTS.md.
 * @param catalogUrl       URL of the content repo (used as the marketplace URL for
 *                         external plugin installs). When provided alongside externalIds,
 *                         plugin entries in externalIds use this URL as their marketplace
 *                         instead of the bundled <cwd>/.claude-plugin/marketplace.json.
 * @param pluginRunner     Optional PluginRunner to inject. When omitted, createClaudeAdapter
 *                         uses its default runner (Bun.spawn). Set this in tests or in
 *                         remote-install.ts to avoid invoking the real `claude` binary.
 * @param effectiveEntries Lookup map (id → CatalogEntry) for the resolved effective catalog.
 *                         Used by hookSpec to resolve event/matcher/timeout for any hook entry.
 *                         Required when any hook entry needs to be installed — hookSpec will
 *                         throw an actionable error if the entry is not found in this map.
 */
export interface BuildClaudeAdapterOpts {
  externalIds?: Set<string>;
  externalBaseDir?: string;
  catalogUrl?: string;
  pluginRunner?: PluginRunner;
  effectiveEntries?: Map<string, CatalogEntry>;
}

// ---------------------------------------------------------------------------
// buildClaudeAdapter
// ---------------------------------------------------------------------------

/**
 * Build a ClaudeAdapter.
 *
 * All artifact content comes from externalBaseDir when externalIds are present:
 * - denyRef       : loaded from <externalBaseDir>/guardrails/<n>/deny.json
 * - agentsContent : loaded from <externalBaseDir>/contexts/<n>/AGENTS.md
 * - skillSource   : resolves id → <externalBaseDir>/skills/<id>
 * - agentSource   : resolves id → <externalBaseDir>/agents/<agentId>.md
 * - hookSpec      : resolves hook entries to ResolvedHook using effectiveEntries map
 *
 * For remove/check without a checkout: pass `manifest` in opts. The adapter
 * reads canonical payload from ManifestEntry.applied (B-iii reversibility).
 *
 * Without externalBaseDir and without manifest: denyRef=[], agentsContent=''.
 * Audit/planRemove fall back to empty defaults (graceful degradation for legacy entries).
 *
 * @param env   Injectable environment for path resolution.
 * @param opts  Optional seam for remote installs, check, and remove.
 */
export async function buildClaudeAdapter(
  env: Env,
  opts?: BuildClaudeAdapterOpts,
): Promise<Adapter> {
  // ---------------------------------------------------------------------------
  // Resolve denyRef + allowRef: external guardrail from checkout OR empty default
  //
  // Matching: prefer 'guardrail:'-prefixed ids first (canonical form).
  // Fallback: look up nature via effectiveEntries for legacy ids (e.g. 'guardrails-claude').
  // ---------------------------------------------------------------------------

  const externalGuardrailId = opts?.externalIds === undefined
    ? undefined
    : (
      // Primary: id with 'guardrail:' prefix
      [...opts.externalIds].find((id) => id.startsWith('guardrail:'))
        // Fallback: any external id whose catalog entry has nature 'guardrail'
        ?? [...opts.externalIds].find((id) =>
          opts.effectiveEntries?.get(id)?.kind === 'artifact'
          && (opts.effectiveEntries.get(id) as { nature: string }).nature === 'guardrail'
        )
    );

  let denyRef: string[];
  let allowRef: string[];

  if (externalGuardrailId !== undefined && opts?.externalBaseDir !== undefined) {
    // Derive the directory name from the id:
    // 'guardrail:<name>' → <name>; legacy ids (e.g. 'guardrails-claude') → id itself.
    const name = externalGuardrailId.startsWith('guardrail:')
      ? externalGuardrailId.replace(/^guardrail:/, '')
      : externalGuardrailId;
    assertSafeArtifactName(name, externalGuardrailId);
    const guardrailDir = path.join(opts.externalBaseDir, 'guardrails', name);
    const [extDeny, extAllow] = await Promise.all([
      loadCanonicalDeny(path.join(guardrailDir, 'deny.json')),
      loadCanonicalAllow(path.join(guardrailDir, 'allow.json')),
    ]);
    denyRef = extDeny;
    allowRef = extAllow;
  } else {
    denyRef = [];
    allowRef = [];
  }

  // ---------------------------------------------------------------------------
  // Resolve agentsContent: external context from checkout OR empty default
  //
  // Matching: prefer 'context:'-prefixed ids; fallback to effectiveEntries lookup.
  // ---------------------------------------------------------------------------

  const externalContextId = opts?.externalIds === undefined
    ? undefined
    : (
      [...opts.externalIds].find((id) => id.startsWith('context:'))
        ?? [...opts.externalIds].find((id) =>
          opts.effectiveEntries?.get(id)?.kind === 'artifact'
          && (opts.effectiveEntries.get(id) as { nature: string }).nature === 'context'
        )
    );

  let agentsContent: string;

  if (externalContextId !== undefined && opts?.externalBaseDir !== undefined) {
    const name = externalContextId.startsWith('context:')
      ? externalContextId.replace(/^context:/, '')
      : externalContextId;
    assertSafeArtifactName(name, externalContextId);
    agentsContent = await readText(
      path.join(opts.externalBaseDir, 'contexts', name, 'AGENTS.md'),
    );
  } else {
    agentsContent = '';
  }

  // ---------------------------------------------------------------------------
  // hookSpec: resolves event/matcher/timeout from effectiveEntries ONLY
  // ---------------------------------------------------------------------------

  const hookSpec = (entry: AdapterEntry): ResolvedHook => {
    const catalogEntry = opts?.effectiveEntries?.get(entry.id);

    if (
      catalogEntry === undefined
      || catalogEntry.kind !== 'artifact'
      || catalogEntry.nature !== 'hook'
    ) {
      throw new Error(
        `hookSpec: cannot resolve hook "${entry.id}" — entry not found in effective catalog. `
          + 'Pass effectiveEntries with the hook entry when calling buildClaudeAdapter.',
      );
    }

    // Defence-in-depth: event and matcher are required by schema but verify at runtime
    if (!catalogEntry.event || !catalogEntry.matcher) {
      throw new Error(
        `hookSpec: hook entry "${entry.id}" is missing event or matcher fields.`,
      );
    }

    const name = entry.id.replace(/^hook:/, '');
    // Depth-in-defence: guard before any path.join.
    assertSafeArtifactName(name, entry.id);

    if (opts?.externalIds?.has(entry.id) === true && opts.externalBaseDir !== undefined) {
      const hooksDir = path.join(opts.externalBaseDir, 'hooks');
      const scriptStore = path.join(path.dirname(resolveUserTargets(env).stateJson), 'hooks');
      const command = `bun run ${scriptStore}/${name}.ts`;

      const base: ResolvedHook = {
        event: catalogEntry.event,
        matcher: catalogEntry.matcher,
        command,
        scriptSource: hooksDir,
        scriptStore,
      };
      if (catalogEntry.timeout !== undefined) {
        return { ...base, timeout: catalogEntry.timeout };
      }
      return base;
    }

    throw new Error(
      `hookSpec: hook "${entry.id}" is not in externalIds. `
        + 'All hooks must come from the remote checkout (externalBaseDir).',
    );
  };

  const createOpts: Parameters<typeof createClaudeAdapter>[0] = {
    denyRef,
    allowRef,
    agentsContent,
    scanner: stubScanner,
    hookSpec,
    skillSource: (entry) => {
      const name = entry.id.replace(/^skill:/, '');
      assertSafeArtifactName(name, entry.id);
      if (
        opts?.externalIds?.has(entry.id) === true
        && opts.externalBaseDir !== undefined
      ) {
        return path.join(opts.externalBaseDir, 'skills', name);
      }
      throw new Error(
        `skillSource: skill "${entry.id}" is not in externalIds. `
          + 'All skills must come from the remote checkout (externalBaseDir).',
      );
    },
    agentSource: (entry) => {
      const name = entry.id.replace(/^agent:/, '');
      assertSafeArtifactName(name, entry.id);
      if (
        opts?.externalIds?.has(entry.id) === true
        && opts.externalBaseDir !== undefined
      ) {
        return path.join(opts.externalBaseDir, 'agents', name + '.md');
      }
      throw new Error(
        `agentSource: agent "${entry.id}" is not in externalIds. `
          + 'All agents must come from the remote checkout (externalBaseDir).',
      );
    },
    pluginSource: (entry) => {
      const plugin = entry.id.replace(/^plugin:/, '');
      if (
        opts?.externalIds?.has(entry.id) === true
        && opts.catalogUrl !== undefined
      ) {
        return { plugin, marketplace: opts.catalogUrl };
      }
      return {
        plugin,
        marketplace: path.join(process.cwd(), '.claude-plugin', 'marketplace.json'),
      };
    },
  };

  if (opts?.pluginRunner !== undefined) {
    createOpts.pluginRunner = opts.pluginRunner;
  }

  return createClaudeAdapter(createOpts);
}
