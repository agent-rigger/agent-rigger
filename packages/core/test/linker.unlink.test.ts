/**
 * Tests for linker.ts — unlink(target, store).
 *
 * Isolation: each test uses fresh tmp directories under os.tmpdir().
 * afterEach removes the entire tmp tree.
 *
 * Invariants:
 * - Removes both `target` (symlink or regular file/dir) and `store`.
 * - Tolerant to absence: calling on non-existent paths does not throw.
 * - Works for symlinks created by `link()` as well as plain files.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { link, unlink } from '../src/linker';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-unlink-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Removal after link()
// ---------------------------------------------------------------------------

describe('unlink: symlink and store removal after link()', () => {
  it('removes the target symlink and the store after link()', async () => {
    const srcPath = path.join(tmpDir, 'src', 'skill.md');
    const storePath = path.join(tmpDir, 'store', 'skill.md');
    const targetPath = path.join(tmpDir, 'target', 'skill.md');

    await fs.mkdir(path.dirname(srcPath), { recursive: true });
    await fs.writeFile(srcPath, 'content', 'utf-8');

    await link(srcPath, storePath, targetPath);

    // Precondition: both exist
    const targetExistsBefore = await fs.lstat(targetPath).then(() => true).catch(() => false);
    const storeExistsBefore = await fs.lstat(storePath).then(() => true).catch(() => false);
    expect(targetExistsBefore).toBe(true);
    expect(storeExistsBefore).toBe(true);

    await unlink(targetPath, storePath);

    const targetExistsAfter = await fs.lstat(targetPath).then(() => true).catch(() => false);
    const storeExistsAfter = await fs.lstat(storePath).then(() => true).catch(() => false);
    expect(targetExistsAfter).toBe(false);
    expect(storeExistsAfter).toBe(false);
  });

  it('removes a directory target and its store', async () => {
    const srcDir = path.join(tmpDir, 'src', 'skill-dir');
    const storeDir = path.join(tmpDir, 'store', 'skill-dir');
    const targetDir = path.join(tmpDir, 'target', 'skill-dir');

    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, 'file.md'), 'content', 'utf-8');

    await link(srcDir, storeDir, targetDir);

    await unlink(targetDir, storeDir);

    const targetExists = await fs.lstat(targetDir).then(() => true).catch(() => false);
    const storeExists = await fs.lstat(storeDir).then(() => true).catch(() => false);
    expect(targetExists).toBe(false);
    expect(storeExists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tolerance to absence
// ---------------------------------------------------------------------------

describe('unlink: tolerates absent paths', () => {
  it('does not throw when both target and store are absent', async () => {
    const targetPath = path.join(tmpDir, 'nonexistent', 'skill.md');
    const storePath = path.join(tmpDir, 'nonexistent-store', 'skill.md');

    // Should resolve without throwing
    await expect(unlink(targetPath, storePath)).resolves.toBeUndefined();
  });

  it('does not throw when only target is absent (store present)', async () => {
    const storePath = path.join(tmpDir, 'store', 'skill.md');
    const targetPath = path.join(tmpDir, 'nonexistent', 'skill.md');

    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, 'content', 'utf-8');

    await expect(unlink(targetPath, storePath)).resolves.toBeUndefined();

    // Store was removed even though target was absent
    const storeExists = await fs.lstat(storePath).then(() => true).catch(() => false);
    expect(storeExists).toBe(false);
  });

  it('does not throw when only store is absent (target present)', async () => {
    const storePath = path.join(tmpDir, 'nonexistent-store', 'skill.md');
    const targetPath = path.join(tmpDir, 'target', 'skill.md');

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, 'content', 'utf-8');

    await expect(unlink(targetPath, storePath)).resolves.toBeUndefined();

    // Target was removed
    const targetExists = await fs.lstat(targetPath).then(() => true).catch(() => false);
    expect(targetExists).toBe(false);
  });

  it('is idempotent: calling unlink twice on absent paths does not throw', async () => {
    const targetPath = path.join(tmpDir, 'nonexistent', 'skill.md');
    const storePath = path.join(tmpDir, 'nonexistent-store', 'skill.md');

    await unlink(targetPath, storePath);
    await expect(unlink(targetPath, storePath)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Plain file removal (not a symlink)
// ---------------------------------------------------------------------------

describe('unlink: plain file (no symlink)', () => {
  it('removes a plain file at target', async () => {
    const targetPath = path.join(tmpDir, 'target', 'plain.md');
    const storePath = path.join(tmpDir, 'store', 'plain.md');

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(targetPath, 'plain content', 'utf-8');
    await fs.writeFile(storePath, 'store content', 'utf-8');

    await unlink(targetPath, storePath);

    const targetExists = await fs.lstat(targetPath).then(() => true).catch(() => false);
    const storeExists = await fs.lstat(storePath).then(() => true).catch(() => false);
    expect(targetExists).toBe(false);
    expect(storeExists).toBe(false);
  });
});
