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
 *   security scan (scanEntries: catalog.json + every scannable entry) → mergeCatalogs → resolve ids →
 *   R4 pre-flight (D4: refuse an opencode plugin requiring a lib when the
 *   host cannot symlink, before any write) → buildAdapter(assistant, env,
 *   {externalIds, externalBaseDir, catalogUrl, pluginRunner}) →
 *   versionFor → runInstall. `assistant` defaults to 'claude' when omitted
 *   (back-compat — the CLI always resolves and passes one explicitly, slice A).
 *
 * Security policy (ADR-0014):
 * - All fetched content is scanned uniformly: skills and agents by their checkout path,
 *   guardrails and contexts by their checkout dir/file, hooks by the entire hooks/
 *   directory (guards + shared libs), opencode plugins by the entire plugins/
 *   directory (native JS modules — ADR-0020 §4, H13), and catalog.json itself
 *   (mcp secrets, check/install command strings) unconditionally on every run.
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

import { lstat } from 'node:fs/promises';
import path from 'node:path';

import type { PluginRunner } from '@agent-rigger/adapters';
import type { Assistant } from '@agent-rigger/core';
import { createCompositeScanner } from '@agent-rigger/core';
import { assertSafeArtifactName } from '@agent-rigger/core/artifact-name';
import type { LinkOptions } from '@agent-rigger/core/linker';
import { probeSymlinkSupport, symlinkRemediationHint } from '@agent-rigger/core/linker';
import { findEntry, findLibEntry, readManifest } from '@agent-rigger/core/manifest';
import {
  resolveOpencodeProjectTargets,
  resolveOpencodeUserTargets,
} from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import { constantScanner } from '@agent-rigger/core/scan';
import type { Scanner } from '@agent-rigger/core/scan';
import type { LibMaterialization, Manifest, Scope, Verdict } from '@agent-rigger/core/types';

import {
  type ArtifactEntry,
  type CatalogEntry,
  localId,
  mergeCatalogs,
  qualifyEntries,
  qualifyRef,
  readCatalogDir,
  resolveVersion,
  type SecretDecl,
  type TmpDirFactory,
  withRemoteCheckout,
} from '@agent-rigger/catalog';
import { collectForeignRequires, resolveWithEdges } from '@agent-rigger/catalog/resolver';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';

import { buildAdapter } from './adapter-dispatch';
import { CLI_COMMAND } from './cli';
import type { InstallResult } from './cmd-install';
import { runInstall, targetsAssistant } from './cmd-install';
import { scanPathFor } from './scan-paths';
import { materializeUnion } from './scan-staging';
import { resolveSecretOverrides } from './secret-collect';

// ---------------------------------------------------------------------------
// ScanBlockedError
// ---------------------------------------------------------------------------

/**
 * Thrown by scanEntries (and therefore runRemoteInstall / runUpdate)
 * when the composite scanner rejects one or more scanned paths and --force
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
// ForeignRequireUnsatisfiedError — R3/D3 (lot 6)
// ---------------------------------------------------------------------------

/**
 * Thrown by `partitionForeignRequires` (the R3 pre-pass, D3) when a
 * cross-catalogue `requires` ref, reachable from the current selection, is
 * NOT already installed for this scope/assistant.
 *
 * Actionable: names the ref, the full requirer chain, and the exact command
 * to run first. Thrown BEFORE `resolve()` ever runs — no partial checkout
 * state, nothing scanned, nothing written (fail-closed of the whole group,
 * same guarantee as any other pre-resolution error).
 */
export class ForeignRequireUnsatisfiedError extends Error {
  /** The qualified foreign ref that is not installed. */
  readonly ref: string;
  /** Qualified DFS chain — the last element is the direct requirer. */
  readonly chain: string[];

  constructor(ref: string, chain: string[]) {
    const requirer = chain.at(-1) ?? ref;
    const chainText = [...chain, ref].join(' -> ');
    super(
      `${requirer} requires "${ref}", which is not installed for this scope/assistant `
        + `(chain: ${chainText}). Install it first: ${CLI_COMMAND} install ${ref}`,
    );
    this.name = 'ForeignRequireUnsatisfiedError';
    this.ref = ref;
    this.chain = chain;
  }
}

// ---------------------------------------------------------------------------
// partitionForeignRequires — R3 pre-pass (D3)
// ---------------------------------------------------------------------------

/**
 * Partition every cross-catalogue require reachable from `rawIds` (raw,
 * unqualified ids — the same space as `rawEffective`) by manifest presence,
 * BEFORE `resolve()` ever runs.
 *
 *  - Present in the manifest for (scope, assistant) → added to the returned
 *    Set so `resolve()` skips it (`externallySatisfied`) instead of throwing
 *    `UnknownEntryError` on a ref it can never find in a single-catalogue index.
 *  - Absent → throws `ForeignRequireUnsatisfiedError` immediately — fail-closed,
 *    group-wide (nothing has been resolved, scanned, or written yet).
 *
 * No-op (returns an empty Set) when `sourceName` is `undefined`: without a
 * catalogue name nothing can be qualified, so the cross-catalogue distinction
 * doesn't exist (back-compat with callers that never qualify).
 */
