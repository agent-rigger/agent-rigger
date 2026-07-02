/**
 * Domain types for agent-rigger.
 *
 * Keep this file types-only — no logic, no imports from node:* or bun.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** 8 natures of installable artefacts. */
export type Nature =
  | 'plugin'
  | 'guardrail'
  | 'context'
  | 'skill'
  | 'agent'
  | 'mcp'
  | 'tool'
  | 'hook';

/** Installation scope: user-level (~/) or project-level (cwd). */
export type Scope = 'user' | 'project';

/** Target assistant for an installed artefact. */
export type Assistant = 'claude' | 'opencode';

// ---------------------------------------------------------------------------
// opencode value types (types-only — shared engine↔adapter vocabulary)
// ---------------------------------------------------------------------------

/** A single opencode permission decision. */
export type OpencodePermissionState = 'allow' | 'ask' | 'deny';

/**
 * The opencode `permission` object (subset agent-rigger manages).
 * A tool key maps either to a flat state (`edit: "ask"`) or to a nested
 * pattern→state map (`bash: { "rm -rf *": "deny" }`).
 */
export interface OpencodePermission {
  [tool: string]: OpencodePermissionState | Record<string, OpencodePermissionState>;
}

/** A local (spawned) MCP server declared in opencode.json. */
export interface OpencodeMcpLocal {
  type: 'local';
  command: string[];
  environment?: Record<string, string>;
  enabled?: boolean;
  cwd?: string;
  timeout?: number;
}

/** A remote (HTTP) MCP server declared in opencode.json. */
export interface OpencodeMcpRemote {
  type: 'remote';
  url: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  timeout?: number;
}

/** Discriminated union of MCP server declarations. */
export type OpencodeMcpServer = OpencodeMcpLocal | OpencodeMcpRemote;

// ---------------------------------------------------------------------------
// Artefact
// ---------------------------------------------------------------------------

/**
 * Minimal installable unit.
 * Enriched by CatalogEntry (packages/catalog) — kept lean here (YAGNI).
 */
export interface Artifact {
  id: string;
  nature: Nature;
}

// ---------------------------------------------------------------------------
// AppliedPayload — the mutations actually applied during install
// ---------------------------------------------------------------------------

/**
 * Payload recorded when a guardrail is installed.
 * Captures the exact deny + allow rules that were merged into settings.json.
 */
export interface AppliedGuardrail {
  kind: 'guardrail';
  /** Deny rules that were added (the full canonical set, not just the delta). */
  denyRules: string[];
  /** Allow rules that were added (the full canonical set). */
  allowRules: string[];
}

/**
 * Payload recorded when a context artifact is installed.
 * Captures the AGENTS.md content that was written.
 */
export interface AppliedContext {
  kind: 'context';
  /** Full UTF-8 content of the AGENTS.md file that was written. */
  block: string;
}

/**
 * Payload recorded when a hook is installed.
 * Captures the exact event/matcher/command registered in settings.json.
 */
export interface AppliedHook {
  kind: 'hook';
  event: string;
  matcher: string;
  command: string;
  timeout?: number;
}

/**
 * Payload recorded when a skill or agent is installed via a link op.
 * The `files` field mirrors ManifestEntry.files for link-type artifacts.
 */
export interface AppliedLink {
  kind: 'link';
  /** Absolute paths of files/dirs written (target + store). */
  files: string[];
}

/**
 * Payload recorded when an opencode guardrail is installed.
 * Captures the exact permission fragment merged into opencode.json so `remove`
 * can subtract precisely what was added (ADR-0016), offline.
 */
export interface AppliedOpencodePermission {
  kind: 'opencode-permission';
  /** The permission fragment (tool→state / bash patterns) that was merged. */
  permission: OpencodePermission;
}

/**
 * Payload recorded when an opencode MCP server is installed.
 * Captures the server id + merged config (secrets are env-refs, never literals — ADR-0019).
 */
export interface AppliedOpencodeMcp {
  kind: 'opencode-mcp';
  /** The MCP server id (key under the `mcp` object). */
  server: string;
  /** The server config that was merged. */
  config: OpencodeMcpServer;
}

