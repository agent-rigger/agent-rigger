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
 *   buildAdapter(assistant, env, {externalIds, externalBaseDir, catalogUrl, pluginRunner}) →
 *   versionFor → runInstall. `assistant` defaults to 'claude' when omitted
 *   (back-compat — the CLI always resolves and passes one explicitly, slice A).
 *
 * Security policy (ADR-0014):
 * - All fetched content is scanned uniformly: skills and agents by their checkout path,
 *   hooks by the entire hooks/ directory (guards + shared libs).
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
import type { Assistant } from '@agent-rigger/core';
import { createCompositeScanner } from '@agent-rigger/core';
import { assertSafeArtifactName } from '@agent-rigger/core/artifact-name';
import type { Env } from '@agent-rigger/core/paths';
import type { Scanner } from '@agent-rigger/core/scan';
import type { Scope } from '@agent-rigger/core/types';

import {
  type ArtifactEntry,
  mergeCatalogs,
  qualifyEntries,
  readCatalogDir,
  resolveVersion,
  type TmpDirFactory,
  withRemoteCheckout,
} from '@agent-rigger/catalog';
import { resolve } from '@agent-rigger/catalog/resolver';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';

import { buildAdapter } from './adapter-dispatch';
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
// localId — strip the source-qualifier prefix from a (potentially qualified) id
// ---------------------------------------------------------------------------

/**
 * Return the local (unqualified) part of a catalog entry id.
 *
 * Examples:
 *   'skill:foo'          → 'skill:foo'   (no prefix → unchanged)
 *   'principal/skill:foo' → 'skill:foo'  (prefix stripped)
 *
 * This is the inverse of the qualification applied by qualifyEntries.
 */
function localId(id: string): string {
  const slashIdx = id.indexOf('/');
  return slashIdx === -1 ? id : id.slice(slashIdx + 1);
}

// ---------------------------------------------------------------------------
// scanPathFor — derive the filesystem path to scan inside the checkout dir
// ---------------------------------------------------------------------------

export function scanPathFor(entry: ArtifactEntry, baseDir: string): string | null {
  const local = localId(entry.id);
  if (entry.nature === 'skill') {
    const name = local.replace(/^skill:/, '');
    return path.join(baseDir, 'skills', name);
  }
  if (entry.nature === 'agent') {
    const name = local.replace(/^agent:/, '');
    return path.join(baseDir, 'agents', name + '.md');
  }
  if (entry.nature === 'hook') {
    // The entire hooks/ directory is scanned so that guard scripts AND shared
    // libs (e.g. _shared/hook-lib.ts) are covered by the composite scanner.
    return path.join(baseDir, 'hooks');
  }
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
 * - If any verdict is degraded (no scanner tool installed) → actionable warning + proceeds.
 *   force is NOT needed for this case (ADR-0018).
 * - If any verdict is !ok (real findings, scanner present) and force is false → throws ScanBlockedError.
 * - If any verdict is !ok and force is true → returns { warnings: [...] }.
 * - If all ok and not degraded → returns { warnings: [] }.
 *
 * Callers prepend the warnings to their output.
 *
 * @param opts.entries  ArtifactEntry list to scan (entries without a checkout path are skipped).
 * @param opts.baseDir  Root of the remote checkout directory.
 * @param opts.scanner  Scanner instance to use.
 * @param opts.force    When true, a blocking scan (real findings) warns instead of throwing.
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

  const rawTargets = entries
    .map((entry) => ({ entry, scanPath: scanPathFor(entry, baseDir) }))
    .filter((t): t is { entry: ArtifactEntry; scanPath: string } => t.scanPath !== null);

  if (rawTargets.length === 0) {
    return { warnings: [] };
  }

  // Deduplicate scan paths: multiple hook entries share the same hooks/ directory;
  // scanning it once is sufficient and avoids redundant scanner invocations.
  const seenPaths = new Set<string>();
  const uniquePaths: string[] = [];
  for (const { scanPath } of rawTargets) {
    if (!seenPaths.has(scanPath)) {
      seenPaths.add(scanPath);
      uniquePaths.push(scanPath);
    }
  }

  const verdicts = await Promise.all(uniquePaths.map((p) => scanner.scan(p)));

  // Real findings from a present scanner (ok: false).
  const allFindings = verdicts.flatMap((v) => v.findings ?? []);
  const anyBlocked = verdicts.some((v) => !v.ok);

  // Degraded mode: scanner returned ok: true but no tool is installed (ADR-0018).
  // All verdicts are degraded — none ran a real scan.
  const anyDegraded = verdicts.some((v) => v.degraded === true);

  if (anyBlocked) {
    if (!force) {
      throw new ScanBlockedError(allFindings);
    }

    return {
      warnings: [
        `[warning] security scan findings (installed anyway via --force): ${
          allFindings.join('; ')
        }`,
      ],
    };
  }

  if (anyDegraded) {
    return {
      warnings: [
        '[warning] content not scanned — install gitleaks or trivy then re-run for a full scan; see `rigger doctor`',
      ],
    };
  }

  return { warnings: [] };
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
 *      buildAdapter(assistant, env, {externalIds, externalBaseDir, catalogUrl, pluginRunner}) →
 *      versionFor → runInstall
 *    })
 * 3. Returns InstallResult from runInstall.
 *
 * cleanup is guaranteed by withRemoteCheckout (finally).
 * Path-traversal ids are rejected before any file operation (UnsafeArtifactNameError).
 *
 * @param opts.scanner   - Optional scanner override. Defaults to createCompositeScanner().
 * @param opts.force     - When true, a blocking scan emits a warning but install proceeds.
 *                         When false/absent, a blocking scan throws ScanBlockedError.
 * @param opts.assistant - Target assistant (resolved upstream by assistant-select.ts).
 *                         Defaults to 'claude' when omitted (back-compat).
 */
