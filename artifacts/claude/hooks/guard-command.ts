#!/usr/bin/env bun
// PreToolUse hook: blocks Bash commands that are destructive, escalate
// privilege, or look like network exfiltration / download-and-execute.
// Sister hook to guard-secret.ts. Inspired by the rm -rf detection in
// disler/claude-code-hooks-multi-agent-observability/pre_tool_use.py,
// extended to cover the threat surface beyond filesystem deletion.
//
// ─── Known limits (this is a defense, not a sandbox) ─────────────────
// The Bash matcher operates on the literal command STRING. Anything that
// requires real shell semantics to interpret will slip through. Concrete
// vectors NOT detected by this hook:
//
//   • Quoting: `rm -rf "/"`, `rm -rf '/'`
//   • Escaping: `rm -rf \/`
//   • Variable indirection: `D=/; rm -rf $D`
//   • Command substitution: `rm -rf $(echo /)`, `` rm -rf `echo /` ``
//   • Glob expansion: `rm -rf /???`
//   • Heredoc: `bash <<< "rm -rf /"`
//   • Download-then-exec split: `curl x>/tmp/s.sh && bash /tmp/s.sh`
//   • Native interpreters: `python -c "open('/etc/passwd').read()"`,
//     same for node, ruby, perl, etc.
//   • Renamed fork-bomb: `f(){f|f&};f` (signature-only match)
//
// Treat this as protection against accidental destruction and the most
// obvious exfiltration patterns — not against an adversarial caller.

import {
  type BashRule,
  buildDenyOutput as buildDenyOutputShared,
  type Deny,
  type HookInput,
  type HookOutput,
  readStringField,
  runHook,
} from './_shared/hook-lib.ts';

export { MAX_LOG_TARGET_LEN, truncateTarget } from './_shared/hook-lib.ts';
export type { Deny, HookInput, HookOutput, PermissionDecision } from './_shared/hook-lib.ts';

const HOOK_NAME = 'command-guard';
const LOG_FILE = `${import.meta.dir}/guard-command.log`;

// ─── Tier 1 helper: rm -rf with dangerous target detection ───────────

// Dangerous absolute or special-form targets that destroy the system or
// the user's whole tree when paired with rm -rf.
export const DANGEROUS_RM_TARGETS: readonly RegExp[] = [
  /^\/$/, // /
  /^\/\*$/, // /*
  /^~\/?$/, // ~ or ~/
  /^~\/\*$/, // ~/*
  /^\$\{?HOME\}?\/?$/, // $HOME or ${HOME}/
  /^\$\{?HOME\}?\/\*$/, // $HOME/*
  /^\.\.\/?$/, // .. or ../
  /^\.\.\/\*$/, // ../*
  /^\*$/, // *
  /^\.\/?$/, // . or ./
  /^\/(etc|usr|var|bin|sbin|lib|sys|proc|boot|root|home|opt|srv|System|Library|Applications)(\/.*)?$/,
];

// Whitelist exposed for documentation and external introspection. NOTE:
// the runtime check (checkRmRf) deliberately ignores this list when the
// target is in DANGEROUS_RM_TARGETS — dangerous always wins. The list
// describes "common, safe rm -rf intents"; non-dangerous targets are
// already implicitly allowed because no rule fires.
export const RM_ALLOWED_TARGETS: readonly RegExp[] = [
  /(^|\/)node_modules(\/[^\s]*)?$/,
  /(^|\/)dist(\/[^\s]*)?$/,
  /(^|\/)\.next(\/[^\s]*)?$/,
  /(^|\/)\.turbo(\/[^\s]*)?$/,
  /(^|\/)coverage(\/[^\s]*)?$/,
  /(^|\/)\.cache(\/[^\s]*)?$/,
];

function hasRmRf(segment: string): boolean {
  // Both -r/-R/--recursive AND -f/-F/--force must appear in the segment.
  const hasR = /-[a-zA-Z]*[rR][a-zA-Z]*\b|--recursive\b/.test(segment);
  const hasF = /-[a-zA-Z]*[fF][a-zA-Z]*\b|--force\b/.test(segment);
  return hasR && hasF;
}

function isDangerousRmTarget(target: string): boolean {
  return DANGEROUS_RM_TARGETS.some((re) => re.test(target));
}

export function checkRmRf(cmd: string): Deny | null {
  // Slice the command at command separators so we evaluate each rm
  // segment independently of surrounding pipes / chains.
  const rmSegments = cmd.match(/\brm\b[^;|&\n]*/g) ?? [];
  for (const seg of rmSegments) {
    if (!hasRmRf(seg)) continue;
    const tokens = seg.split(/\s+/).slice(1).filter((t) => t && !t.startsWith('-'));
    for (const target of tokens) {
      // Dangerous always wins; the allowlist is informative only and
      // cannot override system-path destruction (e.g. /etc/node_modules).
      if (isDangerousRmTarget(target)) {
        return {
          ruleId: 'rm-rf-dangerous',
          reason: `rm -rf targeting a dangerous path: ${target}`,
          target: cmd,
        };
      }
    }
  }
  return null;
}