/**
 * Discriminated union of per-nature applied payloads.
 *
 * Present on ManifestEntry.applied after B-iii.
 * Absent on legacy entries installed before B-iii → remove/check degrade gracefully.
 */
export type AppliedPayload =
  | AppliedGuardrail
  | AppliedContext
  | AppliedHook
  | AppliedLink
  | AppliedOpencodePermission
  | AppliedOpencodeMcp;

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * One record in the local manifest (~/.config/agent-rigger/state.json).
 * Tracks what is installed, where it came from, and what it wrote to disk.
 *
 * - ref: semver tag (human version).
 * - sha: resolved commit sha (reproducibility + drift detection).
 * - installedAt: ISO-8601 timestamp string.
 * - files: absolute paths of files written or managed.
 * - applied: structured payload of the mutations applied at install time.
 *   Optional for backward compatibility with manifests written before B-iii.
 */
export interface ManifestEntry {
  id: string;
  nature: Nature;
  ref: string;
  sha: string;
  scope: Scope;
  installedAt: string;
  files: string[];
  /** Structured payload of the mutations applied at install time. Added in B-iii. */
  applied?: AppliedPayload;
  /**
   * Target assistant this entry was installed for (M3).
   * Optional for backward-compat: absent on legacy entries → treated as 'claude'.
   */
  assistant?: Assistant;
}

/**
 * Root of ~/.config/agent-rigger/state.json.
 * version tracks the manifest schema (bump when breaking changes).
 */
export interface Manifest {
  version: number;
  artifacts: ManifestEntry[];
}

// ---------------------------------------------------------------------------
// WriteOp — planned filesystem operations (for dry-run diff display)
// ---------------------------------------------------------------------------

/**
 * Discriminated union of write operations produced by an Adapter.plan() call.
 *
 * NOTE: this union is intentionally minimal for M0. New kinds will be added as
 * adapters (guardrails, managed-import, skills, agents) are implemented in
 * tasks B3-B6. Do not extend speculatively.
 */

/** Overwrite (or create) a JSON file, keeping unrelated keys intact. */
export interface WriteOpWriteJson {
  kind: 'write-json';
  path: string;
  /** Human-readable summary of what changes (e.g. keys added). */
  description: string;
}

/** Overwrite (or create) a plain-text file. */
export interface WriteOpWriteText {
  kind: 'write-text';
  path: string;
  /** UTF-8 content to write verbatim to the file. */
  content: string;
  description: string;
}

/**
 * Merge entries into permissions.deny (settings.json).
 * Only the deny array is touched; all other keys are preserved.
 */
export interface WriteOpMergeDeny {
  kind: 'merge-deny';
  path: string;
  /** Deny rules that will be appended (after dedup). */
  toAdd: string[];
}

/**
 * Merge entries into permissions.allow (settings.json).
 * Only the allow array is touched; all other keys are preserved.
 */
export interface WriteOpMergeAllow {
  kind: 'merge-allow';
  path: string;
  /** Allow rules that will be appended (after dedup). */
  toAdd: string[];
}

/**
 * Ensure a managed import block exists in a Markdown file (CLAUDE.md bridge).
 * Idempotent: existing blocks are replaced in-place; no duplicate is added.
 */
export interface WriteOpEnsureImport {
  kind: 'ensure-import';
  path: string;
  /** The @import line to embed inside the managed block. */
  importLine: string;
}

/**
 * Install a skill via the managed store + symlink (linker).
 * source → store (physical copy); target → store (symlink or copy fallback).
 * No in-file mutations: the operation is atomic at the directory level.
 */
export interface WriteOpLink {
  kind: 'link';
  source: string;
  store: string;
  target: string;
}

/**
 * Install a plugin by delegating to the native CLI mechanism.
 * No file is written directly: the adapter runs `claude plugin marketplace add`
 * then `claude plugin install`, and remounts any native error as-is.
 * Neither `path` nor `target` are present — the engine skips backup and written
 * path tracking for this kind.
 */
