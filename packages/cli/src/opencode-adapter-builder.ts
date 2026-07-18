/**
 * opencode-adapter-builder.ts — shared factory for OpencodeAdapter instances.
 *
 * Mirrors adapter-builder.ts's external-resolver seam (buildClaudeAdapter) for
 * the opencode assistant, so both builders can be dispatched uniformly by
 * adapter-dispatch.ts.
 *
 * Responsibilities:
 * - Load the NATIVE opencode `permission` descriptor + agentsContent from
 *   externalBaseDir (checkout). The guardrail is a hand-authored
 *   guardrails/<name>/permission.json (ADR-0020 "Option A") — loaded verbatim,
 *   never translated from Claude deny/allow rules.
 * - Build all source closures: skillSource, agentSource, pluginSource, mcpSource.
 * - mcpSource resolves { server, config } from effectiveEntries — config is the
 *   catalog entry's raw `config` field, passed through unchanged.
 *
 * Constraints:
 * - No circular imports: does not import from cli.ts.
 * - exactOptionalPropertyTypes: never assigns undefined to optional fields.
 * - No hookSpec: opencode has no 'hook' handler (claude-only nature, routed by
 *   `targets` — design.md §7.3, ADR-0020 amended). Not wired here (E-targets).
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';

import { createOpencodeAdapter, loadCanonicalOpencodePermission } from '@agent-rigger/adapters';
import type { Adapter, AdapterEntry } from '@agent-rigger/core/adapter';
import { assertSafeArtifactName } from '@agent-rigger/core/artifact-name';
import { readText } from '@agent-rigger/core/fs-json';
import type { Env } from '@agent-rigger/core/paths';
import type { Scanner } from '@agent-rigger/core/scan';
import { stubScanner } from '@agent-rigger/core/scan';
import type { OpencodeMcpServer, OpencodePermission } from '@agent-rigger/core/types';

import { type CatalogEntry, localId } from '@agent-rigger/catalog';

import { renderMcpConfig } from './mcp-source';

// ---------------------------------------------------------------------------
// BuildOpencodeAdapterOpts
// ---------------------------------------------------------------------------

/**
 * Options for the external-resolver seam in buildOpencodeAdapter.
 *
 * @param externalIds      Set of artifact ids whose source should be resolved
 *                         from externalBaseDir.
 * @param externalBaseDir  Absolute path to the root of a remote checkout. Expected
 *                         layout: skills/<name>/, agents/<name>.md, plugins/<name>.<ext>,
 *                         guardrails/<n>/permission.json, contexts/<n>/AGENTS.md.
 * @param effectiveEntries Lookup map (id → CatalogEntry) for the resolved effective
 *                         catalog. Used by mcpSource to resolve the raw `config` field.
 * @param scanner          Security scanner invoked at apply time (defense in depth) for each
 *                         skill link write-op. Callers that already ran the pre-apply union
 *                         gate (scanEntries) pass constantScanner(union verdict) so the
 *                         re-check blocks on a bad verdict with zero extra spawns. Omitted →
 *                         falls back to stubScanner (check/remove paths never write content, so a
 *                         stub there is inert).
 * @param secretOverrides  ref→VAR overrides for mcp secrets (R5, lot 6, D5): from
 *                         --secret-env flags on install, or replayed from a manifest's
 *                         secretRefs on update (no re-prompt, ADR-0020 §1). A ref absent
 *                         from this map defaults to its own name (mcpSource, T6 render).
 */