// ─── Tier 1, 2, 3 — pattern rules ────────────────────────────────────

export const BASH_RULES: readonly BashRule[] = [
  // Tier 1 — destruction
  {
    regex: /\bdd\s+[^|;&\n]*\bof=\/dev\//,
    ruleId: 'dd-device-write',
    reason: 'dd writing to a block device (/dev/...) — likely disk wipe',
  },
  {
    regex: /\bmkfs(\.\w+)?\b/,
    ruleId: 'mkfs',
    reason: 'mkfs reformats a filesystem — irreversible',
  },
  {
    regex: />\s*\/dev\/(sda|sdb|disk|nvme|hd|md|loop)\w*/,
    ruleId: 'device-redirect',
    reason: 'Shell redirection writing to a block device (potential disk corruption)',
  },
  {
    regex: /\btee\s+(?:-a\s+|--append\s+)?\/dev\/(sda|sdb|disk|nvme|hd|md|loop)\w*/,
    ruleId: 'device-redirect',
    reason: 'tee writing to a block device (potential disk corruption)',
  },
  {
    regex: /\bchmod\s+-R\s+0?[0-7]{1,4}\s+\/(?:\s|$)/,
    ruleId: 'chmod-root',
    reason: 'Recursive chmod on / — likely to break the system',
  },
  {
    regex: /\bchown\s+-R\s+\S+\s+\/(?:\s|$)/,
    ruleId: 'chown-root',
    reason: 'Recursive chown on / — likely to break the system',
  },

  // Tier 2 — exfiltration
  {
    // -d / --data / --data-binary / --data-raw / --data-urlencode use `@<path>`.
    // -F / --form uses `field=@<path>`.
    // -T / --upload-file take a bare path argument.
    regex:
      /\bcurl\b[^|;&\n]*?\s(?:(?:-d|--data|--data-binary|--data-raw|--data-urlencode)\s+@\S+|(?:-F|--form)\s+\S*=@|(?:-T|--upload-file)\s+\S+)/,
    ruleId: 'curl-file-upload',
    reason: 'curl uploading a local file (potential exfiltration)',
  },
  {
    regex: /\bwget\b[^|;&\n]*--post-(?:file|data)=/,
    ruleId: 'wget-post-file',
    reason: 'wget posting a local file or data (potential exfiltration)',
  },
  {
    regex: /\bn(?:c|cat)\b[^|;&\n]*<\s*[^\s<]/,
    ruleId: 'nc-file-redirect',
    reason: 'netcat reading a file via stdin redirection (exfiltration)',
  },

  // Tier 3 — escalation / shell pollution
  {
    // `/` is included in the leading separator class so that a path-
    // prefixed binary like `/usr/bin/sudo apt` is also caught.
    // Covers sudo and common alternatives (doas, pkexec, runas, please).
    regex: /(?:^|[;&|/]|&&|\|\|)\s*(?:sudo|doas|pkexec|runas|please)\b/,
    ruleId: 'sudo',
    reason:
      'Privilege escalation tool (sudo/doas/pkexec/runas/please) — confirm manually outside Claude Code',
  },
  {
    regex: /\bchmod\s+(?:[ugoa]*\+s|[0-7]?[2-7][0-7]{2,3})\b/,
    ruleId: 'setuid',
    reason: 'chmod setting setuid/setgid bit',
  },
  {
    regex: /(?:>|>>)\s*\/etc\/(sudoers|passwd|shadow|hosts|ssh\/sshd_config)\b/,
    ruleId: 'etc-write',
    reason: 'Writing to a critical /etc file (sudoers, passwd, shadow, hosts, sshd_config)',
  },
  {
    regex: /\btee\s+(?:-a\s+|--append\s+)?\/etc\/(sudoers|passwd|shadow|hosts|ssh\/sshd_config)\b/,
    ruleId: 'etc-write',
    reason: 'tee writing to a critical /etc file (sudoers, passwd, shadow, hosts, sshd_config)',
  },
  {
    regex: /\bkill(?:all)?\s+(?:-(?:9|KILL)\s+)?(?:-?-?\s*)?(?:1|init)\b/,
    ruleId: 'kill-init',
    reason: 'Killing PID 1 / init — system halt',
  },
  {
    regex: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    ruleId: 'fork-bomb',
    reason: 'Fork bomb pattern detected',
  },
  {
    regex: /(?:curl|wget)\b[^|;&\n]*\|\s*(?:sh|bash|zsh|ksh|fish|sudo)\b/,
    ruleId: 'download-exec',
    reason: 'Piping curl/wget output directly to a shell (download-and-execute)',
  },
  {
    // Matches both `eval $(curl ...)` and `eval `curl ...`` (backticks).
    regex: /\beval\s+["']?(?:\$\(|`)\s*(?:curl|wget)\b/,
    ruleId: 'eval-download',
    reason: 'eval of curl/wget output (download-and-execute)',
  },
  {
    regex: /\b(?:bash|sh|zsh|ksh)\s+<\s*\(\s*(?:curl|wget)\b/,
    ruleId: 'process-substitution-download',
    reason: 'Process substitution feeding curl/wget output to a shell (download-and-execute)',
  },
];

// ─── Git guard: ASK before history-rewriting / remote / destructive ops ──
//
// Maintainable by inversion: a small SAFE_GIT allowlist is auto-approved;
// every OTHER subcommand surfaces an interactive prompt ("ask"). New or
// unknown git subcommands therefore default to "ask" without editing this
// file — the open-ended dangerous set never has to be enumerated.

// Subcommands safe with any flags (read-only, or local-additive).
export const SAFE_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status',
  'diff',
  'log',
  'show',
  'blame',
  'shortlog',
  'describe',
  'rev-parse',
  'ls-files',
  'cat-file',
  'grep',
  'add',
  'commit',
  'fetch',
]);

