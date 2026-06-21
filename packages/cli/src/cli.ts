#!/usr/bin/env bun
/**
 * cli.ts — entry point for the agent-rigger CLI.
 *
 * Responsibilities:
 * - Parse argv (parseArgs).
 * - Route commands to runCheck / runInstall / runInit.
 * - Mount the ClaudeAdapter from real artifacts.
 * - Return exit codes (no process.exit inside runCli — testable).
 * - Call main() only when executed directly.
 *
 * Constraints:
 * - No while loops.
 * - No process.exit inside runCli.
 * - All I/O is injectable via CliDeps for test isolation.
 */

import path from 'node:path';

import {
  createClaudeAdapter,
  loadCanonicalContext,
  loadCanonicalDeny,
  PluginInstallError,
  SkillScanBlockedError,
} from '@agent-rigger/adapters';
import type { Adapter, AdapterEntry } from '@agent-rigger/core/adapter';
import { InvalidJsonError } from '@agent-rigger/core/fs-json';
import type { Env } from '@agent-rigger/core/paths';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';

import { BUILTIN_CATALOG } from '@agent-rigger/catalog';
import { DependencyCycleError, UnknownEntryError } from '@agent-rigger/catalog/resolver';

import { runCheck } from './cmd-check';
import { runInit } from './cmd-init';
import { runInstall } from './cmd-install';
import { PreflightAuthError } from './preflight-auth';

// ---------------------------------------------------------------------------
// Version — sourced from package.json at build time; fallback to "0.0.0"
// ---------------------------------------------------------------------------

const CLI_VERSION = '0.0.0';

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

/** Result of parsing argv. */
export interface ParsedArgs {
  command: string | undefined;
  flags: Record<string, string | boolean>;
}

/**
 * Parse a minimal CLI argv array.
 *
 * - First non-flag token is the command.
 * - --key=value → flags[key] = value
 * - --key       → flags[key] = true
 */
export function parseArgs(argv: string[]): ParsedArgs {
  let command: string | undefined;
  const flags: Record<string, string | boolean> = {};

  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const rest = arg.slice(2);
      const eqIdx = rest.indexOf('=');
      if (eqIdx === -1) {
        flags[rest] = true;
      } else {
        flags[rest.slice(0, eqIdx)] = rest.slice(eqIdx + 1);
      }
    } else if (command === undefined) {
      command = arg;
    }
  }

  return { command, flags };
}

// ---------------------------------------------------------------------------
// Usage text
// ---------------------------------------------------------------------------

const USAGE = `\
agent-rigger — Claude Code guardrail & context installer

Usage:
  agent-rigger <command> [options]

Commands:
  check    Audit whether guardrails and context are correctly installed.
  install  Install selected artifacts (guardrails, context, skills, agents).
  init     First-launch wizard: configure catalog URL and auth method.

Options:
  --scope=<user|project>  Installation scope (default: user).
  --help                  Show this help message.
  --version               Show CLI version.

Examples:
  agent-rigger check
  agent-rigger install --scope=user
  agent-rigger init
`;

// ---------------------------------------------------------------------------
// CliDeps — injectable dependencies
// ---------------------------------------------------------------------------

/** Prompt callbacks injected by the CLI entry or tests. */
export interface CliPrompts {
  selectArtifacts: (entries: typeof BUILTIN_CATALOG) => Promise<string[]>;
  selectScope: () => Promise<'user' | 'project'>;
  confirmApply: () => Promise<boolean>;
  askUrl: () => Promise<string>;
  askMethod: () => Promise<'provider-cli' | 'https' | 'ssh'>;
}

/** All injectable dependencies for runCli. */
export interface CliDeps {
  /** Output sink. Defaults to console.log. */
  print?: (msg: string) => void;
  /** Environment variables. Defaults to Bun.env. */
  env?: Env;
  /** Absolute path to the artifacts directory. Defaults to resolved from __dirname. */
  artifactsDir?: string;
  /** Interactive prompt overrides (for tests). */
  prompts?: CliPrompts;
}

// ---------------------------------------------------------------------------
// buildClaudeAdapter — mount adapter from real artifacts
// ---------------------------------------------------------------------------

