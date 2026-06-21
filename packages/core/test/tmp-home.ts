/**
 * Test isolation helper for agent-rigger.
 *
 * Provides a temporary HOME directory via RIGGER_HOME override so tests never
 * touch the real ~/.claude or ~/.config/agent-rigger.
 *
 * Usage:
 *   const { env, cleanup } = await makeTmpHome();
 *   // ... use env in engine / path calls ...
 *   await cleanup();
 *
 * Design:
 * - Each call creates a fresh directory under os.tmpdir().
 * - The returned env object has { RIGGER_HOME: '<tmp-path>' } so resolveHome()
 *   picks it up (design §3, R12.1).
 * - cleanup() removes the entire tmp tree (recursive).
 * - NOT a test file — no `it`/`describe` exports. Pure utility.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Env } from '../src/paths';

export interface TmpHome {
  /** Absolute path to the temporary home directory. */
  dir: string;
  /** Env object to pass to engine/path functions as the `env` parameter. */
  env: Env;
  /** Remove the tmp directory tree. Call in afterEach. */
  cleanup: () => Promise<void>;
}

/**
 * Create an isolated tmp HOME directory.
 *
 * @param prefix  Optional prefix for the tmp dir name (default 'rigger-tmp-home-').
 */
export async function makeTmpHome(prefix = 'rigger-tmp-home-'): Promise<TmpHome> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };

  return {
    dir,
    env,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}
