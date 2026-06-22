/**
 * remote-install.ts — reusable orchestration for remote catalog installs.
 *
 * Extracted from handleInstall (cli.ts) so that runUpdate (cmd-update.ts) can
 * reuse the same checkout + merge + install pipeline without duplication.
 *
 * Responsibilities:
 * - Resolve the remote version via resolveVersion.
 * - Shallow-clone the content repo (withRemoteCheckout), run the callback,
 *   guarantee cleanup in finally.
 * - Inside the callback: readCatalogDir → frontier guard (path traversal) →
 *   mergeCatalogs → resolve ids → buildClaudeAdapter({externalIds, externalBaseDir}) →
 *   versionFor → runInstall.
 *
 * Constraints:
 * - No while loops.
 * - No process.exit.
 * - No I/O imports beyond what catalog + adapters + core provide.
 * - exactOptionalPropertyTypes: never assigns undefined to optional fields.
 */

import path from 'node:path';

import {
  createClaudeAdapter,
  loadCanonicalContext,
  loadCanonicalDeny,
} from '@agent-rigger/adapters';
import { assertSafeArtifactName } from '@agent-rigger/core/artifact-name';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';
import type { Scope } from '@agent-rigger/core/types';

import {
  BUILTIN_CATALOG,
  mergeCatalogs,
  readCatalogDir,
  resolveVersion,
  type TmpDirFactory,
  withRemoteCheckout,
} from '@agent-rigger/catalog';
import { resolve } from '@agent-rigger/catalog/resolver';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';

import type { InstallResult } from './cmd-install';
import { runInstall } from './cmd-install';

// ---------------------------------------------------------------------------
// buildClaudeAdapterForRemote — shared adapter construction
// ---------------------------------------------------------------------------

/**
 * Build a ClaudeAdapter that resolves sources from either a remote checkout
 * directory (for external ids) or the bundled artifacts directory (for internal ids).
 *
 * Mirror of buildClaudeAdapter in cli.ts with externalIds + externalBaseDir always set.
 * Kept private to this module to avoid a circular dep on cli.ts.
 */
async function buildClaudeAdapterForRemote(
  env: Env,
  artifactsDir: string,
  externalIds: Set<string>,
  externalBaseDir: string,
) {
  const denyJsonPath = path.join(artifactsDir, 'claude', 'deny.json');
  const agentsMdPath = path.join(artifactsDir, 'shared', 'AGENTS.md');

  const [denyRef, agentsContent] = await Promise.all([
    loadCanonicalDeny(denyJsonPath),
    loadCanonicalContext(agentsMdPath),
  ]);

  return createClaudeAdapter({
    denyRef,
    agentsContent,
    scanner: stubScanner,
    skillSource: (entry) => {
      const name = entry.id.replace(/^skill:/, '');
      assertSafeArtifactName(name, entry.id);
      if (externalIds.has(entry.id)) {
        return path.join(externalBaseDir, 'skills', name);
      }
      return path.join(artifactsDir, 'claude', 'skills', name);
    },
    agentSource: (entry) => {
      const name = entry.id.replace(/^agent:/, '');
      assertSafeArtifactName(name, entry.id);
      if (externalIds.has(entry.id)) {
        return path.join(externalBaseDir, 'agents', name + '.md');
      }
      return path.join(artifactsDir, 'claude', 'agents', name + '.md');
    },
    pluginSource: (entry) => ({
      plugin: entry.id.replace(/^plugin:/, ''),
      marketplace: path.join(
        resolveUserTargets(env).stateJson,
        '..',
        '..',
        '..',
        '.claude-plugin',
        'marketplace.json',
      ),
    }),
  });
}

// ---------------------------------------------------------------------------
// runRemoteInstall
// ---------------------------------------------------------------------------

/**
 * Perform a remote catalog install end-to-end.
 *
 * Pipeline:
 * 1. resolveVersion(catalogUrl, runner) → ResolvedVersion.
 * 2. withRemoteCheckout(url, ref, runner, {tmpFactory}, async (dir) => {
 *      readCatalogDir(dir) → frontier guard → mergeCatalogs → resolve →
 *      buildClaudeAdapterForRemote → versionFor → runInstall
 *    })
 * 3. Returns InstallResult from runInstall.
 *
 * cleanup is guaranteed by withRemoteCheckout (finally).
 * Path-traversal ids are rejected before any file operation (UnsafeArtifactNameError).
 */
export async function runRemoteInstall(opts: {
  ids: string[];
  catalogUrl: string;
  scope: Scope;
  env: Env;
  manifestPath: string;
  artifactsDir: string;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  confirm: boolean | ((planText: string) => Promise<boolean>);
}): Promise<InstallResult> {
  const {
    ids,
    catalogUrl,
    scope,
    env,
    manifestPath,
    artifactsDir,
    runner,
    tmpFactory,
    confirm,
  } = opts;

  const version = await resolveVersion(catalogUrl, runner);

  return withRemoteCheckout(catalogUrl, version.ref, runner, { tmpFactory }, async (dir) => {
    const remoteEntries = await readCatalogDir(dir);

    // Frontier guard: reject external entries whose derived name would cause
    // a path traversal before any install operation begins.
    for (const entry of remoteEntries) {
      if (entry.kind !== 'artifact') continue;
      if (entry.nature === 'skill') {
        const name = entry.id.replace(/^skill:/, '');
        assertSafeArtifactName(name, entry.id);
      } else if (entry.nature === 'agent') {
        const name = entry.id.replace(/^agent:/, '');
        assertSafeArtifactName(name, entry.id);
      }
    }

    const { entries: effective } = mergeCatalogs(BUILTIN_CATALOG, remoteEntries);
    const resolved = resolve(ids, effective);
    const externalIds = new Set(
      resolved.filter((e) => e.source === 'external').map((e) => e.id),
    );

    const adapter = await buildClaudeAdapterForRemote(env, artifactsDir, externalIds, dir);

    const versionFor = (
      entry: { id: string },
    ): { source: 'internal' | 'external'; ref: string; sha: string } => {
      if (externalIds.has(entry.id)) {
        return { source: 'external', ref: version.ref, sha: version.sha };
      }
      return { source: 'internal', ref: 'v0.0.0', sha: '' };
    };

    return runInstall({
      catalog: effective,
      adapter,
      scope,
      env,
      manifestPath,
      selectedIds: ids,
      confirm,
      versionFor,
      toolRunner: runner,
    });
  });
}
