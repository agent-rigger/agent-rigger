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

import type { Adapter, AdapterEntry } from '@agent-rigger/core/adapter';
import type { Env } from '@agent-rigger/core/paths';
import type { Scanner } from '@agent-rigger/core/scan';
import { stubScanner } from '@agent-rigger/core/scan';
import type { Nature, NatureReport, RemovalOp, Scope, WriteOp } from '@agent-rigger/core/types';

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
import { applyHook, applyRemoveHook, auditHook, planHook, planRemoveHook } from './hooks';
import type { ResolvedHook } from './hooks';
import {
  applyPlugin,
  applyRemovePlugin,
  auditPlugin,
  defaultPluginRunner,
  planPlugin,
  planRemovePlugin,
  PluginUninstallError,
} from './plugins';
import type { PluginRunner, PluginSource } from './plugins';
import { applyRemoveSkill, applySkill, auditSkill, planRemoveSkill, planSkill } from './skills';

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
}

type OpKindApply = (ops: WriteOp[], env: Env) => Promise<void>;
type RemovalOpKindApply = (ops: RemovalOp[], env: Env) => Promise<void>;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ClaudeAdapterConfig {
  /** Canonical deny rules loaded from artifacts/claude/deny.json. */
  denyRef: string[];
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

  // Nature → { audit, plan, planRemove } — E2-E5 add entries here
  const natureHandlers = new Map<Nature, NatureHandler>([
    [
      'guardrail',
      {
        audit(entry, scope, env): Promise<NatureReport> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          return auditGuardrail(scope, env, config.denyRef, cwd);
        },
        plan(entry, scope, env): Promise<WriteOp[]> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          return planGuardrail(scope, env, config.denyRef, cwd);
        },
        planRemove(entry, scope, env): Promise<RemovalOp[]> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          return planRemoveGuardrail(scope, env, config.denyRef, cwd);
        },
      },
    ],
    [
      'context',
      {
        audit(entry, scope, env): Promise<NatureReport> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          return auditContext(scope, env, agentsContent, cwd);
        },
        plan(entry, scope, env): Promise<WriteOp[]> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          return planContext(scope, env, agentsContent, cwd);
        },
        planRemove(entry, scope, env): Promise<RemovalOp[]> {
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          return planRemoveContext(scope, env, agentsContent, cwd);
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
      'plugin',
      {
        audit(entry, _scope, env): Promise<NatureReport> {
          return auditPlugin(entry, env, { run: pluginRunner });
        },
        plan(entry, _scope, _env): Promise<WriteOp[]> {
          return planPlugin(entry, () => resolvePluginSource(entry), { run: pluginRunner });
        },
        planRemove(entry, _scope, _env): Promise<RemovalOp[]> {
          return planRemovePlugin(entry, { run: pluginRunner });
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
      },
    ],
    [
      'hook',
      {
        audit(entry, scope, env): Promise<NatureReport> {
          let spec: ResolvedHook;
          try {
            spec = resolveHookSpec(entry);
          } catch (err) {
            return Promise.reject(err);
          }
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
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
          let spec: ResolvedHook;
          try {
            spec = resolveHookSpec(entry);
          } catch (err) {
            return Promise.reject(err);
          }
          const cwd = entry.scope === 'project' ? process.cwd() : undefined;
          return planRemoveHook(entry, scope, env, spec, cwd);
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
    ['write-text', (ops, env) => applyContext(ops, env)],
    ['ensure-import', (ops, env) => applyContext(ops, env)],
    ['link', (ops, env) => applySkill(ops, env, scanner)],
    ['plugin-install', (ops, env) => applyPlugin(ops, env, pluginApplyOpts)],
    ['merge-hooks', (ops, env) => applyHook(ops, env)],
  ]);

  // RemovalOp kind → applyRemove fn — mirrors the install dispatch pattern
  const removalOpKindHandlers = new Map<RemovalOp['kind'], RemovalOpKindApply>([
    ['remove-deny', (ops, env) => applyRemoveGuardrail(ops, env)],
    ['delete-file', (ops, env) => applyRemoveContext(ops, env)],
    ['remove-block', (ops, env) => applyRemoveContext(ops, env)],
    ['unlink', (ops, env) => applyRemoveSkill(ops, env)],
    ['plugin-uninstall', (ops, env) => applyRemovePlugin(ops, env, { run: pluginRunner })],
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

    async applyRemove(ops: RemovalOp[], env: Env): Promise<void> {
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
        await applyFn(kindOps, env);
      }
    },
  };
}