export interface WriteOpPluginInstall {
  kind: 'plugin-install';
  /** Plugin identifier as expected by `claude plugin install`. */
  plugin: string;
  /** Path or URL of the marketplace manifest to register. */
  marketplace: string;
}

/**
 * Merge a hook entry into settings.json under hooks.<event>.
 * Only the hooks section is touched; all other keys (e.g. permissions.deny) are preserved.
 * Idempotent: re-applying with the same (event, matcher, command) is a no-op.
 */
export interface WriteOpMergeHooks {
  kind: 'merge-hooks';
  /** Absolute path to settings.json. */
  path: string;
  /** Claude Code hook event (e.g. "PreToolUse", "UserPromptSubmit"). */
  event: string;
  /** Matcher string (e.g. "Bash", "*"). */
  matcher: string;
  /** Shell command to register as a hook. */
  command: string;
  /** Optional timeout in seconds for the hook command. */
  timeout?: number;
  /**
   * Source directory to copy scripts from (e.g. hooks/ sub-dir from the catalog checkout).
   * Absent when script deposit is not needed.
   */
  scriptSource?: string;
  /**
   * Destination directory in the store for the scripts
   * (e.g. ~/.config/agent-rigger/hooks). Absent when script deposit is not needed.
   */
  scriptStore?: string;
}

/**
 * Merge a permission fragment into the `permission` key of opencode.json.
 * Only the permission key is touched; all other keys (mcp, agent, instructions,
 * user config) are preserved. Idempotent: re-merging the same fragment is a no-op.
 */
export interface WriteOpMergePermission {
  kind: 'merge-permission';
  /** Absolute path to opencode.json. */
  path: string;
  /** Permission fragment to merge (already translated from the canonical guardrail). */
  permission: OpencodePermission;
  description: string;
}

/**
 * Merge an MCP server declaration into the `mcp` key of opencode.json.
 * Only the mcp key is touched; other keys are preserved. Idempotent.
 */
export interface WriteOpMergeMcp {
  kind: 'merge-mcp';
  /** Absolute path to opencode.json. */
  path: string;
  /** MCP server id (key under `mcp`). */
  server: string;
  /** Server config to write. */
  config: OpencodeMcpServer;
  description: string;
}

export type WriteOp =
  | WriteOpWriteJson
  | WriteOpWriteText
  | WriteOpMergeDeny
  | WriteOpMergeAllow
  | WriteOpEnsureImport
  | WriteOpLink
  | WriteOpPluginInstall
  | WriteOpMergeHooks
  | WriteOpMergePermission
  | WriteOpMergeMcp;

// ---------------------------------------------------------------------------
// RemovalOp — planned removal operations (for diff display and apply)
// ---------------------------------------------------------------------------

/**
 * Remove deny rules managed by agent-rigger from settings.json.
 * Only the rules listed in `rules` are removed; other deny entries are kept.
 */
export interface RemovalOpRemoveDeny {
  kind: 'remove-deny';
  /** Absolute path to settings.json. */
  path: string;
  /** The managed rules to remove (those originally added by agent-rigger). */
  rules: string[];
}

/**
 * Remove allow rules managed by agent-rigger from settings.json.
 * Only the rules listed in `rules` are removed; other allow entries are kept.
 */
export interface RemovalOpRemoveAllow {
  kind: 'remove-allow';
  /** Absolute path to settings.json. */
  path: string;
  /** The managed allow rules to remove. */
  rules: string[];
}

/**
 * Remove the managed import block from a Markdown file (e.g. CLAUDE.md).
 * User content outside the block is preserved intact.
 */
export interface RemovalOpRemoveBlock {
  kind: 'remove-block';
  /** Absolute path to the Markdown file. */
  path: string;
}

/**
 * Delete a managed file (e.g. AGENTS.md) that was written directly by an adapter.
 */
export interface RemovalOpDeleteFile {
  kind: 'delete-file';
  /** Absolute path to the file to delete. */
  path: string;
}

/**
 * Remove a linked artifact: delete both the symlink (or copy) at `target`
 * and the physical store entry at `store`.
 */
