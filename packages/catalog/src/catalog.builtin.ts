import type { CatalogEntry } from './schema';

// ---------------------------------------------------------------------------
// Guardrails, contexts, and plugins — shipped internally, apply at user and
// project scopes for Claude.
// ---------------------------------------------------------------------------

const GUARDRAILS_CLAUDE: CatalogEntry = {
  kind: 'artifact',
  id: 'guardrails-claude',
  nature: 'guardrail',
  source: 'internal',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

const CONTEXT_CLAUDE: CatalogEntry = {
  kind: 'artifact',
  id: 'context-claude',
  nature: 'context',
  source: 'internal',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

const HARNESS_PLUGIN: CatalogEntry = {
  kind: 'artifact',
  id: 'harness-plugin',
  nature: 'plugin',
  source: 'internal',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

// ---------------------------------------------------------------------------
// External tools — must be present on the host system; detection via check.
// ---------------------------------------------------------------------------

/** GitLab CLI — detected with command -v, installed via brew or mise. */
const TOOL_GLAB: CatalogEntry = {
  kind: 'artifact',
  id: 'tool:glab',
  nature: 'tool',
  source: 'external',
  targets: ['claude'],
  scopes: ['user'],
  level: 'required',
  check: 'command -v glab',
  install: {
    brew: 'glab',
    mise: 'glab',
  },
};

// ---------------------------------------------------------------------------
// Skills — workflow scripts invoked by the harness; spec-workflow depends on
// the glab CLI being available on the host.
// ---------------------------------------------------------------------------

const SKILL_SPEC_WORKFLOW: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:spec-workflow',
  nature: 'skill',
  source: 'internal',
  targets: ['claude'],
  scopes: ['user', 'project'],
  requires: ['tool:glab'],
};

// ---------------------------------------------------------------------------
// Agents — role-specialised sub-agents; each covers a distinct
// responsibility in the spec-workflow loop.
// ---------------------------------------------------------------------------

const AGENT_TECH_LEAD: CatalogEntry = {
  kind: 'artifact',
  id: 'agent:tech-lead',
  nature: 'agent',
  source: 'internal',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

const AGENT_PM: CatalogEntry = {
  kind: 'artifact',
  id: 'agent:pm',
  nature: 'agent',
  source: 'internal',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

const AGENT_REVIEWER: CatalogEntry = {
  kind: 'artifact',
  id: 'agent:reviewer',
  nature: 'agent',
  source: 'internal',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

// ---------------------------------------------------------------------------
// Packs — curated bundles that install multiple entries in one shot.
// Installing pack:spec-workflow installs the skill plus the three agents
// that drive the spec-to-implementation loop.
// ---------------------------------------------------------------------------

const PACK_SPEC_WORKFLOW: CatalogEntry = {
  kind: 'pack',
  id: 'pack:spec-workflow',
  source: 'internal',
  targets: ['claude'],
  scopes: ['user', 'project'],
  members: ['skill:spec-workflow', 'agent:tech-lead', 'agent:pm', 'agent:reviewer'],
};

// ---------------------------------------------------------------------------
// Full built-in catalog
// ---------------------------------------------------------------------------

/** All entries shipped with agent-rigger at M0 milestone. */
export const BUILTIN_CATALOG: CatalogEntry[] = [
  GUARDRAILS_CLAUDE,
  CONTEXT_CLAUDE,
  HARNESS_PLUGIN,
  SKILL_SPEC_WORKFLOW,
  AGENT_TECH_LEAD,
  AGENT_PM,
  AGENT_REVIEWER,
  TOOL_GLAB,
  PACK_SPEC_WORKFLOW,
];
