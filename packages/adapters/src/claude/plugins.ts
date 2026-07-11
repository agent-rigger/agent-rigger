/**
 * Plugins handler for the Claude adapter — delegate-first WRITES, on-disk READS
 * (obs1-plugin-reads, closes OBS-1).
 *
 * A plugin is never copied or linked: it is installed via the native Claude
 * CLI mechanism (`claude plugin marketplace add` + `claude plugin install`).
 * The handler pilots the native commands at APPLY time and re-raises their
 * errors verbatim — nothing is swallowed.
 *
 * READS, by contrast, never spawn the `claude` binary (R1). They inspect
 * Claude's own on-disk plugin ledger directly — the robust, side-effect-free
 * way to answer "is my plugin installed?" without violating the engine's
 * "plan/audit is read-only" invariant (Previously: every audit spawned
 * `claude plugin list`, a third-party binary that bootstraps `.claude.json` on
 * a virgin config, crashes ENOENT when absent, and whose token-match could
 * never match a `plugin:<name>` id against a `<name>@<marketplace>` line —
 * a latent false `missing`, ADR-0022 OBS-1).
 *
 *   resolvePluginPaths   — resolve <config>/plugins/installed_plugins.json +
 *                          <config>/settings.json under CLAUDE_CONFIG_DIR (or
 *                          <home>/.claude). Exported: the `doctor` change reuses
 *                          it as its plugin-probe primitive. NOT the mcp resolver
 *                          — plugins do NOT live in ~/.claude.json (T0).
 *   readInstalledPlugins — read the ledger (version: 2, keys `<name>@<marketplace>`).
 *                          Absent file / plugins:{} → ok with no keys (→ missing);
 *                          invalid JSON / version !== 2 / plugins non-object →
 *                          'unknown' (no coercion — a parse failure must never
 *                          masquerade as `missing` and churn a reinstall).
 *   auditPlugin  — read-only, derives state from the ledger key `<name>@<marketplace>`.
 *   planPlugin   — read-only, returns WriteOp[] (zero or one plugin-install op);
 *                  [] on `unknown` (no churn) and on `present` (idempotent).
 *   applyPlugin  — runs the native CLI commands; throws PluginInstallError on failure.
 *
 * Runner injection:
 *   applyPlugin / applyRemovePlugin accept an optional { run: PluginRunner } so
 *   tests never invoke the real `claude` binary. The spawn lives ONLY on these
 *   post-confirm apply paths — no read path (audit/plan/planRemove/adopt) takes
 *   or uses a runner.
 *
 *   defaultPluginRunner: uses Bun.spawn, pipes stdout/stderr, returns exit code.
 *
 * Plugin source resolution:
 *   planPlugin and the adapter wiring accept a pluginSource resolver:
 *     (entry) => { plugin: string; marketplace: string; marketplaceName: string }
 *   `marketplaceName` is the registered marketplace name that forms the ledger
 *   key `<plugin>@<marketplaceName>` (the `name` field of marketplace.json, R3),
 *   distinct from `marketplace` (the source path/URL passed to `marketplace add`).
 *
 * Invariants:
 * - auditPlugin, planPlugin, planRemovePlugin, adoptPlugin are read-only and
 *   NEVER spawn (no fs writes, no `claude` invocation — R1).
 * - No while loops; no process.exit().
 * - PluginInstallError carries the command string and the native stderr verbatim.
 */

import path from 'node:path';

import type { AdapterEntry, AdoptionResult } from '@agent-rigger/core/adapter';
import type { Env } from '@agent-rigger/core/paths';
import { resolveHome } from '@agent-rigger/core/paths';
import type {
  NatureReport,
  RemovalOp,
  WriteOp,
  WriteOpPluginInstall,
} from '@agent-rigger/core/types';

// ---------------------------------------------------------------------------
// PluginRunner
// ---------------------------------------------------------------------------

/**
 * Injectable command runner for plugin operations.
 *
 * Accepts the same env forwarding pattern as Bun.spawn so a GITLAB_TOKEN can
 * be injected for private marketplace registries.
 *
 * Default implementation (defaultPluginRunner) uses Bun.spawn and reads
 * stdout/stderr via Response.
 */
