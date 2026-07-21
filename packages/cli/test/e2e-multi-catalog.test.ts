/**
 * e2e-multi-catalog.test.ts — End-to-end tests for the multi-catalogue flow (M9).
 *
 * Strategy:
 * - RIGGER_HOME isolated via tmp dirs (never touches real ~/.claude).
 * - Fake CommandRunner (no real git network calls).
 * - TmpDirFactory multiplexed to serve different catalog content per source.
 * - Reuses helper patterns from e2e-remote-install.test.ts and m4-multi-catalog.test.ts.
 *
 * Scenarios:
 *  1. Two catalogues configured → `ls` shows qualified ids from both (a/..., b/...)
 *  2. Homonym (both sources have skill:x) → `ls` shows a/skill:x AND b/skill:x (no collision);
 *     `install skill:x` (unqualified) → exit 2 "id non qualifié";
 *     `install a/skill:x` (qualified) → error is NOT "id non qualifié".
 *  3. Qualified install → manifest stores qualified id (a/skill:x) as provenance.
 *  4. `catalog add` → persists; `catalog ls` shows it; `catalog remove` removes it.
 *  5. Ad-hoc install (URL-shaped source) → manifest stores derived prefix id (gh-bar/...).
 *  6. One source fails to fetch → warning emitted + other source entries still resolved.
 *
 * Conventions: extensionless, no while, no process.exit, subjects lowercase.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import type { Env } from '@agent-rigger/core/paths';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';

import { runCli } from '../src/cli';
import { runCatalog } from '../src/cmd-catalog';
import { loadConfigFile } from '../src/config';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAKE_SHA = 'cafebabecafebabecafebabecafebabecafebabe';
const TAG_NAME = 'v2.0.0';
const CATALOG_URL_A = 'https://example.com/catalog-a.git';
const CATALOG_URL_B = 'https://example.com/catalog-b.git';
const ADHOC_URL = 'https://github.com/owner/bar.git';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCapture(): { lines: string[]; print: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

/**
 * CommandRunner that succeeds for all standard git operations.
 * Optionally fails when any arg contains a specific URL substring.
 */
