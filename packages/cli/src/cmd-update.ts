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
 *   2. withRemoteCheckout → readCatalogDir → resolve → buildAdapter(assistant, …).
 *   3. Confirm BEFORE any destructive operation.
 *   4. If confirmed: remove (unlink old) then apply (link fresh content).
 *
 * Transactional guarantee:
 *   - A network failure, CatalogParseError, or resolve error aborts BEFORE the remove.
 *   - confirm=false → nothing is removed or written; artifact stays at old version.
 *   - resolveVersion is called exactly once.
 *
 * Assistant (E6, R1): `assistant` (defaults to 'claude') scopes every manifest
 * read — candidate ids, classification, and the confirm preview all key by
 * (id, scope, assistant), so an identical id installed for the OTHER assistant
 * is never a candidate, never previewed, never touched.
 *
 * Constraints:
 * - No while loops.
 * - No process.exit.
 * - exactOptionalPropertyTypes: never assign undefined to optional fields.
 */

import type { PluginRunner } from '@agent-rigger/adapters';
import {
  isUpdateAvailable,
  localId,
  mergeCatalogs,
  qualifyRef,
  readCatalogDir,
  resolveVersion,
  type TmpDirFactory,
  withRemoteCheckout,
} from '@agent-rigger/catalog';
import { catalogPrefixOf, resolveWithEdges } from '@agent-rigger/catalog/resolver';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import type { Assistant } from '@agent-rigger/core';
import { createCompositeScanner } from '@agent-rigger/core';
import { assertSafeArtifactName } from '@agent-rigger/core/artifact-name';
import { apply, remove } from '@agent-rigger/core/engine';
import { readManifest } from '@agent-rigger/core/manifest';
import type { Env } from '@agent-rigger/core/paths';
import { acquireRunLock } from '@agent-rigger/core/run-lock';
import { constantScanner } from '@agent-rigger/core/scan';
import type { Scanner } from '@agent-rigger/core/scan';
import type { Scope } from '@agent-rigger/core/types';

import { buildAdapter } from './adapter-dispatch';
import { targetsAssistant } from './cmd-install';
import { buildLibMaterializations, partitionForeignRequires, scanEntries } from './remote-install';
import { ANSI, paint, shouldColor } from './ui';

/**
 * Printed once when `update` (no ids) finds nothing to update across every
 * configured catalog for the resolved scope + assistant (b1b4-R2). Exported so
 * the CLI no-ids call site (cli.ts handleUpdate) and this module's defensive
 * `candidateIds.length === 0` branch share a single source of truth — the R2
 * test asserts the exact, unique occurrence against this constant.
 */