// Tokens that may legitimately precede `git` at command position.
const GIT_BENIGN_PREFIXES: ReadonlySet<string> = new Set([
  'command',
  'exec',
  'env',
  'nice',
  'time',
  'builtin',
]);

// git global options that consume the FOLLOWING token as their argument.
const GIT_OPTS_WITH_ARG: ReadonlySet<string> = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--exec-path',
]);

// Find the git subcommand in a single command segment, tolerating wrappers
// (`command git …`), env assignments (`GIT_SEQUENCE_EDITOR=… git …`), and global
// options (`git -C <path> …`). Returns null when the segment is not a git
// command (so `echo git push` is ignored — git is an argument, not the verb).
export function extractGitSubcommand(segment: string): { sub: string; rest: string[] } | null {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (
    i < tokens.length
    && (/^\w+=/.test(tokens[i]!) || GIT_BENIGN_PREFIXES.has(tokens[i]!))
  ) {
    i++;
  }
  if (i >= tokens.length) return null;
  const head = tokens[i]!;
  if (head !== 'git' && !head.endsWith('/git')) return null;
  i++;
  while (i < tokens.length && tokens[i]!.startsWith('-')) {
    i += GIT_OPTS_WITH_ARG.has(tokens[i]!) ? 2 : 1;
  }
  if (i >= tokens.length) return null;
  return { sub: tokens[i]!, rest: tokens.slice(i + 1) };
}

function gitSubcommandNeedsAsk(sub: string, rest: readonly string[]): boolean {
  if (SAFE_GIT_SUBCOMMANDS.has(sub)) return false;
  // Conditionally-safe: allow the read/additive form, ask on destructive flags.
  if (sub === 'branch') {
    return rest.some((t) => /^(-d|-D|--delete|-m|-M|--move|-f|--force)$/.test(t));
  }
  if (sub === 'tag') {
    return rest.some((t) => /^(-d|--delete)$/.test(t));
  }
  if (sub === 'stash') {
    return rest.length > 0 && /^(drop|clear)$/.test(rest[0]!);
  }
  // Everything else (push, pull, rebase, reset, merge, checkout, switch,
  // restore, clean, bisect, cherry-pick, revert, gc, config writes, remote
  // mutations, worktree, submodule, …) requires confirmation.
  return true;
}

export function checkGit(cmd: string): Deny | null {
  for (const seg of cmd.split(/[;&|\n]+/)) {
    const parsed = extractGitSubcommand(seg);
    if (!parsed) continue;
    if (gitSubcommandNeedsAsk(parsed.sub, parsed.rest)) {
      return {
        decision: 'ask',
        ruleId: 'git-protected',
        reason:
          `git ${parsed.sub} can rewrite history, mutate a remote, or discard work — confirm before running`,
        target: cmd,
      };
    }
  }
  return null;
}

export function checkBash(cmd: string): Deny | null {
  if (!cmd) return null;

  // Special-cased: rm -rf needs allowlist logic before generic regex.
  const rmHit = checkRmRf(cmd);
  if (rmHit) return rmHit;

  // Hard-block (deny) rules take priority over the git "ask" guard.
  for (const rule of BASH_RULES) {
    if (rule.regex.test(cmd)) {
      return { ruleId: rule.ruleId, reason: rule.reason, target: cmd };
    }
  }

  // Protected git operations → interactive prompt ("ask").
  return checkGit(cmd);
}

export function inspect(input: HookInput): Deny | null {
  if (input.tool_name !== 'Bash') return null;
  const ti = input.tool_input ?? {};
  const cmd = readStringField(ti, 'command', HOOK_NAME);
  return cmd === null ? null : checkBash(cmd);
}

export function buildDenyOutput(deny: Deny): HookOutput {
  return buildDenyOutputShared(HOOK_NAME, deny);
}

if (import.meta.main) {
  await runHook({ hookName: HOOK_NAME, logFile: LOG_FILE, inspect });
}