/**
 * Build a ClaudeAdapter from the artifacts directory.
 *
 * - denyRef       : loaded from <artifactsDir>/claude/deny.json
 * - agentsContent : loaded from <artifactsDir>/shared/AGENTS.md
 * - skillSource   : resolves id → <artifactsDir>/claude/skills/<id>
 * - agentSource   : resolves id → <artifactsDir>/claude/agents/<agentId>.md
 * - pluginSource  : resolves id → { plugin: <pluginId>, marketplace: <cwd>/.claude-plugin/marketplace.json }
 * - scanner       : stubScanner (M0: always passes)
 */
export async function buildClaudeAdapter(
  _env: Env,
  artifactsDir: string,
): Promise<Adapter> {
  const denyJsonPath = path.join(artifactsDir, 'claude', 'deny.json');
  const agentsMdPath = path.join(artifactsDir, 'shared', 'AGENTS.md');

  const [denyRef, agentsContent] = await Promise.all([
    loadCanonicalDeny(denyJsonPath),
    loadCanonicalContext(agentsMdPath),
  ]);

  return createClaudeAdapter({
    denyRef,
    agentsContent,
    scanner: stubScanner,
    skillSource: (entry) =>
      path.join(artifactsDir, 'claude', 'skills', entry.id.replace(/^skill:/, '')),
    agentSource: (entry) =>
      path.join(artifactsDir, 'claude', 'agents', entry.id.replace(/^agent:/, '') + '.md'),
    pluginSource: (entry) => ({
      plugin: entry.id.replace(/^plugin:/, ''),
      marketplace: path.join(process.cwd(), '.claude-plugin', 'marketplace.json'),
    }),
  });
}

// ---------------------------------------------------------------------------
// resolveArtifactsDir — find repo artifacts relative to this file
// ---------------------------------------------------------------------------

/**
 * Resolve the default artifacts directory.
 * In dev (src/): walk up to repo root, then artifacts/.
 * In compiled binary: same relative path from dist/.
 */
function resolveArtifactsDir(): string {
  // Walk up: packages/cli/src/ → packages/cli/ → packages/ → repo root (agent-rigger/)
  const thisDir = path.dirname(import.meta.path);
  return path.resolve(thisDir, '..', '..', '..', 'artifacts');
}

// ---------------------------------------------------------------------------
// resolveUserStatePath — manifest path for install
// ---------------------------------------------------------------------------

function resolveManifestPath(env: Env): string {
  return resolveUserTargets(env).stateJson;
}

// ---------------------------------------------------------------------------
// resolveConfigPath
// ---------------------------------------------------------------------------

function resolveConfigPath(env: Env): string {
  const home = resolveUserTargets(env);
  // Config lives in the same dir as state.json
  return path.join(path.dirname(home.stateJson), 'config.json');
}

// ---------------------------------------------------------------------------
// runCli
// ---------------------------------------------------------------------------

/**
 * Route argv to the appropriate command and return the exit code.
 * Does NOT call process.exit — the caller (main) does that.
 *
 * Exit codes:
 *   0  success / help / version / clean abort
 *   2  invalid JSON / unknown command / init parse error
 *   3  check: one or more missing/drifted entries
 *   1  other runtime errors
 */
