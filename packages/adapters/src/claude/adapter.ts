/**
 * ClaudeAdapter — Adapter implementation for Claude Code.
 *
 * Implements the core Adapter interface by dispatching each method call to the
 * appropriate nature handler. The dispatch is structured as a map of handlers
 * so E2-E5 can register new natures without touching this file (open/closed).
 *
 * Handler shape:
 *   natureHandlers: Map<Nature, { audit, plan }>
 *   opKindHandlers: Map<WriteOp['kind'], apply fn>
 *
 * Unsupported nature → UnsupportedNatureError (exported, carries nature field).
 * Unsupported op kind → Error (should never happen in practice if plan + apply are in sync).
 */

import type { Adapter, AdapterEntry, AdoptionResult } from '@agent-rigger/core/adapter';
import type { Env } from '@agent-rigger/core/paths';
import type { Scanner } from '@agent-rigger/core/scan';
import { stubScanner } from '@agent-rigger/core/scan';
import type {
  ClaudeMcpServer,
  Nature,
  NatureReport,
  RemovalOp,
  RemovalOpRemoveHooks,
  Scope,
  WriteOp,
} from '@agent-rigger/core/types';

import { adoptAgent, auditAgent, planAgent, planRemoveAgent } from './agents';
import {
  adoptContext,
  applyContext,
  applyRemoveContext,
  auditContext,
  planContext,
  planRemoveContext,
} from './context';
import {
  adoptGuardrail,
  applyGuardrail,
  applyRemoveGuardrail,
  auditGuardrail,
  planGuardrail,
  planRemoveGuardrail,
} from './guardrails';
import {
  adoptHook,
  applyHook,
  applyRemoveHook,
  auditHook,
  planHook,
  planRemoveHook,
} from './hooks';
import type { ResolvedHook } from './hooks';
import {
  adoptMcp,
  applyMcp,
  applyRemoveMcp,
  auditMcp,
  defaultMcpRunner,
  planMcp,
  planRemoveMcp,
} from './mcp';
import type { McpRunner } from './mcp';
import {
  adoptPlugin,
  applyPlugin,
  applyRemovePlugin,
  auditPlugin,
  defaultPluginRunner,
  planPlugin,
  planRemovePlugin,
  PluginUninstallError,
} from './plugins';
import type { PluginRunner, PluginSource } from './plugins';
import {
  adoptSkill,
  applyRemoveSkill,
  applySkill,
  auditSkill,
  planRemoveSkill,
  planSkill,
} from './skills';

// Re-export so callers can catch this typed error without importing from plugins directly
export { PluginUninstallError };

// ---------------------------------------------------------------------------
// UnsupportedNatureError
// ---------------------------------------------------------------------------

/**
 * Thrown by ClaudeAdapter when audit() or plan() receives a nature that has no
 * registered handler. E2-E5 will register their handlers; until then any call
 * with 'skill', 'agent', etc. throws this error.
 */
export class UnsupportedNatureError extends Error {
  /** The nature that triggered the error. */
  readonly nature: Nature;

