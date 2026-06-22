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
  loadCanonicalContext,
  loadCanonicalDeny,
} from '@agent-rigger/adapters';
import type { PluginRunner, ResolvedHook } from '@agent-rigger/adapters';
import type { Adapter, AdapterEntry } from '@agent-rigger/core/adapter';
import { assertSafeArtifactName } from '@agent-rigger/core/artifact-name';
import type { Env } from '@agent-rigger/core/paths';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';

import { BUILTIN_CATALOG } from '@agent-rigger/catalog';

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
 *                         layout: skills/<name>/ and agents/<name>.md.
 * @param catalogUrl       URL of the content repo (used as the marketplace URL for
 *                         external plugin installs). When provided alongside externalIds,
 *                         plugin entries in externalIds use this URL as their marketplace
 *                         instead of the bundled <cwd>/.claude-plugin/marketplace.json.
 * @param pluginRunner     Optional PluginRunner to inject. When omitted, createClaudeAdapter
 *                         uses its default runner (Bun.spawn). Set this in tests or in
 *                         remote-install.ts to avoid invoking the real `claude` binary.
 */
export interface BuildClaudeAdapterOpts {
  externalIds?: Set<string>;
  externalBaseDir?: string;
  catalogUrl?: string;
  pluginRunner?: PluginRunner;
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
  const denyJsonPath = path.join(artifactsDir, 'claude', 'deny.json');
  const agentsMdPath = path.join(artifactsDir, 'shared', 'AGENTS.md');

  const [denyRef, agentsContent] = await Promise.all([
    loadCanonicalDeny(denyJsonPath),
    loadCanonicalContext(agentsMdPath),
  ]);

  // hookSpec resolves built-in hook entries to their concrete ResolvedHook specification.
  // External hooks (not in BUILTIN_CATALOG) are not yet supported — throw an actionable error.
  const hookSpec = (entry: AdapterEntry): ResolvedHook => {
    const catalogEntry = BUILTIN_CATALOG.find((e) => e.id === entry.id);
    if (
      catalogEntry === undefined
      || catalogEntry.kind !== 'artifact'
      || catalogEntry.nature !== 'hook'
    ) {
      throw new Error(
        `hookSpec: external hooks not yet supported — "${entry.id}" is not a built-in hook entry. `
          + 'Install built-in hooks only (hook:guard-command, hook:guard-secret, '
          + 'hook:guard-write-secret, hook:guard-prompt).',
      );
    }
    const name = entry.id.replace(/^hook:/, '');
    // Depth-in-defence: guard before any path.join.
    assertSafeArtifactName(name, entry.id);
    const scriptSource = path.join(artifactsDir, 'claude', 'hooks');
    const scriptStore = path.join(path.dirname(resolveUserTargets(env).stateJson), 'hooks');
    const command = `bun run ${scriptStore}/${name}.ts`;
    const base: ResolvedHook = {
      event: catalogEntry.event ?? '',
      matcher: catalogEntry.matcher ?? '',
      command,
      scriptSource,
      scriptStore,
    };
    if (catalogEntry.timeout !== undefined) {
      return { ...base, timeout: catalogEntry.timeout };
    }
    return base;
  };

  const createOpts: Parameters<typeof createClaudeAdapter>[0] = {
    denyRef,
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
