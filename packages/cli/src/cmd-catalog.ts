/**
 * cmd-catalog — implementation of the `catalog ls|add|remove` command.
 *
 * Responsibilities:
 * - `catalog ls`              List configured catalog sources (name + url).
 * - `catalog add <name> <url>` Add a new source; reject if name already present.
 * - `catalog remove <name>`   Remove an existing source by name.
 *
 * Design invariants:
 * - No process.exit — exit code is returned, the caller decides.
 * - No while loops.
 * - All I/O injected via opts (print, configPath) for test isolation.
 * - Config is read and written via loadConfigFile / persistConfig (round-trip safe).
 * - fetchCatalogFn / proposeInstall failures after add are caught non-fatally:
 *   config stays saved, output gets an actionable hint to run `install` later.
 *   Same pattern as cmd-init.ts §step-6. A CancelledError (R2, user Ctrl+C in the
 *   post-add picker) is re-thrown, not swallowed — it maps to exit 130.
 */

import { CLI_COMMAND } from './cli';
import type { CatalogProposal } from './cmd-init';
import { loadConfigFile, persistConfig } from './config';
import { CancelledError } from './ui';

// Re-export so tests importing from cmd-catalog get the type without a separate import.
export type { CatalogProposal } from './cmd-init';

// ---------------------------------------------------------------------------
// RunCatalogOpts
// ---------------------------------------------------------------------------

export interface RunCatalogOpts {
  /** Sub-verb: 'ls' | 'add' | 'remove'. */
  verb: string;
  /** Positional arguments after the verb (e.g. [name, url] for add). */
  args: string[];
  /** Absolute path to the config.json file (resolved from env by the caller). */
  configPath: string;
  /** Output sink. */
  print: (msg: string) => void;
  /**
   * Injected catalog fetcher (TTY / interactive mode) — M7/R9.
   * Called after a successful catalog add with the new source's url and name.
   * Returns a CatalogProposal (meta + qualified entries + sourceName).
   * When absent (non-TTY), the proposal step is skipped entirely.
   * Failures are caught non-fatally — config stays saved.
   * Only called when proposeInstall is also present.
   */
  fetchCatalogFn?: (url: string, name: string) => Promise<CatalogProposal>;
  /**
   * Injected picker + install orchestration (TTY / interactive mode) — M7/R9.
   * Receives the fetched catalog; returns the list of ids the user selected.
   * An empty array means the user cancelled or selected nothing.
   * Only called when fetchCatalogFn is also present.
   * Failures are caught non-fatally — config stays saved.
   */
  proposeInstall?: (catalog: CatalogProposal) => Promise<string[]>;
}

// ---------------------------------------------------------------------------
// runCatalog
// ---------------------------------------------------------------------------

/**
 * Execute the catalog sub-command and return an exit code.
 *
 * Exit codes:
 *   0  success
 *   2  invalid args / name already exists / name not found / unknown verb
 */
export async function runCatalog(opts: RunCatalogOpts): Promise<number> {
  const { verb, args, configPath, print, fetchCatalogFn, proposeInstall } = opts;

  // ----- catalog ls -----
  if (verb === 'ls') {
    const config = await loadConfigFile(configPath);
    const catalogs = config.catalogs ?? [];

    if (catalogs.length === 0) {
      print(`no catalog configured — run \`${CLI_COMMAND} init\` or \`catalog add <name> <url>\``);
      return 0;
    }

    for (const entry of catalogs) {
      print(`${entry.name}  ${entry.url}`);
    }

    return 0;
  }

  // ----- catalog add <name> <url> -----
  if (verb === 'add') {
    const name = args[0];
    const url = args[1];

    if (name === undefined || name === '') {
      print('[error] "catalog add" requires <name> and <url> arguments.');
      return 2;
    }

    if (url === undefined || url === '') {
      print('[error] "catalog add" requires <name> and <url> arguments.');
      return 2;
    }

    const config = await loadConfigFile(configPath);
    const catalogs = config.catalogs ?? [];

    const existing = catalogs.find((c) => c.name === name);
    if (existing !== undefined) {
      print(`[error] catalog "${name}" already exists (${existing.url}).`);
      return 2;
    }

    const updated = [...catalogs, { name, url }];
    await persistConfig(configPath, { ...config, catalogs: updated });

    print(`catalog "${name}" added (${url})`);

    // Step M7/R9 — post-add catalog proposal (interactive / TTY mode only).
    // Both fetchCatalogFn and proposeInstall must be provided; otherwise skip silently.
    // Failures are caught non-fatally: config is already saved.
    if (fetchCatalogFn !== undefined && proposeInstall !== undefined) {
      try {
        const catalog = await fetchCatalogFn(url, name);
        await proposeInstall(catalog);
      } catch (err) {
        // R2/ADR-0024: a user cancel (Ctrl+C in the post-add picker) must
        // propagate to exit 130, not be swallowed as a non-fatal fetch failure.
        if (err instanceof CancelledError) {
          throw err;
        }
        // Non-fatal: config is already saved. Give the user an actionable hint.
        print(
          `\nCatalog fetch failed. Run \`install\` later to install artifacts from the catalog.`,
        );
      }
    }

    return 0;
  }

  // ----- catalog remove <name> -----
  if (verb === 'remove') {
    const name = args[0];

    if (name === undefined || name === '') {
      print('[error] "catalog remove" requires a <name> argument.');
      return 2;
    }

    const config = await loadConfigFile(configPath);
    const catalogs = config.catalogs ?? [];

    const index = catalogs.findIndex((c) => c.name === name);
    if (index === -1) {
      print(`[error] catalog "${name}" not found.`);
      return 2;
    }

    const updated = catalogs.filter((c) => c.name !== name);
    await persistConfig(configPath, { ...config, catalogs: updated });

    print(`catalog "${name}" removed.`);
    return 0;
  }

  // ----- unknown verb -----
  print(`[error] Unknown verb "${verb}" for "catalog". Available: ls, add, remove.`);
  return 2;
}