export const NO_UPDATE_CANDIDATES_MSG = 'No external artifacts to update.';

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
  /**
   * Emit ANSI colour in the output. Defaults to TTY auto-detection
   * (see {@link shouldColor}). Pass false in tests for deterministic output.
   */
  color?: boolean;
  /**
   * Target assistant (R1, one-assistant-per-transaction). Defaults to 'claude'
   * (back-compat). Only manifest entries installed for this assistant are
   * candidates — an identical id installed for the OTHER assistant is left
   * untouched, never updated as a side effect.
   */
  assistant?: Assistant;
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
 *      buildAdapter(assistant, env, {externalIds, externalBaseDir: dir}) →
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
  // Raw scanner (NOT memoized) — parity with runRemoteInstall: the pre-apply gate
  // scans the whole stale set as one union (scanEntries below) and the apply-time
  // re-check is handed a constant union verdict, so no per-path cache is threaded
  // through either seam.
  const scanner: Scanner = opts.scanner ?? createCompositeScanner();
  const assistant: Assistant = opts.assistant ?? 'claude';

  // Adapt CommandRunner → PluginRunner (mirrors remote-install.ts's runRemoteInstall)
  // so buildAdapter's claude-native delegation (`claude mcp add-json`/`remove`,
  // `claude plugin install`/`uninstall`) goes through the SAME runner as the
  // checkout's git operations, instead of silently falling back to its own
  // Bun.spawn-backed default — required for update to be testable/injectable
  // for claude-targeted natures, and for parity with install.
  const pluginRunner: PluginRunner = (command, args) =>
    runner(command, args).then(
      (r) => ({ exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }),
    );

  // Outcome line renderer — one artifact per line, aligned tag column, mirrors
  // renderReport()'s `[ ok  ] id` aesthetic. Colour is a no-op when colorOn=false.
  const colorOn = shouldColor(opts.color);
  const TAG_WIDTH = 12;
  const outcomeLine = (tag: string, tagColor: string, id: string, suffix: string): string => {
    const gap = ' '.repeat(TAG_WIDTH - tag.length + 2);
    return `  ${paint(tag, tagColor, colorOn)}${gap}${id}  ${suffix}`;
  };

  const manifest = await readManifest(manifestPath);

  // Determine the candidate id set.
  // When ids is empty: all installed artifacts for the given scope AND assistant
  // are candidates (R1) — an identical id installed for the other assistant is
  // simply not a candidate here, never touched as a side effect.
  // Classification below filters out those without a remote version.
  //
  // When ids is non-empty: exact manifest match only (ADR-0017 §5 — qualified ids end-to-end).
  // Callers must pass qualified ids; unqualified ids result in a "not installed" skip.
  const candidateIds: string[] = ids.length === 0
    ? manifest.artifacts
      .filter((e) => e.scope === scope && (e.assistant ?? 'claude') === assistant)
      .map((e) => e.id)
    : ids;

  if (candidateIds.length === 0) {
    return { output: NO_UPDATE_CANDIDATES_MSG, updated: [], upToDate: [], skipped: [] };
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
    const entry = manifest.artifacts.find(
      (e) => e.id === id && e.scope === scope && (e.assistant ?? 'claude') === assistant,
    );

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

    // `?? ''` defends against a legacy on-disk entry written before sha
    // tracking existed (R2, isUpdateAvailable degrades gracefully).
    if (isUpdateAvailable(entry.ref, entry.sha ?? '', remote)) {
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
      // R1 (lot 6, D1): same provenance check as install — abort before any
      // remove/apply when the checkout's HEAD doesn't match the sha
      // resolveVersion just resolved (homonymous branch/tag, TOCTOU re-push).
      { tmpFactory, expectedSha: remote.sha },
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

        // R3 pre-pass (lot 6, D3): parity with runRemoteInstall — partition every
        // cross-catalogue require reachable from the stale set by manifest
        // presence BEFORE resolve() runs. sourceName is derived from the stale
        // ids themselves: every id in one runUpdate call already shares the same
        // catalogue prefix (the CLI groups update targets by catalog before
        // calling runUpdate), so the first qualified id names it. A poisoned
        // release (a new require that isn't installed) fails THIS source's
        // transaction only — a caller iterating multiple sources catches this
        // and moves on to the next; nothing here blocks that.
        const sourceName = catalogPrefixOf(staleIds[0] ?? '');
        const externallySatisfied = partitionForeignRequires(
          rawStaleIds,
          effective,
          sourceName,
          manifest,
          scope,
          assistant,
        );

        // Resolve WITH edges (S4/R5): capture each entry's resolved requires
        // (own + pack-inherited) PRE-prune. This is the backfill path (S6): a
        // legacy entry with no edges gains them on the first update, which
        // re-resolves. rawResolved reads `effective` (requires refs stay on
        // requirers; only the resolve graph skips externallySatisfied refs).
        const rawResolvedWithEdges = resolveWithEdges(rawStaleIds, effective, externallySatisfied);
        const rawResolved = rawResolvedWithEdges.map((r) => r.entry);

        // Restore qualification: map raw resolved entries back to their manifest-qualified ids.
        // Build a lookup from local-id → qualified id for the stale set.
        const localToQualified = new Map(staleIds.map((qid) => [localId(qid), qid]));
        const resolved = rawResolved.map((e) => ({
          ...e,
          id: localToQualified.get(e.id) ?? e.id,
        }));

        // Qualify the captured edges (qualifyRef idempotent: intra-catalogue
        // refs gain the prefix, cross-catalogue refs stay intact), keyed by the
        // manifest-qualified requirer id so adapterEntries can thread them onto
        // AdapterEntry.requires for buildManifestEntry to persist.
        const qualifyEdge = (ref: string): string =>
          sourceName === undefined ? ref : qualifyRef(sourceName, ref);
        const requiresByQualifiedId = new Map<string, string[]>(
          rawResolvedWithEdges.map((r) => [
            localToQualified.get(r.entry.id) ?? r.entry.id,
            r.requires.map(qualifyEdge),
          ]),
        );

        // All stale entries sourced from the remote checkout.
        // Skills / agents / guardrails / contexts / hooks all have a scanPath;
        // all are remote regardless.
        // remoteIds uses qualified ids; buildClaudeAdapter and versionFor key by them.
        //
        // targetsAssistant filter: provably redundant TODAY (candidates come from
        // the manifest already scoped by (scope, assistant), and packs are stored
        // expanded — no sibling-target id can reach this set), but the adapter
        // boundary invariant (see remote-install.ts remoteIds) says every resolved
        // selection handed to a single-assistant adapter is target-filtered.
        // Defence in depth: if a future change lets a pack id or a re-resolution
        // reach this path, cross-target entries are dropped instead of tripping
        // the mono-guardrail guard (or silently resolving the wrong guardrail).
        const remoteIds = new Set(
          resolved.filter((e) => targetsAssistant(e, assistant)).map((e) => e.id),
        );

        // Build effectiveEntries map with qualified ids for hookSpec resolution
        // (maps qualified id → entry, merging qualifier on top of raw entries).
        const effectiveEntries = new Map(
          rawResolved.map((e) => [localToQualified.get(e.id) ?? e.id, e]),
        );

        // 3c. Security scan — catalog.json unconditionally, plus every entry that
        //     has a checkout path (uniform scan, ADR-0014). Shares scanEntries
        //     with runRemoteInstall — same coverage, no duplicated policy.
        //     Must be BEFORE remove so a blocked scan leaves the artifact intact.
        //     scanEntries uses localId() internally for path derivation.
        const { warnings: scanWarnings, verdict } = await scanEntries({
          entries: resolved,
          baseDir: dir,
          scanner,
          force,
        });

        // R5 (lot 6, D5): replay every stale mcp entry's previously-resolved
        // secretRefs from the manifest, so the re-render (mcpSource) reuses
        // the SAME ref→VAR overrides without asking again — no --secret-env,
        // no TTY prompt, no re-collection (ADR-0020 §1). Merged across the
        // stale set (distinct mcp entries normally use distinct ref names).
        // Both mcp applied payload kinds carry secretRefs (types.ts) — gating
        // on 'opencode-mcp' alone silently skipped every 'claude-mcp' entry,
        // defaulting its ref back to its own name and either throwing
        // MissingRequiredSecretError or drifting the rendered config away
        // from what was actually installed (R8's "mêmes garanties que R5").
        const secretOverrides: Record<string, string> = {};
        for (const id of staleIds) {
          const staleEntry = manifest.artifacts.find(
            (e) => e.id === id && e.scope === scope && (e.assistant ?? 'claude') === assistant,
          );
          const applied = staleEntry?.applied;
          if (
            (applied?.kind === 'opencode-mcp' || applied?.kind === 'claude-mcp')
            && applied.secretRefs
          ) {
            Object.assign(secretOverrides, applied.secretRefs);
          }
        }

        // 3e. Build adapter with remote resolver seam (externalBaseDir = checkout dir).
        // Thread the union verdict to the apply-time re-check only on the
        // non-force path, via constantScanner — see runRemoteInstall
        // (remote-install.ts) for the full rationale: when !force, scanEntries
        // above already threw on any blocking verdict, so replaying the ok union
        // verdict at apply is a safe no-op; when force=true, a blocking verdict
        // was deliberately overridden at the gate and Scanner/applySkill have no
        // notion of --force, so re-threading it here would re-block a run the
        // operator explicitly forced through. R8 tautology: this re-check is
        // defence BY CONSTRUCTION (the constant verdict is what the gate already
        // computed over a superset of every applied source), not a runtime
        // re-scan — the real apply-time blocking path stays pinned by t4's
        // scanner injection at the adapter boundary. See runRemoteInstall.
        const adapter = await buildAdapter(assistant, env, {
          externalIds: remoteIds,
          externalBaseDir: dir,
          effectiveEntries,
          // Claude-native delegation (mcp/plugin natures) goes through the same
          // runner as the checkout's git operations — see pluginRunner above.
          pluginRunner,
          // Constant union verdict for the apply-time re-check under !force only:
          // under --force the gate warns-and-proceeds, so replaying a blocking
          // verdict would wrongly re-throw at apply. Defense-in-depth, redundant
          // while applied skills stay a subset of the gate's scanned union.
          ...(force ? {} : { scanner: constantScanner(verdict) }),
          ...(Object.keys(secretOverrides).length === 0 ? {} : { secretOverrides }),
        });

        // Lib materialisations (R3): a stale consumer's requires can pull a lib
        // into `resolved`. It is re-materialised by the engine's parallel
        // channel (apply({ libs })) — at the SAME call point, under the single
        // lock, so update has no second orchestration site. `source` is the
        // checkout path (scanPathFor('lib')[0], the pinned scanned path, R2);
        // requires are the backfilled edges (S6). This is also where a legacy
        // entry whose require points a lib gains its edge on the first update.
        //
        // Qualify the lib id the SAME way install does (qualifyRef): a lib is
        // pulled transitively, never a stale candidate, so localToQualified
        // (stale set only) leaves it local — the materialised entry id must be
        // `<catalog>/lib:<name>`, matching the install path AND the consumer's
        // backfilled edge, or the two would split the refcount.
        const libs = buildLibMaterializations(
          resolved
            .filter((e) => e.nature === 'lib')
            .map((e) => ({ ...e, id: qualifyEdge(e.id) })),
          dir,
          requiresByQualifiedId,
        );

        // AdapterEntries for remove+apply — exclude tool AND lib natures (S3: a
        // lib never reaches the adapter's remove/plan, which would raise
        // UnsupportedNatureError). Thread the captured requires (S4/R5) onto the
        // opaque AdapterEntry transport so buildManifestEntry backfills them
        // (S6). Omit when none, per the AdapterEntry.requires convention.
        const adapterEntries = resolved
          .filter((e) => e.nature !== 'tool' && e.nature !== 'lib')
          .map((e) => {
            const requires = requiresByQualifiedId.get(e.id) ?? [];
            return requires.length > 0
              ? { id: e.id, nature: e.nature, scope, requires }
              : { id: e.id, nature: e.nature, scope };
          });

        // 3e. versionFor seam: remote (has checkout path) → real ref/sha, others → v0.0.0/''.
        // A lib is remote content too but excluded from remoteIds (targets: [],
        // S3): union the lib ids into the version-eligible set so it is stamped
        // with the real catalogue ref/sha (else a permanent doctor missing-sha,
        // re-stamped '' by every update). remoteIds itself is untouched; the
        // 'shared' assistant keeps a lib a non-candidate for direct update.
        const remoteVersionIds = new Set([...remoteIds, ...libs.map((l) => l.id)]);
        const versionFor = (
          entry: { id: string },
        ): { ref: string; sha: string } => {
          if (remoteVersionIds.has(entry.id)) {
            return { ref: remote.ref, sha: remote.sha };
          }
          return { ref: 'v0.0.0', sha: '' };
        };

        // 3f. Collect plan-level warnings (e.g. a remote guardrail widening
        // permissions.allow — T5, post-ADR-0015) via adapter.plan(), BEFORE
        // confirm — mirrors cmd-install's op.warnings collection so the same
        // signal is visible on update, not just on install. This is a PLAN
        // warning (attached by planGuardrail), not a scan finding: it is
        // always emitted, independent of scanEntries/the scanner above.
        // adapter.plan() is read-only, so calling it again inside apply() is
        // a safe, side-effect-free duplicate (same pattern as cmd-install).
        const plannedOpsByEntry = await Promise.all(
          adapterEntries.map((entry) => adapter.plan(entry, scope, env)),
        );
        const opWarnings = [
          ...new Set(
            plannedOpsByEntry
              .flat()
              .flatMap((op) => ('warnings' in op && Array.isArray(op.warnings) ? op.warnings : [])),
          ),
        ];
        const warningsBlock = opWarnings.length > 0
          ? '\n--- Warnings ---\n' + opWarnings.map((w) => `  [warning] ${w}`).join('\n') + '\n'
          : '';

        // 3g. Confirm BEFORE remove — abort with zero writes if user declines.
        const installedRefs = staleIds
          .map((id) => {
            const m = manifest.artifacts.find(
              (e) => e.id === id && e.scope === scope && (e.assistant ?? 'claude') === assistant,
            );
            return m === undefined
              ? `  ${id}  → ${remote.ref}`
              : `  ${id}  ${m.ref} → ${remote.ref}`;
          })
          .join('\n');
        const planText = `Update ${staleIds.length} artifact(s):\n${installedRefs}${warningsBlock}`;

        const confirmed = typeof confirm === 'boolean' ? confirm : await confirm(planText);

        if (!confirmed) {
          return { aborted: true as const, scanWarnings, opWarnings };
        }

        // 3h/3i. Remove old then apply fresh under a SINGLE run lock (R7/D7):
        // update is a remove-then-apply, so holding ONE hold across both phases
        // keeps the whole transaction atomic against a concurrent run — letting
        // the engine acquire+release twice would open a gap between them. The
        // handle is passed to both, so neither self-acquires. ConcurrentRunError
        // from acquireRunLock propagates (nothing removed/written yet).
        const lock = await acquireRunLock(manifestPath);
        try {
          // 3h. Remove old (targets absent → plan will produce link ops in apply).
          await remove(adapter, adapterEntries, scope, env, manifestPath, undefined, lock);

          // 3i. Apply fresh content from checkout dir + upsert manifest with
          // ref/sha, re-materialising any lib pulled by the stale set on the
          // engine's parallel channel (R3) under this same lock.
          await apply({
            adapter,
            entries: adapterEntries,
            scope,
            env,
            manifestPath,
            versionFor,
            lock,
            ...(libs.length > 0 ? { libs } : {}),
          });
        } finally {
          await lock.release();
        }

        return { aborted: false as const, scanWarnings, opWarnings };
      },
    );

    if (checkoutResult.aborted) {
      // Mirror of the success branch: scan warnings collected before the confirm
      // prompt would otherwise be dropped on abort, letting the user believe the
      // content was scanned clean. opWarnings are NOT re-pushed here — they were
      // already shown in the confirm's planText (warningsBlock).
      if (checkoutResult.scanWarnings.length > 0) {
        outputParts.push(...checkoutResult.scanWarnings);
      }
      outputParts.push('  [aborted] Update cancelled by user.');
    } else {
      updatedIds = staleIds;
      if (checkoutResult.scanWarnings.length > 0) {
        outputParts.push(...checkoutResult.scanWarnings);
      }
      if (checkoutResult.opWarnings.length > 0) {
        outputParts.push('--- Warnings ---');
        for (const w of checkoutResult.opWarnings) {
          outputParts.push(`  [warning] ${w}`);
        }
      }
      outputParts.push('--- Update ---');
      for (const id of staleIds) {
        outputParts.push(outcomeLine('[updated]', ANSI.green, id, `→ ${remote.ref}`));
      }
    }
  }

  if (upToDateIds.length > 0) {
    for (const id of upToDateIds) {
      outputParts.push(outcomeLine('[up-to-date]', ANSI.dim, id, `(${remote.ref})`));
    }
  }

  for (const id of skippedIds) {
    const reason = skipReasons.get(id) ?? 'skipped';
    outputParts.push(outcomeLine('[skipped]', ANSI.yellow, id, reason));
  }

  const output = outputParts.join('\n');

  return {
    output,
    updated: updatedIds,
    upToDate: upToDateIds,
    skipped: skippedIds,
  };
}
