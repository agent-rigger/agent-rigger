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
 *
 * Priority order (highest → lowest):
 *   flags > env > project > user > preset > defaults
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseJsonc } from 'jsonc-parser';

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
  /** URL of the content repository. Fetch is M1; optional in M0. @deprecated — kept for M4 consumer migration; use catalogs[] instead. */
  catalogUrl?: string;
  /** Default installation scope. */
  defaultScope: 'user' | 'project';
  /** Authentication method used by preflight (F1). */
  authMethod?: 'provider-cli' | 'https' | 'ssh';
  /** List of content catalogs (M1). Replaces catalogUrl when fully migrated in M4. */
  catalogs: CatalogEntry[];
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

  const catalogUrl = env['RIGGER_CATALOG_URL'];
  if (catalogUrl !== undefined && catalogUrl !== '') {
    out.catalogUrl = catalogUrl;
  }

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
const KNOWN_KEYS = new Set<keyof Config>(['catalogUrl', 'defaultScope', 'authMethod', 'catalogs']);

/**
 * Read and parse a JSONC config file.
 *
 * - File absent → returns `{}`.
 * - Valid JSONC (comments + trailing commas allowed) → maps to Partial<Config>.
 * - Unknown keys → stripped.
 * - Invalid JSONC → throws InvalidConfigError (carries the file path).
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

  for (const key of KNOWN_KEYS) {
    if (!(key in raw2)) continue;

    const value = raw2[key];
    if (value === undefined) continue;

    if (key === 'catalogs') {
      // Validate: must be an array of objects with non-empty string url.
      if (!Array.isArray(value)) continue;
      const valid: CatalogEntry[] = [];
      for (const entry of value) {
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
      result.catalogs = valid;
      continue;
    }

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
