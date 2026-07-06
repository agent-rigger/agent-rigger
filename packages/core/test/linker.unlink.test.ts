/**
 * Tests for linker.ts — unlink(target, store), unlinkTarget(target) and
 * removeStoreIfUnreferenced(store, candidateTargets).
 *
 * Isolation: each test uses fresh tmp directories under os.tmpdir().
 * afterEach removes the entire tmp tree.
 *
 * Invariants:
 * - unlink: removes both `target` (symlink or regular file/dir) and `store`.
 * - unlinkTarget: removes ONLY the target, never the store (H7, ADR-0020 §3).
 * - removeStoreIfUnreferenced: deletes the store unless a candidate symlink
 *   still resolves to it (one store, N symlinks).
 * - Tolerant to absence: calling on non-existent paths does not throw.
 * - Works for symlinks created by `link()` as well as plain files.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { link, removeStoreIfUnreferenced, unlink, unlinkTarget } from '../src/linker';

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

// ---------------------------------------------------------------------------
// unlinkTarget — target-only removal (H7, ADR-0020 §3)
// ---------------------------------------------------------------------------

describe('unlinkTarget: removes only the target, never the store', () => {
  it('removes the target symlink and leaves the store intact', async () => {
    const srcDir = path.join(tmpDir, 'src', 'skill-dir');
    const storeDir = path.join(tmpDir, 'store', 'skill-dir');
    const targetDir = path.join(tmpDir, 'target', 'skill-dir');

    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, 'SKILL.md'), 'content', 'utf-8');
    await link(srcDir, storeDir, targetDir);

    await unlinkTarget(targetDir);

    const targetExists = await fs.lstat(targetDir).then(() => true).catch(() => false);
    const storeExists = await fs.lstat(storeDir).then(() => true).catch(() => false);
    expect(targetExists).toBe(false);
    expect(storeExists).toBe(true);
  });

  it('removes a plain directory target (copy fallback)', async () => {
    const targetDir = path.join(tmpDir, 'target', 'skill-dir');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, 'SKILL.md'), 'content', 'utf-8');

    await unlinkTarget(targetDir);

    const targetExists = await fs.lstat(targetDir).then(() => true).catch(() => false);
    expect(targetExists).toBe(false);
  });

  it('does not throw when the target is absent', async () => {
    const targetDir = path.join(tmpDir, 'nonexistent', 'skill-dir');

    await expect(unlinkTarget(targetDir)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// removeStoreIfUnreferenced — conditional store removal (H7, ADR-0020 §3)
// ---------------------------------------------------------------------------

describe('removeStoreIfUnreferenced', () => {
  /** Create a store directory containing one SKILL.md file. */
  async function makeStore(name: string): Promise<string> {
    const storeDir = path.join(tmpDir, 'store', name);
    await fs.mkdir(storeDir, { recursive: true });
    await fs.writeFile(path.join(storeDir, 'SKILL.md'), 'content', 'utf-8');
    return storeDir;
  }

  it('removes the store and returns true when no candidate references it', async () => {
    const storeDir = await makeStore('my-skill');
    const candidates = [
      path.join(tmpDir, 'claude', 'skills', 'my-skill'),
      path.join(tmpDir, 'opencode', 'skills', 'my-skill'),
    ];

    const removed = await removeStoreIfUnreferenced(storeDir, candidates);

    expect(removed).toBe(true);
    const storeExists = await fs.lstat(storeDir).then(() => true).catch(() => false);
    expect(storeExists).toBe(false);
  });

  it('keeps the store and returns false when a candidate symlink resolves to it', async () => {
    const storeDir = await makeStore('my-skill');
    const liveTarget = path.join(tmpDir, 'claude', 'skills', 'my-skill');
    await fs.mkdir(path.dirname(liveTarget), { recursive: true });
    await fs.symlink(storeDir, liveTarget);

    const removed = await removeStoreIfUnreferenced(storeDir, [
      path.join(tmpDir, 'opencode', 'skills', 'my-skill'), // absent
      liveTarget,
    ]);

    expect(removed).toBe(false);
    const storeExists = await fs.lstat(storeDir).then(() => true).catch(() => false);
    expect(storeExists).toBe(true);
  });

  it('does not count plain directories (copy fallback) as references', async () => {
    const storeDir = await makeStore('my-skill');
    const copyTarget = path.join(tmpDir, 'claude', 'skills', 'my-skill');
    await fs.mkdir(copyTarget, { recursive: true });
    await fs.writeFile(path.join(copyTarget, 'SKILL.md'), 'content', 'utf-8');

    const removed = await removeStoreIfUnreferenced(storeDir, [copyTarget]);

    expect(removed).toBe(true);
    const storeExists = await fs.lstat(storeDir).then(() => true).catch(() => false);
    expect(storeExists).toBe(false);
  });

  it('removes the store when candidate symlinks point elsewhere', async () => {
    const storeDir = await makeStore('my-skill');
    const otherStore = await makeStore('other-skill');
    const foreignLink = path.join(tmpDir, 'claude', 'skills', 'my-skill');
    await fs.mkdir(path.dirname(foreignLink), { recursive: true });
    await fs.symlink(otherStore, foreignLink);

    const removed = await removeStoreIfUnreferenced(storeDir, [foreignLink]);

    expect(removed).toBe(true);
    const storeExists = await fs.lstat(storeDir).then(() => true).catch(() => false);
    expect(storeExists).toBe(false);
  });

  it('counts relative symlinks that resolve to the store', async () => {
    const storeDir = await makeStore('my-skill');
    const linkDir = path.join(tmpDir, 'claude', 'skills');
    const liveTarget = path.join(linkDir, 'my-skill');
    await fs.mkdir(linkDir, { recursive: true });
    await fs.symlink(path.relative(linkDir, storeDir), liveTarget);

    const removed = await removeStoreIfUnreferenced(storeDir, [liveTarget]);

    expect(removed).toBe(false);
    const storeExists = await fs.lstat(storeDir).then(() => true).catch(() => false);
    expect(storeExists).toBe(true);
  });

  it('does not throw when the store is already absent', async () => {
    const storeDir = path.join(tmpDir, 'nonexistent-store', 'my-skill');

    await expect(removeStoreIfUnreferenced(storeDir, [])).resolves.toBe(true);
  });
});
