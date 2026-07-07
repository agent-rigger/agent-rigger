/**
 * End-to-end lifecycle tests for the opencode 'plugin' nature.
 *
 * Nature 'plugin' links a catalog-provided JS/TS module into opencode's
 * `pluginDir` via the shared store+symlink mechanism (store under
 * ~/.config/agent-rigger/plugins/, reusing the skill 'link'/'unlink' op kinds).
 *
 * This file drives the FULL lifecycle through the REAL core engine + manifest
 * (user scope) and through the REAL adapter handlers (project scope), asserting
 * dimensions NOT already covered by plugins.test.ts (which exercises the adapter
 * methods directly, never the core engine/manifest, and never the symlink→store
 * resolution nor the shared-store co-reference case):
 *
 *  1. core engine round-trip: check→apply→check→apply(idempotent)→remove→check,
 *     with the state.json manifest written on apply and cleared on remove.
 *  2. the installed target is a SYMLINK that resolves to the stored module, and
 *     the stored module content matches the source (not merely "a file exists").
 *  3. project scope full apply→present→idempotent→remove→gone (real handlers,
 *     injected cwd — the adapter hardcodes process.cwd() for project scope, so
 *     the nature/op handlers are driven directly, mirroring plugins.test.ts).
 *  4. removal leaves unrelated, user-authored files in pluginDir untouched
 *     (the analogue of "third-party content survives remove" for a nature that
 *     does not merge into opencode.json).
 *  5. the plugin store is shared across scopes (resolveStorePath is always
 *     user-scope): removing one scope must NOT strand a co-referenced install
 *     of the same plugin in the other scope.
 *
 * Real handlers/engine only — no mocks. Each assertion is load-bearing: it fails
 * if the adapter regressed to a no-op install, a no-op remove, or a broken link.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply, check, remove, reportExitCode } from '@agent-rigger/core/engine';
import { findEntry, readManifest } from '@agent-rigger/core/manifest';
import {
  resolveOpencodeProjectTargets,
  resolveOpencodeUserTargets,
  resolveUserTargets,
} from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { Scanner } from '@agent-rigger/core/scan';
import type { Verdict, WriteOpLink } from '@agent-rigger/core/types';

import { createOpencodeAdapter } from '../../src/opencode/adapter';
import { auditPlugin, planPlugin, planRemovePlugin } from '../../src/opencode/plugins';
import { applyRemoveSkill, applySkill } from '../../src/opencode/skills';

// ---------------------------------------------------------------------------
// Helpers (inlined per-file, mirroring the other opencode adapter tests)
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-opencode-e2e-plugin-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** Create a real plugin fixture module and return its absolute path. */
async function makePluginFixture(baseDir: string, name: string, ext = '.ts'): Promise<string> {
  const filePath = path.join(baseDir, `${name}${ext}`);
  await fs.writeFile(
    filePath,
    `export const plugin = { name: '${name}', tag: 'source-fixture-${name}' };\n`,
  );
  return filePath;
}

const PASSING_VERDICT: Verdict = { ok: true };

/** Spy scanner that records the sources it was asked to scan. */
function makeSpyScanner(verdict: Verdict = PASSING_VERDICT): Scanner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    scan(source: string): Promise<Verdict> {
      calls.push(source);
      return Promise.resolve(verdict);
    },
  };
}

async function exists(p: string): Promise<boolean> {
  return fs.lstat(p).then(() => true).catch(() => false);
}

/** Store path for a plugin — always user-scope, sibling of the skills store. */
function pluginStorePath(env: Env, fileName: string): string {
  return path.join(path.dirname(resolveUserTargets(env).skillsDir), 'plugins', fileName);
}

const PLUGIN_ID = 'plugin:enforce-tests';
const PLUGIN_FILE = 'enforce-tests.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let cwd: string;
let fixturesDir: string;
let srcFile: string;
const pluginSource = (_e: AdapterEntry) => srcFile;

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
  // Project scope resolves targets under <cwd>/.opencode; keep it inside the
  // tmp home so everything is isolated and cleaned up together.
  cwd = tmp.dir;
  fixturesDir = path.join(tmp.dir, 'fixtures');
  await fs.mkdir(fixturesDir, { recursive: true });
  srcFile = await makePluginFixture(fixturesDir, 'enforce-tests');
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// User scope — full lifecycle through the real core engine + manifest
// ---------------------------------------------------------------------------

