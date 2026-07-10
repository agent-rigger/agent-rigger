/**
 * Lot 3 — R6: persistConfig writes atomically (design D6).
 *
 * persistConfig writes JSONC (header comment + body). It must go through core's
 * writeText (tmp + rename) so a crash never leaves a truncated config.jsonc
 * under its final name, and no `.tmp-*` staging residue is left behind.
 *
 * Isolation: fresh tmp directory per test; afterEach cleans up.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfigFile, persistConfig } from '../src/config';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-lot3-r6-cfg-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('persistConfig (atomic)', () => {
  it('lot3-R6: leaves no .tmp-* turd after a successful write', async () => {
    const filePath = path.join(tmpDir, 'config.jsonc');
    await persistConfig(filePath, { defaultScope: 'project' });

    const entries = await fs.readdir(tmpDir);
    expect(entries.filter((e) => e.includes('.tmp-'))).toHaveLength(0);
    expect(entries).toContain('config.jsonc');
  });

  it('lot3-R6: round-trips and keeps the header comment (JSONC text)', async () => {
    const filePath = path.join(tmpDir, 'config.jsonc');
    await persistConfig(filePath, { defaultScope: 'user', catalogs: [] });

    const raw = await fs.readFile(filePath, 'utf-8');
    expect(raw).toMatch(/^\/\//); // header comment first line
    const reloaded = await loadConfigFile(filePath);
    expect(reloaded.defaultScope).toBe('user');
  });

  it('lot3-R6: a failed write leaves the previous file intact, no turd', async () => {
    // Parent becomes a regular file → mkdir(ENOTDIR) makes the write throw.
    const blocker = path.join(tmpDir, 'blocker');
    await fs.writeFile(blocker, 'i am a file', 'utf-8');
    const target = path.join(blocker, 'config.jsonc');

    await expect(persistConfig(target, { defaultScope: 'user' })).rejects.toBeTruthy();

    expect(await fs.readFile(blocker, 'utf-8')).toBe('i am a file');
    const entries = await fs.readdir(tmpDir);
    expect(entries.filter((e) => e.includes('.tmp-'))).toHaveLength(0);
  });
});