  constructor(nature: Nature) {
    super(`ClaudeAdapter: unsupported nature "${nature}"`);
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
  /** R5/D5 adoption gate — records a conforming-on-disk artifact into the manifest. */
  adopt(entry: AdapterEntry, scope: Scope, env: Env): Promise<AdoptionResult | undefined>;
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

export interface ClaudeAdapterConfig {
  /** Canonical deny rules loaded from the installed guardrail entry (deny.json from catalog checkout). */
  denyRef: string[];
  /** Canonical allow rules loaded from the installed guardrail entry (allow.json from catalog checkout, default []). */
  allowRef?: string[];
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
   * Resolve the source .md file path of a sub-agent from its AdapterEntry.
   * Required when any entry with nature 'agent' is planned or applied.
   * Omitting it is safe as long as no agent entries are processed.
   */
  agentSource?: (entry: AdapterEntry) => string;
  /**
   * Resolve the plugin coordinates (plugin id + marketplace path) for a
   * plugin entry. Required when any entry with nature 'plugin' is planned or
   * applied. Omitting it is safe as long as no plugin entries are processed.
   *
   * Default (when resolver is provided but pluginSource returns undefined):
   * plugin = pluginName(entry), marketplace = '<cwd>/.claude-plugin/marketplace.json'.
   */
  pluginSource?: (entry: AdapterEntry) => PluginSource;
  /**
   * Injectable runner for plugin CLI commands.
   * Defaults to defaultPluginRunner (Bun.spawn-backed).
   * Replace with a fake runner in tests to avoid real `claude` invocations.
   */
  pluginRunner?: PluginRunner;
  /**
   * Optional GitLab personal access token forwarded as GITLAB_TOKEN to the
   * plugin runner env. Useful when the marketplace is hosted on a private
   * GitLab instance.
   */
  gitlabToken?: string;
  /**
   * Resolve the concrete hook specification for a hook entry.
   * Required when any entry with nature 'hook' is audited, planned, or applied.
   * Omitting it is safe as long as no hook entries are processed.
   *
   * In H4 this resolver will read from the script catalogue and repository.
   * In H3 callers inject an arbitrary function (e.g. a constant).
   */
  hookSpec?: (entry: AdapterEntry) => ResolvedHook;
  /**
   * Resolve the MCP server id + RENDERED descriptor for an entry (R8, lot 6,
   * ADR-0019). `config` is already fully rendered — env-refs kept VERBATIM
   * (`${VAR}`) since Claude Code expands them at spawn (T0). `secretRefs`
   * (ref→VAR, names only) is threaded to the manifest's AppliedClaudeMcp so a
   * later `update` re-renders without re-prompting. Required when any entry
   * with nature 'mcp' is planned or applied (unless `entry.applied` already
   * carries a 'claude-mcp' payload — offline check/remove).
   */
  mcpSource?: (
    entry: AdapterEntry,
  ) => { server: string; config: ClaudeMcpServer; secretRefs?: Record<string, string> };
  /**
   * Injectable runner for `claude mcp` CLI commands. Defaults to
   * defaultMcpRunner (Bun.spawn-backed). Replace with a fake runner in tests to
   * avoid real `claude` invocations.
   */
  mcpRunner?: McpRunner;
}

// ---------------------------------------------------------------------------
// createClaudeAdapter
// ---------------------------------------------------------------------------

/**
 * Factory for the Claude adapter.
 *
 * Returns an Adapter that implements audit / plan / apply for the 'claude' id.
 * Dispatch tables (natureHandlers, opKindHandlers) are built once at creation
 * time; E2-E5 extend them by adding entries to the maps before this function
 * is called, or by composing a new factory.
 *
 * @param config  Adapter configuration (currently: denyRef for guardrail handler).
 */
export function createClaudeAdapter(config: ClaudeAdapterConfig): Adapter {
  const agentsContent = config.agentsContent ?? '';
  const scanner = config.scanner ?? stubScanner;
  const allowRef = config.allowRef ?? [];

  /**
   * Resolve the skill source for an entry, or raise a clear error when
   * skillSource is not configured and a skill operation is attempted.
   */
  function resolveSkillSource(entry: AdapterEntry): string {
    if (config.skillSource === undefined) {
      throw new Error(
        `ClaudeAdapter: skillSource is required to install skill "${entry.id}". `
          + 'Pass a skillSource resolver in ClaudeAdapterConfig.',
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
        `ClaudeAdapter: agentSource is required to install agent "${entry.id}". `
          + 'Pass an agentSource resolver in ClaudeAdapterConfig.',
      );
    }
    return config.agentSource(entry);
  }

  /**
   * Resolve plugin coordinates for an entry, or raise a clear error when
   * pluginSource is not configured and a plugin operation is attempted.
   */
  function resolvePluginSource(entry: AdapterEntry): PluginSource {
    if (config.pluginSource === undefined) {
      throw new Error(
        `ClaudeAdapter: pluginSource is required to install plugin "${entry.id}". `
          + 'Pass a pluginSource resolver in ClaudeAdapterConfig.',
      );
    }
    return config.pluginSource(entry);
  }

  /**
   * Resolve the hook spec for an entry, or raise a clear error when
   * hookSpec is not configured and a hook operation is attempted.
   */
  function resolveHookSpec(entry: AdapterEntry): ResolvedHook {
    if (config.hookSpec === undefined) {
      throw new Error(
        `ClaudeAdapter: hookSpec is required to install hook "${entry.id}". `
          + 'Pass a hookSpec resolver in ClaudeAdapterConfig.',
      );
    }
    return config.hookSpec(entry);
  }

  const pluginRunner = config.pluginRunner ?? defaultPluginRunner;
  const mcpRunner = config.mcpRunner ?? defaultMcpRunner;

  /**
   * Resolve the mcp server + rendered descriptor for an entry, or raise a clear
   * error when mcpSource is not configured and an mcp operation is attempted.
   */
  function resolveMcpSource(
    entry: AdapterEntry,
  ): { server: string; config: ClaudeMcpServer; secretRefs?: Record<string, string> } {
    if (config.mcpSource === undefined) {
      throw new Error(
        `ClaudeAdapter: mcpSource is required to install mcp server "${entry.id}". `
          + 'Pass an mcpSource resolver in ClaudeAdapterConfig.',
      );
    }
    return config.mcpSource(entry);
  }

  // Nature → { audit, plan, planRemove } — E2-E5 add entries here
  const natureHandlers = new Map<Nature, NatureHandler>([
    [
      'guardrail',
      {
        audit(entry, scope, env): Promise<NatureReport> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          // B-iii: prefer applied payload from manifest when available.
          const effectiveDeny = entry.applied?.kind === 'guardrail'
            ? entry.applied.denyRules
            : config.denyRef;
          const effectiveAllow = entry.applied?.kind === 'guardrail'
            ? entry.applied.allowRules
            : allowRef;
          return auditGuardrail(scope, env, effectiveDeny, cwd, effectiveAllow);
        },
        plan(entry, scope, env): Promise<WriteOp[]> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          return planGuardrail(scope, env, config.denyRef, cwd, allowRef);
        },
        planRemove(entry, scope, env): Promise<RemovalOp[]> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          // B-iii: prefer applied payload from manifest when available.
          const effectiveDeny = entry.applied?.kind === 'guardrail'
            ? entry.applied.denyRules
            : config.denyRef;
          const effectiveAllow = entry.applied?.kind === 'guardrail'
            ? entry.applied.allowRules
            : allowRef;
          return planRemoveGuardrail(scope, env, effectiveDeny, cwd, effectiveAllow);
        },
        adopt(entry, scope, env): Promise<AdoptionResult | undefined> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          // Adoption records the CANONICAL rules (config.*), never a manifest
          // payload — the adoption branch fires only when no manifest entry exists.
          return adoptGuardrail(scope, env, config.denyRef, cwd, allowRef);
        },
      },
    ],
    [
      'context',
      {
        audit(entry, scope, env): Promise<NatureReport> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          // B-iii: prefer applied payload from manifest when available.
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
          // B-iii: prefer applied payload from manifest when available. R6
          // threads the recorded restore baseline (previous) into the plan;
          // a legacy payload without it degrades to delete-on-exact-match.
          if (entry.applied?.kind === 'context') {
            return planRemoveContext(scope, env, entry.applied.block, cwd, entry.applied.previous);
          }
          return planRemoveContext(scope, env, agentsContent, cwd);
        },
        adopt(entry, scope, env): Promise<AdoptionResult | undefined> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          return adoptContext(scope, env, agentsContent, cwd);
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
        adopt(entry, scope, env): Promise<AdoptionResult | undefined> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          return adoptSkill(entry, scope, env, cwd);
        },
      },
    ],
    [
      'plugin',
      {
        // Reads are on-disk and spawn-free (obs1, R1): the ledger under the
        // Claude config dir is the source of truth. resolvePluginSource can throw
        // synchronously (missing pluginSource config) — `async` converts that into
        // a rejected Promise, the contract audit/plan/planRemove/adopt callers rely
        // on. The pluginRunner spawns ONLY at apply time (post-confirm), never here.
        async audit(entry, _scope, env): Promise<NatureReport> {
          return auditPlugin(entry, env, resolvePluginSource(entry).marketplaceName);
        },
        async plan(entry, _scope, env): Promise<WriteOp[]> {
          return planPlugin(entry, env, resolvePluginSource);
        },
        async planRemove(entry, _scope, env): Promise<RemovalOp[]> {
          return planRemovePlugin(entry, env, resolvePluginSource(entry).marketplaceName);
        },
        async adopt(entry, _scope, env): Promise<AdoptionResult | undefined> {
          return adoptPlugin(entry, env, resolvePluginSource(entry).marketplaceName);
        },
      },
    ],
    [
      'mcp',
      {
        // async: resolveMcpSource can throw synchronously (missing mcpSource
        // config) — declaring these async converts that into a rejected Promise,
        // the contract every caller of audit/plan/planRemove/adopt relies on.
        async audit(entry, scope, env): Promise<NatureReport> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          // Prefer applied payload from manifest when available (offline remove/check).
          const server = entry.applied?.kind === 'claude-mcp'
            ? entry.applied.server
            : resolveMcpSource(entry).server;
          return auditMcp(scope, env, server, cwd);
        },
        async plan(entry, scope, env): Promise<WriteOp[]> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          const { server, config: mcpConfig, secretRefs } = resolveMcpSource(entry);
          return planMcp(scope, env, server, mcpConfig, cwd, secretRefs);
        },
        async planRemove(entry, scope, env): Promise<RemovalOp[]> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          const server = entry.applied?.kind === 'claude-mcp'
            ? entry.applied.server
            : resolveMcpSource(entry).server;
          return planRemoveMcp(scope, env, server, cwd);
        },
        async adopt(entry, scope, env): Promise<AdoptionResult | undefined> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          // Adoption runs only when no manifest record exists — resolve the
          // canonical server + RENDERED config, then deep-compare against disk
          // (FM5, R5: comparing the rendered form avoids a false drift).
          const { server, config: mcpConfig, secretRefs } = resolveMcpSource(entry);
          return adoptMcp(scope, env, server, mcpConfig, cwd, secretRefs);
        },
      },
    ],
    [
      'agent',
      {
        audit(entry, scope, env): Promise<NatureReport> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          return auditAgent(entry, scope, env, cwd);
        },
        plan(entry, scope, env): Promise<WriteOp[]> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          return planAgent(entry, scope, env, () => resolveAgentSource(entry), cwd);
        },
        planRemove(entry, scope, env): Promise<RemovalOp[]> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          return planRemoveAgent(entry, scope, env, cwd);
        },
        adopt(entry, scope, env): Promise<AdoptionResult | undefined> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          return adoptAgent(entry, scope, env, cwd);
        },
      },
    ],
    [
      'hook',
      {
        audit(entry, scope, env): Promise<NatureReport> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          // B-iii: prefer applied payload from manifest when available.
          if (entry.applied?.kind === 'hook') {
            const appliedSpec: ResolvedHook = {
              event: entry.applied.event,
              matcher: entry.applied.matcher,
              command: entry.applied.command,
              ...(entry.applied.timeout === undefined ? {} : { timeout: entry.applied.timeout }),
            };
            return auditHook(entry, scope, env, appliedSpec, cwd);
          }
          let spec: ResolvedHook;
          try {
            spec = resolveHookSpec(entry);
          } catch (err) {
            return Promise.reject(err);
          }
          return auditHook(entry, scope, env, spec, cwd);
        },
        plan(entry, scope, env): Promise<WriteOp[]> {
          let spec: ResolvedHook;
          try {
            spec = resolveHookSpec(entry);
          } catch (err) {
            return Promise.reject(err);
          }
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          return planHook(entry, scope, env, spec, cwd);
        },
        planRemove(entry, scope, env): Promise<RemovalOp[]> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          // B-iii: prefer applied payload from manifest when available.
          if (entry.applied?.kind === 'hook') {
            const appliedSpec: ResolvedHook = {
              event: entry.applied.event,
              matcher: entry.applied.matcher,
              command: entry.applied.command,
              ...(entry.applied.timeout === undefined ? {} : { timeout: entry.applied.timeout }),
            };
            return planRemoveHook(entry, scope, env, appliedSpec, cwd);
          }
          let spec: ResolvedHook;
          try {
            spec = resolveHookSpec(entry);
          } catch (err) {
            return Promise.reject(err);
          }
          return planRemoveHook(entry, scope, env, spec, cwd);
        },
        adopt(entry, scope, env): Promise<AdoptionResult | undefined> {
          // Adoption runs only when no manifest entry exists, so there is no
          // `applied` to prefer — resolve the canonical spec (reject if the
          // resolver is not configured, mirroring plan()).
          let spec: ResolvedHook;
          try {
            spec = resolveHookSpec(entry);
          } catch (err) {
            return Promise.reject(err);
          }
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          return adoptHook(scope, env, spec, cwd);
        },
      },
    ],
  ]);

  // Build plugin apply opts once; omit gitlabToken key entirely when not set
  // (exactOptionalPropertyTypes prevents assigning undefined to optional string).
  const pluginApplyOpts = config.gitlabToken === undefined
    ? { run: pluginRunner }
    : { run: pluginRunner, gitlabToken: config.gitlabToken };

  // WriteOp kind → apply fn — E2-E5 add entries here
  const opKindHandlers = new Map<WriteOp['kind'], OpKindApply>([
    ['merge-deny', (ops, env) => applyGuardrail(ops, env)],
    ['merge-allow', (ops, env) => applyGuardrail(ops, env)],
    ['write-text', (ops, env) => applyContext(ops, env)],
    ['ensure-import', (ops, env) => applyContext(ops, env)],
    ['link', (ops, env) => applySkill(ops, env, scanner)],
    ['plugin-install', (ops, env) => applyPlugin(ops, env, pluginApplyOpts)],
    ['mcp-add', (ops, env) => applyMcp(ops, env, { run: mcpRunner })],
    ['merge-hooks', (ops, env) => applyHook(ops, env)],
    // Traced hook migration (R1/D8): an install plan may carry remove-hooks
    // ops retiring the previously installed spec. Same executor as the remove
    // path; the type-guard filter narrows WriteOp[] to the removal shape.
    [
      'remove-hooks',
      (ops, env) =>
        applyRemoveHook(
          ops.filter((op): op is RemovalOpRemoveHooks => op.kind === 'remove-hooks'),
          env,
        ),
    ],
  ]);

  // RemovalOp kind → applyRemove fn — mirrors the install dispatch pattern
  const removalOpKindHandlers = new Map<RemovalOp['kind'], RemovalOpKindApply>([
    ['remove-deny', (ops, env) => applyRemoveGuardrail(ops, env)],
    ['remove-allow', (ops, env) => applyRemoveGuardrail(ops, env)],
    // R6: manifestFiles (files of the entries remaining after the removal)
    // feed the shared-AGENTS.md gate — a path another assistant still
    // references is neither deleted nor restored, only the block goes.
    ['delete-file', (ops, env, manifestFiles) => applyRemoveContext(ops, env, manifestFiles)],
    ['remove-block', (ops, env, manifestFiles) => applyRemoveContext(ops, env, manifestFiles)],
    ['restore-file', (ops, env, manifestFiles) => applyRemoveContext(ops, env, manifestFiles)],
    // R4: manifestFiles (targets of the entries remaining after the removal)
    // feed the store refcount — cwd stays the adapter's project convention
    // (process.cwd(), resolved inside applyRemoveSkill).
    ['unlink', (ops, env, manifestFiles) => applyRemoveSkill(ops, env, undefined, manifestFiles)],
    ['plugin-uninstall', (ops, env) => applyRemovePlugin(ops, env, { run: pluginRunner })],
    ['mcp-remove', (ops, env) => applyRemoveMcp(ops, env, { run: mcpRunner })],
    ['remove-hooks', (ops, env) => applyRemoveHook(ops, env)],
  ]);

  return {
    id: 'claude',

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
          throw new Error(`ClaudeAdapter: unsupported op kind "${kind}"`);
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

    adopt(entry: AdapterEntry, scope: Scope, env: Env): Promise<AdoptionResult | undefined> {
      const handler = natureHandlers.get(entry.nature);
      if (handler === undefined) {
        return Promise.reject(new UnsupportedNatureError(entry.nature));
      }
      return handler.adopt(entry, scope, env);
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
          throw new Error(`ClaudeAdapter: unsupported removal op kind "${kind}"`);
        }
        await applyFn(kindOps, env, manifestFiles);
      }
    },
  };
}
