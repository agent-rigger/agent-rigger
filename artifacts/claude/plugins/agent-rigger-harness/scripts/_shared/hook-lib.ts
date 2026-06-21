// Shared runtime + types for PreToolUse hooks. Hosts the boilerplate
// duplicated across every hook (input shape, deny output, log writer,
// stdin/stdout main loop) so each hook only needs to define its rules
// and an `inspect` function.

import { appendFile, rename, stat } from 'node:fs/promises';

export interface HookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  session_id?: string;
  hook_event_name?: string;
  tool_use_id?: string;
}

// Hooks emit "deny" (hard-block the tool) or "ask" (surface an interactive
// permission prompt). Allow is signaled by exiting silently with code 0.
export type PermissionDecision = 'deny' | 'ask';

export interface HookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: PermissionDecision;
    permissionDecisionReason: string;
  };
}

// A guard verdict. `decision` defaults to "deny" when omitted, so deny-only
// hooks (e.g. secret-guard) need no change; set `decision: "ask"` to surface
// an interactive prompt instead of a hard block.
export interface Deny {
  decision?: PermissionDecision;
  ruleId: string;
  reason: string;
  target: string;
}

// Semantic alias for hooks that emit "ask" as well as "deny".
export type Verdict = Deny;

export interface BashRule {
  regex: RegExp;
  ruleId: string;
  reason: string;
}

export const MAX_LOG_TARGET_LEN = 200;
export const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB

export function truncateTarget(target: string): string {
  return target.length > MAX_LOG_TARGET_LEN
    ? `${target.slice(0, MAX_LOG_TARGET_LEN - 3)}...`
    : target;
}

export function buildDenyOutput(hookName: string, deny: Deny): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `${hookName}[${deny.ruleId}]: ${deny.reason}`,
    },
  };
}

// Emits the verdict's own decision ("deny" by default, or "ask"). Used by
// runHook so a single hook can mix hard-blocks and interactive prompts.
export function buildVerdictOutput(hookName: string, verdict: Deny): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: verdict.decision ?? 'deny',
      permissionDecisionReason: `${hookName}[${verdict.ruleId}]: ${verdict.reason}`,
    },
  };
}

async function rotateIfNeeded(logFile: string): Promise<void> {
  try {
    const s = await stat(logFile);
    if (s.size >= MAX_LOG_SIZE) {
      await rename(logFile, `${logFile}.1`);
    }
  } catch {
    // File doesn't exist yet or stat failed — nothing to rotate
  }
}

export async function logDeny(
  logFile: string,
  hookName: string,
  input: HookInput,
  deny: Deny,
): Promise<void> {
  const entry = `${
    JSON.stringify({
      timestamp: new Date().toISOString(),
      session_id: input.session_id ?? null,
      tool_name: input.tool_name ?? null,
      decision: deny.decision ?? 'deny',
      rule_id: deny.ruleId,
      target: truncateTarget(deny.target),
    })
  }\n`;

  try {
    await rotateIfNeeded(logFile);
    await appendFile(logFile, entry, { mode: 0o600 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${hookName}] log write failed: ${msg}`);
  }
}

export async function runHook(opts: {
  hookName: string;
  logFile: string;
  inspect: (input: HookInput) => Deny | null | Promise<Deny | null>;
}): Promise<void> {
  const raw = await Bun.stdin.text();
  if (!raw.trim()) process.exit(0);

  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${opts.hookName}] malformed JSON on stdin, allowing tool: ${msg}`);
    process.exit(0);
  }

  const deny = await opts.inspect(input);
  if (!deny) process.exit(0);

  await logDeny(opts.logFile, opts.hookName, input, deny);
  process.stdout.write(JSON.stringify(buildVerdictOutput(opts.hookName, deny)));
  process.exit(0);
}

// Helper: safely extract a string field from tool_input, logging on
// stderr if a non-string value is encountered (so future tool surface
// changes don't silently pass through unexpected shapes).
export function readStringField(
  ti: Record<string, unknown>,
  key: string,
  hookName: string,
): string | null {
  const value = ti[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    console.error(
      `[${hookName}] expected string for tool_input.${key}, got ${typeof value} — allowing`,
    );
    return null;
  }
  return value;
}
