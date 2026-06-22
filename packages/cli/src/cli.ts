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
  EmptyDenyArtifactError,
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

import {
  BUILTIN_CATALOG,
  mergeCatalogs,
  readCatalogDir,
  resolveVersion,
  type TmpDirFactory,
  withRemoteCheckout,
} from '@agent-rigger/catalog';
import { DependencyCycleError, resolve, UnknownEntryError } from '@agent-rigger/catalog/resolver';
import { type CommandRunner, defaultRunner } from '@agent-rigger/catalog/tool-check';
import { runCheck } from './cmd-check';
import { runInit } from './cmd-init';
import { runInstall } from './cmd-install';
import type { RunLsResult } from './cmd-ls';
import { RESOURCE_NATURE_MAP, runLs } from './cmd-ls';
import { runRemove, UnknownRemoveIdError } from './cmd-remove';
import { loadConfig } from './config';
import { PreflightAuthError } from './preflight-auth';
import { defaultTmpFactory, fetchRemoteCatalog } from './remote';
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

Resource commands (available verbs: ls, add, info, check, remove):
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
  remove <id...>           Uninstall ids (any resource type).
  remove <id...> --yes     Uninstall without confirmation prompt.

Planned (not yet implemented):
  <resource> update <id>   Update an installed artifact.

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
  agent-rigger init
