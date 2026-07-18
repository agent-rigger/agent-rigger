/**
 * h13-plugin-scan.test.ts — Prove that opencode plugin modules are scanned (H13).
 *
 * An opencode plugin is a native JS/TS module shipped in the checkout's
 * plugins/ directory and copied verbatim into pluginDir (ADR-0020 §4, R8.2) —
 * executable code loaded by opencode at runtime. The pre-apply scan gate
 * (scanEntries / scanPathFor) must therefore cover nature 'plugin' exactly
 * like it covers skills/agents/hooks (uniform scan, ADR-0015 §3, R10.5/R27.1).
 *
 * Strategy
 * --------
 * All tests use injected runners + tmp dirs (no real network, no real git),
 * mirroring remote-install-assistant.test.ts: tmpFactory returns a pre-built
 * "checkout" dir directly, a fake CommandRunner answers ls-remote/clone/rev-parse.
 *
 * Scenarios
 * ---------
 * H13-1  scanPathFor unit tests:
 *        - opencode-targeted plugin → plugins/ directory of the checkout.
 *        - claude-only plugin → null (delegate-first, ADR-0003: the module is
 *          NOT in the checkout; `claude plugin install` owns the content).
 *        - dual-target plugin → plugins/ directory (a module IS in the checkout).
 *
 * H13-2  scanEntries:
 *        - blocking scanner + opencode plugin entry → ScanBlockedError.
 *        - two opencode plugin entries → scanner called for catalog.json (always)
 *          + plugins/ once (deduplication).
 *        - claude-only plugin entry → only catalog.json is scanned (nothing else
 *          in checkout for that entry).
 *
 * H13-3  runRemoteInstall + blocking scanner, no --force
 *        → ScanBlockedError, no module in pluginDir, no store file, no manifest.
 *        Proves: the block happens BEFORE any write.
 *
 * H13-4  runRemoteInstall + spy scanner (clean)
 *        → scanner IS called with the checkout's plugins/ directory, install
 *          completes, module present in pluginDir.
 *
 * H13-5  runRemoteInstall + blocking scanner, with --force
 *        → warning emitted, install proceeds.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type CatalogEntry, type TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { findEntry, readManifest } from '@agent-rigger/core/manifest';
import { resolveOpencodeUserTargets, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { Scanner } from '@agent-rigger/core/scan';

import { runRemoteInstall, ScanBlockedError, scanEntries } from '../src/remote-install';
import { scanPathFor } from '../src/scan-paths';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TAG_NAME = 'v1.0.0';
const SHA = 'aabbccddeeff00112233445566778899aabbccdd';
const CATALOG_URL = 'https://example.com/content-repo.git';

// ---------------------------------------------------------------------------
// Catalog fixtures
// ---------------------------------------------------------------------------

const OPENCODE_PLUGIN_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'plugin:guard',
  nature: 'plugin',
  targets: ['opencode'],
  scopes: ['user', 'project'],
};

const OPENCODE_PLUGIN_ENTRY_2: CatalogEntry = {
  kind: 'artifact',
  id: 'plugin:audit',
  nature: 'plugin',
  targets: ['opencode'],
  scopes: ['user', 'project'],
};

const CLAUDE_PLUGIN_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'plugin:demo-plugin',
  nature: 'plugin',
  targets: ['claude'],
  scopes: ['user'],
};

// ---------------------------------------------------------------------------
// Fake scanner builders
// ---------------------------------------------------------------------------

/** Scanner that always blocks with the given findings. */
function blockingScanner(findings: string[] = ['secret exfiltration in plugin module']): Scanner {
  return { scan: () => Promise.resolve({ ok: false, findings }) };
}

/** Sorted rel-paths of every leaf under `root` (symlinks are leaves, not followed). */
async function walkTree(root: string, dir: string = root): Promise<string[]> {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const d of dirents) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) {
      out.push(...(await walkTree(root, full)));
    } else {
      out.push(path.relative(root, full));
    }
  }
  return out.sort();
}

/**
 * Scanner that records each scanned source AND walks its tree at scan time —
 * before scanEntries tears the staging mirror down in its `finally`. `trees[i]`
 * is the sorted rel-path listing of the i-th scanned dir (the union surface).
 * The union is scanned once, so a healthy run has calls.length === 1.
 */
function spyScanner(): { scanner: Scanner; calls: string[]; trees: string[][] } {
  const calls: string[] = [];
  const trees: string[][] = [];
  const scanner: Scanner = {
    scan: async (source: string) => {
      calls.push(source);
      trees.push(await walkTree(source));
      return { ok: true };
    },
  };
  return { scanner, calls, trees };
}

// ---------------------------------------------------------------------------
// makePluginEnv — isolated HOME + content dir with plugins/ layout
// ---------------------------------------------------------------------------