export interface BuildOpencodeAdapterOpts {
  externalIds?: Set<string>;
  externalBaseDir?: string;
  effectiveEntries?: Map<string, CatalogEntry>;
  scanner?: Scanner;
  secretOverrides?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// resolveOpencodePluginPath — extension-agnostic basename lookup
// ---------------------------------------------------------------------------

/**
 * Search `pluginsDir` for a file whose basename (extension stripped) equals
 * `name`, mirroring plugins.ts's findInstalledFile lookup — sync, because
 * OpencodeAdapterConfig.pluginSource is a synchronous resolver.
 */
function resolveOpencodePluginPath(pluginsDir: string, name: string, id: string): string {
  let files: string[];
  try {
    files = readdirSync(pluginsDir);
  } catch {
    files = [];
  }

  const match = files.find((f) => path.parse(f).name === name);
  if (match === undefined) {
    throw new Error(
      `pluginSource: plugin "${id}" not found under ${pluginsDir}. `
        + `Expected a file named "${name}.<ext>" in the remote checkout.`,
    );
  }

  return path.join(pluginsDir, match);
}

// ---------------------------------------------------------------------------
// buildOpencodeAdapter
// ---------------------------------------------------------------------------

/**
 * Build an OpencodeAdapter.
 *
 * All artifact content comes from externalBaseDir when externalIds are present:
 * - permission       : loaded verbatim from <externalBaseDir>/guardrails/<n>/permission.json
 *                       (native opencode descriptor, ADR-0020 "Option A"; a native
 *                       guardrail REQUIRES a descriptor — missing/empty → hard error)
 * - agentsContent    : loaded from <externalBaseDir>/contexts/<n>/AGENTS.md
 * - skillSource      : resolves id → <externalBaseDir>/skills/<id>
 * - agentSource      : resolves id → <externalBaseDir>/agents/<agentId>.md
 * - pluginSource     : resolves id → <externalBaseDir>/plugins/<id>.<ext> (basename lookup)
 * - mcpSource        : resolves { server, config, secretRefs? } — config is RENDERED
 *                       from effectiveEntries' raw `config` field (R5, see mcpSource below)
 *
 * Without an external guardrail: permission is left unset, agentsContent='' (graceful
 * degradation — audit/planRemove fall back to entry.applied for legacy entries).
 *
 * @param env   Injectable environment. Used by mcpSource's secret render (R5)
 *              to check presence of the resolved env var — the SAME seam that
 *              carries HOME-relative path overrides in tests.
 * @param opts  Optional seam for remote installs, check, and remove.
 */
export async function buildOpencodeAdapter(
  env: Env,
  opts?: BuildOpencodeAdapterOpts,
): Promise<Adapter> {
  // ---------------------------------------------------------------------------
  // Resolve the native opencode permission descriptor from the checkout.
  // A native opencode guardrail REQUIRES a hand-authored permission.json — there
  // is NO fallback to Claude-rule translation (ADR-0020 "Option A"). Absent when
  // no external guardrail is selected → permission stays undefined (the handler
  // then installs {}, resolving via entry.applied for legacy manifest entries).
  // ---------------------------------------------------------------------------

  // Collect ALL selected guardrail ids via BOTH detection modes — the `guardrail:`
  // prefix and, for ids that carry none, the catalog entry's nature. externalIds is
  // a Set, so filtering it once yields the deduplicated union (an id matched by both
  // modes still counts once). Selecting ≥2 guardrails is a hard error, never a silent
  // pick of the first: merging permission descriptors would reopen the unfaithful-
  // coverage risk ADR-0021 closed. One guardrail (or none) keeps the prior behavior.
  const guardrailIds = opts?.externalIds === undefined
    ? []
    : [...opts.externalIds].filter((id) =>
      localId(id).startsWith('guardrail:')
      || (opts.effectiveEntries?.get(id)?.kind === 'artifact'
        && (opts.effectiveEntries.get(id) as { nature: string }).nature === 'guardrail')
    );

  if (guardrailIds.length > 1) {
    throw new Error(
      `multiple guardrails selected for opencode: ${[...guardrailIds].sort().join(', ')} `
        + '— select a single guardrail per install',
    );
  }

  const externalGuardrailId: string | undefined = guardrailIds[0];

  let permission: OpencodePermission | undefined;

  if (externalGuardrailId !== undefined && opts?.externalBaseDir !== undefined) {
    const local = localId(externalGuardrailId);
    const name = local.startsWith('guardrail:') ? local.replace(/^guardrail:/, '') : local;
    assertSafeArtifactName(name, externalGuardrailId);
    const guardrailDir = path.join(opts.externalBaseDir, 'guardrails', name);
    permission = await loadCanonicalOpencodePermission(path.join(guardrailDir, 'permission.json'));
  }

  // ---------------------------------------------------------------------------
  // Resolve agentsContent: external context from checkout OR empty default
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
    const name = local.startsWith('context:') ? local.replace(/^context:/, '') : local;
    assertSafeArtifactName(name, externalContextId);
    agentsContent = await readText(path.join(opts.externalBaseDir, 'contexts', name, 'AGENTS.md'));
  } else {
    agentsContent = '';
  }

