/**
 * cmd-config — implementation of the `config set <key> <value>` command (B6,
 * change fix-bugs-cli-b5-b10). The header persistConfig writes already mentions
 * `rigger config set`; this verb makes that mention true.
 *
 * Scope: `set` only — no get/list/unset (YAGNI, brief §B6). Settable keys:
 *   - defaultScope  enum: user | project
 *   - authMethod    enum: provider-cli | https | ssh
 *   - assistants    CSV, each value validated against VALID_ASSISTANTS
 * `catalogs` is a structured {name,url} list managed by `catalog add/remove`; a
 * `config set catalogs` redirects there rather than inventing an ad-hoc syntax.
 *
 * Design invariants (mirror cmd-catalog.ts):
 * - No process.exit — the exit code is returned, the caller decides.
 * - No while loops.
 * - I/O injected via opts (print, configPath) for test isolation. The caller
 *   resolves configPath from --scope (user default / project) — the scope→path
 *   helpers live in cli.ts, so passing configPath keeps this module free of a
 *   cli.ts import cycle (same shape as runCatalog).
 * - Read-modify-write via loadConfigFile / persistConfig (round-trip safe, atomic
 *   tmp+rename, writes CONFIG_HEADER).
 * - Hard validation BEFORE write — the deliberate contrast with loadConfigFile,
 *   which strips unknown keys silently: a `set` is an explicit user act, so an
 *   unknown key or out-of-enum value is an actionable usage error (exit 2), never
 *   a silent no-op.
 */

import type { Assistant } from '@agent-rigger/core';

import { CLI_COMMAND } from './cli';
import type { Config } from './config';
import {
  loadConfigFile,
  persistConfig,
  VALID_ASSISTANTS,
  VALID_AUTH_METHODS,
  VALID_SCOPES,
} from './config';

// ---------------------------------------------------------------------------
// Settable keys
// ---------------------------------------------------------------------------

// The runtime-valid value sets (VALID_SCOPES/VALID_AUTH_METHODS/VALID_ASSISTANTS)
// are imported from config.ts — a single source of truth with what loadConfigFile
// accepts, so an enum change is type-checked on both the read and the `set` side
// (D2's "hard validation = exactly what the config accepts").
const SETTABLE_KEYS = ['defaultScope', 'authMethod', 'assistants'] as const;
type SettableKey = typeof SETTABLE_KEYS[number];

// ---------------------------------------------------------------------------
// HandleConfigOpts
// ---------------------------------------------------------------------------

export interface HandleConfigOpts {
  /** Sub-verb — only 'set' is supported; anything else is a usage error. */
  verb: string | undefined;
  /** Positional args after the verb: [key, value]. */
  args: string[];
  /** Absolute path to the target config.json (resolved from --scope by the caller). */
  configPath: string;
  /** Output sink. */
  print: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// handleConfig
// ---------------------------------------------------------------------------

/**
 * Execute `config set` and return an exit code.
 *
 * Exit codes:
 *   0  value written
 *   2  usage error (unknown verb/key, out-of-enum value, missing argument,
 *      or `catalogs` — the CLI usage-error convention)
 */
export async function handleConfig(opts: HandleConfigOpts): Promise<number> {
  const { verb, args, configPath, print } = opts;

  if (verb !== 'set') {
    print(`[error] Unknown verb "${verb ?? ''}" for "config". Available: set.`);
    return 2;
  }

  const key = args[0];
  if (key === undefined || key === '') {
    print(
      `[error] "config set" requires <key> and <value>. Settable keys: ${
        SETTABLE_KEYS.join(', ')
      }.`,
    );
    return 2;
  }

  if (key === 'catalogs') {
    print(
      `[error] "catalogs" is managed by \`${CLI_COMMAND} catalog add <name> <url>\` and `
        + `\`${CLI_COMMAND} catalog remove <name>\`, not \`config set\`.`,
    );
    return 2;
  }

  if (!SETTABLE_KEYS.includes(key as SettableKey)) {
    print(`[error] Unknown config key "${key}". Settable keys: ${SETTABLE_KEYS.join(', ')}.`);
    return 2;
  }

  const value = args[1];
  if (value === undefined || value === '') {
    print(`[error] "config set ${key}" requires a <value>.`);
    return 2;
  }

  // Validate + build a typed patch. Every branch prints its own actionable
  // error naming the admitted values before returning 2 (no silent drop).
  let patch: Partial<Config>;
  switch (key as SettableKey) {
    case 'defaultScope': {
      if (!VALID_SCOPES.has(value as Config['defaultScope'])) {
        print(
          `[error] Invalid value "${value}" for "defaultScope". Allowed: ${
            [...VALID_SCOPES].join(', ')
          }.`,
        );
        return 2;
      }
      patch = { defaultScope: value as Config['defaultScope'] };
      break;
    }
    case 'authMethod': {
      if (!VALID_AUTH_METHODS.has(value as NonNullable<Config['authMethod']>)) {
        print(
          `[error] Invalid value "${value}" for "authMethod". Allowed: ${
            [...VALID_AUTH_METHODS].join(', ')
          }.`,
        );
        return 2;
      }
      patch = { authMethod: value as NonNullable<Config['authMethod']> };
      break;
    }
    case 'assistants': {
      const parts = value.split(',').map((v) => v.trim()).filter((v) => v !== '');
      const invalid = parts.filter((v) => !VALID_ASSISTANTS.has(v as Assistant));
      if (parts.length === 0 || invalid.length > 0) {
        print(
          `[error] Invalid value "${value}" for "assistants". Allowed (comma-separated): ${
            [...VALID_ASSISTANTS].join(', ')
          }.`,
        );
        return 2;
      }
      patch = { assistants: parts as Assistant[] };
      break;
    }
  }

  const config = await loadConfigFile(configPath);
  await persistConfig(configPath, { ...config, ...patch });

  print(`config: ${key} set to "${value}" in ${configPath}`);
  return 0;
}
