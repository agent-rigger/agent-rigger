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
 *   buildAdapter(assistant, env, {externalIds, externalBaseDir, catalogUrl, pluginRunner}) →
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

import type { PluginRunner } from '@agent-rigger/adapters';
import type { Assistant } from '@agent-rigger/core';
import { createCompositeScanner } from '@agent-rigger/core';
import { assertSafeArtifactName } from '@agent-rigger/core/artifact-name';
import { findEntry, readManifest } from '@agent-rigger/core/manifest';
import type { Env } from '@agent-rigger/core/paths';
import { constantScanner } from '@agent-rigger/core/scan';
import type { Scanner } from '@agent-rigger/core/scan';
import type { Manifest, Scope, Verdict } from '@agent-rigger/core/types';

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
import { collectForeignRequires, resolve } from '@agent-rigger/catalog/resolver';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';

import { buildAdapter } from './adapter-dispatch';
import type { InstallResult } from './cmd-install';
import { runInstall } from './cmd-install';
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
        + `(chain: ${chainText}). Install it first: agent-rigger install ${ref}`,
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
    if (findEntry(manifest, fr.ref, scope, assistant) !== undefined) {
      externallySatisfied.add(fr.ref);
      continue;
    }
    const chain = fr.requiredBy.map((id) => qualifyRef(sourceName, id));
    throw new ForeignRequireUnsatisfiedError(fr.ref, chain);
  }

  return externallySatisfied;
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
 * - all ok and not degraded → returns { warnings: [], verdict }.
 *
 * Callers prepend the warnings to their output, and thread `constantScanner(verdict)`
 * to the adapter's apply-time re-check under !force (design.md § Le seam de couplage).
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

      const rawResolved = resolve(rawIds, rawEffective, externallySatisfied);

      // When a sourceName is provided, qualify all resolved entries so that the
      // manifest stores fully-qualified ids (e.g. 'principal/guardrail:main').
      // The adapter and version lookup still key by qualified id.
      const qualify = (id: string): string =>
        sourceName === undefined ? id : qualifyRef(sourceName, id);

      const resolved: ArtifactEntry[] = sourceName === undefined
        ? rawResolved
        : rawResolved.map((e) => ({ ...e, id: qualify(e.id) }));

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
      const qualifiedRemoteEntryIds = new Set(remoteEntries.map((e) => qualify(e.id)));
      const remoteIds = new Set(
        resolved
          .filter((e) => qualifiedRemoteEntryIds.has(e.id))
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
        summary: opts.summary === true,
      });

      if (warnings.length === 0) {
        return result;
      }

      return { ...result, output: `${warnings.join('\n')}\n${result.output}` };
    },
  );
}
