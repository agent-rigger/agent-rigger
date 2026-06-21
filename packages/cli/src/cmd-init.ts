/**
 * cmd-init — first-launch wizard for agent-rigger CLI.
 *
 * Responsibilities:
 * - Ask the user for a catalog URL (via injectable askUrl).
 * - Probe access via preflightAuth (injectable run + askMethod).
 * - Persist the resolved config (catalogUrl + authMethod) to configPath.
 * - Idempotent: reads existing config first, merges new values on top.
 *
 * Design invariants:
 * - No process.exit — exitCode / ok is returned, the bin (F5) decides what to do.
 * - No while loops.
 * - No TTY/real network in this module — all I/O is injected via opts.
 * - PreflightAuthError is caught → ok:false + actionable output; config is NOT persisted.
 * - Config is only persisted after a successful preflightAuth.
 *
 * Error handling:
 * - PreflightAuthError → captured, returned as { ok: false, output: <PreflightAuthError.message> }.
 *   The config is not written to disk in this case, so the user can re-run after fixing auth.
 *
 * Idempotence:
 * - Reads existing config file at configPath before doing anything.
 * - Merges: { ...DEFAULT_CONFIG, ...existing, catalogUrl: <from askUrl>, authMethod: <from preflight> }.
 * - A second runInit starts from the existing state and only updates the provided fields.
 */

import { DEFAULT_CONFIG, loadConfigFile, persistConfig } from './config';
import type { Config } from './config';
import { preflightAuth, PreflightAuthError } from './preflight-auth';
import type { AskMethod, CommandRunner } from './preflight-auth';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result returned by runInit. */
export interface InitResult {
  /** The resolved Config (as it would have been persisted). */
  config: Config;
  /** true when auth succeeded and config was persisted; false on auth failure. */
  ok: boolean;
  /** Human-readable summary or actionable error message. */
  output: string;
}

/** Options for runInit. All I/O is injectable for testability. */
export interface RunInitOpts {
  /** Absolute path to the config file to read/write. */
  configPath: string;
  /** Called to obtain the catalog URL from the user (returns URL string). */
  askUrl: () => Promise<string>;
  /** Called by preflightAuth when ambient probe fails and no method is configured. */
  askMethod: AskMethod;
  /** CommandRunner implementation (defaults to defaultRunner when omitted). */
  run?: CommandRunner;
  /** Extra env vars forwarded to every sub-process. */
  env?: Record<string, string | undefined>;
  /** Default scope when no existing config is present. Defaults to 'user'. */
  defaultScope?: Config['defaultScope'];
}

// ---------------------------------------------------------------------------
// runInit
// ---------------------------------------------------------------------------

/**
 * Run the init wizard:
 *
 * 1. Read existing config (idempotence: a second run starts from the saved state).
 * 2. Ask for the catalog URL via askUrl().
 * 3. Run preflightAuth to verify access; negotiate auth method if needed.
 * 4. On success: merge + persist config → return { ok: true, config, output }.
 * 5. On PreflightAuthError: return { ok: false, config: <partial>, output: <error.message> }.
 *    Config is NOT persisted.
 */
export async function runInit(opts: RunInitOpts): Promise<InitResult> {
  const { configPath, askUrl, askMethod, run, env, defaultScope = 'user' } = opts;

  // Step 1 — read existing config (graceful: missing file → {})
  const existing = await loadConfigFile(configPath);

  // Step 2 — ask for the catalog URL
  const url = await askUrl();

  // Step 3 — probe access
  // Build opts without spreading undefined into exactOptionalPropertyTypes-strict fields.
  const preflightOpts = {
    url,
    askMethod,
    ...(run === undefined ? {} : { run }),
    ...(existing.authMethod === undefined ? {} : { method: existing.authMethod }),
    ...(env === undefined ? {} : { env }),
  };

  let authMethod: Config['authMethod'];
  try {
    const result = await preflightAuth(preflightOpts);
    // result.method is set when a specific method was negotiated; undefined = ambient OK
    authMethod = result.method ?? existing.authMethod;
  } catch (err) {
    if (err instanceof PreflightAuthError) {
      // Auth failure: do NOT persist; return actionable output
      const partialConfig: Config = {
        ...DEFAULT_CONFIG,
        ...existing,
        defaultScope: defaultScope ?? existing.defaultScope ?? DEFAULT_CONFIG.defaultScope,
        catalogUrl: url,
      };
      return {
        config: partialConfig,
        ok: false,
        output: err.message,
      };
    }
    throw err;
  }

  // Step 4 — merge + persist
  // Priority: opts.defaultScope > existing.defaultScope > DEFAULT_CONFIG.defaultScope
  // (explicit init opts override the saved value so a re-init can change the scope)
  const resolvedScope = defaultScope ?? existing.defaultScope ?? DEFAULT_CONFIG.defaultScope;
  const config: Config = {
    ...DEFAULT_CONFIG,
    ...existing,
    defaultScope: resolvedScope,
    catalogUrl: url,
    ...(authMethod === undefined ? {} : { authMethod }),
  };

  await persistConfig(configPath, config);

  // Step 5 — compose output
  const methodLine = authMethod === undefined
    ? ''
    : `\nAuth method : ${authMethod}`;
  const output = `Catalog URL  : ${url}${methodLine}\nConfig saved : ${configPath}`;

  return { config, ok: true, output };
}
