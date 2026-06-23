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
 */

import { loadConfigFile, persistConfig } from './config';

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
  const { verb, args, configPath, print } = opts;

  // ----- catalog ls -----
  if (verb === 'ls') {
    const config = await loadConfigFile(configPath);
    const catalogs = config.catalogs ?? [];

    if (catalogs.length === 0) {
      print('aucun catalog configuré — lance `agent-rigger init` ou `catalog add <name> <url>`');
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
      print(`[error] catalog "${name}" existe déjà (${existing.url}).`);
      return 2;
    }

    const updated = [...catalogs, { name, url }];
    await persistConfig(configPath, { ...config, catalogs: updated });

    print(`catalog "${name}" ajouté (${url})`);
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
      print(`[error] catalog "${name}" introuvable.`);
      return 2;
    }

    const updated = catalogs.filter((c) => c.name !== name);
    await persistConfig(configPath, { ...config, catalogs: updated });

    print(`catalog "${name}" retiré.`);
    return 0;
  }

  // ----- unknown verb -----
  print(`[error] Unknown verb "${verb}" for "catalog". Available: ls, add, remove.`);
  return 2;
}
