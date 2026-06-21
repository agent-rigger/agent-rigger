/**
 * Preflight authentication check for agent-rigger CLI.
 *
 * Design invariants:
 * - Non-invasive: if ambient credentials work, nothing is prompted.
 * - Injectable: CommandRunner and AskMethod are injected — no real git/network in tests.
 * - No process.exit: errors surface as PreflightAuthError (caller decides how to handle).
 * - No while loops: a single ambient probe + one re-probe per method.
 *
 * Token injection strategy (provider-cli):
 *   - github.com → `gh auth token` → re-probe with env GITHUB_TOKEN=<token>
 *   - gitlab (gitlab.com or any host containing "gitlab") → `glab auth token` → env GITLAB_TOKEN=<token>
 *
 * SSH URL conversion:
 *   https://host/owner/repo.git  →  git@host:owner/repo.git
 *   URLs already starting with "git@" are passed through unchanged.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Thin abstraction over child-process execution.
 * Mirrors the minimal surface used by probeRemote and token fetching.
 */
export type CommandRunner = (
  command: string,
  args: string[],
  opts?: { env?: Record<string, string | undefined> },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** Authentication methods understood by the preflight. Mirrors Config.authMethod. */
export type AuthMethod = 'provider-cli' | 'https' | 'ssh';

/** Callback that asks the user to choose an AuthMethod (injected; UI in prod). */
export type AskMethod = () => Promise<AuthMethod>;

/** Discriminated union returned by preflightAuth on success. */
export type PreflightResult =
  | { ok: true; method?: AuthMethod }
  | { ok: false; method: AuthMethod; reason: string };

// ---------------------------------------------------------------------------
// Default runner (Bun-first, production only — never used in tests)
// ---------------------------------------------------------------------------

/**
 * Default CommandRunner backed by Bun.spawn.
 * Reads stdout/stderr to completion; waits for process exit.
 */
export const defaultRunner: CommandRunner = async (command, args, opts) => {
  const proc = Bun.spawn([command, ...args], {
    env: opts?.env === undefined ? process.env : { ...process.env, ...opts.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdoutBuf, stderrBuf] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  return { exitCode: exitCode ?? 1, stdout: stdoutBuf, stderr: stderrBuf };
};

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

/**
 * Thrown by preflightAuth when authentication cannot be established.
 * Carries url + method so the CLI layer can render an actionable message
 * (though the message itself already contains actionable guidance).
 */
export class PreflightAuthError extends Error {
  readonly url: string;
  readonly method: AuthMethod;

  constructor(url: string, method: AuthMethod, message: string) {
    super(message);
    this.name = 'PreflightAuthError';
    this.url = url;
    this.method = method;
  }
}

// ---------------------------------------------------------------------------
// probeRemote
// ---------------------------------------------------------------------------

/**
 * Probe repository access with `git ls-remote <url>`.
 * Returns true when the command exits 0, false otherwise.
 * No throws — network/auth failures are represented as false.
 */
export async function probeRemote(
  url: string,
  run: CommandRunner,
  opts?: { env?: Record<string, string | undefined> },
): Promise<boolean> {
  const result = await run('git', ['ls-remote', url], opts);
  return result.exitCode === 0;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Detect whether the URL belongs to a gitlab host.
 * Matches gitlab.com and any host whose name contains "gitlab".
 */
function isGitlabHost(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === 'gitlab.com' || hostname.includes('gitlab');
  } catch {
    // Non-URL (e.g. ssh git@ form) — fall back to string match
    return url.includes('gitlab');
  }
}

/**
 * Convert an https URL to its git+ssh equivalent.
 * https://host/owner/repo.git  →  git@host:owner/repo.git
 * git@ URLs are returned unchanged.
 */
function httpsToSsh(url: string): string {
  if (url.startsWith('git@')) {
    return url;
  }
  try {
    const parsed = new URL(url);
    // pathname starts with "/", strip it: "/owner/repo.git" → "owner/repo.git"
    const path = parsed.pathname.replace(/^\//, '');
    return `git@${parsed.hostname}:${path}`;
  } catch {
    // Cannot parse — return as-is and let git report the error
    return url;
  }
}

/** Build an actionable error message per method. */
function actionableMessage(method: AuthMethod, url: string, isGitlab: boolean): string {
  switch (method) {
    case 'provider-cli': {
      const cmd = isGitlab ? 'glab auth login' : 'gh auth login';
      return `provider-cli authentication failed for ${url}. Run \`${cmd}\` and try again.`;
    }
    case 'https':
      return `https authentication failed for ${url}. Configure a git credential helper (e.g. \`git credential-osxkeychain\` or \`git credential-manager\`) and try again.`;
    case 'ssh':
      return `ssh authentication failed for ${url}. Ensure your SSH key is added to ssh-agent (\`ssh-add ~/.ssh/id_ed25519\`) and registered with the host.`;
  }
}

// ---------------------------------------------------------------------------
// Internal: typed opts builder (exactOptionalPropertyTypes-safe)
// ---------------------------------------------------------------------------

/**
 * Build a runner opts object only when env is defined.
 * Passing `{ env: undefined }` is rejected by exactOptionalPropertyTypes;
 * returning undefined lets callers use `run(cmd, args, envOpts(e))` safely.
 */
function envOpts(
  env: Record<string, string | undefined> | undefined,
): { env: Record<string, string | undefined> } | undefined {
  return env === undefined ? undefined : { env };
}

// ---------------------------------------------------------------------------
// Method applicators
// ---------------------------------------------------------------------------

async function applyProviderCli(
  url: string,
  run: CommandRunner,
  env?: Record<string, string | undefined>,
): Promise<boolean> {
  const gitlab = isGitlabHost(url);
  const cli = gitlab ? 'glab' : 'gh';
  const envKey = gitlab ? 'GITLAB_TOKEN' : 'GITHUB_TOKEN';

  const tokenResult = await run(cli, ['auth', 'token'], envOpts(env));
  if (tokenResult.exitCode !== 0) {
    return false;
  }

  const token = tokenResult.stdout.trim();
  if (token === '') {
    return false;
  }

  return probeRemote(url, run, { env: { ...env, [envKey]: token } });
}

async function applyHttps(
  url: string,
  run: CommandRunner,
  env?: Record<string, string | undefined>,
): Promise<boolean> {
  // Re-probe using the same https URL; git will invoke the credential helper.
  return probeRemote(url, run, envOpts(env));
}

async function applySsh(
  url: string,
  run: CommandRunner,
  env?: Record<string, string | undefined>,
): Promise<boolean> {
  const sshUrl = httpsToSsh(url);
  return probeRemote(sshUrl, run, envOpts(env));
}

// ---------------------------------------------------------------------------
// preflightAuth
// ---------------------------------------------------------------------------

export interface PreflightAuthOpts {
  /** Repository URL to probe. */
  url: string;
  /** CommandRunner implementation (defaults to defaultRunner). */
  run?: CommandRunner;
  /** Called when ambient probe fails and no method is pre-configured. */
  askMethod: AskMethod;
  /** Pre-configured auth method (skips askMethod when provided). */
  method?: AuthMethod;
  /** Extra environment variables forwarded to every sub-process. */
  env?: Record<string, string | undefined>;
}

/**
 * Run the preflight authentication sequence:
 *
 * 1. Ambient probe — if the repo is reachable without any intervention, return
 *    immediately without asking anything (non-invasive).
 * 2. Determine auth method — use opts.method if provided, otherwise call askMethod.
 * 3. Apply the method and re-probe.
 * 4. On success return PreflightResult { ok: true, method }.
 * 5. On failure throw PreflightAuthError with an actionable message.
 */
export async function preflightAuth(opts: PreflightAuthOpts): Promise<PreflightResult> {
  const { url, run = defaultRunner, askMethod, method: configuredMethod, env } = opts;

  // Step 1 — ambient probe
  const ambientOk = await probeRemote(url, run, envOpts(env));
  if (ambientOk) {
    return { ok: true };
  }

  // Step 2 — determine method
  const method: AuthMethod = configuredMethod ?? await askMethod();

  // Step 3 — apply method and re-probe
  const gitlab = isGitlabHost(url);

  let reProbeOk: boolean;
  switch (method) {
    case 'provider-cli':
      reProbeOk = await applyProviderCli(url, run, env);
      break;
    case 'https':
      reProbeOk = await applyHttps(url, run, env);
      break;
    case 'ssh':
      reProbeOk = await applySsh(url, run, env);
      break;
  }

  // Step 4 — success
  if (reProbeOk) {
    return { ok: true, method };
  }

  // Step 5 — failure
  throw new PreflightAuthError(url, method, actionableMessage(method, url, gitlab));
}