export function partitionForeignRequires(
  rawIds: string[],
  rawEffective: CatalogEntry[],
  sourceName: string | undefined,
  manifest: Manifest,
  scope: Scope,
  assistant: Assistant,
): Set<string> {
  const externallySatisfied = new Set<string>();
  if (sourceName === undefined) {
    return externallySatisfied;
  }

  const foreign = collectForeignRequires(rawIds, rawEffective, sourceName);
  for (const fr of foreign) {
    if (isForeignRequireSatisfied(fr.ref, manifest, scope, assistant)) {
      externallySatisfied.add(fr.ref);
      continue;
    }
    const chain = fr.requiredBy.map((id) => qualifyRef(sourceName, id));
    throw new ForeignRequireUnsatisfiedError(fr.ref, chain);
  }

  return externallySatisfied;
}

/**
 * True when a cross-catalogue `requires` ref is already installed for this
 * transaction.
 *
 * A NON-lib ref is satisfied by an exact `(ref, scope, assistant)` manifest
 * entry (R3/D3 — a skill installed for the other assistant or scope does NOT
 * satisfy it).
 *
 * A LIB ref is the exception (S2, lib-nature): a lib is a global singleton
 * recorded `(ref, 'user', 'shared')`, NEVER under a consumer's `(scope,
 * assistant)`. Looking it up with the run's assistant therefore always missed —
 * a cross-catalogue plugin whose lib dependency WAS installed wrongly failed
 * `ForeignRequireUnsatisfiedError` (adversarial-close F2, prerequisite): the
 * gate could not even be reached. A lib ref is satisfied by its singleton
 * entry, matching where a lib actually lives.
 */
function isForeignRequireSatisfied(
  ref: string,
  manifest: Manifest,
  scope: Scope,
  assistant: Assistant,
): boolean {
  if (localId(ref).startsWith('lib:')) {
    return findLibEntry(manifest, ref)?.nature === 'lib';
  }
  return findEntry(manifest, ref, scope, assistant) !== undefined;
}

// ---------------------------------------------------------------------------
// collectRequiredLibIds — the lib ids the R4 pre-flight must gate on (F2)
// ---------------------------------------------------------------------------

/**
 * Every lib id a resolved selection depends on, for the R4 pre-flight — the
 * union of (a) the libs materialised THIS run and (b) libs ALREADY installed
 * that a pre-prune `requires` edge names (adversarial-close F2).
 *
 * (b) is the fix: a cross-catalogue lib satisfied by the manifest is pruned out
 * of this run's `libs` (never re-materialised), yet a plugin that requires it
 * still needs a real symlink. Without it, `findSymlinkDependentPlugin` saw an
 * empty lib set for exactly that plugin and the gate stayed silent, shipping a
 * copy whose lib import breaks at runtime. A lib is the global singleton
 * `(ref, 'user', 'shared')` (S2), so that is where the lookup reads.
 *
 * Shared by both orchestrators (runRemoteInstall, runUpdate) so the gate's lib
 * set is computed one way — no drift between install and update.
 */
export function collectRequiredLibIds(
  inRunLibIds: Iterable<string>,
  requiresById: Map<string, string[]>,
  manifest: Manifest,
): Set<string> {
  const libIds = new Set<string>(inRunLibIds);
  for (const refs of requiresById.values()) {
    for (const ref of refs) {
      if (libIds.has(ref) || !localId(ref).startsWith('lib:')) continue;
      if (findLibEntry(manifest, ref)?.nature === 'lib') {
        libIds.add(ref);
      }
    }
  }
  return libIds;
}

/**
 * Remove any `requires[]` entry that is in `externallySatisfied` from every
 * catalog entry. Applied to the QUALIFIED effective catalog handed to
 * `runInstall`, whose own internal `resolve()` call has no knowledge of the
 * Set threaded through the FIRST `resolve()` call above — pruning the ref out
 * of the graph entirely keeps the second pass from re-discovering (and
 * throwing on) the exact same already-satisfied foreign require.
 */
function pruneSatisfiedRequires(
  entries: CatalogEntry[],
  externallySatisfied: Set<string>,
): CatalogEntry[] {
  if (externallySatisfied.size === 0) return entries;
  return entries.map((entry) => {
    if (entry.requires === undefined) return entry;
    const pruned = entry.requires.filter((r) => !externallySatisfied.has(r));
    return pruned.length === entry.requires.length ? entry : { ...entry, requires: pruned };
  });
}

