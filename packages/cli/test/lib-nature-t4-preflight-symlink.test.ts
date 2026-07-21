/**
 * lib-nature-t4-preflight-symlink.test.ts — R4 (lib-nature T4): the CLI
 * pre-flight that refuses an install BEFORE any write when the host cannot
 * create symlinks and the resolved selection contains an opencode plugin
 * whose `requires` include a lib (D4, design.md § Surfaces de cycle de vie).
 *
 * Harness combines the opencode plugin + plugins/ layout of
 * h13-plugin-scan.test.ts, the hook + hooks/ layout of r27-hook-scan.test.ts,
 * and the lib fixture (common/libs/<name> + requires) of
 * lib-nature-t3-e2e.test.ts.
 *
 * The `symlink` option threaded to runRemoteInstall feeds ONLY the R4
 * pre-flight probe (probeSymlinkSupport, core/linker.ts) — it never reaches
 * the real per-artefact linkOrCopy call inside the adapter, which is
 * untouched by this change. On a test host that actually supports symlinks
 * (CI), the real per-artefact writes below still use a real symlink; what
 * these tests verify is the GATE's behaviour (probed or not, blocked or not),
 * not the linkOrCopy fallback itself (already covered by core/test/linker.test.ts).
 *
 * Scenarios
 * ---------
 * 1. Refus pré-flight — opencode plugin + requires-lib, no-symlink host:
 *    SymlinkUnavailableError, thrown before any write (store/target/lib/manifest).
 * 2. Fallback préservé hors dépendants — a lib-free skill install on the same
 *    no-symlink host never calls the probe at all (scope proof, by call count).
 * 3. Hooks Claude non concernés — a claude hook requiring a lib never calls
 *    the probe (hooks are always copied into the scriptStore, never symlinked).
 * 4. Update — a canonical, constructible vector: an opencode plugin already
 *    installed (copy, pre-lib catalogue), the catalogue bump ADDS a lib
 *    requirement, host still cannot symlink → runUpdate refuses BEFORE
 *    remove() runs (never destroys the old copy with nothing safely
 *    re-posed in its place — assertSymlinkCapable, shared with install).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type CatalogEntry, type TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { findEntry, readManifest, writeManifest } from '@agent-rigger/core/manifest';
import { libsDir, resolveOpencodeUserTargets, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';
import type { ManifestEntry } from '@agent-rigger/core/types';

import { hookScriptStorePath } from '../src/adapter-builder';
import { runUpdate } from '../src/cmd-update';
import { runRemoteInstall, SymlinkUnavailableError } from '../src/remote-install';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TAG_NAME = 'v1.0.0';
const SHA = 'aabbccddeeff00112233445566778899aabbccdd';
const CATALOG_URL = 'https://example.com/principal.git';

// ---------------------------------------------------------------------------
// Catalog fixtures
// ---------------------------------------------------------------------------

const LIB_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'lib:rules-common',
  nature: 'lib',
  scopes: ['user'],
} as CatalogEntry;

const OPENCODE_PLUGIN_WITH_LIB: CatalogEntry = {
  kind: 'artifact',
  id: 'plugin:guard',
  nature: 'plugin',
  targets: ['opencode'],
  scopes: ['user', 'project'],
  requires: ['lib:rules-common'],
};

const SKILL_NO_LIB: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:hello',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user'],
};

const HOOK_WITH_LIB: CatalogEntry = {
  kind: 'artifact',
  id: 'hook:guard-command',
  nature: 'hook',
  targets: ['claude'],
  scopes: ['user'],
  event: 'PreToolUse',
  matcher: 'Bash',
  requires: ['lib:rules-common'],
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeRunner(): CommandRunner {
  return (_cmd, args) => {
    const argv = args ?? [];
    if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${SHA}\trefs/tags/${TAG_NAME}\n`,
        stderr: '',
      });
    }
    if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\tHEAD\n`, stderr: '' });
    }
    if (argv[0] === 'clone') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };
}

interface Harness {
  env: Env;
  contentDir: string;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  manifestPath: string;
  cleanupAll: () => Promise<void>;
}

async function makeHarness(entries: CatalogEntry[]): Promise<Harness> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t4-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t4-content-'));

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 'principal' }, entries }),
    'utf8',
  );

  // plugins/ — opencode plugin module (scanPathFor('plugin') whole dir).
  await fs.mkdir(path.join(contentDir, 'opencode', 'plugins'), { recursive: true });
  await fs.writeFile(
    path.join(contentDir, 'opencode', 'plugins', 'guard.ts'),
    '// opencode guard plugin\nexport const GuardPlugin = async () => ({});\n',
    'utf8',
  );

  // common/libs/<name> — lib checkout position (T1, scanPathFor('lib')).
  await fs.mkdir(path.join(contentDir, 'common', 'libs', 'rules-common'), { recursive: true });
  await fs.writeFile(
    path.join(contentDir, 'common', 'libs', 'rules-common', 'rules.ts'),
    'export const rule = 1;\n',
    'utf8',
  );

  // skills/<name> — plain skill checkout position.
  await fs.mkdir(path.join(contentDir, 'common', 'skills', 'hello'), { recursive: true });
  await fs.writeFile(
    path.join(contentDir, 'common', 'skills', 'hello', 'SKILL.md'),
    '# hello\n',
    'utf8',
  );

  // hooks/ — whole dir, scriptSource for the hook adapter.
  await fs.mkdir(path.join(contentDir, 'claude', 'hooks'), { recursive: true });
  await fs.writeFile(
    path.join(contentDir, 'claude', 'hooks', 'guard-command.ts'),
    '// guard-command hook\n',
    'utf8',
  );

  await fs.mkdir(path.join(homeDir, '.config', 'agent-rigger'), { recursive: true });

  const env: Env = { RIGGER_HOME: homeDir };
  const manifestPath = resolveUserTargets(env).stateJson;

  const cleanupAll = async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(contentDir, { recursive: true, force: true });
  };

  return {
    env,
    contentDir,
    runner: makeRunner(),
    tmpFactory: async () => ({ path: contentDir, cleanup: async () => {} }),
    manifestPath,
    cleanupAll,
  };
}

/**
 * Injectable `symlink` implementation that always rejects — simulates a host
 * without symlink support for the R4 pre-flight probe. Tracks how many times
 * it was invoked so scenarios 2/3 can assert the probe was never consulted
 * (the gate's scope, not merely the install's success).
 */
