/**
 * Plugins handler for the Claude adapter — delegate-first.
 *
 * A plugin is never copied or linked: it is installed via the native Claude
 * CLI mechanism (`claude plugin marketplace add` + `claude plugin install`).
 * The handler only pilots the native commands and re-raises their errors
 * verbatim — nothing is swallowed.
 *
 * Three functions mirror the shape of guardrails, context, and skills handlers:
 *   auditPlugin  — read-only, calls `claude plugin list`, returns NatureReport.
 *   planPlugin   — read-only, returns WriteOp[] (zero or one plugin-install op).
 *   applyPlugin  — runs the native CLI commands; throws PluginInstallError on failure.
 *
 * Runner injection:
 *   Both auditPlugin and applyPlugin accept an optional { run: PluginRunner }
 *   so tests never invoke the real `claude` binary.
 *
 *   defaultPluginRunner: uses Bun.spawn, pipes stdout/stderr, returns exit code.
 *
 * Plugin source resolution:
 *   planPlugin and the adapter wiring accept a pluginSource resolver:
 *     (entry) => { plugin: string; marketplace: string }
 *   Default (when not configured): plugin = pluginName(entry), marketplace =
 *   '<cwd>/.claude-plugin/marketplace.json' (bundled manifest path convention).
 *   Callers providing a ClaudeAdapterConfig.pluginSource override this default.
 *
 * Invariants:
 * - auditPlugin and planPlugin are read-only (no fs writes).
 * - No while loops; no process.exit().
 * - PluginInstallError carries the command string and the native stderr verbatim.
 */

import type { AdapterEntry, AdoptionResult } from '@agent-rigger/core/adapter';
import type { Env } from '@agent-rigger/core/paths';
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
  /** Path or URL of the marketplace manifest to register. */
  marketplace: string;
}

// ---------------------------------------------------------------------------
// auditPlugin
// ---------------------------------------------------------------------------

/**
 * Audit the current state of a plugin by calling `claude plugin list`.
 *
 * Returns:
 * - 'present' if the plugin name appears in the list output.
 * - 'missing' if the plugin name is absent.
 *
 * Read-only: no filesystem writes; the real claude binary is never called
 * in tests (inject a fake runner via opts.run).
 *
 * @param entry   Artifact entry (id carries the plugin name).
 * @param env     Injectable env (kept for interface symmetry with other handlers).
 * @param opts    Optional { run: PluginRunner } for test injection.
 */
export async function auditPlugin(
  entry: AdapterEntry,
  _env: Env,
  opts?: { run?: PluginRunner },
): Promise<NatureReport> {
  const run = opts?.run ?? defaultPluginRunner;
  const name = pluginName(entry);

  const { stdout } = await run('claude', ['plugin', 'list']);

  // Exact token match: the plugin name must appear as a whitespace-delimited token on a line.
  // substring matching (line.includes) produces false positives — e.g. 'git' matching 'legit'.
  const present = stdout.split('\n').some((line) => line.trim().split(/\s+/).includes(name));

  return {
    id: entry.id,
    nature: 'plugin',
    state: present ? 'present' : 'missing',
  };
}

// ---------------------------------------------------------------------------
// planPlugin
// ---------------------------------------------------------------------------

/**
 * Compute the write operations needed to install a plugin.
 *
 * Calls auditPlugin internally to determine current state, then:
 * - Returns [] when the plugin is already present (idempotent).
 * - Returns [{ kind: 'plugin-install', plugin, marketplace }] when absent.
 *
 * Read-only: no filesystem writes.
 *
 * @param entry         Artifact entry.
 * @param pluginSource  Resolver: entry → { plugin, marketplace }.
 * @param opts          Optional { run: PluginRunner } forwarded to auditPlugin.
 */
export async function planPlugin(
  entry: AdapterEntry,
  pluginSource: (entry: AdapterEntry) => PluginSource,
  opts?: { run?: PluginRunner },
): Promise<WriteOp[]> {
  const report = await auditPlugin(entry, {} as Env, opts);
  if (report.state === 'present') {
    return [];
  }

  const { plugin, marketplace } = pluginSource(entry);
  const op: WriteOpPluginInstall = { kind: 'plugin-install', plugin, marketplace };
  return [op];
}

// ---------------------------------------------------------------------------
// planRemovePlugin
// ---------------------------------------------------------------------------

/**
 * Compute the removal operations needed to uninstall a plugin.
 *
 * Calls auditPlugin internally to determine current state, then:
 * - Returns [] when the plugin is not present (idempotent).
 * - Returns [{ kind: 'plugin-uninstall', plugin }] when the plugin is installed.
 *
 * Read-only: no filesystem writes.
 *
 * @param entry  Artifact entry.
 * @param opts   Optional { run: PluginRunner } forwarded to auditPlugin.
 */
export async function planRemovePlugin(
  entry: AdapterEntry,
  opts?: { run?: PluginRunner },
): Promise<RemovalOp[]> {
  const report = await auditPlugin(entry, {} as Env, opts);
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
 * Adopt gate for the plugin nature (R5/D5).
 *
 * Adopts ONLY when `claude plugin list` reports the plugin present — the same
 * condition under which planPlugin returns [] (empty plan). A plugin is a
 * delegated nature (installed/removed through the native CLI, never copied), so
 * there is NO offline payload to reverse: the AdoptionResult carries an empty
 * `files` and no `applied`. Recording the entry is still what lets remove reach
 * the `claude plugin uninstall` path and check verify presence.
 *
 * Read-only: no filesystem writes (the native `plugin list` is a query).
 *
 * @param entry  Artifact entry (id carries the plugin name).
 * @param env    Injectable env (kept for interface symmetry).
 * @param opts   Optional { run: PluginRunner } for test injection.
 */
export async function adoptPlugin(
  entry: AdapterEntry,
  env: Env,
  opts?: { run?: PluginRunner },
): Promise<AdoptionResult | undefined> {
  const report = await auditPlugin(entry, env, opts);
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
