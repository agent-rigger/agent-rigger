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

import type { PluginRunner } from '@agent-rigger/adapters';
import { assertSafeArtifactName } from '@agent-rigger/core/artifact-name';
import type { Env } from '@agent-rigger/core/paths';
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

import { buildClaudeAdapter } from './adapter-builder';
import type { InstallResult } from './cmd-install';
import { runInstall } from './cmd-install';

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
 *      buildClaudeAdapter({externalIds, externalBaseDir, catalogUrl, pluginRunner}) →
 *      versionFor → runInstall
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

  // Adapt CommandRunner → PluginRunner (PluginRunner accepts an optional env opts arg;
  // the CommandRunner signature doesn't carry it, so we ignore it here — tests don't
  // need the env forwarding that GITLAB_TOKEN injection provides).
  const pluginRunner: PluginRunner = (command, args) =>
    runner(command, args).then(
      (r) => ({ exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }),
    );

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

    const adapter = await buildClaudeAdapter(env, artifactsDir, {
      externalIds,
      externalBaseDir: dir,
      catalogUrl,
      pluginRunner,
    });

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
