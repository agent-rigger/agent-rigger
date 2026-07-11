/**
 * Path resolution for agent-rigger.
 *
 * Key design invariant: no function reads process.env / Bun.env directly.
 * All env access is injected via the `env` parameter (default = Bun.env).
 * This makes every function deterministic and testable without touching the
 * real filesystem or the real ~/.
 *
 * RIGGER_HOME env var overrides the home directory used for all user-scope
 * paths. This is the sole seam for test isolation.
 */

import os from 'node:os';
import path from 'node:path';

import type { Assistant, Scope } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Env object shape accepted by all path functions. */
export type Env = Record<string, string | undefined>;

/** Absolute paths for user-scope targets. */
export interface UserTargets {
  /** ~/.claude/settings.json */
  claudeSettings: string;
  /** ~/.claude/CLAUDE.md */
  claudeMd: string;
  /** ~/.claude/harness/AGENTS.md */
  agentsMd: string;
  /** ~/.config/agent-rigger/state.json */
  stateJson: string;
  /** ~/.config/agent-rigger/skills/ */
  skillsDir: string;
}

/** Relative-to-cwd paths for project-scope targets (returned as absolute). */
export interface ProjectTargets {
  /** <cwd>/.claude/settings.json */
  claudeSettings: string;
  /** <cwd>/.claude/CLAUDE.md */
  claudeMd: string;
  /** <cwd>/AGENTS.md */
  agentsMd: string;
}

/** Absolute paths for opencode user-scope targets (M3). */
export interface OpencodeUserTargets {
  /** ~/.config/opencode/opencode.json */
  opencodeJson: string;
  /** ~/.config/opencode/AGENTS.md */
  agentsMd: string;
  /** ~/.config/opencode/agents/ */
  agentsDir: string;
  /** ~/.config/opencode/plugin/ */
  pluginDir: string;
  /** ~/.config/opencode/skills/ (symlink target; physical store stays under agent-rigger). */
  skillsDir: string;
}

/** Absolute paths for opencode project-scope targets (M3). */
export interface OpencodeProjectTargets {
  /** <cwd>/opencode.json */
  opencodeJson: string;
  /** <cwd>/AGENTS.md */
  agentsMd: string;
  /** <cwd>/.opencode/agents/ */
  agentsDir: string;
  /** <cwd>/.opencode/plugin/ */
  pluginDir: string;
  /** <cwd>/.opencode/skills/ */
  skillsDir: string;
}

// ---------------------------------------------------------------------------
// Core resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the effective home directory.
 *
 * Priority:
 *   1. env.RIGGER_HOME  (non-empty string)
 *   2. env.HOME         (non-empty string)
 *   3. os.homedir()     (system fallback)
 *
 * @param env  Injectable env object. Defaults to Bun.env so callers outside
 *             tests need not pass anything.
 */
export function resolveHome(env: Env = Bun.env): string {
  const riggerHome = env['RIGGER_HOME'];
  if (riggerHome !== undefined && riggerHome !== '') return riggerHome;

  const home = env['HOME'];
  if (home !== undefined && home !== '') return home;

  return os.homedir();
}

// ---------------------------------------------------------------------------
// User-scope targets
// ---------------------------------------------------------------------------

/**
 * Resolve all user-scope target paths under the effective home directory.
 * Paths are always absolute.
 *
 * Pass an env with `{ RIGGER_HOME: '/tmp/isolated' }` in tests to avoid
 * touching the real ~/.
 */
export function resolveUserTargets(env: Env = Bun.env): UserTargets {
  const home = resolveHome(env);
  const claudeDir = path.join(home, '.claude');
  const configDir = path.join(home, '.config', 'agent-rigger');

  return {
    claudeSettings: path.join(claudeDir, 'settings.json'),
    claudeMd: path.join(claudeDir, 'CLAUDE.md'),
    agentsMd: path.join(claudeDir, 'harness', 'AGENTS.md'),
    stateJson: path.join(configDir, 'state.json'),
    skillsDir: path.join(configDir, 'skills'),
  };
}

// ---------------------------------------------------------------------------
// Project-scope targets
// ---------------------------------------------------------------------------