export type PluginRunner = (
  command: string,
  args: string[],
  opts?: { env?: Record<string, string | undefined> },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/**
 * Default PluginRunner backed by Bun.spawn.
 *
 * Spawns the command with piped stdout/stderr, waits for exit, and returns
 * the full output. The process env is merged with any caller-provided overrides
 * so GITLAB_TOKEN and similar variables propagate to the child process.
 */
export const defaultPluginRunner: PluginRunner = async (
  command: string,
  args: string[],
  opts?: { env?: Record<string, string | undefined> },
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const mergedEnv = opts?.env === undefined
    ? process.env
    : { ...process.env, ...opts.env };

  const proc = Bun.spawn([command, ...args], {
    env: mergedEnv as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
};

// ---------------------------------------------------------------------------
// PluginInstallError
// ---------------------------------------------------------------------------

/**
 * Thrown by applyPlugin when a `claude plugin …` command exits with a non-zero
 * code. Carries the command string and the native stderr verbatim so callers
 * can present the original error without any transformation.
 */
export class PluginInstallError extends Error {
  /** The full command string that failed (e.g. "claude plugin marketplace add …"). */
  readonly command: string;
  /** Native stderr output from the `claude` process. */
  readonly stderr: string;

  constructor(command: string, stderr: string) {
    super(`Plugin install failed: ${command}\n${stderr}`);
    this.name = 'PluginInstallError';
    this.command = command;
    this.stderr = stderr;
  }
}

// ---------------------------------------------------------------------------
// PluginUninstallError
// ---------------------------------------------------------------------------

/**
 * Thrown by applyRemovePlugin when `claude plugin uninstall` exits with a
 * non-zero code. Carries the command string and native stderr verbatim.
 */
export class PluginUninstallError extends Error {
  /** The full command string that failed (e.g. "claude plugin uninstall <name>"). */
  readonly command: string;
  /** Native stderr output from the `claude` process. */
  readonly stderr: string;

  constructor(command: string, stderr: string) {
    super(`Plugin uninstall failed: ${command}\n${stderr}`);
    this.name = 'PluginUninstallError';
    this.command = command;
    this.stderr = stderr;
  }
}

// ---------------------------------------------------------------------------
// pluginName
// ---------------------------------------------------------------------------

/**
 * Derive the plugin name from the entry id.
 * 'plugin:my-plugin' → 'my-plugin'
 * 'my-plugin'        → 'my-plugin'
 * 'plugin:a:b'       → 'a:b'
 */
export function pluginName(entry: AdapterEntry): string {
  const prefix = 'plugin:';
  // Strip source qualifier if present (ADR-0017: ids may be 'principal/plugin:foo')
  const localPart = entry.id.includes('/') ? entry.id.slice(entry.id.indexOf('/') + 1) : entry.id;
  if (localPart.startsWith(prefix)) {
    return localPart.slice(prefix.length);
  }
  return localPart;
}

// ---------------------------------------------------------------------------
// PluginSource
// ---------------------------------------------------------------------------

/**
 * Resolved plugin coordinates for one AdapterEntry.
 * Returned by the pluginSource resolver passed to planPlugin / adapter wiring.
 */
export interface PluginSource {
  /** Plugin identifier as expected by `claude plugin install`. */
  plugin: string;
  /** Path or URL of the marketplace manifest to register (`marketplace add` arg). */
  marketplace: string;
  /**
   * Registered marketplace name — the `<marketplace>` half of the on-disk
   * ledger key `<plugin>@<marketplace>` (R3). This is the marketplace.json
   * `name` field, distinct from `marketplace` (the source path/URL). The audit
   * matches this exact key; a wrong name yields a false `missing` (safe: it only
   * proposes a redundant, idempotent install — never a destructive op).
   */
  marketplaceName: string;
}

// ---------------------------------------------------------------------------
// On-disk plugin ledger probe (R1, R2, R3) — never spawns
// ---------------------------------------------------------------------------

/**
 * Resolved on-disk locations for Claude Code's plugin state under the config dir.
 * Exported so the `doctor` change can reuse it as its plugin-probe primitive.
 */
export interface PluginPaths {
  /** The Claude config dir (CLAUDE_CONFIG_DIR, or <home>/.claude). */
  configDir: string;
  /** <config>/plugins/installed_plugins.json — the ledger (version 2). */
  installedPluginsPath: string;
  /** <config>/settings.json — carries the enabledPlugins bit (ignored by audit). */
  settingsPath: string;
}

/**
 * Resolve the Claude config dir and the plugin state files under it.
 *
 * The config dir is `CLAUDE_CONFIG_DIR` when set (non-empty), else `<home>/.claude`
 * (resolveHome honours RIGGER_HOME → HOME → os.homedir for test isolation). This
 * is NOT the mcp resolver: Claude stores plugins under the config dir, NOT in
 * `~/.claude.json` (T0, Claude Code 2.1.207) — reusing resolveClaudeMcpConfigPath
 * would probe the wrong file entirely.
 */
export function resolvePluginPaths(env: Env): PluginPaths {
  const override = env['CLAUDE_CONFIG_DIR'];
  const configDir = override !== undefined && override !== ''
    ? override
    : path.join(resolveHome(env), '.claude');
  return {
    configDir,
    installedPluginsPath: path.join(configDir, 'plugins', 'installed_plugins.json'),
    settingsPath: path.join(configDir, 'settings.json'),
  };
}

/**
 * Outcome of reading the on-disk plugin ledger.
 *
 * - `{ state: 'ok', keys }` — the ledger parsed as a version-2 object; `keys` is
 *   the set of `<name>@<marketplace>` install keys (empty when the file is
 *   absent or `plugins: {}` — both mean "no plugin installed" → per-key missing).
 * - `{ state: 'unknown' }` — the file exists but does NOT parse as JSON, or
 *   carries `version !== 2`, or `plugins` is not a plain object. NO coercion: a
 *   parse failure stays `unknown` so audit reports advisory rather than a
 *   `missing` that would churn a reinstall on every Claude Code layout change.
 */
export type ReadInstalledPluginsResult =
  | { state: 'ok'; keys: ReadonlySet<string> }
  | { state: 'unknown' };

/**
 * Read Claude Code's plugin ledger (`installed_plugins.json`) from disk.
 *
 * Strictly read-only and spawn-free (R1): uses Bun.file (existence check + text
 * read) which never creates the file — the probe is safe on a virgin config dir.
 *
 * @param env  Injectable env (CLAUDE_CONFIG_DIR / RIGGER_HOME / HOME).
 */
export async function readInstalledPlugins(env: Env): Promise<ReadInstalledPluginsResult> {
  const { installedPluginsPath } = resolvePluginPaths(env);
  const file = Bun.file(installedPluginsPath);

  // Absent file → no plugin installed (→ per-key missing). Never bootstrap it.
  if (!(await file.exists())) {
    return { state: 'ok', keys: new Set() };
  }

  const raw = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'unknown' };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { state: 'unknown' };
  }
  const ledger = parsed as Record<string, unknown>;

  // Version gate: anything other than the known v2 layout is advisory, not missing.
  if (ledger['version'] !== 2) {
    return { state: 'unknown' };
  }

  const plugins = ledger['plugins'];
  if (plugins === null || typeof plugins !== 'object' || Array.isArray(plugins)) {
    return { state: 'unknown' };
  }

  return { state: 'ok', keys: new Set(Object.keys(plugins as Record<string, unknown>)) };
}

/** Build the on-disk ledger key for a plugin: `<name>@<marketplace>` (R3). */
export function pluginLedgerKey(name: string, marketplaceName: string): string {
  return `${name}@${marketplaceName}`;
}

// ---------------------------------------------------------------------------
// auditPlugin
// ---------------------------------------------------------------------------

/**
 * Audit the current state of a plugin from Claude's on-disk ledger (R1, R2, R3).
 *
 * NEVER spawns `claude` (R1). Derives state from `installed_plugins.json`:
 * - 'present' if the exact key `<name>@<marketplaceName>` exists in the ledger
 *   (installed by rigger OR by hand — provenance is adopt's concern, parity mcp;
 *   an enabledPlugins=false entry still counts present — the ledger is the truth
 *   of the install, decision gate).
 * - 'missing' if the file/key is absent (a plan of install is proposable).
 * - 'unknown' if the ledger exists but does not parse / carries version !== 2 /
 *   `plugins` is non-object — advisory only, never triggers a reinstall.
 *
 * Read-only: no filesystem writes, no process spawn.
 *
 * @param entry            Artifact entry (id carries the plugin name).
 * @param env              Injectable env (CLAUDE_CONFIG_DIR / RIGGER_HOME / HOME).
 * @param marketplaceName  Registered marketplace name (ledger key second half, R3).
 */
export async function auditPlugin(
  entry: AdapterEntry,
  env: Env,
  marketplaceName: string,
): Promise<NatureReport> {
  const result = await readInstalledPlugins(env);
  if (result.state === 'unknown') {
    return {
      id: entry.id,
      nature: 'plugin',
      state: 'unknown',
      detail: 'installed_plugins.json is present but unreadable (invalid JSON or '
        + 'unrecognised version) — advisory, no reinstall planned',
    };
  }

  const key = pluginLedgerKey(pluginName(entry), marketplaceName);
  return {
    id: entry.id,
    nature: 'plugin',
    state: result.keys.has(key) ? 'present' : 'missing',
  };
}

// ---------------------------------------------------------------------------
// planPlugin
// ---------------------------------------------------------------------------

/**
 * Compute the write operations needed to install a plugin (R1, R2).
 *
 * Reads the on-disk ledger (never spawns), then:
 * - Returns [] when the plugin is already present (idempotent).
 * - Returns [] when the ledger is 'unknown' — NO reinstall churn on an
 *   unparsable/foreign-version ledger (R2 decision); the advisory is surfaced by
 *   the audit report's `state: 'unknown'` (rendered by check).
 * - Returns [{ kind: 'plugin-install', plugin, marketplace }] when missing.
 *
 * Read-only: no filesystem writes, no process spawn.
 *
 * @param entry         Artifact entry.
 * @param env           Injectable env (CLAUDE_CONFIG_DIR / RIGGER_HOME / HOME).
 * @param pluginSource  Resolver: entry → { plugin, marketplace, marketplaceName }.
 */
export async function planPlugin(
  entry: AdapterEntry,
  env: Env,
  pluginSource: (entry: AdapterEntry) => PluginSource,
): Promise<WriteOp[]> {
  const { plugin, marketplace, marketplaceName } = pluginSource(entry);
  const report = await auditPlugin(entry, env, marketplaceName);
  // present → idempotent no-op; unknown → advisory, no churn (R2).
  if (report.state !== 'missing') {
    return [];
  }

  const op: WriteOpPluginInstall = { kind: 'plugin-install', plugin, marketplace };
  return [op];
}

// ---------------------------------------------------------------------------
// planRemovePlugin
// ---------------------------------------------------------------------------

/**
 * Compute the removal operations needed to uninstall a plugin (R1).
 *
 * Reads the on-disk ledger (never spawns), then:
 * - Returns [] when the plugin is confirmed absent ('missing' — idempotent).
 * - Returns a single leave-alone op when the ledger is 'unknown'. This must
 *   NOT be an empty array: engine.removeInner's phantom-purge convergence
 *   (M1a) reads `plannedOps.length === 0` as "confirmed absent from disk" and
 *   drops the manifest entry outright — exactly the reinstall/purge churn on
 *   a healthy install that R2 forbids ("un missing sur parse raté
 *   déclencherait... churn non idempotent sur un état sain"), just reached
 *   from the remove side instead of install. An unreadable ledger confirms
 *   NOTHING about the plugin's presence, so the manifest entry is preserved
 *   (R3 Lot 2 conservation, same contract as an unmanaged/foreign present
 *   target) for a later run to re-evaluate once the ledger is readable again.
 *   The leave-alone op carries a warning surfaced by the removal preview
 *   (same plan-warning channel as every other leave-alone op).
 * - Returns [{ kind: 'plugin-uninstall', plugin }] when the plugin is present.
 *
 * Read-only: no filesystem writes, no process spawn.
 *
 * @param entry            Artifact entry.
 * @param env              Injectable env (CLAUDE_CONFIG_DIR / RIGGER_HOME / HOME).
 * @param marketplaceName  Registered marketplace name (ledger key second half, R3).
 */
export async function planRemovePlugin(
  entry: AdapterEntry,
  env: Env,
  marketplaceName: string,
): Promise<RemovalOp[]> {
  const report = await auditPlugin(entry, env, marketplaceName);

  if (report.state === 'unknown') {
    return [{
      kind: 'leave-alone',
      target: pluginName(entry),
      warnings: [
        `"${entry.id}": installed_plugins.json is present but unreadable (invalid JSON or `
        + 'unrecognised version) — cannot confirm the plugin is absent, so the manifest '
        + 'entry is left in place (advisory, no removal performed)',
      ],
    }];
  }

  if (report.state !== 'present') {
    return [];
  }

  const name = pluginName(entry);
  return [{ kind: 'plugin-uninstall', plugin: name }];
}

// ---------------------------------------------------------------------------
// adoptPlugin
// ---------------------------------------------------------------------------

/**
 * Adopt gate for the plugin nature (R5/D5, R1).
 *
 * Adopts ONLY when the on-disk ledger reports the plugin present — the same
 * condition under which planPlugin returns [] (empty plan). A plugin is a
 * delegated nature (installed/removed through the native CLI, never copied), so
 * there is NO offline payload to reverse: the AdoptionResult carries an empty
 * `files` and no `applied`. Recording the entry is still what lets remove reach
 * the `claude plugin uninstall` path and check verify presence.
 *
 * Read-only: no filesystem writes, no process spawn (R1).
 *
 * @param entry            Artifact entry (id carries the plugin name).
 * @param env              Injectable env (CLAUDE_CONFIG_DIR / RIGGER_HOME / HOME).
 * @param marketplaceName  Registered marketplace name (ledger key second half, R3).
 */
export async function adoptPlugin(
  entry: AdapterEntry,
  env: Env,
  marketplaceName: string,
): Promise<AdoptionResult | undefined> {
  const report = await auditPlugin(entry, env, marketplaceName);
  if (report.state !== 'present') {
    return undefined;
  }
  return { files: [] };
}

// ---------------------------------------------------------------------------
// applyRemovePlugin
// ---------------------------------------------------------------------------

/**
 * Execute plugin-uninstall removal operations produced by planRemovePlugin.
 *
 * For each plugin-uninstall op:
 *   Run `claude plugin uninstall <plugin>`.
 *   If exit code ≠ 0 → throw PluginUninstallError with the native stderr.
 *
 * Ops of any other kind are silently skipped (forward-compatibility).
 *
 * @param ops   Removal operations (only 'plugin-uninstall' kind are processed).
 * @param env   Injectable env (kept for interface symmetry).
 * @param opts  Optional { run: PluginRunner }.
 */
export async function applyRemovePlugin(
  ops: RemovalOp[],
  _env: Env,
  opts?: { run?: PluginRunner },
): Promise<void> {
  const run = opts?.run ?? defaultPluginRunner;

  for (const op of ops) {
    if (op.kind !== 'plugin-uninstall') {
      continue;
    }

    const cmd = `claude plugin uninstall ${op.plugin}`;
    const result = await run('claude', ['plugin', 'uninstall', op.plugin]);

    if (result.exitCode !== 0) {
      throw new PluginUninstallError(cmd, result.stderr);
    }
  }
}

// ---------------------------------------------------------------------------
// applyPlugin
// ---------------------------------------------------------------------------

/**
 * Execute plugin-install operations produced by planPlugin.
 *
 * For each plugin-install op:
 * 1. Run `claude plugin marketplace add <marketplace>`.
 *    If exit code ≠ 0 → throw PluginInstallError with the native stderr.
 *    The install step is NOT called after a marketplace failure.
 * 2. Run `claude plugin install <plugin>`.
 *    If exit code ≠ 0 → throw PluginInstallError with the native stderr.
 *
 * If gitlabToken is provided, it is passed as GITLAB_TOKEN in the runner env
 * for both commands (useful for private GitLab-hosted marketplace registries).
 *
 * Ops of any other kind are silently skipped (forward-compatibility).
 *
 * @param ops           Write operations (only 'plugin-install' kind are processed).
 * @param env           Injectable env (kept for interface symmetry).
 * @param opts          Optional { run, gitlabToken }.
 */
export async function applyPlugin(
  ops: WriteOp[],
  _env: Env,
  opts?: { run?: PluginRunner; gitlabToken?: string },
): Promise<void> {
  const run = opts?.run ?? defaultPluginRunner;
  // Build runner opts once; omit env key entirely when no token is set
  // (exactOptionalPropertyTypes: pass undefined opts rather than { env: undefined }).
  const runnerOpts = opts?.gitlabToken === undefined
    ? undefined
    : { env: { GITLAB_TOKEN: opts.gitlabToken } };

  for (const op of ops) {
    if (op.kind !== 'plugin-install') {
      continue;
    }

    const installOp = op as WriteOpPluginInstall;

    // Step 1: register the marketplace
    const marketplaceCmd = `claude plugin marketplace add ${installOp.marketplace}`;
    const addResult = await run(
      'claude',
      ['plugin', 'marketplace', 'add', installOp.marketplace],
      runnerOpts,
    );

    if (addResult.exitCode === 0) {
      // Step 2: install the plugin (only when marketplace add succeeded)
      const installCmd = `claude plugin install ${installOp.plugin}`;
      const installResult = await run(
        'claude',
        ['plugin', 'install', installOp.plugin],
        runnerOpts,
      );

      if (installResult.exitCode !== 0) {
        throw new PluginInstallError(installCmd, installResult.stderr);
      }
    } else {
      throw new PluginInstallError(marketplaceCmd, addResult.stderr);
    }
  }
}
