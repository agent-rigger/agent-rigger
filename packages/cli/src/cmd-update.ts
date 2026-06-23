/**
 * cmd-update.ts — `update` command implementation (M1c-2).
 *
 * Responsibilities:
 * - Read the manifest to find installed external entries.
 * - If `ids` is empty, target all external entries for the given scope.
 * - For each candidate id: classify as stale, upToDate, or skipped.
 *   - not in manifest                              → skipped
 *   - not present in the remote catalog (no remote ref) → skipped (no remote version)
 *   - resolveVersion says newer (isUpdateAvailable) → stale
 *   - already at latest ref                        → upToDate
 * - For stale entries: transactional checkout-first pipeline:
 *   1. resolveVersion (once).
 *   2. withRemoteCheckout → readCatalogDir → resolve → buildClaudeAdapter.
 *   3. Confirm BEFORE any destructive operation.
 *   4. If confirmed: remove (unlink old) then apply (link fresh content).
 *
 * Transactional guarantee:
 *   - A network failure, CatalogParseError, or resolve error aborts BEFORE the remove.
 *   - confirm=false → nothing is removed or written; artifact stays at old version.
 *   - resolveVersion is called exactly once.
 *
 * Constraints:
 * - No while loops.
 * - No process.exit.
 * - exactOptionalPropertyTypes: never assign undefined to optional fields.
 */

import {
  isUpdateAvailable,
  mergeCatalogs,
  readCatalogDir,
  resolveVersion,
  type TmpDirFactory,
  withRemoteCheckout,
} from '@agent-rigger/catalog';
import { resolve } from '@agent-rigger/catalog/resolver';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { createCompositeScanner } from '@agent-rigger/core';
import { assertSafeArtifactName } from '@agent-rigger/core/artifact-name';
import { apply, remove } from '@agent-rigger/core/engine';
import { readManifest } from '@agent-rigger/core/manifest';
import type { Env } from '@agent-rigger/core/paths';
import type { Scanner } from '@agent-rigger/core/scan';
import type { Scope } from '@agent-rigger/core/types';

// ---------------------------------------------------------------------------
// localId — strip source-qualifier prefix (ADR-0017 consumer helper)
// ---------------------------------------------------------------------------

/**
 * Return the local (unqualified) part of a catalog entry id.
 *
 * Examples:
 *   'skill:foo'            → 'skill:foo'
 *   'principal/skill:foo'  → 'skill:foo'
 */
function localId(id: string): string {
  const slashIdx = id.indexOf('/');
  return slashIdx === -1 ? id : id.slice(slashIdx + 1);
}

import { buildClaudeAdapter } from './cli';
import { scanEntries } from './remote-install';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunUpdateOptions {
  /** Explicit ids to update. Empty array = all installed external entries. */
  ids: string[];
  scope: Scope;
  env: Env;
  /** Absolute path to state.json (the manifest). */
  manifestPath: string;
  /** Remote catalog URL. */
  catalogUrl: string;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  confirm: boolean | ((planText: string) => Promise<boolean>);
  /**
   * Optional scanner for external entries. Defaults to createCompositeScanner({ run }).
   * Inject a fake scanner in tests to avoid spawning real security tools.
   */
  scanner?: Scanner;
  /**
   * When true, a blocking scan emits a warning in the output but update proceeds.
   * When false/absent, a blocking scan throws ScanBlockedError (fail-closed).
   */
  force?: boolean;
}

export interface UpdateResult {
  /** Human-readable summary. */
  output: string;
  /** ids that were re-installed (stale). */
  updated: string[];
  /** ids that are already at the latest version. */
  upToDate: string[];
  /** ids that were skipped (not installed, no remote version, or aborted). */
  skipped: string[];
}

// ---------------------------------------------------------------------------
// runUpdate
// ---------------------------------------------------------------------------

