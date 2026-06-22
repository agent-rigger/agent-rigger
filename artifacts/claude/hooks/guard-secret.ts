#!/usr/bin/env bun
// PreToolUse hook: blocks Claude Code from reading/listing secret-bearing
// files. Inspired by disler/claude-code-hooks-multi-agent-observability
// (pre_tool_use.py), reimplemented in Bun TS.
//
// Protocol: reads JSON on stdin, exits 0 in all cases. On allow, stays
// silent. On deny, writes a JSON document to stdout with
// hookSpecificOutput.permissionDecision = "deny" — Claude Code stops the
// tool call and surfaces the reason to the model.
//
// ─── Known limits (this is a defense, not a sandbox) ─────────────────
// 1. Symlinks: inspect() resolves symlinks via realpath() before
//    checkPath, at the cost of one stat() per tool call. Bash paths
//    embedded in commands are NOT resolved (shell obfuscation below).
// 2. Shell obfuscation: the Bash matcher tokenizes the literal command
//    and is trivially defeated by hex/base64/quote-splitting tricks
//    (e.g. `printf '\x2eenv' | xargs cat`). Treat this as protection
//    against accidental leaks, not against an adversarial agent.

import { realpath } from 'node:fs/promises';
import {
  type BashRule,
  buildDenyOutput as buildDenyOutputShared,
  type Deny,
  type HookInput,
  type HookOutput,
  readStringField,
  runHook,
} from './_shared/hook-lib.ts';

// Re-export shared types/values so tests can import everything from this
// module's surface (back-compat with the pre-refactor structure).
export { MAX_LOG_TARGET_LEN, truncateTarget } from './_shared/hook-lib.ts';
export type { Deny, HookInput, HookOutput, PermissionDecision } from './_shared/hook-lib.ts';

const HOOK_NAME = 'secret-guard';
const LOG_FILE = `${import.meta.dir}/guard-secret.log`;

export interface PathRule {
  id: string;
  test: (path: string) => boolean;
  reason: string;
}

const ENV_WHITELIST = /(^|\/)\.env\.(example|test)$/;

// Specific rules (single file or precise extension) come BEFORE broad
// directory rules so that, e.g., ~/.aws/credentials is reported as
// "aws-creds" and not as the generic "secret-dir".
export const PATH_RULES: readonly PathRule[] = [
  {
    id: 'dotenv',
    test: (p) => /(^|\/)\.env[^/]*$/.test(p) && !ENV_WHITELIST.test(p),
    reason: '.env file blocked (only .env.example and .env.test are allowed)',
  },
  {
    id: 'crypto-key',
    test: (p) =>
      /\.(pem|key|pkey|crt|cert|pfx|p12|jks|keystore|gpg|asc|kdbx|kbx|agekey|ovpn)$/i.test(p),
    reason: 'Cryptographic key/certificate file blocked',
  },
  {
    id: 'ssh-key',
    test: (p) => /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(p),
    reason: 'SSH key file blocked',
  },
  {
    id: 'aws-creds',
    test: (p) => /(^|\/)\.aws\/(credentials|config)$/.test(p),
    reason: 'AWS credentials/config blocked',
  },
  {
    id: 'netrc-pgpass',
    test: (p) => /(^|\/)\.(netrc|pgpass)$/.test(p),
    reason: '.netrc/.pgpass blocked',
  },
  {
    id: 'cloud-sa',
    test: (p) => /(service-account|firebase-adminsdk|gcp-key)[^/]*\.json$/i.test(p),
    reason: 'Cloud service-account JSON blocked',
  },
  {
    id: 'tfstate',
    test: (p) => /\.tfstate(\.backup)?$|\.terraform\.tfstate\.lock\.info$/.test(p),
    reason: 'Terraform state file blocked (often contains plaintext secrets)',
  },
  {
    id: 'npmrc',
    test: (p) => /(^|\/)\.npmrc$/.test(p) && !p.includes('/node_modules/'),
    reason: '.npmrc blocked outside node_modules/ (may contain _authToken)',
  },
  {
    id: 'gitconfig',
    test: (p) => /(^|\/)\.gitconfig$/.test(p),
    reason: '.gitconfig blocked (may contain [credential] tokens or signing keys)',
  },
  {
    id: 'hook-log',
    test: (p) =>
      /(^|\/)(?:guard-command|guard-secret|guard-write-secret|transcript-backup)\.log$/.test(p),
    reason: 'hook audit log blocked (would leak history of denied tool calls)',
  },
  {
    id: 'transcript-backup',
    test: (p) => /(^|\/)\.claude\/transcripts(\/|$)/.test(p),
    reason: 'transcript backup directory blocked (contains full session history)',
  },
  {
    id: 'secret-dir',
    test: (p) => /(^|\/)(\.?secrets|credentials)(\/|$)/.test(p),
    reason: 'Path inside secrets/ or credentials/ directory blocked',
  },
  {
    id: 'ssh-dir',
    test: (p) => /(^|\/)\.ssh(\/|$)/.test(p),
    reason: '.ssh directory blocked',
  },
  {
    id: 'gnupg-dir',
    test: (p) => /(^|\/)\.gnupg(\/|$)/.test(p),
    reason: '.gnupg directory blocked',
  },
];