// ---------------------------------------------------------------------------
// SymlinkUnavailableError — R4/D4 (lib-nature pre-flight)
// ---------------------------------------------------------------------------

/**
 * Thrown by the R4 pre-flight (below) when the host cannot create symlinks
 * AND the resolved selection contains an opencode plugin whose `requires`
 * include a lib. Refused BEFORE any write (store, lib, manifest) — the
 * targeted vector is opencode/plugins.ts's `linkOrCopy` call: its silent
 * copy-fallback would pose the plugin file as a byte copy, whose relative
 * import (`../libs/<name>/...`) resolves against the copy's own directory
 * instead of the store — a "Cannot find module" broken import discovered
 * only when the user runs it, the exact silent failure the stock forbids.
 *
 * Scoped to the one proven vector (design.md § Surfaces de cycle de vie — R4
 * "portée honnête"): a plugin nature entry posed by copy, depending on a lib.
 * Any other copy-installed nature that later grows a lib dependency is
 * BACKLOG, not this gate.
 */
export class SymlinkUnavailableError extends Error {
  /** The qualified opencode plugin id that cannot be safely copy-installed. */
  readonly pluginId: string;
  /** The qualified lib id the plugin requires. */
  readonly libId: string;

  constructor(pluginId: string, libId: string) {
    super(
      `Cannot install "${pluginId}": this system does not support symlinks, but it requires `
        + `"${libId}" (a shared lib) — a plain copy would leave its import unresolved at `
        + `runtime ("Cannot find module"). ${symlinkRemediationHint()}`,
    );
    this.name = 'SymlinkUnavailableError';
    this.pluginId = pluginId;
    this.libId = libId;
  }
}

/**
 * First opencode plugin in `resolved` whose (qualified, pre-prune) requires
 * include a lib id — the ONE vector R4 targets. Same `targetsAssistant`
 * predicate step 1b uses, applied here to the raw (not-yet-partitioned)
 * selection so a mixed-target pack's sibling opencode member is only flagged
 * when THIS run's assistant is actually 'opencode' (callers gate on that
 * separately — a claude-targeted run never reaches this vector even for a
 * dual-target plugin, since the claude plugin nature delegates to the native
 * CLI, never `linkOrCopy`).
 *
 * Returns the (plugin id, lib id) pair for the error message; undefined when
 * no such plugin is in the selection.
 */
function findSymlinkDependentPlugin(
  resolved: ArtifactEntry[],
  requiresById: Map<string, string[]>,
  libIds: Set<string>,
  assistant: Assistant,
): { pluginId: string; libId: string } | undefined {
  for (const entry of resolved) {
    if (entry.nature !== 'plugin' || !targetsAssistant(entry, assistant)) continue;
    const libRef = (requiresById.get(entry.id) ?? []).find((r) => libIds.has(r));
    if (libRef !== undefined) {
      return { pluginId: entry.id, libId: libRef };
    }
  }
  return undefined;
}

/**
 * R4 pre-flight (D4): refuse BEFORE any write when the host cannot create
 * symlinks and `resolved` contains an opencode plugin whose requires include
 * a lib. Shared by `runRemoteInstall` (fresh installs) AND `runUpdate`
 * (cmd-update.ts) — a stale opencode plugin re-posed by an update goes
 * through the exact SAME `linkOrCopy` call as a fresh install
 * (opencode/plugins.ts's `applySkill`): if the catalogue bump being applied
 * ADDS a lib requirement to an already-copy-installed plugin, the update
 * must refuse for the same reason a fresh install would — and it must do so
 * BEFORE `remove()` deletes the old copy, or the update would destroy the
 * artifact with nothing safely re-posed in its place (a "success" that
 * silently breaks the install, exactly what R4 exists to prevent). No-op
 * (never even probes) when `assistant !== 'opencode'` — the claude plugin
 * nature delegates to the native CLI, never `linkOrCopy`.
 *
 * The probe itself runs on the SAME filesystem the REAL symlink target of THIS
 * scope will use — the parent of the scope's opencode pluginDir (project:
 * `<cwd>/.opencode`, user: `~/.config/opencode`), NOT the rigger home (F1,
 * adversarial-close): the project pluginDir can sit on a different mount than
 * HOME (WSL: an ext4 HOME vs a /mnt/c project), and a host that symlinks under
 * HOME but not under the project mount must still be refused. When that parent
 * does not exist yet (a fresh project, before `.opencode/` is created) the probe
 * walks up to the nearest EXISTING ancestor rather than stepping onto a
 * different filesystem via os.tmpdir() (the T4 §fallback-tmpdir lesson).
 *
 * @param resolved      Qualified resolved selection.
 * @param requiresById  Qualified, pre-prune requires per qualified entry id.
 * @param libIds        Qualified ids of every lib the selection may require
 *                      (in-run + already-installed cross-catalogue — F2).
 * @param assistant     This run's target assistant.
 * @param scope         This run's install scope — selects the real pluginDir.
 * @param env           Injectable env — resolves the user-scope pluginDir.
 * @param cwd           Working directory — resolves the project-scope pluginDir.
 * @param symlink       Injectable symlink implementation forwarded to the probe (tests).
 */
