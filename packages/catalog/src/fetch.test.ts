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
 */

import { describe, expect, it } from 'bun:test';

import { listRemoteTags, RemoteFetchError, resolveVersion } from './fetch';
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