/**
 * Resolve all project-scope target paths under the given working directory.
 *
 * @param cwd  Project root. Defaults to process.cwd().
 */
export function resolveProjectTargets(cwd: string = process.cwd()): ProjectTargets {
  const claudeDir = path.join(cwd, '.claude');

  return {
    claudeSettings: path.join(claudeDir, 'settings.json'),
    claudeMd: path.join(claudeDir, 'CLAUDE.md'),
    agentsMd: path.join(cwd, 'AGENTS.md'),
  };
}

// ---------------------------------------------------------------------------
// opencode-scope targets (M3)
// ---------------------------------------------------------------------------

/**
 * Resolve all opencode user-scope target paths under the effective home.
 * Config root is ~/.config/opencode (opencode's native global location).
 */
export function resolveOpencodeUserTargets(env: Env = Bun.env): OpencodeUserTargets {
  const home = resolveHome(env);
  const opencodeDir = path.join(home, '.config', 'opencode');

  return {
    opencodeJson: path.join(opencodeDir, 'opencode.json'),
    agentsMd: path.join(opencodeDir, 'AGENTS.md'),
    agentsDir: path.join(opencodeDir, 'agents'),
    pluginDir: path.join(opencodeDir, 'plugin'),
    skillsDir: path.join(opencodeDir, 'skills'),
  };
}

/**
 * Resolve all opencode project-scope target paths under the given cwd.
 * opencode.json + AGENTS.md live at the project root; the rest under .opencode/.
 *
 * @param cwd  Project root. Defaults to process.cwd().
 */
export function resolveOpencodeProjectTargets(
  cwd: string = process.cwd(),
): OpencodeProjectTargets {
  const opencodeDir = path.join(cwd, '.opencode');

  return {
    opencodeJson: path.join(cwd, 'opencode.json'),
    agentsMd: path.join(cwd, 'AGENTS.md'),
    agentsDir: path.join(opencodeDir, 'agents'),
    pluginDir: path.join(opencodeDir, 'plugin'),
    skillsDir: path.join(opencodeDir, 'skills'),
  };
}

// ---------------------------------------------------------------------------
// assistantRoot — per-assistant root directory (R5, lot5-ux-dx)
// ---------------------------------------------------------------------------

/**
 * Resolve the root directory a transaction targets for a given assistant +
 * scope, so plan headers and the scope picker can name the true directory
 * instead of assuming `.claude` (R5).
 *
 * Derived from the `resolve*Targets` functions above — the sole source of
 * truth for these conventions, no duplicated path literals:
 *   - claude/user    → dirname(resolveUserTargets(...).claudeSettings)   = <home>/.claude
 *   - claude/project → dirname(resolveProjectTargets(...).claudeSettings) = <cwd>/.claude
 *   - opencode/user  → dirname(resolveOpencodeUserTargets(...).opencodeJson) = <home>/.config/opencode
 *   - opencode/project → cwd itself (opencode.json lives at the project root;
 *     `.opencode/` is only a sub-tree, not the root — see resolveOpencodeProjectTargets).
 *   - copilot → undefined, fail-soft (reserved assistant id, no adapter, no
 *     path suffix — Hors périmètre).
 *
 * Returns `undefined` when the assistant has no on-disk convention (copilot)
 * or when the required `home`/`cwd` for the requested scope is absent/empty
 * — callers (ui.ts) render no root suffix in that case.
 */
export function assistantRoot(
  assistant: Assistant,
  scope: Scope,
  opts: { home?: string; cwd?: string } = {},
): string | undefined {
  if (assistant === 'copilot') return undefined;

  if (scope === 'user') {
    const { home } = opts;
    if (home === undefined || home === '') return undefined;
    const env: Env = { HOME: home };
    return assistant === 'claude'
      ? path.dirname(resolveUserTargets(env).claudeSettings)
      : path.dirname(resolveOpencodeUserTargets(env).opencodeJson);
  }

  const { cwd } = opts;
  if (cwd === undefined || cwd === '') return undefined;
  return assistant === 'claude'
    ? path.dirname(resolveProjectTargets(cwd).claudeSettings)
    : path.dirname(resolveOpencodeProjectTargets(cwd).opencodeJson);
}
