/**
 * Smoke tests for remote.ts's defaultTmpFactory — the real node:fs/promises
 * mkdtemp + rm implementation. It is never imported by any other test in this
 * package (every fetchRemoteCatalog test injects a fake tmpFactory), so this
 * is the first real spawn-free-but-real-fs exercise of it (M16 residual,
 * lot7, cli/src/remote.ts:49).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { defaultTmpFactory } from '../src/remote';

// ---------------------------------------------------------------------------
// Safety net — force-remove anything a failed assertion left behind before
// its own cleanup() call ran.
// ---------------------------------------------------------------------------

const createdPaths: string[] = [];

afterEach(async () => {
  const leftover = createdPaths.splice(0);
  await Promise.all(leftover.map((p) => fs.rm(p, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// Creates a real directory under os.tmpdir()
// ---------------------------------------------------------------------------

describe('defaultTmpFactory — creates a real directory under os.tmpdir()', () => {
  it('creates a directory whose parent resolves to os.tmpdir()', async () => {
    const { path: dir, cleanup } = await defaultTmpFactory();
    createdPaths.push(dir);

    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);

    const realParent = await fs.realpath(path.dirname(dir));
    const realTmp = await fs.realpath(os.tmpdir());
    expect(realParent).toBe(realTmp);

    await cleanup();
  });

  it('prefixes the directory basename with "agent-rigger-catalog-"', async () => {
    const { path: dir, cleanup } = await defaultTmpFactory();
    createdPaths.push(dir);

    expect(path.basename(dir).startsWith('agent-rigger-catalog-')).toBe(true);

    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// Nested file write
// ---------------------------------------------------------------------------

describe('defaultTmpFactory — nested file write', () => {
  it('allows writing a file inside a nested subdirectory of the created path', async () => {
    const { path: dir, cleanup } = await defaultTmpFactory();
    createdPaths.push(dir);

    const nestedDir = path.join(dir, 'nested', 'deeper');
    await fs.mkdir(nestedDir, { recursive: true });
    const filePath = path.join(nestedDir, 'file.txt');
    await fs.writeFile(filePath, 'content');

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toBe('content');

    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// cleanup() — recursive removal, idempotent
// ---------------------------------------------------------------------------

describe('defaultTmpFactory — cleanup', () => {
  it('cleanup() recursively removes the directory and its contents', async () => {
    const { path: dir, cleanup } = await defaultTmpFactory();
    createdPaths.push(dir);

    const nestedDir = path.join(dir, 'nested');
    await fs.mkdir(nestedDir);
    await fs.writeFile(path.join(nestedDir, 'file.txt'), 'content');

    await cleanup();

    await expect(fs.stat(dir)).rejects.toThrow();
  });

  it('cleanup() is idempotent — a second call does not throw', async () => {
    const { path: dir, cleanup } = await defaultTmpFactory();
    createdPaths.push(dir);

    await cleanup();
    await expect(cleanup()).resolves.toBeUndefined();
  });
});
