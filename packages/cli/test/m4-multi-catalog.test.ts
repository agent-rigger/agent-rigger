/**
 * M4 — multi-source catalog resolution tests.
 *
 * Scenarios:
 *  1. Two sources fetched in parallel, entries merged (first-source wins on collision).
 *  2. One source fails → per-source degradation: warning emitted, other source proceeds.
 *  3. Collision across sources → conflict warning reported (qualified ids collide).
 *  3b. Forged pre-qualified entry id (a raw '/' in an id) → rejected at parse,
 *      per-source degradation keeps the other source (catalog-id-traversal).
 *  4. Legacy `catalogUrl` config (no `catalogs[]`) → R7: LegacyConfigError warning, empty catalog.
 *
 * Strategy:
 *  - Inject fake CommandRunner + TmpDirFactory per source via `remote` deps.
 *  - Catalog content is dispatched by URL (not call order): the runner tracks the URL from
 *    ls-remote; the tmpFactory uses that URL to serve the matching content dir.
 *  - No real git processes; no real network.
 *  - No while loops.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';

import { runCli } from '../src/cli';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAKE_SHA = 'aabbccddeeff00112233445566778899aabbccdd';
const CATALOG_URL_A = 'https://example.com/catalog-a.git';
const CATALOG_URL_B = 'https://example.com/catalog-b.git';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCapture(): { lines: string[]; print: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

/**
 * Builds a `{ run, tmpFactory }` pair that dispatches catalog content by URL.
 *
 * Strategy: the runner intercepts `git clone <url> <path>` and writes the correct
 * `catalog.json` into the already-allocated dir based on the URL argument.
 * The tmpFactory is a simple round-robin allocator (dirA first, dirB second) —
 * content is never written there; the runner writes it in the clone handler.
 *
 * This is robust when fetch operations run in parallel (Promise.all):
 *  - tmpFactory call order is irrelevant — dirs are just pre-allocated slots.
 *  - The runner matches URL → content deterministically, regardless of scheduling.
 *
 * The URL→content mapping:
 *  - CATALOG_URL_A → dirA, meta.name='source-a', entriesA
 *  - CATALOG_URL_B → dirB, meta.name='source-b', entriesB
 */
