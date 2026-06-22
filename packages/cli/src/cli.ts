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
 * - No BUILTIN_CATALOG: all content comes from the fetched remote catalog.
 *   Without catalogUrl → catalog is empty (actionable message).
 */

import path from 'node:path';

import {
  EmptyDenyArtifactError,
  PluginInstallError,
  SkillScanBlockedError,
} from '@agent-rigger/adapters';
import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { UnsafeArtifactNameError } from '@agent-rigger/core/artifact-name';
import { InvalidJsonError } from '@agent-rigger/core/fs-json';
import type { Env } from '@agent-rigger/core/paths';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Scanner } from '@agent-rigger/core/scan';

import {
  type CatalogEntry,
  isUpdateAvailable,
  mergeCatalogs,
  resolveVersion,
  type TmpDirFactory,
} from '@agent-rigger/catalog';
import { DependencyCycleError, UnknownEntryError } from '@agent-rigger/catalog/resolver';
import { type CommandRunner, defaultRunner } from '@agent-rigger/catalog/tool-check';
import { buildClaudeAdapter } from './adapter-builder';
export { buildClaudeAdapter } from './adapter-builder';
export type { BuildClaudeAdapterOpts } from './adapter-builder';
import { runCheck } from './cmd-check';
import { runInit } from './cmd-init';
import type { RunLsResult } from './cmd-ls';
import { RESOURCE_NATURE_MAP, runLs } from './cmd-ls';
import { runRemove, UnknownRemoveIdError } from './cmd-remove';
import { runUpdate } from './cmd-update';
import { loadConfig } from './config';
import { PreflightAuthError } from './preflight-auth';
import { CatalogUrlMissingError, defaultTmpFactory, fetchRemoteCatalog } from './remote';
import { runRemoteInstall, ScanBlockedError } from './remote-install';
import { renderEntryInfo } from './ui';

// ---------------------------------------------------------------------------
// Version — sourced from package.json at build time; fallback to "0.0.0"
// ---------------------------------------------------------------------------

const CLI_VERSION = '0.0.0';

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

/**
 * Known resource tokens (singular + plural aliases).
 *
 * "catalog" is treated as a resource alias for listing all entries.
 */
const KNOWN_RESOURCES = new Set(Object.keys(RESOURCE_NATURE_MAP));

/** Result of parsing argv. */
export interface ParsedArgs {
  /**
   * Primary command token.
   *   - workflow commands: 'check' | 'install' | 'init' | 'ls'
   *   - resource commands: the resource name (e.g. 'skills', 'guardrails')
   */
  command: string | undefined;
  /** Verb following a resource command, e.g. 'ls' or 'install'. Undefined when not a resource. */
  resourceVerb: string | undefined;
  /**
   * Non-flag positional arguments after the verb (ids for install).
   * Also populated for top-level `install <id...>`.
   */
  resourceIds: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Parse a hybrid CLI argv array.
 *
 * Grammar:
 *   <workflow-command> [flags]
 *   install [<id...>] [--yes] [--scope=...]
 *   ls [--scope=...]
 *   <resource> ls [--scope=...]
 *   <resource> install <id...> [--yes] [--scope=...]
 *
 * - First non-flag token is `command`.
 * - When command is a known resource: second non-flag token is `resourceVerb`,
 *   remaining non-flag tokens are `resourceIds`.
 * - When command is 'install': remaining non-flag tokens are `resourceIds`
 *   (non-interactive if non-empty; interactive if empty).
 * - --key=value → flags[key] = value
 * - --key       → flags[key] = true
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const resourceIds: string[] = [];
  const flags: Record<string, string | boolean> = {};

