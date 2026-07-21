/**
 * lib-nature-t13-f3-pose-audit.test.ts — Finding 3 (adversarial-close, R4):
 * the fail-closed AT THE POINT OF POSE plus the truthful audit of a copy.
 *
 * The pre-flight (assertSymlinkCapable, remote-install.ts) is a probe: it can
 * be skewed by a wrong-filesystem probe (F1) or miss a pruned cross-catalogue
 * lib (F2). Finding 3 closes those by construction — it stops trusting the
 * probe and verifies the REAL pose:
 *
 * F3a — POSE: an opencode plugin whose entry `requires` a lib is posed via
 *   applySkill's `link()` call. When that call falls back to a COPY (the host
 *   cannot symlink at the real target, even though a probe passed), applySkill
 *   throws SymlinkRequiredError. The engine's transactional rollback (ADR-0027)
 *   then undoes the whole run: nothing is left posed in copy, the materialised
 *   lib dir is rm'd, and the manifest is never persisted. The copy fallback
 *   stays STRICTLY intact for any link op WITHOUT the requiresSymlink flag.
 *
 * F3b — AUDIT: auditPlugin detects a plain-copy target where the entry requires
 *   a lib and reports it non-`present` (broken, repairable) so `check` (and any
 *   audit path enriching requires from the manifest) surfaces it. A copy of a
 *   lib-FREE plugin stays `present` — copy-fallback is legitimate there.
 *
 * The `linkSymlink` seam threaded to createOpencodeAdapter feeds ONLY the real
 * `link()` pose (never the pre-flight probe), so these tests force the copy
 * fallback deterministically on a CI host that actually supports symlinks.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply, check } from '@agent-rigger/core/engine';
import { findEntry, readManifest, writeManifest } from '@agent-rigger/core/manifest';
import { libsDir, resolveOpencodeUserTargets, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';
import type { LibMaterialization, ManifestEntry, WriteOpLink } from '@agent-rigger/core/types';

import { createOpencodeAdapter } from '../../src/opencode/adapter';
import { auditPlugin } from '../../src/opencode/plugins';
import { applySkill, SymlinkRequiredError } from '../../src/opencode/skills';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  env: Env;
  dir: string;
  fixturesDir: string;
  manifestPath: string;
  cleanup: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t13-f3-'));
  const env: Env = { RIGGER_HOME: dir };
  await fs.mkdir(path.join(dir, '.config', 'agent-rigger'), { recursive: true });
  const fixturesDir = path.join(dir, 'fixtures');
  await fs.mkdir(fixturesDir, { recursive: true });
  return {
    env,
    dir,
    fixturesDir,
    manifestPath: resolveUserTargets(env).stateJson,
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

/** A plugin source module on disk; returns its absolute path. */
async function makePluginModule(baseDir: string, name: string): Promise<string> {
  const file = path.join(baseDir, `${name}.ts`);
  await fs.writeFile(
    file,
    `import { rule } from '../libs/rules-common/rules';\nexport const plugin = { rule };\n`,
    'utf8',
  );
  return file;
}

/** A lib source directory on disk; returns its absolute path. */
async function makeLibSource(baseDir: string, name: string): Promise<string> {
  const src = path.join(baseDir, `lib-${name}`);
  await fs.mkdir(src, { recursive: true });
  await fs.writeFile(path.join(src, 'rules.ts'), 'export const rule = 1;\n', 'utf8');
  return src;
}

/** A symlink implementation that always rejects — forces linkOrCopy's copy fallback. */
function failingSymlink(): (target: string, dest: string) => Promise<void> {
  return () => Promise.reject(new Error('ENOSYS: symlink not supported on this host'));
}

function pluginStorePath(env: Env, fileName: string): string {
  return path.join(path.dirname(resolveUserTargets(env).skillsDir), 'plugins', fileName);
}