function makeUrlAwareRemote(
  dirA: string,
  entriesA: CatalogEntry[],
  dirB: string,
  entriesB: CatalogEntry[],
): { run: CommandRunner; tmpFactory: TmpDirFactory } {
  // URL → catalog payload map, keyed at construction time (no mutation during test).
  const catalogByUrl = new Map<string, { dir: string; name: string; entries: CatalogEntry[] }>([
    [CATALOG_URL_A, { dir: dirA, name: 'source-a', entries: entriesA }],
    [CATALOG_URL_B, { dir: dirB, name: 'source-b', entries: entriesB }],
  ]);

  const run: CommandRunner = async (_cmd, args) => {
    const argsArr = args ?? [];

    if (argsArr.includes('ls-remote')) {
      if (argsArr.includes('--tags')) {
        return { exitCode: 0, stdout: `${FAKE_SHA}\trefs/tags/v1.0.0\n`, stderr: '' };
      }
      return { exitCode: 0, stdout: `${FAKE_SHA}\tHEAD\n`, stderr: '' };
    }

    if (argsArr.includes('clone')) {
      // `git clone --depth 1 --branch <ref> -- <url> <path>`
      // The URL is the second-to-last arg; the destination path is the last arg.
      const urlArg = argsArr.find((a) => a.startsWith('https://'));
      const destPath = argsArr.at(-1);
      if (urlArg !== undefined && destPath !== undefined) {
        const catalog = catalogByUrl.get(urlArg);
        if (catalog !== undefined) {
          await Bun.write(
            path.join(destPath, 'catalog.json'),
            JSON.stringify({ meta: { name: catalog.name }, entries: catalog.entries }),
          );
        }
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    if (argsArr.includes('rev-parse')) {
      return { exitCode: 0, stdout: `${FAKE_SHA}\n`, stderr: '' };
    }

    return { exitCode: 0, stdout: '', stderr: '' };
  };

  // Simple allocator: each call returns a different pre-created dir.
  // Content is injected by the runner's clone handler, not here.
  let callCount = 0;
  const dirs = [dirA, dirB];

  const tmpFactory: TmpDirFactory = async () => {
    const dir = dirs[callCount % dirs.length] ?? dirA;
    callCount += 1;
    return { path: dir, cleanup: async () => {} };
  };

  return { run, tmpFactory };
}

// ---------------------------------------------------------------------------
// Scenario 1: Two sources fetched in parallel — entries merged
// ---------------------------------------------------------------------------

describe('M4 — two sources merged: entries from both sources appear in ls output', () => {
  let homeDir: string;
  let catalogDirA: string;
  let catalogDirB: string;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-m4-two-src-'));
    catalogDirA = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-m4-cat-a-'));
    catalogDirB = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-m4-cat-b-'));

    // Config with two catalogs
    const configDir = path.join(homeDir, '.config', 'agent-rigger');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({
        catalogs: [
          { name: 'source-a', url: CATALOG_URL_A },
          { name: 'source-b', url: CATALOG_URL_B },
        ],
      }),
      'utf8',
    );
  });

  afterEach(async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(catalogDirA, { recursive: true, force: true });
    await fs.rm(catalogDirB, { recursive: true, force: true });
  });

  it('ls exit code 0 when both sources succeed', async () => {
    const entriesA: CatalogEntry[] = [
      {
        kind: 'artifact',
        id: 'skill:from-a',
        nature: 'skill',
        targets: ['claude'],
        scopes: ['user'],
      },
    ];
    const entriesB: CatalogEntry[] = [
      {
        kind: 'artifact',
        id: 'skill:from-b',
        nature: 'skill',
        targets: ['claude'],
        scopes: ['user'],
      },
    ];

    const cap = makeCapture();
    const code = await runCli(['ls'], {
      print: cap.print,
      env: { RIGGER_HOME: homeDir },
      remote: makeUrlAwareRemote(catalogDirA, entriesA, catalogDirB, entriesB),
    });

    expect(code).toBe(0);
  });

  it('ls output contains entries from both source-a and source-b', async () => {
    const entriesA: CatalogEntry[] = [
      {
        kind: 'artifact',
        id: 'skill:from-a',
        nature: 'skill',
        targets: ['claude'],
        scopes: ['user'],
      },
    ];
    const entriesB: CatalogEntry[] = [
      {
        kind: 'artifact',
        id: 'skill:from-b',
        nature: 'skill',
        targets: ['claude'],
        scopes: ['user'],
      },
    ];

    const cap = makeCapture();
    await runCli(['ls'], {
      print: cap.print,
      env: { RIGGER_HOME: homeDir },
      remote: makeUrlAwareRemote(catalogDirA, entriesA, catalogDirB, entriesB),
    });

    const out = cap.lines.join('\n');
    expect(out).toContain('skill:from-a');
    expect(out).toContain('skill:from-b');
  });

  it('same unqualified id in both sources: both entries appear (different qualified ids)', async () => {
    // M4 qualification: source-a/skill:shared ≠ source-b/skill:shared → no collision
    // Both entries appear in the output (different qualified ids from different sources).
    const entriesA: CatalogEntry[] = [
      {
        kind: 'artifact',
        id: 'skill:shared',
        nature: 'skill',
        targets: ['claude'],
        scopes: ['user'],
      },
    ];
    const entriesB: CatalogEntry[] = [
      {
        kind: 'artifact',
        id: 'skill:shared',
        nature: 'skill',
        targets: ['claude'],
        scopes: ['project'],
      },
    ];

    const cap = makeCapture();
    await runCli(['ls'], {
      print: cap.print,
      env: { RIGGER_HOME: homeDir },
      remote: makeUrlAwareRemote(catalogDirA, entriesA, catalogDirB, entriesB),
    });

    const out = cap.lines.join('\n');
    // skill:shared appears (at least one, both unqualified originals kept)
    expect(out).toContain('skill:shared');
    // No collision warning — these are distinct qualified ids
    expect(out).not.toContain('[warning]');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: One source fails → per-source degradation
// ---------------------------------------------------------------------------

describe('M4 — per-source degradation: one source fails, other succeeds', () => {
  let homeDir: string;
  let catalogDirA: string;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-m4-degrade-'));
    catalogDirA = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-m4-degrade-cat-'));

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
  });

  afterEach(async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(catalogDirA, { recursive: true, force: true });
  });

  it('exit code 0 when one source fails and one succeeds', async () => {
    const entriesA: CatalogEntry[] = [
      {
        kind: 'artifact',
        id: 'skill:from-ok',
        nature: 'skill',
        targets: ['claude'],
        scopes: ['user'],
      },
    ];

    const mixedRunner: CommandRunner = (_cmd, args) => {
      const argsArr = args ?? [];
      // source-fail's URL triggers failure on ls-remote
      if (argsArr.some((a) => a.includes(CATALOG_URL_B))) {
        return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'auth required' });
      }
      // source-ok succeeds
      if (argsArr.includes('ls-remote') && argsArr.includes('--tags')) {
        return Promise.resolve({
          exitCode: 0,
          stdout: `${FAKE_SHA}\trefs/tags/v1.0.0\n`,
          stderr: '',
        });
      }
      if (argsArr.includes('clone')) {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      if (argsArr.includes('rev-parse')) {
        return Promise.resolve({ exitCode: 0, stdout: `${FAKE_SHA}\n`, stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    };

    // Only source-ok produces a catalog; source-fail never clones
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
      env: { RIGGER_HOME: homeDir },
      remote: { run: mixedRunner, tmpFactory: partialTmpFactory },
    });

    expect(code).toBe(0);
  });

  it('warning message emitted for failing source', async () => {
    const entriesA: CatalogEntry[] = [
      {
        kind: 'artifact',
        id: 'skill:from-ok',
        nature: 'skill',
        targets: ['claude'],
        scopes: ['user'],
      },
    ];

    const mixedRunner: CommandRunner = (_cmd, args) => {
      const argsArr = args ?? [];
      if (argsArr.some((a) => a.includes(CATALOG_URL_B))) {
        return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'auth required' });
      }
      if (argsArr.includes('ls-remote') && argsArr.includes('--tags')) {
        return Promise.resolve({
          exitCode: 0,
          stdout: `${FAKE_SHA}\trefs/tags/v1.0.0\n`,
          stderr: '',
        });
      }
      if (argsArr.includes('clone')) {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      if (argsArr.includes('rev-parse')) {
        return Promise.resolve({ exitCode: 0, stdout: `${FAKE_SHA}\n`, stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    };

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
      env: { RIGGER_HOME: homeDir },
      remote: { run: mixedRunner, tmpFactory: partialTmpFactory },
    });

    const out = cap.lines.join('\n');
    expect(out).toContain('[warning]');
    expect(out).toContain('source-fail');
    expect(out).toContain('unavailable');
  });

  it('entries from succeeding source still appear in output', async () => {
    const entriesA: CatalogEntry[] = [
      {
        kind: 'artifact',
        id: 'skill:from-ok',
        nature: 'skill',
        targets: ['claude'],
        scopes: ['user'],
      },
    ];

    const mixedRunner: CommandRunner = (_cmd, args) => {
      const argsArr = args ?? [];
      if (argsArr.some((a) => a.includes(CATALOG_URL_B))) {
        return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'auth required' });
      }
      if (argsArr.includes('ls-remote') && argsArr.includes('--tags')) {
        return Promise.resolve({
          exitCode: 0,
          stdout: `${FAKE_SHA}\trefs/tags/v1.0.0\n`,
          stderr: '',
        });
      }
      if (argsArr.includes('clone')) {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      if (argsArr.includes('rev-parse')) {
        return Promise.resolve({ exitCode: 0, stdout: `${FAKE_SHA}\n`, stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    };

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
      env: { RIGGER_HOME: homeDir },
      remote: { run: mixedRunner, tmpFactory: partialTmpFactory },
    });

    const out = cap.lines.join('\n');
    expect(out).toContain('skill:from-ok');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Collision across sources → conflict warning reported
// ---------------------------------------------------------------------------

describe('M4 — collision detection: same qualified id in two sources triggers warning', () => {
  let homeDir: string;
  let catalogDirA: string;
  let catalogDirB: string;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-m4-collision-'));
    catalogDirA = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-m4-col-a-'));
    catalogDirB = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-m4-col-b-'));

    // Canonical collision per ADR-0017 §3: the SAME catalog is added twice.
    // Both config entries carry the same source name → qualifyEntries prefixes
    // both with 'source-a/', so an id present in both yields the exact same
    // fully-qualified id — a true duplicate for foldCatalogs to deduplicate.
    // (Both point at CATALOG_URL_A so the URL-aware remote serves entriesA to
    // both fetches — literally the same catalog, twice.)
    const configDir = path.join(homeDir, '.config', 'agent-rigger');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({
        catalogs: [
          { name: 'source-a', url: CATALOG_URL_A },
          { name: 'source-a', url: CATALOG_URL_A },
        ],
      }),
      'utf8',
    );
  });

  afterEach(async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(catalogDirA, { recursive: true, force: true });
    await fs.rm(catalogDirB, { recursive: true, force: true });
  });

  it('collision warning is emitted when the same catalog is folded twice', async () => {
    const entriesA: CatalogEntry[] = [
      { kind: 'artifact', id: 'skill:dup', nature: 'skill', targets: ['claude'], scopes: ['user'] },
      // qualifyEntries('source-a', entriesA) → 'source-a/skill:dup', produced twice.
    ];

    const cap = makeCapture();
    await runCli(['ls'], {
      print: cap.print,
      env: { RIGGER_HOME: homeDir },
      remote: makeUrlAwareRemote(catalogDirA, entriesA, catalogDirB, []),
    });

    const out = cap.lines.join('\n');
    // Collision warning should be emitted (duplicate qualified ids).
    expect(out).toContain('[warning]');
    expect(out).toContain('deduplicated');
    expect(out).toContain('source-a/skill:dup');
  });

  it('only the first occurrence survives collision (second discarded)', async () => {
    const entriesA: CatalogEntry[] = [
      { kind: 'artifact', id: 'skill:dup', nature: 'skill', targets: ['claude'], scopes: ['user'] },
    ];

    const cap = makeCapture();
    await runCli(['ls'], {
      print: cap.print,
      env: { RIGGER_HOME: homeDir },
      remote: makeUrlAwareRemote(catalogDirA, entriesA, catalogDirB, []),
    });

    const out = cap.lines.join('\n');
    // skill:dup appears once in the catalog listing.
    expect(out).toContain('skill:dup');
    // Collision warning confirms dedup happened.
    expect(out).toContain('deduplicated');
    // Catalog shows exactly 1 entry (dedup worked).
    expect(out).toContain('Catalog (1 entry)');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3b: Forged pre-qualified entry id rejected at parse (entry-id
// analogue of governance-id-forge / partitionMetaIds — catalog-id-traversal)
// ---------------------------------------------------------------------------

describe('M4 — forged pre-qualified entry id is rejected at parse (qualification-forge closed)', () => {
  let homeDir: string;
  let catalogDirA: string;
  let catalogDirB: string;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-m4-forge-'));
    catalogDirA = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-m4-forge-a-'));
    catalogDirB = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-m4-forge-b-'));

    const configDir = path.join(homeDir, '.config', 'agent-rigger');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({
        catalogs: [
          { name: 'source-a', url: CATALOG_URL_A },
          { name: 'source-b', url: CATALOG_URL_B },
        ],
      }),
      'utf8',
    );
  });

  afterEach(async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(catalogDirA, { recursive: true, force: true });
    await fs.rm(catalogDirB, { recursive: true, force: true });
  });

  it('rejects source-b forging id "source-a/skill:dup" at parse, keeps source-a intact', async () => {
    // A raw catalog.json must never carry a '/' in an entry id: qualification is
    // what the CLI does with a source name, not something a remote may pre-declare
    // for another catalog. schema.ts's isSafeCatalogId rejects it at parse — the
    // entry-id analogue of governance-id-forge / partitionMetaIds (meta ids).
    // Effect: source-b fails to parse as a whole; per-source degradation keeps
    // source-a — no crash, and NOT a collision dedup.
    const entriesA: CatalogEntry[] = [
      {
        kind: 'artifact',
        id: 'skill:legit',
        nature: 'skill',
        targets: ['claude'],
        scopes: ['user'],
      },
    ];
    const entriesB: CatalogEntry[] = [
      {
        kind: 'artifact',
        id: 'source-a/skill:dup',
        nature: 'skill',
        targets: ['claude'],
        scopes: ['project'],
      },
    ];

    const cap = makeCapture();
    await runCli(['ls'], {
      print: cap.print,
      env: { RIGGER_HOME: homeDir },
      remote: makeUrlAwareRemote(catalogDirA, entriesA, catalogDirB, entriesB),
    });

    const out = cap.lines.join('\n');
    // source-b dropped with a per-source failure warning naming the forged id.
    expect(out).toContain('[warning]');
    expect(out).toContain('source-b');
    expect(out).toContain('source-a/skill:dup');
    // It is a parse rejection, not a collision dedup.
    expect(out).not.toContain('deduplicated');
    // source-a survived — no crash, other sources intact.
    expect(out).toContain('skill:legit');
  });
});

