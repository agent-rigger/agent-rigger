/**
 * Tests for opencode-json-io — readOpencodeJson / applyOpencodeKey (E-jsonc).
 *
 * opencode.json is JSONC: comments + trailing commas must NOT crash the adapter,
 * and a merge must preserve the user's comments/formatting.
 *
 * Isolation: fresh tmp dir per test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  applyOpencodeKey,
  InvalidOpencodeJsonError,
  readOpencodeJson,
} from '../../src/opencode/opencode-json-io';

let tmpDir: string;
let file: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-oc-jsonc-'));
  file = path.join(tmpDir, 'opencode.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('readOpencodeJson', () => {
  it('returns {} for an absent file', async () => {
    expect(await readOpencodeJson(path.join(tmpDir, 'nope.json'))).toEqual({});
  });

  it('parses plain JSON', async () => {
    await fs.writeFile(file, JSON.stringify({ permission: { bash: 'deny' } }));
    expect(await readOpencodeJson(file)).toEqual({ permission: { bash: 'deny' } });
  });

  it('parses JSONC (comments + trailing comma) without throwing', async () => {
    await fs.writeFile(
      file,
      `{
  // user comment
  "permission": { "edit": "ask" },
  "mcp": {},
}`,
    );
    expect(await readOpencodeJson(file)).toEqual({ permission: { edit: 'ask' }, mcp: {} });
  });

  it('throws InvalidOpencodeJsonError on genuinely malformed content', async () => {
    await fs.writeFile(file, '{ "permission": { ');
    await expect(readOpencodeJson(file)).rejects.toBeInstanceOf(InvalidOpencodeJsonError);
  });
});

describe('applyOpencodeKey', () => {
  it('creates a valid JSON file when absent', async () => {
    await applyOpencodeKey(file, 'permission', { bash: { 'rm -rf *': 'deny' } });
    expect(await readOpencodeJson(file)).toEqual({ permission: { bash: { 'rm -rf *': 'deny' } } });
  });

  it('preserves the user comment and sibling keys when updating a key', async () => {
    await fs.writeFile(
      file,
      `{
  // keep me
  "$schema": "https://opencode.ai/config.json",
  "permission": { "edit": "ask" },
}`,
    );

    await applyOpencodeKey(file, 'permission', { edit: 'ask', bash: { 'rm -rf *': 'deny' } });

    const raw = await fs.readFile(file, 'utf-8');
    expect(raw).toContain('// keep me'); // comment preserved
    expect(raw).toContain('$schema'); // sibling key preserved
    const parsed = await readOpencodeJson(file);
    expect(parsed['$schema']).toBe('https://opencode.ai/config.json');
    expect(parsed['permission']).toEqual({ edit: 'ask', bash: { 'rm -rf *': 'deny' } });
  });

  it('adds a new key without disturbing existing ones', async () => {
    await fs.writeFile(file, `{ "permission": { "edit": "ask" } }`);
    await applyOpencodeKey(file, 'mcp', { srv: { type: 'local', command: ['x'] } });
    const parsed = await readOpencodeJson(file);
    expect(parsed['permission']).toEqual({ edit: 'ask' });
    expect(parsed['mcp']).toEqual({ srv: { type: 'local', command: ['x'] } });
  });
});