export interface RemovalOpUnlink {
  kind: 'unlink';
  /** Path to the symlink or installed file/directory (e.g. ~/.claude/skills/my-skill). */
  target: string;
  /** Path to the managed store entry (e.g. ~/.config/agent-rigger/skills/my-skill). */
  store: string;
}

/**
 * Uninstall a plugin via the native CLI mechanism.
 * No direct file removal; the adapter delegates to `claude plugin uninstall`.
 * This op carries no `path` or `target` — the engine skips backup for it.
 */
export interface RemovalOpPluginUninstall {
  kind: 'plugin-uninstall';
  /** Plugin identifier as expected by `claude plugin uninstall`. */
  plugin: string;
}

/**
 * Remove a hook command from settings.json under hooks.<event>.
 * Cleans up empty matchers, events, and the hooks key itself if they become empty.
 * No-op if the specified hook is absent.
 */
export interface RemovalOpRemoveHooks {
  kind: 'remove-hooks';
  /** Absolute path to settings.json. */
  path: string;
  /** Claude Code hook event (e.g. "PreToolUse", "UserPromptSubmit"). */
  event: string;
  /** Matcher string (e.g. "Bash", "*"). */
  matcher: string;
  /** Shell command to remove. */
  command: string;
}

/**
 * Remove a managed permission fragment from opencode.json.
 * Only the exact keys/patterns in `permission` are removed; other permission
 * entries (and other opencode.json keys) are preserved. No-op if absent.
 */
export interface RemovalOpRemovePermission {
  kind: 'remove-permission';
  /** Absolute path to opencode.json. */
  path: string;
  /** The managed permission fragment to remove (from the applied payload). */
  permission: OpencodePermission;
}

/**
 * Remove a managed MCP server from opencode.json.
 * Only the named server is removed; other servers and keys are preserved. No-op if absent.
 */
export interface RemovalOpRemoveMcp {
  kind: 'remove-mcp';
  /** Absolute path to opencode.json. */
  path: string;
  /** MCP server id to remove. */
  server: string;
}

export type RemovalOp =
  | RemovalOpRemoveDeny
  | RemovalOpRemoveAllow
  | RemovalOpRemoveBlock
  | RemovalOpDeleteFile
  | RemovalOpUnlink
  | RemovalOpPluginUninstall
  | RemovalOpRemoveHooks
  | RemovalOpRemovePermission
  | RemovalOpRemoveMcp;

// ---------------------------------------------------------------------------
// Scanner / Verdict
// ---------------------------------------------------------------------------

/**
 * Result of a security scan (core/scan.ts seam).
 * M0: stub always returns { ok: true }.
 * Future: findings array populated by Trivy/Gitleaks/regex scanners.
 *
 * ADR-0018: when no scanner tool is installed, ok is true but degraded is true.
 * The install layer translates degraded into an actionable warning and proceeds.
 */
export interface Verdict {
  ok: boolean;
  /** Human-readable findings when ok is false. */
  findings?: string[];
  /**
   * True when no scanner tool (gitleaks / trivy) is installed on the host.
   * Content was not scanned; install proceeds with a warning.
   * Absent (undefined) when a scanner ran normally.
   */
  degraded?: boolean;
}

// ---------------------------------------------------------------------------
// Audit / Report
// ---------------------------------------------------------------------------

/**
 * State of a single artefact as observed on disk.
 *
 * - 'missing'  → not installed; check exits 3.
 * - 'present'  → installed and matches manifest sha/content; check exits 0.
 * - 'drift'    → installed but diverged (file modified or sha mismatch); check exits 3.
 */
export type ArtifactState = 'missing' | 'present' | 'drift';

/**
 * Audit result for one artefact entry.
 * The engine (B7) derives exit codes from a collection of NatureReports.
 */
export interface NatureReport {
  id: string;
  nature: Nature;
  state: ArtifactState;
  /** Optional detail message (e.g. which file is missing / drifted). */
  detail?: string;
}

/**
 * Aggregated audit report returned by engine.check().
 * Use entries to derive exit code: 0 if all present, 3 if any missing/drift.
 * Exit code logic lives in engine.ts (B7), not here.
 */
export interface Report {
  entries: NatureReport[];
}
