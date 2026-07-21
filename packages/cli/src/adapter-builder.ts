/**
 * adapter-builder.ts — shared factory for ClaudeAdapter instances.
 *
 * Extracted from cli.ts so that both the CLI entry point and the remote-install
 * orchestrator share a single, consistent adapter construction path.
 *
 * Responsibilities:
 * - Load denyRef + agentsContent from externalBaseDir (checkout) when provided.
 * - Build all source/spec closures: skillSource, agentSource, pluginSource, hookSpec.
 * - Accept an optional manifest to build a getApplied resolver for reversible
 *   remove/check (B-iii): adapter reads canonical payload from the manifest instead
 *   of from local artifact files.
 * - Accept an optional pluginRunner so callers can inject a CommandRunner-based
 *   runner (remote-install.ts) without coupling to the default PluginRunner.
 *
 * Constraints:
 * - No circular imports: does not import from cli.ts or remote-install.ts.
 * - exactOptionalPropertyTypes: never assigns undefined to optional fields.
 * - No BUILTIN_CATALOG dependency: all hook resolution must come from effectiveEntries.
 */

import path from 'node:path';

import {
  auditPlugin,
  createClaudeAdapter,
  loadCanonicalAllow,
  loadCanonicalDeny,
  planPlugin,
  pluginLedgerKey,
  pluginName,
  readInstalledPlugins,
} from '@agent-rigger/adapters';
import type { PluginRunner, PluginSource, ResolvedHook } from '@agent-rigger/adapters';
import type { Adapter, AdapterEntry } from '@agent-rigger/core/adapter';
import { assertSafeArtifactName } from '@agent-rigger/core/artifact-name';
import { readText } from '@agent-rigger/core/fs-json';
import type { Env } from '@agent-rigger/core/paths';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Scanner } from '@agent-rigger/core/scan';
import { stubScanner } from '@agent-rigger/core/scan';

import {
  type CatalogEntry,
  CHECKOUT_CLAUDE,
  CHECKOUT_COMMON,
  localId,
} from '@agent-rigger/catalog';

import { renderMcpConfig } from './mcp-source';

// ---------------------------------------------------------------------------
// hookScriptStorePath
// ---------------------------------------------------------------------------

/**
 * Path of the shared hook scriptStore: `<dirname(stateJson)>/hooks`.
 *
 * Derivable from the env alone, never persisted (design D6,
 * lot2-remove-reversible): the store location is deterministic so the
 * manifest does not carry it. Single derivation seam shared by hookSpec
 * (script deposit at install time) and the remove path (R7: the directory is
 * deleted with the last hook-nature manifest entry).
 */
export function hookScriptStorePath(env: Env): string {
  return path.join(path.dirname(resolveUserTargets(env).stateJson), 'hooks');
}

// ---------------------------------------------------------------------------
// readMarketplaceName
// ---------------------------------------------------------------------------

/**
 * Read the `name` field of a Claude Code marketplace.json (obs1 R3).
 *
 * The name is the second half of the on-disk plugin ledger key
 * `<plugin>@<marketplaceName>` — the value Claude Code records when it registers
 * a marketplace. Returns undefined when the file is absent, unreadable, not an
 * object, or has no non-empty string `name` (the caller falls back). Read-only.
 */
async function readMarketplaceName(marketplaceJsonPath: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readText(marketplaceJsonPath);
  } catch {
    return undefined;
  }
  if (raw === '') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const name = (parsed as Record<string, unknown>)['name'];
  return typeof name === 'string' && name !== '' ? name : undefined;
}

// ---------------------------------------------------------------------------
// resolvePluginLedgerMarketplace (obs1 Low A)
// ---------------------------------------------------------------------------

/**
 * Outcome of confronting a guessed marketplaceName against the real ledger.
 * `marketplaceName` — safe to feed straight into auditPlugin/planPlugin (either
 * the guess was confirmed, corrected to the one real alternate, or the ledger
 * has zero matches / does not parse — all cases the existing plugins.ts state
 * machine already handles correctly on its own).
 * `ambiguous` — more than one ledger entry shares the plugin name under a
 * different marketplace: the detail message for a synthesized 'unknown' report.
 */
