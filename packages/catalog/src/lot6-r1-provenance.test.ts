/**
 * lot6-r1-provenance.test.ts — R1: the manifest records the commit that is
 * actually installed (design D1).
 *
 * TDD: written before the implementation (RED → GREEN).
 *
 * `withRemoteCheckout` (and, by forwarding, `fetchCatalog`) gain an optional
 * `expectedSha` on `opts`. When provided, a `git -C <checkout> rev-parse HEAD`
 * is run right after clone/checkout and compared to `expectedSha` — the
 * *peeled* commit sha `parseLsRemoteTags`/`resolveVersion` already resolve.
 * A mismatch throws `RefShaMismatchError` (a `RemoteFetchError` subtype, so
 * existing `instanceof RemoteFetchError` handling still catches it) BEFORE
 * the callback (`fn`) runs and BEFORE cleanup skips — nothing is installed,
 * nothing is written.
 *
 * Coverage:
 *  - Branch-homonym-of-a-tag collision, reproduced with a REAL local git repo
 *    (not mocked): `git clone --branch <name>` prefers refs/heads over
 *    refs/tags — the exact vector R1 closes.
 *  - TOCTOU (tag re-pushed between ls-remote and clone), simulated with a
 *    fake CommandRunner: ls-remote resolved sha_A, the checkout's HEAD is
 *    sha_B.
 *  - Annotated tag: the *peeled* sha is what gets compared — no false
 *    positive when expectedSha is already the peeled commit sha (which is
 *    exactly what resolveVersion/listRemoteTags supply).
 *  - Nominal: manifest sha === checkout's rev-parse HEAD, no error.
 *  - Check applies on BOTH the isTag and the sha (HEAD fallback) code paths —
 *    "one branch to reason about" (D1), no special-casing.
 *  - Back-compat: `expectedSha` omitted → no check performed (existing
 *    behaviour of every current caller, unchanged).
 *  - fetchCatalog forwards `opts.expectedSha` to withRemoteCheckout.
 *  - RefShaMismatchError shape: ref / expectedSha / foundSha / url, and
 *    `instanceof RemoteFetchError`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import {
  CatalogParseError,
  fetchCatalog,
  RefShaMismatchError,
  RemoteFetchError,
  resolveVersion,
  type TmpDirFactory,
  withRemoteCheckout,
} from './fetch';
import { defaultRunner } from './tool-check';
import type { CommandRunner } from './tool-check';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SHA_A = 'aabbccddeeff00112233445566778899aabbccdd';
const SHA_B = 'bbccddeeff00112233445566778899aabbccddee';

/** Real TmpDirFactory — a genuine mkdtemp'd directory, cleaned up via rm. */
function makeRealTmpFactory(): { factory: TmpDirFactory; getCleanupCalled: () => boolean } {
  let cleanupCalled = false;
  const factory: TmpDirFactory = async () => {
    const path = await mkdtemp(join(tmpdir(), 'lot6-r1-'));
    return {
      path,
      cleanup: async () => {
        cleanupCalled = true;
        await rm(path, { recursive: true, force: true });
      },
    };
  };
  return { factory, getCleanupCalled: () => cleanupCalled };
}

/**
 * Builds a fake CommandRunner for withRemoteCheckout's tag path (isTag:
 * true), returning a fixed `rev-parse HEAD` sha regardless of the clone argv
 * — the simplest way to simulate "the checkout landed on a different commit
 * than the one ls-remote resolved".
 */
