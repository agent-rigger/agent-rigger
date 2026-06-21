/**
 * Tests for cli/src/remote.ts — fetchRemoteCatalog + mergeCatalogs.
 *
 * All network/git I/O is stubbed via injected run + tmpFactory.
 * No real git processes are spawned.
 */

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import { type CatalogEntry, RemoteFetchError, type TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';

import { CatalogUrlMissingError, fetchRemoteCatalog, mergeCatalogs } from '../src/remote';

// ---------------------------------------------------------------------------
// Module-level runners (no outer scope captures — extracted per lint)
// ---------------------------------------------------------------------------

/** A CommandRunner that always fails with exit code 1. */
const alwaysFailRunner: CommandRunner = (_cmd, _args) =>
  Promise.resolve({ exitCode: 1, stdout: '', stderr: 'permission denied' });

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const SHA = 'aabbccddeeff00112233445566778899aabbccdd';

/** Minimal valid CatalogEntry for testing. */
function makeEntry(id: string): CatalogEntry {
  return {
    kind: 'artifact',
    id,
    nature: 'skill',
    source: 'external',
    targets: ['claude'],
    scopes: ['user'],
  };
}

/**
 * Builds a fake TmpDirFactory that writes a catalog.json file in a real
 * temporary directory via Bun.write, then cleans up properly.
 * The path string is controlled by the test.
 */
function makeFakeTmpFactory(
  dir: string,
  catalogJson: unknown,
): TmpDirFactory {
  return async () => {
    // Write the catalog.json into the provided dir
    await Bun.write(join(dir, 'catalog.json'), JSON.stringify(catalogJson));
    return {
      path: dir,
      cleanup: async () => {},
    };
  };
}

/**
 * Builds a CommandRunner that:
 * - For `git ls-remote --tags <url>` → returns the given tags stdout.
 * - For `git clone ...` → returns exitCode 0 (catalog written by tmpFactory).
 * - For `git -C <tmp> rev-parse HEAD` → returns SHA.
 * - For `git ls-remote <url> HEAD` → HEAD fallback (used only when no tags).
 */
function makeRunner(tagsStdout: string, cloneExitCode = 0): CommandRunner {
  return (_cmd, args) => {
    const argsArr = args ?? [];

    // HEAD fallback: ls-remote <url> HEAD
    if (argsArr.includes('HEAD') && argsArr.includes('ls-remote')) {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${SHA}\tHEAD\n`,
        stderr: '',
      });
    }

    // ls-remote --tags
    if (argsArr.includes('ls-remote')) {
      return Promise.resolve({ exitCode: 0, stdout: tagsStdout, stderr: '' });
    }

    // git clone
    if (argsArr.includes('clone')) {
      return Promise.resolve({
        exitCode: cloneExitCode,
        stdout: '',
        stderr: cloneExitCode === 0 ? '' : 'auth error',
      });
    }

    // git rev-parse HEAD
    if (argsArr.includes('rev-parse')) {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\n`, stderr: '' });
    }

    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };
}

// ---------------------------------------------------------------------------
// fetchRemoteCatalog — CatalogUrlMissingError
// ---------------------------------------------------------------------------

describe('fetchRemoteCatalog — missing url', () => {
  it('throws CatalogUrlMissingError when catalogUrl is undefined', async () => {
    await expect(
      fetchRemoteCatalog({ catalogUrl: undefined }),
    ).rejects.toBeInstanceOf(CatalogUrlMissingError);
  });

  it('throws CatalogUrlMissingError when catalogUrl is empty string', async () => {
    await expect(
      fetchRemoteCatalog({ catalogUrl: '' }),
    ).rejects.toBeInstanceOf(CatalogUrlMissingError);
  });

  it('CatalogUrlMissingError message mentions agent-rigger init', async () => {
    let err: unknown;
    try {
      await fetchRemoteCatalog({ catalogUrl: undefined });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CatalogUrlMissingError);
    expect((err as CatalogUrlMissingError).message).toContain('agent-rigger init');
  });
});