`;

// ---------------------------------------------------------------------------
// CliDeps — injectable dependencies
// ---------------------------------------------------------------------------

/** Prompt callbacks injected by the CLI entry or tests. */
export interface CliPrompts {
  selectArtifacts: (entries: typeof BUILTIN_CATALOG) => Promise<string[]>;
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
   */
  remote?: { run?: CommandRunner; tmpFactory?: TmpDirFactory };
}

// ---------------------------------------------------------------------------
// buildClaudeAdapter — mount adapter from real artifacts
// ---------------------------------------------------------------------------

/**
 * Options for the external-resolver seam in buildClaudeAdapter.
 *
 * @param externalIds      Set of artifact ids (e.g. 'skill:x', 'agent:y') whose
 *                         source should be resolved from externalBaseDir instead of
 *                         the local artifactsDir. Both fields must be provided
 *                         together for the seam to activate.
 * @param externalBaseDir  Absolute path to the root of a remote checkout. Expected
 *                         layout: skills/<name>/ and agents/<name>.md.
 */
export interface BuildClaudeAdapterOpts {
  externalIds?: Set<string>;
  externalBaseDir?: string;
}

/**
 * Build a ClaudeAdapter from the artifacts directory.
 *
 * - denyRef       : loaded from <artifactsDir>/claude/deny.json
 * - agentsContent : loaded from <artifactsDir>/shared/AGENTS.md
 * - skillSource   : resolves id → <artifactsDir>/claude/skills/<id>
 *                   or <externalBaseDir>/skills/<id> when id is in externalIds
 * - agentSource   : resolves id → <artifactsDir>/claude/agents/<agentId>.md
 *                   or <externalBaseDir>/agents/<agentId>.md when id is in externalIds
 * - pluginSource  : resolves id → { plugin: <pluginId>, marketplace: <cwd>/.claude-plugin/marketplace.json }
 * - scanner       : stubScanner (M0: always passes)
 *
 * @param opts  Optional external-resolver seam for remote installs (M1b-4).
 *              Omitting opts → existing behaviour unchanged (100% rétro-compatible).
 */
export async function buildClaudeAdapter(
  _env: Env,
  artifactsDir: string,
  opts?: BuildClaudeAdapterOpts,
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
    skillSource: (entry) => {
      const name = entry.id.replace(/^skill:/, '');
      if (
        opts?.externalIds?.has(entry.id) === true
        && opts.externalBaseDir !== undefined
      ) {
        return path.join(opts.externalBaseDir, 'skills', name);
      }
      return path.join(artifactsDir, 'claude', 'skills', name);
    },
    agentSource: (entry) => {
      const name = entry.id.replace(/^agent:/, '');
      if (
        opts?.externalIds?.has(entry.id) === true
        && opts.externalBaseDir !== undefined
      ) {
        return path.join(opts.externalBaseDir, 'agents', name + '.md');
      }
      return path.join(artifactsDir, 'claude', 'agents', name + '.md');
    },
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
// resolveEffectiveCatalog — built-in ∪ remote (best-effort)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective catalog for ls commands.
 *
 * - Loads the user config to check for a catalogUrl.
 * - If catalogUrl is configured, attempts to fetch the remote catalog and
 *   merges it with the built-in (built-in entries win on id collision).
 * - If the fetch fails for any reason, prints a warning and falls back to
 *   the built-in catalog. Exit 0 is preserved — ls is best-effort.
 * - If no catalogUrl is configured, returns BUILTIN_CATALOG unchanged.
 */
async function resolveEffectiveCatalog(
  env: Env,
  print: (msg: string) => void,
  remote: CliDeps['remote'],
): Promise<typeof BUILTIN_CATALOG> {
  const config = await loadCliConfig(env);

  if (!config.catalogUrl) {
    return BUILTIN_CATALOG;
  }

  const remoteFetchOpts: Parameters<typeof fetchRemoteCatalog>[0] = {
    catalogUrl: config.catalogUrl,
  };
  if (remote?.run !== undefined) remoteFetchOpts.run = remote.run;
  if (remote?.tmpFactory !== undefined) remoteFetchOpts.tmpFactory = remote.tmpFactory;

  try {
    const { entries } = await fetchRemoteCatalog(remoteFetchOpts);
    const effective = mergeCatalogs(BUILTIN_CATALOG, entries);
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
    return BUILTIN_CATALOG;
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
      const adapter = await buildClaudeAdapter(env, artifactsDir);

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

    // Validate each id belongs to the resource
    const invalidIds = ids.filter((id) => {
      const entry = BUILTIN_CATALOG.find((e) => e.id === id);
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

    const entry = BUILTIN_CATALOG.find((e) => e.id === id);
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

    // Filter catalog to get artifact entries of this nature
    const adapterNature = natureMapped as
      | 'plugin'
      | 'guardrail'
      | 'context'
      | 'skill'
      | 'agent'
      | 'mcp'
      | 'tool';
    const filteredEntries: AdapterEntry[] = BUILTIN_CATALOG
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
      toolEntries: BUILTIN_CATALOG,
    });

    print(result.output);
    return result.exitCode;
  }

  // ----- <resource> remove <id...> -----
  if (verb === 'remove') {
    if (ids.length === 0) {
      print(`[error] "${resource} remove" requires at least one artifact id.\n\n${USAGE}`);
      return 2;
    }

    // Validate each id belongs to the resource
    const invalidIds = ids.filter((id) => {
      const entry = BUILTIN_CATALOG.find((e) => e.id === id);
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
      // Remote install path: checkout the content repo, merge catalogs, install.
      const catalogUrl = config.catalogUrl;
      const runner: CommandRunner = deps.remote?.run ?? defaultRunner;
      const tmpFactory: TmpDirFactory = deps.remote?.tmpFactory ?? defaultTmpFactory;

      const version = await resolveVersion(catalogUrl, runner);

      const result = await withRemoteCheckout(
        catalogUrl,
        version.ref,
        runner,
        { tmpFactory },
        async (dir) => {
          const remoteEntries = await readCatalogDir(dir);
          const { entries: effective } = mergeCatalogs(BUILTIN_CATALOG, remoteEntries);
          const resolved = resolve(ids, effective);
          const externalIds = new Set(
            resolved.filter((e) => e.source === 'external').map((e) => e.id),
          );
          const adapter = await buildClaudeAdapter(env, artifactsDir, {
            externalIds,
            externalBaseDir: dir,
          });
          const versionFor = (
            entry: { id: string },
          ): { source: 'internal' | 'external'; ref: string; sha: string } => {
            if (externalIds.has(entry.id)) {
              return { source: 'external', ref: version.ref, sha: version.sha };
            }
            return { source: 'internal', ref: 'v0.0.0', sha: '' };
          };
          return runInstall({
            catalog: effective,
            adapter,
            scope,
            env,
            manifestPath,
            selectedIds: ids,
            confirm,
            versionFor,
            toolRunner: runner,
          });
        },
      );

      print(result.output);
      return 0;
    }

    // Local install path (no catalogUrl configured): use BUILTIN_CATALOG.
    const adapter = await buildClaudeAdapter(env, artifactsDir);

    const result = await runInstall({
      catalog: BUILTIN_CATALOG,
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

  // Interactive: no ids — use selectArtifacts prompt
  const prompts = deps.prompts ?? (await importUiPrompts());

  const selectedIds = await prompts.selectArtifacts(BUILTIN_CATALOG);
  if (selectedIds.length === 0) {
    print('No artifacts selected — nothing to install.');
    return 0;
  }

  const interactiveScope = await prompts.selectScope();
  const adapter = await buildClaudeAdapter(env, artifactsDir);
  const manifestPath = resolveManifestPath(env);

  const result = await runInstall({
    catalog: BUILTIN_CATALOG,
    adapter,
    scope: interactiveScope,
    env,
    manifestPath,
    selectedIds,
    confirm: (planText) => prompts.confirmApply(planText),
  });

  print(result.output);
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

  let confirm: boolean | ((planText: string) => Promise<boolean>);
  if (yes) {
    confirm = true;
  } else {
    const prompts = deps.prompts ?? (await importUiPrompts());
    confirm = (planText: string) => prompts.confirmApply(planText);
  }

  const result = await runRemove({
    catalog: BUILTIN_CATALOG,
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
// Error handler — maps typed errors to actionable messages + exit codes
// ---------------------------------------------------------------------------

function handleError(err: unknown, print: (msg: string) => void): number {
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