type MarketplaceResolution = { marketplaceName: string } | { ambiguous: string };

/**
 * Correct a cwd-guessed plugin marketplaceName against the REAL ledger keys
 * (obs1 Low A).
 *
 * `localMarketplaceName` below is resolved once from
 * `<process.cwd()>/.claude-plugin/marketplace.json`, falling back to
 * 'agent-rigger'. That guess is only correct when the cwd IS the rig's own
 * checkout. From any other cwd — a user project with no marketplace.json, or
 * one that bundles a THIRD-PARTY marketplace — the guess degrades to the
 * 'agent-rigger' fallback, which never matches a plugin actually installed
 * under a different marketplace name: `check` reports a false `missing` and
 * exits 3 on a perfectly healthy install.
 *
 * The fix follows the same principle R2 already applies to parse failures:
 * the ledger itself is the only thing that knows which marketplace a plugin
 * was installed under, so when the guessed key misses, this searches
 * `installed_plugins.json` for any OTHER key whose plugin-name half matches
 * `pluginName(entry)`:
 * - exactly one alternate match  → use it (the guess was simply wrong for
 *   this cwd; the exact-key match downstream reports 'present').
 * - more than one alternate match → ambiguous — NEVER guess which one this
 *   catalog entry means; the caller synthesizes 'unknown' with this detail
 *   (parity with R2: an honest advisory beats a coin-flip).
 * - zero alternate matches, or the ledger doesn't parse ('unknown') → the
 *   guess is passed through unchanged: genuinely missing, or the R2
 *   ledger-unknown path already handles it independent of marketplaceName.
 *
 * The common case — cwd IS the rig's own checkout, guess hits the exact key —
 * returns on the first ledger read below without ever reaching the by-name
 * search: correctness for the cross-cwd case costs one extra (cheap, local)
 * ledger read per plugin audit/plan call, never a spawn (R1 untouched).
 */
async function resolvePluginLedgerMarketplace(
  entry: AdapterEntry,
  env: Env,
  guessedMarketplaceName: string,
): Promise<MarketplaceResolution> {
  const ledger = await readInstalledPlugins(env);
  if (ledger.state !== 'ok') {
    // Unparsable ledger: auditPlugin/planPlugin already derive 'unknown' from
    // this same file, independent of marketplaceName — nothing to resolve.
    return { marketplaceName: guessedMarketplaceName };
  }

  const name = pluginName(entry);
  if (ledger.keys.has(pluginLedgerKey(name, guessedMarketplaceName))) {
    return { marketplaceName: guessedMarketplaceName };
  }

  const alternates = [...ledger.keys].filter((key) => {
    const at = key.indexOf('@');
    return at !== -1 && key.slice(0, at) === name;
  });

  if (alternates.length === 1) {
    const [match] = alternates;
    if (match !== undefined) {
      return { marketplaceName: match.slice(match.indexOf('@') + 1) };
    }
  }
  if (alternates.length > 1) {
    return {
      ambiguous: `plugin "${name}" matches ${alternates.length} ledger entries under `
        + `different marketplaces (${alternates.join(', ')}) — cannot determine which one `
        + 'this catalog entry refers to without guessing (obs1 Low A).',
    };
  }
  // Zero alternates: genuinely missing under any marketplace name.
  return { marketplaceName: guessedMarketplaceName };
}

// ---------------------------------------------------------------------------
// BuildClaudeAdapterOpts
// ---------------------------------------------------------------------------