function pluginTargetPath(env: Env, fileName: string): string {
  return path.join(resolveOpencodeUserTargets(env).pluginDir, fileName);
}

/** Pose a plain-copy plugin file (no symlink) at the opencode user pluginDir. */
async function poseCopy(
  env: Env,
  name: string,
  content = 'export const plugin = {};\n',
): Promise<void> {
  const targetDir = resolveOpencodeUserTargets(env).pluginDir;
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(path.join(targetDir, `${name}.ts`), content, 'utf8');
}

const LIB_ID = 'principal/lib:rules-common';

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.cleanup();
});

// ---------------------------------------------------------------------------
// F3a — pose fail-closed via the engine's transactional apply
// ---------------------------------------------------------------------------

describe('F3a — pose forcée en copie of a requires-lib plugin fails closed with full rollback', () => {
  it('throws SymlinkRequiredError and rolls the whole run back (nothing in copy, lib dir gone, manifest intact)', async () => {
    const srcModule = await makePluginModule(h.fixturesDir, 'guard');
    const libSource = await makeLibSource(h.fixturesDir, 'rules-common');
    const adapter = createOpencodeAdapter({
      pluginSource: () => srcModule,
      scanner: stubScanner,
      linkSymlink: failingSymlink(),
    });

    const entry: AdapterEntry = {
      id: 'principal/plugin:guard',
      nature: 'plugin',
      scope: 'user',
      requires: [LIB_ID],
    };
    const libs: LibMaterialization[] = [
      { id: LIB_ID, name: 'rules-common', source: libSource, requires: [] },
    ];

    await expect(
      apply({
        adapter,
        entries: [entry],
        scope: 'user',
        env: h.env,
        manifestPath: h.manifestPath,
        versionFor: () => ({ ref: 'v1.0.0', sha: 'deadbeef' }),
        libs,
      }),
    ).rejects.toBeInstanceOf(SymlinkRequiredError);

    // Nothing left posed in copy — target and store both absent.
    expect(await fs.stat(pluginTargetPath(h.env, 'guard.ts')).catch(() => null)).toBeNull();
    expect(await fs.stat(pluginStorePath(h.env, 'guard.ts')).catch(() => null)).toBeNull();

    // The materialised lib dir was rolled back (engine createdDirs layer).
    expect(await fs.stat(path.join(libsDir(h.env), 'rules-common')).catch(() => null)).toBeNull();

    // Manifest never persisted — no entry for the plugin nor the lib.
    const manifest = await readManifest(h.manifestPath);
    expect(manifest.artifacts).toHaveLength(0);
  });

  it('same seam, a plugin WITHOUT a lib requirement installs fine (copy fallback strictly intact)', async () => {
    const srcModule = await makePluginModule(h.fixturesDir, 'plain');
    const adapter = createOpencodeAdapter({
      pluginSource: () => srcModule,
      scanner: stubScanner,
      linkSymlink: failingSymlink(),
    });

    const entry: AdapterEntry = {
      id: 'principal/plugin:plain',
      nature: 'plugin',
      scope: 'user',
      requires: [],
    };

    await apply({
      adapter,
      entries: [entry],
      scope: 'user',
      env: h.env,
      manifestPath: h.manifestPath,
      versionFor: () => ({ ref: 'v1.0.0', sha: 'deadbeef' }),
    });

    // The copy fallback posed the plugin as a plain file — install succeeded.
    const target = pluginTargetPath(h.env, 'plain.ts');
    const stat = await fs.lstat(target).catch(() => null);
    expect(stat).not.toBeNull();
    expect(stat?.isSymbolicLink()).toBe(false);

    const manifest = await readManifest(h.manifestPath);
    expect(findEntry(manifest, 'principal/plugin:plain', 'user', 'opencode')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// F3a — applySkill unit: the method-check + cleanup live at the pose seam
// ---------------------------------------------------------------------------

describe('F3a — applySkill enforces requiresSymlink at the real pose', () => {
  it('throws and cleans up (target + store removed) when a requiresSymlink op falls back to copy', async () => {
    const source = await makePluginModule(h.fixturesDir, 'guard');
    const store = pluginStorePath(h.env, 'guard.ts');
    const target = pluginTargetPath(h.env, 'guard.ts');
    const op: WriteOpLink = { kind: 'link', source, store, target, requiresSymlink: true };

    await expect(
      applySkill([op], h.env, stubScanner, { symlink: failingSymlink() }),
    ).rejects.toBeInstanceOf(SymlinkRequiredError);

    // The just-posed copy AND its store were undone by applySkill itself
    // (the engine records a link compensation only after apply RETURNS).
    expect(await fs.stat(target).catch(() => null)).toBeNull();
    expect(await fs.stat(store).catch(() => null)).toBeNull();
  });

  it('leaves the copy fallback untouched for a link op without requiresSymlink', async () => {
    const source = await makePluginModule(h.fixturesDir, 'plain');
    const store = pluginStorePath(h.env, 'plain.ts');
    const target = pluginTargetPath(h.env, 'plain.ts');
    const op: WriteOpLink = { kind: 'link', source, store, target };

    await applySkill([op], h.env, stubScanner, { symlink: failingSymlink() });

    const stat = await fs.lstat(target).catch(() => null);
    expect(stat).not.toBeNull();
    expect(stat?.isSymbolicLink()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F3b — auditPlugin: a copy where a lib is required is not `present`
// ---------------------------------------------------------------------------

describe('F3b — auditPlugin flags a copy-installed requires-lib plugin as broken', () => {
  it('returns a non-present state for a copy target when the entry requires a lib', async () => {
    await poseCopy(h.env, 'guard');
    const entry: AdapterEntry = {
      id: 'principal/plugin:guard',
      nature: 'plugin',
      scope: 'user',
      requires: [LIB_ID],
    };

    const report = await auditPlugin(entry, 'user', h.env);

    expect(report.state).not.toBe('present');
    expect(report.detail).toMatch(/lib/i);
  });

  it('keeps a copy of a lib-FREE plugin present (copy fallback is legitimate there)', async () => {
    await poseCopy(h.env, 'plain');
    const entry: AdapterEntry = {
      id: 'principal/plugin:plain',
      nature: 'plugin',
      scope: 'user',
      requires: [],
    };

    const report = await auditPlugin(entry, 'user', h.env);

    expect(report.state).toBe('present');
  });

  it('is visible from check() — enriched with the manifest requires edge', async () => {
    // A plugin copy-installed by a pre-fix rigger: a copy on disk + a manifest
    // entry that records the lib requirement, but no symlink.
    const targetDir = resolveOpencodeUserTargets(h.env).pluginDir;
    await fs.mkdir(targetDir, { recursive: true });
    const target = path.join(targetDir, 'guard.ts');
    await fs.writeFile(target, 'export const plugin = {};\n', 'utf8');

    await writeManifest(h.manifestPath, {
      version: 1,
      artifacts: [
        {
          id: 'principal/plugin:guard',
          nature: 'plugin',
          ref: 'v1.0.0',
          sha: 'deadbeef',
          scope: 'user',
          installedAt: new Date().toISOString(),
          files: [target],
          assistant: 'opencode',
          requires: [LIB_ID],
        } satisfies ManifestEntry,
      ],
    });

    const adapter = createOpencodeAdapter({ pluginSource: () => target, scanner: stubScanner });
    // The CLI builds check entries from the catalog, carrying no requires — the
    // engine's enrichWithApplied must backfill it from the manifest.
    const catalogEntry: AdapterEntry = {
      id: 'principal/plugin:guard',
      nature: 'plugin',
      scope: 'user',
    };

    const report = await check(adapter, [catalogEntry], 'user', h.env, h.manifestPath);

    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]!.state).not.toBe('present');
  });
});