interface PluginEnv {
  env: Env;
  homeDir: string;
  contentDir: string;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  manifestPath: string;
  cleanupAll: () => Promise<void>;
}

async function makePluginEnv(entries: CatalogEntry[]): Promise<PluginEnv> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-h13-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-h13-content-'));

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 'h13-test-catalog' }, entries }),
    'utf8',
  );

  // Populate plugins/ directory with the native opencode modules.
  const pluginsDir = path.join(contentDir, 'plugins');
  await fs.mkdir(pluginsDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginsDir, 'guard.ts'),
    '// opencode guard plugin\nexport const GuardPlugin = async () => ({});\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(pluginsDir, 'audit.ts'),
    '// opencode audit plugin\nexport const AuditPlugin = async () => ({});\n',
    'utf8',
  );

  const env: Env = { RIGGER_HOME: homeDir };
  const manifestPath = path.join(homeDir, '.config', 'agent-rigger', 'state.json');

  const runner: CommandRunner = (_cmd, args) => {
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
    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };

  const tmpFactory: TmpDirFactory = async () => ({ path: contentDir, cleanup: async () => {} });

  const cleanupAll = async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(contentDir, { recursive: true, force: true });
  };

  return { env, homeDir, contentDir, runner, tmpFactory, manifestPath, cleanupAll };
}

/** Shorthand: run a remote opencode install of plugin:guard. */
function installGuardPlugin(
  fixture: PluginEnv,
  scanner: Scanner,
  force?: boolean,
): ReturnType<typeof runRemoteInstall> {
  const base = {
    ids: ['plugin:guard'],
    catalogUrl: CATALOG_URL,
    scope: 'user' as const,
    env: fixture.env,
    manifestPath: fixture.manifestPath,
    runner: fixture.runner,
    tmpFactory: fixture.tmpFactory,
    confirm: true,
    assistant: 'opencode' as const,
    scanner,
  };
  return force === undefined
    ? runRemoteInstall(base)
    : runRemoteInstall({ ...base, force });
}

// ---------------------------------------------------------------------------
// H13-1 — Unit: scanPathFor for plugin nature
// ---------------------------------------------------------------------------

describe('H13-1 — scanPathFor: plugin nature', () => {
  it('returns the plugins/ directory for an opencode-targeted plugin', () => {
    const baseDir = '/tmp/checkout';
    expect(scanPathFor(OPENCODE_PLUGIN_ENTRY, baseDir)).toBe(path.join(baseDir, 'plugins'));
  });

  it('returns the same plugins/ dir regardless of which plugin id is scanned', () => {
    const baseDir = '/tmp/checkout';
    expect(scanPathFor(OPENCODE_PLUGIN_ENTRY, baseDir)).toBe(
      scanPathFor(OPENCODE_PLUGIN_ENTRY_2, baseDir),
    );
  });

  it('returns null for a claude-only plugin (delegate-first: no module in checkout)', () => {
    expect(scanPathFor(CLAUDE_PLUGIN_ENTRY, '/tmp/checkout')).toBeNull();
  });

  it('returns the plugins/ directory for a dual-target plugin', () => {
    const baseDir = '/tmp/checkout';
    const dualEntry: CatalogEntry = {
      kind: 'artifact',
      id: 'plugin:both',
      nature: 'plugin',
      targets: ['claude', 'opencode'],
      scopes: ['user'],
    };
    expect(scanPathFor(dualEntry, baseDir)).toBe(path.join(baseDir, 'plugins'));
  });

  it('strips the source qualifier before deciding (qualified opencode plugin id)', () => {
    const baseDir = '/tmp/checkout';
    const qualified: CatalogEntry = { ...OPENCODE_PLUGIN_ENTRY, id: 'principal/plugin:guard' };
    expect(scanPathFor(qualified, baseDir)).toBe(path.join(baseDir, 'plugins'));
  });
});

// ---------------------------------------------------------------------------
// H13-2 — scanEntries: blocking, deduplication, claude-only skip
// ---------------------------------------------------------------------------

