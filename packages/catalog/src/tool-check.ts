import type { ArtifactEntry, CatalogEntry } from './schema';

// ---------------------------------------------------------------------------
// CommandRunner — injectable shell executor
// ---------------------------------------------------------------------------

/** Result returned by a CommandRunner invocation. */
export interface CommandResult {
  exitCode: number;
  /** Captured stdout. Absent when the caller does not need output. */
  stdout?: string;
  /** Captured stderr. Absent when the caller does not need output. */
  stderr?: string;
}

/**
 * Runs a command with optional argument list.
 * Inject a fake implementation in tests to avoid spawning real processes.
 *
 * When called as `run(command)` (no args), implementations may fall back to
 * `sh -c command`. When called as `run(command, args)`, implementations
 * should spawn `command` directly with the given args.
 */
export type CommandRunner = (
  command: string,
  args?: string[],
) => Promise<CommandResult>;

/**
 * Default runner: executes `command` via Bun's process API.
 * When `args` is provided, spawns `[command, ...args]` directly.
 * Without `args`, falls back to `sh -c <command>`.
 * Captures stdout and stderr as UTF-8 strings.
 */
export const defaultRunner: CommandRunner = async (command, args) => {
  const argv = args ? [command, ...args] : ['sh', '-c', command];
  const proc = Bun.spawn(argv, {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
};

// ---------------------------------------------------------------------------
// ToolCheckResult
// ---------------------------------------------------------------------------

/** Result of checking a single tool's presence on the system. */
export type ToolCheckResult = {
  /** Catalog entry id, e.g. "tool:glab". */
  id: string;
  /** Importance level declared in the catalog entry. */
  level: 'required' | 'recommended' | undefined;
  /**
   * 'present'    — the check command exited 0.
   * 'absent'     — the check command exited non-zero.
   * 'unverified' — the check command was never run (consent to execute it
   *                was declined): presence is simply unknown, and this is
   *                NOT the same as 'absent' — checkTool/checkTools never
   *                produce this value themselves; callers that gate
   *                execution behind consent assign it directly.
   */
  presence: 'present' | 'absent' | 'unverified';
};

// ---------------------------------------------------------------------------
// checkTool
// ---------------------------------------------------------------------------

/**
 * Check whether a single tool artifact is present on the system.
 *
 * Requires:
 *  - entry.kind === 'artifact' and entry.nature === 'tool'
 *  - entry.check is defined
 *
 * Throws a descriptive Error if either precondition is unmet.
 *
 * @param entry - Must be a tool artifact with a check command.
 * @param run   - Shell executor; defaults to defaultRunner.
 */
export async function checkTool(
  entry: ArtifactEntry,
  run: CommandRunner = defaultRunner,
): Promise<ToolCheckResult> {
  if (entry.kind !== 'artifact' || entry.nature !== 'tool') {
    throw new Error(
      `checkTool requires a tool artifact; received kind='${entry.kind}' nature='${
        (entry as ArtifactEntry).nature ?? 'n/a'
      }'`,
    );
  }
  if (!entry.check) {
    throw new Error(
      `checkTool requires entry.check to be defined; entry '${entry.id}' has no check command`,
    );
  }

  const { exitCode } = await run(entry.check);
  return {
    id: entry.id,
    level: entry.level,
    presence: exitCode === 0 ? 'present' : 'absent',
  };
}

// ---------------------------------------------------------------------------
// checkTools
// ---------------------------------------------------------------------------

/**
 * Check presence of all tool artifacts that declare a check command.
 *
 * Silently skips entries that are:
 *  - packs (kind 'pack')
 *  - non-tool artifacts (nature !== 'tool')
 *  - tool artifacts without a check command
 *
 * All eligible tools are checked in parallel via Promise.all.
 * Result order matches the order of eligible entries in the input array.
 *
 * @param entries - Full catalog (may contain any mix of entry types).
 * @param run     - Shell executor; defaults to defaultRunner.
 */
export async function checkTools(
  entries: CatalogEntry[],
  run: CommandRunner = defaultRunner,
): Promise<ToolCheckResult[]> {
  const eligible = entries.filter(
    (e): e is ArtifactEntry => e.kind === 'artifact' && e.nature === 'tool' && Boolean(e.check),
  );
  return Promise.all(eligible.map((e) => checkTool(e, run)));
}

// ---------------------------------------------------------------------------
// Advisory report helpers
// ---------------------------------------------------------------------------

/**
 * Returns results for required tools that are absent.
 * An 'unverified' result (consent declined) is never "missing" — we simply
 * don't know — so it is excluded here, same as 'present'.
 * Advisory only — does not throw or exit.
 */
export function missingRequired(results: ToolCheckResult[]): ToolCheckResult[] {
  return results.filter((r) => r.level === 'required' && r.presence === 'absent');
}

/**
 * Returns results for recommended tools that are absent.
 * An 'unverified' result (consent declined) is never "missing" — we simply
 * don't know — so it is excluded here, same as 'present'.
 * Advisory only — does not throw or exit.
 */
export function missingRecommended(results: ToolCheckResult[]): ToolCheckResult[] {
  return results.filter((r) => r.level === 'recommended' && r.presence === 'absent');
}

/**
 * Returns results whose presence is 'unverified' — checks that were never
 * run because consent to execute them was declined. Advisory only.
 */
export function unverifiedTools(results: ToolCheckResult[]): ToolCheckResult[] {
  return results.filter((r) => r.presence === 'unverified');
}
