/**
 * Lot 3 — R6: recovery paths write atomically (design D6).
 *
 * Contract (requirements.md R6):
 *   restore(), backup() and backupDir() SHALL never expose a partial file or
 *   directory under its final name — staging (tmp + rename) always.
 *
 * These tests prove the invariants with real-filesystem seams (no mocking):
 *   - no-turd: no `.tmp-*` residue under the final name after success.
 *   - restore byte-exact: raw bytes, not a UTF-8 text round-trip.
 *   - partial-write seam: when the rename/copy fails mid-flight, the target
 *     stays either the original or the complete result — never a truncated one,
 *     and no partial file/dir ever appears under the FINAL name.
 *
 * Isolation: each test uses a fresh tmp directory under os.tmpdir().
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { backup, backupDir, restore } from '../src/backup';
import { atomicWriteBytes } from '../src/fs-json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-lot3-r6-'));
});

afterEach(async () => {
  // Best-effort: some tests chmod nested paths — restore before rm.
  await fs.chmod(tmpDir, 0o700).catch(() => {});
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

// Non-UTF-8 byte sequence: lone continuation / surrogate bytes that a text
// round-trip would corrupt. Proves the write path is byte-exact.
const RAW_BYTES = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x41, 0x42, 0x00, 0xc3]);

async function listTurds(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir);
  return entries.filter((e) => e.includes('.tmp-'));
}

// ---------------------------------------------------------------------------
// atomicWriteBytes — the shared primitive
// ---------------------------------------------------------------------------

describe('atomicWriteBytes', () => {
  it('lot3-R6: writes the exact bytes (byte-exact, no text round-trip)', async () => {
    const filePath = path.join(tmpDir, 'blob.bin');
    await atomicWriteBytes(filePath, RAW_BYTES);

    const read = await fs.readFile(filePath);
    expect(new Uint8Array(read)).toEqual(RAW_BYTES);
  });

  it('lot3-R6: accepts an ArrayBuffer as well as a Uint8Array', async () => {
    const filePath = path.join(tmpDir, 'blob.bin');
    await atomicWriteBytes(filePath, RAW_BYTES.buffer);

    const read = await fs.readFile(filePath);
    expect(new Uint8Array(read)).toEqual(RAW_BYTES);
  });

  it('lot3-R6: leaves no .tmp-* turd after a successful write', async () => {
    const filePath = path.join(tmpDir, 'blob.bin');
    await atomicWriteBytes(filePath, RAW_BYTES);

    expect(await listTurds(tmpDir)).toHaveLength(0);
    expect(await fs.readdir(tmpDir)).toContain('blob.bin');
  });

  it('lot3-R6: creates missing parent directories', async () => {
    const filePath = path.join(tmpDir, 'nested', 'deep', 'blob.bin');
    await atomicWriteBytes(filePath, RAW_BYTES);

    const read = await fs.readFile(filePath);
    expect(new Uint8Array(read)).toEqual(RAW_BYTES);
  });

  it('lot3-R6: rename seam — a failed write leaves the target original, no turd', async () => {
    // The target already exists as a NON-EMPTY directory: rename(tmpFile, dir)
    // fails, so the final name never receives the staged bytes.
    const target = path.join(tmpDir, 'settings.json');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'inner'), 'keep', 'utf-8');

    await expect(atomicWriteBytes(target, RAW_BYTES)).rejects.toBeTruthy();

    // Target unchanged (still the original directory with its content).
    const stat = await fs.lstat(target);
    expect(stat.isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(target, 'inner'), 'utf-8')).toBe('keep');
    // No staged tmp file leaked next to it.
    expect(await listTurds(tmpDir)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// restore — atomic, byte-exact
// ---------------------------------------------------------------------------

describe('restore (atomic recovery)', () => {
  it('lot3-R6: restores the exact bytes of the backup (byte-exact)', async () => {
    const bakPath = path.join(tmpDir, 'settings.json.bak');
    await fs.writeFile(bakPath, RAW_BYTES);
    const target = path.join(tmpDir, 'settings.json');
    await fs.writeFile(target, 'stale content that must be replaced', 'utf-8');

    await restore(bakPath, target);

    const read = await fs.readFile(target);
    expect(new Uint8Array(read)).toEqual(RAW_BYTES);
  });

  it('lot3-R6: leaves no .tmp-* turd after a successful restore', async () => {
    const bakPath = path.join(tmpDir, 'settings.json.bak');
    await fs.writeFile(bakPath, '{"restored":true}', 'utf-8');
    const target = path.join(tmpDir, 'settings.json');
    await fs.writeFile(target, '{"old":true}', 'utf-8');

    await restore(bakPath, target);

    expect(await listTurds(tmpDir)).toHaveLength(0);
    expect(await fs.readFile(target, 'utf-8')).toBe('{"restored":true}');
  });

  it('lot3-R6: partial-write seam — target stays original OR complete, never truncated', async () => {
    // Simulate a crash at the write seam: the target is a non-empty directory
    // so the internal rename cannot complete. The original state survives whole.
    const bakPath = path.join(tmpDir, 'settings.json.bak');
    await fs.writeFile(bakPath, 'FULL-RESTORATION-CONTENT', 'utf-8');
    const target = path.join(tmpDir, 'settings.json');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'original'), 'ORIGINAL', 'utf-8');

    await expect(restore(bakPath, target)).rejects.toBeTruthy();

    // The target is untouched (still the original directory) — not a half file.
    const stat = await fs.lstat(target);
    expect(stat.isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(target, 'original'), 'utf-8')).toBe('ORIGINAL');
    expect(await listTurds(tmpDir)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// backup — staged, no partial .bak under its final name
// ---------------------------------------------------------------------------

describe('backup (atomic staging)', () => {
  it('lot3-R6: backup is byte-exact for non-UTF-8 content', async () => {
    const filePath = path.join(tmpDir, 'settings.json');
    await fs.writeFile(filePath, RAW_BYTES);

    const bakPath = await backup(filePath);

    expect(bakPath).not.toBeNull();
    const read = await fs.readFile(bakPath!);
    expect(new Uint8Array(read)).toEqual(RAW_BYTES);
  });

  it('lot3-R6: leaves no .tmp-* turd after a successful backup', async () => {
    const filePath = path.join(tmpDir, 'settings.json');
    await fs.writeFile(filePath, '{"a":1}', 'utf-8');

    await backup(filePath);

    // Exactly one .bak-* under the final name, and no .tmp-* staging residue.
    const entries = await fs.readdir(tmpDir);
    expect(entries.filter((e) => e.includes('.tmp-'))).toHaveLength(0);
    expect(entries.filter((e) => e.includes('.bak-'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// backupDir — copy to a staging name, then rename
// ---------------------------------------------------------------------------

describe('backupDir (atomic staging)', () => {
  it('lot3-R6: copies the whole tree, leaving no .tmp-* turd', async () => {
    const dirPath = path.join(tmpDir, 'store');
    await fs.mkdir(path.join(dirPath, 'sub'), { recursive: true });
    await fs.writeFile(path.join(dirPath, 'a.txt'), 'a', 'utf-8');
    await fs.writeFile(path.join(dirPath, 'sub', 'b.txt'), 'b', 'utf-8');

    const dest = await backupDir(dirPath);

    expect(dest).not.toBeNull();
    expect(await fs.readFile(path.join(dest!, 'a.txt'), 'utf-8')).toBe('a');
    expect(await fs.readFile(path.join(dest!, 'sub', 'b.txt'), 'utf-8')).toBe('b');
    expect(await listTurds(tmpDir)).toHaveLength(0);
  });

  it('lot3-R6: a partial copy never appears under the final .bak name', async () => {
    if (isRoot) return; // permission seam is meaningless as root
    const dirPath = path.join(tmpDir, 'store');
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(path.join(dirPath, 'readable.txt'), 'ok', 'utf-8');
    const secret = path.join(dirPath, 'secret.txt');
    await fs.writeFile(secret, 'nope', 'utf-8');
    await fs.chmod(secret, 0o000); // cp will fail with EACCES mid-tree

    try {
      await expect(backupDir(dirPath)).rejects.toBeTruthy();

      // The copy failed AFTER some files were staged — prove nothing landed
      // under the final `.bak-` name, and no `.tmp-` staging dir remains.
      const entries = await fs.readdir(tmpDir);
      expect(entries.filter((e) => e.includes('.bak-'))).toHaveLength(0);
      expect(entries.filter((e) => e.includes('.tmp-'))).toHaveLength(0);
    } finally {
      await fs.chmod(secret, 0o600).catch(() => {});
    }
  });
});
