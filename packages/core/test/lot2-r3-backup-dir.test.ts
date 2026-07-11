/**
 * Tests for R3 — backupDir primitive (core/src/backup.ts).
 *
 * Requirement (docs/specs/lot2-remove-reversible/requirements.md, R3, gate
 * ratified 2026-07-10): the content of a rigger store is backed up BEFORE the
 * remove deletes it — a skill modified through its symlink lives in the store,
 * so without a backup the modifications vanish with the rm.
 *
 * backupDir(path) contract:
 * - path absent          → null, nothing written.
 * - path is a directory  → recursive copy to <path>.bak-<ISO>-<token>.
 * - path is a file       → plain copy (agent stores are single .md files).
 * - same naming convention as backup() (fs-safe ISO + 8-char random token),
 *   so two calls on the same path never collide.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';

import { backupDir } from '../src/backup';
import { makeTmpHome } from './tmp-home';

const BAK_PATTERN = /\.bak-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f]{8}$/;

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;

beforeEach(async () => {
  tmp = await makeTmpHome('rigger-r3-backup-dir-');
});

afterEach(async () => {
  await tmp.cleanup();
});

describe('backupDir — R3 store backup primitive', () => {
  it('lot2-R3: returns null when the path does not exist', async () => {
    const missing = path.join(tmp.dir, 'no-such-store');

    const result = await backupDir(missing);

    expect(result).toBeNull();
    const entries = await fs.readdir(tmp.dir);
    expect(entries).toHaveLength(0);
  });

  it('lot2-R3: copies a directory recursively to <path>.bak-<ISO>-<token>', async () => {
    const store = path.join(tmp.dir, 'my-skill');
    await fs.mkdir(path.join(store, 'nested'), { recursive: true });
    await fs.writeFile(path.join(store, 'SKILL.md'), '# Skill\nuser edit\n');
    await fs.writeFile(path.join(store, 'nested', 'notes.md'), 'deep content');

    const bak = await backupDir(store);

    expect(bak).not.toBeNull();
    expect(bak!.startsWith(`${store}.bak-`)).toBe(true);
    expect(bak!).toMatch(BAK_PATTERN);

    // The backup carries the full tree.
    const rootCopy = await fs.readFile(path.join(bak!, 'SKILL.md'), 'utf8');
    const deepCopy = await fs.readFile(path.join(bak!, 'nested', 'notes.md'), 'utf8');
    expect(rootCopy).toBe('# Skill\nuser edit\n');
    expect(deepCopy).toBe('deep content');

    // The original is untouched.
    const original = await fs.readFile(path.join(store, 'SKILL.md'), 'utf8');
    expect(original).toBe('# Skill\nuser edit\n');
  });

  it('lot2-R3: handles a single-file store (agent .md)', async () => {
    const store = path.join(tmp.dir, 'reviewer.md');
    await fs.writeFile(store, '# Agent: reviewer\n');

    const bak = await backupDir(store);

    expect(bak).not.toBeNull();
    expect(bak!.startsWith(`${store}.bak-`)).toBe(true);
    const copy = await fs.readFile(bak!, 'utf8');
    expect(copy).toBe('# Agent: reviewer\n');
  });

  it('lot2-R3: successive calls on the same path produce distinct backups', async () => {
    const store = path.join(tmp.dir, 'twice');
    await fs.mkdir(store, { recursive: true });
    await fs.writeFile(path.join(store, 'f.txt'), 'x');

    const first = await backupDir(store);
    const second = await backupDir(store);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second);
  });
});