// ---------------------------------------------------------------------------
// Scenario 4b: Homonym entries — same unqualified id in two sources (ADR-0017 §5)
// ---------------------------------------------------------------------------

describe('M4 — homonym: two sources each with skill:x → qualified ids distinct, unqualified install errors', () => {
  let homeDir: string;
  let catalogDirA: string;
  let catalogDirB: string;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-m4-homonym-'));
    catalogDirA = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-m4-hom-a-'));
    catalogDirB = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-m4-hom-b-'));

    // Config with two catalogs named 'a' and 'b'
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
  });

  afterEach(async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(catalogDirA, { recursive: true, force: true });
    await fs.rm(catalogDirB, { recursive: true, force: true });
  });

  it('ls shows both a/skill:x and b/skill:x — no collision (distinct qualified ids)', async () => {
    // Both sources provide skill:x with the same local id.
    // After qualification: a/skill:x ≠ b/skill:x → both appear, no collision warning.
    const entriesA: CatalogEntry[] = [
      { kind: 'artifact', id: 'skill:x', nature: 'skill', targets: ['claude'], scopes: ['user'] },
    ];
    const entriesB: CatalogEntry[] = [
      { kind: 'artifact', id: 'skill:x', nature: 'skill', targets: ['claude'], scopes: ['user'] },
    ];

    const cap = makeCapture();
    await runCli(['ls'], {
      print: cap.print,
      env: { RIGGER_HOME: homeDir },
      remote: makeUrlAwareRemote(catalogDirA, entriesA, catalogDirB, entriesB),
    });

    const out = cap.lines.join('\n');
    // Both qualified entries appear in the listing
    expect(out).toContain('a/skill:x');
    expect(out).toContain('b/skill:x');
    // No collision — they have different qualified ids
    expect(out).not.toContain('deduplicated');
  });

  it('install skill:x (unqualified) → exit 2 with actionable "id non qualifié" error', async () => {
    // Unqualified id passed to install: CLI must reject it immediately with an actionable error.
    // This prevents silent selection of the first match when homonyms exist (ADR-0017 §5).
    const cap = makeCapture();
    const code = await runCli(['install', 'skill:x', '--yes'], {
      print: cap.print,
      env: { RIGGER_HOME: homeDir },
      // No remote needed — validation fires before any catalog fetch
    });

    expect(code).toBe(2);
    const out = cap.lines.join('\n');
    expect(out).toContain('unqualified id');
    expect(out).toContain('skill:x');
  });

  it('install a/skill:x (qualified) → unambiguous: selects source a entry only', async () => {
    // Qualified install: the source prefix resolves ambiguity.
    // runRemoteInstall is called with sourceName='a', which is the primary catalog.
    // The install may fail at the remote fetch stage (no real git), but the CLI
    // must NOT error with "id non qualifié" — the validation must pass.
    // (Full install success is tested in e2e-remote-install.test.ts.)
    const cap = makeCapture();
    const code = await runCli(['install', 'a/skill:x', '--yes'], {
      print: cap.print,
      env: { RIGGER_HOME: homeDir },
      // No remote injected → will fail at resolveVersion, not at id validation
    });

    // Exit code is NOT 2 (which would mean "id non qualifié" validation error).
    // Could be 0 (success) or 1 (network error) — both are acceptable here.
    expect(code).not.toBe(2);
    const out = cap.lines.join('\n');
    // Must NOT emit "id non qualifié" error for a qualified id
    expect(out).not.toContain('unqualified id');
  });

  it('install b/skill:x (qualified) → does not emit unqualified-id error', async () => {
    // Same as above for source b.
    const cap = makeCapture();
    const code = await runCli(['install', 'b/skill:x', '--yes'], {
      print: cap.print,
      env: { RIGGER_HOME: homeDir },
    });

    expect(code).not.toBe(2);
    const out = cap.lines.join('\n');
    expect(out).not.toContain('unqualified id');
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Legacy catalogUrl config → R7: warning + empty catalog
// ---------------------------------------------------------------------------

describe('M4 — R7 legacy config: catalogUrl without catalogs[] triggers warning', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-m4-legacy-'));

    const configDir = path.join(homeDir, '.config', 'agent-rigger');
    await fs.mkdir(configDir, { recursive: true });
    // Write legacy config: has catalogUrl but no catalogs[]
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({
        catalogUrl: 'https://old.example.com/catalog.git',
        defaultScope: 'project',
      }),
      'utf8',
    );
  });

  afterEach(async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it('check returns exit code 0 (empty catalog) when legacy config detected', async () => {
    const cap = makeCapture();
    const code = await runCli(['check'], {
      print: cap.print,
      env: { RIGGER_HOME: homeDir },
    });
    expect(code).toBe(0);
  });

  it('warning message mentions legacy config and migration', async () => {
    const cap = makeCapture();
    await runCli(['check'], {
      print: cap.print,
      env: { RIGGER_HOME: homeDir },
    });
    const out = cap.lines.join('\n');
    expect(out).toContain('[warning]');
    expect(out).toMatch(/obsolète|rigger init/i);
  });

  it('ls returns exit code 0 (empty catalog) when legacy config detected', async () => {
    const cap = makeCapture();
    const code = await runCli(['ls'], {
      print: cap.print,
      env: { RIGGER_HOME: homeDir },
    });
    expect(code).toBe(0);
  });

  it('ls warning output mentions init migration', async () => {
    const cap = makeCapture();
    await runCli(['ls'], {
      print: cap.print,
      env: { RIGGER_HOME: homeDir },
    });
    const out = cap.lines.join('\n');
    // LegacyConfigError warning is emitted
    expect(out).toMatch(/obsolète|rigger init/i);
  });
});
