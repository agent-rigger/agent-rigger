/**
 * lib-nature-t4-resolution-base.test.ts — permanent test of the resolution
 * base a symlinked, lib-dependent artefact relies on (R4, lib-nature T4,
 * design.md § Surfaces de cycle de vie "test permanent de base de résolution"
 * — BASCULÉ sur la convention `#libs/*` par U1, lib-imports-alias).
 *
 * Replays the 2026-07-22 probe (brief lib-imports-alias) that the
 * lib-imports-alias mechanism is built on: a consumer module posed via a REAL
 * symlink and importing a `#libs/<lib>/<mod>.ts` subpath specifier resolves
 * against the home-managed `package.json` found by walking up from the
 * symlink's REALPATH (the store) — NOT from the process CWD, and NOT from any
 * `package.json` sitting adjacent to the symlink's own (non-real) location.
 * Ports it to a fixture that mirrors the real layout (a store — the rigger
 * home — with a `package.json` mapping `#libs/*` → `./libs/*`, a `libs/`
 * dir, and a `plugins/` dir, linked into an external "plugin store" location
 * that ALSO carries a package.json with a CONFLICTING `#libs/*` mapping, run
 * from a THIRD, unrelated CWD that carries its own conflicting package.json)
 * so a regression (a future Bun resolution change, or a code path that starts
 * resolving from the link's own path/CWD) is caught by CI, not rediscovered
 * by hand.
 *
 * TWO decoys, both from the 2026-07-22 probe's own findings (brief.md):
 *   - a package.json adjacent to the symlink's own (non-real) location
 *     (`externalRoot/package.json`, ancestor of `externalRoot/plugin/`);
 *   - a package.json at a foreign process CWD, unrelated to both the
 *     symlink's location and its realpath.
 * Neither may ever capture the `#libs/*` resolution — only the realpath
 * ancestor (the store's own `package.json`) may.
 *
 * Also pins the probe's reserve: a `#libs/…` specifier WITHOUT the `.ts`
 * extension fails resolution (negative test) — the extension is MANDATORY.
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
 * real bun subprocess, real package.json files (no engine involved — this
 * test probes Bun's own resolution mechanism against hand-built fixtures,
 * the same posture the pre-U1 version of this test took for relative
 * imports).
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
const DECOY_LINK_MARKER = 'decoy-adjacent-to-link';
const DECOY_CWD_MARKER = 'decoy-foreign-cwd';

let storeRoot: string;
let externalRoot: string;
let foreignCwd: string;

beforeEach(async () => {
  storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t4-resolution-store-'));
  externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t4-resolution-external-'));
  foreignCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t4-resolution-foreign-cwd-'));
});

afterEach(async () => {
  await fs.rm(storeRoot, { recursive: true, force: true });
  await fs.rm(externalRoot, { recursive: true, force: true });
  await fs.rm(foreignCwd, { recursive: true, force: true });
});

/**
 * Write a package.json at `root` mapping `#libs/*` to `./libs/*` (the exact
 * managed shape `home-package-json.ts` guarantees), and a `libs/rules-common`
 * lib exporting `marker`.
 */
async function writeHomeLike(root: string, marker: string): Promise<void> {
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ imports: { '#libs/*': './libs/*' } }) + '\n',
    'utf8',
  );
  const libDir = path.join(root, 'libs', 'rules-common');
  await fs.mkdir(libDir, { recursive: true });
  await fs.writeFile(
    path.join(libDir, 'index.ts'),
    `export const marker = '${marker}';\n`,
    'utf8',
  );
}

