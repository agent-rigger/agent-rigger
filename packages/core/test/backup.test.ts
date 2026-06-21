/**
 * Tests for backup.ts — backup(path).
 *
 * Isolation: each test uses a fresh tmp directory under os.tmpdir().
 * afterEach removes the entire tmp tree.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { backup } from '../src/backup';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-backup-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// Backup suffix pattern: .bak-<ISO>-<8-hex-token>
// toISOString() colons replaced with dashes; the dot before ms is kept; an
// 8-char random hex token guarantees uniqueness without a probing loop.
// e.g. .bak-2026-06-21T14-30-00.000Z-a1b2c3d4
const BAK_SUFFIX_RE = /\.bak-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f]{8}$/;

// ---------------------------------------------------------------------------
// backup — file present
// ---------------------------------------------------------------------------

describe('backup (file present)', () => {
  it('creates a .bak-<ISO> file next to the original', async () => {
    const filePath = path.join(tmpDir, 'settings.json');
    await fs.writeFile(filePath, '{"a":1}', 'utf-8');

    const bakPath = await backup(filePath);

    expect(bakPath).not.toBeNull();
    expect(BAK_SUFFIX_RE.test(bakPath!)).toBe(true);
  });

  it('preserves the original file content in the backup', async () => {
    const content = '{"permissions":{"deny":["Read(.env)"]}}';
    const filePath = path.join(tmpDir, 'settings.json');
    await fs.writeFile(filePath, content, 'utf-8');

    const bakPath = await backup(filePath);

    const bakContent = await fs.readFile(bakPath!, 'utf-8');
    expect(bakContent).toBe(content);
  });

  it('leaves the original file untouched after backup', async () => {
    const content = 'original content';
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.writeFile(filePath, content, 'utf-8');

    await backup(filePath);

    const originalContent = await fs.readFile(filePath, 'utf-8');
    expect(originalContent).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// backup — file absent
// ---------------------------------------------------------------------------

describe('backup (file absent)', () => {
  it('returns null when the target file does not exist', async () => {
    const filePath = path.join(tmpDir, 'does-not-exist.json');

    const result = await backup(filePath);

    expect(result).toBeNull();
  });

  it('creates no .bak file when the target file does not exist', async () => {
    const filePath = path.join(tmpDir, 'does-not-exist.json');

    await backup(filePath);

    const entries = await fs.readdir(tmpDir);
    expect(entries.filter((e) => e.includes('.bak'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// backup — anti-collision (two rapid successive calls)
// ---------------------------------------------------------------------------

describe('backup (anti-collision)', () => {
  it('produces two distinct backup paths on successive calls', async () => {
    const content = 'data';
    const filePath = path.join(tmpDir, 'file.json');
    await fs.writeFile(filePath, content, 'utf-8');

    const bak1 = await backup(filePath);
    const bak2 = await backup(filePath);

    expect(bak1).not.toBeNull();
    expect(bak2).not.toBeNull();
    expect(bak1).not.toBe(bak2);
  });

  it('both backups contain the original content', async () => {
    const content = '{"version":1}';
    const filePath = path.join(tmpDir, 'state.json');
    await fs.writeFile(filePath, content, 'utf-8');

    const bak1 = await backup(filePath);
    const bak2 = await backup(filePath);

    const c1 = await fs.readFile(bak1!, 'utf-8');
    const c2 = await fs.readFile(bak2!, 'utf-8');
    expect(c1).toBe(content);
    expect(c2).toBe(content);
  });

  it('the original file is intact after two backups', async () => {
    const content = 'intact';
    const filePath = path.join(tmpDir, 'check.json');
    await fs.writeFile(filePath, content, 'utf-8');

    await backup(filePath);
    await backup(filePath);

    const after = await fs.readFile(filePath, 'utf-8');
    expect(after).toBe(content);
  });
});