  // Collect flags and positional tokens in order.
  const positionals: string[] = [];

  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const rest = arg.slice(2);
      const eqIdx = rest.indexOf('=');
      if (eqIdx === -1) {
        flags[rest] = true;
      } else {
        flags[rest.slice(0, eqIdx)] = rest.slice(eqIdx + 1);
      }
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length === 0) {
    return { command: undefined, resourceVerb: undefined, resourceIds, flags };
  }

  // positionals.length > 0 is established above; positionals[0] is defined.
  const command = positionals[0] as string;

  // Resource grammar: <resource> <verb> [ids...]
  if (KNOWN_RESOURCES.has(command)) {
    const resourceVerb = positionals[1];
    resourceIds.push(...positionals.slice(2));
    return { command, resourceVerb, resourceIds, flags };
  }

  // Top-level install with optional ids: install [<id...>]
  if (command === 'install') {
    resourceIds.push(...positionals.slice(1));
    return { command, resourceVerb: undefined, resourceIds, flags };
  }

  // Top-level remove with required ids: remove <id...>
  if (command === 'remove') {
    resourceIds.push(...positionals.slice(1));
    return { command, resourceVerb: undefined, resourceIds, flags };
  }

  // Top-level update with optional ids: update [<id...>]
  if (command === 'update') {
    resourceIds.push(...positionals.slice(1));
    return { command, resourceVerb: undefined, resourceIds, flags };
  }

  // All other commands (check, init, ls, --help, --version, unknown)
  return { command, resourceVerb: undefined, resourceIds, flags };
}

// ---------------------------------------------------------------------------
// Usage text
// ---------------------------------------------------------------------------

const USAGE = `\
agent-rigger — Claude Code guardrail & context installer

Usage:
  agent-rigger <command> [options]
  agent-rigger <resource> <verb> [args] [options]

Workflow commands:
  check                    Audit whether guardrails and context are correctly installed.
  install                  Install selected artifacts interactively.
  install <id...>          Install specified artifact ids non-interactively.
  install <id...> --yes    Install without confirmation prompt.
  init                     First-launch wizard: configure catalog URL and auth method.

Discovery commands:
  ls                       List all catalog entries with install status.
  catalog ls               Same as ls.

Update commands:
  update <id...>           Update specified external artifact ids to the latest remote version.
  update <id...> --yes     Update without confirmation prompt.
  update                   Update all installed external artifacts.

Resource commands (available verbs: ls, add, info, check, remove, update):
  <resource> ls            List entries filtered by resource type.
  <resource> add <id...>   Install ids validated against the resource type.
  <resource> add <id...> --yes
                           Install without confirmation prompt.
  <resource> info <id>     Show details for a catalog entry.
  <resource> check         Audit entries for this resource type only.
  <resource> remove <id...>
                           Uninstall specified artifact ids.
  <resource> remove <id...> --yes
                           Uninstall without confirmation prompt.
  <resource> update <id...>
                           Update specified artifact ids (remote catalog required).
  <resource> update <id...> --yes
                           Update without confirmation prompt.
  remove <id...>           Uninstall ids (any resource type).
  remove <id...> --yes     Uninstall without confirmation prompt.

Resources:
  skill | skills           Workflow skills.
  agent | agents           Role-specialised sub-agents.
  guardrail | guardrails   Claude deny rules and safety guardrails.
  context | contexts       Claude context and AGENTS.md entries.
  plugin | plugins         Claude Code plugins.
  tool | tools             Host system tools (advisory check only).
  pack | packs             Named bundles of multiple entries.

Options:
  --scope=<user|project>  Installation scope (default: user).
  --yes                   Skip confirmation prompt (non-interactive install only).
  --help                  Show this help message.
  --version               Show CLI version.

Examples:
  agent-rigger check
  agent-rigger ls
  agent-rigger skills ls
  agent-rigger guardrails add guardrails-claude --yes
  agent-rigger guardrails info guardrails-claude
  agent-rigger guardrails check
  agent-rigger install --scope=user
  agent-rigger update --yes
  agent-rigger skills update skill:remote-demo --yes
  agent-rigger init
`;

// ---------------------------------------------------------------------------
// CliDeps — injectable dependencies
// ---------------------------------------------------------------------------

