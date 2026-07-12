/**
 * Tests for catalog/src/fetch.ts — remote git tag fetching and version resolution.
 *
 * TDD: tests written before implementation (RED → GREEN).
 *
 * All tests inject a fake CommandRunner — no real git or network calls.
 *
 * Coverage:
 *  - listRemoteTags: parsing mix of annotated (with ^{}) and lightweight tags
 *  - listRemoteTags: annotated tag sha peeled (^{}) preferred over object sha
 *  - listRemoteTags: deduplication by tag name
 *  - listRemoteTags: non-semver refs are filtered out
 *  - listRemoteTags: numeric sort (v1.10.0 > v1.2.0, v2.0.0 > v1.9.9)
 *  - listRemoteTags: prerelease is lower than release (v1.0.0 > v1.0.0-rc.1)
 *  - resolveVersion: returns largest semver tag when tags exist
 *  - resolveVersion: fallback to HEAD sha when no semver tags
 *  - RemoteFetchError: raised on exitCode !== 0, message contains stderr
 *  - fetchCatalog: valid catalog returns entries + sha
 *  - fetchCatalog: invalid entry triggers CatalogParseError
 *  - fetchCatalog: non-array catalog.json triggers CatalogParseError
 *  - fetchCatalog: absent catalog.json triggers CatalogParseError
 *  - fetchCatalog: invalid JSON triggers CatalogParseError
 *  - fetchCatalog: clone failure triggers RemoteFetchError + cleanup always called
 *  - fetchCatalog: cleanup always called on success
 *  - fetchCatalog: clone argv verified
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, mock } from 'bun:test';

import {
  type CatalogCanon,
  CatalogParseError,
  fetchCatalog,
  fetchCatalogCanon,
  InvalidRemoteRefError,
  InvalidRemoteUrlError,
  isUpdateAvailable,
  listRemoteTags,
  readCatalogDir,
  RemoteFetchError,
  type ResolvedVersion,
  resolveVersion,
  type TmpDirFactory,
  withRemoteCheckout,
} from './fetch';
import type { CommandRunner } from './tool-check';

// ---------------------------------------------------------------------------
// Fixture helpers — realistic git ls-remote output
// ---------------------------------------------------------------------------

const SHA_A = 'aabbccddeeff00112233445566778899aabbccdd';
const SHA_B = 'bbccddeeff00112233445566778899aabbccddee';
const SHA_C = 'ccddeeff00112233445566778899aabbccddeeff';
const SHA_D = 'ddeeff00112233445566778899aabbccddeeffaa';
const SHA_HEAD = 'ff00112233445566778899aabbccddeeffaabbcc';

/**
 * Builds a fake CommandRunner that returns the given stdout for any command.
 * Exits 0 by default.
 */
function makeRunner(stdout: string, exitCode = 0): CommandRunner {
  return (_cmd, _args) => Promise.resolve({ exitCode, stdout, stderr: '' });
}

/**
 * Builds a fake CommandRunner that fails with a given stderr message.
 */
function makeFailRunner(stderr: string): CommandRunner {
  return (_cmd, _args) => Promise.resolve({ exitCode: 1, stdout: '', stderr });
}

/**
 * Builds a CommandRunner that returns different outputs depending on whether
 * the args include "HEAD" (for resolveVersion fallback tests).
 */
