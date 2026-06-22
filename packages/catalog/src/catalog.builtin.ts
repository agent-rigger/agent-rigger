import type { CatalogEntry } from './schema';

// ---------------------------------------------------------------------------
// Guardrails, contexts — shipped internally, apply at user and project scopes.
//
// NOTE: The harness plugin (agent-rigger-harness) has been removed from the
// catalog. Guard hooks are now delivered as individual hook:guard-* entries
// (see below) and installed directly via the hooks mechanism. Keeping the
// plugin would cause double-firing since its hooks.json registers the same
// guards a second time.
// ---------------------------------------------------------------------------

const GUARDRAILS_CLAUDE: CatalogEntry = {
  kind: 'artifact',
  id: 'guardrails-claude',
  nature: 'guardrail',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

const CONTEXT_CLAUDE: CatalogEntry = {
  kind: 'artifact',
  id: 'context-claude',
  nature: 'context',
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
  targets: ['claude'],
  scopes: ['user', 'project'],
};

const AGENT_PM: CatalogEntry = {
  kind: 'artifact',
  id: 'agent:pm',
  nature: 'agent',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

const AGENT_REVIEWER: CatalogEntry = {
  kind: 'artifact',
  id: 'agent:reviewer',
  nature: 'agent',
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
  targets: ['claude'],
  scopes: ['user', 'project'],
  members: ['skill:spec-workflow', 'agent:tech-lead', 'agent:pm', 'agent:reviewer'],
};

// ---------------------------------------------------------------------------
// Hook guards — built-in command/file/prompt safety guards
// ---------------------------------------------------------------------------

const HOOK_GUARD_COMMAND: CatalogEntry = {
  kind: 'artifact',
  id: 'hook:guard-command',
  nature: 'hook',
  targets: ['claude'],
  scopes: ['user', 'project'],
  event: 'PreToolUse',
  matcher: 'Bash',
  timeout: 5,
};

const HOOK_GUARD_SECRET: CatalogEntry = {
  kind: 'artifact',
  id: 'hook:guard-secret',
  nature: 'hook',
  targets: ['claude'],
  scopes: ['user', 'project'],
  event: 'PreToolUse',
  matcher: 'Read|Edit|MultiEdit|Write|NotebookEdit|Grep|Glob|Bash',
  timeout: 5,
};

const HOOK_GUARD_WRITE_SECRET: CatalogEntry = {
  kind: 'artifact',
  id: 'hook:guard-write-secret',
  nature: 'hook',
  targets: ['claude'],
  scopes: ['user', 'project'],
  event: 'PreToolUse',
  matcher: 'Write|Edit|MultiEdit',
  timeout: 5,
};

const HOOK_GUARD_PROMPT: CatalogEntry = {
  kind: 'artifact',
  id: 'hook:guard-prompt',
  nature: 'hook',
  targets: ['claude'],
  scopes: ['user', 'project'],
  event: 'UserPromptSubmit',
  matcher: '*',
  timeout: 5,
};

// ---------------------------------------------------------------------------
// Packs — harness bundle installs all 4 guards in one shot;
//         baseline bundle installs the full required team setup.
// ---------------------------------------------------------------------------

const PACK_HARNESS: CatalogEntry = {
  kind: 'pack',
  id: 'pack:harness',
  targets: ['claude'],
  scopes: ['user', 'project'],
  members: [
    'hook:guard-command',
    'hook:guard-secret',
    'hook:guard-write-secret',
    'hook:guard-prompt',
  ],
};

/**
 * Team baseline pack — installs the full required set in one shot:
 * the 4 hook guards (via pack:harness) + guardrails + context.
 * pack:harness is expanded recursively by the resolver.
 */
const PACK_BASELINE: CatalogEntry = {
  kind: 'pack',
  id: 'pack:baseline',
  targets: ['claude'],
  scopes: ['user', 'project'],
  members: ['pack:harness', 'guardrails-claude', 'context-claude'],
};

// ---------------------------------------------------------------------------
// Full built-in catalog
// ---------------------------------------------------------------------------

/** All entries shipped with agent-rigger at M0 milestone. */
export const BUILTIN_CATALOG: CatalogEntry[] = [
  GUARDRAILS_CLAUDE,
  CONTEXT_CLAUDE,
  SKILL_SPEC_WORKFLOW,
  AGENT_TECH_LEAD,
  AGENT_PM,
  AGENT_REVIEWER,
  TOOL_GLAB,
  PACK_SPEC_WORKFLOW,
  HOOK_GUARD_COMMAND,
  HOOK_GUARD_SECRET,
  HOOK_GUARD_WRITE_SECRET,
  HOOK_GUARD_PROMPT,
  PACK_HARNESS,
  PACK_BASELINE,
];