  // ---------------------------------------------------------------------------
  // createOpts
  // ---------------------------------------------------------------------------

  const createOpts: Parameters<typeof createOpencodeAdapter>[0] = {
    agentsContent,
    // The REAL security scan runs at the pre-apply gate (remote-install.ts
    // scanEntries) on the checkout paths — skills, agents, and opencode plugin
    // modules (H13) are all covered there before any write. The adapter-level
    // scanner re-checks each link-op source at apply time (defense in depth):
    // callers that already ran the union gate pass constantScanner(union
    // verdict) (opts.scanner), which blocks on a bad verdict without
    // re-spawning gitleaks/trivy. Callers with nothing to write (check/remove)
    // never pass one → stub.
    scanner: opts?.scanner ?? stubScanner,
    skillSource: (entry) => {
      const name = localId(entry.id).replace(/^skill:/, '');
      assertSafeArtifactName(name, entry.id);
      if (opts?.externalIds?.has(entry.id) === true && opts.externalBaseDir !== undefined) {
        return path.join(opts.externalBaseDir, 'skills', name);
      }
      throw new Error(
        `skillSource: skill "${entry.id}" is not in externalIds. `
          + 'All skills must come from the remote checkout (externalBaseDir).',
      );
    },
    agentSource: (entry) => {
      const name = localId(entry.id).replace(/^agent:/, '');
      assertSafeArtifactName(name, entry.id);
      if (opts?.externalIds?.has(entry.id) === true && opts.externalBaseDir !== undefined) {
        return path.join(opts.externalBaseDir, 'agents', name + '.md');
      }
      throw new Error(
        `agentSource: agent "${entry.id}" is not in externalIds. `
          + 'All agents must come from the remote checkout (externalBaseDir).',
      );
    },
    pluginSource: (entry) => {
      const name = localId(entry.id).replace(/^plugin:/, '');
      assertSafeArtifactName(name, entry.id);
      if (opts?.externalIds?.has(entry.id) === true && opts.externalBaseDir !== undefined) {
        const pluginsDir = path.join(opts.externalBaseDir, 'plugins');
        return resolveOpencodePluginPath(pluginsDir, name, entry.id);
      }
      throw new Error(
        `pluginSource: plugin "${entry.id}" is not in externalIds. `
          + 'All plugins must come from the remote checkout (externalBaseDir).',
      );
    },
    mcpSource: (
      entry: AdapterEntry,
    ): { server: string; config: OpencodeMcpServer; secretRefs?: Record<string, string> } => {
      // Shared resolver + secret render (mcp-source.ts); opencode's host-native
      // form is `{env:VAR}` (T0: opencode does not expand bash-style "${VAR}").
      const { server, config, secretRefs } = renderMcpConfig(entry, {
        env,
        ...(opts?.effectiveEntries === undefined
          ? {}
          : { effectiveEntries: opts.effectiveEntries }),
        ...(opts?.secretOverrides === undefined ? {} : { secretOverrides: opts.secretOverrides }),
        renderVar: (envVar) => `{env:${envVar}}`,
      });
      const opencodeConfig = config as unknown as OpencodeMcpServer;
      return secretRefs === undefined
        ? { server, config: opencodeConfig }
        : { server, config: opencodeConfig, secretRefs };
    },
  };

  // exactOptionalPropertyTypes: only set `permission` when a descriptor was
  // actually loaded — never assign `undefined` to the optional field.
  if (permission !== undefined) {
    createOpts.permission = permission;
  }

  return createOpencodeAdapter(createOpts);
}
