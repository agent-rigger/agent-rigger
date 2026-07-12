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
  InvalidOpencodeJsonError,
  PluginInstallError,
  SkillScanBlockedError,
} from '@agent-rigger/adapters';
import type { Assistant } from '@agent-rigger/core';
import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { UnsafeArtifactNameError } from '@agent-rigger/core/artifact-name';
import { InvalidJsonError } from '@agent-rigger/core/fs-json';
import { MalformedManifestError } from '@agent-rigger/core/manifest';
import type { Env } from '@agent-rigger/core/paths';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import { ConcurrentRunError } from '@agent-rigger/core/run-lock';
import type { Scanner } from '@agent-rigger/core/scan';

import {
  type CatalogCanon,
  type CatalogEntry,
  fetchCatalog,
  foldCatalogs,
  isUpdateAvailable,
  localId,
  partitionMetaIds,
  qualifyEntries,
  RefShaMismatchError,
  RemoteFetchError,
  resolveVersion,
  type TmpDirFactory,
} from '@agent-rigger/catalog';
import { DependencyCycleError, UnknownEntryError } from '@agent-rigger/catalog/resolver';
import { type CommandRunner, defaultRunner } from '@agent-rigger/catalog/tool-check';
export { buildClaudeAdapter } from './adapter-builder';
export type { BuildClaudeAdapterOpts } from './adapter-builder';
import { buildAdapter } from './adapter-dispatch';
import { detectAssistants, resolveAssistant } from './assistant-select';
import { runCatalog } from './cmd-catalog';
import { runCheck } from './cmd-check';
import { runDoctor, runDoctorState } from './cmd-doctor';
import { runInit } from './cmd-init';
import type { CatalogProposal } from './cmd-init';
import type { RunLsResult } from './cmd-ls';
import { RESOURCE_NATURE_MAP, runLs } from './cmd-ls';
import { NotInstalledError, runRemove } from './cmd-remove';
import { NO_UPDATE_CANDIDATES_MSG, runUpdate } from './cmd-update';
import { LegacyConfigError, loadConfig } from './config';
import { auditableGovernanceIds, type CatalogGovernanceMeta } from './governance';
import { PreflightAuthError } from './preflight-auth';
import { defaultTmpFactory, fetchRemoteCatalog, fetchRemoteCatalogCanon } from './remote';
import {
  ForeignRequireUnsatisfiedError,
  runRemoteInstall,
  ScanBlockedError,
} from './remote-install';
import {
  InvalidSecretEnvFlagError,
  MissingRequiredSecretError,
  parseSecretEnvFlags,
} from './secret-collect';
import {
  ANSI,
  CancelledError,
  paint,
  renderEntryInfo,
  shouldColor,
  type StatusedEntry,
  type StatusInitialValuesOpts,
} from './ui';

import pkg from '../package.json';

// ---------------------------------------------------------------------------
// Version — sourced from package.json, embedded at build time.
// `bun build --compile` inlines this JSON import, so the standalone binary
// reports the package version without reading any file at runtime.
// ---------------------------------------------------------------------------

const CLI_VERSION: string = pkg.version;

// ---------------------------------------------------------------------------
// isAdHocTarget — detect whether an arg is a URL or local path (not a qualified id)
// ---------------------------------------------------------------------------

/**
 * Known git hosting prefixes that indicate a remote URL even without a scheme.
 * We only check for prefixes that unambiguously denote a remote git host.
 */
const GIT_HOST_PREFIXES = ['github.com/', 'gitlab.com/', 'bitbucket.org/'];

/**
 * Return true when `arg` should be treated as an ad-hoc install target
 * (a URL or a local filesystem path) rather than a qualified catalog id.
 *
 * Detection rules (in priority order):
 * 1. Contains `://`                  → URL (http/https/git/ssh/…)
 * 2. Starts with `git@`              → SSH git URL
 * 3. Ends with `.git`                → git clone URL (bare)
 * 4. Starts with `./`, `/`, or `~/`  → local filesystem path
 * 5. Matches a known git host prefix → bare git URL (no scheme)
 *
 * A qualified id has the form `<prefix>/<nature>:<name>` and always contains `/`
 * AND `:`. Such an arg passes none of the above rules and falls through as NOT
 * ad-hoc. A bare id (`skill:foo`) also passes none of the rules.
 */
