/**
 * Agents handler for the opencode adapter.
 *
 * Unlike Claude (which links the sub-agent `.md` opaquely, `claude/agents.ts`),
 * opencode requires a translated frontmatter schema (design.md §7.2): the source
 * `.md` is READ, its frontmatter TRANSLATED (description/model passthrough,
 * `mode: subagent` default, `tools` translated into a `permission` allow-list,
 * unknown fields omitted + warning), and the result WRITTEN — a `write-text`
 * op, not a `link`. `apply`/`applyRemove`
 * are therefore reused as-is from context.ts (`write-text`→applyContext,
 * `delete-file`→applyRemoveContext, already wired in adapter.ts) — no new op
 * kind, no new apply function needed here.
 *
 * Four functions:
 *   agentName                — derive + validate the agent name from entry.id
 *   translateAgentFrontmatter — pure: source frontmatter fields → opencode fields
 *   auditAgent                — read-only, returns NatureReport (missing/present/drift)
 *   planAgent / planRemoveAgent — read-only, returns WriteOp[] / RemovalOp[]
 *
 * Path conventions:
 *   target : ~/.config/opencode/agents/<name>.md   (scope:'user')
 *   target : <cwd>/.opencode/agents/<name>.md      (scope:'project')
 *
 * Invariants:
 * - auditAgent, planAgent and planRemoveAgent are read-only (no fs writes).
 * - planRemoveAgent only removes a target that is 'present' (exact match); a
 *   drifted target (locally edited) is left alone offline, same policy as context.ts.
 * - No while loops; no process.exit().
 */

import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { assertSafeArtifactName } from '@agent-rigger/core/artifact-name';
import { readText } from '@agent-rigger/core/fs-json';
import {
  resolveOpencodeProjectTargets,
  resolveOpencodeUserTargets,
} from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type {
  NatureReport,
  OpencodePermission,
  OpencodePermissionState,
  RemovalOp,
  Scope,
  WriteOp,
  WriteOpWriteText,
} from '@agent-rigger/core/types';

import { parseFrontmatter, serializeFrontmatter } from './frontmatter';

// ---------------------------------------------------------------------------
// agentName
// ---------------------------------------------------------------------------

/**
 * Derive the agent name from the entry id and assert it is safe for filesystem use.
 *
 * 'agent:reviewer' → 'reviewer'
 * 'my-agent'       → 'my-agent'
 *
 * Throws UnsafeArtifactNameError when the derived name contains path traversal
 * segments, dots-only names ('.', '..'), or characters outside [a-zA-Z0-9._-].
 */
export function agentName(entry: AdapterEntry): string {
  const prefix = 'agent:';
  // Strip source qualifier if present (ADR-0017: ids may be 'principal/agent:foo')
  const localPart = entry.id.includes('/') ? entry.id.slice(entry.id.indexOf('/') + 1) : entry.id;
  const name = localPart.startsWith(prefix) ? localPart.slice(prefix.length) : localPart;
  assertSafeArtifactName(name, entry.id);
  return name;
}

// ---------------------------------------------------------------------------
// translateAgentFrontmatter (pure)
// ---------------------------------------------------------------------------

/** Result of translating a Claude sub-agent's frontmatter fields to opencode's schema. */
export interface AgentFrontmatterTranslation {
  /** Translated opencode frontmatter fields. */
  frontmatter: Record<string, unknown>;
  /** Human-readable, actionable warnings — one per omitted/ambiguous field (R6.3). */
  warnings: string[];
}

/**
 * Source frontmatter fields this translation understands (whether translated or
 * dropped). `tools` is handled (translated into `permission`, see
 * `translateToolsToPermission` below); a bare `permission` field on the source
 * is only added dynamically (see the collision check in `translateAgentFrontmatter`)
 * when `tools` is also present — otherwise it falls through to the generic
 * unhandled-field path below.
 */
const HANDLED_FIELDS = new Set(['name', 'description', 'model', 'tools']);

/**
 * Claude tool name (case-insensitive) → opencode permission category.
 *
 * opencode has no separate "write" category: `write`, `edit` and `apply_patch`
 * are all gated by the single `edit` permission — see the fusion warning
 * emitted by `translateToolsToPermission` when the source whitelist didn't
 * already grant both `Write` and `Edit`.
 */
const TOOL_TO_PERMISSION: Readonly<Record<string, string>> = {
  read: 'read',
  grep: 'grep',
  glob: 'glob',
  bash: 'bash',
  edit: 'edit',
  write: 'edit',
  notebookedit: 'edit',
  webfetch: 'webfetch',
  websearch: 'websearch',
  task: 'task',
  agent: 'task',
  todowrite: 'todowrite',
  skill: 'skill',
};

/** Parse a Claude `tools` field (comma-separated string, or array) into a name list. */
function parseToolNames(tools: unknown): string[] | undefined {
  const raw = typeof tools === 'string'
    ? tools.split(',')
    : Array.isArray(tools)
    ? tools
    : undefined;
  if (raw === undefined) {
    return undefined;
  }
  const names = raw
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim())
    .filter((t) => t !== '');
  return names.length > 0 ? names : undefined;
}

