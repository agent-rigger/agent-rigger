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
import type { Nature, NatureReport, Scope, WriteOp } from '@agent-rigger/core/types';

import { applyContext, auditContext, planContext } from './context';
import { applyGuardrail, auditGuardrail, planGuardrail } from './guardrails';
import { applySkill, auditSkill, planSkill } from './skills';

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
}

type OpKindApply = (ops: WriteOp[], env: Env) => Promise<void>;

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

  // Nature → { audit, plan } — E2-E5 add entries here
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
      },
    ],
  ]);

  // WriteOp kind → apply fn — E2-E5 add entries here
  const opKindHandlers = new Map<WriteOp['kind'], OpKindApply>([
    ['merge-deny', (ops, env) => applyGuardrail(ops, env)],
    ['write-text', (ops, env) => applyContext(ops, env)],
    ['ensure-import', (ops, env) => applyContext(ops, env)],
    ['link', (ops, env) => applySkill(ops, env, scanner)],
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
  };
}