function makeRunner(opts: { failUrlContaining?: string } = {}): CommandRunner {
  return (_cmd, args) => {
    const argv = args ?? [];

    // Fail when a specific URL is present (for degradation scenario)
    if (opts.failUrlContaining !== undefined) {
      if (argv.some((a) => a.includes(opts.failUrlContaining as string))) {
        return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'connection refused' });
      }
    }

    if (argv[0] === 'ls-remote' && argv.includes('--tags')) {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${FAKE_SHA}\trefs/tags/${TAG_NAME}\n`,
        stderr: '',
      });
    }
    if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
      return Promise.resolve({ exitCode: 0, stdout: `${FAKE_SHA}\tHEAD\n`, stderr: '' });
    }
    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${FAKE_SHA}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };
}

/**
 * Builds a TmpDirFactory that rotates between dirA and dirB, writing catalog.json on each call.
 * First call → dirA with entriesA, second call → dirB with entriesB.
 */
function makeSequentialTmpFactory(
  dirA: string,
  entriesA: CatalogEntry[],
  dirB: string,
  entriesB: CatalogEntry[],
): TmpDirFactory {
  let call = 0;
  return async () => {
    call++;
    if (call === 1) {
      await Bun.write(
        path.join(dirA, 'catalog.json'),
        JSON.stringify({ meta: { name: 'source-a' }, entries: entriesA }),
      );
      return { path: dirA, cleanup: async () => {} };
    }
    await Bun.write(
      path.join(dirB, 'catalog.json'),
      JSON.stringify({ meta: { name: 'source-b' }, entries: entriesB }),
    );
    return { path: dirB, cleanup: async () => {} };
  };
}

/** Skill entry fixture. */
function skillEntry(id: string): CatalogEntry {
  return {
    kind: 'artifact',
    id,
    nature: 'skill',
    targets: ['claude'],
    scopes: ['user'],
  };
}

/**
 * Creates an isolated env with two catalogs configured (a → URL_A, b → URL_B).
 * Also creates two tmp dirs for catalog content (catalogDirA, catalogDirB).
 */
async function makeDualCatalogEnv(): Promise<{
  env: Env;
  homeDir: string;
  catalogDirA: string;
  catalogDirB: string;
  configPath: string;
  cleanupAll: () => Promise<void>;
}> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-e2e-mc-home-'));
  const catalogDirA = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-e2e-mc-cat-a-'));
  const catalogDirB = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-e2e-mc-cat-b-'));

  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });

  const configPath = path.join(configDir, 'config.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      catalogs: [
        { name: 'a', url: CATALOG_URL_A },
        { name: 'b', url: CATALOG_URL_B },
      ],
    }),
    'utf8',
  );

  const env: Env = { RIGGER_HOME: homeDir };

  return {
    env,
    homeDir,
    catalogDirA,
    catalogDirB,
    configPath,
    cleanupAll: async () => {
      await fs.rm(homeDir, { recursive: true, force: true });
      await fs.rm(catalogDirA, { recursive: true, force: true });
      await fs.rm(catalogDirB, { recursive: true, force: true });
    },
  };
}

/**
 * Creates an env + content dir for a fully-formed remote install (skill + catalog.json).
 * No config.catalogs written — used for ad-hoc and single-catalog scenarios.
 */
async function makeRemoteContentEnv(opts: {
  entries?: CatalogEntry[];
  withCatalogs?: Array<{ name: string; url: string }>;
}): Promise<{
  env: Env;
  homeDir: string;
  contentDir: string;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  cleanupAll: () => Promise<void>;
}> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-e2e-mc-renv-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-e2e-mc-content-'));

  const entries: CatalogEntry[] = opts.entries ?? [skillEntry('skill:remote-demo')];

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 'adhoc-test-catalog' }, entries }),
    'utf8',
  );

  // Write a SKILL.md for each skill entry so the linker finds it.
  for (const entry of entries) {
    if (entry.kind === 'artifact' && entry.nature === 'skill') {
      const localId = entry.id.includes('/') ? entry.id.split('/').slice(1).join('/') : entry.id;
      const skillName = localId.replace(/^skill:/, '');
      const skillDir = path.join(contentDir, 'common', 'skills', skillName);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `# ${skillName}\n\nFixture skill for e2e-multi-catalog tests.`,
        'utf8',
      );
    }
  }

  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });

  if (opts.withCatalogs !== undefined && opts.withCatalogs.length > 0) {
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({ catalogs: opts.withCatalogs }),
      'utf8',
    );
  }

  const env: Env = { RIGGER_HOME: homeDir };
  const runner = makeRunner();

  const tmpFactory: TmpDirFactory = async () => ({
    path: contentDir,
    cleanup: async () => {},
  });

  return {
    env,
    homeDir,
    contentDir,
    runner,
    tmpFactory,
    cleanupAll: async () => {
      await fs.rm(homeDir, { recursive: true, force: true });
      await fs.rm(contentDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: Two catalogues → ls shows qualified ids from both
// ---------------------------------------------------------------------------

describe('e2e multi-catalog — scenario 1: two catalogues, ls shows qualified entries from both', () => {
  let ctx: Awaited<ReturnType<typeof makeDualCatalogEnv>>;

  beforeEach(async () => {
    ctx = await makeDualCatalogEnv();
  });

  afterEach(async () => {
    await ctx.cleanupAll();
  });

  it('ls exits 0 when both sources succeed', async () => {
    const cap = makeCapture();
    const code = await runCli(['ls'], {
      print: cap.print,
      env: ctx.env,
      remote: {
        run: makeRunner(),
        tmpFactory: makeSequentialTmpFactory(
          ctx.catalogDirA,
          [skillEntry('skill:from-a')],
          ctx.catalogDirB,
          [skillEntry('skill:from-b')],
        ),
      },
    });
    expect(code).toBe(0);
  });

  it('ls shows a/skill:from-a (qualified with source name a)', async () => {
    const cap = makeCapture();
    await runCli(['ls'], {
      print: cap.print,
      env: ctx.env,
      remote: {
        run: makeRunner(),
        tmpFactory: makeSequentialTmpFactory(
          ctx.catalogDirA,
          [skillEntry('skill:from-a')],
          ctx.catalogDirB,
          [skillEntry('skill:from-b')],
        ),
      },
    });
    const out = cap.lines.join('\n');
    expect(out).toContain('a/skill:from-a');
  });

  it('ls shows b/skill:from-b (qualified with source name b)', async () => {
    const cap = makeCapture();
    await runCli(['ls'], {
      print: cap.print,
      env: ctx.env,
      remote: {
        run: makeRunner(),
        tmpFactory: makeSequentialTmpFactory(
          ctx.catalogDirA,
          [skillEntry('skill:from-a')],
          ctx.catalogDirB,
          [skillEntry('skill:from-b')],
        ),
      },
    });
    const out = cap.lines.join('\n');
    expect(out).toContain('b/skill:from-b');
  });

  it('ls shows both sources in the same output', async () => {
    const cap = makeCapture();
    await runCli(['ls'], {
      print: cap.print,
      env: ctx.env,
      remote: {
        run: makeRunner(),
        tmpFactory: makeSequentialTmpFactory(
          ctx.catalogDirA,
          [skillEntry('skill:from-a')],
          ctx.catalogDirB,
          [skillEntry('skill:from-b')],
        ),
      },
    });
    const out = cap.lines.join('\n');
    expect(out).toContain('a/skill:from-a');
    expect(out).toContain('b/skill:from-b');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Homonym — both sources have skill:x
// ---------------------------------------------------------------------------

describe('e2e multi-catalog — scenario 2: homonym skill:x in both sources', () => {
  let ctx: Awaited<ReturnType<typeof makeDualCatalogEnv>>;

  beforeEach(async () => {
    ctx = await makeDualCatalogEnv();
  });

  afterEach(async () => {
    await ctx.cleanupAll();
  });

  it('ls shows both a/skill:x and b/skill:x (no collision)', async () => {
    const cap = makeCapture();
    await runCli(['ls'], {
      print: cap.print,
      env: ctx.env,
      remote: {
        run: makeRunner(),
        tmpFactory: makeSequentialTmpFactory(
          ctx.catalogDirA,
          [skillEntry('skill:x')],
          ctx.catalogDirB,
          [skillEntry('skill:x')],
        ),
      },
    });
    const out = cap.lines.join('\n');
    expect(out).toContain('a/skill:x');
    expect(out).toContain('b/skill:x');
  });

  it('ls does not emit collision warning for homonyms (they have distinct qualified ids)', async () => {
    const cap = makeCapture();
    await runCli(['ls'], {
      print: cap.print,
      env: ctx.env,
      remote: {
        run: makeRunner(),
        tmpFactory: makeSequentialTmpFactory(
          ctx.catalogDirA,
          [skillEntry('skill:x')],
          ctx.catalogDirB,
          [skillEntry('skill:x')],
        ),
      },
    });
    const out = cap.lines.join('\n');
    expect(out).not.toContain('deduplicated');
  });

  it('install skill:x (unqualified) → exit 2 "id non qualifié"', async () => {
    const cap = makeCapture();
    const code = await runCli(['install', 'skill:x', '--yes'], {
      print: cap.print,
      env: ctx.env,
      // No remote needed — validation fires before any catalog fetch
    });
    expect(code).toBe(2);
    const out = cap.lines.join('\n');
    expect(out).toContain('unqualified id');
    expect(out).toContain('skill:x');
  });

  it('install a/skill:x (qualified) → does not produce "id non qualifié" error', async () => {
    // Qualified install with injected runner — may fail at remote stage but NOT at id validation.
    const cap = makeCapture();
    const code = await runCli(['install', 'a/skill:x', '--yes'], {
      print: cap.print,
      env: ctx.env,
      // No remote injected → will fail at resolveVersion (no runner), not at id validation
    });
    // Must NOT be 2 (which would mean "id non qualifié" validation error)
    expect(code).not.toBe(2);
    const out = cap.lines.join('\n');
    expect(out).not.toContain('unqualified id');
  });

  it('install b/skill:x (qualified) → does not produce "id non qualifié" error', async () => {
    const cap = makeCapture();
    const code = await runCli(['install', 'b/skill:x', '--yes'], {
      print: cap.print,
      env: ctx.env,
    });
    expect(code).not.toBe(2);
    const out = cap.lines.join('\n');
    expect(out).not.toContain('unqualified id');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Qualified install → manifest stores qualified id as provenance
// ---------------------------------------------------------------------------

describe('e2e multi-catalog — scenario 3: qualified install → manifest has qualified id', () => {
  let ctx: Awaited<ReturnType<typeof makeRemoteContentEnv>>;
  let targets: ReturnType<typeof resolveUserTargets>;

  beforeEach(async () => {
    ctx = await makeRemoteContentEnv({
      entries: [skillEntry('skill:remote-demo')],
      withCatalogs: [{ name: 'a', url: CATALOG_URL_A }],
    });
    targets = resolveUserTargets(ctx.env);
  });

  afterEach(async () => {
    await ctx.cleanupAll();
  });

  it('install a/skill:remote-demo exits 0', async () => {
    const cap = makeCapture();
    const code = await runCli(['install', 'a/skill:remote-demo', '--yes'], {
      print: cap.print,
      env: ctx.env,
      remote: {
        run: ctx.runner,
        tmpFactory: ctx.tmpFactory,
        scanner: stubScanner,
      },
    });
    expect(code).toBe(0);
  });

  it('manifest stores qualified id a/skill:remote-demo (not bare skill:remote-demo)', async () => {
    await runCli(['install', 'a/skill:remote-demo', '--yes'], {
      print: makeCapture().print,
      env: ctx.env,
      remote: {
        run: ctx.runner,
        tmpFactory: ctx.tmpFactory,
        scanner: stubScanner,
      },
    });

    const raw = await fs.readFile(targets.stateJson, 'utf8');
    const manifest = JSON.parse(raw) as {
      artifacts: Array<{ id: string; ref?: string; sha?: string }>;
    };

    const entry = manifest.artifacts.find((a) => a.id === 'a/skill:remote-demo');
    expect(entry).toBeDefined();
    // Unqualified id must NOT appear
    const bareEntry = manifest.artifacts.find((a) => a.id === 'skill:remote-demo');
    expect(bareEntry).toBeUndefined();
  });

  it('manifest entry for qualified install has a real ref (tag)', async () => {
    await runCli(['install', 'a/skill:remote-demo', '--yes'], {
      print: makeCapture().print,
      env: ctx.env,
      remote: {
        run: ctx.runner,
        tmpFactory: ctx.tmpFactory,
        scanner: stubScanner,
      },
    });

    const raw = await fs.readFile(targets.stateJson, 'utf8');
    const manifest = JSON.parse(raw) as {
      artifacts: Array<{ id: string; ref?: string; sha?: string }>;
    };

    const entry = manifest.artifacts.find((a) => a.id === 'a/skill:remote-demo');
    expect(entry?.ref).toBe(TAG_NAME);
    expect(entry?.sha).toBe(FAKE_SHA);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: catalog add → persists; catalog ls shows it; catalog remove removes it
// ---------------------------------------------------------------------------

describe('e2e multi-catalog — scenario 4: catalog add / ls / remove lifecycle', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-e2e-mc-cat-mgmt-'));
    configPath = path.join(tmpDir, 'config.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('catalog add exits 0', async () => {
    const cap = makeCapture();
    const code = await runCatalog({
      verb: 'add',
      args: ['primary', CATALOG_URL_A],
      configPath,
      print: cap.print,
    });
    expect(code).toBe(0);
  });

  it('catalog add persists to config.catalogs', async () => {
    await runCatalog({
      verb: 'add',
      args: ['primary', CATALOG_URL_A],
      configPath,
      print: () => {},
    });

    const cfg = await loadConfigFile(configPath);
    expect(cfg.catalogs).toHaveLength(1);
    expect(cfg.catalogs?.[0]).toEqual({ name: 'primary', url: CATALOG_URL_A });
  });

  it('catalog ls shows the added catalog', async () => {
    await runCatalog({
      verb: 'add',
      args: ['primary', CATALOG_URL_A],
      configPath,
      print: () => {},
    });

    const cap = makeCapture();
    await runCatalog({ verb: 'ls', args: [], configPath, print: cap.print });
    const out = cap.lines.join('\n');
    expect(out).toContain('primary');
    expect(out).toContain(CATALOG_URL_A);
  });

  it('catalog add a second source appends without overwriting', async () => {
    await runCatalog({
      verb: 'add',
      args: ['primary', CATALOG_URL_A],
      configPath,
      print: () => {},
    });
    await runCatalog({
      verb: 'add',
      args: ['secondary', CATALOG_URL_B],
      configPath,
      print: () => {},
    });

    const cfg = await loadConfigFile(configPath);
    expect(cfg.catalogs).toHaveLength(2);
    const names = (cfg.catalogs ?? []).map((c) => c.name);
    expect(names).toContain('primary');
    expect(names).toContain('secondary');
  });

  it('catalog ls shows both sources', async () => {
    await runCatalog({
      verb: 'add',
      args: ['primary', CATALOG_URL_A],
      configPath,
      print: () => {},
    });
    await runCatalog({
      verb: 'add',
      args: ['secondary', CATALOG_URL_B],
      configPath,
      print: () => {},
    });

    const cap = makeCapture();
    await runCatalog({ verb: 'ls', args: [], configPath, print: cap.print });
    const out = cap.lines.join('\n');
    expect(out).toContain('primary');
    expect(out).toContain('secondary');
  });

  it('catalog remove removes the source', async () => {
    await runCatalog({
      verb: 'add',
      args: ['primary', CATALOG_URL_A],
      configPath,
      print: () => {},
    });
    await runCatalog({
      verb: 'add',
      args: ['secondary', CATALOG_URL_B],
      configPath,
      print: () => {},
    });

    const cap = makeCapture();
    const code = await runCatalog({
      verb: 'remove',
      args: ['primary'],
      configPath,
      print: cap.print,
    });
    expect(code).toBe(0);

    const cfg = await loadConfigFile(configPath);
    expect(cfg.catalogs).toHaveLength(1);
    expect(cfg.catalogs?.[0]?.name).toBe('secondary');
  });

  it('catalog ls no longer shows the removed source', async () => {
    await runCatalog({
      verb: 'add',
      args: ['primary', CATALOG_URL_A],
      configPath,
      print: () => {},
    });
    await runCatalog({ verb: 'remove', args: ['primary'], configPath, print: () => {} });

    const cap = makeCapture();
    await runCatalog({ verb: 'ls', args: [], configPath, print: cap.print });
    const out = cap.lines.join('\n');
    expect(out).not.toContain('primary');
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Ad-hoc install (URL) → manifest stores derived-prefix id (gh-bar/...)
// ---------------------------------------------------------------------------

describe('e2e multi-catalog — scenario 5: ad-hoc install from URL', () => {
  let ctx: Awaited<ReturnType<typeof makeRemoteContentEnv>>;
  let targets: ReturnType<typeof resolveUserTargets>;

  beforeEach(async () => {
    ctx = await makeRemoteContentEnv({
      entries: [skillEntry('skill:remote-demo')],
      // No withCatalogs — ad-hoc install doesn't require a configured catalog
    });
    targets = resolveUserTargets(ctx.env);
  });

  afterEach(async () => {
    await ctx.cleanupAll();
  });

  it('ad-hoc install from github URL exits 0', async () => {
    const cap = makeCapture();
    const code = await runCli(['install', ADHOC_URL, '--yes'], {
      print: cap.print,
      env: ctx.env,
      remote: {
        run: ctx.runner,
        tmpFactory: ctx.tmpFactory,
        scanner: stubScanner,
      },
    });
    expect(code).toBe(0);
  });

  it('manifest stores derived-prefix qualified id (gh-bar/skill:remote-demo)', async () => {
    await runCli(['install', ADHOC_URL, '--yes'], {
      print: makeCapture().print,
      env: ctx.env,
      remote: {
        run: ctx.runner,
        tmpFactory: ctx.tmpFactory,
        scanner: stubScanner,
      },
    });

    const raw = await fs.readFile(targets.stateJson, 'utf8');
    const manifest = JSON.parse(raw) as {
      artifacts: Array<{ id: string }>;
    };

    // ADHOC_URL = 'https://github.com/owner/bar.git' → prefix = 'gh-bar'
    const entry = manifest.artifacts.find((a) => a.id === 'gh-bar/skill:remote-demo');
    expect(entry).toBeDefined();
  });

  it('manifest id does NOT use bare id (scan provenance is the derived prefix)', async () => {
    await runCli(['install', ADHOC_URL, '--yes'], {
      print: makeCapture().print,
      env: ctx.env,
      remote: {
        run: ctx.runner,
        tmpFactory: ctx.tmpFactory,
        scanner: stubScanner,
      },
    });

    const raw = await fs.readFile(targets.stateJson, 'utf8');
    const manifest = JSON.parse(raw) as {
      artifacts: Array<{ id: string }>;
    };

    // Bare id must not appear — provenance is always qualified
    const bare = manifest.artifacts.find((a) => a.id === 'skill:remote-demo');
    expect(bare).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: One source fails → warning + other source entries resolved
// ---------------------------------------------------------------------------

describe('e2e multi-catalog — scenario 6: degraded source — warning + other source ok', () => {
  let homeDir: string;
  let catalogDirA: string;
  let env: Env;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-e2e-mc-degrade-'));
    catalogDirA = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-e2e-mc-degrade-cat-'));

    const configDir = path.join(homeDir, '.config', 'agent-rigger');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({
        catalogs: [
          { name: 'source-ok', url: CATALOG_URL_A },
          { name: 'source-fail', url: CATALOG_URL_B },
        ],
      }),
      'utf8',
    );

    env = { RIGGER_HOME: homeDir };
  });

  afterEach(async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(catalogDirA, { recursive: true, force: true });
  });

  it('ls exits 0 when one source fails and one succeeds', async () => {
    const entriesA: CatalogEntry[] = [skillEntry('skill:from-ok')];

    const partialTmpFactory: TmpDirFactory = async () => {
      await Bun.write(
        path.join(catalogDirA, 'catalog.json'),
        JSON.stringify({ meta: { name: 'source-ok' }, entries: entriesA }),
      );
      return { path: catalogDirA, cleanup: async () => {} };
    };

    const cap = makeCapture();
    const code = await runCli(['ls'], {
      print: cap.print,
      env,
      remote: {
        run: makeRunner({ failUrlContaining: CATALOG_URL_B }),
        tmpFactory: partialTmpFactory,
      },
    });

    expect(code).toBe(0);
  });

  it('warning is emitted mentioning the failing source name', async () => {
    const entriesA: CatalogEntry[] = [skillEntry('skill:from-ok')];

    const partialTmpFactory: TmpDirFactory = async () => {
      await Bun.write(
        path.join(catalogDirA, 'catalog.json'),
        JSON.stringify({ meta: { name: 'source-ok' }, entries: entriesA }),
      );
      return { path: catalogDirA, cleanup: async () => {} };
    };

    const cap = makeCapture();
    await runCli(['ls'], {
      print: cap.print,
      env,
      remote: {
        run: makeRunner({ failUrlContaining: CATALOG_URL_B }),
        tmpFactory: partialTmpFactory,
      },
    });

    const out = cap.lines.join('\n');
    expect(out).toContain('[warning]');
    expect(out).toContain('source-fail');
    expect(out).toContain('unavailable');
  });

  it('entries from the succeeding source still appear in output', async () => {
    const entriesA: CatalogEntry[] = [skillEntry('skill:from-ok')];

    const partialTmpFactory: TmpDirFactory = async () => {
      await Bun.write(
        path.join(catalogDirA, 'catalog.json'),
        JSON.stringify({ meta: { name: 'source-ok' }, entries: entriesA }),
      );
      return { path: catalogDirA, cleanup: async () => {} };
    };

    const cap = makeCapture();
    await runCli(['ls'], {
      print: cap.print,
      env,
      remote: {
        run: makeRunner({ failUrlContaining: CATALOG_URL_B }),
        tmpFactory: partialTmpFactory,
      },
    });

    const out = cap.lines.join('\n');
    // The qualified id from source-ok must appear
    expect(out).toContain('source-ok/skill:from-ok');
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: install routes by prefix — secondary source (b) serves its own content
//
// This is the regression scenario for the catalogs[0] bug:
// - `a` and `b` are configured with distinct URLs.
// - `b` has `skill:only-in-b` and `skill:x` (different content from a's skill:x).
// - `a` has `skill:x` but NOT `skill:only-in-b`.
// - `install b/skill:only-in-b` must succeed (not throw UnknownEntryError against a).
// - `install b/skill:x` must install the content from b (not a).
// - The manifest stores the qualified id from b's prefix.
//
// Dispatcher strategy: URL-tracking runner + URL-aware tmpFactory.
// The runner records the last URL seen in ls-remote; tmpFactory reads that URL
// to dispatch the right content dir (A or B).  The sequence is guaranteed by
// resolveVersion (ls-remote sees URL) → withRemoteCheckout (tmpFactory called).
// ---------------------------------------------------------------------------

describe('e2e multi-catalog — scenario 7: install routes by prefix to secondary source', () => {
  let homeDir: string;
  let contentDirA: string;
  let contentDirB: string;
  let env: Env;
  let targets: ReturnType<typeof resolveUserTargets>;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-e2e-mc-s7-home-'));
    contentDirA = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-e2e-mc-s7-a-'));
    contentDirB = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-e2e-mc-s7-b-'));

    const configDir = path.join(homeDir, '.config', 'agent-rigger');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({
        catalogs: [
          { name: 'a', url: CATALOG_URL_A },
          { name: 'b', url: CATALOG_URL_B },
        ],
      }),
      'utf8',
    );

    // Catalog A: skill:x only
    await fs.writeFile(
      path.join(contentDirA, 'catalog.json'),
      JSON.stringify({
        meta: { name: 'a' },
        entries: [{
          kind: 'artifact',
          id: 'skill:x',
          nature: 'skill',
          targets: ['claude'],
          scopes: ['user'],
        }],
      }),
      'utf8',
    );
    await fs.mkdir(path.join(contentDirA, 'common', 'skills', 'x'), { recursive: true });
    await fs.writeFile(
      path.join(contentDirA, 'common', 'skills', 'x', 'SKILL.md'),
      '# x\nContent from source A.',
      'utf8',
    );

    // Catalog B: skill:x (different content) + skill:only-in-b (absent from A)
    await fs.writeFile(
      path.join(contentDirB, 'catalog.json'),
      JSON.stringify({
        meta: { name: 'b' },
        entries: [
          {
            kind: 'artifact',
            id: 'skill:x',
            nature: 'skill',
            targets: ['claude'],
            scopes: ['user'],
          },
          {
            kind: 'artifact',
            id: 'skill:only-in-b',
            nature: 'skill',
            targets: ['claude'],
            scopes: ['user'],
          },
        ],
      }),
      'utf8',
    );
    await fs.mkdir(path.join(contentDirB, 'common', 'skills', 'x'), { recursive: true });
    await fs.writeFile(
      path.join(contentDirB, 'common', 'skills', 'x', 'SKILL.md'),
      '# x\nContent from source B.',
      'utf8',
    );
    await fs.mkdir(path.join(contentDirB, 'common', 'skills', 'only-in-b'), { recursive: true });
    await fs.writeFile(
      path.join(contentDirB, 'common', 'skills', 'only-in-b', 'SKILL.md'),
      '# only-in-b\nExclusive to source B.',
      'utf8',
    );

    env = { RIGGER_HOME: homeDir };
    targets = resolveUserTargets(env);
  });

  afterEach(async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(contentDirA, { recursive: true, force: true });
    await fs.rm(contentDirB, { recursive: true, force: true });
  });

  /**
   * URL-tracking runner + URL-aware tmpFactory.
   * The runner records the last URL seen via ls-remote; the tmpFactory uses that
   * URL to serve the right content directory.
   */
  function makeUrlAwareRemote(): { run: CommandRunner; tmpFactory: TmpDirFactory } {
    let lastUrl = '';

    const run: CommandRunner = (_cmd, args) => {
      const argv = args ?? [];

      // Track URL from ls-remote calls (resolveVersion path)
      if (argv[0] === 'ls-remote') {
        // argv is: ['ls-remote', '--tags', '--refs', url] or ['ls-remote', url, 'HEAD']
        const urlArg = argv.find((a) => a.startsWith('https://'));
        if (urlArg !== undefined) lastUrl = urlArg;
        if (argv.includes('--tags')) {
          return Promise.resolve({
            exitCode: 0,
            stdout: `${FAKE_SHA}\trefs/tags/${TAG_NAME}\n`,
            stderr: '',
          });
        }
        return Promise.resolve({ exitCode: 0, stdout: `${FAKE_SHA}\tHEAD\n`, stderr: '' });
      }
      if (argv[0] === 'clone') {
        // Track URL from clone call too (the URL is the second-to-last arg before path)
        const urlArg = argv.find((a) => a.startsWith('https://'));
        if (urlArg !== undefined) lastUrl = urlArg;
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      if (argv[0] === '-C' && argv[2] === 'rev-parse') {
        return Promise.resolve({ exitCode: 0, stdout: `${FAKE_SHA}\n`, stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    };

    const tmpFactory: TmpDirFactory = async () => {
      const dir = lastUrl === CATALOG_URL_B ? contentDirB : contentDirA;
      return { path: dir, cleanup: async () => {} };
    };

    return { run, tmpFactory };
  }

  it('install b/skill:only-in-b exits 0 (not UnknownEntryError from a)', async () => {
    const { run, tmpFactory } = makeUrlAwareRemote();
    const cap = makeCapture();
    const code = await runCli(['install', 'b/skill:only-in-b', '--yes'], {
      print: cap.print,
      env,
      remote: { run, tmpFactory, scanner: stubScanner },
    });
    expect(code).toBe(0);
  });

  it('manifest stores b/skill:only-in-b (not a/skill:only-in-b)', async () => {
    const { run, tmpFactory } = makeUrlAwareRemote();
    await runCli(['install', 'b/skill:only-in-b', '--yes'], {
      print: makeCapture().print,
      env,
      remote: { run, tmpFactory, scanner: stubScanner },
    });

    const raw = await fs.readFile(targets.stateJson, 'utf8');
    const manifest = JSON.parse(raw) as { artifacts: Array<{ id: string }> };
    const entry = manifest.artifacts.find((a) => a.id === 'b/skill:only-in-b');
    expect(entry).toBeDefined();
  });

  it('install b/skill:x installs content from b (not a)', async () => {
    const { run, tmpFactory } = makeUrlAwareRemote();
    const code = await runCli(['install', 'b/skill:x', '--yes'], {
      print: makeCapture().print,
      env,
      remote: { run, tmpFactory, scanner: stubScanner },
    });
    expect(code).toBe(0);

    const raw = await fs.readFile(targets.stateJson, 'utf8');
    const manifest = JSON.parse(raw) as { artifacts: Array<{ id: string }> };
    const entry = manifest.artifacts.find((a) => a.id === 'b/skill:x');
    expect(entry).toBeDefined();
    // a/skill:x must NOT appear — only b's entry
    const aEntry = manifest.artifacts.find((a) => a.id === 'a/skill:x');
    expect(aEntry).toBeUndefined();
  });

  it('install b/skill:only-in-b does NOT produce "id non qualifié" error', async () => {
    const { run, tmpFactory } = makeUrlAwareRemote();
    const cap = makeCapture();
    await runCli(['install', 'b/skill:only-in-b', '--yes'], {
      print: cap.print,
      env,
      remote: { run, tmpFactory, scanner: stubScanner },
    });
    const out = cap.lines.join('\n');
    expect(out).not.toContain('unqualified id');
  });

  it('install a/skill:x uses catalog-a URL (not catalog-b)', async () => {
    const usedUrls: string[] = [];
    const run: CommandRunner = (_cmd, args) => {
      const argv = args ?? [];
      const urlArg = argv.find((a) => a.startsWith('https://'));
      if (urlArg !== undefined) usedUrls.push(urlArg);
      if (argv[0] === 'ls-remote' && argv.includes('--tags')) {
        return Promise.resolve({
          exitCode: 0,
          stdout: `${FAKE_SHA}\trefs/tags/${TAG_NAME}\n`,
          stderr: '',
        });
      }
      if (argv[0] === 'ls-remote') {
        return Promise.resolve({ exitCode: 0, stdout: `${FAKE_SHA}\tHEAD\n`, stderr: '' });
      }
      if (argv[0] === '-C' && argv[2] === 'rev-parse') {
        return Promise.resolve({ exitCode: 0, stdout: `${FAKE_SHA}\n`, stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    };
    const tmpFactory: TmpDirFactory = async () => ({ path: contentDirA, cleanup: async () => {} });

    await runCli(['install', 'a/skill:x', '--yes'], {
      print: makeCapture().print,
      env,
      remote: { run, tmpFactory, scanner: stubScanner },
    });

    expect(usedUrls.some((u) => u === CATALOG_URL_A)).toBe(true);
    expect(usedUrls.some((u) => u === CATALOG_URL_B)).toBe(false);
  });
});
