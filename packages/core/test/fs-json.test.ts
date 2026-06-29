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

import { InvalidJsonError, readJson, readText, writeJson, writeText } from '../src/fs-json';

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
// writeText
// ---------------------------------------------------------------------------

describe('writeText', () => {
  it('round-trips: writeText then readText returns the same content', async () => {
    const filePath = path.join(tmpDir, 'CLAUDE.md');
    const content = '# My config\n@~/.claude/harness/AGENTS.md\n';

    await writeText(filePath, content);
    const result = await readText(filePath);

    expect(result).toBe(content);
  });

  it('creates missing parent directories', async () => {
    const filePath = path.join(tmpDir, 'nested', 'deep', 'AGENTS.md');
    const content = 'agent context\n';

    await writeText(filePath, content);
    const result = await readText(filePath);

    expect(result).toBe(content);
  });

  it('overwrites an existing file', async () => {
    const filePath = path.join(tmpDir, 'file.md');
    await writeText(filePath, 'first\n');
    await writeText(filePath, 'second\n');

    const result = await readText(filePath);
    expect(result).toBe('second\n');
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

// ---------------------------------------------------------------------------
// atomic write (tmp + rename) — no half-written files, no leftover temp files
// ---------------------------------------------------------------------------

describe('atomic write', () => {
  it('leaves no .tmp-* turd after a successful writeJson', async () => {
    const filePath = path.join(tmpDir, 'state.json');
    await writeJson(filePath, { ok: true });

    const entries = await fs.readdir(tmpDir);
    expect(entries.filter((e) => e.includes('.tmp-'))).toHaveLength(0);
    expect(entries).toContain('state.json');
  });

  it('leaves no .tmp-* turd after a successful writeText', async () => {
    const filePath = path.join(tmpDir, 'AGENTS.md');
    await writeText(filePath, 'hello');

    const entries = await fs.readdir(tmpDir);
    expect(entries.filter((e) => e.includes('.tmp-'))).toHaveLength(0);
  });

  it('overwrites an existing file in full (no merge of old bytes)', async () => {
    const filePath = path.join(tmpDir, 'out.txt');
    await writeText(filePath, 'a-very-long-original-content-string');
    await writeText(filePath, 'short');

    expect(await readText(filePath)).toBe('short');
  });

  it('preserves the previous file and cleans up when the write fails', async () => {
    // Parent is a regular file → mkdir(ENOTDIR) makes the write throw.
    const blocker = path.join(tmpDir, 'blocker');
    await writeText(blocker, 'i am a file');
    const target = path.join(blocker, 'state.json');

    await expect(writeJson(target, { x: 1 })).rejects.toBeTruthy();

    // The blocker file is untouched and no stray temp file appeared.
    expect(await readText(blocker)).toBe('i am a file');
    const entries = await fs.readdir(tmpDir);
    expect(entries.filter((e) => e.includes('.tmp-'))).toHaveLength(0);
  });
});
