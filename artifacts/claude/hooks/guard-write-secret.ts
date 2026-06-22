#!/usr/bin/env bun
/**
 * guard-write-secret.ts — PreToolUse(Write/Edit/MultiEdit) hook: blocks writing
 * a hardcoded secret VALUE into a file before it hits disk.
 *
 * Complements secret-guard, which blocks READING secret-bearing files. This is
 * the write/leak side: it stops the agent from baking an obvious live token
 * (AWS key, GitHub PAT, private key, …) into source.
 *
 * ─── Posture & split (defense in depth, not a vault) ─────────────────
 * This hook is REGEX-only and fast (a PreToolUse gate must be cheap): it catches
 * high-signal token shapes. It is the part that SHIPS with the plugin and runs
 * in the user's Claude Code session. Obfuscated or novel encodings slip through
 * the regex by design — deeper, entropy-based / history-wide detection is a
 * separate GIT-LEVEL net (`gitleaks`) that the plugin does NOT install: this repo
 * wires it at `pre-commit` (see lefthook.yml / CONTRIBUTING.md), and teams should
 * add it to their own repos.
 *
 * Contract: emits a deny (permissionDecision:"deny") via the shared harness when
 * a secret is detected; stays silent (allow) otherwise; fails open on bad input.
 *
 * scanSecrets() is pure and exported for unit tests.
 */

import {
  buildDenyOutput as buildDenyOutputShared,
  type Deny,
  type HookInput,
  type HookOutput,
  readStringField,
  runHook,
} from './_shared/hook-lib.ts';

export type { Deny, HookInput, HookOutput } from './_shared/hook-lib.ts';

const HOOK_NAME = 'guard-write-secret';
const LOG_FILE = `${import.meta.dir}/guard-write-secret.log`;

interface SecretRule {
  regex: RegExp;
  ruleId: string;
  reason: string;
}

// High-signal token shapes only — distinctive enough that a match is almost
// always a real credential. Trade-off: a realistic-SHAPED placeholder (e.g. a
// doc token of the right form) can still trip a rule; we favour blocking. The
// entropy-based catch-all is deliberately left to gitleaks (pre-commit).
export const SECRET_RULES: readonly SecretRule[] = [
  {
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
    ruleId: 'private-key',
    reason: 'PEM/OpenSSH private key block',
  },
  { regex: /\bAKIA[0-9A-Z]{16}\b/, ruleId: 'aws-access-key-id', reason: 'AWS access key id' },
  {
    regex: /\bghp_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
    ruleId: 'github-pat',
    reason: 'GitHub personal access token',
  },
  {
    regex: /\bgh[ousr]_[A-Za-z0-9]{36}\b/,
    ruleId: 'github-token',
    reason: 'GitHub OAuth/app/refresh token',
  },
  {
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    ruleId: 'slack-token',
    reason: 'Slack token',
  },
  { regex: /\bAIza[0-9A-Za-z_-]{35}\b/, ruleId: 'google-api-key', reason: 'Google API key' },
  {
    regex: /\b(?:sk|rk)_live_[A-Za-z0-9]{24,}\b/,
    ruleId: 'stripe-secret-key',
    reason: 'Stripe live secret key',
  },
  {
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    ruleId: 'jwt',
    reason: 'JSON Web Token (possible embedded credential)',
  },
];

/**
 * Scans text for an embedded secret value. Returns the first matching rule as a
 * Deny, or null if clean.
 */
export function scanSecrets(text: string, target: string): Deny | null {
  if (!text) return null;
  for (const rule of SECRET_RULES) {
    if (rule.regex.test(text)) {
      return { ruleId: rule.ruleId, reason: rule.reason, target };
    }
  }
  return null;
}

/**
 * Extracts the text being written for each supported tool, then scans it.
 */
export function inspect(input: HookInput): Deny | null {
  const ti = input.tool_input ?? {};
  switch (input.tool_name) {
    case 'Write': {
      const content = readStringField(ti, 'content', HOOK_NAME);
      const path = readStringField(ti, 'file_path', HOOK_NAME) ?? '(write)';
      return content === null ? null : scanSecrets(content, path);
    }
    case 'Edit': {
      const next = readStringField(ti, 'new_string', HOOK_NAME);
      const path = readStringField(ti, 'file_path', HOOK_NAME) ?? '(edit)';
      return next === null ? null : scanSecrets(next, path);
    }
    case 'MultiEdit': {
      const path = readStringField(ti, 'file_path', HOOK_NAME) ?? '(multiedit)';
      const edits = Array.isArray(ti['edits'])
        ? (ti['edits'] as Array<Record<string, unknown>>)
        : [];
      const joined = edits
        .map((e) => (typeof e['new_string'] === 'string' ? (e['new_string'] as string) : ''))
        .join('\n');
      return scanSecrets(joined, path);
    }
    default:
      return null;
  }
}

export function buildDenyOutput(deny: Deny): HookOutput {
  return buildDenyOutputShared(HOOK_NAME, deny);
}

if (import.meta.main) {
  await runHook({ hookName: HOOK_NAME, logFile: LOG_FILE, inspect });
}