describe('opencode plugin e2e — user scope via core engine', () => {
  const entry: AdapterEntry = { id: PLUGIN_ID, nature: 'plugin', scope: 'user' };

  it(
    'check(missing) → apply → symlink resolves to stored module → check(present) '
      + '→ idempotent apply → remove → check(missing)',
    async () => {
      const targets = resolveUserTargets(env);
      const scanner = makeSpyScanner();
      const adapter = createOpencodeAdapter({ pluginSource, scanner });

      const target = path.join(resolveOpencodeUserTargets(env).pluginDir, PLUGIN_FILE);
      const store = pluginStorePath(env, PLUGIN_FILE);

      // 1. Audit before install: missing (exit code 3).
      const before = await check(adapter, [entry], 'user', env, targets.stateJson);
      expect(reportExitCode(before)).toBe(3);
      expect(before.entries[0]!.state).toBe('missing');
      expect(await exists(target)).toBe(false);

      // 2. Apply installs the module: the write targets the symlink path, and the
      //    security scanner is invoked through the engine path with the source.
      const applied = await apply(adapter, [entry], 'user', env, targets.stateJson);
      expect(applied.written).toContain(target);
      expect(scanner.calls).toEqual([srcFile]);

      // 3. The manifest records the install for the 'opencode' assistant.
      const manifestAfterApply = await readManifest(targets.stateJson);
      const recorded = findEntry(manifestAfterApply, PLUGIN_ID, 'user', 'opencode');
      expect(recorded).toBeDefined();
      expect(recorded!.nature).toBe('plugin');
      expect(recorded!.files).toContain(target);

      // 4. The target is a SYMLINK that resolves to the stored module, and the
      //    stored module carries the source content verbatim (store+symlink, not
      //    a phantom empty file).
      expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(target)).toBe(await fs.realpath(store));
      expect(await fs.readFile(store, 'utf-8')).toContain('source-fixture-enforce-tests');

      // 5. Audit after install: present (exit code 0).
      const after = await check(adapter, [entry], 'user', env, targets.stateJson);
      expect(reportExitCode(after)).toBe(0);
      expect(after.entries[0]!.state).toBe('present');

      // 6. Second apply is a no-op (idempotent): nothing written, scanner untouched.
      const applied2 = await apply(adapter, [entry], 'user', env, targets.stateJson);
      expect(applied2.written).toHaveLength(0);
      expect(scanner.calls).toEqual([srcFile]);

      // 7. Remove uninstalls: target + store gone, manifest entry cleared.
      const removed = await remove(adapter, [entry], 'user', env, targets.stateJson);
      expect(removed.removed).toContain(PLUGIN_ID);
      expect(await exists(target)).toBe(false);
      expect(await exists(store)).toBe(false);
      const manifestAfterRemove = await readManifest(targets.stateJson);
      expect(findEntry(manifestAfterRemove, PLUGIN_ID, 'user', 'opencode')).toBeUndefined();

      // 8. Audit after remove: missing again (exit code 3).
      const final = await check(adapter, [entry], 'user', env, targets.stateJson);
      expect(reportExitCode(final)).toBe(3);
      expect(final.entries[0]!.state).toBe('missing');
    },
  );

  it('remove leaves unrelated, user-authored files in pluginDir untouched', async () => {
    const targets = resolveUserTargets(env);
    const adapter = createOpencodeAdapter({ pluginSource, scanner: makeSpyScanner() });

    await apply(adapter, [entry], 'user', env, targets.stateJson);

    // A file the user hand-placed next to the managed plugin (its basename does
    // not collide with the managed plugin name).
    const pluginDir = resolveOpencodeUserTargets(env).pluginDir;
    const userOwned = path.join(pluginDir, 'user-authored.js');
    await fs.writeFile(userOwned, "export const mine = 'keep-me';\n");

    await remove(adapter, [entry], 'user', env, targets.stateJson);

    // The managed plugin is gone, the user's own file survives verbatim.
    expect(await exists(path.join(pluginDir, PLUGIN_FILE))).toBe(false);
    expect(await fs.readFile(userOwned, 'utf-8')).toContain('keep-me');
  });
});

// ---------------------------------------------------------------------------
// Project scope — full lifecycle through the real handlers (injected cwd)
// ---------------------------------------------------------------------------