/** Prompt callbacks injected by the CLI entry or tests. */
export interface CliPrompts {
  selectArtifacts: (entries: CatalogEntry[]) => Promise<string[]>;
  selectScope: () => Promise<'user' | 'project'>;
  confirmApply: (planText: string) => Promise<boolean>;
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
  /**
   * Remote seam for testing — injected into fetchRemoteCatalog.
   * Production code uses defaultRunner + defaultTmpFactory.
   * `scanner` is forwarded to runRemoteInstall/runUpdate so tests can bypass
   * the real composite scanner (gitleaks/trivy) without affecting prod behaviour.
   */
  remote?: { run?: CommandRunner; tmpFactory?: TmpDirFactory; scanner?: Scanner };
}

// buildClaudeAdapter + BuildClaudeAdapterOpts are defined and exported from adapter-builder.ts.
// They are re-exported at the top of this file so existing consumers of "cli.ts" are unaffected.

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
// loadCliConfig — load resolved config for the current env
// ---------------------------------------------------------------------------

/**
 * Load the effective CLI config from user + project config files and env vars.
 *
 * Shared by resolveEffectiveCatalog and handleInstall to avoid duplicating
 * the path-resolution + loadConfig plumbing.
 */
async function loadCliConfig(env: Env): Promise<Awaited<ReturnType<typeof loadConfig>>> {
  const userConfigPath = resolveConfigPath(env);
  const projectConfigPath = path.join(process.cwd(), '.agent-rigger', 'config.json');
  return loadConfig({
    userConfigPath,
    projectConfigPath,
    env: env as Record<string, string | undefined>,
  });
}

// ---------------------------------------------------------------------------
// resolveEffectiveCatalog — remote only (no builtin fallback)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective catalog for ls commands.
 *
 * - Loads the user config to check for a catalogUrl.
 * - If catalogUrl is configured, attempts to fetch the remote catalog.
 *   On fetch failure: prints a warning and returns [] (empty, actionable).
 * - If no catalogUrl is configured: returns [] with an actionable message.
 */