function makeHeadFallbackRunner(tagsStdout: string, headSha: string): CommandRunner {
  return (_cmd, args) => {
    const isHead = args?.includes('HEAD') ?? false;
    if (isHead) {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${headSha}\tHEAD\n`,
        stderr: '',
      });
    }
    return Promise.resolve({ exitCode: 0, stdout: tagsStdout, stderr: '' });
  };
}

// ---------------------------------------------------------------------------
// Fixtures — git ls-remote --tags output samples
// ---------------------------------------------------------------------------

/** Lightweight tags only (no ^{} lines). */
const LIGHTWEIGHT_OUTPUT = [
  `${SHA_A}\trefs/tags/v1.0.0`,
  `${SHA_B}\trefs/tags/v1.2.0`,
  `${SHA_C}\trefs/tags/v1.10.0`,
].join('\n');

/** Mix of annotated tags (with ^{} peeled lines) and lightweight. */
const ANNOTATED_OUTPUT = [
  `${SHA_A}\trefs/tags/v1.0.0`,
  `${SHA_B}\trefs/tags/v1.0.0^{}`,
  `${SHA_C}\trefs/tags/v2.0.0`,
  `${SHA_D}\trefs/tags/v2.0.0^{}`,
].join('\n');

/** Contains a non-semver ref that must be filtered out. */
const WITH_NON_SEMVER = [
  `${SHA_A}\trefs/tags/v1.0.0`,
  `${SHA_B}\trefs/tags/latest`,
  `${SHA_C}\trefs/tags/nightly-build`,
  `${SHA_D}\trefs/tags/v2.0.0`,
].join('\n');

/** Prerelease mixed with release. */
const WITH_PRERELEASE = [
  `${SHA_A}\trefs/tags/v1.0.0-rc.1`,
  `${SHA_B}\trefs/tags/v1.0.0`,
  `${SHA_C}\trefs/tags/v1.0.0-beta.2`,
].join('\n');

/** Tags that exercise v-prefix stripping: v1.9.9 vs v2.0.0. */
const VERSION_SORT_OUTPUT = [
  `${SHA_A}\trefs/tags/v1.9.9`,
  `${SHA_B}\trefs/tags/v2.0.0`,
  `${SHA_C}\trefs/tags/v1.10.0`,
  `${SHA_D}\trefs/tags/v1.2.0`,
].join('\n');

/** Empty output — no tags at all. */
const EMPTY_OUTPUT = '';

// ---------------------------------------------------------------------------
// listRemoteTags — parsing lightweight tags
// ---------------------------------------------------------------------------

describe('listRemoteTags — lightweight tags parsed correctly', () => {
  it('returns one entry per tag', async () => {
    const tags = await listRemoteTags(
      'https://example.com/repo.git',
      makeRunner(LIGHTWEIGHT_OUTPUT),
    );
    expect(tags).toHaveLength(3);
  });

  it('tag names match refs/tags/<name> without prefix', async () => {
    const tags = await listRemoteTags(
      'https://example.com/repo.git',
      makeRunner(LIGHTWEIGHT_OUTPUT),
    );
    const names = tags.map((t) => t.tag);
    expect(names).toContain('v1.0.0');
    expect(names).toContain('v1.2.0');
    expect(names).toContain('v1.10.0');
  });

  it('sha matches the line sha', async () => {
    const tags = await listRemoteTags(
      'https://example.com/repo.git',
      makeRunner(LIGHTWEIGHT_OUTPUT),
    );
    const v100 = tags.find((t) => t.tag === 'v1.0.0');
    expect(v100?.sha).toBe(SHA_A);
  });
});

// ---------------------------------------------------------------------------
// listRemoteTags — annotated tags (peeled sha preferred)
// ---------------------------------------------------------------------------

describe('listRemoteTags — annotated tags: peeled sha preferred', () => {
  it('deduplicates by tag name — one entry per tag', async () => {
    const tags = await listRemoteTags('https://example.com/repo.git', makeRunner(ANNOTATED_OUTPUT));
    expect(tags).toHaveLength(2);
  });

  it('v1.0.0 sha is the peeled sha (from ^{} line)', async () => {
    const tags = await listRemoteTags('https://example.com/repo.git', makeRunner(ANNOTATED_OUTPUT));
    const v100 = tags.find((t) => t.tag === 'v1.0.0');
    expect(v100?.sha).toBe(SHA_B); // SHA_B is the ^{} (peeled) sha
  });

  it('v2.0.0 sha is the peeled sha', async () => {
    const tags = await listRemoteTags('https://example.com/repo.git', makeRunner(ANNOTATED_OUTPUT));
    const v200 = tags.find((t) => t.tag === 'v2.0.0');
    expect(v200?.sha).toBe(SHA_D); // SHA_D is the ^{} peeled sha
  });
});

// ---------------------------------------------------------------------------
// listRemoteTags — non-semver filtering
// ---------------------------------------------------------------------------

describe('listRemoteTags — non-semver refs are filtered out', () => {
  it('filters out "latest" tag', async () => {
    const tags = await listRemoteTags('https://example.com/repo.git', makeRunner(WITH_NON_SEMVER));
    const names = tags.map((t) => t.tag);
    expect(names).not.toContain('latest');
  });

  it('filters out "nightly-build" tag', async () => {
    const tags = await listRemoteTags('https://example.com/repo.git', makeRunner(WITH_NON_SEMVER));
    const names = tags.map((t) => t.tag);
    expect(names).not.toContain('nightly-build');
  });

  it('keeps only semver-valid tags', async () => {
    const tags = await listRemoteTags('https://example.com/repo.git', makeRunner(WITH_NON_SEMVER));
    expect(tags).toHaveLength(2);
    const names = tags.map((t) => t.tag);
    expect(names).toContain('v1.0.0');
    expect(names).toContain('v2.0.0');
  });
});

// ---------------------------------------------------------------------------
// listRemoteTags — semver sort (numeric, descending)
// ---------------------------------------------------------------------------

describe('listRemoteTags — numeric semver sort descending', () => {
  it('v2.0.0 comes first', async () => {
    const tags = await listRemoteTags(
      'https://example.com/repo.git',
      makeRunner(VERSION_SORT_OUTPUT),
    );
    expect(tags[0]?.tag).toBe('v2.0.0');
  });

  it('v1.10.0 sorts after v2.0.0 but before v1.9.9 (numeric, not lexical)', async () => {
    const tags = await listRemoteTags(
      'https://example.com/repo.git',
      makeRunner(VERSION_SORT_OUTPUT),
    );
    const names = tags.map((t) => t.tag);
    const idx110 = names.indexOf('v1.10.0');
    const idx199 = names.indexOf('v1.9.9');
    const idx200 = names.indexOf('v2.0.0');
    expect(idx200).toBeLessThan(idx110);
    expect(idx110).toBeLessThan(idx199);
  });

  it('v1.2.0 comes last', async () => {
    const tags = await listRemoteTags(
      'https://example.com/repo.git',
      makeRunner(VERSION_SORT_OUTPUT),
    );
    const names = tags.map((t) => t.tag);
    expect(names.at(-1)).toBe('v1.2.0');
  });
});

// ---------------------------------------------------------------------------
// listRemoteTags — prerelease ordering
// ---------------------------------------------------------------------------

describe('listRemoteTags — prerelease is lower than release', () => {
  it('v1.0.0 comes before v1.0.0-rc.1', async () => {
    const tags = await listRemoteTags('https://example.com/repo.git', makeRunner(WITH_PRERELEASE));
    const names = tags.map((t) => t.tag);
    const idxRelease = names.indexOf('v1.0.0');
    const idxRc = names.indexOf('v1.0.0-rc.1');
    expect(idxRelease).toBeLessThan(idxRc);
  });

  it('v1.0.0-beta.2 and v1.0.0-rc.1 are both below v1.0.0', async () => {
    const tags = await listRemoteTags('https://example.com/repo.git', makeRunner(WITH_PRERELEASE));
    const names = tags.map((t) => t.tag);
    const idxRelease = names.indexOf('v1.0.0');
    const idxBeta = names.indexOf('v1.0.0-beta.2');
    expect(idxRelease).toBeLessThan(idxBeta);
  });
});

// ---------------------------------------------------------------------------
// listRemoteTags — empty output
// ---------------------------------------------------------------------------

describe('listRemoteTags — empty output returns empty array', () => {
  it('returns [] when ls-remote has no lines', async () => {
    const tags = await listRemoteTags('https://example.com/repo.git', makeRunner(EMPTY_OUTPUT));
    expect(tags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resolveVersion — tag path
// ---------------------------------------------------------------------------

describe('resolveVersion — returns largest semver tag when tags exist', () => {
  it('returns isTag: true', async () => {
    const result = await resolveVersion(
      'https://example.com/repo.git',
      makeRunner(VERSION_SORT_OUTPUT),
    );
    expect(result.isTag).toBe(true);
  });

  it('returns ref = largest semver tag', async () => {
    const result = await resolveVersion(
      'https://example.com/repo.git',
      makeRunner(VERSION_SORT_OUTPUT),
    );
    expect(result.ref).toBe('v2.0.0');
  });

  it('returns sha of the largest tag', async () => {
    const result = await resolveVersion(
      'https://example.com/repo.git',
      makeRunner(VERSION_SORT_OUTPUT),
    );
    expect(result.sha).toBe(SHA_B); // SHA_B = v2.0.0 in VERSION_SORT_OUTPUT
  });
});

// ---------------------------------------------------------------------------
// resolveVersion — HEAD fallback
// ---------------------------------------------------------------------------

describe('resolveVersion — fallback to HEAD sha when no semver tags', () => {
  it('calls ls-remote HEAD when no tags found', async () => {
    const run = makeHeadFallbackRunner(EMPTY_OUTPUT, SHA_HEAD);
    const result = await resolveVersion('https://example.com/repo.git', run);
    expect(result.isTag).toBe(false);
  });

  it('returns sha from HEAD', async () => {
    const run = makeHeadFallbackRunner(EMPTY_OUTPUT, SHA_HEAD);
    const result = await resolveVersion('https://example.com/repo.git', run);
    expect(result.sha).toBe(SHA_HEAD);
  });

  it('returns ref = sha (not a tag name)', async () => {
    const run = makeHeadFallbackRunner(EMPTY_OUTPUT, SHA_HEAD);
    const result = await resolveVersion('https://example.com/repo.git', run);
    expect(result.ref).toBe(SHA_HEAD);
  });

  it('also falls back when all tags are non-semver', async () => {
    const nonSemverOnly = [
      `${SHA_A}\trefs/tags/latest`,
      `${SHA_B}\trefs/tags/nightly`,
    ].join('\n');
    const run = makeHeadFallbackRunner(nonSemverOnly, SHA_HEAD);
    const result = await resolveVersion('https://example.com/repo.git', run);
    expect(result.isTag).toBe(false);
    expect(result.sha).toBe(SHA_HEAD);
  });
});

// ---------------------------------------------------------------------------
// RemoteFetchError — raised on exitCode !== 0
// ---------------------------------------------------------------------------

describe('RemoteFetchError — raised when git exits non-zero', () => {
  const STDERR_MSG = 'fatal: repository not found';

  it('throws RemoteFetchError when runner exits 1', async () => {
    await expect(
      listRemoteTags('https://example.com/missing.git', makeFailRunner(STDERR_MSG)),
    ).rejects.toBeInstanceOf(RemoteFetchError);
  });

  it('error message contains the git stderr output', async () => {
    await expect(
      listRemoteTags('https://example.com/missing.git', makeFailRunner(STDERR_MSG)),
    ).rejects.toThrow(STDERR_MSG);
  });

  it('error carries the url property', async () => {
    const url = 'https://example.com/missing.git';
    try {
      await listRemoteTags(url, makeFailRunner(STDERR_MSG));
      expect(true).toBe(false); // should not reach here
    } catch (e) {
      expect(e).toBeInstanceOf(RemoteFetchError);
      expect((e as RemoteFetchError).url).toBe(url);
    }
  });

  it('resolveVersion also throws RemoteFetchError on git failure', async () => {
    await expect(
      resolveVersion('https://example.com/missing.git', makeFailRunner(STDERR_MSG)),
    ).rejects.toBeInstanceOf(RemoteFetchError);
  });
});

// ---------------------------------------------------------------------------
// fetchCatalog — helpers
// ---------------------------------------------------------------------------

const FIXED_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

/** Minimal valid artifact entry for catalog fixtures. */
const VALID_TOOL_ENTRY = {
  kind: 'artifact',
  id: 'tool:glab',
  nature: 'tool',
  targets: ['claude'],
  scopes: ['user'],
  level: 'required',
  check: 'which glab',
};

/** Minimal valid pack entry for catalog fixtures. */
const VALID_PACK_ENTRY = {
  kind: 'pack',
  id: 'pack:dev',
  targets: ['claude'],
  scopes: ['user'],
  members: ['tool:glab'],
};

/** Default meta block for test fixtures. */
const DEFAULT_META = { name: 'test-catalog' };

/**
 * Wraps an entries array into the `{meta,entries}` object expected by catalog.json.
 * Uses DEFAULT_META unless overridden.
 */
function wrapCatalog(
  entries: unknown[],
  meta: Record<string, unknown> = DEFAULT_META,
): string {
  return JSON.stringify({ meta, entries });
}

/**
 * Creates a real temp directory, writes the given file content to catalog.json
 * (or leaves it absent if content is undefined), and returns a TmpDirFactory
 * that yields that directory + a cleanup function.
 *
 * The cleanup function removes the directory. The test can spy on it.
 */
async function makeTmpFactory(catalogContent?: string): Promise<{
  factory: TmpDirFactory;
  cleanupSpy: ReturnType<typeof mock>;
  dirPath: () => string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'fetchcatalog-test-'));

  if (catalogContent !== undefined) {
    await writeFile(join(dir, 'catalog.json'), catalogContent, 'utf8');
  }

  const cleanupSpy = mock(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const resolvedDir = dir;
  return {
    factory: async () => ({ path: resolvedDir, cleanup: cleanupSpy as () => Promise<void> }),
    cleanupSpy,
    dirPath: () => resolvedDir,
  };
}

/**
 * Builds a CommandRunner for fetchCatalog / withRemoteCheckout tests.
 *
 * - git clone            → exits 0, records argv in `cloneCalls`
 * - git -C <p> rev-parse → exits 0 with FIXED_SHA  (fetchCatalog rev-parse)
 * - git -C <p> fetch     → exits 0  (sha-path fetch step)
 * - git -C <p> checkout  → exits 0  (sha-path checkout step)
 * - anything else        → exits 1
 *
 * Optional `allCalls` captures every non-clone `-C` call for argv assertions.
 */
function makeCloneRunner(cloneCalls: string[][] = [], allCalls: string[][] = []): CommandRunner {
  return (_cmd, args) => {
    const argv = args ?? [];
    if (argv[0] === 'clone') {
      cloneCalls.push(argv);
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argv[0] === '-C') {
      allCalls.push(argv);
      if (argv[2] === 'rev-parse') {
        return Promise.resolve({ exitCode: 0, stdout: `${FIXED_SHA}\n`, stderr: '' });
      }
      if (argv[2] === 'fetch' || argv[2] === 'checkout') {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
    }
    return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'unexpected command' });
  };
}

/** Runner where clone fails with a given stderr. */
function makeFailCloneRunner(stderr: string): CommandRunner {
  return (_cmd, args) => {
    const argv = args ?? [];
    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 1, stdout: '', stderr });
    }
    return Promise.resolve({ exitCode: 0, stdout: `${FIXED_SHA}\n`, stderr: '' });
  };
}

// ---------------------------------------------------------------------------
// fetchCatalog — valid catalog
// ---------------------------------------------------------------------------

describe('fetchCatalog — valid catalog returns entries and sha', () => {
  it('returns all validated entries', async () => {
    const catalog = wrapCatalog([VALID_TOOL_ENTRY, VALID_PACK_ENTRY]);
    const { factory } = await makeTmpFactory(catalog);
    const result = await fetchCatalog(
      'https://example.com/catalog.git',
      'v1.0.0',
      true,
      makeCloneRunner(),
      {
        tmpFactory: factory,
      },
    );
    expect(result.entries).toHaveLength(2);
  });

  it('returns the expected sha from rev-parse', async () => {
    const catalog = wrapCatalog([VALID_TOOL_ENTRY, VALID_PACK_ENTRY]);
    const { factory } = await makeTmpFactory(catalog);
    const result = await fetchCatalog(
      'https://example.com/catalog.git',
      'v1.0.0',
      true,
      makeCloneRunner(),
      {
        tmpFactory: factory,
      },
    );
    expect(result.sha).toBe(FIXED_SHA);
  });

  it('returns both tool and pack entries typed correctly', async () => {
    const catalog = wrapCatalog([VALID_TOOL_ENTRY, VALID_PACK_ENTRY]);
    const { factory } = await makeTmpFactory(catalog);
    const result = await fetchCatalog(
      'https://example.com/catalog.git',
      'v1.0.0',
      true,
      makeCloneRunner(),
      {
        tmpFactory: factory,
      },
    );
    expect(result.entries[0]?.kind).toBe('artifact');
    expect(result.entries[1]?.kind).toBe('pack');
  });

  it('returns meta from the catalog file', async () => {
    const catalog = wrapCatalog([VALID_TOOL_ENTRY], { name: 'my-catalog', required: ['pack:x'] });
    const { factory } = await makeTmpFactory(catalog);
    const result = await fetchCatalog(
      'https://example.com/catalog.git',
      'v1.0.0',
      true,
      makeCloneRunner(),
      { tmpFactory: factory },
    );
    expect(result.meta.name).toBe('my-catalog');
    expect(result.meta.required).toEqual(['pack:x']);
  });
});

// ---------------------------------------------------------------------------
// fetchCatalog — invalid entry → CatalogParseError
// ---------------------------------------------------------------------------

describe('fetchCatalog — invalid entry triggers CatalogParseError', () => {
  it('throws CatalogParseError when an entry has an unknown nature', async () => {
    const badEntry = { ...VALID_TOOL_ENTRY, nature: 'unknown-nature' };
    const catalog = wrapCatalog([badEntry]);
    const { factory } = await makeTmpFactory(catalog);
    await expect(
      fetchCatalog('https://example.com/catalog.git', 'v1.0.0', true, makeCloneRunner(), {
        tmpFactory: factory,
      }),
    ).rejects.toBeInstanceOf(CatalogParseError);
  });

  it('issues field is non-empty and mentions the problem', async () => {
    const badEntry = { ...VALID_TOOL_ENTRY, nature: 'unknown-nature' };
    const catalog = wrapCatalog([badEntry]);
    const { factory } = await makeTmpFactory(catalog);
    try {
      await fetchCatalog('https://example.com/catalog.git', 'v1.0.0', true, makeCloneRunner(), {
        tmpFactory: factory,
      });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(CatalogParseError);
      expect((e as CatalogParseError).issues.length).toBeGreaterThan(0);
      // At minimum issues describe index and a field problem
      expect((e as CatalogParseError).issues[0]).toMatch(/index 0/i);
    }
  });
});

// ---------------------------------------------------------------------------
// fetchCatalog — bare array catalog.json → CatalogParseError
// ---------------------------------------------------------------------------

describe('fetchCatalog — bare-array catalog.json triggers CatalogParseError', () => {
  it('throws CatalogParseError when catalog.json is a bare array (legacy format)', async () => {
    const catalog = JSON.stringify([VALID_TOOL_ENTRY]);
    const { factory } = await makeTmpFactory(catalog);
    await expect(
      fetchCatalog('https://example.com/catalog.git', 'v1.0.0', true, makeCloneRunner(), {
        tmpFactory: factory,
      }),
    ).rejects.toBeInstanceOf(CatalogParseError);
  });

  it('error message mentions wrapped object requirement', async () => {
    const catalog = JSON.stringify([VALID_TOOL_ENTRY]);
    const { factory } = await makeTmpFactory(catalog);
    try {
      await fetchCatalog('https://example.com/catalog.git', 'v1.0.0', true, makeCloneRunner(), {
        tmpFactory: factory,
      });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(CatalogParseError);
      expect((e as CatalogParseError).message).toMatch(/wrapp/i);
    }
  });
});

// ---------------------------------------------------------------------------
// fetchCatalog — missing meta.name → CatalogParseError
// ---------------------------------------------------------------------------

describe('fetchCatalog — missing meta.name triggers CatalogParseError', () => {
  it('throws CatalogParseError when meta.name is absent', async () => {
    const catalog = JSON.stringify({ meta: { required: [] }, entries: [VALID_TOOL_ENTRY] });
    const { factory } = await makeTmpFactory(catalog);
    await expect(
      fetchCatalog('https://example.com/catalog.git', 'v1.0.0', true, makeCloneRunner(), {
        tmpFactory: factory,
      }),
    ).rejects.toBeInstanceOf(CatalogParseError);
  });

  it('throws CatalogParseError when meta.name is empty string', async () => {
    const catalog = JSON.stringify({ meta: { name: '' }, entries: [VALID_TOOL_ENTRY] });
    const { factory } = await makeTmpFactory(catalog);
    await expect(
      fetchCatalog('https://example.com/catalog.git', 'v1.0.0', true, makeCloneRunner(), {
        tmpFactory: factory,
      }),
    ).rejects.toBeInstanceOf(CatalogParseError);
  });
});

// ---------------------------------------------------------------------------
// fetchCatalog — absent catalog.json → CatalogParseError
// ---------------------------------------------------------------------------

describe('fetchCatalog — absent catalog.json triggers CatalogParseError', () => {
  it('throws CatalogParseError when catalog.json does not exist', async () => {
    // Pass undefined so no catalog.json is written
    const { factory } = await makeTmpFactory(undefined);
    await expect(
      fetchCatalog('https://example.com/catalog.git', 'v1.0.0', true, makeCloneRunner(), {
        tmpFactory: factory,
      }),
    ).rejects.toBeInstanceOf(CatalogParseError);
  });

  it('error message mentions catalog.json being not found', async () => {
    const { factory } = await makeTmpFactory(undefined);
    try {
      await fetchCatalog('https://example.com/catalog.git', 'v1.0.0', true, makeCloneRunner(), {
        tmpFactory: factory,
      });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(CatalogParseError);
      expect((e as CatalogParseError).message).toMatch(/not found/i);
    }
  });
});

// ---------------------------------------------------------------------------
// fetchCatalog — invalid JSON → CatalogParseError
// ---------------------------------------------------------------------------

describe('fetchCatalog — invalid JSON triggers CatalogParseError', () => {
  it('throws CatalogParseError when catalog.json is broken JSON', async () => {
    const { factory } = await makeTmpFactory('{ this is not json }');
    await expect(
      fetchCatalog('https://example.com/catalog.git', 'v1.0.0', true, makeCloneRunner(), {
        tmpFactory: factory,
      }),
    ).rejects.toBeInstanceOf(CatalogParseError);
  });
});

// ---------------------------------------------------------------------------
// fetchCatalog — clone failure → RemoteFetchError + cleanup always called
// ---------------------------------------------------------------------------

describe('fetchCatalog — clone failure: RemoteFetchError and cleanup always called', () => {
  it('throws RemoteFetchError when clone exits 1', async () => {
    const { factory } = await makeTmpFactory(undefined);
    await expect(
      fetchCatalog(
        'https://example.com/catalog.git',
        'v1.0.0',
        true,
        makeFailCloneRunner('fatal: repository not found'),
        { tmpFactory: factory },
      ),
    ).rejects.toBeInstanceOf(RemoteFetchError);
  });

  it('cleanup is called even when clone fails', async () => {
    const { factory, cleanupSpy } = await makeTmpFactory(undefined);
    try {
      await fetchCatalog(
        'https://example.com/catalog.git',
        'v1.0.0',
        true,
        makeFailCloneRunner('fatal: repository not found'),
        { tmpFactory: factory },
      );
    } catch {
      // expected
    }
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it('tmp dir does not exist after clone failure (cleanup ran)', async () => {
    const { factory, dirPath } = await makeTmpFactory(wrapCatalog([]));
    try {
      await fetchCatalog(
        'https://example.com/catalog.git',
        'v1.0.0',
        true,
        makeFailCloneRunner('fatal: repository not found'),
        { tmpFactory: factory },
      );
    } catch {
      // expected
    }
    // After cleanup the directory should be gone
    const exists = await Bun.file(join(dirPath(), 'catalog.json')).exists();
    expect(exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchCatalog — cleanup called on success
// ---------------------------------------------------------------------------

describe('fetchCatalog — cleanup called on success', () => {
  it('cleanup spy is called exactly once on a successful fetch', async () => {
    const catalog = wrapCatalog([VALID_TOOL_ENTRY]);
    const { factory, cleanupSpy } = await makeTmpFactory(catalog);
    await fetchCatalog('https://example.com/catalog.git', 'v1.0.0', true, makeCloneRunner(), {
      tmpFactory: factory,
    });
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it('tmp dir does not exist after successful fetch (cleanup ran)', async () => {
    const catalog = wrapCatalog([VALID_TOOL_ENTRY]);
    const { factory, dirPath } = await makeTmpFactory(catalog);
    await fetchCatalog('https://example.com/catalog.git', 'v1.0.0', true, makeCloneRunner(), {
      tmpFactory: factory,
    });
    const exists = await Bun.file(join(dirPath(), 'catalog.json')).exists();
    expect(exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchCatalog — clone argv verification
// ---------------------------------------------------------------------------

describe('fetchCatalog — clone argv', () => {
  it('passes correct argv to git clone', async () => {
    const catalog = wrapCatalog([VALID_TOOL_ENTRY]);
    const { factory } = await makeTmpFactory(catalog);
    const cloneCalls: string[][] = [];
    await fetchCatalog(
      'https://example.com/catalog.git',
      'v1.2.3',
      true,
      makeCloneRunner(cloneCalls),
      { tmpFactory: factory },
    );
    expect(cloneCalls).toHaveLength(1);
    const argv = cloneCalls[0];
    // '--' must appear after the branch ref and before the URL to prevent option injection.
    expect(argv).toEqual([
      'clone',
      '--depth',
      '1',
      '--branch',
      'v1.2.3',
      '--',
      'https://example.com/catalog.git',
      expect.any(String),
    ]);
  });

  it('tmp path is the last argument to git clone', async () => {
    const catalog = wrapCatalog([VALID_TOOL_ENTRY]);
    const { factory, dirPath } = await makeTmpFactory(catalog);
    const cloneCalls: string[][] = [];
    await fetchCatalog(
      'https://example.com/catalog.git',
      'v1.2.3',
      true,
      makeCloneRunner(cloneCalls),
      { tmpFactory: factory },
    );
    const argv = cloneCalls[0] ?? [];
    expect(argv.at(-1)).toBe(dirPath());
  });
});

// ---------------------------------------------------------------------------
// assertSafeRemoteUrl / InvalidRemoteUrlError
// ---------------------------------------------------------------------------

/** No-op runner for URL validation tests — never actually called. */
const noop: CommandRunner = () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });

describe('assertSafeRemoteUrl — rejects dangerous URLs', () => {
  it('rejects ext:: transport (RCE vector)', async () => {
    await expect(
      listRemoteTags('ext::sh -c id', noop),
    ).rejects.toBeInstanceOf(InvalidRemoteUrlError);
  });

  it('rejects URL starting with -- (option injection)', async () => {
    await expect(
      listRemoteTags('--upload-pack=x', noop),
    ).rejects.toBeInstanceOf(InvalidRemoteUrlError);
  });

  it('rejects fd:: transport', async () => {
    await expect(listRemoteTags('fd::17', noop)).rejects.toBeInstanceOf(InvalidRemoteUrlError);
  });

  it('accepts https:// URL', async () => {
    const runner = makeRunner('');
    await expect(
      listRemoteTags('https://github.com/owner/repo.git', runner),
    ).resolves.toEqual([]);
  });

  it('accepts ssh:// URL', async () => {
    const runner = makeRunner('');
    await expect(
      listRemoteTags('ssh://git@github.com/owner/repo.git', runner),
    ).resolves.toEqual([]);
  });

  it('accepts SCP-style git@ URL', async () => {
    const runner = makeRunner('');
    await expect(
      listRemoteTags('git@github.com:owner/repo.git', runner),
    ).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// assertSafeRef / InvalidRemoteRefError — via fetchCatalog
// ---------------------------------------------------------------------------

describe('assertSafeRef — rejects dangerous refs', () => {
  it('rejects ref starting with -- (option injection)', async () => {
    const { factory } = await makeTmpFactory(wrapCatalog([VALID_TOOL_ENTRY]));
    await expect(
      fetchCatalog('https://example.com/catalog.git', '--foo', true, makeCloneRunner(), {
        tmpFactory: factory,
      }),
    ).rejects.toBeInstanceOf(InvalidRemoteRefError);
  });

  it('rejects empty ref', async () => {
    const { factory } = await makeTmpFactory(wrapCatalog([VALID_TOOL_ENTRY]));
    await expect(
      fetchCatalog('https://example.com/catalog.git', '', true, makeCloneRunner(), {
        tmpFactory: factory,
      }),
    ).rejects.toBeInstanceOf(InvalidRemoteRefError);
  });
});

// ---------------------------------------------------------------------------
// resolveVersion — HEAD sha vide → RemoteFetchError
// ---------------------------------------------------------------------------

/**
 * Runner that always exits 0 with empty stdout.
 * Simulates a remote that returns no tags AND returns an empty HEAD response.
 */
const emptyHeadRunner: CommandRunner = () =>
  Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });

describe('resolveVersion — empty HEAD sha triggers RemoteFetchError', () => {
  it('throws RemoteFetchError when HEAD ls-remote exits 0 but stdout is empty', async () => {
    await expect(
      resolveVersion('https://example.com/repo.git', emptyHeadRunner),
    ).rejects.toBeInstanceOf(RemoteFetchError);
  });

  it('error message mentions HEAD output being empty', async () => {
    try {
      await resolveVersion('https://example.com/repo.git', emptyHeadRunner);
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(RemoteFetchError);
      expect((e as RemoteFetchError).message).toMatch(/empty/i);
    }
  });
});

// ---------------------------------------------------------------------------
// fetchCatalog — rev-parse failure → RemoteFetchError + cleanup called
// ---------------------------------------------------------------------------

/**
 * Runner where clone succeeds but rev-parse exits 1.
 * Simulates a corrupted or incomplete clone.
 */
function makeRevParseFailRunner(): CommandRunner {
  return (_cmd, args) => {
    const argv = args ?? [];
    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'fatal: not a git repository' });
    }
    return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'unexpected' });
  };
}

describe('fetchCatalog — rev-parse failure triggers RemoteFetchError', () => {
  it('throws RemoteFetchError when rev-parse exits 1', async () => {
    const catalog = wrapCatalog([VALID_TOOL_ENTRY]);
    const { factory } = await makeTmpFactory(catalog);
    await expect(
      fetchCatalog('https://example.com/catalog.git', 'v1.0.0', true, makeRevParseFailRunner(), {
        tmpFactory: factory,
      }),
    ).rejects.toBeInstanceOf(RemoteFetchError);
  });

  it('cleanup is called exactly once when rev-parse fails', async () => {
    const catalog = wrapCatalog([VALID_TOOL_ENTRY]);
    const { factory, cleanupSpy } = await makeTmpFactory(catalog);
    try {
      await fetchCatalog(
        'https://example.com/catalog.git',
        'v1.0.0',
        true,
        makeRevParseFailRunner(),
        {
          tmpFactory: factory,
        },
      );
    } catch {
      // expected
    }
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// withRemoteCheckout
// ---------------------------------------------------------------------------

describe('withRemoteCheckout — callback receives checkoutDir', () => {
  it('passes the tmp path from tmpFactory to fn', async () => {
    const { factory, dirPath } = await makeTmpFactory(undefined);
    let receivedDir = '';
    await withRemoteCheckout(
      'https://example.com/repo.git',
      'v1.0.0',
      true,
      makeCloneRunner(),
      { tmpFactory: factory },
      async (dir) => {
        receivedDir = dir;
      },
    );
    expect(receivedDir).toBe(dirPath());
  });
});

describe('withRemoteCheckout — clone argv', () => {
  it('passes correct argv to git clone including -- separator', async () => {
    const { factory, dirPath } = await makeTmpFactory(undefined);
    const cloneCalls: string[][] = [];
    await withRemoteCheckout(
      'https://example.com/repo.git',
      'v2.3.4',
      true,
      makeCloneRunner(cloneCalls),
      { tmpFactory: factory },
      async () => {},
    );
    expect(cloneCalls).toHaveLength(1);
    expect(cloneCalls[0]).toEqual([
      'clone',
      '--depth',
      '1',
      '--branch',
      'v2.3.4',
      '--',
      'https://example.com/repo.git',
      dirPath(),
    ]);
  });
});

describe('withRemoteCheckout — clone failure: RemoteFetchError + cleanup', () => {
  it('throws RemoteFetchError when clone exits 1', async () => {
    const { factory } = await makeTmpFactory(undefined);
    await expect(
      withRemoteCheckout(
        'https://example.com/repo.git',
        'v1.0.0',
        true,
        makeFailCloneRunner('fatal: repo not found'),
        { tmpFactory: factory },
        async () => {},
      ),
    ).rejects.toBeInstanceOf(RemoteFetchError);
  });

  it('cleanup is called exactly once when clone fails', async () => {
    const { factory, cleanupSpy } = await makeTmpFactory(undefined);
    try {
      await withRemoteCheckout(
        'https://example.com/repo.git',
        'v1.0.0',
        true,
        makeFailCloneRunner('fatal: repo not found'),
        { tmpFactory: factory },
        async () => {},
      );
    } catch {
      // expected
    }
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });
});

describe('withRemoteCheckout — fn throws: error propagates + cleanup called', () => {
  it('propagates the error thrown by fn', async () => {
    const { factory } = await makeTmpFactory(undefined);
    await expect(
      withRemoteCheckout(
        'https://example.com/repo.git',
        'v1.0.0',
        true,
        makeCloneRunner(),
        { tmpFactory: factory },
        async () => {
          throw new Error('boom');
        },
      ),
    ).rejects.toThrow('boom');
  });

  it('cleanup is called exactly once when fn throws', async () => {
    const { factory, cleanupSpy } = await makeTmpFactory(undefined);
    try {
      await withRemoteCheckout(
        'https://example.com/repo.git',
        'v1.0.0',
        true,
        makeCloneRunner(),
        { tmpFactory: factory },
        async () => {
          throw new Error('boom');
        },
      );
    } catch {
      // expected
    }
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });
});

describe('withRemoteCheckout — invalid url/ref: error before tmpFactory called', () => {
  it('throws InvalidRemoteUrlError for ext:: transport without calling tmpFactory', async () => {
    const factorySpy = mock(async () => ({
      path: '/tmp/unused',
      cleanup: mock(async () => {}),
    }));
    await expect(
      withRemoteCheckout(
        'ext::sh -c x',
        'v1.0.0',
        true,
        makeCloneRunner(),
        { tmpFactory: factorySpy as TmpDirFactory },
        async () => {},
      ),
    ).rejects.toBeInstanceOf(InvalidRemoteUrlError);
    expect(factorySpy).not.toHaveBeenCalled();
  });

  it('throws InvalidRemoteRefError for ref starting with -- without calling tmpFactory', async () => {
    const factorySpy = mock(async () => ({
      path: '/tmp/unused',
      cleanup: mock(async () => {}),
    }));
    await expect(
      withRemoteCheckout(
        'https://example.com/repo.git',
        '--foo',
        true,
        makeCloneRunner(),
        { tmpFactory: factorySpy as TmpDirFactory },
        async () => {},
      ),
    ).rejects.toBeInstanceOf(InvalidRemoteRefError);
    expect(factorySpy).not.toHaveBeenCalled();
  });
});

describe('withRemoteCheckout — success: returns fn value + cleanup called', () => {
  it('returns the value returned by fn', async () => {
    const { factory } = await makeTmpFactory(undefined);
    const result = await withRemoteCheckout(
      'https://example.com/repo.git',
      'v1.0.0',
      true,
      makeCloneRunner(),
      { tmpFactory: factory },
      async () => 42,
    );
    expect(result).toBe(42);
  });

  it('cleanup is called exactly once on success', async () => {
    const { factory, cleanupSpy } = await makeTmpFactory(undefined);
    await withRemoteCheckout(
      'https://example.com/repo.git',
      'v1.0.0',
      true,
      makeCloneRunner(),
      { tmpFactory: factory },
      async () => {},
    );
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// withRemoteCheckout — isTag: false (sha path): clone + fetch + checkout
// ---------------------------------------------------------------------------

const SHA_COMMIT = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

/**
 * Builds a CommandRunner for the sha path (isTag: false).
 *
 * Records every call argv into `allCalls`.
 * - git clone              → exits 0
 * - git -C <p> fetch       → exits 0
 * - git -C <p> checkout    → exits 0
 * - git -C <p> rev-parse   → exits 0 with FIXED_SHA  (used by fetchCatalog)
 * - anything else          → exits 1
 */
function makeShaRunner(allCalls: string[][] = []): CommandRunner {
  return (_cmd, args) => {
    const argv = args ?? [];
    allCalls.push(argv);
    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argv[0] === '-C') {
      const sub = argv[2];
      if (sub === 'fetch' || sub === 'checkout' || sub === 'rev-parse') {
        return Promise.resolve({ exitCode: 0, stdout: `${FIXED_SHA}\n`, stderr: '' });
      }
    }
    return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'unexpected command' });
  };
}

/**
 * Builds a CommandRunner where the sha-path fetch step fails.
 */
function makeFailFetchRunner(stderr: string): CommandRunner {
  return (_cmd, args) => {
    const argv = args ?? [];
    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argv[0] === '-C' && argv[2] === 'fetch') {
      return Promise.resolve({ exitCode: 1, stdout: '', stderr });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };
}

/**
 * Builds a CommandRunner where the sha-path checkout step fails.
 */
function makeFailCheckoutRunner(stderr: string): CommandRunner {
  return (_cmd, args) => {
    const argv = args ?? [];
    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argv[0] === '-C' && argv[2] === 'fetch') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argv[0] === '-C' && argv[2] === 'checkout') {
      return Promise.resolve({ exitCode: 1, stdout: '', stderr });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };
}

describe('withRemoteCheckout — isTag:false (sha path) emits clone + fetch + checkout', () => {
  it('clones without --branch and then fetches the sha', async () => {
    const { factory, dirPath } = await makeTmpFactory(undefined);
    const allCalls: string[][] = [];
    await withRemoteCheckout(
      'https://example.com/repo.git',
      SHA_COMMIT,
      false,
      makeShaRunner(allCalls),
      { tmpFactory: factory },
      async () => {},
    );
    const cloneCall = allCalls.find((a) => a[0] === 'clone');
    expect(cloneCall).toEqual([
      'clone',
      '--depth',
      '1',
      '--',
      'https://example.com/repo.git',
      dirPath(),
    ]);
  });

  it('issues git fetch with the sha after clone', async () => {
    const { factory, dirPath } = await makeTmpFactory(undefined);
    const allCalls: string[][] = [];
    await withRemoteCheckout(
      'https://example.com/repo.git',
      SHA_COMMIT,
      false,
      makeShaRunner(allCalls),
      { tmpFactory: factory },
      async () => {},
    );
    const fetchCall = allCalls.find((a) => a[0] === '-C' && a[2] === 'fetch');
    expect(fetchCall).toEqual(['-C', dirPath(), 'fetch', '--depth', '1', 'origin', SHA_COMMIT]);
  });

  it('issues git checkout with the sha after fetch', async () => {
    const { factory, dirPath } = await makeTmpFactory(undefined);
    const allCalls: string[][] = [];
    await withRemoteCheckout(
      'https://example.com/repo.git',
      SHA_COMMIT,
      false,
      makeShaRunner(allCalls),
      { tmpFactory: factory },
      async () => {},
    );
    const checkoutCall = allCalls.find((a) => a[0] === '-C' && a[2] === 'checkout');
    expect(checkoutCall).toEqual(['-C', dirPath(), 'checkout', SHA_COMMIT]);
  });

  it('fn receives the checkout dir', async () => {
    const { factory, dirPath } = await makeTmpFactory(undefined);
    let received = '';
    await withRemoteCheckout(
      'https://example.com/repo.git',
      SHA_COMMIT,
      false,
      makeShaRunner(),
      { tmpFactory: factory },
      async (dir) => {
        received = dir;
      },
    );
    expect(received).toBe(dirPath());
  });

  it('cleanup is called on success', async () => {
    const { factory, cleanupSpy } = await makeTmpFactory(undefined);
    await withRemoteCheckout(
      'https://example.com/repo.git',
      SHA_COMMIT,
      false,
      makeShaRunner(),
      { tmpFactory: factory },
      async () => {},
    );
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });
});

describe('withRemoteCheckout — isTag:false: fetch failure throws RemoteFetchError + cleanup', () => {
  it('throws RemoteFetchError when fetch exits 1', async () => {
    const { factory } = await makeTmpFactory(undefined);
    await expect(
      withRemoteCheckout(
        'https://example.com/repo.git',
        SHA_COMMIT,
        false,
        makeFailFetchRunner('fatal: sha not found'),
        { tmpFactory: factory },
        async () => {},
      ),
    ).rejects.toBeInstanceOf(RemoteFetchError);
  });

  it('cleanup is called even when fetch fails', async () => {
    const { factory, cleanupSpy } = await makeTmpFactory(undefined);
    try {
      await withRemoteCheckout(
        'https://example.com/repo.git',
        SHA_COMMIT,
        false,
        makeFailFetchRunner('fatal: sha not found'),
        { tmpFactory: factory },
        async () => {},
      );
    } catch {
      // expected
    }
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });
});

describe('withRemoteCheckout — isTag:false: checkout failure throws RemoteFetchError + cleanup', () => {
  it('throws RemoteFetchError when checkout exits 1', async () => {
    const { factory } = await makeTmpFactory(undefined);
    await expect(
      withRemoteCheckout(
        'https://example.com/repo.git',
        SHA_COMMIT,
        false,
        makeFailCheckoutRunner('error: pathspec SHA did not match'),
        { tmpFactory: factory },
        async () => {},
      ),
    ).rejects.toBeInstanceOf(RemoteFetchError);
  });

  it('cleanup is called even when checkout fails', async () => {
    const { factory, cleanupSpy } = await makeTmpFactory(undefined);
    try {
      await withRemoteCheckout(
        'https://example.com/repo.git',
        SHA_COMMIT,
        false,
        makeFailCheckoutRunner('error: pathspec SHA did not match'),
        { tmpFactory: factory },
        async () => {},
      );
    } catch {
      // expected
    }
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });
});

describe('withRemoteCheckout — isTag:true (tag path) clone argv unchanged (non-regression)', () => {
  it('passes --branch <tag> to git clone', async () => {
    const { factory, dirPath } = await makeTmpFactory(undefined);
    const cloneCalls: string[][] = [];
    await withRemoteCheckout(
      'https://example.com/repo.git',
      'v3.0.0',
      true,
      makeCloneRunner(cloneCalls),
      { tmpFactory: factory },
      async () => {},
    );
    expect(cloneCalls).toHaveLength(1);
    expect(cloneCalls[0]).toEqual([
      'clone',
      '--depth',
      '1',
      '--branch',
      'v3.0.0',
      '--',
      'https://example.com/repo.git',
      dirPath(),
    ]);
  });
});

// ---------------------------------------------------------------------------
// readCatalogDir — standalone unit tests
// ---------------------------------------------------------------------------

/**
 * Creates a real temporary directory, writes `catalog.json` with the given content
 * (or leaves it absent when content is undefined), and returns the directory path.
 * The caller is responsible for cleanup via rm.
 */
async function makeReadCatalogDir(catalogContent?: string): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'readcatalogdir-test-'));
  if (catalogContent !== undefined) {
    await writeFile(join(dir, 'catalog.json'), catalogContent, 'utf8');
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe('readCatalogDir — valid catalog returns entries', () => {
  it('returns all validated entries from the directory', async () => {
    const catalog = wrapCatalog([VALID_TOOL_ENTRY, VALID_PACK_ENTRY]);
    const { dir, cleanup } = await makeReadCatalogDir(catalog);
    try {
      const { entries } = await readCatalogDir(dir);
      expect(entries).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  it('returns artifact entry typed correctly', async () => {
    const catalog = wrapCatalog([VALID_TOOL_ENTRY]);
    const { dir, cleanup } = await makeReadCatalogDir(catalog);
    try {
      const { entries } = await readCatalogDir(dir);
      expect(entries[0]?.kind).toBe('artifact');
    } finally {
      await cleanup();
    }
  });

  it('returns pack entry typed correctly', async () => {
    const catalog = wrapCatalog([VALID_PACK_ENTRY]);
    const { dir, cleanup } = await makeReadCatalogDir(catalog);
    try {
      const { entries } = await readCatalogDir(dir);
      expect(entries[0]?.kind).toBe('pack');
    } finally {
      await cleanup();
    }
  });

  it('returns empty entries array for empty entries list', async () => {
    const { dir, cleanup } = await makeReadCatalogDir(wrapCatalog([]));
    try {
      const { entries } = await readCatalogDir(dir);
      expect(entries).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it('returns meta with name from catalog file', async () => {
    const { dir, cleanup } = await makeReadCatalogDir(
      wrapCatalog([], { name: 'my-catalog' }),
    );
    try {
      const { meta } = await readCatalogDir(dir);
      expect(meta.name).toBe('my-catalog');
    } finally {
      await cleanup();
    }
  });

  it('meta.required defaults to [] when absent', async () => {
    const { dir, cleanup } = await makeReadCatalogDir(
      JSON.stringify({ meta: { name: 'test' }, entries: [] }),
    );
    try {
      const { meta } = await readCatalogDir(dir);
      expect(meta.required).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('meta.recommended defaults to [] when absent', async () => {
    const { dir, cleanup } = await makeReadCatalogDir(
      JSON.stringify({ meta: { name: 'test' }, entries: [] }),
    );
    try {
      const { meta } = await readCatalogDir(dir);
      expect(meta.recommended).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('accepts arbitrary ids (pack and artifact) in meta.required and meta.recommended', async () => {
    const catalog = JSON.stringify({
      meta: {
        name: 'test',
        required: ['pack:essentials', 'tool:glab', 'artifact:my-thing'],
        recommended: ['pack:extras', 'skill:remote-demo'],
      },
      entries: [],
    });
    const { dir, cleanup } = await makeReadCatalogDir(catalog);
    try {
      const { meta } = await readCatalogDir(dir);
      expect(meta.required).toEqual(['pack:essentials', 'tool:glab', 'artifact:my-thing']);
      expect(meta.recommended).toEqual(['pack:extras', 'skill:remote-demo']);
    } finally {
      await cleanup();
    }
  });
});

describe('readCatalogDir — absent catalog.json throws CatalogParseError', () => {
  it('throws CatalogParseError when catalog.json does not exist', async () => {
    const { dir, cleanup } = await makeReadCatalogDir(undefined);
    try {
      await expect(readCatalogDir(dir)).rejects.toBeInstanceOf(CatalogParseError);
    } finally {
      await cleanup();
    }
  });

  it('error message mentions not found', async () => {
    const { dir, cleanup } = await makeReadCatalogDir(undefined);
    try {
      await expect(readCatalogDir(dir)).rejects.toMatchObject({
        message: expect.stringMatching(/not found/i),
      });
    } finally {
      await cleanup();
    }
  });
});

describe('readCatalogDir — invalid JSON throws CatalogParseError', () => {
  it('throws CatalogParseError on broken JSON', async () => {
    const { dir, cleanup } = await makeReadCatalogDir('{ not valid json }');
    try {
      await expect(readCatalogDir(dir)).rejects.toBeInstanceOf(CatalogParseError);
    } finally {
      await cleanup();
    }
  });
});

describe('readCatalogDir — bare-array root throws CatalogParseError', () => {
  it('throws CatalogParseError when root is a bare array (legacy format)', async () => {
    const { dir, cleanup } = await makeReadCatalogDir(JSON.stringify([VALID_TOOL_ENTRY]));
    try {
      await expect(readCatalogDir(dir)).rejects.toBeInstanceOf(CatalogParseError);
    } finally {
      await cleanup();
    }
  });

  it('error message mentions wrapped object requirement', async () => {
    const { dir, cleanup } = await makeReadCatalogDir(JSON.stringify([VALID_TOOL_ENTRY]));
    try {
      await expect(readCatalogDir(dir)).rejects.toMatchObject({
        message: expect.stringMatching(/wrapp/i),
      });
    } finally {
      await cleanup();
    }
  });
});

describe('readCatalogDir — missing meta.name throws CatalogParseError', () => {
  it('throws CatalogParseError when meta is missing entirely', async () => {
    const { dir, cleanup } = await makeReadCatalogDir(JSON.stringify({ entries: [] }));
    try {
      await expect(readCatalogDir(dir)).rejects.toBeInstanceOf(CatalogParseError);
    } finally {
      await cleanup();
    }
  });

  it('throws CatalogParseError when meta.name is empty string', async () => {
    const { dir, cleanup } = await makeReadCatalogDir(
      JSON.stringify({ meta: { name: '' }, entries: [] }),
    );
    try {
      await expect(readCatalogDir(dir)).rejects.toBeInstanceOf(CatalogParseError);
    } finally {
      await cleanup();
    }
  });

  it('throws CatalogParseError when meta is present but name is absent', async () => {
    const { dir, cleanup } = await makeReadCatalogDir(
      JSON.stringify({ meta: { required: [] }, entries: [] }),
    );
    try {
      await expect(readCatalogDir(dir)).rejects.toBeInstanceOf(CatalogParseError);
    } finally {
      await cleanup();
    }
  });
});

describe('readCatalogDir — invalid entry throws CatalogParseError with issues', () => {
  it('throws CatalogParseError when an entry has an unknown nature', async () => {
    const badEntry = { ...VALID_TOOL_ENTRY, nature: 'unknown-nature' };
    const { dir, cleanup } = await makeReadCatalogDir(wrapCatalog([badEntry]));
    try {
      await expect(readCatalogDir(dir)).rejects.toBeInstanceOf(CatalogParseError);
    } finally {
      await cleanup();
    }
  });

  it('issues array is non-empty on validation failure', async () => {
    const badEntry = { ...VALID_TOOL_ENTRY, nature: 'unknown-nature' };
    const { dir, cleanup } = await makeReadCatalogDir(wrapCatalog([badEntry]));
    try {
      try {
        await readCatalogDir(dir);
        expect(true).toBe(false);
      } catch (e) {
        expect(e).toBeInstanceOf(CatalogParseError);
        expect((e as CatalogParseError).issues.length).toBeGreaterThan(0);
        expect((e as CatalogParseError).issues[0]).toMatch(/index 0/i);
      }
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// compareSemver — SemVer §11 prerelease ordering (via listRemoteTags sort)
// ---------------------------------------------------------------------------

/**
 * Helper: builds ls-remote output for a list of version strings and returns
 * the sorted tag names from listRemoteTags (descending, highest first).
 */
async function sortedTags(versions: string[]): Promise<string[]> {
  const sha = 'aabbccddeeff00112233445566778899aabbccdd';
  const stdout = versions.map((v) => `${sha}\trefs/tags/${v}`).join('\n');
  const tags = await listRemoteTags('https://example.com/repo.git', makeRunner(stdout));
  return tags.map((t) => t.tag);
}

describe('compareSemver — SemVer §11 strict prerelease ordering', () => {
  it('1.0.0-alpha < 1.0.0-alpha.1 (more identifiers wins)', async () => {
    const names = await sortedTags(['1.0.0-alpha', '1.0.0-alpha.1']);
    expect(names.indexOf('1.0.0-alpha.1')).toBeLessThan(names.indexOf('1.0.0-alpha'));
  });

  it('1.0.0-alpha.1 < 1.0.0-alpha.beta (numeric < alphanum)', async () => {
    const names = await sortedTags(['1.0.0-alpha.1', '1.0.0-alpha.beta']);
    expect(names.indexOf('1.0.0-alpha.beta')).toBeLessThan(names.indexOf('1.0.0-alpha.1'));
  });

  it('1.0.0-alpha.beta < 1.0.0-beta (lexical alpha < beta)', async () => {
    const names = await sortedTags(['1.0.0-alpha.beta', '1.0.0-beta']);
    expect(names.indexOf('1.0.0-beta')).toBeLessThan(names.indexOf('1.0.0-alpha.beta'));
  });

  it('1.0.0-beta < 1.0.0-beta.2 (more identifiers wins)', async () => {
    const names = await sortedTags(['1.0.0-beta', '1.0.0-beta.2']);
    expect(names.indexOf('1.0.0-beta.2')).toBeLessThan(names.indexOf('1.0.0-beta'));
  });

  it('1.0.0-beta.2 < 1.0.0-beta.11 (numeric comparison, not lexical)', async () => {
    const names = await sortedTags(['1.0.0-beta.2', '1.0.0-beta.11']);
    expect(names.indexOf('1.0.0-beta.11')).toBeLessThan(names.indexOf('1.0.0-beta.2'));
  });

  it('1.0.0-beta.11 < 1.0.0-rc.1 (lexical beta < rc)', async () => {
    const names = await sortedTags(['1.0.0-beta.11', '1.0.0-rc.1']);
    expect(names.indexOf('1.0.0-rc.1')).toBeLessThan(names.indexOf('1.0.0-beta.11'));
  });

  it('1.0.0-rc.1 < 1.0.0 (release beats prerelease)', async () => {
    const names = await sortedTags(['1.0.0-rc.1', '1.0.0']);
    expect(names.indexOf('1.0.0')).toBeLessThan(names.indexOf('1.0.0-rc.1'));
  });

  it('full §11 ordering in one sort: alpha < alpha.1 < alpha.beta < beta < beta.2 < beta.11 < rc.1 < release', async () => {
    const input = [
      '1.0.0-beta.11',
      '1.0.0',
      '1.0.0-alpha',
      '1.0.0-rc.1',
      '1.0.0-alpha.1',
      '1.0.0-beta.2',
      '1.0.0-beta',
      '1.0.0-alpha.beta',
    ];
    const names = await sortedTags(input);
    const expected = [
      '1.0.0',
      '1.0.0-rc.1',
      '1.0.0-beta.11',
      '1.0.0-beta.2',
      '1.0.0-beta',
      '1.0.0-alpha.beta',
      '1.0.0-alpha.1',
      '1.0.0-alpha',
    ];
    expect(names).toEqual(expected);
  });

  it('rc.10 > rc.2 (numeric comparison)', async () => {
    const names = await sortedTags(['1.0.0-rc.2', '1.0.0-rc.10']);
    expect(names.indexOf('1.0.0-rc.10')).toBeLessThan(names.indexOf('1.0.0-rc.2'));
  });

  it('alpha.10 > alpha.9 (numeric comparison)', async () => {
    const names = await sortedTags(['1.0.0-alpha.9', '1.0.0-alpha.10']);
    expect(names.indexOf('1.0.0-alpha.10')).toBeLessThan(names.indexOf('1.0.0-alpha.9'));
  });
});

// ---------------------------------------------------------------------------
// isUpdateAvailable
// ---------------------------------------------------------------------------

// `installedSha` is passed as '' throughout this section: these tests target
// the ref/semver comparison in isolation, which R2 (lot 6, D2) only reaches
// when the installed sha is unknown (the legacy path — see
// lot6-r2-update-sha.test.ts for the sha-aware comparison that now primes
// when `installedSha` is known).
describe('isUpdateAvailable — tag vs tag (installedSha unknown, legacy path)', () => {
  it('returns true when remote tag is newer (v1.0.0 installed, v1.1.0 remote)', () => {
    const remote = { ref: 'v1.1.0', sha: SHA_B, isTag: true };
    expect(isUpdateAvailable('v1.0.0', '', remote)).toBe(true);
  });

  it('returns false when remote tag equals installed (v1.2.0 == v1.2.0)', () => {
    const remote = { ref: 'v1.2.0', sha: SHA_B, isTag: true };
    expect(isUpdateAvailable('v1.2.0', '', remote)).toBe(false);
  });

  it('returns false when installed is newer than remote (v2.0.0 installed, v1.0.0 remote)', () => {
    const remote = { ref: 'v1.0.0', sha: SHA_A, isTag: true };
    expect(isUpdateAvailable('v2.0.0', '', remote)).toBe(false);
  });
});

describe('isUpdateAvailable — sha fallback path (installedSha unknown, legacy path)', () => {
  it('returns true when shas differ (installed sha A, remote sha B)', () => {
    const remote = { ref: SHA_B, sha: SHA_B, isTag: false };
    expect(isUpdateAvailable(SHA_A, '', remote)).toBe(true);
  });

  it('returns false when shas are identical', () => {
    const remote = { ref: SHA_A, sha: SHA_A, isTag: false };
    expect(isUpdateAvailable(SHA_A, '', remote)).toBe(false);
  });
});

describe('isUpdateAvailable — non-semver installed ref (installedSha unknown, legacy path)', () => {
  it('returns true when installed is a sha but remote is a semver tag', () => {
    // installed is a raw sha (non-semver) — falls back to ref/sha comparison
    const remote = { ref: 'v1.0.0', sha: SHA_B, isTag: true };
    expect(isUpdateAvailable(SHA_A, '', remote)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fetchCatalogCanon — canon reading inside withRemoteCheckout (T1, D1/D2)
//
// The canon reads the per-nature content files that catalog.json only points
// at: guardrails/<name>/deny.json + allow.json (claude form) and
// contexts/<name>/AGENTS.md. Same path resolution as the install builder
// (adapter-builder.ts), same missing-file semantics (deny strict, allow/AGENTS
// tolerant). mcp config stays inline in the entry — no file to read.
// ---------------------------------------------------------------------------

const CANON_URL = 'https://example.com/catalog.git';
const CANON_VERSION: ResolvedVersion = { ref: 'v1.0.0', sha: FIXED_SHA, isTag: true };

const MCP_CONFIG = { command: 'npx', args: ['-y', 'some-mcp-server'] };

/** Claude-targeted guardrail entry → deny.json + allow.json under guardrails/secu/. */
const GUARDRAIL_ENTRY = {
  kind: 'artifact',
  id: 'guardrail:secu',
  nature: 'guardrail',
  targets: ['claude'],
  scopes: ['user'],
};

/** Context entry → contexts/house/AGENTS.md. */
const CONTEXT_ENTRY = {
  kind: 'artifact',
  id: 'context:house',
  nature: 'context',
  targets: ['claude'],
  scopes: ['user'],
};

/** Mcp entry → config inline in catalog.json, no checkout file of its own. */
const MCP_ENTRY = {
  kind: 'artifact',
  id: 'mcp:github',
  nature: 'mcp',
  targets: ['claude'],
  scopes: ['user'],
  config: MCP_CONFIG,
};

/**
 * Builds a content-dir fixture: writes catalog.json plus the per-nature content
 * files at install-parity paths (guardrails/<name>/{deny,allow}.json,
 * contexts/<name>/AGENTS.md), then returns a TmpDirFactory yielding that dir.
 *
 * The fake clone runner (makeCloneRunner) never writes anything, so the files
 * placed here ARE the checkout content fetchCatalogCanon reads. `cleanupSpy`
 * removes the dir — a canon that survives it proves the content was read in
 * memory before the `finally`.
 */
async function makeContentDirFactory(files: {
  catalog?: string;
  guardrails?: Record<string, { deny?: string; allow?: string; permission?: string }>;
  contexts?: Record<string, string>;
}): Promise<{
  factory: TmpDirFactory;
  cleanupSpy: ReturnType<typeof mock>;
  dirPath: () => string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'fetchcanon-test-'));

  if (files.catalog !== undefined) {
    await writeFile(join(dir, 'catalog.json'), files.catalog, 'utf8');
  }

  for (const [name, g] of Object.entries(files.guardrails ?? {})) {
    const gdir = join(dir, 'guardrails', name);
    await mkdir(gdir, { recursive: true });
    if (g.deny !== undefined) await writeFile(join(gdir, 'deny.json'), g.deny, 'utf8');
    if (g.allow !== undefined) await writeFile(join(gdir, 'allow.json'), g.allow, 'utf8');
    if (g.permission !== undefined) {
      await writeFile(join(gdir, 'permission.json'), g.permission, 'utf8');
    }
  }

  for (const [name, content] of Object.entries(files.contexts ?? {})) {
    const cdir = join(dir, 'contexts', name);
    await mkdir(cdir, { recursive: true });
    await writeFile(join(cdir, 'AGENTS.md'), content, 'utf8');
  }

  const cleanupSpy = mock(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  return {
    factory: async () => ({ path: dir, cleanup: cleanupSpy as () => Promise<void> }),
    cleanupSpy,
    dirPath: () => dir,
  };
}

describe('fetchCatalogCanon — full canon: metadata, entries, guardrail + context content, mcp inline', () => {
  const FILES = {
    catalog: wrapCatalog([GUARDRAIL_ENTRY, CONTEXT_ENTRY, MCP_ENTRY]),
    guardrails: {
      secu: {
        deny: JSON.stringify({ deny: ['Bash(rm -rf /)'] }),
        allow: JSON.stringify({ allow: ['Read(*)'] }),
      },
    },
    contexts: { house: '# House rules\nBe careful.\n' },
  };

  it('carries the configured catalog name', async () => {
    const { factory } = await makeContentDirFactory(FILES);
    const canon: CatalogCanon = await fetchCatalogCanon(
      'my-cat',
      CANON_URL,
      CANON_VERSION,
      makeCloneRunner(),
      {
        tmpFactory: factory,
      },
    );
    expect(canon.name).toBe('my-cat');
  });

  it('carries the resolved version verbatim', async () => {
    const { factory } = await makeContentDirFactory(FILES);
    const canon = await fetchCatalogCanon('my-cat', CANON_URL, CANON_VERSION, makeCloneRunner(), {
      tmpFactory: factory,
    });
    expect(canon.version).toEqual(CANON_VERSION);
  });

  it('carries meta from catalog.json', async () => {
    const { factory } = await makeContentDirFactory(FILES);
    const canon = await fetchCatalogCanon('my-cat', CANON_URL, CANON_VERSION, makeCloneRunner(), {
      tmpFactory: factory,
    });
    expect(canon.meta.name).toBe('test-catalog');
  });

  it('carries all entries', async () => {
    const { factory } = await makeContentDirFactory(FILES);
    const canon = await fetchCatalogCanon('my-cat', CANON_URL, CANON_VERSION, makeCloneRunner(), {
      tmpFactory: factory,
    });
    expect(canon.entries).toHaveLength(3);
  });

  it('reads guardrail deny + allow keyed by entry id', async () => {
    const { factory } = await makeContentDirFactory(FILES);
    const canon = await fetchCatalogCanon('my-cat', CANON_URL, CANON_VERSION, makeCloneRunner(), {
      tmpFactory: factory,
    });
    expect(canon.guardrails.get('guardrail:secu')).toEqual({
      deny: ['Bash(rm -rf /)'],
      allow: ['Read(*)'],
    });
  });

  it('reads context AGENTS.md keyed by entry id', async () => {
    const { factory } = await makeContentDirFactory(FILES);
    const canon = await fetchCatalogCanon('my-cat', CANON_URL, CANON_VERSION, makeCloneRunner(), {
      tmpFactory: factory,
    });
    expect(canon.contexts.get('context:house')).toBe('# House rules\nBe careful.\n');
  });

  it('keeps mcp config inline in entries', async () => {
    const { factory } = await makeContentDirFactory(FILES);
    const canon = await fetchCatalogCanon('my-cat', CANON_URL, CANON_VERSION, makeCloneRunner(), {
      tmpFactory: factory,
    });
    const mcp = canon.entries.find((e) => e.id === 'mcp:github');
    expect(mcp).toMatchObject({ kind: 'artifact', config: MCP_CONFIG });
  });

  it('content survives checkout cleanup (read in memory before finally)', async () => {
    const { factory, cleanupSpy } = await makeContentDirFactory(FILES);
    const canon = await fetchCatalogCanon('my-cat', CANON_URL, CANON_VERSION, makeCloneRunner(), {
      tmpFactory: factory,
    });
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(canon.guardrails.get('guardrail:secu')?.deny).toEqual(['Bash(rm -rf /)']);
    expect(canon.contexts.get('context:house')).toContain('House rules');
  });
});

describe('fetchCatalogCanon — guardrail without allow.json → allow defaults to []', () => {
  it('returns deny rules with an empty allow list', async () => {
    const { factory } = await makeContentDirFactory({
      catalog: wrapCatalog([GUARDRAIL_ENTRY]),
      guardrails: { secu: { deny: JSON.stringify({ deny: ['Bash(x)'] }) } },
    });
    const canon = await fetchCatalogCanon('c', CANON_URL, CANON_VERSION, makeCloneRunner(), {
      tmpFactory: factory,
    });
    expect(canon.guardrails.get('guardrail:secu')).toEqual({ deny: ['Bash(x)'], allow: [] });
  });
});

describe('fetchCatalogCanon — context without AGENTS.md → empty string (install parity)', () => {
  it('returns an empty string for the context entry', async () => {
    const { factory } = await makeContentDirFactory({
      catalog: wrapCatalog([CONTEXT_ENTRY]),
    });
    const canon = await fetchCatalogCanon('c', CANON_URL, CANON_VERSION, makeCloneRunner(), {
      tmpFactory: factory,
    });
    expect(canon.contexts.get('context:house')).toBe('');
  });
});

describe('fetchCatalogCanon — mcp config stays inline (no separate file read)', () => {
  it('preserves the mcp config verbatim and adds no guardrail/context entries', async () => {
    const { factory } = await makeContentDirFactory({ catalog: wrapCatalog([MCP_ENTRY]) });
    const canon = await fetchCatalogCanon('c', CANON_URL, CANON_VERSION, makeCloneRunner(), {
      tmpFactory: factory,
    });
    expect(canon.entries).toMatchObject([{ id: 'mcp:github', config: MCP_CONFIG }]);
    expect(canon.guardrails.size).toBe(0);
    expect(canon.contexts.size).toBe(0);
  });
});

describe('fetchCatalogCanon — claude guardrail with absent/empty deny.json fails closed (install parity)', () => {
  it('throws CatalogParseError when deny.json is absent for a claude guardrail', async () => {
    const { factory } = await makeContentDirFactory({
      catalog: wrapCatalog([GUARDRAIL_ENTRY]),
      guardrails: { secu: { allow: JSON.stringify({ allow: [] }) } },
    });
    await expect(
      fetchCatalogCanon('c', CANON_URL, CANON_VERSION, makeCloneRunner(), { tmpFactory: factory }),
    ).rejects.toBeInstanceOf(CatalogParseError);
  });

  it('throws CatalogParseError when the deny array is empty', async () => {
    const { factory } = await makeContentDirFactory({
      catalog: wrapCatalog([GUARDRAIL_ENTRY]),
      guardrails: { secu: { deny: JSON.stringify({ deny: [] }) } },
    });
    await expect(
      fetchCatalogCanon('c', CANON_URL, CANON_VERSION, makeCloneRunner(), { tmpFactory: factory }),
    ).rejects.toBeInstanceOf(CatalogParseError);
  });
});

describe('fetchCatalogCanon — opencode guardrail reads permission.json (native descriptor)', () => {
  const OC_PERMISSION = { read: { '.env': 'deny' }, bash: { 'rm -rf *': 'deny' } } as const;
  const OPENCODE_GUARDRAIL = { ...GUARDRAIL_ENTRY, id: 'guardrail:oc', targets: ['opencode'] };

  it('populates guardrailPermissions by entry id, not the claude deny/allow map', async () => {
    const { factory } = await makeContentDirFactory({
      catalog: wrapCatalog([OPENCODE_GUARDRAIL]),
      guardrails: { oc: { permission: JSON.stringify({ permission: OC_PERMISSION }) } },
    });
    const canon = await fetchCatalogCanon('c', CANON_URL, CANON_VERSION, makeCloneRunner(), {
      tmpFactory: factory,
    });
    expect(canon.guardrails.size).toBe(0);
    expect(canon.guardrailPermissions.get('guardrail:oc')).toEqual(OC_PERMISSION);
  });

  it('throws CatalogParseError when permission.json is absent (install parity, fail-closed)', async () => {
    const { factory } = await makeContentDirFactory({
      catalog: wrapCatalog([OPENCODE_GUARDRAIL]),
    });
    await expect(
      fetchCatalogCanon('c', CANON_URL, CANON_VERSION, makeCloneRunner(), { tmpFactory: factory }),
    ).rejects.toBeInstanceOf(CatalogParseError);
  });

  it('throws CatalogParseError when the permission object is empty', async () => {
    const { factory } = await makeContentDirFactory({
      catalog: wrapCatalog([OPENCODE_GUARDRAIL]),
      guardrails: { oc: { permission: JSON.stringify({ permission: {} }) } },
    });
    await expect(
      fetchCatalogCanon('c', CANON_URL, CANON_VERSION, makeCloneRunner(), { tmpFactory: factory }),
    ).rejects.toBeInstanceOf(CatalogParseError);
  });

  it('a guardrail targeting BOTH assistants populates both canon maps', async () => {
    const bothGuardrail = {
      ...GUARDRAIL_ENTRY,
      id: 'guardrail:both',
      targets: ['claude', 'opencode'],
    };
    const { factory } = await makeContentDirFactory({
      catalog: wrapCatalog([bothGuardrail]),
      guardrails: {
        both: {
          deny: JSON.stringify({ deny: ['Bash(rm -rf /)'] }),
          allow: JSON.stringify({ allow: [] }),
          permission: JSON.stringify({ permission: OC_PERMISSION }),
        },
      },
    });
    const canon = await fetchCatalogCanon('c', CANON_URL, CANON_VERSION, makeCloneRunner(), {
      tmpFactory: factory,
    });
    expect(canon.guardrails.get('guardrail:both')).toEqual({ deny: ['Bash(rm -rf /)'], allow: [] });
    expect(canon.guardrailPermissions.get('guardrail:both')).toEqual(OC_PERMISSION);
  });
});

describe('fetchCatalogCanon — clone failure fails closed with cleanup (fail-closed, D1)', () => {
  it('throws RemoteFetchError and still runs cleanup when clone fails', async () => {
    const { factory, cleanupSpy } = await makeContentDirFactory({
      catalog: wrapCatalog([MCP_ENTRY]),
    });
    await expect(
      fetchCatalogCanon(
        'c',
        CANON_URL,
        CANON_VERSION,
        makeFailCloneRunner('fatal: repo not found'),
        {
          tmpFactory: factory,
        },
      ),
    ).rejects.toBeInstanceOf(RemoteFetchError);
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });
});
