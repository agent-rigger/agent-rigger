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
import { stubScanner } from '@agent-rigger/core/scan';
import type { OpencodeMcpServer, OpencodePermission } from '@agent-rigger/core/types';

import type { CatalogEntry } from '@agent-rigger/catalog';

// ---------------------------------------------------------------------------
// localId — strip the source-qualifier prefix from a (potentially qualified) id
// ---------------------------------------------------------------------------

/**
 * Return the local (unqualified) part of a catalog entry id.
 * Duplicated from adapter-builder.ts (each CLI builder mirrors its adapter
 * package rather than sharing — design.md §1) to keep the two builders
 * independently evolvable.
 */
function localId(id: string): string {
  const slashIdx = id.indexOf('/');
  return slashIdx === -1 ? id : id.slice(slashIdx + 1);
}

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
 */
export interface BuildOpencodeAdapterOpts {
  externalIds?: Set<string>;
  externalBaseDir?: string;
  effectiveEntries?: Map<string, CatalogEntry>;
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
 * - mcpSource        : resolves { server, config } from effectiveEntries' raw `config` field
 *
 * Without an external guardrail: permission is left unset, agentsContent='' (graceful
 * degradation — audit/planRemove fall back to entry.applied for legacy entries).
 *
 * @param _env  Injectable environment — kept for signature parity with buildClaudeAdapter
 *              so adapter-dispatch.ts can call either builder uniformly. Unused today:
 *              no opencode nature needs HOME-relative paths at build time.
 * @param opts  Optional seam for remote installs, check, and remove.
 */
export async function buildOpencodeAdapter(
  _env: Env,
  opts?: BuildOpencodeAdapterOpts,
): Promise<Adapter> {
  // ---------------------------------------------------------------------------
  // Resolve the native opencode permission descriptor from the checkout.
  // A native opencode guardrail REQUIRES a hand-authored permission.json — there
  // is NO fallback to Claude-rule translation (ADR-0020 "Option A"). Absent when
  // no external guardrail is selected → permission stays undefined (the handler
  // then installs {}, resolving via entry.applied for legacy manifest entries).
  // ---------------------------------------------------------------------------

  const externalGuardrailId = opts?.externalIds === undefined
    ? undefined
    : (
      [...opts.externalIds].find((id) => localId(id).startsWith('guardrail:'))
        ?? [...opts.externalIds].find((id) =>
          opts.effectiveEntries?.get(id)?.kind === 'artifact'
          && (opts.effectiveEntries.get(id) as { nature: string }).nature === 'guardrail'
        )
    );

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
    // scanner re-scans each link-op source at apply time, so it stays a stub
    // to avoid double-scanning the same checkout content.
    scanner: stubScanner,
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
    mcpSource: (entry: AdapterEntry): { server: string; config: OpencodeMcpServer } => {
      const catalogEntry = opts?.effectiveEntries?.get(entry.id);

      if (
        catalogEntry === undefined
        || catalogEntry.kind !== 'artifact'
        || catalogEntry.nature !== 'mcp'
      ) {
        throw new Error(
          `mcpSource: cannot resolve mcp server "${entry.id}" — entry not found in effective `
            + 'catalog. Pass effectiveEntries with the mcp entry when calling buildOpencodeAdapter.',
        );
      }

      // TODO(E-secrets): config is passed through verbatim — env-refs (e.g.
      // "${GITHUB_TOKEN}") stay literal strings; secret substitution/prompting
      // is deferred to a later phase (tasks.md E-secrets, ADR-0019).
      const config = catalogEntry.config;
      if (config === undefined) {
        throw new Error(
          `mcpSource: mcp entry "${entry.id}" has no "config" field in the catalog. `
            + 'An mcp artifact must declare its server configuration.',
        );
      }

      const server = localId(entry.id).replace(/^mcp:/, '');
      return { server, config: config as unknown as OpencodeMcpServer };
    },
  };

  // exactOptionalPropertyTypes: only set `permission` when a descriptor was
  // actually loaded — never assign `undefined` to the optional field.
  if (permission !== undefined) {
    createOpts.permission = permission;
  }

  return createOpencodeAdapter(createOpts);
}