export async function assertSymlinkCapable(
  resolved: ArtifactEntry[],
  requiresById: Map<string, string[]>,
  libIds: Set<string>,
  assistant: Assistant,
  scope: Scope,
  env: Env,
  cwd: string = process.cwd(),
  symlink?: LinkOptions['symlink'],
): Promise<void> {
  if (assistant !== 'opencode') return;

  const dependent = findSymlinkDependentPlugin(resolved, requiresById, libIds, assistant);
  if (dependent === undefined) return;

  const pluginDir = scope === 'project'
    ? resolveOpencodeProjectTargets(cwd).pluginDir
    : resolveOpencodeUserTargets(env).pluginDir;
  const scratchParentDir = await nearestExistingDir(path.dirname(pluginDir));

  const supported = await probeSymlinkSupport({
    scratchParentDir,
    ...(symlink === undefined ? {} : { symlink }),
  });
  if (!supported) {
    throw new SymlinkUnavailableError(dependent.pluginId, dependent.libId);
  }
}

/**
 * Nearest existing directory at or above `start` — walks parents until one
 * exists (the filesystem root always does, so this terminates). Recursion, not
 * a while loop (design invariant). Used to keep the symlink probe on the target
 * filesystem when the scope's `.opencode/` parent has not been created yet.
 */
async function nearestExistingDir(start: string): Promise<string> {
  const exists = await lstat(start).then(() => true).catch(() => false);
  if (exists) return start;
  const parent = path.dirname(start);
  if (parent === start) return start;
  return nearestExistingDir(parent);
}

// ---------------------------------------------------------------------------
// buildLibMaterializations — lib descriptors for the engine's parallel channel
// ---------------------------------------------------------------------------

/**
 * Build a `LibMaterialization` for every lib in a resolved selection, so the
 * engine's parallel channel (R3, `apply({ libs })`) can pose it — CLI-side,
 * because the checkout `source` is a layout the core must never derive (D2,
 * design.md §1 "split checkout/store").
 *
 * The `source` is `scanPathFor(entry, baseDir)[0]` — the SAME path the scan gate
 * (materializeUnion) mirrored into the scanned union. This is the R2 invariant:
 * the octet materialised IS the octet scanned. `applySkill` carries the only
 * apply-time re-check and never sees a lib, so `scanEntries` is the unique
 * barrier on these bytes — a source drifting from the scanned path would run
 * unscanned bytes by import. The pin test (t4 model) freezes this equality.
 *
 * `requires` is copied verbatim from the pre-prune, qualified edge map (S4) —
 * opaque transport; a real lib depends on nothing, so it is `[]`.
 *
 * Shared by runRemoteInstall and runUpdate (single source of the source
 * computation — DRY, and the pin has one thing to freeze).
 */
export function buildLibMaterializations(
  resolved: ArtifactEntry[],
  baseDir: string,
  requiresById: Map<string, string[]>,
): LibMaterialization[] {
  return resolved
    .filter((e) => e.nature === 'lib')
    .map((e) => {
      const name = localId(e.id).replace(/^lib:/, '');
      const paths = scanPathFor(e, baseDir);
      const source = paths[0];
      if (source === undefined) {
        // Unreachable: scanPathFor('lib') always returns exactly one path
        // (scan-paths.ts). Guarded so a future layout regression fails loud
        // instead of materialising from `undefined`.
        throw new Error(`lib ${e.id} has no checkout path (scanPathFor returned empty)`);
      }
      return { id: e.id, name, source, requires: requiresById.get(e.id) ?? [] };
    });
}

// ---------------------------------------------------------------------------
// scanEntries — reusable scan gate
// ---------------------------------------------------------------------------

