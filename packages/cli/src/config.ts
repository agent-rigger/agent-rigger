/**
 * Configuration resolution for the agent-rigger CLI.
 *
 * Design invariants:
 * - resolveConfig is a pure function — no I/O, fully deterministic.
 * - I/O is isolated to loadConfigFile, persistConfig, and loadConfig.
 * - Missing config file → empty partial (no error).
 * - Invalid JSONC → throws InvalidConfigError (carries the file path).
 * - Invalid enum values in env vars are silently ignored (do not erase lower-priority values).
 * - Unknown keys in config files are stripped (type-safe mapping only).
 * - R7 legacy detection: if a config file has a top-level "catalogUrl" key but no "catalogs"
 *   entry, loadConfigFile returns { _legacyCatalogUrl: true } instead of mapping the key,
 *   so callers can emit an actionable migration message.
 *
 * Priority order (highest → lowest):
 *   flags > env > project > user > preset > defaults
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseJsonc } from 'jsonc-parser';

import type { Assistant } from '@agent-rigger/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single catalog entry in the multi-catalog list. */
export interface CatalogEntry {
  name: string;
  url: string;
}

/** M0 CLI configuration shape. Keep soberly minimal — YAGNI. */
export interface Config {
  /** Default installation scope. */
  defaultScope: 'user' | 'project';
  /** Authentication method used by preflight (F1). */
  authMethod?: 'provider-cli' | 'https' | 'ssh';
  /** List of content catalogs (M1+M4). Each source is fetched independently, qualified, and folded. */
  catalogs: CatalogEntry[];
  /**
   * Target assistant(s) for install/check/remove/update (M3 — opencode adapter).
   * When it holds exactly one value, assistant-select.ts uses it without prompting.
   */
  assistants?: Assistant[];
}

/**
 * Layers accepted by resolveConfig.
 * Each is a Partial<Config> except `env`, which is the raw env record.
 */
export interface ConfigLayers {
  flags?: Partial<Config>;
  env?: Record<string, string | undefined>;
  project?: Partial<Config>;
  user?: Partial<Config>;
  preset?: Partial<Config>;
}

/** Options for loadConfig. */
export interface LoadConfigOpts {
  projectConfigPath: string;
  userConfigPath: string;
  presetConfigPath?: string;
  flags?: Partial<Config>;
  env?: Record<string, string | undefined>;
}

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

/**
 * Thrown by loadConfigFile when a file exists but contains invalid JSONC.
 *
 * Carries the file path for actionable error messages in the CLI.
 */
export class InvalidConfigError extends Error {
  readonly path: string;

