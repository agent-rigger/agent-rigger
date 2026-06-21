/**
 * Public barrel for @agent-rigger/adapters.
 *
 * Exports ClaudeAdapter and associated types.
 * E2-E5 will add their handlers here as they are implemented.
 */

export { createClaudeAdapter, UnsupportedNatureError } from './claude/adapter';
export type { ClaudeAdapterConfig } from './claude/adapter';
export { agentName, auditAgent, planAgent } from './claude/agents';
export { applyContext, auditContext, loadCanonicalContext, planContext } from './claude/context';
export {
  applyGuardrail,
  auditGuardrail,
  loadCanonicalDeny,
  planGuardrail,
} from './claude/guardrails';
export {
  applyPlugin,
  auditPlugin,
  defaultPluginRunner,
  planPlugin,
  PluginInstallError,
  pluginName,
} from './claude/plugins';
export type { PluginRunner, PluginSource } from './claude/plugins';
export {
  applySkill,
  auditSkill,
  planSkill,
  skillName,
  SkillScanBlockedError,
} from './claude/skills';
