/**
 * Tests for assistant-select.ts — resolve the target assistant (R1).
 *
 * Split in two:
 * - decideAssistant: pure, exhaustive branch coverage (no I/O).
 * - resolveAssistant: IO wrapper — detection via RIGGER_HOME tmp dirs (existing
 *   isolation seam), picker injected (no real TTY/clack in tests).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Assistant } from '@agent-rigger/core';
import type { Env } from '@agent-rigger/core/paths';

import { decideAssistant, detectAssistants, resolveAssistant } from '../src/assistant-select';

// ---------------------------------------------------------------------------
// decideAssistant — pure, exhaustive
// ---------------------------------------------------------------------------

describe('decideAssistant', () => {
  it('a valid flag wins over everything else', () => {
    const result = decideAssistant({
      flag: 'opencode',
      configAssistants: ['claude'],
      detected: ['claude'],
      isTTY: false,
    });
    expect(result).toEqual({ assistant: 'opencode' });
  });

  it('accepts flag "claude"', () => {
    const result = decideAssistant({ flag: 'claude', detected: [], isTTY: false });
    expect(result).toEqual({ assistant: 'claude' });
  });

  it('an invalid flag value is an actionable error, regardless of other inputs', () => {
    const result = decideAssistant({
      flag: 'copilot',
      configAssistants: ['claude'],
      detected: ['claude'],
      isTTY: true,
    });
    expect(result).toEqual({
      error: expect.stringContaining('copilot') as unknown as string,
    });
  });

  it('configAssistants with exactly one value wins (no flag)', () => {
    const result = decideAssistant({
      configAssistants: ['opencode'],
      detected: ['claude', 'opencode'],
      isTTY: false,
    });
    expect(result).toEqual({ assistant: 'opencode' });
  });

  it('detected with exactly one value wins when config is absent', () => {
    const result = decideAssistant({ detected: ['opencode'], isTTY: false });
    expect(result).toEqual({ assistant: 'opencode' });
  });

  it('detected with exactly one value wins over an ambiguous config (>1)', () => {
    const result = decideAssistant({
      configAssistants: ['claude', 'opencode'],
      detected: ['claude'],
      isTTY: false,
    });
    expect(result).toEqual({ assistant: 'claude' });
  });

  it('TTY + ambiguous config and detection → needsPrompt with the union as candidates', () => {
    const result = decideAssistant({
      configAssistants: ['claude', 'opencode'],
      detected: ['claude', 'opencode'],
      isTTY: true,
    });
    expect(result).toEqual({ needsPrompt: expect.arrayContaining(['claude', 'opencode']) });
    if ('needsPrompt' in result) {
      expect(result.needsPrompt).toHaveLength(2);
    }
  });

  it('TTY + nothing detected/configured → needsPrompt with both assistants as fallback candidates', () => {
    const result = decideAssistant({ detected: [], isTTY: true });
    expect(result).toEqual({ needsPrompt: expect.arrayContaining(['claude', 'opencode']) });
    if ('needsPrompt' in result) {
      expect(result.needsPrompt).toHaveLength(2);
    }
  });

  it('non-TTY + nothing resolvable → actionable error mentioning --assistant and config', () => {
    const result = decideAssistant({ detected: [], isTTY: false });
    expect(result).toEqual({
      error: expect.stringContaining('--assistant') as unknown as string,
    });
  });

  it('non-TTY + ambiguous config and detection → actionable error (no silent default)', () => {
    const result = decideAssistant({
      configAssistants: ['claude', 'opencode'],
      detected: ['claude', 'opencode'],
      isTTY: false,
    });
    expect('error' in result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectAssistants — presence of ~/.claude and ~/.config/opencode
// ---------------------------------------------------------------------------

let tmp: string;
let env: Env;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-assistant-select-'));
  env = { RIGGER_HOME: path.join(tmp, 'home') };
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('detectAssistants', () => {
  it('detects nothing when neither ~/.claude nor ~/.config/opencode exists', async () => {
    const detected = await detectAssistants(env);
    expect(detected).toEqual([]);
  });

  it('detects claude when ~/.claude exists', async () => {
    await fs.mkdir(path.join(tmp, 'home', '.claude'), { recursive: true });
    const detected = await detectAssistants(env);
    expect(detected).toEqual(['claude']);
  });

  it('detects opencode when ~/.config/opencode exists', async () => {
    await fs.mkdir(path.join(tmp, 'home', '.config', 'opencode'), { recursive: true });
    const detected = await detectAssistants(env);
    expect(detected).toEqual(['opencode']);
  });

  it('detects both when both exist', async () => {
    await fs.mkdir(path.join(tmp, 'home', '.claude'), { recursive: true });
    await fs.mkdir(path.join(tmp, 'home', '.config', 'opencode'), { recursive: true });
    const detected = await detectAssistants(env);
    expect(detected).toEqual(['claude', 'opencode']);
  });
});

// ---------------------------------------------------------------------------
// resolveAssistant — IO wrapper, injected picker
// ---------------------------------------------------------------------------

describe('resolveAssistant', () => {
  it('returns the flag without ever calling the picker', async () => {
    let called = false;
    const assistant = await resolveAssistant({
      flag: 'claude',
      env,
      isTTY: true,
      picker: async (): Promise<Assistant> => {
        called = true;
        return 'opencode';
      },
    });
    expect(assistant).toBe('claude');
    expect(called).toBe(false);
  });

  it('returns the single configAssistants value without detection mattering', async () => {
    const assistant = await resolveAssistant({
      configAssistants: ['opencode'],
      env,
      isTTY: false,
    });
    expect(assistant).toBe('opencode');
  });

  it('falls back to detection when no flag/config is set', async () => {
    await fs.mkdir(path.join(tmp, 'home', '.claude'), { recursive: true });
    const assistant = await resolveAssistant({ env, isTTY: false });
    expect(assistant).toBe('claude');
  });

  it('calls the injected picker when ambiguous + TTY, and returns its choice', async () => {
    await fs.mkdir(path.join(tmp, 'home', '.claude'), { recursive: true });
    await fs.mkdir(path.join(tmp, 'home', '.config', 'opencode'), { recursive: true });

    let receivedCandidates: Assistant[] = [];
    const assistant = await resolveAssistant({
      env,
      isTTY: true,
      picker: async (candidates): Promise<Assistant> => {
        receivedCandidates = candidates;
        return 'opencode';
      },
    });

    expect(assistant).toBe('opencode');
    expect(receivedCandidates).toEqual(expect.arrayContaining(['claude', 'opencode']));
  });

  it('rejects with an actionable error when non-TTY and nothing resolvable', async () => {
    await expect(resolveAssistant({ env, isTTY: false })).rejects.toThrow(/--assistant/);
  });

  it('rejects when the flag value is invalid', async () => {
    await expect(resolveAssistant({ flag: 'bogus', env, isTTY: false })).rejects.toThrow(/bogus/);
  });

  // -------------------------------------------------------------------------
  // fallback — back-compat default for the "nothing resolvable" case only
  // -------------------------------------------------------------------------

  it('returns the fallback instead of throwing when non-TTY and nothing resolvable', async () => {
    const assistant = await resolveAssistant({ env, isTTY: false, fallback: 'claude' });
    expect(assistant).toBe('claude');
  });

  it('does not apply the fallback to an invalid flag value — still throws', async () => {
    await expect(
      resolveAssistant({ flag: 'bogus', env, isTTY: false, fallback: 'claude' }),
    ).rejects.toThrow(/bogus/);
  });

  it('does not need the fallback when TTY should prompt instead — picker still wins', async () => {
    await fs.mkdir(path.join(tmp, 'home', '.claude'), { recursive: true });
    await fs.mkdir(path.join(tmp, 'home', '.config', 'opencode'), { recursive: true });

    const assistant = await resolveAssistant({
      env,
      isTTY: true,
      fallback: 'claude',
      picker: async (): Promise<Assistant> => 'opencode',
    });
    expect(assistant).toBe('opencode');
  });
});
