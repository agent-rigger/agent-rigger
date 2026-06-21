/**
 * Tests for fs-json.ts — readJson, readText, writeJson.
 *
 * Isolation: each test uses a fresh tmp directory under os.tmpdir().
 * No writes outside that directory. afterEach cleans up.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { InvalidJsonError, readJson, readText, writeJson } from '../src/fs-json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-fs-json-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readJson
// ---------------------------------------------------------------------------

describe('readJson', () => {
  it('returns {} when the file does not exist', async () => {
    const result = await readJson(path.join(tmpDir, 'missing.json'));
    expect(result).toEqual({});
  });

  it('returns the parsed object when the file contains valid JSON', async () => {
    const filePath = path.join(tmpDir, 'settings.json');
    await fs.writeFile(filePath, JSON.stringify({ model: 'claude', count: 42 }), 'utf-8');

    const result = await readJson(filePath);
    expect(result).toEqual({ model: 'claude', count: 42 });
  });

  it('throws InvalidJsonError when the file contains invalid JSON', async () => {
    const filePath = path.join(tmpDir, 'broken.json');
    await fs.writeFile(filePath, '{ not: valid json }', 'utf-8');

    await expect(readJson(filePath)).rejects.toThrow(InvalidJsonError);
  });

  it('sets .path on InvalidJsonError to the file path', async () => {
    const filePath = path.join(tmpDir, 'broken.json');
    await fs.writeFile(filePath, '{ bad }', 'utf-8');

    let caught: unknown;
    try {
      await readJson(filePath);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InvalidJsonError);
    expect((caught as InvalidJsonError).path).toBe(filePath);
  });

  it('does not alter the file when reading', async () => {
    const filePath = path.join(tmpDir, 'settings.json');
    const original = '{"a":1}';
    await fs.writeFile(filePath, original, 'utf-8');

    await readJson(filePath);

    const after = await fs.readFile(filePath, 'utf-8');
    expect(after).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// readText
// ---------------------------------------------------------------------------

describe('readText', () => {
  it("returns '' when the file does not exist", async () => {
    const result = await readText(path.join(tmpDir, 'missing.md'));
    expect(result).toBe('');
  });

  it('returns the file content as a string when the file exists', async () => {
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    await fs.writeFile(filePath, 'Hello world\n', 'utf-8');

    const result = await readText(filePath);
    expect(result).toBe('Hello world\n');
  });
});

// ---------------------------------------------------------------------------
// writeJson
// ---------------------------------------------------------------------------

describe('writeJson', () => {
  it('writes indented JSON with a trailing newline', async () => {
    const filePath = path.join(tmpDir, 'out.json');
    await writeJson(filePath, { hello: 'world' });

    const raw = await fs.readFile(filePath, 'utf-8');
    expect(raw).toBe('{\n  "hello": "world"\n}\n');
  });

  it('creates missing parent directories', async () => {
    const filePath = path.join(tmpDir, 'nested', 'deep', 'file.json');
    await writeJson(filePath, { x: 1 });

    const raw = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toEqual({ x: 1 });
  });

  it('round-trips: writeJson then readJson returns the same data', async () => {
    const filePath = path.join(tmpDir, 'state.json');
    const data = { version: 1, artifacts: [] };

    await writeJson(filePath, data);
    const result = await readJson(filePath);

    expect(result).toEqual(data);
  });
});
