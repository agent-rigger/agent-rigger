/**
 * Path resolution for agent-rigger.
 *
 * Key design invariant: no function reads process.env / Bun.env directly.
 * All env access is injected via the `env` parameter (default = Bun.env).
 * This makes every function deterministic and testable without touching the
 * real filesystem or the real ~/.
 *
 * RIGGER_HOME env var overrides the home directory used for all user-scope
 * paths. This is the sole seam for test isolation (R12.1, design §3).
 */

import os from 'node:os';
import path from 'node:path';

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
