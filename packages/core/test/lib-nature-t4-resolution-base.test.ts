/**
 * lib-nature-t4-resolution-base.test.ts — permanent test of the resolution
 * base a symlinked, lib-dependent artefact relies on (R4, lib-nature T4,
 * design.md § Surfaces de cycle de vie "test permanent de base de résolution").
 *
 * Replays the 2026-07-19 probe that the whole lib-nature mechanism (S1
 * "Géométrie d'import = la pose") is built on: a module posed via a REAL
 * symlink and imported in relative form resolves its import against the
 * symlink's TARGET (realpath) — the store — not against the symlink's own
 * directory. Ports it to a fixture that mirrors the real layout (a store
 * with a plugin file + a sibling libs/ dir, linked into an external "target"
 * location that ALSO has a libs/ sibling with DISTINCT content) so a
 * regression (a future Bun/Node resolution change, or a code path that starts
 * resolving from the link's own path) is caught by CI, not rediscovered by
 * hand.
 *
 * Deliberately an OUTPUT-observable test, not a boolean pass/fail: the
 * consumer module is executed as a real child process (bun run) and its
 * stdout — the `marker` string it imports — is asserted directly. A silent
 * resolution regression would either crash (module not found) or print the
 * WRONG marker; both are visible in the captured output, not inferred from a
 * green checkmark alone.
 *
 * Zero mocks: real filesystem (tmp dirs), real symlink (linker.ts's
 * linkOrCopy — the exact primitive opencode/plugins.ts uses in production),
 * real bun subprocess.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { linkOrCopy } from '../src/linker';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const TARGET_MARKER = 'target-store-side';
const DECOY_MARKER = 'symlink-side-decoy';

let storeRoot: string;
let externalRoot: string;

beforeEach(async () => {
  storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t4-resolution-store-'));
  externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t4-resolution-external-'));
});

afterEach(async () => {
  await fs.rm(storeRoot, { recursive: true, force: true });
  await fs.rm(externalRoot, { recursive: true, force: true });
});

/**
 * Build the two-libs-either-side-of-the-symlink fixture and pose the
 * consumer module via the REAL linkOrCopy (production primitive).
 *
 * - storeRoot/plugins/consumer.ts + storeRoot/libs/rules-common/index.ts
 *   (marker = TARGET_MARKER) — the store, sibling layout production uses
 *   (~/.config/agent-rigger/{plugins,libs}/).
 * - externalRoot/plugin/consumer.ts (SYMLINK, produced by linkOrCopy) +
 *   externalRoot/libs/rules-common/index.ts (marker = DECOY_MARKER) — a
 *   decoy lib placed adjacent to the SYMLINK's own location, to make the
 *   assertion below falsifiable: if resolution ever followed the link's own
 *   path instead of its realpath, the decoy is what would print.
 *
 * Returns the path to the symlinked consumer.ts (what a real install would
 * hand to `bun run`) and the linkOrCopy method actually used.
 */
async function buildFixture(): Promise<{ consumerTarget: string; method: string }> {
  const storePlugins = path.join(storeRoot, 'plugins');
  const storeLib = path.join(storeRoot, 'libs', 'rules-common');
  await fs.mkdir(storePlugins, { recursive: true });
  await fs.mkdir(storeLib, { recursive: true });
  await fs.writeFile(
    path.join(storePlugins, 'consumer.ts'),
    "import { marker } from '../libs/rules-common/index.ts';\nconsole.log(marker);\n",
    'utf8',
  );
  await fs.writeFile(
    path.join(storeLib, 'index.ts'),
    `export const marker = '${TARGET_MARKER}';\n`,
    'utf8',
  );

  const externalLib = path.join(externalRoot, 'libs', 'rules-common');
  await fs.mkdir(externalLib, { recursive: true });
  await fs.writeFile(
    path.join(externalLib, 'index.ts'),
    `export const marker = '${DECOY_MARKER}';\n`,
    'utf8',
  );

  const storeFile = path.join(storePlugins, 'consumer.ts');
  const consumerTarget = path.join(externalRoot, 'plugin', 'consumer.ts');
  const method = await linkOrCopy(storeFile, consumerTarget);

  return { consumerTarget, method };
}

/** Spawn `bun run <file>` and return trimmed stdout. Throws on a non-zero exit. */
async function runConsumer(file: string): Promise<string> {
  const proc = Bun.spawn(['bun', 'run', file], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`consumer exited ${exitCode}: ${stderr}`);
  }
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// Permanent test — sortie observable
// ---------------------------------------------------------------------------

describe('permanent: symlinked consumer resolves its relative import from the realpath (store)', () => {
  it('poses the consumer via a real symlink (linkOrCopy)', async () => {
    const { method } = await buildFixture();
    // Sanity anchor for the rest of the test: the whole premise (S1) is about
    // a REAL symlink, not the copy-fallback (already covered elsewhere).
    expect(method).toBe('symlink');
  });

  it("the executed consumer's stdout identifies the STORE-side marker, not the decoy next to the symlink", async () => {
    const { consumerTarget } = await buildFixture();

    const output = await runConsumer(consumerTarget);

    expect(output).toBe(TARGET_MARKER);
    expect(output).not.toBe(DECOY_MARKER);
  });
});
