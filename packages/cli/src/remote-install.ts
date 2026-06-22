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
 *   security scan (external entries only) → mergeCatalogs → resolve ids →
 *   buildClaudeAdapter({externalIds, externalBaseDir, catalogUrl, pluginRunner}) →
 *   versionFor → runInstall.
 *
 * Security policy (ADR-0014):
 * - ONLY external entries are scanned (built-in content is trusted).
 * - Scan occurs BEFORE plan/apply — no files are written if scan blocks.
 * - Without --force: a blocking verdict throws ScanBlockedError (fail-closed).
 * - With --force: a blocking verdict emits a warning and install proceeds.
 *
 * Constraints:
 * - No while loops.
 * - No process.exit.
 * - No I/O imports beyond what catalog + adapters + core provide.
 * - exactOptionalPropertyTypes: never assigns undefined to optional fields.
 */

import path from 'node:path';

import type { PluginRunner } from '@agent-rigger/adapters';
import { createCompositeScanner } from '@agent-rigger/core';
import { assertSafeArtifactName } from '@agent-rigger/core/artifact-name';
import type { Env } from '@agent-rigger/core/paths';
import type { Scanner } from '@agent-rigger/core/scan';
import type { Scope } from '@agent-rigger/core/types';

import {
  type ArtifactEntry,
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
// ScanBlockedError
// ---------------------------------------------------------------------------

/**
 * Thrown by scanExternalEntries (and therefore runRemoteInstall / runUpdate)
 * when the composite scanner rejects one or more external entries and --force
 * is not set.
 *
 * No files are written before this error is raised.
 */
export class ScanBlockedError extends Error {
  readonly findings: string[];

  constructor(findings: string[]) {
    const findingsList = findings.map((f) => `  - ${f}`).join('\n');
    super(
      `Security scan blocked installation. Findings:\n${findingsList}\n\nRe-run with --force to install anyway.`,
    );
    this.name = 'ScanBlockedError';
    this.findings = findings;
  }
}

// ---------------------------------------------------------------------------
// scanPathFor — derive the filesystem path to scan inside the checkout dir
// ---------------------------------------------------------------------------

export function scanPathFor(entry: ArtifactEntry, baseDir: string): string | null {
  if (entry.nature === 'skill') {
    const name = entry.id.replace(/^skill:/, '');
    return path.join(baseDir, 'skills', name);
  }
  if (entry.nature === 'agent') {
    const name = entry.id.replace(/^agent:/, '');
    return path.join(baseDir, 'agents', name + '.md');
  }
  // hook and others not yet supported for scanning
  return null;
}

// ---------------------------------------------------------------------------
// scanExternalEntries — reusable scan gate
// ---------------------------------------------------------------------------

/**
 * Scan all entries that have a resolvable checkout path in the given directory.
 *
 * - Resolves each entry to a scan path (skills/agents only; others skipped naturally).
 * - Runs scanner.scan() in parallel via Promise.all.
 * - If any verdict is !ok and force is false → throws ScanBlockedError.
 * - If any verdict is !ok and force is true  → returns { warnings: [...] }.
 * - If all ok → returns { warnings: [] }.
 *
 * Callers prepend the warnings to their output.
 *
 * @param opts.entries  ArtifactEntry list to scan (entries without a checkout path are skipped).
 * @param opts.baseDir  Root of the remote checkout directory.
 * @param opts.scanner  Scanner instance to use.
 * @param opts.force    When true, blocking scan warns instead of throwing.
 */
export async function scanEntries(opts: {
  entries: ArtifactEntry[];
  baseDir: string;
  scanner: Scanner;
  force: boolean;
}): Promise<{ warnings: string[] }> {
  const { entries, baseDir, scanner, force } = opts;

  if (entries.length === 0) {
    return { warnings: [] };
  }

  const scanTargets = entries
    .map((entry) => ({ entry, scanPath: scanPathFor(entry, baseDir) }))
    .filter((t): t is { entry: ArtifactEntry; scanPath: string } => t.scanPath !== null);

  if (scanTargets.length === 0) {
    return { warnings: [] };
  }

  const verdicts = await Promise.all(
    scanTargets.map(({ scanPath }) => scanner.scan(scanPath)),
  );

  const allFindings = verdicts.flatMap((v) => v.findings ?? []);
  const anyBlocked = verdicts.some((v) => !v.ok);

  if (!anyBlocked) {
    return { warnings: [] };
  }

  if (!force) {
    throw new ScanBlockedError(allFindings);
  }

  return {
    warnings: [
      `[warning] security scan findings (installed anyway via --force): ${allFindings.join('; ')}`,
    ],
  };
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
 *      readCatalogDir(dir) → frontier guard → scanExternalEntries (external only) →
 *      mergeCatalogs → resolve →
 *      buildClaudeAdapter({externalIds, externalBaseDir, catalogUrl, pluginRunner}) →
 *      versionFor → runInstall
 *    })
 * 3. Returns InstallResult from runInstall.
 *
 * cleanup is guaranteed by withRemoteCheckout (finally).
 * Path-traversal ids are rejected before any file operation (UnsafeArtifactNameError).
 *
 * @param opts.scanner - Optional scanner override. Defaults to createCompositeScanner().
 * @param opts.force   - When true, a blocking scan emits a warning but install proceeds.
 *                       When false/absent, a blocking scan throws ScanBlockedError.
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
  scanner?: Scanner;
  force?: boolean;
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

  const force = opts.force === true;
  const scanner = opts.scanner ?? createCompositeScanner();

  // Adapt CommandRunner → PluginRunner (PluginRunner accepts an optional env opts arg;
  // the CommandRunner signature doesn't carry it, so we ignore it here — tests don't
  // need the env forwarding that GITLAB_TOKEN injection provides).
  const pluginRunner: PluginRunner = (command, args) =>
    runner(command, args).then(
      (r) => ({ exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }),
    );

  const version = await resolveVersion(catalogUrl, runner);

  return withRemoteCheckout(
    catalogUrl,
    version.ref,
    version.isTag,
    runner,
    { tmpFactory },
    async (dir) => {
      const { entries: remoteEntries } = await readCatalogDir(dir);

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

      // Entries with a checkout path (skills/agents) are "remote" — they come
      // from the fetched content repo. Others (guardrails, contexts, hooks)
      // always come from the local artifacts dir.
      // Plugin entries that appear in remoteEntries (not in builtin) are also
      // considered remote: they use catalogUrl as their marketplace URL.
      const remoteEntryIds = new Set(remoteEntries.map((e) => e.id));
      const remoteIds = new Set(
        resolved
          .filter(
            (e) =>
              scanPathFor(e, dir) !== null
              || (e.nature === 'plugin' && remoteEntryIds.has(e.id)),
          )
          .map((e) => e.id),
      );

      // Security scan — all entries that have a checkout path (uniform scan, ADR-0014).
      // Entries without a scanPath (e.g. guardrails, hooks) are naturally skipped.
      const { warnings } = await scanEntries({
        entries: resolved,
        baseDir: dir,
        scanner,
        force,
      });

      const adapter = await buildClaudeAdapter(env, artifactsDir, {
        externalIds: remoteIds,
        externalBaseDir: dir,
        catalogUrl,
        pluginRunner,
      });

      const versionFor = (
        entry: { id: string },
      ): { ref: string; sha: string } => {
        if (remoteIds.has(entry.id)) {
          return { ref: version.ref, sha: version.sha };
        }
        return { ref: 'v0.0.0', sha: '' };
      };

      const result = await runInstall({
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

      if (warnings.length === 0) {
        return result;
      }

      return { ...result, output: `${warnings.join('\n')}\n${result.output}` };
    },
  );
}