/**
 * Build the store (rigger home) + external plugin-store location + foreign
 * CWD fixture, and pose the consumer module via the REAL linkOrCopy
 * (production primitive: opencode/plugins.ts symlinks a store file into the
 * plugin dir).
 *
 * - storeRoot: the rigger home — `package.json` (real mapping),
 *   `libs/rules-common/index.ts` (marker = TARGET_MARKER),
 *   `plugins/consumer.ts` importing `#libs/rules-common/index.ts`.
 * - externalRoot: mirrors `~/.config/opencode/plugin/`'s PARENT — a
 *   `package.json` at its root (DECOY, marker = DECOY_LINK_MARKER) and
 *   `plugin/consumer.ts` (the SYMLINK target, produced by linkOrCopy). If
 *   resolution ever walked up from the symlink's OWN path instead of its
 *   realpath, THIS is the package.json/lib it would capture.
 * - foreignCwd: an unrelated directory the consumer process is launched
 *   from — its own `package.json` (DECOY, marker = DECOY_CWD_MARKER). If
 *   resolution ever consulted the process CWD, THIS is what it would
 *   capture.
 *
 * Returns the path to the symlinked consumer.ts (what a real install would
 * hand to `bun run`) and the linkOrCopy method actually used.
 */
async function buildFixture(): Promise<{ consumerTarget: string; method: string }> {
  await writeHomeLike(storeRoot, TARGET_MARKER);
  const storePlugins = path.join(storeRoot, 'plugins');
  await fs.mkdir(storePlugins, { recursive: true });
  await fs.writeFile(
    path.join(storePlugins, 'consumer.ts'),
    "import { marker } from '#libs/rules-common/index.ts';\nconsole.log(marker);\n",
    'utf8',
  );

  await writeHomeLike(externalRoot, DECOY_LINK_MARKER);
  await fs.mkdir(path.join(externalRoot, 'plugin'), { recursive: true });

  await writeHomeLike(foreignCwd, DECOY_CWD_MARKER);

  const storeFile = path.join(storePlugins, 'consumer.ts');
  const consumerTarget = path.join(externalRoot, 'plugin', 'consumer.ts');
  const method = await linkOrCopy(storeFile, consumerTarget);

  return { consumerTarget, method };
}

/**
 * Spawn `bun run <file>` from `cwd` and return trimmed stdout. Throws on a
 * non-zero exit (module-not-found included).
 */
async function runConsumer(file: string, cwd: string): Promise<string> {
  const proc = Bun.spawn(['bun', 'run', file], { cwd, stdout: 'pipe', stderr: 'pipe' });
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

describe('permanent: symlinked consumer resolves #libs/* from the realpath ancestor package.json (U1)', () => {
  it('poses the consumer via a real symlink (linkOrCopy)', async () => {
    const { method } = await buildFixture();
    // Sanity anchor for the rest of the test: the whole premise is about a
    // REAL symlink, not the copy-fallback (already covered elsewhere).
    expect(method).toBe('symlink');
  });

  it(
    "the executed consumer's stdout identifies the STORE-side marker — "
      + 'neither the foreign-CWD decoy nor the adjacent-to-link decoy captures it',
    async () => {
      const { consumerTarget } = await buildFixture();

      const output = await runConsumer(consumerTarget, foreignCwd);

      expect(output).toBe(TARGET_MARKER);
      expect(output).not.toBe(DECOY_LINK_MARKER);
      expect(output).not.toBe(DECOY_CWD_MARKER);
    },
  );
});

// ---------------------------------------------------------------------------
// Réserve sonde — extension .ts obligatoire dans les specifiers #libs
// ---------------------------------------------------------------------------

describe('permanent: the .ts extension is MANDATORY in every #libs/* specifier (probe reserve)', () => {
  it('a #libs/... specifier WITHOUT the .ts extension fails to resolve', async () => {
    await writeHomeLike(storeRoot, TARGET_MARKER);
    const storePlugins = path.join(storeRoot, 'plugins');
    await fs.mkdir(storePlugins, { recursive: true });
    const noExtFile = path.join(storePlugins, 'consumer-no-ext.ts');
    await fs.writeFile(
      noExtFile,
      // Same import, extension DELIBERATELY omitted.
      "import { marker } from '#libs/rules-common/index';\nconsole.log(marker);\n",
      'utf8',
    );

    await expect(runConsumer(noExtFile, storeRoot)).rejects.toThrow(/Cannot find module/);
  });
});