/**
 * Options for the external-resolver seam in buildClaudeAdapter.
 *
 * @param externalIds      Set of artifact ids (e.g. 'skill:x', 'agent:y') whose
 *                         source should be resolved from externalBaseDir.
 *                         Both fields must be provided together for the seam to activate.
 * @param externalBaseDir  Absolute path to the root of a remote checkout. Expected
 *                         post-cutover layout (R9): common/skills/<name>/,
 *                         common/agents/<name>.md, claude/hooks/<name>.ts,
 *                         claude/guardrails/<n>/deny.json + allow.json,
 *                         claude/contexts/<n>/AGENTS.md.
 * @param catalogUrl       URL of the content repo (used as the marketplace URL for
 *                         external plugin installs). When provided alongside externalIds,
 *                         plugin entries in externalIds use this URL as their marketplace
 *                         instead of the bundled <cwd>/.claude-plugin/marketplace.json.
 * @param pluginRunner     Optional PluginRunner to inject. When omitted, createClaudeAdapter
 *                         uses its default runner (Bun.spawn). Set this in tests or in
 *                         remote-install.ts to avoid invoking the real `claude` binary.
 * @param effectiveEntries Lookup map (id → CatalogEntry) for the resolved effective catalog.
 *                         Used by hookSpec to resolve event/matcher/timeout for any hook entry.
 *                         Required when any hook entry needs to be installed — hookSpec will
 *                         throw an actionable error if the entry is not found in this map.
 * @param scanner          Security scanner invoked at apply time (defense in depth) for each
 *                         skill link write-op. Callers that already ran the pre-apply union
 *                         gate (scanEntries) pass constantScanner(union verdict) so the
 *                         re-check blocks on a bad verdict with zero extra spawns. Omitted →
 *                         falls back to stubScanner (check/remove paths never write content, so a
 *                         stub there is inert).
 * @param secretOverrides  ref→VAR overrides collected by the CLI (--secret-env / TTY prompt,
 *                         R5, lot 6, D5). Consumed by the claude mcpSource render (R8/T7):
 *                         env-refs are kept verbatim (`${VAR}`) and the presence check
 *                         fails closed on a missing `required` secret before any write.
 */