/**
 * Scan the union of the selection plus catalog.json as ONE composite call, and
 * return both the human warnings and the single union verdict (design.md § Le
 * seam de scan).
 *
 * `materializeUnion` builds a staging root mirroring the checkout layout —
 * catalog.json (unconditional: inline `mcp` config with secrets in config.env,
 * `check`/`install` strings for every nature, ADR-0014/0015 §3) plus every
 * selected entry's checkout path (skills/agents/guardrails/contexts/hooks/
 * opencode plugins; mcp/tool/claude-only-plugin contribute nothing beyond
 * catalog.json). The scanner runs once over that root, so the whole selection
 * costs ~2 tool spawns, not ~2 per artefact (R1) — and because the mirror
 * reproduces the checkout layout, gitleaks/trivy findings already carry the
 * checkout-relative path (R7), attributed per artefact with no rewrite here.
 *
 * The verdict drives the SAME force/degraded/blocked policy as before (order
 * anyBlocked before anyDegraded — R5 scénario 3):
 * - degraded (no scanner tool installed) → actionable warning + proceeds; force
 *   is NOT needed (ADR-0018).
 * - !ok (real findings, scanner present) and force is false → throws ScanBlockedError.
 * - !ok and force is true → returns { warnings: [...], verdict }.
 * - all ok, not degraded, and verdict.missingTools names exactly one absent tool
 *   (partial presence, T2) → actionable warning naming the absent tool, install
 *   proceeds. Checked AFTER anyBlocked/anyDegraded, so a blocking or degraded
 *   verdict never also emits this warning (blocking prime partiel).
 * - all ok and not degraded and no partial presence → returns { warnings: [], verdict }.
 *
 * Callers prepend the warnings to their output, and thread `constantScanner(verdict)`
 * to the adapter's apply-time re-check under !force (design.md § Le seam de couplage).
 *
 * Libs (engine-materialized, never applied by an adapter) have NO apply-time
 * re-check at all: this gate is the only barrier over their bytes. That is
 * sound because the union covers `scanPathFor('lib')` and the materializer's
 * source is pinned to that exact path (path_match test, ADR-0030) — the
 * materialized byte is the scanned byte.
 *
 * The staging mirror is torn down in a `finally` — it never survives the call,
 * scan success or failure. A scan always runs (catalog.json is always mirrored),
 * so a selection with no scannable natures (guardrail-only, mcp-only) still
 * surfaces the degraded warning instead of silently skipping the check.
 *
 * @param opts.entries  ArtifactEntry list to scan (entries without a checkout path
 *                      contribute nothing beyond the unconditional catalog.json scan).
 * @param opts.baseDir  Root of the remote checkout directory.
 * @param opts.scanner  Raw scanner instance (composite or a test fake) — NOT
 *                      memoized: the union is scanned once, and the apply-time
 *                      re-check is served a constant verdict, not a cache hit.
 * @param opts.force    When true, a blocking scan (real findings) warns instead of throwing.
 */