describe('H13-2 — scanEntries: plugin entries', () => {
  it('throws ScanBlockedError for an opencode plugin when the scanner blocks', async () => {
    await expect(
      scanEntries({
        entries: [OPENCODE_PLUGIN_ENTRY],
        baseDir: fixture.contentDir,
        scanner: blockingScanner(),
        force: false,
      }),
    ).rejects.toBeInstanceOf(ScanBlockedError);
  });

  it('scans a single union of catalog.json + the whole plugins/ dir for 2 opencode plugin entries (dedup)', async () => {
    const { scanner, calls, trees } = spyScanner();

    await scanEntries({
      entries: [OPENCODE_PLUGIN_ENTRY, OPENCODE_PLUGIN_ENTRY_2],
      baseDir: fixture.contentDir,
      scanner,
      force: false,
    });

    // Two plugin entries → one plugins/ in the union (dedup), scanned once; the
    // whole dir is present, sibling modules included (audit.ts + guard.ts, R2).
    expect(calls).toHaveLength(1);
    expect(trees[0]).toEqual(['catalog.json', 'plugins/audit.ts', 'plugins/guard.ts']);
  });

  it('only scans catalog.json for a claude-only plugin entry (no module in checkout)', async () => {
    const { scanner, calls, trees } = spyScanner();

    await scanEntries({
      entries: [CLAUDE_PLUGIN_ENTRY],
      baseDir: fixture.contentDir,
      scanner,
      force: false,
    });

    expect(calls).toHaveLength(1);
    expect(trees[0]).toEqual(['catalog.json']);
  });
});

// ---------------------------------------------------------------------------
// Shared lifecycle for the runRemoteInstall scenarios
// ---------------------------------------------------------------------------

let fixture: PluginEnv;

beforeEach(async () => {
  fixture = await makePluginEnv([OPENCODE_PLUGIN_ENTRY, OPENCODE_PLUGIN_ENTRY_2]);
});

afterEach(async () => {
  await fixture.cleanupAll();
});

// ---------------------------------------------------------------------------
// H13-3 — blocking scanner, no --force → fail-closed BEFORE any write
// ---------------------------------------------------------------------------

describe('H13-3 — opencode plugin + blocking scanner, no --force → fail-closed', () => {
  it('throws ScanBlockedError', async () => {
    await expect(installGuardPlugin(fixture, blockingScanner())).rejects.toBeInstanceOf(
      ScanBlockedError,
    );
  });

  it('no module reaches pluginDir when the scanner blocks', async () => {
    await installGuardPlugin(fixture, blockingScanner()).catch(() => {});

    const pluginDir = resolveOpencodeUserTargets(fixture.env).pluginDir;
    const stat = await fs.stat(path.join(pluginDir, 'guard.ts')).catch(() => null);
    expect(stat).toBeNull();
  });

  it('no module reaches the plugins store when the scanner blocks', async () => {
    await installGuardPlugin(fixture, blockingScanner()).catch(() => {});

    const skillsDir = resolveUserTargets(fixture.env).skillsDir;
    const storeDir = path.join(path.dirname(skillsDir), 'plugins');
    const stat = await fs.stat(storeDir).catch(() => null);
    expect(stat).toBeNull();
  });

  it('no manifest entry is recorded when the scanner blocks', async () => {
    await installGuardPlugin(fixture, blockingScanner()).catch(() => {});

    const manifest = await readManifest(fixture.manifestPath);
    expect(findEntry(manifest, 'plugin:guard', 'user', 'opencode')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// H13-4 — clean spy scanner → scanned on plugins/ path AND installed
// ---------------------------------------------------------------------------

describe('H13-4 — opencode plugin + clean scanner → scanned then installed', () => {
  it('scans the whole plugins/ dir in a single union scan', async () => {
    const { scanner, calls, trees } = spyScanner();

    await installGuardPlugin(fixture, scanner);

    // One union scan; the plugins/ surface is present in full — both the
    // selected guard.ts and the sibling audit.ts (R2 "chaque nature conserve sa
    // surface", shared modules included).
    expect(calls).toHaveLength(1);
    expect(trees[0]).toContain('plugins/guard.ts');
    expect(trees[0]).toContain('plugins/audit.ts');
  });

  it('installs the plugin module into pluginDir after a clean scan', async () => {
    const { scanner } = spyScanner();

    const result = await installGuardPlugin(fixture, scanner);
    expect(result.applied).toBe(true);

    const pluginDir = resolveOpencodeUserTargets(fixture.env).pluginDir;
    const installed = await fs.readFile(path.join(pluginDir, 'guard.ts'), 'utf8');
    expect(installed).toContain('GuardPlugin');

    const manifest = await readManifest(fixture.manifestPath);
    expect(findEntry(manifest, 'plugin:guard', 'user', 'opencode')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// H13-5 — blocking scanner, with --force → warn + proceed
// ---------------------------------------------------------------------------

describe('H13-5 — opencode plugin + blocking scanner, with --force → warn + proceed', () => {
  it('emits a [warning] and installs anyway', async () => {
    const result = await installGuardPlugin(fixture, blockingScanner(), true);

    expect(result.applied).toBe(true);
    expect(result.output).toMatch(/\[warning\]/);

    const pluginDir = resolveOpencodeUserTargets(fixture.env).pluginDir;
    const stat = await fs.stat(path.join(pluginDir, 'guard.ts')).catch(() => null);
    expect(stat).not.toBeNull();
  });
});
