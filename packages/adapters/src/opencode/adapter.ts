/**
 * OpencodeAdapter — Adapter implementation for opencode.
 *
 * Implements the core Adapter interface by dispatching each method call to the
 * appropriate nature handler. Phase B registered the "quasi-free" natures
 * ('context', 'skill' — no translation involved, only path differs from
 * Claude). Phase C added 'guardrail' (a NATIVE opencode `permission` descriptor
 * authored in the catalog, ADR-0020 "Option A" — no Claude-rule translation)
 * and 'agent' (frontmatter translation, agents.ts). Phase D adds the greenfield
 * natures: 'mcp' (merge into the `mcp`
 * key of opencode.json, mcp.ts) and 'plugin' (store+symlink a catalog-provided
 * JS/TS module, plugins.ts — reuses the 'link'/'unlink' op kinds already wired
 * for 'skill', no new opKindHandlers entry needed). 'hook' is out of scope this
 * pass (D3) — this dispatch shape stays untouched (open/closed, mirrors
 * claude/adapter.ts).
 *
 * Handler shape:
 *   natureHandlers: Map<Nature, { audit, plan, planRemove }>
 *   opKindHandlers / removalOpKindHandlers: Map<Op['kind'], apply fn>
 *
 * Unsupported nature → UnsupportedNatureError (a local mirror of the claude
 * one — kept decoupled so the two adapter packages never depend on each other).
 * Unsupported op kind → Error (should never happen in practice if plan + apply
 * are in sync).
 */

import type { Adapter, AdapterEntry } from '@agent-rigger/core/adapter';
import type { Env } from '@agent-rigger/core/paths';
import type { Scanner } from '@agent-rigger/core/scan';
import { stubScanner } from '@agent-rigger/core/scan';
import type {
  Nature,
  NatureReport,
  OpencodeMcpServer,
  OpencodePermission,
  RemovalOp,
  Scope,
  WriteOp,
} from '@agent-rigger/core/types';

import { auditAgent, planAgent, planRemoveAgent } from './agents';
import {
  applyContext,
  applyRemoveContext,
  auditContext,
  planContext,
  planRemoveContext,
} from './context';
import {
  applyGuardrail,
  applyRemoveGuardrail,
  auditGuardrail,
  planGuardrail,
  planRemoveGuardrail,
} from './guardrails';
import { applyMcp, applyRemoveMcp, auditMcp, planMcp, planRemoveMcp } from './mcp';
import { auditPlugin, planPlugin, planRemovePlugin } from './plugins';
import { applyRemoveSkill, applySkill, auditSkill, planRemoveSkill, planSkill } from './skills';

// ---------------------------------------------------------------------------
// UnsupportedNatureError
// ---------------------------------------------------------------------------

/**
 * Thrown by OpencodeAdapter when audit()/plan()/planRemove() receive a nature
 * that has no registered handler. 'hook' (Phase D3) and 'tool' (advisory-only,
 * never installed by an adapter) still throw this error.
 */
export class UnsupportedNatureError extends Error {
  /** The nature that triggered the error. */
  readonly nature: Nature;

  constructor(nature: Nature) {
    super(`OpencodeAdapter: unsupported nature "${nature}"`);
    this.name = 'UnsupportedNatureError';
    this.nature = nature;
  }
}

// ---------------------------------------------------------------------------
// Handler types
// ---------------------------------------------------------------------------

interface NatureHandler {
  audit(entry: AdapterEntry, scope: Scope, env: Env): Promise<NatureReport>;
  plan(entry: AdapterEntry, scope: Scope, env: Env): Promise<WriteOp[]>;
  planRemove(entry: AdapterEntry, scope: Scope, env: Env): Promise<RemovalOp[]>;
}

