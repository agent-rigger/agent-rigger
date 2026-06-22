/**
 * adapter-builder.ts — shared factory for ClaudeAdapter instances.
 *
 * Extracted from cli.ts so that both the CLI entry point and the remote-install
 * orchestrator share a single, consistent adapter construction path.
 *
 * The previous duplication (buildClaudeAdapter in cli.ts +
 * buildClaudeAdapterForRemote in remote-install.ts) caused remote installs of
 * hook entries to fail because the private copy lacked hookSpec.
 *
 * Responsibilities:
 * - Load denyRef + agentsContent from artifactsDir.
 * - Build all source/spec closures: skillSource, agentSource, pluginSource, hookSpec.
 * - Accept an optional pluginRunner so callers can inject a CommandRunner-based
 *   runner (remote-install.ts) without coupling to the default PluginRunner.
 *
 * Constraints:
 * - No circular imports: does not import from cli.ts or remote-install.ts.
 * - exactOptionalPropertyTypes: never assigns undefined to optional fields.
 */

import path from 'node:path';

import {
  createClaudeAdapter,
  loadCanonicalAllow,
  loadCanonicalContext,
  loadCanonicalDeny,
} from '@agent-rigger/adapters';
import type { PluginRunner, ResolvedHook } from '@agent-rigger/adapters';
import type { Adapter, AdapterEntry } from '@agent-rigger/core/adapter';
import { assertSafeArtifactName } from '@agent-rigger/core/artifact-name';
import { readText } from '@agent-rigger/core/fs-json';
import type { Env } from '@agent-rigger/core/paths';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';

import { BUILTIN_CATALOG } from '@agent-rigger/catalog';
import type { CatalogEntry } from '@agent-rigger/catalog';

// ---------------------------------------------------------------------------
// BuildClaudeAdapterOpts
// ---------------------------------------------------------------------------

/**
 * Options for the external-resolver seam in buildClaudeAdapter.
 *
 * @param externalIds      Set of artifact ids (e.g. 'skill:x', 'agent:y') whose
 *                         source should be resolved from externalBaseDir instead of
 *                         the local artifactsDir. Both fields must be provided
 *                         together for the seam to activate.
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
 *                         Used by hookSpec to resolve event/matcher/timeout for any hook entry
 *                         (builtin or external) without depending on BUILTIN_CATALOG.find.
 *                         When absent, hookSpec falls back to BUILTIN_CATALOG.
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
 * Build a ClaudeAdapter from the artifacts directory.
 *
 * - denyRef       : loaded from <artifactsDir>/claude/deny.json
 * - agentsContent : loaded from <artifactsDir>/shared/AGENTS.md
 * - skillSource   : resolves id → <artifactsDir>/claude/skills/<id>
 *                   or <externalBaseDir>/skills/<id> when id is in externalIds
 * - agentSource   : resolves id → <artifactsDir>/claude/agents/<agentId>.md
 *                   or <externalBaseDir>/agents/<agentId>.md when id is in externalIds
 * - pluginSource  : resolves id → { plugin: <pluginId>, marketplace: <cwd>/.claude-plugin/marketplace.json }
 *                   or { plugin: <pluginId>, marketplace: catalogUrl } for external plugin entries
 * - hookSpec      : resolves built-in hook entries to ResolvedHook (event/matcher/command/scriptSource/scriptStore)
 * - scanner       : stubScanner (M0: always passes)
 *
 * @param opts  Optional external-resolver seam for remote installs.
 *              Omitting opts → existing behaviour unchanged (100% rétro-compatible).
 */
