/**
 * Tests for linker.ts — syncToStore, linkOrCopy, link.
 *
 * Isolation: each test uses fresh tmp directories under os.tmpdir().
 * afterEach removes the entire tmp tree.
 *
 * Covered scenarios:
 * - syncToStore: file source → store copy
 * - syncToStore: directory source → recursive store copy
 * - syncToStore: re-sync updates the store to reflect the new source
 * - linkOrCopy: creates a symlink from target → store
 * - linkOrCopy: idempotent (correct symlink already present → no error)
 * - linkOrCopy: replaces a stale target (wrong symlink or plain file)
 * - linkOrCopy (fallback): injected symlink throws → copy fallback, method === 'copy'
 * - link: syncToStore + linkOrCopy composed, returns summary
 * - link: stable on second call (idempotence)
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { link, linkOrCopy, syncToStore } from '../src/linker';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-linker-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// syncToStore — file source
// ---------------------------------------------------------------------------

describe('syncToStore (file source)', () => {
  it('copies the source file into the store path', async () => {
    const srcPath = path.join(tmpDir, 'src', 'skill.md');
    const storePath = path.join(tmpDir, 'store', 'skill.md');

    await fs.mkdir(path.dirname(srcPath), { recursive: true });
    await fs.writeFile(srcPath, '# Skill content', 'utf-8');

    await syncToStore(srcPath, storePath);

    const content = await fs.readFile(storePath, 'utf-8');
    expect(content).toBe('# Skill content');
  });

  it('creates parent directories for the store path', async () => {
    const srcPath = path.join(tmpDir, 'src', 'skill.md');
    const storePath = path.join(tmpDir, 'deep', 'nested', 'store', 'skill.md');

    await fs.mkdir(path.dirname(srcPath), { recursive: true });
    await fs.writeFile(srcPath, 'data', 'utf-8');

    await syncToStore(srcPath, storePath);

    const exists = await fs.stat(storePath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it('overwrites an existing store file with the new source content', async () => {
    const srcPath = path.join(tmpDir, 'src', 'skill.md');
    const storePath = path.join(tmpDir, 'store', 'skill.md');

    await fs.mkdir(path.dirname(srcPath), { recursive: true });
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, 'old content', 'utf-8');
    await fs.writeFile(srcPath, 'new content', 'utf-8');

    await syncToStore(srcPath, storePath);

    const content = await fs.readFile(storePath, 'utf-8');
    expect(content).toBe('new content');
  });
});

// ---------------------------------------------------------------------------
// syncToStore — directory source
// ---------------------------------------------------------------------------

describe('syncToStore (directory source)', () => {
  it('recursively copies the source directory into the store path', async () => {
    const srcDir = path.join(tmpDir, 'src', 'skill-dir');
    const storeDir = path.join(tmpDir, 'store', 'skill-dir');

    await fs.mkdir(path.join(srcDir, 'sub'), { recursive: true });
    await fs.writeFile(path.join(srcDir, 'README.md'), '# Readme', 'utf-8');
    await fs.writeFile(path.join(srcDir, 'sub', 'file.ts'), 'export {}', 'utf-8');

    await syncToStore(srcDir, storeDir);

    const readme = await fs.readFile(path.join(storeDir, 'README.md'), 'utf-8');
    const nested = await fs.readFile(path.join(storeDir, 'sub', 'file.ts'), 'utf-8');
    expect(readme).toBe('# Readme');
    expect(nested).toBe('export {}');
  });

  it('replaces the old store directory on re-sync', async () => {
    const srcDir = path.join(tmpDir, 'src', 'skill-dir');
    const storeDir = path.join(tmpDir, 'store', 'skill-dir');

    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, 'v1.md'), 'version 1', 'utf-8');
    await syncToStore(srcDir, storeDir);

    await fs.writeFile(path.join(srcDir, 'v2.md'), 'version 2', 'utf-8');
    await fs.rm(path.join(srcDir, 'v1.md'));
    await syncToStore(srcDir, storeDir);

    const v2 = await fs.readFile(path.join(storeDir, 'v2.md'), 'utf-8');
    expect(v2).toBe('version 2');

    const v1Exists = await fs.stat(path.join(storeDir, 'v1.md')).then(() => true).catch(
      () => false,
    );
    expect(v1Exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// syncToStore — update scenario
// ---------------------------------------------------------------------------

describe('syncToStore (update)', () => {
  it('reflects updated source content after a second sync', async () => {
    const srcPath = path.join(tmpDir, 'src', 'agent.md');
    const storePath = path.join(tmpDir, 'store', 'agent.md');

    await fs.mkdir(path.dirname(srcPath), { recursive: true });
    await fs.writeFile(srcPath, 'v1', 'utf-8');
    await syncToStore(srcPath, storePath);

    await fs.writeFile(srcPath, 'v2', 'utf-8');
    await syncToStore(srcPath, storePath);

    const content = await fs.readFile(storePath, 'utf-8');
    expect(content).toBe('v2');
  });
});

// ---------------------------------------------------------------------------
// linkOrCopy — symlink path
// ---------------------------------------------------------------------------

describe('linkOrCopy (symlink)', () => {
  it('creates a symlink from targetPath to storePath', async () => {
    const storePath = path.join(tmpDir, 'store', 'skill.md');
    const targetPath = path.join(tmpDir, 'target', 'skill.md');

    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, 'content', 'utf-8');

    const method = await linkOrCopy(storePath, targetPath);

    expect(method).toBe('symlink');
    const stat = await fs.lstat(targetPath);
    expect(stat.isSymbolicLink()).toBe(true);
  });

  it('reading targetPath through the symlink returns store content', async () => {
    const storePath = path.join(tmpDir, 'store', 'skill.md');
    const targetPath = path.join(tmpDir, 'target', 'skill.md');

    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, 'via symlink', 'utf-8');

    await linkOrCopy(storePath, targetPath);

    const content = await fs.readFile(targetPath, 'utf-8');
    expect(content).toBe('via symlink');
  });

  it('creates parent directories for targetPath', async () => {
    const storePath = path.join(tmpDir, 'store', 'skill.md');
    const targetPath = path.join(tmpDir, 'deep', 'nested', 'target', 'skill.md');

    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, 'data', 'utf-8');

    await linkOrCopy(storePath, targetPath);

    const stat = await fs.lstat(targetPath);
    expect(stat.isSymbolicLink()).toBe(true);
  });

  it('is idempotent when the correct symlink already exists', async () => {
    const storePath = path.join(tmpDir, 'store', 'skill.md');
    const targetPath = path.join(tmpDir, 'target', 'skill.md');

    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, 'content', 'utf-8');

    await linkOrCopy(storePath, targetPath);
    const method = await linkOrCopy(storePath, targetPath);

    expect(method).toBe('symlink');
    const link = await fs.readlink(targetPath);
    expect(link).toBe(storePath);
  });

  it('replaces a stale symlink pointing to the wrong target', async () => {
    const storePath = path.join(tmpDir, 'store', 'skill.md');
    const staleTarget = path.join(tmpDir, 'other', 'old.md');
    const targetPath = path.join(tmpDir, 'target', 'skill.md');

    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.mkdir(path.dirname(staleTarget), { recursive: true });
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(storePath, 'correct content', 'utf-8');
    await fs.symlink(staleTarget, targetPath);

    const method = await linkOrCopy(storePath, targetPath);

    expect(method).toBe('symlink');
    const link = await fs.readlink(targetPath);
    expect(link).toBe(storePath);
  });

  it('replaces a plain file at targetPath with a symlink', async () => {
    const storePath = path.join(tmpDir, 'store', 'skill.md');
    const targetPath = path.join(tmpDir, 'target', 'skill.md');

    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(storePath, 'store content', 'utf-8');
    await fs.writeFile(targetPath, 'plain file', 'utf-8');

    const method = await linkOrCopy(storePath, targetPath);

    expect(method).toBe('symlink');
    const stat = await fs.lstat(targetPath);
    expect(stat.isSymbolicLink()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// linkOrCopy — copy fallback
// ---------------------------------------------------------------------------

describe('linkOrCopy (copy fallback)', () => {
  it('returns "copy" when the injected symlink function throws', async () => {
    const storePath = path.join(tmpDir, 'store', 'skill.md');
    const targetPath = path.join(tmpDir, 'target', 'skill.md');

    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, 'fallback content', 'utf-8');

    const method = await linkOrCopy(storePath, targetPath, {
      symlink: async () => {
        throw new Error('symlink not supported on this FS');
      },
    });

    expect(method).toBe('copy');
  });

  it('target is a real copy (not a symlink) after fallback', async () => {
    const storePath = path.join(tmpDir, 'store', 'skill.md');
    const targetPath = path.join(tmpDir, 'target', 'skill.md');

    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, 'fallback content', 'utf-8');

    await linkOrCopy(storePath, targetPath, {
      symlink: async () => {
        throw new Error('symlink not supported');
      },
    });

    const stat = await fs.lstat(targetPath);
    expect(stat.isSymbolicLink()).toBe(false);
  });

  it('copy fallback preserves the store content at targetPath', async () => {
    const storePath = path.join(tmpDir, 'store', 'skill.md');
    const targetPath = path.join(tmpDir, 'target', 'skill.md');

    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, 'fallback content', 'utf-8');

    await linkOrCopy(storePath, targetPath, {
      symlink: async () => {
        throw new Error('symlink not supported');
      },
    });

    const content = await fs.readFile(targetPath, 'utf-8');
    expect(content).toBe('fallback content');
  });

  it('copy fallback works for a directory store', async () => {
    const storeDir = path.join(tmpDir, 'store', 'skill-dir');
    const targetPath = path.join(tmpDir, 'target', 'skill-dir');

    await fs.mkdir(path.join(storeDir, 'sub'), { recursive: true });
    await fs.writeFile(path.join(storeDir, 'README.md'), '# readme', 'utf-8');

    const method = await linkOrCopy(storeDir, targetPath, {
      symlink: async () => {
        throw new Error('no symlinks');
      },
    });

    expect(method).toBe('copy');
    const readme = await fs.readFile(path.join(targetPath, 'README.md'), 'utf-8');
    expect(readme).toBe('# readme');
    const stat = await fs.lstat(targetPath);
    expect(stat.isSymbolicLink()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// link — composed function
// ---------------------------------------------------------------------------

describe('link', () => {
  it('returns a summary with method, store, and target', async () => {
    const srcPath = path.join(tmpDir, 'src', 'skill.md');
    const storePath = path.join(tmpDir, 'store', 'skill.md');
    const targetPath = path.join(tmpDir, 'target', 'skill.md');

    await fs.mkdir(path.dirname(srcPath), { recursive: true });
    await fs.writeFile(srcPath, 'content', 'utf-8');

    const result = await link(srcPath, storePath, targetPath);

    expect(result.method).toBe('symlink');
    expect(result.store).toBe(storePath);
    expect(result.target).toBe(targetPath);
  });

  it('store contains the source content after link', async () => {
    const srcPath = path.join(tmpDir, 'src', 'skill.md');
    const storePath = path.join(tmpDir, 'store', 'skill.md');
    const targetPath = path.join(tmpDir, 'target', 'skill.md');

    await fs.mkdir(path.dirname(srcPath), { recursive: true });
    await fs.writeFile(srcPath, 'linked content', 'utf-8');

    await link(srcPath, storePath, targetPath);

    const stored = await fs.readFile(storePath, 'utf-8');
    expect(stored).toBe('linked content');
  });

  it('target is a symlink to the store after link', async () => {
    const srcPath = path.join(tmpDir, 'src', 'skill.md');
    const storePath = path.join(tmpDir, 'store', 'skill.md');
    const targetPath = path.join(tmpDir, 'target', 'skill.md');

    await fs.mkdir(path.dirname(srcPath), { recursive: true });
    await fs.writeFile(srcPath, 'linked content', 'utf-8');

    await link(srcPath, storePath, targetPath);

    const resolved = await fs.readlink(targetPath);
    expect(resolved).toBe(storePath);
  });

  it('is stable on a second call (idempotence)', async () => {
    const srcPath = path.join(tmpDir, 'src', 'skill.md');
    const storePath = path.join(tmpDir, 'store', 'skill.md');
    const targetPath = path.join(tmpDir, 'target', 'skill.md');

    await fs.mkdir(path.dirname(srcPath), { recursive: true });
    await fs.writeFile(srcPath, 'content', 'utf-8');

    await link(srcPath, storePath, targetPath);
    const result2 = await link(srcPath, storePath, targetPath);

    expect(result2.method).toBe('symlink');
    const resolved = await fs.readlink(targetPath);
    expect(resolved).toBe(storePath);
  });

  it('uses copy fallback when symlink injection throws', async () => {
    const srcPath = path.join(tmpDir, 'src', 'skill.md');
    const storePath = path.join(tmpDir, 'store', 'skill.md');
    const targetPath = path.join(tmpDir, 'target', 'skill.md');

    await fs.mkdir(path.dirname(srcPath), { recursive: true });
    await fs.writeFile(srcPath, 'content', 'utf-8');

    const result = await link(srcPath, storePath, targetPath, {
      symlink: async () => {
        throw new Error('no symlinks');
      },
    });

    expect(result.method).toBe('copy');
    const stat = await fs.lstat(targetPath);
    expect(stat.isSymbolicLink()).toBe(false);
  });
});
