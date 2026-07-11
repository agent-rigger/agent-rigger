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
  EmptyDenyArtifactError,
  loadCanonicalAllow,
  loadCanonicalDeny,
  planGuardrail,
} from './claude/guardrails';
export { applyHook, auditHook, planHook } from './claude/hooks';
export type { ResolvedHook } from './claude/hooks';
export {
  adoptMcp as adoptClaudeMcp,
  applyMcp as applyClaudeMcp,
  applyRemoveMcp as applyRemoveClaudeMcp,
  auditMcp as auditClaudeMcp,
  defaultMcpRunner,
  McpAddError,
  McpRemoveError,
  mcpServerName as claudeMcpServerName,
  planMcp as planClaudeMcp,
  planRemoveMcp as planRemoveClaudeMcp,
} from './claude/mcp';
export type { McpRunner } from './claude/mcp';
export {
  applyPlugin,
  auditPlugin,
  defaultPluginRunner,
  planPlugin,
  PluginInstallError,
  pluginLedgerKey,
  pluginName,
  readInstalledPlugins,
  resolvePluginPaths,
} from './claude/plugins';
export type {
  PluginPaths,
  PluginRunner,
  PluginSource,
  ReadInstalledPluginsResult,
} from './claude/plugins';
export {
  applySkill,
  auditSkill,
  planSkill,
  skillName,
  SkillScanBlockedError,
} from './claude/skills';
export {
  createOpencodeAdapter,
  UnsupportedNatureError as OpencodeUnsupportedNatureError,
} from './opencode/adapter';
export type { OpencodeAdapterConfig } from './opencode/adapter';
export {
  agentName as opencodeAgentName,
  auditAgent as auditOpencodeAgent,
  planAgent as planOpencodeAgent,
  translateAgentFrontmatter,
} from './opencode/agents';
export type { AgentFrontmatterTranslation } from './opencode/agents';
export {
  applyContext as applyOpencodeContext,
  auditContext as auditOpencodeContext,
  planContext as planOpencodeContext,
} from './opencode/context';
export { parseFrontmatter, serializeFrontmatter } from './opencode/frontmatter';
export type { ParsedFrontmatter } from './opencode/frontmatter';
export {
  applyGuardrail as applyOpencodeGuardrail,
  auditGuardrail as auditOpencodeGuardrail,
  loadCanonicalOpencodePermission,
  MissingOpencodePermissionError,
  planGuardrail as planOpencodeGuardrail,
} from './opencode/guardrails';
export {
  applyMcp as applyOpencodeMcp,
  applyRemoveMcp as applyRemoveOpencodeMcp,
  auditMcp as auditOpencodeMcp,
  planMcp as planOpencodeMcp,
  planRemoveMcp as planRemoveOpencodeMcp,
} from './opencode/mcp';
export {
  applyOpencodeKey,
  InvalidOpencodeJsonError,
  readOpencodeJson,
} from './opencode/opencode-json-io';
export {
  auditPlugin as auditOpencodePlugin,
  planPlugin as planOpencodePlugin,
  planRemovePlugin as planRemoveOpencodePlugin,
  pluginName as opencodePluginName,
} from './opencode/plugins';
export {
  applySkill as applyOpencodeSkill,
  auditSkill as auditOpencodeSkill,
  planSkill as planOpencodeSkill,
  skillName as opencodeSkillName,
  SkillScanBlockedError as OpencodeSkillScanBlockedError,
} from './opencode/skills';
export { isStoreReferenced, storeReferenceCandidates } from './shared/store-refs';
