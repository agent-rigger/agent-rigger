import type { ArtifactEntry, CatalogEntry } from './schema';

// ---------------------------------------------------------------------------
// CommandRunner — injectable shell executor
// ---------------------------------------------------------------------------

/**
 * Runs a shell command and returns its exit code.
 * Inject a fake implementation in tests to avoid spawning real processes.
 */
export type CommandRunner = (command: string) => Promise<{ exitCode: number }>;

/**
 * Default runner: executes `command` via `sh -c` using Bun's process API.
 * stdout and stderr are suppressed — only the exit code matters.
 */
export const defaultRunner: CommandRunner = async (command) => {
  const proc = Bun.spawn(['sh', '-c', command], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const exitCode = await proc.exited;
  return { exitCode };
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
  /** True when the check command exited 0 (tool is present). */
  present: boolean;
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
    present: exitCode === 0,
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
 * Advisory only — does not throw or exit.
 */
export function missingRequired(results: ToolCheckResult[]): ToolCheckResult[] {
  return results.filter((r) => r.level === 'required' && !r.present);
}

/**
 * Returns results for recommended tools that are absent.
 * Advisory only — does not throw or exit.
 */
export function missingRecommended(results: ToolCheckResult[]): ToolCheckResult[] {
  return results.filter((r) => r.level === 'recommended' && !r.present);
}
