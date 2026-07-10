/**
 * Tests for E1 — post-init catalog proposal in runInit.
 *
 * Isolation: tmp dir per test. All I/O injected.
 *   - fetchCatalogFn: injected async fn (url) => { meta, entries }
 *   - proposeInstall: injected async fn (catalog) => ids-to-install
 *   - No real TTY, no real network, no process.exit.
 *
 * Scenarios:
 * E1-1  TTY mode: both injectables provided → proposeInstall called with catalog, ids returned.
 * E1-2  Non-TTY mode: neither injectable provided → config only, no install.
 * E1-3  Picker cancelled (proposeInstall returns []) → config conserved, no install.
 * E1-4  fetchCatalogFn throws post-config → actionable message, config conserved.
 * E1-5  required ids present in meta forwarded to proposeInstall.
 * E1-6  proposeInstall NOT called when auth fails (ok:false).
 * E1-7  buildInitialSelection + enforceRequired pure helpers.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, CatalogMeta } from '@agent-rigger/catalog';

import { buildInitialSelection, enforceRequired, runInit } from '../src/cmd-init';
import { loadConfigFile } from '../src/config';
import type { CommandRunner } from '../src/preflight-auth';

// ---------------------------------------------------------------------------
// Helpers / fakes
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-e1-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const URL = 'https://github.com/org/catalog.git';

/** CommandRunner that always returns exit 0. */
const runOk: CommandRunner = async () => ({ exitCode: 0, stdout: '', stderr: '' });
/** CommandRunner that always returns exit 1. */
const runFail: CommandRunner = async () => ({ exitCode: 1, stdout: '', stderr: 'auth error' });

function makeAskUrl(url: string = URL): () => Promise<string> {
  return () => Promise.resolve(url);
}

const askNeverCalled = () => {
  throw new Error('askMethod should not be called');
};

// ---------------------------------------------------------------------------
// Catalog fixtures
// ---------------------------------------------------------------------------

const META: CatalogMeta = {
  name: 'test-catalog',
  required: ['tool:git'],
  recommended: ['skill:code-review'],
};

const ENTRIES: CatalogEntry[] = [
  {
    kind: 'artifact',
    id: 'tool:git',
    nature: 'tool',
    targets: ['claude'],
    scopes: ['user'],
  },
  {
    kind: 'artifact',
    id: 'skill:code-review',
    nature: 'skill',
    targets: ['claude'],
    scopes: ['user'],
  },
  {
    kind: 'artifact',
    id: 'plugin:glab',
    nature: 'plugin',
    targets: ['claude'],
    scopes: ['user'],
  },
];

/** Fake fetchCatalogFn that returns the fixture catalog. */
const fakeFetchCatalog = async (
  _url: string,
): Promise<{ meta: CatalogMeta; entries: CatalogEntry[]; sourceName: string }> => ({
  meta: META,
  entries: ENTRIES,
  sourceName: 'test-catalog',
});

// ---------------------------------------------------------------------------
// E1-1 — TTY mode: both injectables provided → proposeInstall called with catalog
// ---------------------------------------------------------------------------

describe('E1-1 — TTY mode: proposeInstall called after successful config persist', () => {
  it('calls proposeInstall with the fetched catalog', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');
    let capturedCatalog: { meta: CatalogMeta; entries: CatalogEntry[] } | undefined;

    await runInit({
      configPath,
      askUrl: makeAskUrl(),
      askMethod: askNeverCalled,
      run: runOk,
      fetchCatalogFn: fakeFetchCatalog,
      proposeInstall: async (catalog) => {
        capturedCatalog = catalog;
        return [];
      },
    });

    expect(capturedCatalog).toBeDefined();
    expect(capturedCatalog?.meta.name).toBe('test-catalog');
    expect(capturedCatalog?.entries).toHaveLength(3);
  });

  it('fetchCatalogFn receives the configured catalogUrl', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');
    let receivedUrl: string | undefined;

    await runInit({
      configPath,
      askUrl: makeAskUrl(URL),
      askMethod: askNeverCalled,
      run: runOk,
      fetchCatalogFn: async (url) => {
        receivedUrl = url;
        return { meta: META, entries: ENTRIES, sourceName: 'test-catalog' };
      },
      proposeInstall: async () => [],
    });

    expect(receivedUrl).toBe(URL);
  });

  it('result ok:true when proposeInstall is called', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');
    const result = await runInit({
      configPath,
      askUrl: makeAskUrl(),
      askMethod: askNeverCalled,
      run: runOk,
      fetchCatalogFn: fakeFetchCatalog,
      proposeInstall: async () => [],
    });

    expect(result.ok).toBe(true);
  });

  it('config is persisted regardless of proposeInstall result', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');

    await runInit({
      configPath,
      askUrl: makeAskUrl(),
      askMethod: askNeverCalled,
      run: runOk,
      fetchCatalogFn: fakeFetchCatalog,
      proposeInstall: async () => ['tool:git', 'skill:code-review'],
    });

    const saved = await loadConfigFile(configPath);
    expect(saved.catalogs?.[0]?.url).toBe(URL);
  });
});