type OpKindApply = (ops: WriteOp[], env: Env) => Promise<void>;
type RemovalOpKindApply = (
  ops: RemovalOp[],
  env: Env,
  manifestFiles?: string[],
) => Promise<void>;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OpencodeAdapterConfig {
  /** Canonical AGENTS.md content for the context handler. */
  agentsContent?: string;
  /**
   * Resolve the source directory of a skill from its AdapterEntry.
   * Required when any entry with nature 'skill' is planned or applied.
   * Omitting it is safe as long as no skill entries are processed.
   */
  skillSource?: (entry: AdapterEntry) => string;
  /**
   * Security scanner invoked before each skill installation.
   * Defaults to stubScanner (M0: always passes).
   * Replace with a real scanner at the security milestone.
   */
  scanner?: Scanner;
  /**
   * Native opencode permission descriptor for the guardrail handler (ADR-0020
   * "Option A"). This is the human-authored, security-critical policy fragment
   * loaded verbatim from the catalog's `guardrails/<name>/permission.json` — NOT
   * a translation of Claude rules. Absent → the guardrail handler installs
   * nothing ({}), which is a lossless no-op (never a silent partial enforcement).
   */
  permission?: OpencodePermission;
  /**
   * Resolve the source `.md` file of a Claude-style sub-agent from its AdapterEntry.
   * Required when any entry with nature 'agent' is planned or applied — its
   * frontmatter is read and translated to opencode's schema (design.md §7.2).
   * Omitting it is safe as long as no agent entries are processed.
   */
  agentSource?: (entry: AdapterEntry) => string;
  /**
   * Resolve the MCP server id + config for an entry (design.md §7, ADR-0019).
   * `config` already carries `${VAR}` env-refs, never literal secret values —
   * the adapter treats it verbatim, substitution happens upstream of this call.
   * Required when any entry with nature 'mcp' is planned or applied (unless
   * `entry.applied` already carries an 'opencode-mcp' payload — offline check/remove).
   */
  mcpSource?: (entry: AdapterEntry) => { server: string; config: OpencodeMcpServer };
  /**
   * Resolve the source `.ts`/`.js` module file of an opencode plugin from its
   * AdapterEntry. Required when any entry with nature 'plugin' is planned or
   * applied — the module is copied verbatim (store+symlink, scanner active,
   * design.md §7.3, ADR-0020 §4). Omitting it is safe as long as no plugin
   * entries are processed.
   */
  pluginSource?: (entry: AdapterEntry) => string;
}

// ---------------------------------------------------------------------------
// createOpencodeAdapter
// ---------------------------------------------------------------------------

/**
 * Factory for the opencode adapter.
 *
 * Returns an Adapter that implements audit / plan / apply for the 'opencode'
 * id. Dispatch tables (natureHandlers, opKindHandlers) are built once at
 * creation time; Phase C/D extend them by adding entries to the maps before
 * this function is called, or by composing a new factory.
 *
 * @param config  Adapter configuration (agentsContent, skillSource, scanner).
 */