export function checkPath(path: string): Deny | null {
  if (!path) return null;
  for (const rule of PATH_RULES) {
    if (rule.test(path)) {
      return { ruleId: rule.id, reason: rule.reason, target: path };
    }
  }
  return null;
}

// Path-like token: contiguous run covering absolute, relative, and ~/ paths.
const BASH_PATH_TOKEN = /[\w./~-]+/g;

export const BASH_RULES: readonly BashRule[] = [
  {
    regex: /\bgit\s+config\b[^\n]*\b(credential|user\.signingkey|remote\.[^\s]+\.url)\b/,
    ruleId: 'bash-git-leak',
    reason:
      'git command may leak credentials (tokens in remote URLs, signing keys, credential helpers)',
  },
  {
    regex: /\bgit\s+remote\s+(-v\b|get-url\b|--verbose\b)/,
    ruleId: 'bash-git-leak',
    reason:
      'git command may leak credentials (tokens in remote URLs, signing keys, credential helpers)',
  },
  {
    regex: /\b(?:https?|git|ssh|ftp):\/\/[^\s/@:]+:[^\s/@]+@/,
    ruleId: 'bash-url-creds',
    reason: 'URL contains embedded user:password credentials (likely token leak)',
  },
];

export function checkBash(cmd: string): Deny | null {
  if (!cmd) return null;
  for (const rule of BASH_RULES) {
    if (rule.regex.test(cmd)) {
      return { ruleId: rule.ruleId, reason: rule.reason, target: cmd };
    }
  }
  const tokens = cmd.match(BASH_PATH_TOKEN) ?? [];
  for (const tok of tokens) {
    const normalized = tok.replace(/^~\//, '/');
    const hit = checkPath(normalized);
    if (hit) {
      return {
        ruleId: `bash-${hit.ruleId}`,
        reason: `Bash command references sensitive path: ${hit.reason}`,
        target: cmd,
      };
    }
  }
  return null;
}

async function resolvePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

export async function inspect(input: HookInput): Promise<Deny | null> {
  const ti = input.tool_input ?? {};
  switch (input.tool_name) {
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write': {
      const path = readStringField(ti, 'file_path', HOOK_NAME);
      if (path === null) return null;
      return checkPath(await resolvePath(path));
    }
    case 'NotebookEdit': {
      const path = readStringField(ti, 'notebook_path', HOOK_NAME);
      if (path === null) return null;
      return checkPath(await resolvePath(path));
    }
    case 'Grep': {
      const path = readStringField(ti, 'path', HOOK_NAME);
      if (path === null) return null;
      return checkPath(await resolvePath(path));
    }
    case 'Glob': {
      const pattern = readStringField(ti, 'pattern', HOOK_NAME);
      const path = readStringField(ti, 'path', HOOK_NAME);
      const resolvedPath = path !== null ? await resolvePath(path) : null;
      return (pattern !== null ? checkPath(pattern) : null)
        ?? (resolvedPath !== null ? checkPath(resolvedPath) : null);
    }
    case 'Bash': {
      const cmd = readStringField(ti, 'command', HOOK_NAME);
      return cmd === null ? null : checkBash(cmd);
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