export async function runRemoteInstall(opts: {
  ids: string[];
  catalogUrl: string;
  scope: Scope;
  env: Env;
  manifestPath: string;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  confirm: boolean | ((planText: string) => Promise<boolean>);
  scanner?: Scanner;
  force?: boolean;
  assistant?: Assistant;
  /**
   * When provided, raw catalog ids are qualified as `<sourceName>/<id>` so that
   * the manifest stores fully-qualified ids (ADR-0017). The caller is responsible
   * for stripping any existing qualifier from `ids` before passing them here, or
   * for passing pre-qualified ids — `localId()` normalises them either way.
   */
  sourceName?: string;
}): Promise<InstallResult> {
  const {
    ids,
    catalogUrl,
    scope,
    env,
    manifestPath,
    runner,
    tmpFactory,
    confirm,
  } = opts;

  const assistant: Assistant = opts.assistant ?? 'claude';

  const force = opts.force === true;
  const scanner = opts.scanner ?? createCompositeScanner();
  const sourceName = opts.sourceName;

  // Normalise: strip any existing qualifier prefix from user-provided ids so that
  // we always work with local (unqualified) ids when resolving against the raw
  // checkout catalog.
  const rawIds = ids.map(localId);

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
      // Always use local (unqualified) id for path derivation.
      for (const entry of remoteEntries) {
        if (entry.kind !== 'artifact') continue;
        const local = localId(entry.id);
        if (entry.nature === 'skill') {
          const name = local.replace(/^skill:/, '');
          assertSafeArtifactName(name, entry.id);
        } else if (entry.nature === 'agent') {
          const name = local.replace(/^agent:/, '');
          assertSafeArtifactName(name, entry.id);
        }
      }

      // Resolve against raw (unqualified) catalog first.
      const { entries: rawEffective } = mergeCatalogs([], remoteEntries);
      const rawResolved = resolve(rawIds, rawEffective);

      // When a sourceName is provided, qualify all resolved entries so that the
      // manifest stores fully-qualified ids (e.g. 'principal/guardrail:main').
      // The adapter and version lookup still key by qualified id.
      const qualify = (id: string): string =>
        sourceName !== undefined && !id.includes('/') ? `${sourceName}/${id}` : id;

      const resolved: ArtifactEntry[] = sourceName === undefined
        ? rawResolved
        : rawResolved.map((e) => ({ ...e, id: qualify(e.id) }));

      // Qualify the effective catalog using qualifyEntries so that pack members,
      // requires, and ids are ALL qualified (not just the top-level id field).
      // This prevents UnknownEntryError when resolve() tries to look up pack members.
      const effective = sourceName === undefined
        ? rawEffective
        : qualifyEntries(sourceName, rawEffective);

      // All entries from the remote catalog are sourced from the checkout.
      // - Skills / agents: have a checkout path (scanPathFor != null).
      // - Guardrails / contexts / hooks: no scan path but also come from checkout.
      // - Plugins: from the remote catalog's marketplace URL.
      // remoteIds tells buildClaudeAdapter which entries to resolve from externalBaseDir.
      // Use qualified ids here to match the (potentially qualified) resolved entries.
      const qualifiedRemoteEntryIds = new Set(remoteEntries.map((e) => qualify(e.id)));
      const remoteIds = new Set(
        resolved
          .filter((e) => qualifiedRemoteEntryIds.has(e.id))
          .map((e) => e.id),
      );

      // Security scan — all entries that have a checkout path (uniform scan, ADR-0014).
      // Entries without a scanPath (e.g. guardrails, hooks) are naturally skipped.
      // scanPathFor uses localId() internally to strip the qualifier before path derivation.
      const { warnings } = await scanEntries({
        entries: resolved,
        baseDir: dir,
        scanner,
        force,
      });

      // Build effectiveEntries map for hookSpec resolution (qualified ids).
      const effectiveEntries = new Map(effective.map((e) => [e.id, e]));

      const adapter = await buildAdapter(assistant, env, {
        externalIds: remoteIds,
        externalBaseDir: dir,
        catalogUrl,
        pluginRunner,
        effectiveEntries,
      });

      const versionFor = (
        entry: { id: string },
      ): { ref: string; sha: string } => {
        if (remoteIds.has(entry.id)) {
          return { ref: version.ref, sha: version.sha };
        }
        return { ref: 'v0.0.0', sha: '' };
      };

      // Pass qualified ids and qualified catalog to runInstall so the manifest
      // stores fully-qualified ids.
      const selectedIds = sourceName === undefined ? ids : ids.map(qualify);
      const result = await runInstall({
        catalog: effective,
        adapter,
        scope,
        env,
        manifestPath,
        selectedIds,
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
