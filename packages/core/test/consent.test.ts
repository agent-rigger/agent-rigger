/**
 * Tests for consent.ts — granular tool-check consent ledger.
 *
 * TDD: written before the implementation (RED → GREEN).
 *
 * Isolation: each test uses a fresh tmp directory as RIGGER_HOME so the
 * ledger never touches the real ~/.config/agent-rigger/consent.json.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { hashCommand, isConsented, recordConsent } from '../src/consent';
import type { Env } from '../src/paths';

// ---------------------------------------------------------------------------
// Fixture lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;
let env: Env;
let consentPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-consent-'));
  env = { RIGGER_HOME: tmpDir };
  consentPath = path.join(tmpDir, '.config', 'agent-rigger', 'consent.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// hashCommand
// ---------------------------------------------------------------------------

describe('hashCommand', () => {
  it('returns a 64-char lowercase hex sha256 digest', () => {
    const hash = hashCommand('command -v glab');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same command', () => {
    expect(hashCommand('which gh')).toBe(hashCommand('which gh'));
  });

  it('differs for different commands', () => {
    expect(hashCommand('which gh')).not.toBe(hashCommand('which glab'));
  });
});

// ---------------------------------------------------------------------------
// isConsented
// ---------------------------------------------------------------------------

describe('isConsented', () => {
  it('returns false when the ledger file does not exist', async () => {
    const result = await isConsented(env, { id: 'tool:glab', command: 'which glab' });
    expect(result).toBe(false);
  });

  it('returns false when the ledger file is malformed JSON', async () => {
    await fs.mkdir(path.dirname(consentPath), { recursive: true });
    await fs.writeFile(consentPath, '{ not valid json', 'utf-8');

    const result = await isConsented(env, { id: 'tool:glab', command: 'which glab' });
    expect(result).toBe(false);
  });

  it('returns true after recordConsent for the same id + command', async () => {
    await recordConsent(env, { id: 'tool:glab', command: 'which glab' });
    const result = await isConsented(env, { id: 'tool:glab', command: 'which glab' });
    expect(result).toBe(true);
  });

  it('returns false when the command differs even for the same id', async () => {
    await recordConsent(env, { id: 'tool:glab', command: 'which glab' });
    const result = await isConsented(env, { id: 'tool:glab', command: 'which glab --version' });
    expect(result).toBe(false);
  });

  it('returns false for a different id, even with the same command', async () => {
    await recordConsent(env, { id: 'tool:glab', command: 'which glab' });
    const result = await isConsented(env, { id: 'tool:gh', command: 'which glab' });
    expect(result).toBe(false);
  });

  it('stays true when only the recorded sha changes for the same id + command', async () => {
    await recordConsent(env, { id: 'tool:glab', command: 'which glab', sha: 'sha-1' });
    // Re-approve the SAME command under a different catalog sha — the match
    // key is (id, commandHash), not sha, so this is a no-op re-affirmation.
    await recordConsent(env, { id: 'tool:glab', command: 'which glab', sha: 'sha-2' });

    const result = await isConsented(env, { id: 'tool:glab', command: 'which glab' });
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// recordConsent
// ---------------------------------------------------------------------------

describe('recordConsent', () => {
  it('writes an entry with id, commandHash and an ISO approvedAt', async () => {
    await recordConsent(env, { id: 'tool:glab', command: 'which glab' });

    const raw = JSON.parse(await fs.readFile(consentPath, 'utf-8')) as {
      version: number;
      entries: { id: string; commandHash: string; approvedAt: string; sha?: string }[];
    };

    expect(raw.version).toBe(1);
    expect(raw.entries).toHaveLength(1);
    const entry = raw.entries[0];
    expect(entry?.id).toBe('tool:glab');
    expect(entry?.commandHash).toBe(hashCommand('which glab'));
    expect(Number.isNaN(new Date(entry?.approvedAt ?? '').getTime())).toBe(false);
  });

  it('records sha when provided', async () => {
    await recordConsent(env, { id: 'tool:glab', command: 'which glab', sha: 'abc123' });

    const raw = JSON.parse(await fs.readFile(consentPath, 'utf-8')) as {
      entries: { sha?: string }[];
    };
    expect(raw.entries[0]?.sha).toBe('abc123');
  });

  it('omits sha when not provided', async () => {
    await recordConsent(env, { id: 'tool:glab', command: 'which glab' });

    const raw = JSON.parse(await fs.readFile(consentPath, 'utf-8')) as {
      entries: Record<string, unknown>[];
    };
    expect('sha' in (raw.entries[0] ?? {})).toBe(false);
  });

  it('is idempotent: a second call with the same id + command does not duplicate the entry', async () => {
    await recordConsent(env, { id: 'tool:glab', command: 'which glab' });
    await recordConsent(env, { id: 'tool:glab', command: 'which glab' });

    const raw = JSON.parse(await fs.readFile(consentPath, 'utf-8')) as { entries: unknown[] };
    expect(raw.entries).toHaveLength(1);
  });

  it('adds a new entry when the command changes for the same id (re-prompt case)', async () => {
    await recordConsent(env, { id: 'tool:glab', command: 'which glab' });
    await recordConsent(env, { id: 'tool:glab', command: 'which glab --version' });

    const raw = JSON.parse(await fs.readFile(consentPath, 'utf-8')) as { entries: unknown[] };
    expect(raw.entries).toHaveLength(2);
  });

  it('self-heals a malformed ledger file instead of throwing', async () => {
    await fs.mkdir(path.dirname(consentPath), { recursive: true });
    await fs.writeFile(consentPath, 'not json at all', 'utf-8');

    await recordConsent(env, { id: 'tool:glab', command: 'which glab' });

    const raw = JSON.parse(await fs.readFile(consentPath, 'utf-8')) as { entries: unknown[] };
    expect(raw.entries).toHaveLength(1);
  });

  it('writes atomically — no leftover .tmp-* file', async () => {
    await recordConsent(env, { id: 'tool:glab', command: 'which glab' });

    const entries = await fs.readdir(path.dirname(consentPath));
    expect(entries.filter((e) => e.includes('.tmp-'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Ledger shape — human/tool readable JSON
// ---------------------------------------------------------------------------

describe('ledger shape', () => {
  it('is a flat { version, entries: [...] } document', async () => {
    await recordConsent(env, { id: 'tool:glab', command: 'which glab' });
    await recordConsent(env, { id: 'tool:gh', command: 'which gh', sha: 'deadbeef' });

    const raw = JSON.parse(await fs.readFile(consentPath, 'utf-8')) as Record<string, unknown>;
    expect(typeof raw['version']).toBe('number');
    expect(Array.isArray(raw['entries'])).toBe(true);
    expect((raw['entries'] as unknown[]).length).toBe(2);
  });
});