async function resolveEffectiveCatalog(
  env: Env,
  print: (msg: string) => void,
  remote: CliDeps['remote'],
): Promise<CatalogEntry[]> {
  const config = await loadCliConfig(env);

  if (!config.catalogUrl) {
    print('aucun catalog configuré — lance `agent-rigger init`');
    return [];
  }

  const remoteFetchOpts: Parameters<typeof fetchRemoteCatalog>[0] = {
    catalogUrl: config.catalogUrl,
  };
  if (remote?.run !== undefined) remoteFetchOpts.run = remote.run;
  if (remote?.tmpFactory !== undefined) remoteFetchOpts.tmpFactory = remote.tmpFactory;

  try {
    const { entries } = await fetchRemoteCatalog(remoteFetchOpts);
    const effective = mergeCatalogs([], entries);
    if (effective.conflicts.length > 0) {
      print(
        `[warning] ${effective.conflicts.length} remote entr${
          effective.conflicts.length === 1 ? 'y' : 'ies'
        } shadowed by built-in: ${effective.conflicts.join(', ')}`,
      );
    }
    return effective.entries;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    print(`[warning] Remote catalog unavailable (${msg}). Falling back to built-in catalog.`);
    return [];
  }
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

  const { command, resourceVerb, resourceIds, flags } = parseArgs(argv);

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

  // Validate --scope before entering any command block
  if (flags['scope'] !== undefined && flags['scope'] !== 'user' && flags['scope'] !== 'project') {
    print(`[error] Invalid --scope value: "${flags['scope']}". Must be "user" or "project".`);
    return 2;
  }

  const scope = (flags['scope'] === 'project' ? 'project' : 'user') as 'user' | 'project';

  try {
    // ----- ls (top-level) -----
    if (command === 'ls') {
      const effective = await resolveEffectiveCatalog(env, print, deps.remote);
      if (effective.length === 0) {
        return 0;
      }
      const result = await runLs({ catalog: effective, env, scope });
      print(result.output);
      return 0;
    }

    // ----- resource commands: <resource> <verb> [ids...] -----
    if (RESOURCE_NATURE_MAP[command] !== undefined) {
      return await handleResourceCommand({
        resource: command,
        verb: resourceVerb,
        ids: resourceIds,
        flags,
        scope,
        env,
        artifactsDir,
        print,
        deps,
      });
    }

    // ----- check -----
    if (command === 'check') {
      const effective = await resolveEffectiveCatalog(env, print, deps.remote);

      if (effective.length === 0) {
        return 0;
      }

      // Entries for check: all guardrails and contexts in the effective catalog.
      // (No hardcoded ids — catalog is fully remote, content comes from catalogUrl.)
      const entries: AdapterEntry[] = effective
        .filter(
          (e) => e.kind === 'artifact' && (e.nature === 'guardrail' || e.nature === 'context'),
        )
        .map((e) => ({
          id: e.id,
          nature: (e as { nature: 'guardrail' | 'context' }).nature,
          scope,
        }));

      // Best-effort update-available annotation (R22.4).
      // Always run when catalog is non-empty, independent of guardrail/context presence.
      // Never throws: failures are silently swallowed so check exit code is unaffected.
      const updateLines = await resolveUpdateAvailable(env, scope, deps.remote);

      if (entries.length === 0) {
        // Catalog has entries but no guardrail/context to check.
        // Still show update-available annotation if relevant.
        if (updateLines.length > 0) {
          print(updateLines.join('\n'));
        }
        return 0;
      }

      const adapter = await buildClaudeAdapter(env, artifactsDir);

      const result = await runCheck({
        adapter,
        entries,
        scope,
        env,
        toolEntries: effective,
      });

      print(result.output);

      if (updateLines.length > 0) {
        print(updateLines.join('\n'));
      }

      return result.exitCode;
    }

    // ----- install -----
    if (command === 'install') {
      return await handleInstall({
        ids: resourceIds,
        flags,
        scope,
        env,
        artifactsDir,
        print,
        deps,
      });
    }

    // ----- remove -----
    if (command === 'remove') {
      return await handleRemove({
        ids: resourceIds,
        flags,
        scope,
        env,
        artifactsDir,
        print,
        deps,
      });
    }

    // ----- update -----
    if (command === 'update') {
      return await handleUpdate({
        ids: resourceIds,
        flags,
        scope,
        env,
        artifactsDir,
        print,
        deps,
      });
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
// handleResourceCommand — route <resource> <verb> [ids...]
// ---------------------------------------------------------------------------

interface ResourceCommandOpts {
  resource: string;
  verb: string | undefined;
  ids: string[];
  flags: Record<string, string | boolean>;
  scope: 'user' | 'project';
  env: Env;
  artifactsDir: string;
  print: (msg: string) => void;
  deps: CliDeps;
}

async function handleResourceCommand(opts: ResourceCommandOpts): Promise<number> {
  const { resource, verb, ids, flags, scope, env, artifactsDir, print, deps } = opts;

  const natureMapped = RESOURCE_NATURE_MAP[resource] ?? 'catalog';

  // ----- <resource> ls -----
  if (verb === 'ls' || verb === undefined) {
    const effectiveCatalog = await resolveEffectiveCatalog(env, print, deps.remote);
    if (effectiveCatalog.length === 0) {
      return 0;
    }
    let result: RunLsResult;
    if (natureMapped === 'catalog') {
      result = await runLs({ catalog: effectiveCatalog, env, scope });
    } else {
      result = await runLs({ catalog: effectiveCatalog, env, scope, resourceFilter: natureMapped });
    }
    print(result.output);
    return 0;
  }

  // ----- <resource> add <id...> -----
  if (verb === 'add') {
    if (ids.length === 0) {
      print(`[error] "${resource} add" requires at least one artifact id.\n\n${USAGE}`);
      return 2;
    }

    // Validate each id belongs to the resource — check against effective catalog
    const effectiveCatalog = await resolveEffectiveCatalog(env, print, deps.remote);
    const invalidIds = ids.filter((id) => {
      const entry = effectiveCatalog.find((e) => e.id === id);
      if (entry === undefined) return false; // will fail at resolve time with a better error
      if (natureMapped === 'pack') return entry.kind !== 'pack';
      return entry.kind !== 'artifact' || entry.nature !== natureMapped;
    });

    if (invalidIds.length > 0) {
      const singular = resource.replace(/s$/, '');
      for (const id of invalidIds) {
        print(`[error] id "${id}" is not a ${singular}`);
      }
      return 2;
    }

    return await handleInstall({ ids, flags, scope, env, artifactsDir, print, deps });
  }

  // ----- <resource> info <id> -----
  if (verb === 'info') {
    const id = ids[0];
    if (id === undefined) {
      print(`[error] "${resource} info" requires an artifact id.\n\n${USAGE}`);
      return 2;
    }

    const effectiveCatalog = await resolveEffectiveCatalog(env, print, deps.remote);
    const entry = effectiveCatalog.find((e) => e.id === id);
    if (entry === undefined) {
      print(`[error] Unknown artifact id "${id}". Run "agent-rigger ls" to see available entries.`);
      return 2;
    }

    // Read manifest to determine installed status
    const targets = resolveUserTargets(env);
    let installed = false;
    try {
      const { readManifest } = await import('@agent-rigger/core/manifest');
      const manifest = await readManifest(targets.stateJson);
      installed = manifest.artifacts.some((a) => a.id === id && a.scope === scope);
    } catch {
      installed = false;
    }

    print(renderEntryInfo(entry, { installed }));
    return 0;
  }

  // ----- <resource> check -----
  if (verb === 'check') {
    if (natureMapped === 'pack') {
      print(
        '[error] "packs check" is not supported — packs are bundles, not installable directly.',
      );
      return 2;
    }

    const effectiveCatalog = await resolveEffectiveCatalog(env, print, deps.remote);

    if (effectiveCatalog.length === 0) {
      return 0;
    }

    // Filter catalog to get artifact entries of this nature
    const adapterNature = natureMapped as
      | 'plugin'
      | 'guardrail'
      | 'context'
      | 'skill'
      | 'agent'
      | 'mcp'
      | 'tool';
    const filteredEntries: AdapterEntry[] = effectiveCatalog
      .filter((e) => e.kind === 'artifact' && e.nature === adapterNature)
      .map((e) => ({ id: e.id, nature: adapterNature, scope }));

    if (filteredEntries.length === 0) {
      print(`No ${resource} entries in catalog.`);
      return 0;
    }

    const adapter = await buildClaudeAdapter(env, artifactsDir);
    const result = await runCheck({
      adapter,
      entries: filteredEntries,
      scope,
      env,
      toolEntries: effectiveCatalog,
    });

    print(result.output);

    // Best-effort update-available annotation (same as top-level check).
    const updateLines = await resolveUpdateAvailable(env, scope, deps.remote);
    if (updateLines.length > 0) {
      print(updateLines.join('\n'));
    }

    return result.exitCode;
  }

  // ----- <resource> update <id...> -----
  if (verb === 'update') {
    if (ids.length === 0) {
      print(`[error] "${resource} update" requires at least one artifact id.\n\n${USAGE}`);
      return 2;
    }

    // Validate each id belongs to the resource.
    // For external entries (not in effective catalog): infer nature from id prefix.
    const singular = resource.replace(/s$/, '');
    const effectiveCatalog = await resolveEffectiveCatalog(env, print, deps.remote);
    const invalidIds = ids.filter((id) => {
      const catalogEntry = effectiveCatalog.find((e) => e.id === id);
      if (catalogEntry !== undefined) {
        if (natureMapped === 'pack') return catalogEntry.kind !== 'pack';
        return catalogEntry.kind !== 'artifact' || catalogEntry.nature !== natureMapped;
      }
      // For external ids: infer nature from known prefixes.
      const PREFIX_TO_NATURE: Record<string, string> = {
        'skill:': 'skill',
        'agent:': 'agent',
        'guardrail:': 'guardrail',
        'context:': 'context',
        'plugin:': 'plugin',
        'tool:': 'tool',
        'pack:': 'pack',
      };
      for (const [prefix, nature] of Object.entries(PREFIX_TO_NATURE)) {
        if (id.startsWith(prefix)) {
          return nature !== natureMapped;
        }
      }
      return false; // unknown prefix → let runUpdate handle it
    });

    if (invalidIds.length > 0) {
      for (const id of invalidIds) {
        print(`[error] id "${id}" is not a ${singular}`);
      }
      return 2;
    }

    return await handleUpdate({ ids, flags, scope, env, artifactsDir, print, deps });
  }

  // ----- <resource> remove <id...> -----
  if (verb === 'remove') {
    if (ids.length === 0) {
      print(`[error] "${resource} remove" requires at least one artifact id.\n\n${USAGE}`);
      return 2;
    }

    // Validate each id belongs to the resource — check against effective catalog
    const effectiveCatalog = await resolveEffectiveCatalog(env, print, deps.remote);
    const invalidIds = ids.filter((id) => {
      const entry = effectiveCatalog.find((e) => e.id === id);
      if (entry === undefined) return false; // will fail at runRemove time with a better error
      if (natureMapped === 'pack') return entry.kind !== 'pack';
      return entry.kind !== 'artifact' || entry.nature !== natureMapped;
    });

    if (invalidIds.length > 0) {
      const singular = resource.replace(/s$/, '');
      for (const id of invalidIds) {
        print(`[error] id "${id}" is not a ${singular}`);
      }
      return 2;
    }

    return await handleRemove({ ids, flags, scope, env, artifactsDir, print, deps });
  }

  // ----- unknown verb (includes planned: update) -----
  print(`Unknown verb "${verb ?? ''}" for resource "${resource}".\n\n${USAGE}`);
  return 2;
}

// ---------------------------------------------------------------------------
// handleInstall — shared install logic (interactive or non-interactive)
// ---------------------------------------------------------------------------

interface HandleInstallOpts {
  ids: string[];
  flags: Record<string, string | boolean>;
  scope: 'user' | 'project';
  env: Env;
  artifactsDir: string;
  print: (msg: string) => void;
  deps: CliDeps;
}

async function handleInstall(opts: HandleInstallOpts): Promise<number> {
  const { ids, flags, scope, env, artifactsDir, print, deps } = opts;

  const yes = flags['yes'] === true;
  const force = flags['force'] === true;

  // Non-interactive: ids provided on the command line
  if (ids.length > 0) {
    const manifestPath = resolveManifestPath(env);

    // Determine confirmation strategy
    let confirm: boolean | ((planText: string) => Promise<boolean>);
    if (yes) {
      // --yes: skip confirmation entirely
      confirm = true;
    } else {
      // No --yes: show plan and ask confirmation via prompt
      const prompts = deps.prompts ?? (await importUiPrompts());
      confirm = (planText: string) => prompts.confirmApply(planText);
    }

    // Load config to check for a remote catalog URL.
    const config = await loadCliConfig(env);

    if (config.catalogUrl !== undefined && config.catalogUrl !== '') {
      // Remote install path: delegate to runRemoteInstall.
      const catalogUrl = config.catalogUrl;
      const runner: CommandRunner = deps.remote?.run ?? defaultRunner;
      const tmpFactory: TmpDirFactory = deps.remote?.tmpFactory ?? defaultTmpFactory;

      const remoteOpts = {
        ids,
        catalogUrl,
        scope,
        env,
        manifestPath,
        artifactsDir,
        runner,
        tmpFactory,
        confirm,
        ...(force ? { force } : {}),
        ...(deps.remote?.scanner === undefined ? {} : { scanner: deps.remote.scanner }),
      };

      const result = await runRemoteInstall(remoteOpts);

      print(result.output);
      return 0;
    }

    // No catalogUrl configured → actionable message, nothing to install locally
    print('aucun catalog configuré — lance `agent-rigger init`');
    return 0;
  }

  // Interactive: no ids — use selectArtifacts prompt with effective catalog (remote only).
  const prompts = deps.prompts ?? (await importUiPrompts());

  const effective = await resolveEffectiveCatalog(env, print, deps.remote);

  if (effective.length === 0) {
    return 0;
  }

  const selectedIds = await prompts.selectArtifacts(effective);
  if (selectedIds.length === 0) {
    print('No artifacts selected — nothing to install.');
    return 0;
  }

  const interactiveScope = await prompts.selectScope();
  const interactiveManifestPath = resolveManifestPath(env);
  const interactiveConfig = await loadCliConfig(env);

  if (interactiveConfig.catalogUrl !== undefined && interactiveConfig.catalogUrl !== '') {
    // Remote interactive path: use runRemoteInstall so external entries are sourced correctly.
    const catalogUrl = interactiveConfig.catalogUrl;
    const runner: CommandRunner = deps.remote?.run ?? defaultRunner;
    const tmpFactory: TmpDirFactory = deps.remote?.tmpFactory ?? defaultTmpFactory;

    const interactiveOpts = {
      ids: selectedIds,
      catalogUrl,
      scope: interactiveScope,
      env,
      manifestPath: interactiveManifestPath,
      artifactsDir,
      runner,
      tmpFactory,
      confirm: (planText: string) => prompts.confirmApply(planText),
      ...(force ? { force } : {}),
      ...(deps.remote?.scanner === undefined ? {} : { scanner: deps.remote.scanner }),
    };

    const remoteResult = await runRemoteInstall(interactiveOpts);

    print(remoteResult.output);
    return 0;
  }

  // No catalogUrl configured → actionable message
  print('aucun catalog configuré — lance `agent-rigger init`');
  return 0;
}

// ---------------------------------------------------------------------------
// handleRemove — shared remove logic
// ---------------------------------------------------------------------------

interface HandleRemoveOpts {
  ids: string[];
  flags: Record<string, string | boolean>;
  scope: 'user' | 'project';
  env: Env;
  artifactsDir: string;
  print: (msg: string) => void;
  deps: CliDeps;
}

async function handleRemove(opts: HandleRemoveOpts): Promise<number> {
  const { ids, flags, scope, env, artifactsDir, print, deps } = opts;

  if (ids.length === 0) {
    print(`[error] "remove" requires at least one artifact id.\n\n${USAGE}`);
    return 2;
  }

  const yes = flags['yes'] === true;
  const adapter = await buildClaudeAdapter(env, artifactsDir);
  const manifestPath = resolveManifestPath(env);

  // Build effective catalog for remove (entries in manifest)
  const effectiveCatalog = await resolveEffectiveCatalog(env, print, deps.remote);

  let confirm: boolean | ((planText: string) => Promise<boolean>);
  if (yes) {
    confirm = true;
  } else {
    const prompts = deps.prompts ?? (await importUiPrompts());
    confirm = (planText: string) => prompts.confirmApply(planText);
  }

  const result = await runRemove({
    catalog: effectiveCatalog,
    adapter,
    scope,
    env,
    manifestPath,
    selectedIds: ids,
    confirm,
  });

  print(result.output);
  return 0;
}

// ---------------------------------------------------------------------------
// handleUpdate — shared update logic
// ---------------------------------------------------------------------------

interface HandleUpdateOpts {
  ids: string[];
  flags: Record<string, string | boolean>;
  scope: 'user' | 'project';
  env: Env;
  artifactsDir: string;
  print: (msg: string) => void;
  deps: CliDeps;
}

async function handleUpdate(opts: HandleUpdateOpts): Promise<number> {
  const { ids, flags, scope, env, artifactsDir, print, deps } = opts;

  const config = await loadCliConfig(env);

  if (!config.catalogUrl) {
    throw new CatalogUrlMissingError();
  }

  const yes = flags['yes'] === true;
  const force = flags['force'] === true;
  const runner: CommandRunner = deps.remote?.run ?? defaultRunner;
  const tmpFactory: TmpDirFactory = deps.remote?.tmpFactory ?? defaultTmpFactory;

  let confirm: boolean | ((planText: string) => Promise<boolean>);
  if (yes) {
    confirm = true;
  } else {
    const prompts = deps.prompts ?? (await importUiPrompts());
    confirm = (planText: string) => prompts.confirmApply(planText);
  }

  const updateOpts = {
    ids,
    scope,
    env,
    manifestPath: resolveManifestPath(env),
    artifactsDir,
    catalogUrl: config.catalogUrl,
    runner,
    tmpFactory,
    confirm,
    ...(force ? { force } : {}),
    ...(deps.remote?.scanner === undefined ? {} : { scanner: deps.remote.scanner }),
  };

  const result = await runUpdate(updateOpts);

  print(result.output);
  return 0;
}

// ---------------------------------------------------------------------------
// resolveUpdateAvailable — best-effort update-available annotation for check
// ---------------------------------------------------------------------------

/**
 * Returns formatted lines listing external entries with newer remote versions.
 * Best-effort: any error → returns [] (never throws).
 * Zero writes.
 */
async function resolveUpdateAvailable(
  env: Env,
  scope: 'user' | 'project',
  remote: CliDeps['remote'],
): Promise<string[]> {
  try {
    const config = await loadCliConfig(env);
    if (!config.catalogUrl) return [];

    const runner: CommandRunner = remote?.run ?? defaultRunner;
    const remoteVersion = await resolveVersion(config.catalogUrl, runner);

    const { readManifest } = await import('@agent-rigger/core/manifest');
    const manifestPath = resolveManifestPath(env);
    const manifest = await readManifest(manifestPath);

    const staleIds = manifest.artifacts
      .filter((e) => e.scope === scope && e.ref !== 'v0.0.0')
      .filter((e) => isUpdateAvailable(e.ref, remoteVersion))
      .map((e) => `  [update available]  ${e.id}  ${e.ref} → ${remoteVersion.ref}`);

    if (staleIds.length === 0) return [];

    return ['', '--- Updates ---', ...staleIds];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Error handler — maps typed errors to actionable messages + exit codes
// ---------------------------------------------------------------------------

function handleError(err: unknown, print: (msg: string) => void): number {
  if (err instanceof CatalogUrlMissingError) {
    print('[error] No catalog URL configured.');
    print('  Run `agent-rigger init` to configure the catalog URL.');
    return 2;
  }

  if (err instanceof EmptyDenyArtifactError) {
    print(`[error] Canonical deny artifact missing or empty: ${err.path}`);
    print('  Ensure deny.json exists and contains at least one rule in the "deny" array.');
    return 1;
  }

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

  if (err instanceof UnsafeArtifactNameError) {
    print(
      `[error] Unsafe artifact id rejected (path traversal attempt): "${err.id}". Only names matching [a-zA-Z0-9._-] are accepted.`,
    );
    return 2;
  }

  if (err instanceof UnknownEntryError) {
    print(`[error] Unknown artifact: ${err.message}`);
    return 2;
  }

  if (err instanceof UnknownRemoveIdError) {
    print(`[error] ${err.message}`);
    return 2;
  }

  if (err instanceof DependencyCycleError) {
    print(`[error] Dependency cycle: ${err.message}`);
    return 2;
  }

  if (err instanceof ScanBlockedError) {
    print(`[error] ${err.message}`);
    return 1;
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
    confirmApply: (planText) => ui.confirmApply(planText),
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