export function isAdHocTarget(arg: string): boolean {
  if (arg.includes('://')) return true;
  if (arg.startsWith('git@')) return true;
  if (arg.endsWith('.git')) return true;
  if (arg.startsWith('./') || arg.startsWith('/') || arg.startsWith('~/')) return true;
  for (const prefix of GIT_HOST_PREFIXES) {
    if (arg.startsWith(prefix)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// deriveAdHocPrefix — derive a sanitised source prefix from a URL or path
// ---------------------------------------------------------------------------

/**
 * Sanitise a raw string to `[a-z0-9-]`: lowercase, replace non-alphanumeric
 * (except `-`) with `-`, then collapse consecutive `-` and trim leading/trailing `-`.
 */
function sanitizeSegment(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Strip the TLD from a hostname.
 *
 * Examples:
 *   'custom.host'    → 'host'   (last label before TLD dropped)
 *   'bitbucket.org'  → 'bitbucket'
 *   'example.com'    → 'example'
 *
 * We keep only the second-to-last label (the SLD) when the hostname has exactly
 * two labels. For deeper hostnames (sub.example.com) we also return the SLD.
 * `github` and `gitlab` are handled by their dedicated cases before this is called.
 */
function hostWithoutTld(host: string): string {
  const parts = host.split('.');
  // For 'bitbucket.org' → ['bitbucket', 'org'] → 'bitbucket'
  // For 'custom.host' → ['custom', 'host'] → 'custom'
  // For 'sub.example.com' → ['sub', 'example', 'com'] → 'example'
  if (parts.length >= 2) {
    const idx = parts.length - 2;
    return parts[idx] as string;
  }
  return host;
}

/**
 * Derive the ad-hoc source prefix from a URL or local path.
 *
 * Rules:
 *  - `github.com/<owner>/<repo>(.git)` → `gh-<repo>`
 *  - `gitlab.com/<owner>/<repo>(.git)` → `glab-<repo>`
 *  - other host `<host>/<owner>/<repo>(.git)` → `<host-sans-TLD>-<repo>`
 *  - local path (starts with `.`, `/`, `~`) → `local-<basename-no-.git>`
 *
 * All output segments are sanitised to `[a-z0-9-]` with no consecutive `-`.
 */
export function deriveAdHocPrefix(source: string): string {
  // ── Local path ──────────────────────────────────────────────────────────
  const isLocal = source.startsWith('./') || source.startsWith('/') || source.startsWith('~/');
  if (isLocal) {
    const base = path.basename(source).replace(/\.git$/, '');
    return `local-${sanitizeSegment(base)}`;
  }

  // ── Normalise: strip scheme and git@ prefix to get a plain host/path string ──
  // https://github.com/owner/repo.git → github.com/owner/repo.git
  // git@github.com:owner/repo.git     → github.com/owner/repo.git
  let normalised = source;
  const schemeMatch = /^[a-z][a-z0-9+.-]*:\/\//i.exec(source);
  if (schemeMatch !== null) {
    normalised = source.slice(schemeMatch[0].length);
  } else if (source.startsWith('git@')) {
    // git@github.com:owner/repo.git → github.com/owner/repo.git
    normalised = source.slice(4).replace(':', '/');
  }

  // ── Extract host and repo name ───────────────────────────────────────────
  const slashIdx = normalised.indexOf('/');
  if (slashIdx === -1) {
    // e.g. just 'github.com' — unlikely but safe
    return sanitizeSegment(normalised);
  }

  const host = normalised.slice(0, slashIdx);
  // path after host: 'owner/repo.git' or 'owner/repo'
  const rest = normalised.slice(slashIdx + 1);

  // Repo name = last path segment, strip .git
  const lastSlash = rest.lastIndexOf('/');
  const rawRepo = lastSlash === -1 ? rest : rest.slice(lastSlash + 1);
  const repo = sanitizeSegment(rawRepo.replace(/\.git$/, ''));

  // ── Determine host-specific prefix ──────────────────────────────────────
  const hostLower = host.toLowerCase();
  if (hostLower === 'github.com') {
    return `gh-${repo}`;
  }
  if (hostLower === 'gitlab.com') {
    return `glab-${repo}`;
  }

  const sld = sanitizeSegment(hostWithoutTld(hostLower));
  return `${sld}-${repo}`;
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

/**
 * Known resource tokens (singular + plural aliases).
 *
 * "catalog" is treated as a resource alias for listing all entries.
 */
const KNOWN_RESOURCES = new Set(Object.keys(RESOURCE_NATURE_MAP));

/**
 * Flags that take a value and accept BOTH `--flag=value` and `--flag value`
 * (space syntax, R3). When `--flag` appears without `=`, the next argv token
 * is consumed as its value — even if that token itself looks like a flag —
 * so a missing value only occurs at the true end of argv.
 */
const VALUE_FLAGS = new Set(['scope', 'assistant', 'secret-env']);

/**
 * The complete allowlist of flags this CLI recognises (R3). Any `--key` (with
 * or without `=value`) outside this set is an operator typo, not a silent
 * no-op — parseArgs rejects it instead of swallowing it into `flags`.
 *
 * Exported so the anti-drift test (lot5-r3-flags.test.ts) can assert USAGE
 * documents exactly this set — a flag added here without a matching
 * `--<flag>` line in USAGE's Options section must fail that test, not slip
 * into an undocumented CLI surface.
 */
export const KNOWN_FLAGS = new Set([
  'scope',
  'assistant',
  'secret-env',
  'yes',
  'force',
  'fix',
  'remote',
  'help',
  'version',
]);

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
  /**
   * Every `--secret-env=<ref>=<VAR>` occurrence, in argv order (R5, lot 6).
   * Kept separate from `flags` (which holds one scalar per key) because this
   * flag is repeatable — `flags['secret-env']` still gets the LAST raw value
   * for parity with every other flag, but only this array preserves all of them.
   */
  secretEnvFlags: string[];
  /**
   * Set when argv violates the flag grammar (R3): a value-flag with no value
   * at end of argv, or a flag key outside KNOWN_FLAGS. Every other field is
   * empty/undefined on this path — callers (runCli) MUST check this first and
   * exit 2 with the message, before looking at `command`/`flags`.
   */
  error?: string;
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
 * - --key=value        → flags[key] = value
 * - --key value         (VALUE_FLAGS only, R3) → flags[key] = value, consumes
 *   the next token
 * - --key               (everything else)      → flags[key] = true
 * - --key outside KNOWN_FLAGS, in either form → `error` set, exit 2 (R3)
 * - a VALUE_FLAGS key with no `=` and no following token → `error` set (R3)
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const resourceIds: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const secretEnvFlags: string[] = [];

  // Collect flags and positional tokens in order.
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    const rest = arg.slice(2);
    const eqIdx = rest.indexOf('=');

    let key: string;
    let value: string | boolean;

    if (eqIdx !== -1) {
      key = rest.slice(0, eqIdx);
      value = rest.slice(eqIdx + 1);
    } else if (VALUE_FLAGS.has(rest)) {
      key = rest;
      const next = argv[i + 1];
      if (next === undefined) {
        return {
          command: undefined,
          resourceVerb: undefined,
          resourceIds: [],
          flags: {},
          secretEnvFlags: [],
          error: `--${key} requires a value`,
        };
      }
      value = next;
      i += 1; // consume the value token (space syntax, R3)
    } else {
      key = rest;
      value = true;
    }

    if (!KNOWN_FLAGS.has(key)) {
      return {
        command: undefined,
        resourceVerb: undefined,
        resourceIds: [],
        flags: {},
        secretEnvFlags: [],
        error: `unknown flag "--${key}"`,
      };
    }

    if (key === 'secret-env' && typeof value === 'string') {
      secretEnvFlags.push(value);
    }
    flags[key] = value;
  }

  if (positionals.length === 0) {
    return { command: undefined, resourceVerb: undefined, resourceIds, flags, secretEnvFlags };
  }

  // positionals.length > 0 is established above; positionals[0] is defined.
  const command = positionals[0] as string;

  // Resource grammar: <resource> <verb> [ids...]
  if (KNOWN_RESOURCES.has(command)) {
    const resourceVerb = positionals[1];
    resourceIds.push(...positionals.slice(2));
    return { command, resourceVerb, resourceIds, flags, secretEnvFlags };
  }

  // Top-level install with optional ids: install [<id...>]
  if (command === 'install') {
    resourceIds.push(...positionals.slice(1));
    return { command, resourceVerb: undefined, resourceIds, flags, secretEnvFlags };
  }

  // Top-level remove with required ids: remove <id...>
  if (command === 'remove') {
    resourceIds.push(...positionals.slice(1));
    return { command, resourceVerb: undefined, resourceIds, flags, secretEnvFlags };
  }

  // Top-level update with optional ids: update [<id...>]
  if (command === 'update') {
    resourceIds.push(...positionals.slice(1));
    return { command, resourceVerb: undefined, resourceIds, flags, secretEnvFlags };
  }

  // All other commands (check, init, ls, --help, --version, unknown)
  return { command, resourceVerb: undefined, resourceIds, flags, secretEnvFlags };
}

// ---------------------------------------------------------------------------
// Usage text
// ---------------------------------------------------------------------------

const USAGE = `\
  ██████╗ ██╗ ██████╗  ██████╗ ███████╗██████╗
  ██╔══██╗██║██╔════╝ ██╔════╝ ██╔════╝██╔══██╗
  ██████╔╝██║██║  ███╗██║  ███╗█████╗  ██████╔╝
  ██╔══██╗██║██║   ██║██║   ██║██╔══╝  ██╔══██╗
  ██║  ██║██║╚██████╔╝╚██████╔╝███████╗██║  ██║
  ╚═╝  ╚═╝╚═╝ ╚═════╝  ╚═════╝ ╚══════╝╚═╝  ╚═╝
  The harness package manager for teams

Usage:
  agent-rigger <command> [options]
  agent-rigger <resource> <verb> [args] [options]

Workflow commands:
  check                    Audit whether guardrails and context are correctly installed.
  doctor                   Diagnose environment deps AND installed state (untracked artifacts,
                           dangling symlinks, phantom stores, manifest issues, run lock, hygiene).
                           Read-only: exit 0 healthy / 3 findings / 2 manifest unreadable.
  doctor --fix             Repair the installed state under consent (safe repairs need --yes;
                           destructive ones are confirmed per item, never under --yes).
                           Exit 0 all repaired / 3 findings remain / 1 a repair failed.
  doctor --remote          Also read every configured catalog's content (read-only fetch) to
                           surface host-diff and divergent-mcp findings. Fail-closed on any
                           fetch error (exit 1). Combinable with --fix.
  install                  Install selected artifacts interactively.
  install <id...>          Install specified artifact ids non-interactively.
  install <id...> --yes    Install without confirmation prompt.
  install <url|path>       Install ad-hoc from a URL or local path (content is scanned).
  install <url|path> --force
                           Install despite scan findings (warn + proceed).
  init                     First-launch wizard: configure catalog URL and auth method.

Discovery commands:
  ls                       List all catalog entries with install status.
  catalog ls               List configured catalog sources (name + url).
  catalog add <name> <url> Add a catalog source (name must be unique).
  catalog remove <name>    Remove a catalog source by name.

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
  --scope=<user|project>        Installation scope (default: user).
  --assistant=<claude|opencode>
                                 Target assistant (default: resolved from config/detection,
                                 or prompted; see README § Assistants).
  --yes                         Skip confirmation prompt (non-interactive install only).
  --force                       Proceed despite scan findings (ad-hoc install only).
  --fix                         Repair the installed state (doctor only; consent-driven).
  --remote                      Read configured catalog content for the differential (doctor
                                only; read-only, fail-closed).
  --secret-env=<ref>=<VAR>
                                 Override which env var resolves an mcp secret ref (repeatable).
  --help                        Show this help message.
  --version                     Show CLI version.

Examples:
  agent-rigger check
  agent-rigger ls
  agent-rigger skills ls
  agent-rigger guardrails add jr/guardrail:claude --yes
  agent-rigger guardrails info jr/guardrail:claude
  agent-rigger guardrails check
  agent-rigger install --scope=user
  agent-rigger update --yes
  agent-rigger skills update jr/skill:remote-demo --yes
  agent-rigger install jr/skill:foo --assistant opencode
  agent-rigger init
`;

// ---------------------------------------------------------------------------
// CliDeps — injectable dependencies
// ---------------------------------------------------------------------------

/** Prompt callbacks injected by the CLI entry or tests. */
export interface CliPrompts {
  selectArtifacts: (entries: CatalogEntry[]) => Promise<string[]>;
  /**
   * Optional status-aware grouped picker (install / update / current).
   *
   * When provided (real CLI via importUiPrompts), the interactive install flow
   * asks for scope first, classifies each entry against the manifest + remote
   * version, short-circuits when nothing is actionable, and renders the grouped
   * picker. When absent (legacy / injected-prompt tests), the flow falls back to
   * the flat `selectArtifacts` picker with scope asked afterwards.
   *
   * `opts` (b1b4-R4, optional) relays each catalog's `meta.recommended` opinion
   * into the pre-checked set. Absent → historical default (install ∪ update).
   */
  selectArtifactsByStatus?: (
    entries: StatusedEntry[],
    opts?: StatusInitialValuesOpts,
  ) => Promise<string[]>;
  /** `assistant` (R5, optional — defaults to 'claude') picks the picker's root labels. */
  selectScope: (assistant?: Assistant) => Promise<'user' | 'project'>;
  confirmApply: (planText: string) => Promise<boolean>;
  askUrl: () => Promise<string>;
  askMethod: () => Promise<'provider-cli' | 'https' | 'ssh'>;
  /**
   * Optional post-init picker + install orchestration (injectable for tests).
   *
   * When set, `runCli` will provide this as `proposeInstall` to `runInit`,
   * which calls it after a successful config persist.
   * When absent and in a real TTY, `runCli` builds the real picker + install fn.
   * When absent and NOT in a TTY, `runInit` receives no `proposeInstall` (config-only).
   */
  proposeInstall?: (catalog: CatalogProposal) => Promise<string[]>;
  /**
   * Optional post-init defaults picker (injectable for tests, governance-id-forge).
   *
   * Threaded into the real `runInteractiveProposeInstall` so a test can observe
   * the `{required, recommended}` sets it builds from `catalog.meta` (foreign
   * ids excluded) without driving real clack. When absent, the real
   * clack-backed `selectArtifactsWithDefaults` is used.
   */
  selectArtifactsWithDefaults?: (
    entries: CatalogEntry[],
    defaults: { required: Set<string>; recommended: Set<string> },
  ) => Promise<string[]>;
  /**
   * Optional target-assistant(s) picker (injectable for tests, R1/E7).
   *
   * When set, `runCli` provides this to `runInit` as `askAssistants` regardless
   * of TTY (test injection always wins). When absent and in a real TTY, `runCli`
   * builds a real clack multiselect. When absent and NOT in a TTY, `runInit`
   * receives no `askAssistants` and falls back to on-disk detection.
   */
  askAssistants?: () => Promise<Assistant[]>;
}

/** All injectable dependencies for runCli. */
export interface CliDeps {
  /** Output sink. Defaults to console.log. */
  print?: (msg: string) => void;
  /** Environment variables. Defaults to Bun.env. */
  env?: Env;
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
// resolveCliAssistant — flag > config.assistants > detected > TTY prompt
// ---------------------------------------------------------------------------

/**
 * Resolve the target assistant for a command (R1): install, check, remove,
 * update. Each command resolves exactly ONE assistant per transaction.
 *
 * `--assistant` (raw, unvalidated) takes priority; config.assistants[] and
 * on-disk detection follow (assistant-select.ts). `fallback: 'claude'` keeps
 * the pre-M3 behaviour when nothing is resolvable and the terminal isn't
 * interactive (existing scripts/CI with neither `~/.claude` nor
 * `~/.config/opencode` present keep operating as claude, unchanged).
 *
 * A legacy config (catalogUrl without catalogs[]) makes loadCliConfig throw
 * LegacyConfigError — that migration message is the caller's responsibility
 * (resolveEffectiveCatalogFull etc.) to surface, not this resolver's; degrade
 * to "no configAssistants" here rather than letting the whole command fail.
 */
async function resolveCliAssistant(
  flags: Record<string, string | boolean>,
  env: Env,
): Promise<Assistant> {
  const rawFlag = flags['assistant'];
  const flag = rawFlag === undefined ? undefined : String(rawFlag);

  let configAssistants: Assistant[] | undefined;
  try {
    configAssistants = (await loadCliConfig(env)).assistants;
  } catch (err) {
    if (!(err instanceof LegacyConfigError)) throw err;
  }

  return resolveAssistant({
    ...(flag === undefined ? {} : { flag }),
    ...(configAssistants === undefined ? {} : { configAssistants }),
    env,
    isTTY: process.stdout.isTTY === true,
    fallback: 'claude',
  });
}

// ---------------------------------------------------------------------------
// resolveProposalAssistants — assistant(s) for post-init / catalog-add installs
// ---------------------------------------------------------------------------

/**
 * Resolve the assistant(s) targeted by a post-init / post-`catalog add`
 * install proposal (H9).
 *
 * config.assistants — persisted by the init wizard BEFORE the proposal step
 * (cmd-init.ts step 4 vs step 6) — wins: every configured assistant receives
 * the proposed install, so a user who picked opencode (or both) never
 * silently falls back to claude. Without configured assistants, a single
 * detected assistant wins; otherwise 'claude' (pre-M3 back-compat).
 *
 * Never prompts: this runs inside picker flows (`init`, `init --yes`,
 * `catalog add`) where the wizard already asked — an extra assistant prompt
 * would be redundant in TTY and would hang a `--yes` run.
 */
async function resolveProposalAssistants(env: Env): Promise<Assistant[]> {
  let configAssistants: Assistant[] | undefined;
  try {
    configAssistants = (await loadCliConfig(env)).assistants;
  } catch (err) {
    if (!(err instanceof LegacyConfigError)) throw err;
  }

  if (configAssistants !== undefined && configAssistants.length > 0) {
    return configAssistants;
  }

  const detected = await detectAssistants(env);
  return detected.length === 1 ? detected : ['claude'];
}

// ---------------------------------------------------------------------------
// resolveManifestAssistant — manifest-first routing for check/remove/update (M18)
// ---------------------------------------------------------------------------

/**
 * Resolve the target assistant for manifest-routed commands (check/remove/
 * update). ADR-0020 §1 / R1.6: the assistant is persisted per manifest entry,
 * so these commands route the adapter from the manifest WITHOUT re-prompting.
 *
 * Priority:
 * 1. `--assistant` flag: explicit override, delegated to resolveCliAssistant
 *    (same validation and error behaviour).
 * 2. Manifest: when every relevant entry (matching `scope`, and `ids` when
 *    given) belongs to exactly ONE assistant → that assistant. No prompt, no
 *    config/detection lookup — the manifest already knows.
 * 3. Fallback: resolveCliAssistant (config > detection > TTY prompt >
 *    'claude') — only when the manifest genuinely has no answer (no matching
 *    entries, or entries spread across several assistants).
 */
async function resolveManifestAssistant(opts: {
  flags: Record<string, string | boolean>;
  env: Env;
  scope: 'user' | 'project';
  /** When provided and non-empty, only manifest entries with these ids count. */
  ids?: string[];
}): Promise<Assistant> {
  const { flags, env, scope, ids } = opts;

  if (flags['assistant'] !== undefined) {
    return resolveCliAssistant(flags, env);
  }

  const { readManifest } = await import('@agent-rigger/core/manifest');
  const manifest = await readManifest(resolveManifestPath(env));
  const idFilter = ids === undefined || ids.length === 0 ? undefined : new Set(ids);

  const distinct = new Set<Assistant>();
  for (const entry of manifest.artifacts) {
    if (entry.scope !== scope) continue;
    if (idFilter !== undefined && !idFilter.has(entry.id)) continue;
    distinct.add(entry.assistant ?? 'claude');
  }

  const [only] = distinct;
  if (distinct.size === 1 && only !== undefined) {
    return only;
  }

  return resolveCliAssistant(flags, env);
}

// ---------------------------------------------------------------------------
// parseAssistantFilterFlag — optional --assistant filter (read-only commands)
// ---------------------------------------------------------------------------

/**
 * Parse an optional `--assistant` filter flag for read-only commands (ls, info)
 * that never write, never prompt, and never fall back — absent means "every
 * assistant", not "claude" (unlike resolveCliAssistant's install/check/remove/
 * update semantics, R1).
 *
 * Returns `undefined` when the flag is absent (no filtering), the validated
 * Assistant when the value is 'claude' or 'opencode', or `'invalid'` when the
 * value is anything else — callers print an actionable error and exit 2.
 */
function parseAssistantFilterFlag(
  flags: Record<string, string | boolean>,
): Assistant | undefined | 'invalid' {
  const raw = flags['assistant'];
  if (raw === undefined) return undefined;
  const value = String(raw);
  return value === 'claude' || value === 'opencode' ? value : 'invalid';
}

// ---------------------------------------------------------------------------
// resolveEffectiveCatalog — multi-source, parallel fetch, per-source degradation
// ---------------------------------------------------------------------------

/**
 * Resolve the effective catalog by fetching all configured sources in parallel.
 *
 * - Loads the user config to obtain config.catalogs[].
 * - If no catalogs are configured: prints actionable message and returns [].
 * - For each source: fetches in parallel, applies qualifyEntries(name, entries).
 *   On per-source failure → warning (name + url + error) + continues with others.
 * - Folds all qualified arrays via foldCatalogs(sources).
 * - Reports id collisions (same qualified id in multiple sources) as a warning.
 */
/** Effective catalog + the governance meta of every source that resolved. */
interface EffectiveCatalog {
  entries: CatalogEntry[];
  /** sourceName → its meta.required/recommended. Absent for failed sources. */
  metaBySource: Map<string, CatalogGovernanceMeta>;
  /**
   * True when at least one catalog is configured AND every one of them
   * failed to fetch (R1, ADR-0024: offline — the request was legitimate,
   * the runtime failed). False both when no catalog is configured at all
   * (a different condition, handled by the caller before this ever runs)
   * and when at least one source responded (existing per-source degradation
   * — unchanged, the caller proceeds on the partial catalog).
   */
  allSourcesFailed: boolean;
}

/**
 * Like {@link resolveEffectiveCatalog} but also returns each source's governance
 * meta (required/recommended), needed by `check` to decide which guardrail/
 * context entries to audit. The single fetch is shared — no extra remote work.
 */
async function resolveEffectiveCatalogFull(
  env: Env,
  print: (msg: string) => void,
  remote: CliDeps['remote'],
): Promise<EffectiveCatalog> {
  let config: Awaited<ReturnType<typeof loadCliConfig>>;
  try {
    config = await loadCliConfig(env);
  } catch (err) {
    if (err instanceof LegacyConfigError) {
      print(
        `[warning] ${err.message}`,
      );
      return { entries: [], metaBySource: new Map(), allSourcesFailed: false };
    }
    throw err;
  }

  if (config.catalogs.length === 0) {
    print('no catalog configured — run `agent-rigger init`');
    return { entries: [], metaBySource: new Map(), allSourcesFailed: false };
  }

  const run: CommandRunner | undefined = remote?.run;
  const tmpFactory: TmpDirFactory | undefined = remote?.tmpFactory;

  // Fetch all sources in parallel; degrade per-source on failure.
  // Each source's entries are immediately qualified with its name (ADR-0017):
  // 'skill:foo' from source 'principal' → 'principal/skill:foo'.
  // foldCatalogs then deduplicates and detects collisions on qualified ids.
  const sourceResults = await Promise.all(
    config.catalogs.map(async (source) => {
      try {
        const fetchOpts: Parameters<typeof fetchRemoteCatalog>[0] = { url: source.url };
        if (run !== undefined) fetchOpts.run = run;
        if (tmpFactory !== undefined) fetchOpts.tmpFactory = tmpFactory;

        const { entries, meta } = await fetchRemoteCatalog(fetchOpts);
        return {
          name: source.name,
          entries: qualifyEntries(source.name, entries),
          meta: { required: meta.required, recommended: meta.recommended } as CatalogGovernanceMeta,
          ok: true,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        print(
          `[warning] Catalog "${source.name}" (${source.url}) unavailable (${msg}). `
            + `Check the URL or run \`agent-rigger init\`.`,
        );
        return {
          name: source.name,
          entries: [] as CatalogEntry[],
          meta: undefined as CatalogGovernanceMeta | undefined,
          ok: false,
        };
      }
    }),
  );

  // Fold all qualified sources; first source wins on collision.
  const effective = foldCatalogs(sourceResults.map((r) => r.entries));

  if (effective.conflicts.length > 0) {
    print(
      `[warning] ${effective.conflicts.length} catalog entr${
        effective.conflicts.length === 1 ? 'y' : 'ies'
      } deduplicated (duplicate qualified ids discarded): ${effective.conflicts.join(', ')}`,
    );
  }

  const metaBySource = new Map<string, CatalogGovernanceMeta>();
  for (const r of sourceResults) {
    if (r.meta !== undefined) metaBySource.set(r.name, r.meta);
  }

  // R1 (ADR-0024): at least one catalog IS configured here (checked above) —
  // allSourcesFailed distinguishes "every source unreachable" (offline, exit
  // 1 for install) from "some responded" (existing per-source degradation,
  // caller proceeds on the partial catalog, unchanged).
  const allSourcesFailed = sourceResults.every((r) => !r.ok);

  return { entries: effective.entries, metaBySource, allSourcesFailed };
}

/**
 * Resolve the effective catalog by fetching all configured sources in parallel.
 * Thin wrapper over {@link resolveEffectiveCatalogFull} for the many call-sites
 * that only need the merged, qualified entries.
 */
async function resolveEffectiveCatalog(
  env: Env,
  print: (msg: string) => void,
  remote: CliDeps['remote'],
): Promise<CatalogEntry[]> {
  return (await resolveEffectiveCatalogFull(env, print, remote)).entries;
}

// ---------------------------------------------------------------------------
// computeArtifactStatuses — classify effective entries vs manifest + remote
// ---------------------------------------------------------------------------

/**
 * Classify each effective catalog entry as install / update / current for the
 * given scope.
 *
 * - Reads the manifest to find installed ids (+ their ref/sha) for `scope`,
 *   keyed to `assistant` — an id installed for the OTHER assistant is not
 *   "current" here, it falls through to 'install' (one-assistant-per-
 *   transaction, R1).
 * - Resolves the remote version (top semver tag) per configured catalog so an
 *   installed entry at an older ref/sha is flagged 'update' — sha-aware (R2,
 *   lot 6, D2): a same-name tag re-pushed to a new commit is still flagged,
 *   and a HEAD-fallback landing back on the already-installed commit is not.
 *   A catalog whose version cannot be resolved degrades gracefully (its
 *   installed entries → 'current').
 * - Packs derive their status from their installable members (b1b4-R3): a
 *   member 'install' → pack 'install'; else a member 'update' → pack 'update';
 *   else 'current'. Tool members are excluded from the aggregate — they are
 *   never manifest-tracked (install = M5) — so a tool (and an all-tool pack)
 *   still falls through to 'install' until M5. A member that is itself a pack
 *   contributes its own synthesized status (recursion, memoized, with a cycle
 *   guard — a member on the current path is ignored, so cycles terminate).
 */
async function computeArtifactStatuses(
  effective: CatalogEntry[],
  scope: 'user' | 'project',
  env: Env,
  deps: CliDeps,
  assistant: Assistant,
): Promise<StatusedEntry[]> {
  const runner: CommandRunner = deps.remote?.run ?? defaultRunner;
  const manifestPath = resolveManifestPath(env);
  const { readManifest } = await import('@agent-rigger/core/manifest');
  const manifest = await readManifest(manifestPath);

  const installedById = new Map<string, { ref: string; sha: string }>();
  for (const a of manifest.artifacts) {
    if (a.scope === scope && (a.assistant ?? 'claude') === assistant) {
      // `?? ''` defends against a legacy on-disk entry written before sha
      // tracking existed — readManifest stays entry-shape-tolerant (R2,
      // isUpdateAvailable degrades gracefully on an empty sha).
      installedById.set(a.id, { ref: a.ref, sha: a.sha ?? '' });
    }
  }

  // Resolve remote version per catalog (keyed by source name = id prefix).
  // Degrade to null on failure — update detection is skipped for that catalog.
  const config = await loadCliConfig(env);
  const remoteByName = new Map<string, Awaited<ReturnType<typeof resolveVersion>> | null>();
  await Promise.all(
    config.catalogs.map(async (c) => {
      try {
        remoteByName.set(c.name, await resolveVersion(c.url, runner));
      } catch {
        remoteByName.set(c.name, null);
      }
    }),
  );

  // Remote version for an entry's catalog (keyed by id prefix), or null when
  // that catalog's version could not be resolved (graceful degradation).
  const remoteFor = (id: string): Awaited<ReturnType<typeof resolveVersion>> | null => {
    const slash = id.indexOf('/');
    const prefix = slash === -1 ? '' : id.slice(0, slash);
    return remoteByName.get(prefix) ?? null;
  };

  // Pass 1: classify every non-pack entry (install / update / current). This
  // is the member-status source for the pack synthesis in pass 2.
  const classifyArtifact = (e: CatalogEntry): StatusedEntry => {
    const remote = remoteFor(e.id);
    const installed = installedById.get(e.id);
    if (installed === undefined) {
      // Surface the to-be-installed version when the remote resolved.
      return remote === null
        ? { id: e.id, status: 'install' }
        : { id: e.id, status: 'install', remoteRef: remote.ref };
    }
    if (remote !== null && isUpdateAvailable(installed.ref, installed.sha, remote)) {
      return { id: e.id, status: 'update', installedRef: installed.ref, remoteRef: remote.ref };
    }
    return { id: e.id, status: 'current', installedRef: installed.ref };
  };

  const artifactStatusById = new Map<string, StatusedEntry>();
  for (const e of effective) {
    if (e.kind !== 'pack') artifactStatusById.set(e.id, classifyArtifact(e));
  }

  // Pass 2: synthesize each pack from its members (b1b4-R3, D3). Members are
  // already qualified in the effective catalog (qualify.ts). An artifact member
  // contributes its pass-1 status; a member that is itself a pack contributes
  // its OWN synthesized status (recursion, so nested drift surfaces). Tool
  // members are excluded — mirror of the install-time filter (cmd-install.ts):
  // the manifest never tracks them, so they can't drive a pack 'current'. A
  // member absent from the effective catalog is ignored (inconsistent data,
  // same tolerance as the legacy picker). `ancestors` guards cycles (governance.ts
  // DFS pattern): a member already on the current path contributes nothing, so
  // a pack cycle terminates. Memoized by id (a DAG resolves each pack once). An
  // empty aggregate (all-tool / member-less pack) keeps the 'install'
  // fall-through — nothing trackable could ever make it 'current'.
  const effectiveById = new Map(effective.map((e) => [e.id, e] as const));
  const packStatusCache = new Map<string, StatusedEntry['status']>();
  const aggregatePackStatus = (packId: string, ancestors: Set<string>): StatusedEntry['status'] => {
    const cached = packStatusCache.get(packId);
    if (cached !== undefined) return cached;

    const entry = effectiveById.get(packId);
    const members = entry !== undefined && entry.kind === 'pack' ? entry.members : [];
    const nextAncestors = new Set(ancestors).add(packId);

    const memberStatuses: StatusedEntry['status'][] = [];
    for (const mid of members) {
      if (nextAncestors.has(mid)) continue; // member is an ancestor on the path → cycle, skip
      const m = effectiveById.get(mid);
      if (m === undefined) continue; // absent from the effective catalog → ignore
      if (m.kind === 'pack') {
        memberStatuses.push(aggregatePackStatus(mid, nextAncestors));
      } else if (m.nature !== 'tool') {
        const s = artifactStatusById.get(m.id);
        if (s !== undefined) memberStatuses.push(s.status);
      }
      // tool members are excluded from the aggregate
    }

    const status: StatusedEntry['status'] = memberStatuses.length === 0
        || memberStatuses.includes('install')
      ? 'install'
      : memberStatuses.includes('update')
      ? 'update'
      : 'current';
    packStatusCache.set(packId, status);
    return status;
  };

  // Assemble in effective order, preserving the picker's display order. A pack
  // carries kind:'pack' (member-oriented labels) and, when 'install', the
  // catalog's remote ref so the picker can still show the target version.
  return effective.map((e): StatusedEntry => {
    if (e.kind !== 'pack') return artifactStatusById.get(e.id) as StatusedEntry;
    const status = aggregatePackStatus(e.id, new Set());
    if (status === 'install') {
      const remote = remoteFor(e.id);
      return remote === null
        ? { id: e.id, status: 'install', kind: 'pack' }
        : { id: e.id, status: 'install', kind: 'pack', remoteRef: remote.ref };
    }
    return { id: e.id, status, kind: 'pack' };
  });
}

// ---------------------------------------------------------------------------
// runInteractiveProposeInstall — shared picker + install orchestration (M7/R9)
// ---------------------------------------------------------------------------

/**
 * Show the interactive artifact picker for a catalog source, then install the
 * selected ids via runRemoteInstall.
 *
 * Shared between `init` (post-wizard proposal) and `catalog add` (post-add
 * proposal). The caller is responsible for building the CatalogProposal
 * (qualified entries + meta) and for resolving the install source (url/name).
 *
 * The install targets the assistant(s) resolved by resolveProposalAssistants
 * (H9): one runRemoteInstall per configured assistant, so a user who picked
 * opencode in the init wizard never gets a silent claude install.
 *
 * Returns the list of installed ids (empty if the user cancelled).
 */
async function runInteractiveProposeInstall(
  catalog: CatalogProposal,
  installSource: { catalogUrl: string; sourceName: string },
  opts: {
    scope: 'user' | 'project';
    env: Env;
    runner: CommandRunner;
    tmpFactory: TmpDirFactory;
    scanner?: import('@agent-rigger/core/scan').Scanner;
    print: (msg: string) => void;
    /** Injectable picker (tests); defaults to the real clack-backed ui export. */
    selectWithDefaults?: (
      entries: CatalogEntry[],
      defaults: { required: Set<string>; recommended: Set<string> },
    ) => Promise<string[]>;
  },
): Promise<string[]> {
  const { scope, env, runner, tmpFactory, scanner, print, selectWithDefaults } = opts;
  const selectArtifactsWithDefaults = selectWithDefaults
    ?? (await import('./ui')).selectArtifactsWithDefaults;

  // Qualify meta.required/recommended with the source name so that they
  // match the qualified entries in the picker (ADR-0017). governance-id-forge:
  // own ids only — a foreign pre-qualified id in this catalog's meta can't forge
  // a pre-check on another catalog's artifacts (advisory → silent discard).
  const sourceName = catalog.sourceName;
  const required = new Set(partitionMetaIds(sourceName, catalog.meta.required ?? []).own);
  const recommended = new Set(partitionMetaIds(sourceName, catalog.meta.recommended ?? []).own);

  // catalog.entries are already qualified (fetchCatalogFn returns qualified entries).
  const selectedIds = await selectArtifactsWithDefaults(catalog.entries, {
    required,
    recommended,
  });

  if (selectedIds.length === 0) {
    return [];
  }

  const manifestPath = resolveManifestPath(env);

  // H9: target the assistant(s) the user configured (persisted before the
  // proposal step) — one install per assistant, never a silent claude default.
  const assistants = await resolveProposalAssistants(env);

  for (const assistant of assistants) {
    const result = await runRemoteInstall({
      ids: selectedIds,
      catalogUrl: installSource.catalogUrl,
      sourceName: installSource.sourceName,
      scope,
      env,
      manifestPath,
      runner,
      tmpFactory,
      confirm: true,
      assistant,
      ...(scanner === undefined ? {} : { scanner }),
    });

    // Surface the plan + result recap + scan/tool warnings. Without this the
    // install happens silently after the picker (no feedback to the user).
    print(result.output);
  }

  return selectedIds;
}

// ---------------------------------------------------------------------------
// runCli
// ---------------------------------------------------------------------------

/**
 * Route argv to the appropriate command and return the exit code.
 * Does NOT call process.exit — the caller (main) does that.
 *
 * Exit code contract: see ADR-0024 (`docs/adr/0024-contrat-exit-codes-cli.md`)
 * — 0/2/1/130, identical for a given condition across every command. `check`
 * additionally returns 3 for one or more missing/drifted entries, a
 * domain-specific code outside the ADR's scope (not a confirmation/precondition/
 * runtime distinction).
 */
export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const print = deps.print ?? ((msg: string) => process.stdout.write(msg + '\n'));
  const env: Env = deps.env ?? Bun.env;

  const parsed = parseArgs(argv);

  // Flag grammar violation (R3): unknown flag, or a value-flag with no value
  // at end of argv. Checked before anything else — `command`/`flags` are
  // empty on this path.
  if (parsed.error !== undefined) {
    print(`[error] ${parsed.error}`);
    return 2;
  }

  const { command, resourceVerb, resourceIds, flags, secretEnvFlags } = parsed;

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

  // Validate --assistant before entering any command block (R3): centralised
  // here, next to --scope, so every command sees the same exit code (2) for
  // the same typo — the per-command checks below (ls/info/install/check/…)
  // become unreachable for an invalid value but are left in place as
  // defense-in-depth for direct callers of those helpers.
  if (
    flags['assistant'] !== undefined
    && flags['assistant'] !== 'claude'
    && flags['assistant'] !== 'opencode'
  ) {
    print(
      `[error] Invalid --assistant value: "${flags['assistant']}". Must be "claude" or "opencode".`,
    );
    return 2;
  }

  const scope = (flags['scope'] === 'project' ? 'project' : 'user') as 'user' | 'project';

  try {
    // ----- ls (top-level) -----
    if (command === 'ls') {
      // Optional --assistant filter (read-only: absent = show every assistant).
      const assistantFilter = parseAssistantFilterFlag(flags);
      if (assistantFilter === 'invalid') {
        print(
          `[error] Invalid --assistant value: "${
            flags['assistant']
          }". Must be "claude" or "opencode".`,
        );
        return 2;
      }

      const effective = await resolveEffectiveCatalog(env, print, deps.remote);
      if (effective.length === 0) {
        return 0;
      }
      const result = await runLs({
        catalog: effective,
        env,
        scope,
        ...(assistantFilter === undefined ? {} : { assistant: assistantFilter }),
      });
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
        print,
        deps,
        secretEnvFlags,
      });
    }

    // ----- check -----
    if (command === 'check') {
      // Resolve the target assistant once (R1/M18): flag > manifest routing
      // (entry.assistant, ADR-0020 §1 — no re-prompt) > config/detection.
      const assistant = await resolveManifestAssistant({ flags, env, scope });

      const { entries: effective, metaBySource } = await resolveEffectiveCatalogFull(
        env,
        print,
        deps.remote,
      );

      // Best-effort catalog status + update-available annotation (R22.4).
      // Computed from the manifest + configured catalogs, independent of whether
      // the catalog listing could be fetched — so an unreachable catalog still
      // surfaces here. Never throws: check exit code is unaffected.
      const remoteSections = await resolveCheckRemoteSections(env, scope, deps.remote, assistant);

      if (effective.length === 0) {
        printRemoteSections(print, remoteSections);
        return 0;
      }

      const manifestPath = resolveManifestPath(env);

      // Which guardrail/context to audit: a catalog entry is an offer, not an
      // obligation. Audit only the DECLARED governance baseline (required ∪
      // recommended, packs expanded) plus whatever is already installed FOR
      // THIS ASSISTANT (so drift is still caught, without confusing the other
      // assistant's entries as this one's baseline — one-assistant-per-
      // transaction, R1). This keeps `check` green when an extra catalog
      // merely OFFERS guardrails/context the user never opted into.
      const { readManifest } = await import('@agent-rigger/core/manifest');
      const manifestForCheck = await readManifest(manifestPath);
      const installedGovernanceIds = manifestForCheck.artifacts
        .filter(
          (a) =>
            a.scope === scope
            && (a.nature === 'guardrail' || a.nature === 'context')
            && (a.assistant ?? 'claude') === assistant,
        )
        .map((a) => a.id);
      const auditable = auditableGovernanceIds(effective, metaBySource, installedGovernanceIds);

      const entries: AdapterEntry[] = effective
        .filter(
          (e) =>
            e.kind === 'artifact'
            && (e.nature === 'guardrail' || e.nature === 'context')
            && auditable.has(e.id),
        )
        .map((e) => ({
          id: e.id,
          nature: (e as { nature: 'guardrail' | 'context' }).nature,
          scope,
        }));

      if (entries.length === 0) {
        // Nothing declared-or-installed to audit — still show catalog status.
        printRemoteSections(print, remoteSections);
        return 0;
      }

      const adapter = await buildAdapter(assistant, env);

      const result = await runCheck({
        adapter,
        entries,
        scope,
        env,
        manifestPath,
      });

      print(result.output);

      printRemoteSections(print, remoteSections);

      return result.exitCode;
    }

    // ----- doctor -----
    if (command === 'doctor') {
      // Phase 1 (env-deps) — UNCHANGED.
      await runDoctor({ print });

      // Phase 2 (installed state, R8). Catalog NAMES only by default (never
      // fetched) — the R2 orphan-catalog prefix check + R5 id requalification; a
      // legacy config degrades to no configured catalogs rather than failing the
      // command. The full {name,url} list is kept for the --remote fetch below.
      let configuredCatalogs: { name: string; url: string }[] = [];
      try {
        configuredCatalogs = (await loadCliConfig(env)).catalogs;
      } catch (err) {
        if (!(err instanceof LegacyConfigError)) throw err;
      }
      const configuredCatalogIds = configuredCatalogs.map((c) => c.name);

      // D1 (--remote): read-only fetch of EVERY configured catalog's content,
      // sequential, fail-closed. Without the flag, nothing here runs — no
      // network access at all (the v1 invariant). Any fetch error propagates to
      // handleError (RemoteFetchError → exit 1, RefShaMismatchError → exit 2);
      // the message is augmented in place with the configured catalog name so a
      // fail-closed exit names the offending source (name + url), never
      // degrading silently to a disk-only scan.
      let catalogCanons: CatalogCanon[] | undefined;
      if (flags['remote'] === true) {
        const canons: CatalogCanon[] = [];
        for (const cat of configuredCatalogs) {
          try {
            canons.push(
              await fetchRemoteCatalogCanon({
                name: cat.name,
                url: cat.url,
                ...(deps.remote?.run === undefined ? {} : { run: deps.remote.run }),
                ...(deps.remote?.tmpFactory === undefined
                  ? {}
                  : { tmpFactory: deps.remote.tmpFactory }),
              }),
            );
          } catch (err) {
            if (err instanceof RemoteFetchError) {
              // Preserve the subclass (and its exit-code mapping) while naming
              // the configured catalog the url belongs to.
              (err as { message: string }).message =
                `catalog "${cat.name}" (${cat.url}): ${err.message}`;
            }
            throw err;
          }
        }
        catalogCanons = canons;
      }

      return await runDoctorState({
        env,
        print,
        fix: flags['fix'] === true,
        yes: flags['yes'] === true,
        isTTY: process.stdin.isTTY === true,
        configuredCatalogIds,
        ...(catalogCanons === undefined ? {} : { catalogCanons }),
      });
    }

    // ----- install -----
    if (command === 'install') {
      return await handleInstall({
        ids: resourceIds,
        flags,
        scope,
        env,
        print,
        deps,
        secretEnvFlags,
      });
    }

    // ----- remove -----
    if (command === 'remove') {
      return await handleRemove({
        ids: resourceIds,
        flags,
        scope,
        env,
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
        print,
        deps,
      });
    }

    // ----- init -----
    if (command === 'init') {
      const prompts = deps.prompts ?? (await importUiPrompts());
      const configPath = resolveConfigPath(env);

      const runner: CommandRunner = deps.remote?.run ?? defaultRunner;
      const tmpFactory: TmpDirFactory = deps.remote?.tmpFactory ?? defaultTmpFactory;

      // proposeInstall: resolve required/recommended from catalog.meta, show picker,
      // then run actual install if user confirmed a non-empty selection.
      // Gate: use injected prompts.proposeInstall when provided (test injection),
      //       build the real picker when in a real TTY,
      //       skip proposal entirely when NOT in a TTY (config-only mode).
      let proposeInstallFn: ((catalog: CatalogProposal) => Promise<string[]>) | undefined;

      if (prompts.proposeInstall !== undefined) {
        // Test injection: use the injected fn directly.
        proposeInstallFn = prompts.proposeInstall;
      } else if (flags['yes'] === true) {
        // --yes (TTY or non-TTY): install defaults (required + recommended) without a picker.
        // `--yes` universally means "accept defaults, show no prompt" — it takes priority
        // over the interactive TTY picker.
        proposeInstallFn = async (catalog: CatalogProposal): Promise<string[]> => {
          const sourceName = catalog.sourceName;

          // governance-id-forge: split own vs foreign meta ids. A foreign id in
          // meta.required is a floor this catalog cannot honor — fail closed with
          // an actionable message (same class as a phantom required's
          // UnknownEntryError, which runInit also catches non-fatally). Foreign
          // recommended is advisory → silently dropped (keeps only .own).
          const requiredParts = partitionMetaIds(sourceName, catalog.meta.required ?? []);
          if (requiredParts.foreign.length > 0) {
            print(
              `[error] catalog "${sourceName}" declares foreign id(s) in meta.required: `
                + `${requiredParts.foreign.join(', ')} — a catalog's required floor may only `
                + `reference its own artifacts (bare or "${sourceName}/…"-qualified).`,
            );
            throw new Error(`foreign id in catalog "${sourceName}" meta.required`);
          }
          const required = requiredParts.own;
          const recommended = partitionMetaIds(sourceName, catalog.meta.recommended ?? []).own;

          // Build defaults selection: required(all) ∪ (recommended ∩ entries).
          //
          // Mirrors the interactive path (selectArtifactsWithDefaults):
          //   - required ids absent from entries are kept → runRemoteInstall errors
          //     (UnknownEntryError, fail-closed — aligned with ADR-0015 §6).
          //   - recommended ids absent from entries are silently skipped: the picker
          //     only renders options from entries, so absent recommended ids never
          //     appear in the picker and are never installed — no error.
          const entryIds = new Set(catalog.entries.map((e) => e.id));
          const seen = new Set<string>();
          const defaultIds: string[] = [];
          for (const id of required) {
            if (!seen.has(id)) {
              seen.add(id);
              defaultIds.push(id);
            }
          }
          for (const id of recommended) {
            if (!seen.has(id) && entryIds.has(id)) {
              seen.add(id);
              defaultIds.push(id);
            }
          }

          if (defaultIds.length === 0) {
            return [];
          }

          const initConfig = await loadCliConfig(env);
          const initPrimary = initConfig.catalogs[0];
          if (initPrimary === undefined) {
            return [];
          }

          const manifestPath = resolveManifestPath(env);

          // H9: install the defaults for every assistant the wizard persisted
          // (config.assistants is saved BEFORE this proposal step) — never a
          // silent claude default when the user picked opencode.
          const proposalAssistants = await resolveProposalAssistants(env);

          for (const assistant of proposalAssistants) {
            await runRemoteInstall({
              ids: defaultIds,
              catalogUrl: initPrimary.url,
              sourceName,
              scope,
              env,
              manifestPath,
              runner,
              tmpFactory,
              confirm: true,
              assistant,
              ...(deps.remote?.scanner === undefined ? {} : { scanner: deps.remote.scanner }),
            });
          }

          return defaultIds;
        };
      } else if (process.stdout.isTTY) {
        // Real TTY without --yes: delegate to the shared interactive picker + install helper.
        // The install source (url + name) is loaded lazily from the just-saved config
        // so that `init` always installs from the first catalog it configured.
        proposeInstallFn = async (catalog: CatalogProposal): Promise<string[]> => {
          const initConfig = await loadCliConfig(env);
          const initPrimary = initConfig.catalogs[0];

          if (initPrimary === undefined) {
            return [];
          }

          return runInteractiveProposeInstall(catalog, {
            catalogUrl: initPrimary.url,
            sourceName: initPrimary.name,
          }, {
            scope,
            env,
            runner,
            tmpFactory,
            print,
            ...(deps.remote?.scanner === undefined ? {} : { scanner: deps.remote.scanner }),
            ...(prompts.selectArtifactsWithDefaults === undefined
              ? {}
              : { selectWithDefaults: prompts.selectArtifactsWithDefaults }),
          });
        };
      }
      // else: non-TTY without --yes → proposeInstallFn stays undefined → runInit skips proposal step.

      // askAssistants: target-assistant(s) picker (E7, R1).
      // Gate: use injected prompts.askAssistants when provided (test injection,
      //       always honoured regardless of TTY); skip the prompt under --yes
      //       (same "accept defaults, no prompt" rule as proposeInstallFn —
      //       runInit falls back to on-disk detection); build the real clack
      //       multiselect only in a real interactive TTY; otherwise leave
      //       undefined — runInit falls back to on-disk detection (no network).
      let askAssistantsFn: (() => Promise<Assistant[]>) | undefined;

      if (prompts.askAssistants !== undefined) {
        askAssistantsFn = prompts.askAssistants;
      } else if (flags['yes'] !== true && process.stdout.isTTY) {
        askAssistantsFn = async (): Promise<Assistant[]> => {
          const { multiselect, isCancel, cancel } = await import('@clack/prompts');
          const result = await multiselect<Assistant>({
            message: 'Which assistant(s) do you want to configure?',
            options: [
              { value: 'claude', label: 'claude' },
              { value: 'opencode', label: 'opencode' },
            ],
            required: false,
          });
          if (isCancel(result)) {
            // R2: interruption, not a silent "configure nothing" default —
            // propagate so runInit never persists config.assistants.
            cancel('Operation cancelled.');
            throw new CancelledError();
          }
          return result;
        };
      }

      // fetchCatalogFn: resolves remote version then fetches catalog.json.
      // Only provided when proposeInstallFn is set — runInit skips both when either is absent.
      const fetchCatalogFn = proposeInstallFn === undefined
        ? undefined
        : async (url: string): Promise<CatalogProposal> => {
          const version = await resolveVersion(url, runner);
          const { meta, entries } = await fetchCatalog(
            url,
            version.ref,
            version.isTag,
            runner,
            { tmpFactory },
          );
          // Determine the source name by loading the just-saved config (runInit
          // persists catalogs[] before calling fetchCatalogFn). Fall back to
          // 'principal' which is the name cmd-init.ts always assigns.
          let sourceName = 'principal';
          try {
            const initConf = await loadCliConfig(env);
            const primary = initConf.catalogs[0];
            if (primary !== undefined) sourceName = primary.name;
          } catch {
            // Config not yet saved or unreadable — keep 'principal' as fallback.
          }
          return {
            meta,
            entries: qualifyEntries(sourceName, entries),
            sourceName,
          };
        };

      // Adapt the catalog CommandRunner (optional stdout/stderr, optional args)
      // to the preflight-auth CommandRunner (required stdout/stderr, required args).
      // This is safe: preflightAuth always provides args and always uses stdout/stderr.
      // opts (env forwarding) is only relevant for the real preflightAuth path; the
      // test runner does not need it, so we silently discard it here.
      const initRunner: import('./preflight-auth').CommandRunner = (cmd, args, _opts) =>
        runner(cmd, args ?? []).then((r) => ({
          exitCode: r.exitCode,
          stdout: r.stdout ?? '',
          stderr: r.stderr ?? '',
        }));

      const result = await runInit({
        configPath,
        askUrl: prompts.askUrl,
        askMethod: prompts.askMethod,
        // Forward the runner so preflightAuth uses the injected runner in tests
        // (production: defaultRunner; tests: deps.remote?.run).
        run: initRunner,
        env,
        ...(fetchCatalogFn === undefined ? {} : { fetchCatalogFn }),
        ...(proposeInstallFn === undefined ? {} : { proposeInstall: proposeInstallFn }),
        ...(askAssistantsFn === undefined ? {} : { askAssistants: askAssistantsFn }),
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
  print: (msg: string) => void;
  deps: CliDeps;
  /** Every --secret-env=<ref>=<VAR> occurrence (R5, lot 6) — forwarded to `<resource> add`. */
  secretEnvFlags: string[];
}

async function handleResourceCommand(opts: ResourceCommandOpts): Promise<number> {
  const { resource, verb, ids, flags, scope, env, print, deps, secretEnvFlags } = opts;

  const natureMapped = RESOURCE_NATURE_MAP[resource] ?? 'catalog';

  // ----- catalog source management: ls, add, remove -----
  // Intercept before artifact-level routing so that `catalog add/remove` manage
  // configured sources (config.catalogs[]) rather than artifact entries.
  //
  // For `catalog add` (M7/R9): after persisting the source, propose an install
  // using the same interactive mechanism as `init`. Both fetchCatalogFn and
  // proposeInstall are gated on the same TTY / injection logic as in `init`.
  if (resource === 'catalog' && (verb === 'add' || verb === 'remove' || verb === 'ls')) {
    const configPath = resolveConfigPath(env);

    if (verb !== 'add') {
      return runCatalog({ verb, args: ids, configPath, print });
    }

    // verb === 'add': build the proposal fns (TTY gate / test injection).
    const runner: CommandRunner = deps.remote?.run ?? defaultRunner;
    const tmpFactory: TmpDirFactory = deps.remote?.tmpFactory ?? defaultTmpFactory;

    const prompts = deps.prompts;

    let proposeInstallFn: ((catalog: CatalogProposal) => Promise<string[]>) | undefined;

    if (prompts?.proposeInstall !== undefined) {
      // Test injection: use the injected fn directly.
      proposeInstallFn = prompts.proposeInstall;
    } else if (process.stdout.isTTY) {
      // Real TTY: delegate to the shared interactive picker + install helper.
      // The install source (url + name) comes from the catalog proposal itself —
      // they are the just-added source, passed through catalog.sourceName and
      // injected as the explicit catalogUrl by fetchCatalogFn below.
      proposeInstallFn = async (catalog: CatalogProposal): Promise<string[]> => {
        const addedName = catalog.sourceName;
        // catalogUrl: the newly-added source's url is in ids[1] (args: [name, url]).
        // It was passed to fetchCatalogFn and is now canonically stored in the config.
        // Load it from config to ensure consistency (same pattern as init).
        let addedUrl = ids[1] ?? '';
        try {
          const conf = await loadCliConfig(env);
          const src = conf.catalogs.find((c) => c.name === addedName);
          if (src !== undefined) addedUrl = src.url;
        } catch {
          // Config not readable — fall back to the explicit url arg.
        }

        return runInteractiveProposeInstall(catalog, {
          catalogUrl: addedUrl,
          sourceName: addedName,
        }, {
          scope,
          env,
          runner,
          tmpFactory,
          print,
          ...(deps.remote?.scanner === undefined ? {} : { scanner: deps.remote.scanner }),
        });
      };
    }

    // fetchCatalogFn: resolves remote version then fetches catalog.json for the
    // just-added source. Receives (url, name) directly from runCatalog after persist.
    // Only built when proposeInstallFn is set — runCatalog skips both when either is absent.
    const fetchCatalogFn = proposeInstallFn === undefined
      ? undefined
      : async (url: string, name: string): Promise<CatalogProposal> => {
        const version = await resolveVersion(url, runner);
        const { meta, entries } = await fetchCatalog(
          url,
          version.ref,
          version.isTag,
          runner,
          { tmpFactory },
        );
        return {
          meta,
          entries: qualifyEntries(name, entries),
          sourceName: name,
        };
      };

    return runCatalog({
      verb,
      args: ids,
      configPath,
      print,
      ...(fetchCatalogFn === undefined ? {} : { fetchCatalogFn }),
      ...(proposeInstallFn === undefined ? {} : { proposeInstall: proposeInstallFn }),
    });
  }

  // ----- <resource> ls -----
  if (verb === 'ls' || verb === undefined) {
    // Optional --assistant filter (read-only: absent = show every assistant).
    const assistantFilter = parseAssistantFilterFlag(flags);
    if (assistantFilter === 'invalid') {
      print(
        `[error] Invalid --assistant value: "${
          flags['assistant']
        }". Must be "claude" or "opencode".`,
      );
      return 2;
    }

    const effectiveCatalog = await resolveEffectiveCatalog(env, print, deps.remote);
    if (effectiveCatalog.length === 0) {
      return 0;
    }
    const assistantOpts = assistantFilter === undefined ? {} : { assistant: assistantFilter };
    let result: RunLsResult;
    if (natureMapped === 'catalog') {
      result = await runLs({ catalog: effectiveCatalog, env, scope, ...assistantOpts });
    } else {
      result = await runLs({
        catalog: effectiveCatalog,
        env,
        scope,
        resourceFilter: natureMapped,
        ...assistantOpts,
      });
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

    // Validate each id belongs to the resource — strict qualified match (ADR-0017 §5).
    const effectiveCatalog = await resolveEffectiveCatalog(env, print, deps.remote);

    // Reject unqualified ids immediately with an actionable error.
    const unqualifiedIds = ids.filter((id) => !id.includes('/'));
    if (unqualifiedIds.length > 0) {
      for (const id of unqualifiedIds) {
        print(
          `[error] unqualified id "${id}" — use \`<catalog>/${id}\` (see \`agent-rigger ls\`)`,
        );
      }
      return 2;
    }

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

    return await handleInstall({ ids, flags, scope, env, print, deps, secretEnvFlags });
  }

  // ----- <resource> info <id> -----
  if (verb === 'info') {
    const id = ids[0];
    if (id === undefined) {
      print(`[error] "${resource} info" requires an artifact id.\n\n${USAGE}`);
      return 2;
    }

    // Reject unqualified id immediately with an actionable error (ADR-0017 §5).
    if (!id.includes('/')) {
      print(
        `[error] unqualified id "${id}" — use \`<catalog>/${id}\` (see \`agent-rigger ls\`)`,
      );
      return 2;
    }

    // Optional --assistant filter (read-only: absent = "installed for any assistant").
    const assistantFilter = parseAssistantFilterFlag(flags);
    if (assistantFilter === 'invalid') {
      print(
        `[error] Invalid --assistant value: "${
          flags['assistant']
        }". Must be "claude" or "opencode".`,
      );
      return 2;
    }

    const effectiveCatalog = await resolveEffectiveCatalog(env, print, deps.remote);
    const entry = effectiveCatalog.find((e) => e.id === id);
    if (entry === undefined) {
      print(`[error] Unknown artifact id "${id}". Run "agent-rigger ls" to see available entries.`);
      return 2;
    }

    // Read manifest to determine installed status (exact qualified id match).
    // Without --assistant: "installed" if present for ANY assistant (R1) —
    // with --assistant: only that assistant's identical-id entry counts.
    const canonicalId = entry.id;
    const targets = resolveUserTargets(env);
    let installed = false;
    try {
      const { readManifest } = await import('@agent-rigger/core/manifest');
      const manifest = await readManifest(targets.stateJson);
      installed = manifest.artifacts.some(
        (a) =>
          a.id === canonicalId
          && a.scope === scope
          && (assistantFilter === undefined || (a.assistant ?? 'claude') === assistantFilter),
      );
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

    // Manifest-first assistant routing (M18/ADR-0020 §1), same as top-level
    // check: when every matching manifest entry belongs to one assistant, use
    // it — never the silent non-TTY 'claude' fallback while the installed
    // entries are opencode's. Scoped to the ids being audited (this nature).
    const assistant = await resolveManifestAssistant({
      flags,
      env,
      scope,
      ids: filteredEntries.map((e) => e.id),
    });
    const manifestPath = resolveManifestPath(env);
    const adapter = await buildAdapter(assistant, env);
    const result = await runCheck({
      adapter,
      entries: filteredEntries,
      scope,
      env,
      manifestPath,
    });

    print(result.output);

    // Best-effort catalog status + update-available annotation (same as top-level check).
    const remoteSections = await resolveCheckRemoteSections(env, scope, deps.remote, assistant);
    printRemoteSections(print, remoteSections);

    return result.exitCode;
  }

  // ----- <resource> update <id...> -----
  if (verb === 'update') {
    if (ids.length === 0) {
      print(`[error] "${resource} update" requires at least one artifact id.\n\n${USAGE}`);
      return 2;
    }

    // Validate each id belongs to the resource — strict qualified match (ADR-0017 §5).
    const singular = resource.replace(/s$/, '');
    const effectiveCatalog = await resolveEffectiveCatalog(env, print, deps.remote);

    // Reject unqualified ids immediately with an actionable error.
    const unqualifiedUpdateIds = ids.filter((id) => !id.includes('/'));
    if (unqualifiedUpdateIds.length > 0) {
      for (const id of unqualifiedUpdateIds) {
        print(
          `[error] unqualified id "${id}" — use \`<catalog>/${id}\` (see \`agent-rigger ls\`)`,
        );
      }
      return 2;
    }

    const invalidIds = ids.filter((id) => {
      const catalogEntry = effectiveCatalog.find((e) => e.id === id);
      if (catalogEntry !== undefined) {
        if (natureMapped === 'pack') return catalogEntry.kind !== 'pack';
        return catalogEntry.kind !== 'artifact' || catalogEntry.nature !== natureMapped;
      }
      // For external ids not in catalog: infer nature from known prefixes (qualified form).
      const PREFIX_TO_NATURE: Record<string, string> = {
        'skill:': 'skill',
        'agent:': 'agent',
        'guardrail:': 'guardrail',
        'context:': 'context',
        'plugin:': 'plugin',
        'tool:': 'tool',
        'pack:': 'pack',
      };
      // Strip qualifier to get local part for prefix inference.
      const localPart = localId(id);
      for (const [prefix, nature] of Object.entries(PREFIX_TO_NATURE)) {
        if (localPart.startsWith(prefix)) {
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

    return await handleUpdate({ ids, flags, scope, env, print, deps });
  }

  // ----- <resource> remove <id...> -----
  if (verb === 'remove') {
    if (ids.length === 0) {
      print(`[error] "${resource} remove" requires at least one artifact id.\n\n${USAGE}`);
      return 2;
    }

    // Reject unqualified ids immediately with an actionable error (ADR-0017 §5).
    const unqualifiedRemoveIds = ids.filter((id) => !id.includes('/'));
    if (unqualifiedRemoveIds.length > 0) {
      for (const id of unqualifiedRemoveIds) {
        print(
          `[error] unqualified id "${id}" — use \`<catalog>/${id}\` (see \`agent-rigger ls\`)`,
        );
      }
      return 2;
    }

    // R5: validate the nature from the manifest — remove never fetches the
    // catalog (manifest-first, offline). Packs never reach the manifest, so a
    // found entry can never satisfy natureMapped === 'pack'.
    const { readManifest } = await import('@agent-rigger/core/manifest');
    const manifest = await readManifest(resolveManifestPath(env));

    const invalidIds = ids.filter((id) => {
      const entry = manifest.artifacts.find((e) => e.id === id);
      if (entry === undefined) return false; // runRemove raises the "not installed" error
      return entry.nature !== natureMapped;
    });

    if (invalidIds.length > 0) {
      const singular = resource.replace(/s$/, '');
      for (const id of invalidIds) {
        print(`[error] id "${id}" is not a ${singular}`);
      }
      return 2;
    }

    return await handleRemove({ ids, flags, scope, env, print, deps });
  }

  // ----- unknown verb (includes planned: update) -----
  print(`Unknown verb "${verb ?? ''}" for resource "${resource}".\n\n${USAGE}`);
  return 2;
}

// ---------------------------------------------------------------------------
// assertConfirmableOrYes — non-TTY fail-closed gate (R4, ADR-0018, ADR-0024)
// ---------------------------------------------------------------------------

/**
 * Fail-closed gate for any command that would ask for a confirmation prompt
 * (install, remove, update, ad-hoc install).
 *
 * clack `confirm`/`select`/`multiselect` on a non-TTY stdin never resolves —
 * it hangs forever (proven empirically). A CI job that omits `--yes` would
 * therefore checkout, scan, and then freeze on the confirmation. This gate is
 * called at the HEAD of every confirming handler, before any catalog
 * resolution / network fetch / checkout / scan, so the process exits 2 with an
 * actionable message instead of doing work it would then block on.
 *
 * - `--yes` present → proceed (scripted, non-interactive path, unchanged).
 * - TTY session     → proceed (the real interactive prompt can run).
 * - non-TTY, no `--yes` → the request cannot be satisfied (ADR-0024 exit 2):
 *   print an actionable message and return false; the caller returns 2.
 *
 * The caller guards this with `deps.prompts === undefined` (see each handler):
 * the hang this gate prevents can only happen when the REAL clack prompts are
 * used (`deps.prompts ?? importUiPrompts()`). When a caller injects
 * `deps.prompts` — only reachable programmatically, never from the CLI/argv
 * surface — those stand-ins resolve synchronously, so there is nothing to hang
 * on and the gate would wrongly reject a caller that supplies its own answers.
 * In production `runCli(process.argv.slice(2))` passes no deps, so the gate is
 * unconditional there and the R4 security property holds on the real CLI.
 *
 * This is the same fail-closed policy already codified in remote-install and
 * secret-collect, generalised to one helper (design decision 4).
 *
 * @returns `true` when it is safe to proceed; `false` after printing the
 *   error, in which case the caller must return exit 2.
 */
function assertConfirmableOrYes(
  flags: Record<string, string | boolean>,
  print: (msg: string) => void,
): boolean {
  if (flags['yes'] === true) return true;
  // R4: the hang this gate prevents is a property of STDIN (clack's Prompt
  // reads keypresses from `stdin`; `setRawMode` only applies when
  // `stdin.isTTY`). Gating on stdout.isTTY is bypassable by redirecting only
  // stdin (stdout still a TTY) — the gate must track the stream the prompt
  // actually blocks on.
  if (process.stdin.isTTY === true) return true;
  print('[error] non-interactive session — pass --yes to confirm non-interactively');
  return false;
}

// ---------------------------------------------------------------------------
// handleInstall — shared install logic (interactive or non-interactive)
// ---------------------------------------------------------------------------

interface HandleInstallOpts {
  ids: string[];
  flags: Record<string, string | boolean>;
  scope: 'user' | 'project';
  env: Env;
  print: (msg: string) => void;
  deps: CliDeps;
  /** Every --secret-env=<ref>=<VAR> occurrence, in argv order (R5, lot 6). */
  secretEnvFlags: string[];
}

async function handleInstall(opts: HandleInstallOpts): Promise<number> {
  const { ids, flags, scope, env, print, deps, secretEnvFlags } = opts;

  const yes = flags['yes'] === true;
  const force = flags['force'] === true;

  // R5 (lot 6, D5): collect --secret-env overrides BEFORE any checkout or
  // run-lock. An invalid "<ref>=<VAR>" value is an actionable error
  // (InvalidSecretEnvFlagError, mapped to exit 2 by handleError) — fails fast,
  // before catalogs are even resolved. The resulting ref→VAR map is threaded
  // through, unconsumed here: the render (env-presence check, substitution)
  // is T6 — this is plumbing only.
  const secretOverrides = parseSecretEnvFlags(secretEnvFlags);

  // b1b4-R1: fail-fast the interactive picker on a non-TTY stdin with no ids,
  // BEFORE the confirm gate below. --yes satisfies assertConfirmableOrYes, but
  // the interactive branch then drives selectScope/the clack status picker,
  // which never resolves on a non-TTY stdin (proven hang, ADR-0024). Placed
  // ahead of the gate on purpose: the no-ids case must produce "pass explicit
  // ids" even without --yes — the gate's "pass --yes" message would otherwise
  // route the user straight into that hang. Guarded by deps.prompts ===
  // undefined for parity with the confirm gate below: injected prompts answer
  // synchronously, so nothing hangs and the guard must not reject them.
  if (deps.prompts === undefined && ids.length === 0 && process.stdin.isTTY !== true) {
    print(
      '[error] interactive picker requires a TTY — pass explicit ids to install non-interactively',
    );
    return 2;
  }

  // R4 (ADR-0018, ADR-0024): fail-closed before any catalog resolution,
  // network fetch, checkout or scan — but after the flag-level validation
  // above (a malformed --secret-env is a more specific "impossible request"
  // and must surface its own message). A non-TTY session without --yes cannot
  // answer the confirmation prompt (it would hang), so exit 2 immediately.
  // Guarded by deps.prompts === undefined: the hang only exists when the real
  // clack prompts run; an injected prompt set answers synchronously.
  if (deps.prompts === undefined && !assertConfirmableOrYes(flags, print)) return 2;

  // Resolve the target assistant once (R1): flag > config.assistants > detected
  // > TTY prompt > 'claude' fallback (back-compat, see resolveCliAssistant).
  const assistant = await resolveCliAssistant(flags, env);

  // Non-interactive: ids provided on the command line
  if (ids.length > 0) {
    // Ad-hoc install: single URL or local path — routed before the qualified-id checks.
    // We only support one ad-hoc target per invocation (unambiguous, scannable, qualifiable).
    const firstId = ids[0] as string;
    if (ids.length === 1 && isAdHocTarget(firstId)) {
      return handleAdHocInstall({
        source: firstId,
        flags,
        scope,
        env,
        print,
        deps,
        assistant,
        secretOverrides,
      });
    }

    // Reject unqualified ids immediately with an actionable error (ADR-0017 §5).
    const unqualifiedInstallIds = ids.filter((id) => !id.includes('/'));
    if (unqualifiedInstallIds.length > 0) {
      for (const id of unqualifiedInstallIds) {
        print(
          `[error] unqualified id "${id}" — use \`<catalog>/${id}\` (see \`agent-rigger ls\`)`,
        );
      }
      return 2;
    }

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

    // Load config to route each qualified id to its source catalog (ADR-0017 §5).
    // The prefix (part before the first '/') names the catalog; we group ids by prefix
    // and run one runRemoteInstall per source so each checkout targets the right URL.
    const config = await loadCliConfig(env);

    if (config.catalogs.length === 0) {
      // No catalogs configured (R1, ADR-0024): the request cannot be
      // satisfied — a missing precondition, not a voluntary abort. Nothing
      // is written (no manifest, no config). Same message used by the
      // interactive site below.
      print('[error] no catalog configured — run `agent-rigger init`');
      return 2;
    }

    const runner: CommandRunner = deps.remote?.run ?? defaultRunner;
    const tmpFactory: TmpDirFactory = deps.remote?.tmpFactory ?? defaultTmpFactory;

    // Group ids by their catalog prefix.
    const groupedByPrefix = new Map<string, string[]>();
    for (const id of ids) {
      const slashIdx = id.indexOf('/');
      const prefix = slashIdx === -1 ? '' : id.slice(0, slashIdx);
      const existing = groupedByPrefix.get(prefix);
      if (existing === undefined) {
        groupedByPrefix.set(prefix, [id]);
      } else {
        existing.push(id);
      }
    }

    // Validate all prefixes resolve to a configured catalog before touching the network.
    for (const prefix of groupedByPrefix.keys()) {
      const catalog = config.catalogs.find((c) => c.name === prefix);
      if (catalog === undefined) {
        print(
          `[error] catalog "${prefix}" not configured — see \`agent-rigger catalog ls\``,
        );
        return 2;
      }
    }

    // Run one install per source catalog (sequential — each requires its own checkout).
    for (const [prefix, groupIds] of groupedByPrefix) {
      const catalog = config.catalogs.find((c) => c.name === prefix) as {
        name: string;
        url: string;
      };

      const remoteOpts = {
        ids: groupIds,
        catalogUrl: catalog.url,
        sourceName: catalog.name,
        scope,
        env,
        manifestPath,
        runner,
        tmpFactory,
        confirm,
        assistant,
        ...(force ? { force } : {}),
        ...(deps.remote?.scanner === undefined ? {} : { scanner: deps.remote.scanner }),
        ...(Object.keys(secretOverrides).length === 0 ? {} : { secretOverrides }),
      };

      const result = await runRemoteInstall(remoteOpts);
      print(result.output);
    }

    return 0;
  }

  // Interactive: no ids — use selectArtifacts prompt with effective catalog (remote only).
  const prompts = deps.prompts ?? (await importUiPrompts());

  // Load config up-front (R1, ADR-0024): interactive install is still an
  // explicit request for install — no catalog configured is a missing
  // precondition, not a voluntary abort, same as the non-interactive site
  // above (same message, same code). Reused below for the per-prefix
  // routing, so this is the only load for the whole interactive branch.
  const interactiveConfig = await loadCliConfig(env);

  if (interactiveConfig.catalogs.length === 0) {
    print('[error] no catalog configured — run `agent-rigger init`');
    return 2;
  }

  const effectiveFull = await resolveEffectiveCatalogFull(env, print, deps.remote);
  const effective = effectiveFull.entries;

  if (effectiveFull.allSourcesFailed) {
    // Every configured source failed to fetch (R1 offline): same intent,
    // same code as the explicit path (RemoteFetchError → 1 via handleError)
    // — not an empty picker silently exiting 0. When at least one source
    // responds, allSourcesFailed is false and the flow below proceeds on
    // the partial catalog (existing per-source degradation, unchanged).
    return 1;
  }

  if (effective.length === 0) {
    return 0;
  }

  let selectedIds: string[];
  let interactiveScope: 'user' | 'project';

  // R6: when --scope was given explicitly, honor it and skip the scope prompt
  // entirely — statuses/picker below are computed on this resolved scope,
  // same as the flagless prompt path. `scope` (opts) already carries the
  // resolved value (flag > 'user' default); flags['scope'] !== undefined is
  // the only reliable signal that the flag was actually passed (see central
  // validation above, which already rejected any invalid value).
  const scopeFlagProvided = flags['scope'] !== undefined;

  const statusPicker = prompts.selectArtifactsByStatus;
  if (statusPicker === undefined) {
    // Legacy flow (preserved order for injected-prompt tests without the picker).
    selectedIds = await prompts.selectArtifacts(effective);
    if (selectedIds.length === 0) {
      print('No artifacts selected — nothing to install.');
      return 0;
    }
    interactiveScope = scopeFlagProvided ? scope : await prompts.selectScope(assistant);
  } else {
    // Status-aware flow: scope first (status is per-scope), classify each entry
    // against the manifest + remote version, short-circuit when nothing is
    // actionable, then render the grouped install/update picker.
    interactiveScope = scopeFlagProvided ? scope : await prompts.selectScope(assistant);
    const statuses = await computeArtifactStatuses(
      effective,
      interactiveScope,
      env,
      deps,
      assistant,
    );
    const actionable = statuses.filter((s) => s.status !== 'current');
    if (actionable.length === 0) {
      // b1b4-R3 (WEAK fix): count only manifest-tracked artifacts — a
      // synthesized pack ('current' via its members) is not itself installed,
      // so counting it would overstate "N artifact(s) installed".
      const installedCount = statuses.filter((s) => s.kind !== 'pack').length;
      print(
        `✓ Everything already up-to-date for scope "${interactiveScope}" `
          + `(${installedCount} artifact(s) installed). Use \`agent-rigger remove\` to uninstall.`,
      );
      return 0;
    }
    // b1b4-R4: relay each catalog's meta opinion into the picker's pre-check.
    // metaBySource carries bare ids per source (no new fetch). A source
    // "declares an opinion" only when its recommended list is non-empty
    // (MetaSchema defaults to []) — a required-only catalog is NOT opting and
    // keeps the historical "check all install" (required included). For an
    // opting catalog the pre-check covers required ∪ recommended (R4a
    // amendment: required must not fall out). Anti-leak (R4b amendment): admit
    // an id only if it belongs to THIS source — bare (qualifyRef prefixes it)
    // or already qualified by its own prefix; a foreign pre-qualified id is
    // ignored, closing the cross-catalog forge at the entry point (governance.ts
    // shares the pattern but is out of this diff — tracked in the report).
    const preChecked = new Set<string>();
    const optingPrefixes = new Set<string>();
    for (const [sourceName, meta] of effectiveFull.metaBySource) {
      const recs = meta.recommended ?? [];
      if (recs.length === 0) continue;
      optingPrefixes.add(sourceName);
      // governance-id-forge: own ids only (foreign pre-qualified ids in another
      // catalog's meta can't forge a pre-check here). required ∪ recommended.
      for (const id of partitionMetaIds(sourceName, [...(meta.required ?? []), ...recs]).own) {
        preChecked.add(id);
      }
    }
    selectedIds = await statusPicker(statuses, { preChecked, optingPrefixes });
    if (selectedIds.length === 0) {
      print('No artifacts selected — nothing to install.');
      return 0;
    }
  }

  const interactiveManifestPath = resolveManifestPath(env);
  // interactiveConfig already loaded above (catalogs.length > 0, checked before
  // any fetch) — reused here for the per-prefix routing, no second load.

  const interactiveRunner: CommandRunner = deps.remote?.run ?? defaultRunner;
  const interactiveTmpFactory: TmpDirFactory = deps.remote?.tmpFactory ?? defaultTmpFactory;

  // Group selected ids by prefix and install per source (same routing as non-interactive).
  const interactiveGrouped = new Map<string, string[]>();
  for (const id of selectedIds) {
    const slashIdx = id.indexOf('/');
    const prefix = slashIdx === -1 ? '' : id.slice(0, slashIdx);
    const existing = interactiveGrouped.get(prefix);
    if (existing === undefined) {
      interactiveGrouped.set(prefix, [id]);
    } else {
      existing.push(id);
    }
  }

  for (const [prefix, groupIds] of interactiveGrouped) {
    const catalog = interactiveConfig.catalogs.find((c) => c.name === prefix);
    if (catalog === undefined) {
      // Interactive picker always yields qualified ids from effective catalog, so an
      // unresolvable prefix here is a data inconsistency — skip with a warning.
      print(`[warning] catalog "${prefix}" not configured — entries ignored`);
      continue;
    }

    const interactiveOpts = {
      ids: groupIds,
      catalogUrl: catalog.url,
      sourceName: catalog.name,
      scope: interactiveScope,
      env,
      manifestPath: interactiveManifestPath,
      runner: interactiveRunner,
      tmpFactory: interactiveTmpFactory,
      confirm: (planText: string) => prompts.confirmApply(planText),
      assistant,
      ...(force ? { force } : {}),
      ...(deps.remote?.scanner === undefined ? {} : { scanner: deps.remote.scanner }),
      ...(Object.keys(secretOverrides).length === 0 ? {} : { secretOverrides }),
    };

    const remoteResult = await runRemoteInstall(interactiveOpts);
    print(remoteResult.output);
  }

  return 0;
}

// ---------------------------------------------------------------------------
// handleAdHocInstall — install from a URL or local path outside configured catalogs
// ---------------------------------------------------------------------------

interface HandleAdHocInstallOpts {
  source: string;
  flags: Record<string, string | boolean>;
  scope: 'user' | 'project';
  env: Env;
  print: (msg: string) => void;
  deps: CliDeps;
  /** Target assistant, already resolved by resolveCliAssistant (R1). */
  assistant: Assistant;
  /** ref→VAR overrides already parsed from --secret-env by the caller (R5, lot 6). */
  secretOverrides: Record<string, string>;
}

/**
 * Install content from an ad-hoc URL or local path (R8).
 *
 * The content is treated as untrusted (ADR-0018):
 * - The composite scanner runs over all fetchable entries.
 * - If no scanner tool is installed: warn-only, install proceeds (ADR-0018).
 * - If the scanner finds issues and --force is absent: blocks with ScanBlockedError.
 * - If --force: emits warning and proceeds.
 *
 * The source prefix is derived from the URL/path hostname+repo (deriveAdHocPrefix)
 * and used to qualify all installed ids, so the manifest stores
 * `<derived-prefix>/<nature:name>` (ADR-0017 provenance).
 *
 * Flow:
 * 1. Fetch the remote catalog (lightweight checkout via fetchRemoteCatalog).
 * 2. Qualify entries with the derived prefix.
 * 3. Show a picker (interactive) or select all (--yes / non-TTY).
 * 4. Call runRemoteInstall with the selected ids and derivedPrefix as sourceName —
 *    runRemoteInstall performs the real checkout, scan, and install.
 */
async function handleAdHocInstall(opts: HandleAdHocInstallOpts): Promise<number> {
  const { source, flags, scope, env, print, deps, assistant, secretOverrides } = opts;

  // R4 (ADR-0018, ADR-0024): fail-closed before the ad-hoc fetch/scan. A
  // non-TTY session without --yes cannot answer the confirmation prompt, and
  // the untrusted select-all below must never run without explicit consent —
  // exit 2 immediately. (handleInstall already gates before routing here; this
  // second guard keeps the handler safe on its own.) Guarded by
  // deps.prompts === undefined — see assertConfirmableOrYes.
  if (deps.prompts === undefined && !assertConfirmableOrYes(flags, print)) return 2;

  const yes = flags['yes'] === true;
  const force = flags['force'] === true;

  const derivedPrefix = deriveAdHocPrefix(source);

  const runner: CommandRunner = deps.remote?.run ?? defaultRunner;
  const tmpFactory: TmpDirFactory = deps.remote?.tmpFactory ?? defaultTmpFactory;
  const manifestPath = resolveManifestPath(env);

  // Step 1: fetch the catalog to enumerate available entries.
  const remoteCatalog = await fetchRemoteCatalog({ url: source, run: runner, tmpFactory });

  // Step 2: qualify entries so the picker shows fully-qualified ids.
  const qualifiedEntries = qualifyEntries(derivedPrefix, remoteCatalog.entries);

  // Step 3: select which entries to install.
  let selectedIds: string[];
  if (yes) {
    // --yes: install all entries from the remote catalog. This select-all over
    // untrusted content is the documented, explicitly-consented behaviour
    // (R4). The non-TTY-without-yes case never reaches here — it is stopped by
    // assertConfirmableOrYes above, so the `|| !process.stdout.isTTY` arm that
    // used to select-all silently on a non-TTY session is gone.
    selectedIds = qualifiedEntries.map((e) => e.id);
  } else {
    // Interactive: show picker.
    const prompts = deps.prompts ?? (await importUiPrompts());
    selectedIds = await prompts.selectArtifacts(qualifiedEntries);
    if (selectedIds.length === 0) {
      print('No artifacts selected — nothing to install.');
      return 0;
    }
  }

  if (selectedIds.length === 0) {
    print('Remote catalog is empty — nothing to install.');
    return 0;
  }

  // Confirmation strategy (mirrors handleInstall non-interactive path).
  let confirm: boolean | ((planText: string) => Promise<boolean>);
  if (yes) {
    confirm = true;
  } else {
    const prompts = deps.prompts ?? (await importUiPrompts());
    confirm = (planText: string) => prompts.confirmApply(planText);
  }

  // Step 4: run the actual install. runRemoteInstall re-fetches via withRemoteCheckout,
  // runs scanEntries (mandatory for ad-hoc — untrusted content), qualifies with
  // derivedPrefix as sourceName, and writes to the manifest.
  const remoteOpts = {
    ids: selectedIds,
    catalogUrl: source,
    sourceName: derivedPrefix,
    scope,
    env,
    manifestPath,
    runner,
    tmpFactory,
    confirm,
    assistant,
    ...(force ? { force } : {}),
    ...(deps.remote?.scanner === undefined ? {} : { scanner: deps.remote.scanner }),
    ...(Object.keys(secretOverrides).length === 0 ? {} : { secretOverrides }),
  };

  const result = await runRemoteInstall(remoteOpts);

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
  print: (msg: string) => void;
  deps: CliDeps;
}

async function handleRemove(opts: HandleRemoveOpts): Promise<number> {
  const { ids, flags, scope, env, print, deps } = opts;

  if (ids.length === 0) {
    print(`[error] "remove" requires at least one artifact id.\n\n${USAGE}`);
    return 2;
  }

  // Reject unqualified ids immediately with an actionable error (ADR-0017 §5).
  const unqualifiedRemIds = ids.filter((id) => !id.includes('/'));
  if (unqualifiedRemIds.length > 0) {
    for (const id of unqualifiedRemIds) {
      print(
        `[error] unqualified id "${id}" — use \`<catalog>/${id}\` (see \`agent-rigger ls\`)`,
      );
    }
    return 2;
  }

  // R4 (ADR-0018, ADR-0024): fail-closed before any mutation. A non-TTY
  // session without --yes cannot answer the confirmation prompt — exit 2
  // immediately, after the actionable arg-validation errors above but before
  // any adapter build or manifest write. Guarded by deps.prompts === undefined
  // — see assertConfirmableOrYes.
  if (deps.prompts === undefined && !assertConfirmableOrYes(flags, print)) return 2;

  const yes = flags['yes'] === true;
  // Resolve the target assistant once (R1/M18): flag > manifest routing
  // (entry.assistant of the requested ids, ADR-0020 §1 — no re-prompt) >
  // config/detection fallback when the manifest has no answer.
  const assistant = await resolveManifestAssistant({ flags, env, scope, ids });
  const adapter = await buildAdapter(assistant, env);
  const manifestPath = resolveManifestPath(env);

  // R5: no catalog resolution — remove validates against the manifest alone
  // (runRemove), so the whole path works offline and never fetches a source.

  let confirm: boolean | ((planText: string) => Promise<boolean>);
  if (yes) {
    confirm = true;
  } else {
    const prompts = deps.prompts ?? (await importUiPrompts());
    confirm = (planText: string) => prompts.confirmApply(planText);
  }

  // ids are already qualified (validated by callers — ADR-0017 §5).
  const result = await runRemove({
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
  print: (msg: string) => void;
  deps: CliDeps;
}

async function handleUpdate(opts: HandleUpdateOpts): Promise<number> {
  const { ids, flags, scope, env, print, deps } = opts;

  // Reject unqualified ids immediately with an actionable error (ADR-0017 §5).
  // update with no ids = "all installed" → no per-id validation needed.
  if (ids.length > 0) {
    const unqualifiedUpdateIds = ids.filter((id) => !id.includes('/'));
    if (unqualifiedUpdateIds.length > 0) {
      for (const id of unqualifiedUpdateIds) {
        print(
          `[error] unqualified id "${id}" — use \`<catalog>/${id}\` (see \`agent-rigger ls\`)`,
        );
      }
      return 2;
    }
  }

  // R4 (ADR-0018, ADR-0024): fail-closed before any catalog resolution,
  // network fetch, checkout or mutation. A non-TTY session without --yes
  // cannot answer the confirmation prompt — exit 2 immediately. Guarded by
  // deps.prompts === undefined — see assertConfirmableOrYes.
  if (deps.prompts === undefined && !assertConfirmableOrYes(flags, print)) return 2;

  const config = await loadCliConfig(env);

  if (config.catalogs.length === 0) {
    // No catalogs configured — surface as actionable error.
    print('[error] No catalog URL configured.');
    print('  Run `agent-rigger init` to configure the catalog URL.');
    return 2;
  }

  const yes = flags['yes'] === true;
  const force = flags['force'] === true;
  const runner: CommandRunner = deps.remote?.run ?? defaultRunner;
  const tmpFactory: TmpDirFactory = deps.remote?.tmpFactory ?? defaultTmpFactory;

  // Resolve the target assistant once (R1/M18): flag > manifest routing
  // (entry.assistant of the requested ids — or all installed entries when ids
  // is empty, ADR-0020 §1 — no re-prompt) > config/detection fallback.
  const assistant = await resolveManifestAssistant({ flags, env, scope, ids });

  let confirm: boolean | ((planText: string) => Promise<boolean>);
  if (yes) {
    confirm = true;
  } else {
    const prompts = deps.prompts ?? (await importUiPrompts());
    confirm = (planText: string) => prompts.confirmApply(planText);
  }

  const manifestPath = resolveManifestPath(env);
  const scannerOpts = deps.remote?.scanner === undefined ? {} : { scanner: deps.remote.scanner };

  if (ids.length === 0) {
    // update all installed — iterate each catalog; pass empty ids so runUpdate reads
    // the full manifest; then filter by prefix happens inside runUpdate (only entries
    // whose ids start with this catalog's name are in scope).
    // We drive it per-catalog with explicit ids derived from the manifest to ensure
    // each checkout targets the right URL.
    const { readManifest } = await import('@agent-rigger/core/manifest');
    const manifest = await readManifest(manifestPath);

    // b1b4-R2: track whether ANY catalog yielded a candidate. The per-catalog
    // `continue` below is silent by design; the no-op signal is raised once
    // after the loop only when nothing was installed anywhere for this
    // scope+assistant — never per-catalog (that would report "nothing here"
    // while another catalog still has work).
    let hadCandidates = false;

    for (const catalog of config.catalogs) {
      const prefix = catalog.name + '/';
      const catalogIds = manifest.artifacts
        .filter(
          (e) =>
            e.scope === scope
            && e.id.startsWith(prefix)
            && (e.assistant ?? 'claude') === assistant,
        )
        .map((e) => e.id);

      // Nothing installed from this catalog (for this assistant) → skip it.
      // Passing empty ids to runUpdate would trigger its "all installed"
      // semantics, reclassifying OTHER catalogs' entries against THIS
      // catalog's url/version and failing resolution (UnknownEntryError).
      // The loop always drives explicit ids.
      if (catalogIds.length === 0) continue;
      hadCandidates = true;

      const updateOpts = {
        ids: catalogIds,
        scope,
        env,
        manifestPath,
        catalogUrl: catalog.url,
        runner,
        tmpFactory,
        confirm,
        assistant,
        ...(force ? { force } : {}),
        ...scannerOpts,
      };

      const result = await runUpdate(updateOpts);
      print(result.output);
    }

    // b1b4-R2: no catalog had a candidate → nothing installed anywhere for
    // this scope+assistant. Signal the no-op once (same string as runUpdate's
    // defensive branch, via the shared constant). Exit code unchanged (0).
    if (!hadCandidates) print(NO_UPDATE_CANDIDATES_MSG);

    return 0;
  }

  // Explicit ids — validate prefixes then group by catalog (ADR-0017 §5).
  for (const id of ids) {
    const slashIdx = id.indexOf('/');
    const prefix = slashIdx === -1 ? '' : id.slice(0, slashIdx);
    const catalog = config.catalogs.find((c) => c.name === prefix);
    if (catalog === undefined) {
      print(
        `[error] catalog "${prefix}" not configured — see \`agent-rigger catalog ls\``,
      );
      return 2;
    }
  }

  const updateGrouped = new Map<string, string[]>();
  for (const id of ids) {
    const prefix = id.slice(0, id.indexOf('/'));
    const existing = updateGrouped.get(prefix);
    if (existing === undefined) {
      updateGrouped.set(prefix, [id]);
    } else {
      existing.push(id);
    }
  }

  for (const [prefix, groupIds] of updateGrouped) {
    const catalog = config.catalogs.find((c) => c.name === prefix) as { name: string; url: string };

    const updateOpts = {
      ids: groupIds,
      scope,
      env,
      manifestPath,
      catalogUrl: catalog.url,
      runner,
      tmpFactory,
      confirm,
      assistant,
      ...(force ? { force } : {}),
      ...scannerOpts,
    };

    const result = await runUpdate(updateOpts);
    print(result.output);
  }

  return 0;
}

// ---------------------------------------------------------------------------
// resolveCheckRemoteSections — best-effort catalog + update status for check
// ---------------------------------------------------------------------------

/** Per-catalog status + per-artifact stale detail rendered by `check`. */
interface CheckRemoteSections {
  /** One status line per configured catalog (always shown when catalogs exist). */
  catalogLines: string[];
  /** Per-artifact "[update available]" detail lines (only for stale artifacts). */
  updateLines: string[];
}

/**
 * Render a per-catalog status line, aligned and coloured to match check/doctor.
 *
 * kinds: current (green) · update (yellow) · available (dim) · unreachable (red).
 */
function catalogStatusLine(
  kind: 'current' | 'update' | 'available' | 'unreachable',
  name: string,
  ref: string,
  staleCount: number,
  colorOn: boolean,
): string {
  const TAG_WIDTH = 13; // widest tag is "[unreachable]"
  const tagged = (tag: string, color: string): string =>
    `  ${paint(tag, color, colorOn)}${' '.repeat(TAG_WIDTH - tag.length + 2)}${name}`;
  switch (kind) {
    case 'current':
      return `${tagged('[up-to-date]', ANSI.green)}  (${ref})`;
    case 'update':
      return `${tagged('[update]', ANSI.yellow)}  → ${ref}  (${staleCount} artifact(s) behind)`;
    case 'available':
      return `${tagged('[available]', ANSI.dim)}  (latest ${ref})`;
    case 'unreachable':
      return `${tagged('[unreachable]', ANSI.red)}  (version could not be resolved)`;
  }
}

/**
 * Resolve, per configured catalog, whether installed artifacts are up-to-date and
 * which ones are stale. Best-effort: any top-level error → empty sections (never
 * throws); a single unreachable catalog degrades to an "[unreachable]" line.
 * Only counts artifacts installed for `assistant` (one-assistant-per-transaction, R1).
 * Zero writes.
 */
async function resolveCheckRemoteSections(
  env: Env,
  scope: 'user' | 'project',
  remote: CliDeps['remote'],
  assistant: Assistant,
): Promise<CheckRemoteSections> {
  const empty: CheckRemoteSections = { catalogLines: [], updateLines: [] };
  try {
    const config = await loadCliConfig(env);
    if (config.catalogs.length === 0) return empty;

    const runner: CommandRunner = remote?.run ?? defaultRunner;
    const { readManifest } = await import('@agent-rigger/core/manifest');
    const manifest = await readManifest(resolveManifestPath(env));
    const colorOn = shouldColor();

    const catalogLines: string[] = [];
    const updateLines: string[] = [];

    for (const catalog of config.catalogs) {
      const prefix = catalog.name + '/';
      const installed = manifest.artifacts.filter(
        (e) =>
          e.scope === scope
          && e.ref !== 'v0.0.0'
          && e.id.startsWith(prefix)
          && (e.assistant ?? 'claude') === assistant,
      );

      let remoteVersion: Awaited<ReturnType<typeof resolveVersion>>;
      try {
        remoteVersion = await resolveVersion(catalog.url, runner);
      } catch {
        catalogLines.push(catalogStatusLine('unreachable', catalog.name, '', 0, colorOn));
        continue;
      }

      // `?? ''` defends against a legacy on-disk entry written before sha
      // tracking existed (R2, isUpdateAvailable degrades gracefully).
      const stale = installed.filter((e) => isUpdateAvailable(e.ref, e.sha ?? '', remoteVersion));
      if (installed.length === 0) {
        catalogLines.push(
          catalogStatusLine('available', catalog.name, remoteVersion.ref, 0, colorOn),
        );
      } else if (stale.length === 0) {
        catalogLines.push(
          catalogStatusLine('current', catalog.name, remoteVersion.ref, 0, colorOn),
        );
      } else {
        catalogLines.push(
          catalogStatusLine('update', catalog.name, remoteVersion.ref, stale.length, colorOn),
        );
        for (const e of stale) {
          updateLines.push(`  [update available]  ${e.id}  ${e.ref} → ${remoteVersion.ref}`);
        }
      }
    }

    return { catalogLines, updateLines };
  } catch {
    return empty;
  }
}

/** Print the "--- Catalogs ---" / "--- Updates ---" sections (skips empty ones). */
function printRemoteSections(print: (m: string) => void, sections: CheckRemoteSections): void {
  if (sections.catalogLines.length > 0) {
    print('');
    print('--- Catalogs ---');
    print(sections.catalogLines.join('\n'));
  }
  if (sections.updateLines.length > 0) {
    print('');
    print('--- Updates ---');
    print(sections.updateLines.join('\n'));
  }
}

// ---------------------------------------------------------------------------
// Error handler — maps typed errors to actionable messages + exit codes
// ---------------------------------------------------------------------------

function handleError(err: unknown, print: (msg: string) => void): number {
  if (err instanceof CancelledError) {
    // R2/ADR-0024: the user interrupted a prompt (Ctrl+C) — clack's own
    // cancel() call already printed a message to the terminal, so no
    // re-print here (a second line would contradict "message d'annulation
    // unique"). 130 = 128+SIGINT, distinguishing an interruption from a
    // refusal (exit 0) or a runtime failure (exit 1).
    return 130;
  }

  if (err instanceof LegacyConfigError) {
    print(`[error] ${err.message}`);
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

  if (err instanceof MalformedManifestError) {
    print(`[error] Malformed manifest: ${err.path}`);
    print(`  Reason: ${err.reason}`);
    print('  Expected shape: {"version":1,"artifacts":[...]}');
    print('  Fix the top-level shape by hand, or delete the file to start fresh, then re-run.');
    return 2;
  }

  if (err instanceof ConcurrentRunError) {
    // Another agent-rigger run holds the lock (R7). A transient contention, not
    // a corruption: fast-fail with a stable exit code so the user can retry.
    print(`[error] ${err.message}`);
    return 1;
  }

  if (err instanceof InvalidOpencodeJsonError) {
    print(`[error] ${err.message}`);
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

  if (err instanceof NotInstalledError) {
    print(`[error] ${err.message}`);
    return 2;
  }

  if (err instanceof DependencyCycleError) {
    print(`[error] Dependency cycle: ${err.message}`);
    return 2;
  }

  if (err instanceof ForeignRequireUnsatisfiedError) {
    // R3 (lot 6, D3): a cross-catalogue require is not installed for this
    // scope/assistant. Actionable — names the requirer, the chain, and the
    // exact command to run first. Nothing was resolved/scanned/written.
    print(`[error] ${err.message}`);
    return 2;
  }

  if (err instanceof RefShaMismatchError) {
    // R1 (lot 6, D1): provenance mismatch (branch/tag homonym or TOCTOU) —
    // install/update refused before anything is written. Never bypassed by
    // --force (provenance is not a scan policy).
    print(`[error] ${err.message}`);
    return 2;
  }

  if (err instanceof RemoteFetchError) {
    // R1 (lot 5, ADR-0024): a git fetch/clone against a configured source
    // failed (network/auth/host down) — the request was legitimate, the
    // runtime failed, not the caller's fault. Names the source so a script
    // reading only the exit code still gets an actionable log line. Checked
    // AFTER RefShaMismatchError (a RemoteFetchError subclass with its own,
    // more specific, exit code) so the narrower match wins.
    print(`[error] fetch failed for "${err.url}": ${err.message}`);
    return 1;
  }

  if (err instanceof ScanBlockedError) {
    print(`[error] ${err.message}`);
    return 1;
  }

  if (err instanceof InvalidSecretEnvFlagError) {
    // R5 (lot 6, D5): a malformed --secret-env value is an operator typo —
    // fails fast, before any catalog is resolved or checked out.
    print(`[error] ${err.message}`);
    return 2;
  }

  if (err instanceof MissingRequiredSecretError) {
    // R5 (lot 6, D5): a required mcp secret has no --secret-env override and
    // no prompt is possible (non-TTY) — fail-closed before any write.
    print(`[error] ${err.message}`);
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
    selectArtifactsByStatus: (entries, opts) => ui.selectArtifactsByStatus(entries, opts),
    selectScope: (assistant) => ui.selectScope(assistant),
    confirmApply: (planText) => ui.confirmApply(planText),
    askUrl: async () => {
      const { text } = await import('@clack/prompts');
      const result = await text({
        message: 'Enter the catalog repository URL:',
        placeholder: 'https://github.com/org/repo.git',
      });
      if (ui.isCancel(result)) {
        // R2: interruption, not an empty-URL default — propagate so
        // preflightAuth is never invoked and nothing is persisted.
        ui.cancel('Operation cancelled.');
        throw new CancelledError();
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
        // R2: interruption, not a silent 'https' default — propagate so
        // runInit never persists an authMethod the user never chose.
        cancel('Operation cancelled.');
        throw new CancelledError();
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