/**
 * Translate a Claude `tools` availability whitelist into an opencode `permission`
 * allow-list: `"*": "deny"` first (fail-safe default — required to come first in
 * insertion order, opencode resolves rules with `findLast` over key order), then
 * one `<category>: "allow"` per successfully mapped tool, deduplicated, in
 * source order.
 *
 * - An unmappable name (incl. `mcp__*` tools) is NOT allow-listed — it stays
 *   denied by `"*"` (fail-safe) — and produces a warning naming it.
 * - When any listed tool maps to opencode's fused `edit` category and the
 *   source did not list both `Write` and `Edit`, a warning flags that granting
 *   `edit` is broader than the source whitelist (it also covers apply_patch).
 */
function translateToolsToPermission(
  toolNames: string[],
): { permission: OpencodePermission; warnings: string[] } {
  const warnings: string[] = [];
  const permission: OpencodePermission = { '*': 'deny' };
  const mappedSeen = new Set<string>();
  let grantsEdit = false;

  for (const name of toolNames) {
    const category = TOOL_TO_PERMISSION[name.toLowerCase()];
    if (category === undefined) {
      warnings.push(
        `Tool "${name}" has no opencode permission equivalent; it was omitted from the `
          + `allow-list (denied by default via "*": deny).`,
      );
      continue;
    }
    if (category === 'edit') {
      grantsEdit = true;
    }
    if (!mappedSeen.has(category)) {
      mappedSeen.add(category);
      permission[category] = 'allow' satisfies OpencodePermissionState;
    }
  }

  if (grantsEdit) {
    const lowerNames = new Set(toolNames.map((n) => n.toLowerCase()));
    if (!(lowerNames.has('write') && lowerNames.has('edit'))) {
      warnings.push(
        'opencode has a single "edit" permission category covering write/edit/apply_patch; '
          + 'granting it here is broader than the source "tools" whitelist.',
      );
    }
  }

  return { permission, warnings };
}

/**
 * Translate a Claude sub-agent's frontmatter fields into opencode's schema (§7.2):
 * - `description` → passed through unchanged.
 * - `name`        → silently dropped (opencode's id is the filename, not a field).
 * - `tools`       → translated into a `permission` allow-list via
 *                   `translateToolsToPermission` (denies everything else by default).
 *                   Absent/empty `tools` → no `permission` key emitted.
 * - `model`       → passed through unchanged; a warning is emitted when the value is not
 *                   already in opencode's "provider/model" form (ambiguous, not fatal).
 * - `mode`        → always set to `'subagent'` (distributed artifacts are sub-agents).
 * - `permission`  → only meaningful when `tools` is also present (unusual, but the source
 *                   may carry both): the tools-derived permission wins and a warning
 *                   reports the collision. A bare `permission` with no `tools` falls
 *                   through to the generic unhandled-field path below.
 * - any other field (e.g. `effort`, Claude-specific) → omitted, warning emitted (R6.3).
 *
 * Pure, total: never throws.
 */
export function translateAgentFrontmatter(
  source: Record<string, unknown>,
): AgentFrontmatterTranslation {
  const warnings: string[] = [];
  const frontmatter: Record<string, unknown> = {};
  const extraHandled = new Set<string>();

  if (typeof source['description'] === 'string') {
    frontmatter['description'] = source['description'];
  }

  frontmatter['mode'] = 'subagent';

  const model = source['model'];
  if (typeof model === 'string' && model !== '') {
    if (!model.includes('/')) {
      warnings.push(
        `Model "${model}" is not in opencode's "provider/model" form; passed through unchanged.`,
      );
    }
    frontmatter['model'] = model;
  }

  const toolNames = parseToolNames(source['tools']);
  if (toolNames !== undefined) {
    const { permission, warnings: toolWarnings } = translateToolsToPermission(toolNames);
    frontmatter['permission'] = permission;
    warnings.push(...toolWarnings);

    if (source['permission'] !== undefined) {
      extraHandled.add('permission');
      warnings.push(
        'Source frontmatter has both "tools" and an explicit "permission" field; the '
          + 'tools-derived permission takes precedence and the explicit "permission" field '
          + 'was ignored.',
      );
    }
  }

  for (const key of Object.keys(source)) {
    if (HANDLED_FIELDS.has(key) || extraHandled.has(key)) {
      continue;
    }
    warnings.push(`Field "${key}" has no opencode equivalent and was omitted.`);
  }

  return { frontmatter, warnings };
}

// ---------------------------------------------------------------------------
// Path resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the target path where the translated agent `.md` will be written.
 *
 * - user scope:    ~/.config/opencode/agents/<name>.md
 * - project scope: <cwd>/.opencode/agents/<name>.md
 */
