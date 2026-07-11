/**
 * cmd-init — first-launch wizard for agent-rigger CLI.
 *
 * Responsibilities:
 * - Ask the user for a catalog URL (via injectable askUrl).
 * - Probe access via preflightAuth (injectable run + askMethod).
 * - Persist the resolved config (catalogs[] + authMethod) to configPath.
 * - Idempotent: reads existing config first, merges new values on top.
 * - After successful persist + in interactive mode: fetch catalog, propose install.
 *
 * Design invariants:
 * - No process.exit — exitCode / ok is returned, the bin (F5) decides what to do.
 * - No while loops.
 * - No TTY/real network in this module — all I/O is injected via opts.
 * - PreflightAuthError is caught → ok:false + actionable output; config is NOT persisted.
 * - Config is only persisted after a successful preflightAuth.
 * - fetchCatalogFn / proposeInstall failures are caught non-fatally: config stays saved,
 *   output gets an actionable hint to re-run `install` later. A CancelledError (R2, user
 *   Ctrl+C in the post-init picker) is re-thrown, not swallowed — it maps to exit 130.
 *
 * Error handling:
 * - PreflightAuthError → captured, returned as { ok: false, output: <PreflightAuthError.message> }.
 *   The config is not written to disk in this case, so the user can re-run after fixing auth.
 *
 * Idempotence:
 * - Reads existing config file at configPath before doing anything (LegacyConfigError is caught
 *   and treated as an empty config — the user will be prompted for a URL which rewrites correctly).
 * - Merges: { ...DEFAULT_CONFIG, ...existing, catalogs: [{name:'principal', url}], authMethod }.
 * - A second runInit starts from the existing state and only updates the provided fields.
 *
 * Target assistant(s) (E7, R1):
 * - askAssistants (TTY / injected) is called and validated; invalid/reserved values
 *   (e.g. 'copilot') are dropped.
 * - When askAssistants is absent (non-TTY / no injection): falls back to on-disk
 *   detection (detectAssistants(env)) — no prompt, the one filesystem probe this
 *   otherwise I/O-free module performs (no network, no TTY read).
 * - Neither source resolves anything → the existing persisted value is preserved
 *   (idempotence), or config.assistants stays absent for a brand-new config.
 */

import type { CatalogEntry, CatalogMeta } from '@agent-rigger/catalog';
import type { Assistant } from '@agent-rigger/core';

import { detectAssistants } from './assistant-select';
import { DEFAULT_CONFIG, LegacyConfigError, loadConfigFile, persistConfig } from './config';
import type { Config } from './config';
import { preflightAuth, PreflightAuthError } from './preflight-auth';
import type { AskMethod, CommandRunner } from './preflight-auth';
import { CancelledError } from './ui';

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