export async function scanEntries(opts: {
  entries: ArtifactEntry[];
  baseDir: string;
  scanner: Scanner;
  force: boolean;
}): Promise<{ warnings: string[]; verdict: Verdict }> {
  const { entries, baseDir, scanner, force } = opts;

  // Materialise the exact union (catalog.json + every selected surface) into one
  // staging root mirroring the checkout layout, scan it in a SINGLE composite
  // call (~2 tool spawns for the whole selection, not ~2×artefact — R1), then
  // tear the mirror down. cleanup runs in finally: the staging never survives,
  // scan success or failure. The lone verdict drives everything below.
  const { stagingDir, cleanup } = await materializeUnion({ entries, baseDir });
  let verdict: Verdict;
  try {
    verdict = await scanner.scan(stagingDir);
  } finally {
    await cleanup();
  }

  // Real findings from a present scanner (ok: false).
  const allFindings = verdict.findings ?? [];
  const anyBlocked = !verdict.ok;

  // Degraded mode: scanner returned ok: true but no tool is installed (ADR-0018).
  const anyDegraded = verdict.degraded === true;

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
      verdict,
    };
  }

  if (anyDegraded) {
    return {
      warnings: [
        '[warning] content not scanned — install gitleaks or trivy then re-run for a full scan; see `rigger doctor`',
      ],
      verdict,
    };
  }

  // Partial presence (ADR-0018 additive signal, T1/T2): all-ok, but exactly
  // one of gitleaks/trivy is installed (composite.ts). Only reached once
  // anyBlocked/anyDegraded above have both fallen through — blocking always
  // wins over a partial warning (fail-closed prime partiel), so a present
  // tool's finding never reaches this branch. `noUncheckedIndexedAccess`
  // means an index read stays `T | undefined` even after the length check,
  // hence the guarded destructure below rather than `missingTools[0]` inline.
  const missingTool = verdict.missingTools?.length === 1 ? verdict.missingTools[0] : undefined;
  if (missingTool !== undefined) {
    const presentTool = missingTool === 'gitleaks' ? 'trivy' : 'gitleaks';
    return {
      warnings: [
        `[warning] content partially scanned — ${missingTool} not installed (${presentTool} ran); `
        + `install ${missingTool} then re-run for a full scan; see \`rigger doctor\``,
      ],
      verdict,
    };
  }

  return { warnings: [], verdict };
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
 *      readCatalogDir(dir) → frontier guard → scanEntries (catalog.json + every scannable entry) →
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
  /**
   * ref→VAR overrides collected from --secret-env, already parsed by the
   * caller BEFORE this checkout begins (secret-collect.ts's
   * parseSecretEnvFlags). A ref declared by an mcp entry actually being
   * installed but absent here still gets resolved below — via a TTY prompt
   * or the non-TTY ladder (decideSecretOverride) — before the adapter is
   * built, so this map is a lower bound, not the final one.
   */
  secretOverrides?: Record<string, string>;
  /**
   * Whether the current process is an interactive TTY (R5: flag > TTY prompt
   * > non-TTY actionable error/default). Defaults to `process.stdout.isTTY
   * === true`; override in tests for a deterministic branch.
   */
  isTTY?: boolean;
  /**
   * Injectable picker for a declared secret with no --secret-env override,
   * invoked only in a TTY. Defaults to secret-collect.ts's clack prompt.
   */
  secretPicker?: (secret: SecretDecl) => Promise<string>;
  /**
   * Compact output mode (plan-compact-summary). Forwarded verbatim to runInstall
   * — the only place the plan/result rendering happens. This is the sole seam
   * that reaches the real install path, since every `install` route (grouped
   * ids, interactive picker, ad-hoc) funnels through runRemoteInstall.
   */
  summary?: boolean;
  /**
   * Injectable symlink implementation forwarded to the R4 pre-flight probe
   * (probeSymlinkSupport, core/linker.ts) — tests force a rejection to
   * simulate a host without symlink support. Defaults to the real
   * `fs.symlink` (same default `linkOrCopy` uses). This seam only decides
   * whether the pre-flight throws; it never reaches the real per-artefact
   * install writes, which go through the adapter's own untouched
   * `linkOrCopy` call.
   */
  symlink?: LinkOptions['symlink'];
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
  // Raw scanner (NOT memoized): the pre-apply gate scans the whole selection as
  // a single union (scanEntries below), and the adapter's apply-time re-check is
  // handed a constant verdict — no per-path cache is threaded through either
  // seam anymore. The union verdict returned by scanEntries feeds constantScanner.
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
    // R1 (lot 6, D1): the checkout's HEAD must match the sha ls-remote just
    // resolved — fail-closed (RefShaMismatchError) before anything is read
    // or written when a homonymous branch/tag or a TOCTOU re-push landed a
    // different commit than the one the manifest is about to describe.
    { tmpFactory, expectedSha: version.sha },
    async (dir) => {
      const { entries: remoteEntries } = await readCatalogDir(dir);

      // Frontier guard: reject external entries whose derived name would cause
      // a path traversal before any install operation begins.
      // Always use local (unqualified) id for path derivation.
      //
      // Subsumption (catalog-id-traversal): this guard is now defence-in-depth,
      // not the frontier. `isSafeCatalogId` (schema.ts) refines every entry `id`
      // at catalog.json parse time — each ':'-separated segment must be a safe
      // artefact name ([a-zA-Z0-9._-], never "." / ".."). A forged id such as
      // `skill:x/../../../evil` is therefore rejected inside `readCatalogDir`
      // ABOVE, before this loop ever runs, so no traversing id reaches here in
      // practice. The guard is kept — not extended — as a second, local barrier
      // (defence-in-depth); extending it to further natures would be dead code,
      // since the parse-time refinement already covers every id uniformly.
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

      // R3 pre-pass (lot 6, D3): partition every cross-catalogue require
      // reachable from rawIds by manifest presence BEFORE resolve() runs —
      // satisfied ones are pruned via externallySatisfied; an absent one
      // throws ForeignRequireUnsatisfiedError here, fail-closed, before any
      // checkout content is read further, scanned, or written.
      const manifest = await readManifest(manifestPath);
      const externallySatisfied = partitionForeignRequires(
        rawIds,
        rawEffective,
        sourceName,
        manifest,
        scope,
        assistant,
      );

      // Resolve WITH edges (S4/R5): capture each entry's resolved requires (own
      // + pack-inherited) from the RAW resolution — i.e. PRE-prune. rawEffective
      // still carries every requires ref (pruneSatisfiedRequires only touches
      // `effective` below, which feeds runInstall's second resolve), so a
      // cross-catalogue require already satisfied stays on its requirer's edges
      // even though externallySatisfied skipped emitting the ref itself.
      const rawResolvedWithEdges = resolveWithEdges(rawIds, rawEffective, externallySatisfied);
      const rawResolved = rawResolvedWithEdges.map((r) => r.entry);

      // When a sourceName is provided, qualify all resolved entries so that the
      // manifest stores fully-qualified ids (e.g. 'principal/guardrail:main').
      // The adapter and version lookup still key by qualified id.
      const qualify = (id: string): string =>
        sourceName === undefined ? id : qualifyRef(sourceName, id);

      const resolved: ArtifactEntry[] = sourceName === undefined
        ? rawResolved
        : rawResolved.map((e) => ({ ...e, id: qualify(e.id) }));

      // Qualify the captured edges with the SAME map that qualifies ids
      // (qualifyRef is idempotent: intra-catalogue refs gain the prefix,
      // cross-catalogue refs stay intact — R5 format `<catalog>/<nature>:<name>`).
      // Keyed by qualified entry id so runInstall matches its AdapterEntry ids;
      // this pre-prune map is the source of truth threaded via `requiresById`.
      const requiresById = new Map<string, string[]>(
        rawResolvedWithEdges.map((r) => [qualify(r.entry.id), r.requires.map(qualify)]),
      );

      // Lib materialisations (R3): descriptors for the engine's parallel
      // channel, built CLI-side so `source` = scanPathFor('lib')[0] (the pinned
      // scanned path — R2). Partitioned OUT of the adapter loop by runInstall
      // (S3: a lib never reaches step 1b, no `[skipped]` line) and threaded to
      // apply({ libs }). Empty on a lib-free selection.
      const libs = buildLibMaterializations(resolved, dir, requiresById);

      // Qualify the effective catalog using qualifyEntries so that pack members,
      // requires, and ids are ALL qualified (not just the top-level id field).
      // This prevents UnknownEntryError when resolve() tries to look up pack members.
      // pruneSatisfiedRequires (R3/D3) then strips any already-satisfied foreign
      // require from entries.requires[] — runInstall calls resolve() a SECOND
      // time (selectedIds, catalog) with no knowledge of externallySatisfied, so
      // the ref must be gone from the graph, not merely skippable.
      const effective = pruneSatisfiedRequires(
        sourceName === undefined ? rawEffective : qualifyEntries(sourceName, rawEffective),
        externallySatisfied,
      );

      // All entries from the remote catalog are sourced from the checkout.
      // - Skills / agents / guardrails / contexts / hooks / opencode plugins:
      //   have a checkout path (scanPathFor != null).
      // - mcp: no checkout path of its own — covered via the unconditional
      //   catalog.json scan in scanEntries (inline config, not a checkout).
      // - Claude plugins: from the remote catalog's marketplace URL.
      // remoteIds tells buildClaudeAdapter which entries to resolve from externalBaseDir.
      // Use qualified ids here to match the (potentially qualified) resolved entries.
      //
      // Filtered by targetsAssistant (opencode-pack-target-filter): `resolved`
      // is the RAW pack expansion, ahead of the target-routing step 1b applies
      // later inside runInstall. A pack legitimately carries one guardrail per
      // target (e.g. one for claude, one for opencode); without this filter, the
      // adapter about to be built for ONE assistant would see the OTHER
      // assistant's sibling member too — wrongly tripping opencode's
      // mono-guardrail policy (ADR-0021) on a mixed-target pack, or letting the
      // claude builder's `.find()` silently resolve the wrong guardrail. Same
      // predicate as step 1b, so both filters can never drift apart.
      const qualifiedRemoteEntryIds = new Set(remoteEntries.map((e) => qualify(e.id)));
      const remoteIds = new Set(
        resolved
          .filter((e) => qualifiedRemoteEntryIds.has(e.id) && targetsAssistant(e, assistant))
          .map((e) => e.id),
      );

      // Security scan — the union of the selection plus catalog.json, scanned as
      // ONE composite call over a staging mirror (uniform scan, ADR-0014; R2
      // surfaces). scanPathFor (inside materializeUnion) uses localId() to strip
      // the qualifier before path derivation. The union verdict is threaded to
      // the apply-time re-check below via constantScanner.
      const { warnings, verdict } = await scanEntries({
        entries: resolved,
        baseDir: dir,
        scanner,
        force,
      });

      // R4 pre-flight (D4): refuse BEFORE any write when the host cannot
      // create symlinks and the resolved selection contains an opencode
      // plugin requiring a lib (opencode/plugins.ts poses a plugin via
      // linkOrCopy, whose silent copy-fallback would break the plugin's
      // relative import at runtime — SymlinkUnavailableError above). Probed
      // ONCE per run, AFTER the scan gate (the security verdict primes) and
      // BEFORE buildAdapter/apply: nothing durable has been written yet at
      // this point — scanEntries only mirrors the union into a staging dir
      // torn down in its own `finally`. Never gated behind --force: this is
      // a structural runtime-correctness refusal, not a scan policy. Shared
      // with runUpdate (cmd-update.ts) — see assertSymlinkCapable's docblock.
      const libIds = collectRequiredLibIds(libs.map((l) => l.id), requiresById, manifest);
      await assertSymlinkCapable(
        resolved,
        requiresById,
        libIds,
        assistant,
        scope,
        env,
        process.cwd(),
        opts.symlink,
      );

      // Build effectiveEntries map for hookSpec resolution (qualified ids).
      const effectiveEntries = new Map(effective.map((e) => [e.id, e]));

      // R5 (lot 6, D5 gap-fix): resolve the ref→VAR mapping for every secret
      // declared by an mcp entry actually being installed. A --secret-env
      // override always wins; otherwise, in a TTY, the mandated interactive
      // prompt runs HERE (secrets are only known once the catalog is
      // resolved, hence after checkout, not before it) — resolveSecretOverrides
      // was previously built and unit-tested but never called from an install
      // path, so a TTY install with an unresolved required secret hard-failed
      // instead of asking. Non-TTY behaviour is unchanged: renderMcpConfig
      // (mcp-source.ts) still fails closed on an unresolved `required` secret
      // right below, with the same actionable error.
      const declaredSecrets = resolved
        .filter((e) => e.nature === 'mcp')
        .flatMap((e) => e.secrets ?? []);
      const secretOverrides = declaredSecrets.length === 0
        ? opts.secretOverrides
        : await resolveSecretOverrides({
          secrets: declaredSecrets,
          overrides: opts.secretOverrides ?? {},
          isTTY: opts.isTTY ?? process.stdout.isTTY === true,
          ...(opts.secretPicker === undefined ? {} : { picker: opts.secretPicker }),
        });

      // Thread the union verdict to the adapter's apply-time re-check only on the
      // non-force path, via constantScanner. When !force, scanEntries above has
      // ALREADY thrown ScanBlockedError on any blocking verdict — so by the time
      // we reach here the union verdict is ok (or degraded), and every apply-time
      // re-check replays that same ok verdict (the union is a superset of every
      // applied source — structural via scanPathFor's assertNever, ADR-0022 §4),
      // at zero extra tool spawns. When force=true, a blocking verdict was
      // deliberately overridden by the operator at the gate; Scanner/applySkill
      // have no notion of --force, so re-running the SAME verdict at apply time
      // would re-block a run the operator explicitly forced through (D5/ADR-0018:
      // --force policy is unchanged, not narrowed to "gate only").
      //
      // R8 (tautology, by design): threading constantScanner here is defence BY
      // CONSTRUCTION, not a runtime re-scan. The verdict is exactly what the gate
      // already computed over a superset of every applied source (structural via
      // scanPathFor's assertNever), so the apply-time re-check can only agree with
      // the gate — it can never independently catch something the union missed.
      // The apply-time BLOCKING path is nonetheless real (applySkill throws on a
      // !ok verdict) and stays pinned by t4's scanner injection at the adapter
      // boundary, where a genuinely blocking scanner is fed in directly.
      const adapter = await buildAdapter(assistant, env, {
        externalIds: remoteIds,
        externalBaseDir: dir,
        catalogUrl,
        pluginRunner,
        effectiveEntries,
        // Constant union verdict for the apply-time re-check under !force only:
        // under --force the gate warns-and-proceeds, so replaying a blocking
        // verdict would wrongly re-throw at apply. Defense-in-depth, redundant
        // while applied skills stay a subset of the gate's scanned union.
        ...(force ? {} : { scanner: constantScanner(verdict) }),
        // R5 (lot 6, D5): threaded through to the builder — mcpSource resolves
        // secretRefs (override, TTY-prompted, or ref default — see above),
        // checks env presence, and fails closed on an unresolved `required`
        // secret (render step, mcpSource).
        ...(secretOverrides === undefined || Object.keys(secretOverrides).length === 0
          ? {}
          : { secretOverrides }),
      });

      // A lib is remote content (its bytes come from THIS checkout) but it is
      // excluded from remoteIds (targets: [], S3) so it never routes to an
      // adapter. It must still be stamped with the REAL catalogue ref/sha: a
      // v0.0.0/'' lib entry is a permanent, inextinguishable doctor missing-sha
      // finding (update re-stamps '') and makes "the audit verifies its bytes"
      // structurally impossible, asymmetric with the consumers from the same
      // checkout. Union the lib ids into the version-eligible set WITHOUT
      // touching remoteIds (externalIds/adapter stay intact); a real ref/sha
      // never makes a lib a direct-update candidate — its 'shared' assistant
      // keeps it non-candidate.
      const remoteVersionIds = new Set([...remoteIds, ...libs.map((l) => l.id)]);
      const versionFor = (
        entry: { id: string },
      ): { ref: string; sha: string } => {
        if (remoteVersionIds.has(entry.id)) {
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
        summary: opts.summary === true,
        // Pre-prune, qualified edges (S4/R5): override runInstall's own
        // (post-prune, `effective`-based) resolution so a satisfied
        // cross-catalogue require persists on its requirer even though it was
        // pruned from the install graph.
        requiresById,
        // Lib materialisations (R3): posed by the engine's parallel channel,
        // never by the adapter. runInstall partitions them out of step 1b.
        libs,
      });

      if (warnings.length === 0) {
        return result;
      }

      return { ...result, output: `${warnings.join('\n')}\n${result.output}` };
    },
  );
}