export function createOpencodeAdapter(config: OpencodeAdapterConfig): Adapter {
  const agentsContent = config.agentsContent ?? '';
  const scanner = config.scanner ?? stubScanner;

  /**
   * Resolve the skill source for an entry, or raise a clear error when
   * skillSource is not configured and a skill operation is attempted.
   */
  function resolveSkillSource(entry: AdapterEntry): string {
    if (config.skillSource === undefined) {
      throw new Error(
        `OpencodeAdapter: skillSource is required to install skill "${entry.id}". `
          + 'Pass a skillSource resolver in OpencodeAdapterConfig.',
      );
    }
    return config.skillSource(entry);
  }

  /**
   * Resolve the agent source .md file for an entry, or raise a clear error when
   * agentSource is not configured and an agent operation is attempted.
   */
  function resolveAgentSource(entry: AdapterEntry): string {
    if (config.agentSource === undefined) {
      throw new Error(
        `OpencodeAdapter: agentSource is required to install agent "${entry.id}". `
          + 'Pass an agentSource resolver in OpencodeAdapterConfig.',
      );
    }
    return config.agentSource(entry);
  }

  /**
   * Resolve the mcp server + config for an entry, or raise a clear error when
   * mcpSource is not configured and an mcp operation is attempted.
   */
  function resolveMcpSource(entry: AdapterEntry): { server: string; config: OpencodeMcpServer } {
    if (config.mcpSource === undefined) {
      throw new Error(
        `OpencodeAdapter: mcpSource is required to install mcp server "${entry.id}". `
          + 'Pass an mcpSource resolver in OpencodeAdapterConfig.',
      );
    }
    return config.mcpSource(entry);
  }

  /**
   * Resolve the plugin source module for an entry, or raise a clear error when
   * pluginSource is not configured and a plugin operation is attempted.
   */
  function resolvePluginSource(entry: AdapterEntry): string {
    if (config.pluginSource === undefined) {
      throw new Error(
        `OpencodeAdapter: pluginSource is required to install plugin "${entry.id}". `
          + 'Pass a pluginSource resolver in OpencodeAdapterConfig.',
      );
    }
    return config.pluginSource(entry);
  }

  // Nature → { audit, plan, planRemove } — Phase C/D add entries here
  const natureHandlers = new Map<Nature, NatureHandler>([
    [
      'context',
      {
        audit(entry, scope, env): Promise<NatureReport> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          // Prefer applied payload from manifest when available (offline remove/check).
          const effectiveContent = entry.applied?.kind === 'context'
            ? entry.applied.block
            : agentsContent;
          return auditContext(scope, env, effectiveContent, cwd);
        },
        plan(entry, scope, env): Promise<WriteOp[]> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          return planContext(scope, env, agentsContent, cwd);
        },
        planRemove(entry, scope, env): Promise<RemovalOp[]> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          const effectiveContent = entry.applied?.kind === 'context'
            ? entry.applied.block
            : agentsContent;
          return planRemoveContext(scope, env, effectiveContent, cwd);
        },
      },
    ],
    [
      'skill',
      {
        audit(entry, scope, env): Promise<NatureReport> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          return auditSkill(entry, scope, env, cwd);
        },
        plan(entry, scope, env): Promise<WriteOp[]> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          return planSkill(entry, scope, env, () => resolveSkillSource(entry), cwd);
        },
        planRemove(entry, scope, env): Promise<RemovalOp[]> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          return planRemoveSkill(entry, scope, env, cwd);
        },
      },
    ],
    [
      'guardrail',
      {
        audit(entry, scope, env): Promise<NatureReport> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          // Prefer applied payload from manifest when available (offline remove/check);
          // otherwise the native descriptor loaded from the catalog (config.permission).
          const effective = entry.applied?.kind === 'opencode-permission'
            ? entry.applied.permission
            : (config.permission ?? {});
          return auditGuardrail(scope, env, effective, cwd);
        },
        plan(entry, scope, env): Promise<WriteOp[]> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          // Native descriptor: no translation step, so there are no translation
          // warnings to surface (the M7 conflict warnings are computed downstream).
          return planGuardrail(scope, env, config.permission ?? {}, cwd, []);
        },
        planRemove(entry, scope, env): Promise<RemovalOp[]> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          const effective = entry.applied?.kind === 'opencode-permission'
            ? entry.applied.permission
            : (config.permission ?? {});
          return planRemoveGuardrail(scope, env, effective, cwd);
        },
      },
    ],
    [
      'agent',
      {
        audit(entry, scope, env): Promise<NatureReport> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          return auditAgent(entry, scope, env, () => resolveAgentSource(entry), cwd);
        },
        plan(entry, scope, env): Promise<WriteOp[]> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          return planAgent(entry, scope, env, () => resolveAgentSource(entry), cwd);
        },
        planRemove(entry, scope, env): Promise<RemovalOp[]> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          return planRemoveAgent(entry, scope, env, () => resolveAgentSource(entry), cwd);
        },
      },
    ],
    [
      'mcp',
      {
        // async: resolveMcpSource can throw synchronously (missing mcpSource
        // config) — declaring these `async` ensures that throw is converted
        // into a rejected Promise (the contract every caller of audit/plan/
        // planRemove relies on), instead of escaping as a synchronous throw.
        async audit(entry, scope, env): Promise<NatureReport> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          // Prefer applied payload from manifest when available (offline remove/check).
          const { server } = entry.applied?.kind === 'opencode-mcp'
            ? entry.applied
            : resolveMcpSource(entry);
          return auditMcp(scope, env, server, cwd);
        },
        async plan(entry, scope, env): Promise<WriteOp[]> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          const { server, config: mcpConfig } = resolveMcpSource(entry);
          return planMcp(scope, env, server, mcpConfig, cwd);
        },
        async planRemove(entry, scope, env): Promise<RemovalOp[]> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          const { server } = entry.applied?.kind === 'opencode-mcp'
            ? entry.applied
            : resolveMcpSource(entry);
          return planRemoveMcp(scope, env, server, cwd);
        },
      },
    ],
    [
      'plugin',
      {
        audit(entry, scope, env): Promise<NatureReport> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          return auditPlugin(entry, scope, env, cwd);
        },
        plan(entry, scope, env): Promise<WriteOp[]> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          return planPlugin(entry, scope, env, () => resolvePluginSource(entry), cwd);
        },
        planRemove(entry, scope, env): Promise<RemovalOp[]> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          return planRemovePlugin(entry, scope, env, cwd);
        },
      },
    ],
  ]);

  // WriteOp kind → apply fn.
  // Note: 'write-text' is shared by context AND agent (translation already baked
  // into op.content at plan time) — applyContext is generic enough to reuse as-is.
  // 'link' is shared by skill AND plugin (applySkill is nature-agnostic: scan
  // op.source, then link store→target) — no dedicated plugin apply fn needed.
  const opKindHandlers = new Map<WriteOp['kind'], OpKindApply>([
    ['write-text', (ops, env) => applyContext(ops, env)],
    ['link', (ops, env) => applySkill(ops, env, scanner)],
    ['merge-permission', (ops, env) => applyGuardrail(ops, env)],
    ['merge-mcp', (ops, env) => applyMcp(ops, env)],
  ]);

  // RemovalOp kind → applyRemove fn — mirrors the install dispatch pattern.
  // 'unlink' is shared by skill AND plugin (applyRemoveSkill is nature-agnostic).
  const removalOpKindHandlers = new Map<RemovalOp['kind'], RemovalOpKindApply>([
    ['delete-file', (ops, env) => applyRemoveContext(ops, env)],
    // R4: manifestFiles (targets of the entries remaining after the removal)
    // feed the store refcount — cwd stays the adapter's project convention
    // (process.cwd(), resolved inside applyRemoveSkill).
    ['unlink', (ops, env, manifestFiles) => applyRemoveSkill(ops, env, undefined, manifestFiles)],
    ['remove-permission', (ops, env) => applyRemoveGuardrail(ops, env)],
    ['remove-mcp', (ops, env) => applyRemoveMcp(ops, env)],
  ]);

  return {
    id: 'opencode',

    audit(entry: AdapterEntry, scope: Scope, env: Env): Promise<NatureReport> {
      const handler = natureHandlers.get(entry.nature);
      if (handler === undefined) {
        return Promise.reject(new UnsupportedNatureError(entry.nature));
      }
      return handler.audit(entry, scope, env);
    },

    plan(entry: AdapterEntry, scope: Scope, env: Env): Promise<WriteOp[]> {
      const handler = natureHandlers.get(entry.nature);
      if (handler === undefined) {
        return Promise.reject(new UnsupportedNatureError(entry.nature));
      }
      return handler.plan(entry, scope, env);
    },

    async apply(ops: WriteOp[], env: Env): Promise<void> {
      // Group ops by kind to delegate each group to the right handler.
      // Maintain the original ordering within each kind group.
      const grouped = new Map<WriteOp['kind'], WriteOp[]>();
      for (const op of ops) {
        const existing = grouped.get(op.kind);
        if (existing === undefined) {
          grouped.set(op.kind, [op]);
        } else {
          existing.push(op);
        }
      }

      for (const [kind, kindOps] of grouped) {
        const applyFn = opKindHandlers.get(kind);
        if (applyFn === undefined) {
          throw new Error(`OpencodeAdapter: unsupported op kind "${kind}"`);
        }
        await applyFn(kindOps, env);
      }
    },

    planRemove(entry: AdapterEntry, scope: Scope, env: Env): Promise<RemovalOp[]> {
      const handler = natureHandlers.get(entry.nature);
      if (handler === undefined) {
        return Promise.reject(new UnsupportedNatureError(entry.nature));
      }
      return handler.planRemove(entry, scope, env);
    },

    async applyRemove(ops: RemovalOp[], env: Env, manifestFiles?: string[]): Promise<void> {
      // Group ops by kind to delegate each group to the right handler.
      // Maintain the original ordering within each kind group.
      const grouped = new Map<RemovalOp['kind'], RemovalOp[]>();
      for (const op of ops) {
        const existing = grouped.get(op.kind);
        if (existing === undefined) {
          grouped.set(op.kind, [op]);
        } else {
          existing.push(op);
        }
      }

      for (const [kind, kindOps] of grouped) {
        const applyFn = removalOpKindHandlers.get(kind);
        if (applyFn === undefined) {
          throw new Error(`OpencodeAdapter: unsupported removal op kind "${kind}"`);
        }
        await applyFn(kindOps, env, manifestFiles);
      }
    },
  };
}