function noSymlinkHost(): {
  symlink: (target: string, dest: string) => Promise<void>;
  callCount: () => number;
} {
  let calls = 0;
  return {
    symlink: (_target: string, _dest: string) => {
      calls += 1;
      return Promise.reject(new Error('ENOSYS: symlink not supported on this host'));
    },
    callCount: () => calls,
  };
}

// ---------------------------------------------------------------------------
// Scenario 1 — refus pré-flight
// ---------------------------------------------------------------------------

describe('R4 scenario 1 — opencode plugin + requires-lib, no symlink support → refused', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness([LIB_ENTRY, OPENCODE_PLUGIN_WITH_LIB]);
  });

  afterEach(async () => {
    await h.cleanupAll();
  });

  it('throws SymlinkUnavailableError', async () => {
    const noSymlink = noSymlinkHost();

    await expect(
      runRemoteInstall({
        ids: ['principal/plugin:guard'],
        catalogUrl: CATALOG_URL,
        scope: 'user',
        env: h.env,
        manifestPath: h.manifestPath,
        runner: h.runner,
        tmpFactory: h.tmpFactory,
        confirm: true,
        assistant: 'opencode',
        scanner: stubScanner,
        sourceName: 'principal',
        symlink: noSymlink.symlink,
      }),
    ).rejects.toBeInstanceOf(SymlinkUnavailableError);
  });

  it('names the blocking plugin and its lib dependency, with a platform-appropriate remediation hint', async () => {
    const noSymlink = noSymlinkHost();
    let caught: unknown;
    try {
      await runRemoteInstall({
        ids: ['principal/plugin:guard'],
        catalogUrl: CATALOG_URL,
        scope: 'user',
        env: h.env,
        manifestPath: h.manifestPath,
        runner: h.runner,
        tmpFactory: h.tmpFactory,
        confirm: true,
        assistant: 'opencode',
        scanner: stubScanner,
        sourceName: 'principal',
        symlink: noSymlink.symlink,
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(SymlinkUnavailableError);
    const err = caught as SymlinkUnavailableError;
    expect(err.pluginId).toBe('principal/plugin:guard');
    expect(err.libId).toBe('principal/lib:rules-common');
    expect(err.message).toMatch(/symlink/i);
    // The remediation hint is platform-conditional (adversarial-close finding 5):
    // Developer Mode / W1 on Windows, a generic cause + `rigger doctor` elsewhere.
    if (process.platform === 'win32') {
      expect(err.message).toMatch(/Developer Mode/);
      expect(err.message).toMatch(/W1/);
    } else {
      expect(err.message).toMatch(/rigger doctor/);
      expect(err.message).not.toMatch(/Developer Mode/);
    }
  });

  it('writes NOTHING before throwing — plugin store, plugin target, lib dir, and manifest all stay absent/empty', async () => {
    const noSymlink = noSymlinkHost();

    await runRemoteInstall({
      ids: ['principal/plugin:guard'],
      catalogUrl: CATALOG_URL,
      scope: 'user',
      env: h.env,
      manifestPath: h.manifestPath,
      runner: h.runner,
      tmpFactory: h.tmpFactory,
      confirm: true,
      assistant: 'opencode',
      scanner: stubScanner,
      sourceName: 'principal',
      symlink: noSymlink.symlink,
    }).catch(() => {});

    // Plugin store (~/.config/agent-rigger/plugins/) never created.
    const skillsDir = resolveUserTargets(h.env).skillsDir;
    const pluginStoreDir = path.join(path.dirname(skillsDir), 'plugins');
    expect(await fs.stat(pluginStoreDir).catch(() => null)).toBeNull();

    // Plugin target (~/.config/opencode/plugin/) never created.
    const pluginTargetDir = resolveOpencodeUserTargets(h.env).pluginDir;
    expect(await fs.stat(path.join(pluginTargetDir, 'guard.ts')).catch(() => null)).toBeNull();

    // Lib store (~/.config/agent-rigger/libs/rules-common) never created.
    expect(await fs.stat(path.join(libsDir(h.env), 'rules-common')).catch(() => null)).toBeNull();

    // Manifest never written to (findEntry over an empty/absent manifest).
    const manifest = await readManifest(h.manifestPath);
    expect(manifest.artifacts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — fallback copie préservé hors dépendants de lib
// ---------------------------------------------------------------------------

describe('R4 scenario 2 — a lib-free skill is never gated by the pre-flight', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness([LIB_ENTRY, SKILL_NO_LIB]);
  });

  afterEach(async () => {
    await h.cleanupAll();
  });

  it('never probes the symlink seam and installs normally on the same no-symlink host', async () => {
    const noSymlink = noSymlinkHost();

    const result = await runRemoteInstall({
      ids: ['principal/skill:hello'],
      catalogUrl: CATALOG_URL,
      scope: 'user',
      env: h.env,
      manifestPath: h.manifestPath,
      runner: h.runner,
      tmpFactory: h.tmpFactory,
      confirm: true,
      assistant: 'claude',
      scanner: stubScanner,
      sourceName: 'principal',
      symlink: noSymlink.symlink,
    });

    // R4 is scoped to "opencode plugin + requires-lib" (design.md § portée
    // honnête) — a skill with no lib dependency never reaches the probe: the
    // pre-existing linkOrCopy mechanism (already covered, unchanged, by
    // core/test/linker.test.ts) is untouched by this gate. Proven at the
    // mechanism level (zero probe calls), not merely by the install succeeding.
    expect(noSymlink.callCount()).toBe(0);
    expect(result.applied).toBe(true);

    const manifest = await readManifest(h.manifestPath);
    expect(findEntry(manifest, 'principal/skill:hello', 'user', 'claude')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — hooks Claude non concernés
// ---------------------------------------------------------------------------

describe('R4 scenario 3 — a claude hook requiring a lib is never gated by the pre-flight', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness([LIB_ENTRY, HOOK_WITH_LIB]);
  });

  afterEach(async () => {
    await h.cleanupAll();
  });

  it('installs without ever probing the symlink seam — hooks are copied, never symlinked', async () => {
    const noSymlink = noSymlinkHost();

    const result = await runRemoteInstall({
      ids: ['principal/hook:guard-command'],
      catalogUrl: CATALOG_URL,
      scope: 'user',
      env: h.env,
      manifestPath: h.manifestPath,
      runner: h.runner,
      tmpFactory: h.tmpFactory,
      confirm: true,
      assistant: 'claude',
      scanner: stubScanner,
      sourceName: 'principal',
      symlink: noSymlink.symlink,
    });

    // The gate only ever looks at nature === 'plugin' — a hook never reaches
    // it, regardless of its requires. Zero probe calls proves the vector
    // never applies here, not merely that the install happened to succeed.
    expect(noSymlink.callCount()).toBe(0);
    expect(result.applied).toBe(true);

    // The hook script landed in the scriptStore (copy, adapter-builder.ts's
    // scriptSource/scriptStore) AND the lib was materialised (engine's
    // parallel channel) — real siblings under the config dir, import
    // resolvable without any link at all.
    const scriptStore = hookScriptStorePath(h.env);
    expect(
      await fs.stat(path.join(scriptStore, 'guard-command.ts')).catch(() => null),
    ).not.toBeNull();
    expect(
      await fs.stat(path.join(libsDir(h.env), 'rules-common')).catch(() => null),
    ).not.toBeNull();

    const manifest = await readManifest(h.manifestPath);
    const hookEntry = findEntry(manifest, 'principal/hook:guard-command', 'user', 'claude');
    expect(hookEntry?.requires).toEqual(['principal/lib:rules-common']);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — update: refuse BEFORE remove() destroys the old copy
// ---------------------------------------------------------------------------

describe('R4 scenario 4 — update: a catalogue bump adding a lib requirement refuses before remove()', () => {
  let h: Harness;
  let storeFile: string;
  let targetFile: string;
  const OLD_SHA = 'oldoldoldoldoldoldoldoldoldoldoldoldold0';
  const ORIGINAL_CONTENT = '// opencode guard plugin — pre-bump copy-installed content\n';

  beforeEach(async () => {
    // The "bumped" catalogue: plugin:guard now requires lib:rules-common —
    // this is the checkout runUpdate resolves against.
    h = await makeHarness([LIB_ENTRY, OPENCODE_PLUGIN_WITH_LIB]);

    // Simulate a plugin already installed BEFORE the bump (copy-fallback, no
    // requires yet) — real files on disk + a manifest entry with an older
    // ref/sha than TAG_NAME/SHA so runUpdate classifies it as stale.
    const skillsDir = resolveUserTargets(h.env).skillsDir;
    const pluginStoreDir = path.join(path.dirname(skillsDir), 'plugins');
    await fs.mkdir(pluginStoreDir, { recursive: true });
    storeFile = path.join(pluginStoreDir, 'guard.ts');
    await fs.writeFile(storeFile, ORIGINAL_CONTENT, 'utf8');

    const pluginTargetDir = resolveOpencodeUserTargets(h.env).pluginDir;
    await fs.mkdir(pluginTargetDir, { recursive: true });
    targetFile = path.join(pluginTargetDir, 'guard.ts');
    await fs.writeFile(targetFile, ORIGINAL_CONTENT, 'utf8');

    await writeManifest(h.manifestPath, {
      version: 1,
      artifacts: [
        {
          id: 'principal/plugin:guard',
          nature: 'plugin',
          ref: 'v0.9.0',
          sha: OLD_SHA,
          scope: 'user',
          installedAt: new Date().toISOString(),
          files: [storeFile, targetFile],
          assistant: 'opencode',
        } satisfies ManifestEntry,
      ],
    });
  });

  afterEach(async () => {
    await h.cleanupAll();
  });

  it('runUpdate throws SymlinkUnavailableError on a no-symlink host', async () => {
    const noSymlink = noSymlinkHost();

    await expect(
      runUpdate({
        ids: ['principal/plugin:guard'],
        scope: 'user',
        env: h.env,
        manifestPath: h.manifestPath,
        catalogUrl: CATALOG_URL,
        runner: h.runner,
        tmpFactory: h.tmpFactory,
        confirm: true,
        scanner: stubScanner,
        assistant: 'opencode',
        symlink: noSymlink.symlink,
      }),
    ).rejects.toBeInstanceOf(SymlinkUnavailableError);
  });

  it('never calls remove() first: the OLD copy on disk and its manifest entry are both untouched', async () => {
    const noSymlink = noSymlinkHost();

    await runUpdate({
      ids: ['principal/plugin:guard'],
      scope: 'user',
      env: h.env,
      manifestPath: h.manifestPath,
      catalogUrl: CATALOG_URL,
      runner: h.runner,
      tmpFactory: h.tmpFactory,
      confirm: true,
      scanner: stubScanner,
      assistant: 'opencode',
      symlink: noSymlink.symlink,
    }).catch(() => {});

    // Manifest entry unchanged — a real remove() would delete it (and a
    // successful re-apply would bump ref/sha); either way, seeing the OLD
    // ref/sha survive proves remove() was never reached.
    const manifest = await readManifest(h.manifestPath);
    const entry = findEntry(manifest, 'principal/plugin:guard', 'user', 'opencode');
    expect(entry).toBeDefined();
    expect(entry?.ref).toBe('v0.9.0');
    expect(entry?.sha).toBe(OLD_SHA);

    // The old copy is still on disk, byte-for-byte — remove() never deleted
    // it, so the plugin is never left destroyed with nothing re-posed.
    expect(await fs.readFile(storeFile, 'utf8')).toBe(ORIGINAL_CONTENT);
    expect(await fs.readFile(targetFile, 'utf8')).toBe(ORIGINAL_CONTENT);

    // The lib was never materialised either (apply()'s parallel channel never ran).
    expect(await fs.stat(path.join(libsDir(h.env), 'rules-common')).catch(() => null)).toBeNull();
  });
});