export interface BuildClaudeAdapterOpts {
  externalIds?: Set<string>;
  externalBaseDir?: string;
  catalogUrl?: string;
  pluginRunner?: PluginRunner;
  effectiveEntries?: Map<string, CatalogEntry>;
  scanner?: Scanner;
  secretOverrides?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// buildClaudeAdapter
// ---------------------------------------------------------------------------

/**
 * Build a ClaudeAdapter.
 *
 * All artifact content comes from externalBaseDir when externalIds are present
 * (post-cutover layout, R9):
 * - denyRef       : loaded from <externalBaseDir>/claude/guardrails/<n>/deny.json
 * - agentsContent : loaded from <externalBaseDir>/claude/contexts/<n>/AGENTS.md
 * - skillSource   : resolves id → <externalBaseDir>/common/skills/<id>
 * - agentSource   : resolves id → <externalBaseDir>/common/agents/<agentId>.md
 * - hookSpec      : resolves hook entries to ResolvedHook using effectiveEntries map
 *
 * For remove/check without a checkout: pass `manifest` in opts. The adapter
 * reads canonical payload from ManifestEntry.applied (B-iii reversibility).
 *
 * Without externalBaseDir and without manifest: denyRef=[], agentsContent=''.
 * Audit/planRemove fall back to empty defaults (graceful degradation for legacy entries).
 *
 * @param env   Injectable environment for path resolution.
 * @param opts  Optional seam for remote installs, check, and remove.
 */
export async function buildClaudeAdapter(
  env: Env,
  opts?: BuildClaudeAdapterOpts,
): Promise<Adapter> {
  // ---------------------------------------------------------------------------
  // Resolve denyRef + allowRef: external guardrail from checkout OR empty default
  //
  // Matching: prefer 'guardrail:'-prefixed ids first (canonical form).
  // Fallback: look up nature via effectiveEntries for legacy ids (e.g. 'guardrails-claude').
  // ---------------------------------------------------------------------------

  const externalGuardrailId = opts?.externalIds === undefined
    ? undefined
    : (
      // Primary: local part of id starts with 'guardrail:' (handles qualified ids)
      [...opts.externalIds].find((id) => localId(id).startsWith('guardrail:'))
        // Fallback: any external id whose catalog entry has nature 'guardrail'
        ?? [...opts.externalIds].find((id) =>
          opts.effectiveEntries?.get(id)?.kind === 'artifact'
          && (opts.effectiveEntries.get(id) as { nature: string }).nature === 'guardrail'
        )
    );

  let denyRef: string[];
  let allowRef: string[];

  if (externalGuardrailId !== undefined && opts?.externalBaseDir !== undefined) {
    // Derive the directory name from the local part of the id:
    // 'guardrail:<name>' → <name>; legacy ids (e.g. 'guardrails-claude') → id itself.
    const local = localId(externalGuardrailId);
    const name = local.startsWith('guardrail:')
      ? local.replace(/^guardrail:/, '')
      : local;
    assertSafeArtifactName(name, externalGuardrailId);
    const guardrailDir = path.join(opts.externalBaseDir, CHECKOUT_CLAUDE, 'guardrails', name);
    const [extDeny, extAllow] = await Promise.all([
      loadCanonicalDeny(path.join(guardrailDir, 'deny.json')),
      loadCanonicalAllow(path.join(guardrailDir, 'allow.json')),
    ]);
    denyRef = extDeny;
    allowRef = extAllow;
  } else {
    denyRef = [];
    allowRef = [];
  }

  // ---------------------------------------------------------------------------
  // Resolve agentsContent: external context from checkout OR empty default
  //
  // Matching: prefer 'context:'-prefixed ids; fallback to effectiveEntries lookup.
  // ---------------------------------------------------------------------------

  const externalContextId = opts?.externalIds === undefined
    ? undefined
    : (
      [...opts.externalIds].find((id) => localId(id).startsWith('context:'))
        ?? [...opts.externalIds].find((id) =>
          opts.effectiveEntries?.get(id)?.kind === 'artifact'
          && (opts.effectiveEntries.get(id) as { nature: string }).nature === 'context'
        )
    );

  let agentsContent: string;

  if (externalContextId !== undefined && opts?.externalBaseDir !== undefined) {
    const local = localId(externalContextId);
    const name = local.startsWith('context:')
      ? local.replace(/^context:/, '')
      : local;
    assertSafeArtifactName(name, externalContextId);
    agentsContent = await readText(
      path.join(opts.externalBaseDir, CHECKOUT_CLAUDE, 'contexts', name, 'AGENTS.md'),
    );
  } else {
    agentsContent = '';
  }

  // ---------------------------------------------------------------------------
  // hookSpec: resolves event/matcher/timeout from effectiveEntries ONLY
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Resolve the marketplace NAME(s) for the plugin ledger key `<name>@<marketplace>`
  // (obs1 R3). The audit matches this exact key on disk, so the name must be the
  // marketplace.json `name` field — the value Claude Code records in its ledger —
  // NOT the marketplace source path/URL. Read once here (async), closed over by
  // the sync pluginSource resolver below.
  //
  // Known gap: the local bundled manifest (<cwd>/.claude-plugin/marketplace.json)
  // and a checked-out external one are read when present; a foreign catalog with
  // no checked-out marketplace.json falls back to the bundled name. A wrong name
  // only yields a false `missing` → a redundant, idempotent install, never a
  // destructive op (the doctor change refines external-marketplace naming).
  //
  // obs1 Low A: this guess is cwd-dependent, so `check`/`remove`/`update` run
  // from a project cwd with no (or a foreign) marketplace.json degrade to the
  // 'agent-rigger' fallback, which never matches a plugin genuinely installed
  // under another marketplace name — a false `missing` (exit 3 on a healthy
  // install), not the safe "redundant install" case above. resolvePluginLedgerMarketplace
  // below corrects this guess against the real ledger keys for audit/plan.
  const localMarketplaceName = await readMarketplaceName(
    path.join(process.cwd(), '.claude-plugin', 'marketplace.json'),
  );
  const externalMarketplaceName = opts?.externalBaseDir === undefined
    ? undefined
    : await readMarketplaceName(
      path.join(opts.externalBaseDir, '.claude-plugin', 'marketplace.json'),
    );

  const hookSpec = (entry: AdapterEntry): ResolvedHook => {
    const catalogEntry = opts?.effectiveEntries?.get(entry.id);

    if (
      catalogEntry === undefined
      || catalogEntry.kind !== 'artifact'
      || catalogEntry.nature !== 'hook'
    ) {
      throw new Error(
        `hookSpec: cannot resolve hook "${entry.id}" — entry not found in effective catalog. `
          + 'Pass effectiveEntries with the hook entry when calling buildClaudeAdapter.',
      );
    }

    // Defence-in-depth: event and matcher are required by schema but verify at runtime
    if (!catalogEntry.event || !catalogEntry.matcher) {
      throw new Error(
        `hookSpec: hook entry "${entry.id}" is missing event or matcher fields.`,
      );
    }

    const name = localId(entry.id).replace(/^hook:/, '');
    // Depth-in-defence: guard before any path.join.
    assertSafeArtifactName(name, entry.id);

    if (opts?.externalIds?.has(entry.id) === true && opts.externalBaseDir !== undefined) {
      const hooksDir = path.join(opts.externalBaseDir, CHECKOUT_CLAUDE, 'hooks');
      const scriptStore = hookScriptStorePath(env);
      const command = `bun run ${scriptStore}/${name}.ts`;

      const base: ResolvedHook = {
        event: catalogEntry.event,
        matcher: catalogEntry.matcher,
        command,
        scriptSource: hooksDir,
        scriptStore,
      };
      if (catalogEntry.timeout !== undefined) {
        return { ...base, timeout: catalogEntry.timeout };
      }
      return base;
    }

    throw new Error(
      `hookSpec: hook "${entry.id}" is not in externalIds. `
        + 'All hooks must come from the remote checkout (externalBaseDir).',
    );
  };

  // Extracted to a name (rather than inline in createOpts) so the obs1 Low A
  // wrapper below can reuse the SAME guess that feeds the base adapter, then
  // correct it against the ledger before delegating.
  const pluginSourceResolver = (entry: AdapterEntry): PluginSource => {
    const plugin = localId(entry.id).replace(/^plugin:/, '');
    if (
      opts?.externalIds?.has(entry.id) === true
      && opts.catalogUrl !== undefined
    ) {
      return {
        plugin,
        marketplace: opts.catalogUrl,
        // External: prefer the checked-out marketplace.json name, fall back to
        // the bundled one, then to 'agent-rigger' (obs1 R3 known gap above).
        marketplaceName: externalMarketplaceName ?? localMarketplaceName ?? 'agent-rigger',
      };
    }
    return {
      plugin,
      marketplace: path.join(process.cwd(), '.claude-plugin', 'marketplace.json'),
      marketplaceName: localMarketplaceName ?? 'agent-rigger',
    };
  };

  const createOpts: Parameters<typeof createClaudeAdapter>[0] = {
    denyRef,
    allowRef,
    agentsContent,
    // The REAL security scan runs at the pre-apply gate (remote-install.ts
    // scanEntries) on the checkout paths — skills, agents, and hooks are all
    // covered there before any write (claude plugins are delegate-installed by
    // the `claude` binary, ADR-0003). The adapter-level scanner re-scans each
    // link-op source at apply time (defense in depth): callers that already
    // ran the union gate pass constantScanner(union verdict) (opts.scanner),
    // which blocks on a bad verdict without re-spawning gitleaks/trivy.
    // Callers with nothing to write (check/remove) never pass one → stub.
    scanner: opts?.scanner ?? stubScanner,
    hookSpec,
    skillSource: (entry) => {
      const name = localId(entry.id).replace(/^skill:/, '');
      assertSafeArtifactName(name, entry.id);
      if (
        opts?.externalIds?.has(entry.id) === true
        && opts.externalBaseDir !== undefined
      ) {
        return path.join(opts.externalBaseDir, CHECKOUT_COMMON, 'skills', name);
      }
      throw new Error(
        `skillSource: skill "${entry.id}" is not in externalIds. `
          + 'All skills must come from the remote checkout (externalBaseDir).',
      );
    },
    agentSource: (entry) => {
      const name = localId(entry.id).replace(/^agent:/, '');
      assertSafeArtifactName(name, entry.id);
      if (
        opts?.externalIds?.has(entry.id) === true
        && opts.externalBaseDir !== undefined
      ) {
        return path.join(opts.externalBaseDir, CHECKOUT_COMMON, 'agents', name + '.md');
      }
      throw new Error(
        `agentSource: agent "${entry.id}" is not in externalIds. `
          + 'All agents must come from the remote checkout (externalBaseDir).',
      );
    },
    pluginSource: pluginSourceResolver,
    // R5/R8 (lot 6, D5/D6): resolve the mcp server + RENDERED descriptor via the
    // shared seam. Claude's host-native form keeps env-refs VERBATIM (`${VAR}`)
    // — Claude Code expands them at server spawn (T0). Secrets fail closed here
    // (renderMcpConfig → renderSecretRefs) BEFORE any `claude mcp add-json`.
    mcpSource: (entry) => {
      const { server, config, secretRefs } = renderMcpConfig(entry, {
        env,
        ...(opts?.effectiveEntries === undefined
          ? {}
          : { effectiveEntries: opts.effectiveEntries }),
        ...(opts?.secretOverrides === undefined ? {} : { secretOverrides: opts.secretOverrides }),
        renderVar: (envVar) => `\${${envVar}}`,
      });
      return secretRefs === undefined ? { server, config } : { server, config, secretRefs };
    },
  };

  if (opts?.pluginRunner !== undefined) {
    createOpts.pluginRunner = opts.pluginRunner;
    // The mcp nature drives the same `claude` binary — reuse the injected runner
    // so remote-install's CommandRunner adapter (and test fakes) cover both.
    createOpts.mcpRunner = opts.pluginRunner;
  }

  const baseAdapter = createClaudeAdapter(createOpts);

  // ---------------------------------------------------------------------------
  // obs1 Low A: cross-cwd marketplaceName correction for the plugin nature.
  //
  // Only audit/plan are wrapped — both delegate to auditPlugin/planPlugin,
  // which ARE part of @agent-rigger/adapters' public export surface, so the
  // corrected marketplaceName reaches them without duplicating their state
  // logic. planRemove/adopt are deliberately left calling the base adapter
  // unchanged: their plugins.ts counterparts (planRemovePlugin, adoptPlugin)
  // are internal to the package (no barrel export, see deviations) and a
  // wrong guess there degrades to the pre-existing, already-documented-safe
  // outcome (PluginSource's own contract: a wrong name yields a false
  // `missing`/no-op, never a destructive uninstall) — not the "exit 3 on a
  // healthy install" symptom this fix targets, which is specifically audit's.
  // Every other nature is delegated untouched.
  const wrapped: Adapter = {
    id: baseAdapter.id,
    async audit(entry, scope, callEnv) {
      if (entry.nature !== 'plugin') {
        return baseAdapter.audit(entry, scope, callEnv);
      }
      const guessedMarketplaceName = pluginSourceResolver(entry).marketplaceName;
      const resolved = await resolvePluginLedgerMarketplace(entry, callEnv, guessedMarketplaceName);
      if ('ambiguous' in resolved) {
        return { id: entry.id, nature: 'plugin', state: 'unknown', detail: resolved.ambiguous };
      }
      return auditPlugin(entry, callEnv, resolved.marketplaceName);
    },
    async plan(entry, scope, callEnv) {
      if (entry.nature !== 'plugin') {
        return baseAdapter.plan(entry, scope, callEnv);
      }
      const guessed = pluginSourceResolver(entry);
      const resolved = await resolvePluginLedgerMarketplace(
        entry,
        callEnv,
        guessed.marketplaceName,
      );
      if ('ambiguous' in resolved) {
        // Unknown → no reinstall churn (R2 parity): the advisory already
        // surfaced by audit() above is enough; plan proposes nothing.
        return [];
      }
      return planPlugin(
        entry,
        callEnv,
        () => ({ ...guessed, marketplaceName: resolved.marketplaceName }),
      );
    },
    apply: baseAdapter.apply,
    planRemove: baseAdapter.planRemove,
    applyRemove: baseAdapter.applyRemove,
    // exactOptionalPropertyTypes: baseAdapter.adopt is always set by
    // createClaudeAdapter, but the Adapter interface types it optional —
    // spread it in only when defined rather than assigning `undefined`.
    ...(baseAdapter.adopt === undefined ? {} : { adopt: baseAdapter.adopt }),
  };
  return wrapped;
}