/** Payload passed to proposeInstall. */
export interface CatalogProposal {
  meta: CatalogMeta;
  entries: CatalogEntry[];
  /**
   * Name of the catalog source (e.g. 'principal').
   * Used by the caller to qualify meta.required/recommended ids so that
   * they match the qualified entries (ADR-0017), via the single qualification
   * seam (`qualifyRef`, lot 6 R4/D4).
   *
   * REQUIRED (lot 6 R4/D4): both real `fetchCatalogFn` implementations
   * (init, catalog add) always set it, so the divergent fallbacks that used
   * to cover its absence (`?? ''`, `?? 'principal'`, `?? ids[0] ?? ''`) are
   * dead code and have been removed — callers now use `catalog.sourceName`
   * directly.
   */
  sourceName: string;
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
  /**
   * Injected catalog fetcher (TTY / interactive mode).
   * Called after successful config persist with the saved catalogUrl.
   * When absent (non-TTY), the proposal step is skipped entirely.
   * Failures are caught non-fatally — config stays saved.
   */
  fetchCatalogFn?: (url: string) => Promise<CatalogProposal>;
  /**
   * Injected picker + install orchestration (TTY / interactive mode).
   * Receives the fetched catalog; returns the list of ids the user selected.
   * An empty array means the user cancelled or selected nothing.
   * Only called when fetchCatalogFn is also present.
   * Failures are caught non-fatally — config stays saved.
   */
  proposeInstall?: (catalog: CatalogProposal) => Promise<string[]>;
  /**
   * Injected picker for target assistant(s) (TTY / interactive mode, R1).
   * Invalid/unknown values (e.g. 'copilot') are dropped from the result.
   * When absent (non-TTY / no injection), runInit falls back to on-disk
   * detection (detectAssistants(env)) — no prompt, no network.
   */
  askAssistants?: () => Promise<Assistant[]>;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit testing without TTY
// ---------------------------------------------------------------------------

/**
 * Compute the initial multiselect state for the post-init picker.
 *
 * Returns:
 * - `initial`    : ids that should be pre-checked (required ∪ recommended).
 * - `requiredSet`: ids that must always be included in the final result (cannot be unchecked).
 *
 * Entries that appear in neither set start unchecked.
 */
export function buildInitialSelection(
  entries: CatalogEntry[],
  opts: { required: Set<string>; recommended: Set<string> },
): { initial: string[]; requiredSet: Set<string> } {
  const { required, recommended } = opts;
  const initial: string[] = [];

  for (const entry of entries) {
    if (required.has(entry.id) || recommended.has(entry.id)) {
      initial.push(entry.id);
    }
  }

  return { initial, requiredSet: new Set(required) };
}

/**
 * Enforce that all required ids are present in a picker result.
 *
 * Re-adds any required ids that the user may have unchecked (or that the picker
 * dropped). Deduplicates: if a required id is already in `selected`, it appears
 * exactly once in the output.
 *
 * Pure function — does not mutate inputs.
 */
export function enforceRequired(selected: string[], required: Set<string>): string[] {
  const seen = new Set(selected);
  const result = [...selected];

  for (const id of required) {
    if (!seen.has(id)) {
      result.push(id);
    }
  }

  return result;
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
 * 6. After successful persist + when both fetchCatalogFn and proposeInstall are set:
 *    fetch catalog → proposeInstall → run install on selected ids.
 *    Failures here are caught non-fatally: config stays saved, output gets actionable hint.
 */
export async function runInit(opts: RunInitOpts): Promise<InitResult> {
  const {
    configPath,
    askUrl,
    askMethod,
    run,
    env,
    defaultScope = 'user',
    fetchCatalogFn,
    proposeInstall,
    askAssistants,
  } = opts;

  // Step 1 — read existing config (graceful: missing file → {}; LegacyConfigError → {} so init
  // can overwrite the legacy key with a correct catalogs[] value without blocking the wizard).
  let existing: Awaited<ReturnType<typeof loadConfigFile>>;
  try {
    existing = await loadConfigFile(configPath);
  } catch (err) {
    if (err instanceof LegacyConfigError) {
      existing = {};
    } else {
      throw err;
    }
  }

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
        catalogs: [{ name: 'principal', url }],
      };
      return {
        config: partialConfig,
        ok: false,
        output: err.message,
      };
    }
    throw err;
  }

  // Step 3b — resolve target assistant(s) (E7, R1): injected prompt (TTY) or
  // on-disk detection (non-TTY). Neither resolving anything preserves the
  // existing persisted value (idempotence).
  let resolvedAssistants: Assistant[] | undefined = existing.assistants;
  if (askAssistants === undefined) {
    const detected = await detectAssistants(env ?? {});
    if (detected.length > 0) resolvedAssistants = detected;
  } else {
    const asked = await askAssistants();
    const valid = asked.filter((a): a is Assistant => a === 'claude' || a === 'opencode');
    if (valid.length > 0) resolvedAssistants = valid;
  }

  // Step 4 — merge + persist
  // Priority: opts.defaultScope > existing.defaultScope > DEFAULT_CONFIG.defaultScope
  // (explicit init opts override the saved value so a re-init can change the scope)
  const resolvedScope = defaultScope ?? existing.defaultScope ?? DEFAULT_CONFIG.defaultScope;
  const config: Config = {
    ...DEFAULT_CONFIG,
    ...existing,
    defaultScope: resolvedScope,
    catalogs: [{ name: 'principal', url }],
    ...(authMethod === undefined ? {} : { authMethod }),
    ...(resolvedAssistants === undefined ? {} : { assistants: resolvedAssistants }),
  };

  await persistConfig(configPath, config);

  // Step 5 — compose base output
  const methodLine = authMethod === undefined
    ? ''
    : `\nAuth method  : ${authMethod}`;
  const assistantsLine = resolvedAssistants === undefined || resolvedAssistants.length === 0
    ? ''
    : `\nAssistant(s) : ${resolvedAssistants.join(', ')}`;
  let output =
    `Catalog      : ${url} (principal)${methodLine}${assistantsLine}\nConfig saved : ${configPath}`;

  // Step 6 — post-init catalog proposal (interactive / TTY mode only)
  // Both fetchCatalogFn and proposeInstall must be provided; otherwise skip silently.
  if (fetchCatalogFn !== undefined && proposeInstall !== undefined) {
    try {
      const catalog = await fetchCatalogFn(url);
      await proposeInstall(catalog);
    } catch (err) {
      // R2/ADR-0024: a user cancel (Ctrl+C in the post-init picker) must
      // propagate to exit 130, not be swallowed as a non-fatal fetch failure.
      if (err instanceof CancelledError) {
        throw err;
      }
      // Non-fatal: config is already saved. Give the user an actionable hint.
      output +=
        '\n\nCatalog fetch failed. Run `install` later to install artifacts from the catalog.';
    }
  }

  return { config, ok: true, output };
}