// ---------------------------------------------------------------------------
// fetchRemoteCatalog — success
// ---------------------------------------------------------------------------

describe('fetchRemoteCatalog — success', () => {
  it('returns entries and version when fetch succeeds', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join: pathJoin } = await import('node:path');
    const dir = await mkdtemp(pathJoin(tmpdir(), 'rigger-rtest-'));

    const remoteEntries = [makeEntry('skill:remote-only')];
    const tagsStdout = `${SHA}\trefs/tags/v1.0.0\n`;

    const result = await fetchRemoteCatalog({
      catalogUrl: 'https://example.com/catalog.git',
      run: makeRunner(tagsStdout),
      tmpFactory: makeFakeTmpFactory(dir, remoteEntries),
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.id).toBe('skill:remote-only');
    expect(result.version.isTag).toBe(true);
    expect(result.version.ref).toBe('v1.0.0');
    expect(result.version.sha).toBe(SHA);

    await import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }));
  });
});

// ---------------------------------------------------------------------------
// fetchRemoteCatalog — RemoteFetchError propagated
// ---------------------------------------------------------------------------

describe('fetchRemoteCatalog — RemoteFetchError propagation', () => {
  it('propagates RemoteFetchError when clone fails', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join: pathJoin } = await import('node:path');
    const dir = await mkdtemp(pathJoin(tmpdir(), 'rigger-rtest-fail-'));

    const tagsStdout = `${SHA}\trefs/tags/v1.0.0\n`;

    await expect(
      fetchRemoteCatalog({
        catalogUrl: 'https://example.com/catalog.git',
        run: makeRunner(tagsStdout, 1), // clone exits 1
        tmpFactory: makeFakeTmpFactory(dir, []),
      }),
    ).rejects.toBeInstanceOf(RemoteFetchError);

    await import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }));
  });

  it('propagates RemoteFetchError when ls-remote fails', async () => {
    await expect(
      fetchRemoteCatalog({
        catalogUrl: 'https://example.com/catalog.git',
        run: alwaysFailRunner,
      }),
    ).rejects.toBeInstanceOf(RemoteFetchError);
  });
});

// ---------------------------------------------------------------------------
// mergeCatalogs
// ---------------------------------------------------------------------------

describe('mergeCatalogs', () => {
  it('returns built-in entries when remote is empty', () => {
    const builtin = [makeEntry('guardrails-claude'), makeEntry('context-claude')];
    const result = mergeCatalogs(builtin, []);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.id)).toEqual(['guardrails-claude', 'context-claude']);
  });

  it('appends remote-only entries after built-in', () => {
    const builtin = [makeEntry('guardrails-claude')];
    const remote = [makeEntry('skill:remote-only')];
    const result = mergeCatalogs(builtin, remote);
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('guardrails-claude');
    expect(result[1]?.id).toBe('skill:remote-only');
  });

  it('built-in wins on id collision', () => {
    const builtinEntry: CatalogEntry = {
      kind: 'artifact',
      id: 'guardrails-claude',
      nature: 'guardrail',
      source: 'internal',
      targets: ['claude'],
      scopes: ['user', 'project'],
    };
    const remoteEntry: CatalogEntry = {
      kind: 'artifact',
      id: 'guardrails-claude',
      nature: 'guardrail',
      source: 'external', // different source — remote version
      targets: ['claude'],
      scopes: ['user'],
    };
    const result = mergeCatalogs([builtinEntry], [remoteEntry]);
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe('internal'); // built-in kept
  });

  it('dedups correctly with multiple remote-only and collision entries', () => {
    const builtin = [makeEntry('a'), makeEntry('b')];
    const remote = [makeEntry('b'), makeEntry('c'), makeEntry('d')];
    const result = mergeCatalogs(builtin, remote);
    expect(result.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns empty array when both inputs are empty', () => {
    expect(mergeCatalogs([], [])).toEqual([]);
  });
});