/**
 * Execute the update command end-to-end.
 *
 * Transactional pipeline for stale entries (all steps within withRemoteCheckout):
 * 1. resolveVersion(catalogUrl) → remote (called once).
 * 2. Classify candidates → staleIds / upToDateIds / skippedIds.
 * 3. withRemoteCheckout(catalogUrl, remote.ref, runner, {tmpFactory}, async (dir) => {
 *      readCatalogDir(dir) → frontier guard → mergeCatalogs → resolve →
 *      buildClaudeAdapter({externalIds, externalBaseDir: dir}) →
 *      confirm (planText summarising the update) BEFORE any write →
 *      remove(adapter, staleEntries, scope, env, manifestPath) →
 *      apply(adapter, staleEntries, scope, env, manifestPath, versionFor)
 *    })
 * 4. Compose and return UpdateResult.
 *
 * If the checkout fails, catalog is invalid, confirm=false, or any step throws,
 * the artifact is never removed — it stays at the installed version.
 */
export async function runUpdate(opts: RunUpdateOptions): Promise<UpdateResult> {
  const {
    ids,
    scope,
    env,
    manifestPath,
    catalogUrl,
    runner,
    tmpFactory,
    confirm,
  } = opts;

  const force = opts.force === true;
  const scanner: Scanner = opts.scanner ?? createCompositeScanner();

  const manifest = await readManifest(manifestPath);

  // Determine the candidate id set.
  // When ids is empty: all installed artifacts for the given scope are candidates.
  // Classification below filters out those without a remote version.
  //
  // When ids is non-empty: exact manifest match only (ADR-0017 §5 — qualified ids end-to-end).
  // Callers must pass qualified ids; unqualified ids result in a "not installed" skip.
  const candidateIds: string[] = ids.length === 0
    ? manifest.artifacts
      .filter((e) => e.scope === scope)
      .map((e) => e.id)
    : ids;

  if (candidateIds.length === 0) {
    const output = 'No external artifacts to update.';
    return { output, updated: [], upToDate: [], skipped: [] };
  }

  // Step 1 — resolveVersion once. Any network error aborts here (nothing removed).
  const remote = await resolveVersion(catalogUrl, runner);

  // Step 2 — classify candidates.
  const staleIds: string[] = [];
  const staleManifestNatures: Map<
    string,
    import('@agent-rigger/core/types').Nature
  > = new Map();
  const upToDateIds: string[] = [];
  const skippedIds: string[] = [];
  const skipReasons: Map<string, string> = new Map();

  for (const id of candidateIds) {
    const entry = manifest.artifacts.find((e) => e.id === id && e.scope === scope);

    if (entry === undefined) {
      skippedIds.push(id);
      skipReasons.set(id, 'not installed');
      continue;
    }

    // Entries installed without a remote ref (ref 'v0.0.0', sha '') have no
    // remote version — they are not candidates for update.
    if (entry.ref === 'v0.0.0' && entry.sha === '') {
      skippedIds.push(id);
      skipReasons.set(id, 'no remote version');
      continue;
    }

    if (isUpdateAvailable(entry.ref, remote)) {
      staleIds.push(id);
      staleManifestNatures.set(entry.id, entry.nature);
    } else {
      upToDateIds.push(id);
    }
  }

  const outputParts: string[] = [];
  let updatedIds: string[] = [];

  // Step 3 — transactional update for stale entries.
  if (staleIds.length > 0) {
    const checkoutResult = await withRemoteCheckout(
      catalogUrl,
      remote.ref,
      remote.isTag,
      runner,
      { tmpFactory },
      async (dir) => {
        // 3a. Read + validate remote catalog (CatalogParseError → abort before remove).
        const { entries: remoteEntries } = await readCatalogDir(dir);

        // Frontier guard: reject traversal ids.
        // Always use localId() to strip any qualifier before path derivation.
        for (const entry of remoteEntries) {
          if (entry.kind !== 'artifact') continue;
          const local = localId(entry.id);
          if (entry.nature === 'skill') {
            assertSafeArtifactName(local.replace(/^skill:/, ''), entry.id);
          } else if (entry.nature === 'agent') {
            assertSafeArtifactName(local.replace(/^agent:/, ''), entry.id);
          }
        }

        // 3b. Resolve ids against effective catalog (UnknownEntryError → abort before remove).
        // staleIds may contain qualified ids (e.g. 'principal/skill:foo') from the manifest
        // (ADR-0017), but the raw checkout catalog has unqualified ids ('skill:foo').
        // Strip qualifiers for resolution, then restore them in the resolved entries.
        const { entries: effective } = mergeCatalogs([], remoteEntries);
        const rawStaleIds = staleIds.map(localId);
        const rawResolved = resolve(rawStaleIds, effective);

        // Restore qualification: map raw resolved entries back to their manifest-qualified ids.
        // Build a lookup from local-id → qualified id for the stale set.
        const localToQualified = new Map(staleIds.map((qid) => [localId(qid), qid]));
        const resolved = rawResolved.map((e) => ({
          ...e,
          id: localToQualified.get(e.id) ?? e.id,
        }));

        // All stale entries sourced from the remote checkout.
        // Skills / agents have a scanPath; guardrails / contexts / hooks do not
        // but still come from externalBaseDir. All are remote.
        // remoteIds uses qualified ids; buildClaudeAdapter and versionFor key by them.
        const remoteIds = new Set(resolved.map((e) => e.id));

        // Build effectiveEntries map with qualified ids for hookSpec resolution
        // (maps qualified id → entry, merging qualifier on top of raw entries).
        const effectiveEntries = new Map(
          rawResolved.map((e) => [localToQualified.get(e.id) ?? e.id, e]),
        );

        // 3c. Security scan — all entries that have a checkout path (uniform scan, ADR-0014).
        //     Entries without a scanPath (e.g. guardrails, hooks) are naturally skipped.
        //     Must be BEFORE remove so a blocked scan leaves the artifact intact.
        //     scanEntries uses localId() internally for path derivation.
        const { warnings: scanWarnings } = await scanEntries({
          entries: resolved,
          baseDir: dir,
          scanner,
          force,
        });

        // 3e. Build adapter with remote resolver seam (externalBaseDir = checkout dir).
        const adapter = await buildClaudeAdapter(env, {
          externalIds: remoteIds,
          externalBaseDir: dir,
          effectiveEntries,
        });

        // AdapterEntries for remove+apply (exclude tool-nature entries).
        const adapterEntries = resolved
          .filter((e) => e.nature !== 'tool')
          .map((e) => ({ id: e.id, nature: e.nature, scope }));

        // 3e. versionFor seam: remote (has checkout path) → real ref/sha, others → v0.0.0/''.
        const versionFor = (
          entry: { id: string },
        ): { ref: string; sha: string } => {
          if (remoteIds.has(entry.id)) {
            return { ref: remote.ref, sha: remote.sha };
          }
          return { ref: 'v0.0.0', sha: '' };
        };

        // 3g. Confirm BEFORE remove — abort with zero writes if user declines.
        const installedRefs = staleIds
          .map((id) => {
            const m = manifest.artifacts.find((e) => e.id === id && e.scope === scope);
            return m === undefined
              ? `  ${id}  → ${remote.ref}`
              : `  ${id}  ${m.ref} → ${remote.ref}`;
          })
          .join('\n');
        const planText = `Update ${staleIds.length} artifact(s):\n${installedRefs}`;

        const confirmed = typeof confirm === 'boolean' ? confirm : await confirm(planText);

        if (!confirmed) {
          return { aborted: true as const, scanWarnings };
        }

        // 3h. Remove old (targets absent → plan will produce link ops in apply).
        await remove(adapter, adapterEntries, scope, env, manifestPath);

        // 3i. Apply fresh content from checkout dir + upsert manifest with ref/sha.
        await apply(adapter, adapterEntries, scope, env, manifestPath, versionFor);

        return { aborted: false as const, scanWarnings };
      },
    );

    if (checkoutResult.aborted) {
      outputParts.push('  [aborted] Update cancelled by user.');
    } else {
      updatedIds = staleIds;
      if (checkoutResult.scanWarnings.length > 0) {
        outputParts.push(...checkoutResult.scanWarnings);
      }
      outputParts.push('--- Update ---');
      outputParts.push(`  [updated] ${staleIds.join(', ')} → ${remote.ref}`);
    }
  }

  if (upToDateIds.length > 0) {
    outputParts.push(`  [already up-to-date] ${upToDateIds.join(', ')} (${remote.ref})`);
  }

  for (const id of skippedIds) {
    const reason = skipReasons.get(id) ?? 'skipped';
    outputParts.push(`  [skipped] ${id}: ${reason}`);
  }

  const output = outputParts.join('\n');

  return {
    output,
    updated: updatedIds,
    upToDate: upToDateIds,
    skipped: skippedIds,
  };
}
