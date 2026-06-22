/**
 * cmd-update.ts — `update` command implementation (M1c-2).
 *
 * Responsibilities:
 * - Read the manifest to find installed external entries.
 * - If `ids` is empty, target all external entries for the given scope.
 * - For each candidate id: classify as stale, upToDate, or skipped.
 *   - not in manifest (or source !== 'external')  → skipped ("not installed" or "no remote version")
 *   - resolveVersion says newer (isUpdateAvailable) → stale
 *   - already at latest ref                        → upToDate
 * - For stale entries: remove → runRemoteInstall (so planSkill sees the target absent
 *   and produces a link op; engine.apply copies fresh content and upserts ref/sha).
 * - Return UpdateResult { output, updated, upToDate, skipped }.
 *
 * Constraints:
 * - No while loops.
 * - No process.exit.
 * - exactOptionalPropertyTypes: never assign undefined to optional fields.
 */

import { isUpdateAvailable, resolveVersion, type TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { remove } from '@agent-rigger/core/engine';
import { readManifest } from '@agent-rigger/core/manifest';
import type { Env } from '@agent-rigger/core/paths';
import type { Scope } from '@agent-rigger/core/types';

import { buildClaudeAdapter } from './cli';
import { runRemoteInstall } from './remote-install';

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
  /** Absolute path to the bundled artifacts directory. */
  artifactsDir: string;
  /** Remote catalog URL. */
  catalogUrl: string;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  confirm: boolean | ((planText: string) => Promise<boolean>);
}

export interface UpdateResult {
  /** Human-readable summary. */
  output: string;
  /** ids that were re-installed (stale). */
  updated: string[];
  /** ids that are already at the latest version. */
  upToDate: string[];
  /** ids that were skipped (not installed or internal). */
  skipped: string[];
}

// ---------------------------------------------------------------------------
// runUpdate
// ---------------------------------------------------------------------------

/**
 * Execute the update command end-to-end.
 *
 * Pipeline:
 * 1. readManifest → determine candidates.
 * 2. If ids is empty, candidates = all external entries in manifest for scope.
 *    Otherwise, filter requested ids through the manifest.
 * 3. resolveVersion(catalogUrl) → remote version.
 * 4. For each candidate: isUpdateAvailable(installed.ref, remote) → stale vs upToDate.
 *    Non-installed or internal entries → skipped.
 * 5. For stale entries:
 *    a. Build a local adapter (no external-resolver seam — only needed for plan/apply).
 *    b. remove(adapter, staleEntries, scope, env, manifestPath) → unlink + drop from manifest.
 *    c. runRemoteInstall({ids: staleIds, …}) → fresh checkout + link + manifest upsert with ref/sha.
 * 6. Compose and return UpdateResult.
 */
export async function runUpdate(opts: RunUpdateOptions): Promise<UpdateResult> {
  const {
    ids,
    scope,
    env,
    manifestPath,
    artifactsDir,
    catalogUrl,
    runner,
    tmpFactory,
    confirm,
  } = opts;

  const manifest = await readManifest(manifestPath);

  // Determine the candidate id set.
  const candidateIds: string[] = ids.length === 0
    ? manifest.artifacts
      .filter((e) => e.scope === scope && e.source === 'external')
      .map((e) => e.id)
    : ids;

  if (candidateIds.length === 0) {
    const output = 'No external artifacts to update.';
    return { output, updated: [], upToDate: [], skipped: [] };
  }

  // Resolve remote version once for all candidates.
  const remote = await resolveVersion(catalogUrl, runner);

  // Classify candidates.
  const staleIds: string[] = [];
  const staleAdapterEntries: Array<
    { id: string; nature: import('@agent-rigger/core/types').Nature; scope: Scope }
  > = [];
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

    if (entry.source !== 'external') {
      skippedIds.push(id);
      skipReasons.set(id, 'no remote version');
      continue;
    }

    if (isUpdateAvailable(entry.ref, remote)) {
      staleIds.push(id);
      staleAdapterEntries.push({ id: entry.id, nature: entry.nature, scope });
    } else {
      upToDateIds.push(id);
    }
  }

  // Remove stale entries, then re-install fresh from remote checkout.
  const outputParts: string[] = [];

  if (staleIds.length > 0) {
    // Step 5a — local adapter (no external seam; planRemove only needs name → store/target).
    const localAdapter = await buildClaudeAdapter(env, artifactsDir);

    // Step 5b — unlink store+target + drop manifest entries so plan() returns ops on reinstall.
    await remove(localAdapter, staleAdapterEntries, scope, env, manifestPath);

    // Step 5c — re-install from remote checkout; engine.apply copies fresh content and
    // writes manifest with ref/sha via the versionFor seam in runRemoteInstall.
    const installResult = await runRemoteInstall({
      ids: staleIds,
      catalogUrl,
      scope,
      env,
      manifestPath,
      artifactsDir,
      runner,
      tmpFactory,
      confirm,
    });

    outputParts.push('--- Update ---');
    outputParts.push(`  [updated] ${staleIds.join(', ')} → ${remote.ref}`);
    outputParts.push('');
    outputParts.push(installResult.output);
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
    updated: staleIds,
    upToDate: upToDateIds,
    skipped: skippedIds,
  };
}
