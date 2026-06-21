/**
 * Tests for manifest.ts — readManifest, writeManifest, upsertEntry, findEntry, detectDrift.
 *
 * Isolation: each test uses a fresh tmp directory under os.tmpdir().
 * afterEach removes the entire tmp tree.
 *
 * TDD order: tests written first (RED), then src/manifest.ts (GREEN).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  detectDrift,
  emptyManifest,
  findEntry,
  readManifest,
  upsertEntry,
  writeManifest,
} from '../src/manifest';
import type { Manifest, ManifestEntry } from '../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-manifest-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Build a minimal but complete ManifestEntry for tests. */
function makeEntry(
  id: string,
  scope: 'user' | 'project',
  files: string[] = [],
): ManifestEntry {
  return {
    id,
    nature: 'guardrail',
    source: 'internal',
    ref: 'v0.0.1',
    sha: 'abc123def456',
    scope,
    installedAt: '2026-06-21T12:00:00.000Z',
    files,
  };
}

// ---------------------------------------------------------------------------
// emptyManifest
// ---------------------------------------------------------------------------

describe('emptyManifest', () => {
  it('returns { version: 1, artifacts: [] }', () => {
    const m = emptyManifest();
    expect(m).toEqual({ version: 1, artifacts: [] });
  });

  it('returns a fresh object on each call (no shared reference)', () => {
    const a = emptyManifest();
    const b = emptyManifest();
    a.artifacts.push(makeEntry('x', 'user'));
    expect(b.artifacts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// readManifest
// ---------------------------------------------------------------------------

describe('readManifest', () => {
  it('returns emptyManifest() when the file does not exist', async () => {
    const result = await readManifest(path.join(tmpDir, 'missing.json'));
    expect(result).toEqual(emptyManifest());
  });

  it('returns emptyManifest() when file contains {} (missing version/artifacts)', async () => {
    const filePath = path.join(tmpDir, 'state.json');
    await fs.writeFile(filePath, '{}', 'utf-8');

    const result = await readManifest(filePath);
    expect(result).toEqual(emptyManifest());
  });

  it('returns emptyManifest() when version is wrong type', async () => {
    const filePath = path.join(tmpDir, 'state.json');
    await fs.writeFile(filePath, JSON.stringify({ version: 'bad', artifacts: [] }), 'utf-8');

    const result = await readManifest(filePath);
    expect(result).toEqual(emptyManifest());
  });

  it('returns emptyManifest() when artifacts is not an array', async () => {
    const filePath = path.join(tmpDir, 'state.json');
    await fs.writeFile(
      filePath,
      JSON.stringify({ version: 1, artifacts: 'not-an-array' }),
      'utf-8',
    );

    const result = await readManifest(filePath);
    expect(result).toEqual(emptyManifest());
  });

  it('round-trips: writeManifest then readManifest returns equal manifest', async () => {
    const filePath = path.join(tmpDir, 'state.json');
    const entry = makeEntry('guardrails-claude', 'user', ['/home/user/.claude/settings.json']);
    const manifest: Manifest = { version: 1, artifacts: [entry] };

    await writeManifest(filePath, manifest);
    const result = await readManifest(filePath);

    expect(result).toEqual(manifest);
  });

  it('preserves ref, sha, files, installedAt after round-trip', async () => {
    const filePath = path.join(tmpDir, 'state.json');
    const entry = makeEntry('skill-spec', 'user', ['/home/user/.claude/skills/spec/SKILL.md']);
    const manifest: Manifest = { version: 1, artifacts: [entry] };

    await writeManifest(filePath, manifest);
    const result = await readManifest(filePath);

    const stored = result.artifacts[0];
    expect(stored).toBeDefined();
    expect(stored!.ref).toBe('v0.0.1');
    expect(stored!.sha).toBe('abc123def456');
    expect(stored!.installedAt).toBe('2026-06-21T12:00:00.000Z');
    expect(stored!.files).toEqual(['/home/user/.claude/skills/spec/SKILL.md']);
  });
});

// ---------------------------------------------------------------------------
// writeManifest
// ---------------------------------------------------------------------------

describe('writeManifest', () => {
  it('creates parent directories if missing', async () => {
    const filePath = path.join(tmpDir, 'nested', 'deep', 'state.json');
    await writeManifest(filePath, emptyManifest());

    const content = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(content)).toEqual({ version: 1, artifacts: [] });
  });

  it('writes indented JSON with a trailing newline', async () => {
    const filePath = path.join(tmpDir, 'state.json');
    await writeManifest(filePath, emptyManifest());

    const raw = await fs.readFile(filePath, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('  '); // 2-space indent from writeJson
  });
});

// ---------------------------------------------------------------------------
// upsertEntry
// ---------------------------------------------------------------------------

describe('upsertEntry', () => {
  it('adds a new entry when artifacts is empty', () => {
    const m = emptyManifest();
    const entry = makeEntry('guardrails-claude', 'user');

    const result = upsertEntry(m, entry);

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toEqual(entry);
  });

  it('adds a new entry when no entry matches (id+scope)', () => {
    const entry1 = makeEntry('a', 'user');
    const m: Manifest = { version: 1, artifacts: [entry1] };
    const entry2 = makeEntry('b', 'user');

    const result = upsertEntry(m, entry2);

    expect(result.artifacts).toHaveLength(2);
  });

  it('replaces the entry with the same id+scope', () => {
    const original = makeEntry('guardrails-claude', 'user', ['/old/path']);
    const m: Manifest = { version: 1, artifacts: [original] };
    const updated = makeEntry('guardrails-claude', 'user', ['/new/path']);

    const result = upsertEntry(m, updated);

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]!.files).toEqual(['/new/path']);
  });

  it('does not replace an entry with same id but different scope', () => {
    const userEntry = makeEntry('guardrails-claude', 'user');
    const m: Manifest = { version: 1, artifacts: [userEntry] };
    const projectEntry = makeEntry('guardrails-claude', 'project');

    const result = upsertEntry(m, projectEntry);

    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts.some((e) => e.scope === 'user')).toBe(true);
    expect(result.artifacts.some((e) => e.scope === 'project')).toBe(true);
  });

  it('preserves order of other entries when replacing', () => {
    const a = makeEntry('a', 'user');
    const b = makeEntry('b', 'user');
    const c = makeEntry('c', 'user');
    const m: Manifest = { version: 1, artifacts: [a, b, c] };
    const bUpdated = { ...b, ref: 'v1.0.0' };

    const result = upsertEntry(m, bUpdated);

    expect(result.artifacts[0]!.id).toBe('a');
    expect(result.artifacts[1]!.id).toBe('b');
    expect(result.artifacts[1]!.ref).toBe('v1.0.0');
    expect(result.artifacts[2]!.id).toBe('c');
  });

  it('does not mutate the original manifest', () => {
    const m = emptyManifest();
    const entry = makeEntry('x', 'user');

    upsertEntry(m, entry);

    expect(m.artifacts).toHaveLength(0);
  });

  it('does not mutate the original artifacts array', () => {
    const entry1 = makeEntry('a', 'user');
    const m: Manifest = { version: 1, artifacts: [entry1] };
    const originalArtifacts = m.artifacts;

    upsertEntry(m, makeEntry('b', 'user'));

    expect(m.artifacts).toBe(originalArtifacts);
    expect(m.artifacts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// findEntry
// ---------------------------------------------------------------------------

describe('findEntry', () => {
  it('returns the entry matching id+scope', () => {
    const entry = makeEntry('guardrails-claude', 'user');
    const m: Manifest = { version: 1, artifacts: [entry] };

    const found = findEntry(m, 'guardrails-claude', 'user');

    expect(found).toEqual(entry);
  });

  it('returns undefined when id matches but scope differs', () => {
    const entry = makeEntry('guardrails-claude', 'user');
    const m: Manifest = { version: 1, artifacts: [entry] };

    const found = findEntry(m, 'guardrails-claude', 'project');

    expect(found).toBeUndefined();
  });

  it('returns undefined when no entry matches', () => {
    const m = emptyManifest();

    const found = findEntry(m, 'nonexistent', 'user');

    expect(found).toBeUndefined();
  });

  it('returns the correct entry when multiple entries exist', () => {
    const user = makeEntry('skill-spec', 'user');
    const project = makeEntry('skill-spec', 'project');
    const other = makeEntry('other-skill', 'user');
    const m: Manifest = { version: 1, artifacts: [user, project, other] };

    const found = findEntry(m, 'skill-spec', 'project');

    expect(found).toEqual(project);
  });
});

// ---------------------------------------------------------------------------
// detectDrift
// ---------------------------------------------------------------------------

describe('detectDrift', () => {
  it('returns missing: [] when all files exist', async () => {
    const file1 = path.join(tmpDir, 'file1.txt');
    const file2 = path.join(tmpDir, 'file2.txt');
    await fs.writeFile(file1, 'content', 'utf-8');
    await fs.writeFile(file2, 'content', 'utf-8');

    const entry = makeEntry('test', 'user', [file1, file2]);
    const result = await detectDrift(entry);

    expect(result.missing).toEqual([]);
  });

  it('returns missing: [] when entry has no files', async () => {
    const entry = makeEntry('test', 'user', []);
    const result = await detectDrift(entry);

    expect(result.missing).toEqual([]);
  });

  it('returns the missing file path when a file was deleted', async () => {
    const present = path.join(tmpDir, 'present.txt');
    const missing = path.join(tmpDir, 'missing.txt');
    await fs.writeFile(present, 'content', 'utf-8');
    // missing.txt intentionally not created

    const entry = makeEntry('test', 'user', [present, missing]);
    const result = await detectDrift(entry);

    expect(result.missing).toEqual([missing]);
  });

  it('lists all absent files when multiple files are missing', async () => {
    const missing1 = path.join(tmpDir, 'a.txt');
    const missing2 = path.join(tmpDir, 'b.txt');
    // neither created

    const entry = makeEntry('test', 'user', [missing1, missing2]);
    const result = await detectDrift(entry);

    expect(result.missing).toHaveLength(2);
    expect(result.missing).toContain(missing1);
    expect(result.missing).toContain(missing2);
  });

  it('drift is detected (missing.length > 0) when any file is absent', async () => {
    const present = path.join(tmpDir, 'present.txt');
    const gone = path.join(tmpDir, 'gone.txt');
    await fs.writeFile(present, 'x', 'utf-8');

    const entry = makeEntry('test', 'user', [present, gone]);
    const result = await detectDrift(entry);

    expect(result.missing.length).toBeGreaterThan(0);
  });
});