function makeFixedHeadRunner(headSha: string): CommandRunner {
  return (_cmd, args) => {
    const argv = args ?? [];
    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${headSha}\n`, stderr: '' });
    }
    if (argv[0] === '-C' && (argv[2] === 'fetch' || argv[2] === 'checkout')) {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'unexpected command' });
  };
}

// ---------------------------------------------------------------------------
// Real-git fixture: branch homonymous with a tag — install refused
// ---------------------------------------------------------------------------

/**
 * Builds a real local git repo with:
 *  - commit A, tagged `v1.2.3` (lightweight tag)
 *  - commit B, on top, with a BRANCH also named `v1.2.3`
 * `git clone --branch v1.2.3` resolves to the branch (commit B) — the
 * exact ambiguity reproduced empirically in the requirements deep-map.
 * gpgsign is disabled explicitly so the fixture is deterministic
 * regardless of the host's global git config.
 */
async function makeHomonymRepo(): Promise<{ repoDir: string; shaA: string; shaB: string }> {
  const repoDir = await mkdtemp(join(tmpdir(), 'lot6-r1-homonym-repo-'));
  const cfg = ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false'];

  await defaultRunner('git', [...cfg, '-C', repoDir, 'init', '--quiet', '-b', 'main']);
  await defaultRunner('git', ['-C', repoDir, 'config', 'user.email', 'lot6-r1@example.com']);
  await defaultRunner('git', ['-C', repoDir, 'config', 'user.name', 'lot6-r1']);

  await Bun.write(join(repoDir, 'file.txt'), 'A');
  await defaultRunner('git', [...cfg, '-C', repoDir, 'add', '.']);
  await defaultRunner('git', [...cfg, '-C', repoDir, 'commit', '-q', '-m', 'commit A']);
  const shaAResult = await defaultRunner('git', ['-C', repoDir, 'rev-parse', 'HEAD']);
  const shaA = (shaAResult.stdout ?? '').trim();
  await defaultRunner('git', [...cfg, '-C', repoDir, 'tag', 'v1.2.3']);

  await Bun.write(join(repoDir, 'file.txt'), 'B');
  await defaultRunner('git', [...cfg, '-C', repoDir, 'add', '.']);
  await defaultRunner('git', [...cfg, '-C', repoDir, 'commit', '-q', '-m', 'commit B']);
  const shaBResult = await defaultRunner('git', ['-C', repoDir, 'rev-parse', 'HEAD']);
  const shaB = (shaBResult.stdout ?? '').trim();
  // Branch v1.2.3 -> commit B, homonymous with the tag v1.2.3 -> commit A.
  await defaultRunner('git', [...cfg, '-C', repoDir, 'branch', 'v1.2.3']);

  return { repoDir, shaA, shaB };
}

describe('lot6-R1: branch homonymous with a tag — real git fixture', () => {
  it('rejects with RefShaMismatchError when the branch wins the clone', async () => {
    const { repoDir, shaA } = await makeHomonymRepo();
    const { factory } = makeRealTmpFactory();
    try {
      await expect(
        withRemoteCheckout(
          repoDir,
          'v1.2.3',
          true,
          defaultRunner,
          { tmpFactory: factory, expectedSha: shaA },
          async () => 'should not run',
        ),
      ).rejects.toBeInstanceOf(RefShaMismatchError);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it('the error names the ref and both shas (expected = tag commit A, found = branch commit B)', async () => {
    const { repoDir, shaA, shaB } = await makeHomonymRepo();
    const { factory } = makeRealTmpFactory();
    try {
      let caught: unknown;
      try {
        await withRemoteCheckout(
          repoDir,
          'v1.2.3',
          true,
          defaultRunner,
          { tmpFactory: factory, expectedSha: shaA },
          async () => 'should not run',
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(RefShaMismatchError);
      const err = caught as RefShaMismatchError;
      expect(err.ref).toBe('v1.2.3');
      expect(err.expectedSha).toBe(shaA);
      expect(err.foundSha).toBe(shaB);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it('nothing is installed — fn is never called', async () => {
    const { repoDir, shaA } = await makeHomonymRepo();
    const { factory } = makeRealTmpFactory();
    let fnCalled = false;
    try {
      await withRemoteCheckout(
        repoDir,
        'v1.2.3',
        true,
        defaultRunner,
        { tmpFactory: factory, expectedSha: shaA },
        async () => {
          fnCalled = true;
          return undefined;
        },
      ).catch(() => {
        // expected
      });
      expect(fnCalled).toBe(false);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it('cleanup still runs (no orphaned checkout on disk)', async () => {
    const { repoDir, shaA } = await makeHomonymRepo();
    const { factory, getCleanupCalled } = makeRealTmpFactory();
    try {
      await withRemoteCheckout(
        repoDir,
        'v1.2.3',
        true,
        defaultRunner,
        { tmpFactory: factory, expectedSha: shaA },
        async () => undefined,
      ).catch(() => {
        // expected
      });
      expect(getCleanupCalled()).toBe(true);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it('no mismatch (expectedSha matches the resolved branch commit) — succeeds', async () => {
    // Sanity check: same repo, but expectedSha now matches what --branch actually
    // resolves to (commit B) — proves the check isn't a blanket rejection of the
    // homonym setup, only of an actual mismatch.
    const { repoDir, shaB } = await makeHomonymRepo();
    const { factory } = makeRealTmpFactory();
    try {
      const result = await withRemoteCheckout(
        repoDir,
        'v1.2.3',
        true,
        defaultRunner,
        { tmpFactory: factory, expectedSha: shaB },
        async () => 'installed',
      );
      expect(result).toBe('installed');
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// TOCTOU: tag re-pushed between ls-remote and clone (simulated, fake runner)
// ---------------------------------------------------------------------------

describe('lot6-R1: TOCTOU — tag re-pushed between resolution and clone', () => {
  it('rejects when the checkout HEAD differs from the sha ls-remote resolved', async () => {
    // ls-remote resolved sha_A (expectedSha); by the time the clone completes,
    // the checkout is on sha_B (tag re-pushed mid-flight).
    const { factory } = makeRealTmpFactory();
    await expect(
      withRemoteCheckout(
        'https://example.com/repo.git',
        'v1.2.3',
        true,
        makeFixedHeadRunner(SHA_B),
        { tmpFactory: factory, expectedSha: SHA_A },
        async () => 'should not run',
      ),
    ).rejects.toBeInstanceOf(RefShaMismatchError);
  });

  it('nothing is written: fn never runs on TOCTOU mismatch', async () => {
    const { factory } = makeRealTmpFactory();
    let fnCalled = false;
    await withRemoteCheckout(
      'https://example.com/repo.git',
      'v1.2.3',
      true,
      makeFixedHeadRunner(SHA_B),
      { tmpFactory: factory, expectedSha: SHA_A },
      async () => {
        fnCalled = true;
        return undefined;
      },
    ).catch(() => {
      // expected
    });
    expect(fnCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Annotated tag: peeled sha compared — no false positive
// ---------------------------------------------------------------------------

describe('lot6-R1: annotated tag — peeled sha, no false positive', () => {
  const SHA_ANNOTATED_TAG_OBJECT = 'ccddeeff00112233445566778899aabbccddeeff';
  const SHA_PEELED_COMMIT = 'ddeeff00112233445566778899aabbccddeeffaa';

  it('resolveVersion already returns the peeled (commit) sha for an annotated tag', async () => {
    // parseLsRemoteTags prefers the ^{} peeled line — resolveVersion's .sha is
    // already the commit sha, never the tag object sha.
    const annotatedLsRemote = [
      `${SHA_ANNOTATED_TAG_OBJECT}\trefs/tags/v1.0.0`,
      `${SHA_PEELED_COMMIT}\trefs/tags/v1.0.0^{}`,
    ].join('\n');
    const runner: CommandRunner = (_cmd, _args) =>
      Promise.resolve({ exitCode: 0, stdout: annotatedLsRemote, stderr: '' });

    const version = await resolveVersion('https://example.com/repo.git', runner);
    expect(version.sha).toBe(SHA_PEELED_COMMIT);
    expect(version.sha).not.toBe(SHA_ANNOTATED_TAG_OBJECT);
  });

  it('checkout succeeds when the checkout HEAD equals the peeled commit sha (no false positive)', async () => {
    const { factory } = makeRealTmpFactory();
    const result = await withRemoteCheckout(
      'https://example.com/repo.git',
      'v1.0.0',
      true,
      makeFixedHeadRunner(SHA_PEELED_COMMIT),
      { tmpFactory: factory, expectedSha: SHA_PEELED_COMMIT },
      async () => 'installed',
    );
    expect(result).toBe('installed');
  });

  it('checkout still rejects if HEAD were the tag OBJECT sha instead of peeled (defense check works both ways)', async () => {
    const { factory } = makeRealTmpFactory();
    await expect(
      withRemoteCheckout(
        'https://example.com/repo.git',
        'v1.0.0',
        true,
        makeFixedHeadRunner(SHA_ANNOTATED_TAG_OBJECT),
        { tmpFactory: factory, expectedSha: SHA_PEELED_COMMIT },
        async () => 'should not run',
      ),
    ).rejects.toBeInstanceOf(RefShaMismatchError);
  });
});

// ---------------------------------------------------------------------------
// Nominal: manifest sha === rev-parse HEAD
// ---------------------------------------------------------------------------

describe('lot6-R1: nominal — manifest sha equals the checkout HEAD', () => {
  it('succeeds and returns fn value when expectedSha matches HEAD (tag path)', async () => {
    const { factory } = makeRealTmpFactory();
    const result = await withRemoteCheckout(
      'https://example.com/repo.git',
      'v1.2.3',
      true,
      makeFixedHeadRunner(SHA_A),
      { tmpFactory: factory, expectedSha: SHA_A },
      async (dir) => `installed at ${dir}`,
    );
    expect(result).toContain('installed at');
  });
});

// ---------------------------------------------------------------------------
// Systematic check: applies on the sha (HEAD fallback) path too
// ---------------------------------------------------------------------------

/**
 * Fake runner for the sha path: clone (no --branch) + fetch + checkout +
 * rev-parse HEAD all succeed; rev-parse HEAD returns `headSha`.
 */
function makeShaPathRunner(headSha: string): CommandRunner {
  return (_cmd, args) => {
    const argv = args ?? [];
    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argv[0] === '-C' && (argv[2] === 'fetch' || argv[2] === 'checkout')) {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${headSha}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'unexpected command' });
  };
}

describe('lot6-R1: check is systematic — sha (isTag:false) path included', () => {
  it('passes when HEAD equals expectedSha on the sha (HEAD-fallback) path', async () => {
    const { factory } = makeRealTmpFactory();
    const result = await withRemoteCheckout(
      'https://example.com/repo.git',
      SHA_A,
      false,
      makeShaPathRunner(SHA_A),
      { tmpFactory: factory, expectedSha: SHA_A },
      async () => 'installed',
    );
    expect(result).toBe('installed');
  });

  it('rejects with RefShaMismatchError when HEAD differs on the sha (HEAD-fallback) path (defense in depth)', async () => {
    const { factory } = makeRealTmpFactory();
    await expect(
      withRemoteCheckout(
        'https://example.com/repo.git',
        SHA_A,
        false,
        makeShaPathRunner(SHA_B),
        { tmpFactory: factory, expectedSha: SHA_A },
        async () => 'should not run',
      ),
    ).rejects.toBeInstanceOf(RefShaMismatchError);
  });
});

// ---------------------------------------------------------------------------
// Back-compat: expectedSha omitted → no check performed
// ---------------------------------------------------------------------------

describe('lot6-R1: back-compat — expectedSha omitted skips the check entirely', () => {
  it('succeeds even when the (unchecked) HEAD would have mismatched an arbitrary sha', async () => {
    const { factory } = makeRealTmpFactory();
    const result = await withRemoteCheckout(
      'https://example.com/repo.git',
      'v1.2.3',
      true,
      makeFixedHeadRunner(SHA_B),
      { tmpFactory: factory }, // no expectedSha — legacy call shape, unchanged behaviour
      async () => 'installed without a check',
    );
    expect(result).toBe('installed without a check');
  });
});

// ---------------------------------------------------------------------------
// RefShaMismatchError — shape
// ---------------------------------------------------------------------------

describe('lot6-R1: RefShaMismatchError — typed error shape', () => {
  it('is an instance of RemoteFetchError (existing instanceof checks keep working)', () => {
    const err = new RefShaMismatchError('https://example.com/repo.git', 'v1.2.3', SHA_A, SHA_B);
    expect(err).toBeInstanceOf(RemoteFetchError);
  });

  it('is also an instance of RefShaMismatchError specifically', () => {
    const err = new RefShaMismatchError('https://example.com/repo.git', 'v1.2.3', SHA_A, SHA_B);
    expect(err).toBeInstanceOf(RefShaMismatchError);
  });

  it('carries ref, expectedSha, foundSha, and url', () => {
    const err = new RefShaMismatchError('https://example.com/repo.git', 'v1.2.3', SHA_A, SHA_B);
    expect(err.ref).toBe('v1.2.3');
    expect(err.expectedSha).toBe(SHA_A);
    expect(err.foundSha).toBe(SHA_B);
    expect(err.url).toBe('https://example.com/repo.git');
  });

  it('the message names the ref and both shas', () => {
    const err = new RefShaMismatchError('https://example.com/repo.git', 'v1.2.3', SHA_A, SHA_B);
    expect(err.message).toContain('v1.2.3');
    expect(err.message).toContain(SHA_A);
    expect(err.message).toContain(SHA_B);
  });

  it('name is RefShaMismatchError, not the inherited RemoteFetchError', () => {
    const err = new RefShaMismatchError('https://example.com/repo.git', 'v1.2.3', SHA_A, SHA_B);
    expect(err.name).toBe('RefShaMismatchError');
  });
});

// ---------------------------------------------------------------------------
// fetchCatalog — forwards expectedSha to withRemoteCheckout
// ---------------------------------------------------------------------------

/** Runner: clone succeeds, rev-parse HEAD returns a fixed sha. */
function makeFetchCatalogRunner(headSha: string): CommandRunner {
  return (_cmd, args) => {
    const argv = args ?? [];
    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${headSha}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'unexpected command' });
  };
}

describe('lot6-R1: fetchCatalog forwards expectedSha', () => {
  const VALID_TOOL_ENTRY = {
    kind: 'artifact',
    id: 'tool:glab',
    nature: 'tool',
    targets: ['claude'],
    scopes: ['user'],
    level: 'required',
    check: 'which glab',
  };

  async function makeCatalogTmpFactory(): Promise<TmpDirFactory> {
    return async () => {
      const dir = await mkdtemp(join(tmpdir(), 'lot6-r1-fetchcatalog-'));
      await Bun.write(
        join(dir, 'catalog.json'),
        JSON.stringify({ meta: { name: 'test-catalog' }, entries: [VALID_TOOL_ENTRY] }),
      );
      return { path: dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
    };
  }

  it('succeeds when expectedSha matches the clone HEAD', async () => {
    const tmpFactory = await makeCatalogTmpFactory();
    const result = await fetchCatalog(
      'https://example.com/catalog.git',
      'v1.0.0',
      true,
      makeFetchCatalogRunner(SHA_A),
      { tmpFactory, expectedSha: SHA_A },
    );
    expect(result.sha).toBe(SHA_A);
    expect(result.entries).toHaveLength(1);
  });

  it('rejects with RefShaMismatchError when expectedSha mismatches, before catalog.json is even parsed', async () => {
    const tmpFactory = await makeCatalogTmpFactory();
    await expect(
      fetchCatalog(
        'https://example.com/catalog.git',
        'v1.0.0',
        true,
        makeFetchCatalogRunner(SHA_B),
        { tmpFactory, expectedSha: SHA_A },
      ),
    ).rejects.toBeInstanceOf(RefShaMismatchError);
  });

  it('rejects with RefShaMismatchError, not CatalogParseError, on mismatch (provenance checked before parse)', async () => {
    const tmpFactory = await makeCatalogTmpFactory();
    await expect(
      fetchCatalog(
        'https://example.com/catalog.git',
        'v1.0.0',
        true,
        makeFetchCatalogRunner(SHA_B),
        { tmpFactory, expectedSha: SHA_A },
      ),
    ).rejects.not.toBeInstanceOf(CatalogParseError);
  });

  it('back-compat: fetchCatalog without expectedSha behaves exactly as before', async () => {
    const tmpFactory = await makeCatalogTmpFactory();
    const result = await fetchCatalog(
      'https://example.com/catalog.git',
      'v1.0.0',
      true,
      makeFetchCatalogRunner(SHA_B),
      { tmpFactory },
    );
    expect(result.sha).toBe(SHA_B);
    expect(result.entries).toHaveLength(1);
  });
});