describe('opencode plugin e2e — project scope via real handlers', () => {
  const entry: AdapterEntry = { id: PLUGIN_ID, nature: 'plugin', scope: 'project' };

  it(
    'audit(missing) → apply → symlink resolves to store → idempotent plan → '
      + 'remove → audit(missing)',
    async () => {
      const scanner = makeSpyScanner();
      const target = path.join(resolveOpencodeProjectTargets(cwd).pluginDir, PLUGIN_FILE);
      const store = pluginStorePath(env, PLUGIN_FILE);

      // 1. Missing before install.
      expect((await auditPlugin(entry, 'project', env, cwd)).state).toBe('missing');

      // 2. Plan → apply (real 'link' op handler + real scanner seam).
      const ops = await planPlugin(entry, 'project', env, pluginSource, cwd);
      expect(ops).toHaveLength(1);
      expect(ops[0]!.kind).toBe('link');
      await applySkill(ops, env, scanner);
      expect(scanner.calls).toEqual([srcFile]);

      // 3. Present, and the project target is a symlink resolving to the (user-
      //    scope) shared store carrying the source content.
      expect((await auditPlugin(entry, 'project', env, cwd)).state).toBe('present');
      expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(target)).toBe(await fs.realpath(store));
      expect(await fs.readFile(store, 'utf-8')).toContain('source-fixture-enforce-tests');

      // 4. Second plan is a no-op (idempotent).
      expect(await planPlugin(entry, 'project', env, pluginSource, cwd)).toHaveLength(0);

      // 5. Remove: offline plan discovers the installed file, unlink clears it.
      const removeOps = await planRemovePlugin(entry, 'project', env, cwd);
      expect(removeOps).toHaveLength(1);
      expect(removeOps[0]!.kind).toBe('unlink');
      await applyRemoveSkill(removeOps, env, cwd);

      // 6. Gone.
      expect((await auditPlugin(entry, 'project', env, cwd)).state).toBe('missing');
      expect(await exists(target)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// Shared store across scopes — removal must not strand a co-referenced install
// ---------------------------------------------------------------------------

describe('opencode plugin e2e — shared store co-reference', () => {
  const userEntry: AdapterEntry = { id: PLUGIN_ID, nature: 'plugin', scope: 'user' };
  const projectEntry: AdapterEntry = { id: PLUGIN_ID, nature: 'plugin', scope: 'project' };

  it(
    'removing the user-scope install does not strand the co-referenced '
      + 'project-scope install (shared store)',
    async () => {
      const scanner = makeSpyScanner();

      // Install the SAME plugin at both scopes. resolveStorePath is always
      // user-scope, so both installs point their symlink at the one shared store.
      const userOps = await planPlugin(userEntry, 'user', env, pluginSource);
      await applySkill(userOps, env, scanner);
      const projectOps = await planPlugin(projectEntry, 'project', env, pluginSource, cwd);
      await applySkill(projectOps, env, scanner);

      const store = pluginStorePath(env, PLUGIN_FILE);
      const userTarget = path.join(resolveOpencodeUserTargets(env).pluginDir, PLUGIN_FILE);
      const projectTarget = path.join(resolveOpencodeProjectTargets(cwd).pluginDir, PLUGIN_FILE);

      // Precondition: both scopes resolve to the very same store file.
      expect((userOps[0] as WriteOpLink).store).toBe((projectOps[0] as WriteOpLink).store);
      expect(await fs.realpath(userTarget)).toBe(await fs.realpath(store));
      expect(await fs.realpath(projectTarget)).toBe(await fs.realpath(store));

      // Remove ONLY the user-scope install.
      const removeOps = await planRemovePlugin(userEntry, 'user', env);
      await applyRemoveSkill(removeOps, env, cwd);

      // The user target is gone.
      expect(await exists(userTarget)).toBe(false);

      // CORRECT behaviour: the co-referenced project install is NOT stranded —
      // it still audits present AND its module content is still readable through
      // the symlink (i.e. the shared store was not deleted out from under it).
      expect((await auditPlugin(projectEntry, 'project', env, cwd)).state).toBe('present');
      expect(await exists(store)).toBe(true);
      expect(await fs.readFile(projectTarget, 'utf-8')).toContain('source-fixture-enforce-tests');
    },
  );
});