  constructor(filePath: string, cause?: unknown) {
    const message = `Invalid JSONC config in "${filePath}"`
      + (cause instanceof Error ? `: ${cause.message}` : '');
    super(message);
    this.name = 'InvalidConfigError';
    this.path = filePath;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Factory returning the baseline Config. Used as the lowest-priority layer. */
export const DEFAULT_CONFIG: Config = {
  defaultScope: 'user',
  catalogs: [],
};

// ---------------------------------------------------------------------------
// LegacyConfigError — R7 migration signal
// ---------------------------------------------------------------------------

/**
 * Thrown by loadConfigFile (and surfaced by loadConfig) when the config file
 * contains a top-level "catalogUrl" key but no valid "catalogs" array.
 *
 * R7 requirement: the system SHALL emit an actionable message asking the user
 * to re-run `init` rather than silently migrating the legacy key.
 *
 * Carries the file path for precise error messages.
 */
export class LegacyConfigError extends Error {
  readonly path: string;

  constructor(filePath: string) {
    super(
      `Obsolete config in "${filePath}" — run \`rigger init\` to migrate to catalogs[].`,
    );
    this.name = 'LegacyConfigError';
    this.path = filePath;
  }
}

// ---------------------------------------------------------------------------
// Env mapping
// ---------------------------------------------------------------------------

const VALID_SCOPES = new Set<Config['defaultScope']>(['user', 'project']);
const VALID_AUTH_METHODS = new Set<NonNullable<Config['authMethod']>>([
  'provider-cli',
  'https',
  'ssh',
]);

/**
 * Map a raw env record to a Partial<Config>.
 * Empty strings and values that fail enum validation are skipped.
 */
function mapEnv(env: Record<string, string | undefined>): Partial<Config> {
  const out: Partial<Config> = {};

  const rawScope = env['RIGGER_SCOPE'];
  if (rawScope !== undefined && rawScope !== '') {
    if (VALID_SCOPES.has(rawScope as Config['defaultScope'])) {
      out.defaultScope = rawScope as Config['defaultScope'];
    }
  }

  const rawAuth = env['RIGGER_AUTH_METHOD'];
  if (rawAuth !== undefined && rawAuth !== '') {
    if (VALID_AUTH_METHODS.has(rawAuth as NonNullable<Config['authMethod']>)) {
      out.authMethod = rawAuth as NonNullable<Config['authMethod']>;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// resolveConfig — pure, no I/O
// ---------------------------------------------------------------------------

/**
 * Merge config layers by priority (highest → lowest):
 *   flags > env > project > user > preset > defaults
 *
 * Only defined (non-undefined) fields from higher-priority layers overwrite
 * lower-priority ones. A missing key in a higher layer never erases a value
 * set by a lower layer.
 */
export function resolveConfig(layers: ConfigLayers): Config {
  const { flags = {}, env = {}, project = {}, user = {}, preset = {} } = layers;
  const envPartial = mapEnv(env);

  // Build merged result lowest-to-highest priority using defined-key filtering.
  const merged: Config = { ...DEFAULT_CONFIG };

  const ordered: Partial<Config>[] = [preset, user, project, envPartial, flags];
  for (const layer of ordered) {
    for (const key of Object.keys(layer) as (keyof Config)[]) {
      const value = layer[key];
      if (value !== undefined) {
        // Type-safe assignment: value type matches the key's type in Config.
        (merged as Record<keyof Config, Config[keyof Config]>)[key] = value;
      }
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// loadConfigFile — reads JSONC, returns Partial<Config>
// ---------------------------------------------------------------------------

/** Known Config keys for safe mapping (unknown keys are stripped). */
const KNOWN_KEYS = new Set<keyof Config>(['defaultScope', 'authMethod', 'catalogs', 'assistants']);

/** Valid Assistant literals — anything else in config.assistants[] is dropped. */
const VALID_ASSISTANTS = new Set<Assistant>(['claude', 'opencode']);

/**
 * Read and parse a JSONC config file.
 *
 * - File absent → returns `{}`.
 * - Valid JSONC (comments + trailing commas allowed) → maps to Partial<Config>.
 * - Unknown keys → stripped.
 * - Invalid JSONC → throws InvalidConfigError (carries the file path).
 * - R7 legacy: if the raw file has "catalogUrl" but no valid "catalogs[]", throws
 *   LegacyConfigError so the CLI can emit an actionable migration message.
 */
export async function loadConfigFile(filePath: string): Promise<Partial<Config>> {
  const file = Bun.file(filePath);
  const exists = await file.exists();

  if (!exists) {
    return {};
  }

  const raw = await file.text();

  const errors: { error: number; offset: number; length: number }[] = [];
  const parsed: unknown = parseJsonc(raw, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (errors.length > 0) {
    throw new InvalidConfigError(filePath);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const raw2 = parsed as Record<string, unknown>;
  const result: Partial<Config> = {};

  // R7 legacy detection: "catalogUrl" present but no valid "catalogs" array.
  // We detect BEFORE mapping KNOWN_KEYS so the check is always authoritative.
  const hasLegacyCatalogUrl = 'catalogUrl' in raw2
    && typeof raw2['catalogUrl'] === 'string'
    && raw2['catalogUrl'] !== '';

  // Parse catalogs first so the legacy guard can check whether a valid array exists.
  const rawCatalogs = raw2['catalogs'];
  let parsedCatalogs: CatalogEntry[] | undefined;

  if (Array.isArray(rawCatalogs)) {
    const valid: CatalogEntry[] = [];
    for (const entry of rawCatalogs) {
      if (
        entry !== null
        && typeof entry === 'object'
        && !Array.isArray(entry)
        && typeof (entry as Record<string, unknown>)['name'] === 'string'
        && typeof (entry as Record<string, unknown>)['url'] === 'string'
        && ((entry as Record<string, unknown>)['url'] as string) !== ''
      ) {
        valid.push({
          name: (entry as Record<string, unknown>)['name'] as string,
          url: (entry as Record<string, unknown>)['url'] as string,
        });
      }
    }
    parsedCatalogs = valid;
  }

  // R7: legacy key present, no valid catalogs[] → throw actionable error.
  if (hasLegacyCatalogUrl && (parsedCatalogs === undefined || parsedCatalogs.length === 0)) {
    throw new LegacyConfigError(filePath);
  }

  // Parse assistants[]: accept only the 'claude'|'opencode' literals, drop unknowns.
  const rawAssistants = raw2['assistants'];
  let parsedAssistants: Assistant[] | undefined;
  if (Array.isArray(rawAssistants)) {
    parsedAssistants = rawAssistants.filter(
      (a): a is Assistant => VALID_ASSISTANTS.has(a as Assistant),
    );
  }

  for (const key of KNOWN_KEYS) {
    if (key === 'catalogs') {
      if (parsedCatalogs !== undefined) {
        result.catalogs = parsedCatalogs;
      }
      continue;
    }

    if (key === 'assistants') {
      if (parsedAssistants !== undefined) {
        result.assistants = parsedAssistants;
      }
      continue;
    }

    if (!(key in raw2)) continue;

    const value = raw2[key];
    if (value === undefined) continue;

    // Type-safe: cast via the widened record, value is unknown but callers
    // (resolveConfig) treat it as Partial<Config>, validated at runtime by TS.
    (result as Record<string, unknown>)[key] = value;
  }

  return result;
}

// ---------------------------------------------------------------------------
// persistConfig — writes JSONC with a header comment
// ---------------------------------------------------------------------------

const CONFIG_HEADER = '// agent-rigger config — edit this file or run `rigger config set`\n';

/**
 * Write `config` as JSONC to `filePath` with a header comment.
 * Creates parent directories if absent.
 * The written file is readable by loadConfigFile (round-trip safe).
 */
export async function persistConfig(filePath: string, config: Partial<Config>): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });

  const body = JSON.stringify(config, null, 2) + '\n';
  await Bun.write(filePath, CONFIG_HEADER + body);
}

// ---------------------------------------------------------------------------
// loadConfig — orchestrates I/O then delegates to resolveConfig
// ---------------------------------------------------------------------------

/**
 * Load the effective config by reading all config files and merging with
 * flags and env vars.
 *
 * Priority (highest → lowest):
 *   flags > env > project > user > preset > defaults
 */
export async function loadConfig(opts: LoadConfigOpts): Promise<Config> {
  const { projectConfigPath, userConfigPath, presetConfigPath, flags, env } = opts;

  const presetPromise = presetConfigPath === undefined
    ? Promise.resolve({})
    : loadConfigFile(presetConfigPath);

  const [project, user, preset] = await Promise.all([
    loadConfigFile(projectConfigPath),
    loadConfigFile(userConfigPath),
    presetPromise,
  ]);

  const layers: ConfigLayers = { project, user, preset };
  if (flags !== undefined) layers.flags = flags;
  if (env !== undefined) layers.env = env;

  return resolveConfig(layers);
}