export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const print = deps.print ?? ((msg: string) => process.stdout.write(msg + '\n'));
  const env: Env = deps.env ?? Bun.env;
  const artifactsDir = deps.artifactsDir ?? resolveArtifactsDir();

  const { command, flags } = parseArgs(argv);

  // --version (check before --help so `--version` alone works)
  if (flags['version'] === true) {
    print(CLI_VERSION);
    return 0;
  }

  // --help or no command
  if (flags['help'] === true || command === undefined) {
    print(USAGE);
    return 0;
  }

  try {
    // ----- check -----
    if (command === 'check') {
      const adapter = await buildClaudeAdapter(env, artifactsDir);

      const scope = (flags['scope'] === 'project' ? 'project' : 'user') as 'user' | 'project';

      // Builtin entries for guardrail + context check
      const entries: AdapterEntry[] = [
        { id: 'guardrails-claude', nature: 'guardrail', scope },
        { id: 'context-claude', nature: 'context', scope },
      ];

      const result = await runCheck({
        adapter,
        entries,
        scope,
        env,
        toolEntries: BUILTIN_CATALOG,
      });

      print(result.output);
      return result.exitCode;
    }

    // ----- install -----
    if (command === 'install') {
      const prompts = deps.prompts ?? (await importUiPrompts());

      const selectedIds = await prompts.selectArtifacts(BUILTIN_CATALOG);
      if (selectedIds.length === 0) {
        print('No artifacts selected — nothing to install.');
        return 0;
      }

      const scope = await prompts.selectScope();
      const adapter = await buildClaudeAdapter(env, artifactsDir);
      const manifestPath = resolveManifestPath(env);

      const result = await runInstall({
        catalog: BUILTIN_CATALOG,
        adapter,
        scope,
        env,
        manifestPath,
        selectedIds,
        confirm: prompts.confirmApply,
      });

      print(result.output);
      return 0;
    }

    // ----- init -----
    if (command === 'init') {
      const prompts = deps.prompts ?? (await importUiPrompts());
      const configPath = resolveConfigPath(env);

      const result = await runInit({
        configPath,
        askUrl: prompts.askUrl,
        askMethod: prompts.askMethod,
      });

      print(result.output);
      return result.ok ? 0 : 1;
    }

    // ----- unknown command -----
    print(`Unknown command: "${command}"\n\n${USAGE}`);
    return 2;
  } catch (err) {
    return handleError(err, print);
  }
}

// ---------------------------------------------------------------------------
// Error handler — maps typed errors to actionable messages + exit codes
// ---------------------------------------------------------------------------

function handleError(err: unknown, print: (msg: string) => void): number {
  if (err instanceof InvalidJsonError) {
    print(`[error] Invalid JSON: ${err.path}`);
    if (err.cause instanceof Error) {
      print(`  Detail: ${err.cause.message}`);
    }
    return 2;
  }

  if (err instanceof PreflightAuthError) {
    print(`[error] Auth failed: ${err.message}`);
    return 1;
  }

  if (err instanceof UnknownEntryError) {
    print(`[error] Unknown artifact: ${err.message}`);
    return 2;
  }

  if (err instanceof DependencyCycleError) {
    print(`[error] Dependency cycle: ${err.message}`);
    return 2;
  }

  if (err instanceof SkillScanBlockedError) {
    print(`[error] Skill scan blocked: ${err.message}`);
    return 1;
  }

  if (err instanceof PluginInstallError) {
    print(`[error] Plugin install failed: ${err.message}`);
    return 1;
  }

  if (err instanceof Error) {
    print(`[error] ${err.message}`);
  } else {
    print('[error] An unexpected error occurred.');
  }

  return 1;
}

// ---------------------------------------------------------------------------
// importUiPrompts — lazy-load real TTY prompts from ui.ts
// ---------------------------------------------------------------------------

/**
 * Lazily import the real clack-backed prompts.
 * Separated so tests can inject fake prompts without importing clack.
 */
async function importUiPrompts(): Promise<CliPrompts> {
  const ui = await import('./ui');
  return {
    selectArtifacts: (entries) => ui.selectArtifacts(entries),
    selectScope: () => ui.selectScope(),
    confirmApply: () => ui.confirmApply(''),
    askUrl: async () => {
      const { text } = await import('@clack/prompts');
      const result = await text({
        message: 'Enter the catalog repository URL:',
        placeholder: 'https://github.com/org/repo.git',
      });
      if (ui.isCancel(result)) {
        ui.cancel('Operation cancelled.');
        return '';
      }
      return result as string;
    },
    askMethod: async () => {
      const { select, isCancel, cancel } = await import('@clack/prompts');
      const result = await select<'provider-cli' | 'https' | 'ssh'>({
        message: 'Select authentication method:',
        options: [
          { value: 'provider-cli', label: 'Provider CLI (gh / glab)' },
          { value: 'https', label: 'HTTPS (credential helper)' },
          { value: 'ssh', label: 'SSH key' },
        ],
      });
      if (isCancel(result)) {
        cancel('Operation cancelled.');
        return 'https';
      }
      return result as 'provider-cli' | 'https' | 'ssh';
    },
  };
}

// ---------------------------------------------------------------------------
// main — called only when executed directly
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}

if (import.meta.main) {
  await main();
}