function resolveTargetPath(name: string, scope: Scope, env: Env, cwd?: string): string {
  if (scope === 'project') {
    return path.join(resolveOpencodeProjectTargets(cwd).agentsDir, `${name}.md`);
  }
  return path.join(resolveOpencodeUserTargets(env).agentsDir, `${name}.md`);
}

// ---------------------------------------------------------------------------
// Internal: read + translate the source .md
// ---------------------------------------------------------------------------

/** Read the source `.md` and produce the fully translated, ready-to-write content. */
async function computeTranslation(
  entry: AdapterEntry,
  agentSource: (entry: AdapterEntry) => string,
): Promise<{ content: string; warnings: string[] }> {
  const sourcePath = agentSource(entry);
  const raw = await readText(sourcePath);
  const { data, body } = parseFrontmatter(raw);
  const { frontmatter, warnings } = translateAgentFrontmatter(data);
  return { content: serializeFrontmatter(frontmatter, body), warnings };
}

// ---------------------------------------------------------------------------
// auditAgent
// ---------------------------------------------------------------------------

/**
 * Audit the current state of a translated sub-agent artifact on disk.
 *
 * Returns:
 * - 'missing' if the target `.md` does not exist.
 * - 'present' if it exists and its content matches the effective canonical content.
 * - 'drift'   if it exists but diverges.
 *
 * The effective canonical content is `entry.applied.block` when available (offline
 * check/remove, no source re-read needed); otherwise it is recomputed fresh from
 * `agentSource(entry)` — only invoked in that fallback branch, so a missing/absent
 * `agentSource` never breaks a plain "not installed" audit.
 *
 * Read-only: no filesystem writes.
 */
export async function auditAgent(
  entry: AdapterEntry,
  scope: Scope,
  env: Env,
  agentSource: (entry: AdapterEntry) => string,
  cwd?: string,
): Promise<NatureReport> {
  const name = agentName(entry);
  const targetPath = resolveTargetPath(name, scope, env, cwd);
  const current = await readText(targetPath);

  if (current === '') {
    return { id: entry.id, nature: 'agent', state: 'missing' };
  }

  const effective = entry.applied?.kind === 'context'
    ? entry.applied.block
    : (await computeTranslation(entry, agentSource)).content;

  return {
    id: entry.id,
    nature: 'agent',
    state: current === effective ? 'present' : 'drift',
  };
}

// ---------------------------------------------------------------------------
// planAgent
// ---------------------------------------------------------------------------

/**
 * Compute the write operations needed to install a translated sub-agent.
 *
 * Always re-reads and re-translates the source (installs must reflect the latest
 * catalog content, unlike audit's applied-fallback). Returns [] when the target
 * already holds the exact translated content (idempotent).
 *
 * Read-only: no filesystem writes. The op produced is a plain `write-text` —
 * reused verbatim by the existing `write-text`→applyContext opKindHandler.
 *
 * @param entry        Artifact entry (id carries the agent name).
 * @param scope        Installation scope.
 * @param env          Injectable env for HOME resolution.
 * @param agentSource  Resolver: entry → absolute path to the Claude-style source `.md`.
 * @param cwd          Working directory (only used when scope is 'project').
 */
export async function planAgent(
  entry: AdapterEntry,
  scope: Scope,
  env: Env,
  agentSource: (entry: AdapterEntry) => string,
  cwd?: string,
): Promise<WriteOp[]> {
  const name = agentName(entry);
  const targetPath = resolveTargetPath(name, scope, env, cwd);
  const { content, warnings } = await computeTranslation(entry, agentSource);

  const current = await readText(targetPath);
  if (current === content) {
    return [];
  }

  const op: WriteOpWriteText = {
    kind: 'write-text',
    path: targetPath,
    content,
    description: `Translate and write opencode sub-agent "${name}"`,
  };
  // Surface frontmatter-translation warnings on the op (R6.3 / HIGH-2) so the CLI
  // renders them before confirm. Only set the key when non-empty (exactOptional).
  if (warnings.length > 0) {
    op.warnings = warnings;
  }
  return [op];
}

// ---------------------------------------------------------------------------
// planRemoveAgent
// ---------------------------------------------------------------------------

/**
 * Compute the removal operations needed to uninstall a translated sub-agent.
 *
 * Returns [{ kind: 'delete-file', path }] only when the target is exactly
 * 'present' (matches the effective canonical translation). Returns [] when
 * missing, and also when drifted — a locally edited file is left alone offline,
 * the same policy as opencode/context.ts's planRemoveContext.
 *
 * Read-only: no filesystem writes.
 */
export async function planRemoveAgent(
  entry: AdapterEntry,
  scope: Scope,
  env: Env,
  agentSource: (entry: AdapterEntry) => string,
  cwd?: string,
): Promise<RemovalOp[]> {
  const report = await auditAgent(entry, scope, env, agentSource, cwd);
  if (report.state !== 'present') {
    return [];
  }

  const name = agentName(entry);
  const targetPath = resolveTargetPath(name, scope, env, cwd);
  return [{ kind: 'delete-file', path: targetPath }];
}