// ---------------------------------------------------------------------------
// E1-2 — Non-TTY mode: no injectables → config only, no install
// ---------------------------------------------------------------------------

describe('E1-2 — Non-TTY mode: no proposeInstall → config persisted, no install', () => {
  it('config is persisted when no proposeInstall provided', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');

    const result = await runInit({
      configPath,
      askUrl: makeAskUrl(),
      askMethod: askNeverCalled,
      run: runOk,
      // proposeInstall and fetchCatalogFn deliberately absent
    });

    expect(result.ok).toBe(true);
    const saved = await loadConfigFile(configPath);
    expect(saved.catalogs?.[0]?.url).toBe(URL);
  });

  it('output contains catalogUrl when non-interactive', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');

    const result = await runInit({
      configPath,
      askUrl: makeAskUrl(),
      askMethod: askNeverCalled,
      run: runOk,
    });

    expect(result.output).toContain(URL);
  });

  it('proposeInstall with fetchCatalogFn absent is not called', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');
    let proposeWasCalled = false;

    await runInit({
      configPath,
      askUrl: makeAskUrl(),
      askMethod: askNeverCalled,
      run: runOk,
      // fetchCatalogFn absent → no proposal even if proposeInstall is set
      proposeInstall: async () => {
        proposeWasCalled = true;
        return [];
      },
    });

    expect(proposeWasCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// E1-3 — Picker cancelled: proposeInstall returns [] → config conserved, no install
// ---------------------------------------------------------------------------

describe('E1-3 — Picker cancelled: empty selection → config conserved, no install', () => {
  it('config is conserved when proposeInstall returns empty array', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');

    const result = await runInit({
      configPath,
      askUrl: makeAskUrl(),
      askMethod: askNeverCalled,
      run: runOk,
      fetchCatalogFn: fakeFetchCatalog,
      proposeInstall: async () => [],
    });

    expect(result.ok).toBe(true);
    const saved = await loadConfigFile(configPath);
    expect(saved.catalogs?.[0]?.url).toBe(URL);
  });

  it('ok:true when picker returns empty ids (cancel scenario)', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');

    const result = await runInit({
      configPath,
      askUrl: makeAskUrl(),
      askMethod: askNeverCalled,
      run: runOk,
      fetchCatalogFn: fakeFetchCatalog,
      proposeInstall: async () => [],
    });

    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// E1-4 — fetchCatalogFn throws post-config → actionable message, config conserved
// ---------------------------------------------------------------------------

describe('E1-4 — fetchCatalogFn fails post-config → config conserved, actionable message', () => {
  it('config is persisted even when fetchCatalogFn throws', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');

    const result = await runInit({
      configPath,
      askUrl: makeAskUrl(),
      askMethod: askNeverCalled,
      run: runOk,
      fetchCatalogFn: async () => {
        throw new Error('network unreachable');
      },
      proposeInstall: async () => [],
    });

    // Config must be saved
    const saved = await loadConfigFile(configPath);
    expect(saved.catalogs?.[0]?.url).toBe(URL);
    // Still ok:true — config was saved, the install step failed but non-fatally
    expect(result.ok).toBe(true);
  });

  it('output contains actionable message when fetchCatalogFn throws', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');

    const result = await runInit({
      configPath,
      askUrl: makeAskUrl(),
      askMethod: askNeverCalled,
      run: runOk,
      fetchCatalogFn: async () => {
        throw new Error('network unreachable');
      },
      proposeInstall: async () => [],
    });

    // Output should mention install retry or catalog
    const output = result.output.toLowerCase();
    expect(output.includes('install') || output.includes('catalog')).toBe(true);
  });

  it('config is persisted even when proposeInstall itself throws', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');

    const result = await runInit({
      configPath,
      askUrl: makeAskUrl(),
      askMethod: askNeverCalled,
      run: runOk,
      fetchCatalogFn: fakeFetchCatalog,
      proposeInstall: async () => {
        throw new Error('install crashed');
      },
    });

    const saved = await loadConfigFile(configPath);
    expect(saved.catalogs?.[0]?.url).toBe(URL);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// E1-5 — required ids forwarded to proposeInstall via catalog.meta
// ---------------------------------------------------------------------------

describe('E1-5 — catalog.meta.required forwarded to proposeInstall', () => {
  it('proposeInstall receives catalog with required ids in meta', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');
    let seenMeta: CatalogMeta | undefined;

    await runInit({
      configPath,
      askUrl: makeAskUrl(),
      askMethod: askNeverCalled,
      run: runOk,
      fetchCatalogFn: fakeFetchCatalog,
      proposeInstall: async (catalog) => {
        seenMeta = catalog.meta;
        return [];
      },
    });

    expect(seenMeta?.required).toEqual(['tool:git']);
    expect(seenMeta?.recommended).toEqual(['skill:code-review']);
  });

  it('proposeInstall receives all entries including required+recommended+rest', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');
    let seenEntries: CatalogEntry[] | undefined;

    await runInit({
      configPath,
      askUrl: makeAskUrl(),
      askMethod: askNeverCalled,
      run: runOk,
      fetchCatalogFn: fakeFetchCatalog,
      proposeInstall: async (catalog) => {
        seenEntries = catalog.entries;
        return [];
      },
    });

    const ids = seenEntries?.map((e) => e.id) ?? [];
    expect(ids).toContain('tool:git');
    expect(ids).toContain('skill:code-review');
    expect(ids).toContain('plugin:glab');
  });
});

// ---------------------------------------------------------------------------
// E1-6 — proposeInstall NOT called when auth fails
// ---------------------------------------------------------------------------

describe('E1-6 — proposeInstall not called when auth fails', () => {
  it('proposeInstall is not invoked when ok:false', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');
    let proposeWasCalled = false;
    let fetchWasCalled = false;

    const result = await runInit({
      configPath,
      askUrl: makeAskUrl(),
      askMethod: () => Promise.resolve('https' as const),
      run: runFail,
      fetchCatalogFn: async () => {
        fetchWasCalled = true;
        return { meta: META, entries: ENTRIES, sourceName: 'test-catalog' };
      },
      proposeInstall: async () => {
        proposeWasCalled = true;
        return [];
      },
    });

    expect(result.ok).toBe(false);
    expect(fetchWasCalled).toBe(false);
    expect(proposeWasCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// E1-7 — buildInitialSelection + enforceRequired pure helpers (exported)
// ---------------------------------------------------------------------------

describe('E1-7 — buildInitialSelection pure helper', () => {
  it('marks required ids as initially selected', () => {
    const required = new Set(['tool:git']);
    const recommended = new Set(['skill:code-review']);

    const { initial, requiredSet } = buildInitialSelection(ENTRIES, { required, recommended });

    expect(initial).toContain('tool:git');
    expect(requiredSet.has('tool:git')).toBe(true);
  });

  it('marks recommended ids as initially selected', () => {
    const required = new Set<string>();
    const recommended = new Set(['skill:code-review']);

    const { initial } = buildInitialSelection(ENTRIES, { required, recommended });

    expect(initial).toContain('skill:code-review');
  });

  it('does not pre-select entries that are neither required nor recommended', () => {
    const required = new Set(['tool:git']);
    const recommended = new Set(['skill:code-review']);

    const { initial } = buildInitialSelection(ENTRIES, { required, recommended });

    expect(initial).not.toContain('plugin:glab');
  });

  it('requiredSet contains only required ids, not recommended', () => {
    const required = new Set(['tool:git']);
    const recommended = new Set(['skill:code-review']);

    const { requiredSet } = buildInitialSelection(ENTRIES, { required, recommended });

    expect(requiredSet.has('tool:git')).toBe(true);
    expect(requiredSet.has('skill:code-review')).toBe(false);
  });
});

describe('E1-7 — enforceRequired pure helper', () => {
  it('re-adds required ids that were unchecked', () => {
    const required = new Set(['tool:git']);
    // User unchecked tool:git
    const selected = ['skill:code-review'];
    const result = enforceRequired(selected, required);

    expect(result).toContain('tool:git');
    expect(result).toContain('skill:code-review');
  });

  it('deduplicates when required id already in selection', () => {
    const required = new Set(['tool:git']);
    const selected = ['tool:git', 'skill:code-review'];
    const result = enforceRequired(selected, required);

    expect(result.filter((id) => id === 'tool:git')).toHaveLength(1);
  });

  it('keeps non-required selected ids intact', () => {
    const required = new Set(['tool:git']);
    const selected = ['skill:code-review', 'plugin:glab'];
    const result = enforceRequired(selected, required);

    expect(result).toContain('skill:code-review');
    expect(result).toContain('plugin:glab');
    expect(result).toContain('tool:git');
  });

  it('returns empty array when no selection and no required', () => {
    const result = enforceRequired([], new Set());
    expect(result).toEqual([]);
  });
});