export async function buildClaudeAdapter(
  env: Env,
  artifactsDir: string,
  opts?: BuildClaudeAdapterOpts,
): Promise<Adapter> {
  // ---------------------------------------------------------------------------
  // Resolve denyRef + allowRef: external guardrail from checkout OR builtin fallback
  // ---------------------------------------------------------------------------

  const externalGuardrailId = opts?.externalIds === undefined
    ? undefined
    : [...opts.externalIds].find((id) => id.startsWith('guardrail:'));

  let denyRef: string[];
  let allowRef: string[];

  if (externalGuardrailId !== undefined && opts?.externalBaseDir !== undefined) {
    const name = externalGuardrailId.replace(/^guardrail:/, '');
    assertSafeArtifactName(name, externalGuardrailId);
    const guardrailDir = path.join(opts.externalBaseDir, 'guardrails', name);
    const [extDeny, extAllow] = await Promise.all([
      loadCanonicalDeny(path.join(guardrailDir, 'deny.json')),
      loadCanonicalAllow(path.join(guardrailDir, 'allow.json')),
    ]);
    denyRef = extDeny;
    allowRef = extAllow;
  } else {
    const denyJsonPath = path.join(artifactsDir, 'claude', 'deny.json');
    denyRef = await loadCanonicalDeny(denyJsonPath);
    allowRef = [];
  }

  // ---------------------------------------------------------------------------
  // Resolve agentsContent: external context from checkout OR builtin fallback
  // ---------------------------------------------------------------------------

  const externalContextId = opts?.externalIds === undefined
    ? undefined
    : [...opts.externalIds].find((id) => id.startsWith('context:'));

  let agentsContent: string;

  if (externalContextId !== undefined && opts?.externalBaseDir !== undefined) {
    const name = externalContextId.replace(/^context:/, '');
    assertSafeArtifactName(name, externalContextId);
    agentsContent = await readText(
      path.join(opts.externalBaseDir, 'contexts', name, 'AGENTS.md'),
    );
  } else {
    const agentsMdPath = path.join(artifactsDir, 'shared', 'AGENTS.md');
    agentsContent = await loadCanonicalContext(agentsMdPath);
  }

  // ---------------------------------------------------------------------------
  // hookSpec: resolves event/matcher/timeout from effectiveEntries OR BUILTIN_CATALOG
  // ---------------------------------------------------------------------------

  const hookSpec = (entry: AdapterEntry): ResolvedHook => {
    // Look up from effectiveEntries if provided, else fall back to BUILTIN_CATALOG
    const catalogEntry = opts?.effectiveEntries?.get(entry.id)
      ?? BUILTIN_CATALOG.find((e) => e.id === entry.id);

    if (
      catalogEntry === undefined
      || catalogEntry.kind !== 'artifact'
      || catalogEntry.nature !== 'hook'
    ) {
      throw new Error(
        `hookSpec: cannot resolve hook "${entry.id}" — entry not found in effective catalog.`,
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

    // Path: external hook (in externalIds AND externalBaseDir set) → externalBaseDir/hooks
    // else → artifactsDir/claude/hooks (builtin fallback)
    const hooksDir = opts?.externalIds?.has(entry.id) === true && opts.externalBaseDir !== undefined
      ? path.join(opts.externalBaseDir, 'hooks')
      : path.join(artifactsDir, 'claude', 'hooks');

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
  };

  const createOpts: Parameters<typeof createClaudeAdapter>[0] = {
    denyRef,
    allowRef,
    agentsContent,
    scanner: stubScanner,
    hookSpec,
    skillSource: (entry) => {
      const name = entry.id.replace(/^skill:/, '');
      // Depth-in-defence: guard before any path.join — prevents traversal via
      // an external catalog entry like "skill:../../../../etc/evil".
      assertSafeArtifactName(name, entry.id);
      if (
        opts?.externalIds?.has(entry.id) === true
        && opts.externalBaseDir !== undefined
      ) {
        return path.join(opts.externalBaseDir, 'skills', name);
      }
      return path.join(artifactsDir, 'claude', 'skills', name);
    },
    agentSource: (entry) => {
      const name = entry.id.replace(/^agent:/, '');
      // Depth-in-defence: guard before any path.join.
      assertSafeArtifactName(name, entry.id);
      if (
        opts?.externalIds?.has(entry.id) === true
        && opts.externalBaseDir !== undefined
      ) {
        return path.join(opts.externalBaseDir, 'agents', name + '.md');
      }
      return path.join(artifactsDir, 'claude', 'agents', name + '.md');
    },
    pluginSource: (entry) => {
      const plugin = entry.id.replace(/^plugin:/, '');
      // External plugin: use the content repo URL as the marketplace.
      // This lets `claude plugin marketplace add <url>` register the remote
      // repository, then `claude plugin install <plugin>` installs from it.
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
