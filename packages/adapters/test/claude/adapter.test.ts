/**
 * End-to-end tests for ClaudeAdapter via the engine (check/apply).
 *
 * Verifies:
 * - check exits 3 before apply (guardrail rules missing).
 * - check exits 0 after apply (rules present).
 * - 2nd apply is a no-op (idempotent, no new backup files).
 * - Other keys in settings.json survive the full apply cycle.
 * - Unsupported nature throws UnsupportedNatureError.
 *
 * Isolation: fresh RIGGER_HOME via tmp dir per test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply, check, reportExitCode } from '@agent-rigger/core/engine';
import { readJson, writeJson } from '@agent-rigger/core/fs-json';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { createClaudeAdapter, UnsupportedNatureError } from '../../src/claude/adapter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-adapter-e2e-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REF_DENY = ['Read(./.env)', 'Read(~/.ssh/**)', 'Read(./secrets/**)'];

const GUARDRAIL_ENTRY: AdapterEntry = {
  id: 'guardrails-claude',
  nature: 'guardrail',
  scope: 'user',
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let manifestPath: string;
let targets: ReturnType<typeof resolveUserTargets>;

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
  targets = resolveUserTargets(env);
  manifestPath = targets.stateJson;
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// End-to-end: check → apply → check → apply (idempotent)
// ---------------------------------------------------------------------------

describe('ClaudeAdapter — guardrail e2e via engine', () => {
  it('check exits 3 before apply (rules missing)', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });
    const report = await check(adapter, [GUARDRAIL_ENTRY], 'user', env);

    expect(reportExitCode(report)).toBe(3);
    expect(report.entries[0]!.state).toBe('missing');
  });

  it('check exits 0 after apply (rules present)', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });

    await apply(adapter, [GUARDRAIL_ENTRY], 'user', env, manifestPath);
    const report = await check(adapter, [GUARDRAIL_ENTRY], 'user', env);

    expect(reportExitCode(report)).toBe(0);
    expect(report.entries[0]!.state).toBe('present');
  });

  it('2nd apply is a no-op (no new backup, no new files written)', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });

    // Seed settings so backup() has something to copy on first apply
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, { permissions: { deny: [] }, model: 'sonnet' });

    const result1 = await apply(adapter, [GUARDRAIL_ENTRY], 'user', env, manifestPath);
    expect(result1.written.length).toBeGreaterThan(0);
    expect(result1.backedUp.length).toBeGreaterThan(0);

    const result2 = await apply(adapter, [GUARDRAIL_ENTRY], 'user', env, manifestPath);
    expect(result2.written).toHaveLength(0);
    expect(result2.backedUp).toHaveLength(0);
  });

  it('other settings keys survive the full apply cycle', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });

    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      model: 'claude-opus',
      theme: 'light',
      permissions: { deny: [], allowedTools: ['bash'] },
    });

    await apply(adapter, [GUARDRAIL_ENTRY], 'user', env, manifestPath);

    const result = await readJson(targets.claudeSettings);
    expect(result['model']).toBe('claude-opus');
    expect(result['theme']).toBe('light');
    const perms = result['permissions'] as Record<string, unknown>;
    expect(perms['allowedTools'] as string[]).toContain('bash');
    const deny = perms['deny'] as string[];
    for (const rule of REF_DENY) {
      expect(deny).toContain(rule);
    }
  });

  it('deny rules are not duplicated after 2 applies', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });

    await apply(adapter, [GUARDRAIL_ENTRY], 'user', env, manifestPath);
    await apply(adapter, [GUARDRAIL_ENTRY], 'user', env, manifestPath);

    const result = await readJson(targets.claudeSettings);
    const deny = ((result['permissions'] as Record<string, unknown>)['deny']) as string[];

    for (const rule of REF_DENY) {
      const occurrences = deny.filter((r) => r === rule).length;
      expect(occurrences).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// UnsupportedNatureError
// ---------------------------------------------------------------------------

describe('ClaudeAdapter — unsupported nature', () => {
  it('throws UnsupportedNatureError for an unregistered nature during audit', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });

    const entry: AdapterEntry = {
      id: 'agent-foo',
      nature: 'agent',
      scope: 'user',
    };

    let caught: unknown;
    try {
      await adapter.audit(entry, 'user', env);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(UnsupportedNatureError);
  });

  it('UnsupportedNatureError carries the nature in its message', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });

    const entry: AdapterEntry = {
      id: 'agent-foo',
      nature: 'agent',
      scope: 'user',
    };

    let caught: unknown;
    try {
      await adapter.audit(entry, 'user', env);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(UnsupportedNatureError);
    expect((caught as UnsupportedNatureError).nature).toBe('agent');
    expect((caught as Error).message).toContain('agent');
  });

  it('throws UnsupportedNatureError for an unregistered nature during plan', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });

    const entry: AdapterEntry = {
      id: 'agent-foo',
      nature: 'agent',
      scope: 'user',
    };

    await expect(adapter.plan(entry, 'user', env)).rejects.toBeInstanceOf(UnsupportedNatureError);
  });
});

// ---------------------------------------------------------------------------
// createClaudeAdapter — id
// ---------------------------------------------------------------------------

describe('ClaudeAdapter — adapter id', () => {
  it('has id "claude"', () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });
    expect(adapter.id).toBe('claude');
  });
});
