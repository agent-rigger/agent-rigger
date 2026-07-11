/**
 * assistant-select.ts — resolve the target assistant for a transaction (R1).
 *
 * Split pure decision from IO (testability, ADR-aligned):
 * - decideAssistant  Pure function, exhaustive branch logic, no I/O.
 * - resolveAssistant IO wrapper: detects installed assistants on disk, delegates
 *   to decideAssistant, and prompts (injectable picker) only when ambiguous.
 *
 * Priority (highest → lowest): flag > config.assistants (single) > detected
 * (single) > interactive prompt (TTY) > actionable error.
 *
 * Constraints:
 * - No while loops.
 * - No process.exit — callers decide what to do with a thrown error.
 */

import { cancel, isCancel, select } from '@clack/prompts';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Assistant } from '@agent-rigger/core';
import type { Env } from '@agent-rigger/core/paths';
import { resolveHome } from '@agent-rigger/core/paths';

import { CancelledError } from './ui';

// ---------------------------------------------------------------------------
// decideAssistant — pure
// ---------------------------------------------------------------------------

const VALID_ASSISTANTS = new Set<Assistant>(['claude', 'opencode']);

/** Input to decideAssistant. */
export interface DecideAssistantInput {
  /** Raw --assistant flag value, unvalidated. */
  flag?: string;
  /** config.assistants[] from the resolved CLI config. */
  configAssistants?: Assistant[];
  /** Assistants detected on disk (~/.claude, ~/.config/opencode). */
  detected: Assistant[];
  /** Whether the current process is an interactive TTY. */
  isTTY: boolean;
}

/** Outcome of decideAssistant — exactly one branch is populated. */
export type DecideAssistantResult =
  | { assistant: Assistant }
  | { needsPrompt: Assistant[] }
  | { error: string };

/**
 * Decide the target assistant from flag/config/detection/TTY, with no I/O.
 *
 * Priority:
 * 1. A valid `flag` wins outright. An invalid flag value is an actionable
 *    error regardless of every other input (fail fast on operator typos).
 * 2. Otherwise, `configAssistants` with exactly one entry wins.
 * 3. Otherwise, `detected` with exactly one entry wins.
 * 4. Otherwise, in a TTY: the caller must prompt — candidates are the union of
 *    `configAssistants` and `detected` (or, if both are empty, both assistants).
 * 5. Otherwise (non-TTY, ambiguous or empty): actionable error — never a
 *    silent default (R10.4).
 */
export function decideAssistant(input: DecideAssistantInput): DecideAssistantResult {
  const { flag, configAssistants, detected, isTTY } = input;

  if (flag !== undefined) {
    if (VALID_ASSISTANTS.has(flag as Assistant)) {
      return { assistant: flag as Assistant };
    }
    return {
      error: `Invalid --assistant value: "${flag}". Must be "claude" or "opencode".`,
    };
  }

  if (configAssistants !== undefined && configAssistants.length === 1) {
    return { assistant: configAssistants[0] as Assistant };
  }

  if (detected.length === 1) {
    return { assistant: detected[0] as Assistant };
  }

  if (isTTY) {
    const union = new Set<Assistant>([...(configAssistants ?? []), ...detected]);
    const candidates = union.size > 0 ? [...union] : (['claude', 'opencode'] satisfies Assistant[]);
    return { needsPrompt: candidates };
  }

  return {
    error: 'no assistant selected; pass --assistant claude|opencode or set assistants[] in config',
  };
}

// ---------------------------------------------------------------------------
// detectAssistants — IO: presence of ~/.claude and ~/.config/opencode
// ---------------------------------------------------------------------------

/** Return true when `dir` exists (file or directory), false otherwise. */
async function pathExists(dir: string): Promise<boolean> {
  return fs.access(dir).then(
    () => true,
    () => false,
  );
}

/**
 * Detect which assistants are installed on this machine, under resolveHome(env).
 *
 * - `~/.claude`          → 'claude'
 * - `~/.config/opencode` → 'opencode'
 *
 * Order is stable ('claude' before 'opencode') so callers get deterministic output.
 */
export async function detectAssistants(env: Env): Promise<Assistant[]> {
  const home = resolveHome(env);
  const [hasClaude, hasOpencode] = await Promise.all([
    pathExists(path.join(home, '.claude')),
    pathExists(path.join(home, '.config', 'opencode')),
  ]);

  const detected: Assistant[] = [];
  if (hasClaude) detected.push('claude');
  if (hasOpencode) detected.push('opencode');
  return detected;
}

// ---------------------------------------------------------------------------
// resolveAssistant — IO wrapper
// ---------------------------------------------------------------------------

/** Options for resolveAssistant. */
export interface ResolveAssistantOpts {
  /** Raw --assistant flag value, unvalidated. */
  flag?: string;
  /** config.assistants[] from the resolved CLI config. */
  configAssistants?: Assistant[];
  /** Injectable environment for path resolution (RIGGER_HOME seam). */
  env: Env;
  /** Whether the current process is an interactive TTY. Defaults to process.stdout.isTTY. */
  isTTY?: boolean;
  /** Injectable picker, invoked only when the assistant is ambiguous. Defaults to a clack select prompt. */
  picker?: (candidates: Assistant[]) => Promise<Assistant>;
  /**
   * Back-compat default, used ONLY for the "nothing resolvable, non-TTY" case
   * (no flag, no single config/detected assistant, can't prompt). Never applied
   * to an invalid `flag` value — a typo always throws, regardless of fallback.
   * Omit to keep the strict behaviour (throw — R10.4, no silent default).
   */
  fallback?: Assistant;
}

/**
 * Default interactive picker — thin glue around @clack/prompts, not unit-tested
 * (TTY requirement), mirroring ui.ts's selectScope/confirmApply pattern.
 */
async function defaultPicker(candidates: Assistant[]): Promise<Assistant> {
  const result = await select<Assistant>({
    message: 'Which assistant do you want to target?',
    options: candidates.map((a) => ({ value: a, label: a })),
  });

  if (isCancel(result)) {
    // R2: migrated from a generic Error (→ exit 1, indistinguishable from a
    // runtime failure) to CancelledError (→ exit 130 via handleError).
    cancel('Operation cancelled.');
    throw new CancelledError('Assistant selection cancelled.');
  }

  return result;
}

/**
 * Resolve the target assistant, prompting interactively only when ambiguous.
 *
 * Detection is real filesystem I/O (isolated via RIGGER_HOME in tests, the
 * same seam used throughout packages/core/src/paths.ts).
 */
export async function resolveAssistant(opts: ResolveAssistantOpts): Promise<Assistant> {
  const { env, picker = defaultPicker } = opts;
  const isTTY = opts.isTTY ?? process.stdout.isTTY === true;
  const detected = await detectAssistants(env);

  const input: DecideAssistantInput = { detected, isTTY };
  if (opts.flag !== undefined) input.flag = opts.flag;
  if (opts.configAssistants !== undefined) input.configAssistants = opts.configAssistants;

  const result = decideAssistant(input);

  if ('assistant' in result) return result.assistant;
  if ('error' in result) {
    // fallback only covers the flagless "nothing resolvable" error — an invalid
    // flag (input.flag !== undefined) is always a hard error (operator typo).
    if (opts.fallback !== undefined && input.flag === undefined) {
      return opts.fallback;
    }
    throw new Error(result.error);
  }

  return picker(result.needsPrompt);
}
