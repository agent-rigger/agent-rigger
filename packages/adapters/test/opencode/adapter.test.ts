/**
 * End-to-end tests for OpencodeAdapter dispatch (audit/plan/planRemove/apply).
 *
 * Verifies:
 * - adapter id is 'opencode'.
 * - context + skill natures dispatch correctly (detailed coverage lives in
 *   context.test.ts / skills.test.ts — this file only smoke-tests dispatch).
 * - unregistered natures (hook, tool — Phase D3 / advisory-only) throw
 *   UnsupportedNatureError for audit / plan / planRemove.
 *
 * Isolation: fresh RIGGER_HOME via tmp dir per test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import type { Env } from '@agent-rigger/core/paths';
import type { Nature } from '@agent-rigger/core/types';

import { createOpencodeAdapter, UnsupportedNatureError } from '../../src/opencode/adapter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-opencode-adapter-e2e-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// createOpencodeAdapter — id
// ---------------------------------------------------------------------------

describe('OpencodeAdapter — adapter id', () => {
  it('has id "opencode"', () => {
    const adapter = createOpencodeAdapter({});
    expect(adapter.id).toBe('opencode');
  });
});

// ---------------------------------------------------------------------------
// UnsupportedNatureError — Phase D natures not yet wired
// ---------------------------------------------------------------------------

describe('OpencodeAdapter — unsupported natures (hook not yet wired, tool advisory-only)', () => {
  // 'guardrail'/'agent' were wired in Phase C (guardrails.test.ts / agents.test.ts);
  // 'mcp'/'plugin' were wired in Phase D (mcp.test.ts / plugins.test.ts).
  const natures: Nature[] = ['hook', 'tool'];

  for (const nature of natures) {
    it(`throws UnsupportedNatureError for nature "${nature}" during audit`, async () => {
      const adapter = createOpencodeAdapter({});
      const entry: AdapterEntry = { id: `${nature}-foo`, nature, scope: 'user' };

      await expect(adapter.audit(entry, 'user', env)).rejects.toBeInstanceOf(
        UnsupportedNatureError,
      );
    });

    it(`throws UnsupportedNatureError for nature "${nature}" during plan`, async () => {
      const adapter = createOpencodeAdapter({});
      const entry: AdapterEntry = { id: `${nature}-foo`, nature, scope: 'user' };

      await expect(adapter.plan(entry, 'user', env)).rejects.toBeInstanceOf(
        UnsupportedNatureError,
      );
    });

    it(`throws UnsupportedNatureError for nature "${nature}" during planRemove`, async () => {
      const adapter = createOpencodeAdapter({});
      const entry: AdapterEntry = { id: `${nature}-foo`, nature, scope: 'user' };

      await expect(adapter.planRemove(entry, 'user', env)).rejects.toBeInstanceOf(
        UnsupportedNatureError,
      );
    });
  }

  it('UnsupportedNatureError carries the nature in its message', async () => {
    const adapter = createOpencodeAdapter({});
    const entry: AdapterEntry = { id: 'hook-foo', nature: 'hook', scope: 'user' };

    let caught: unknown;
    try {
      await adapter.audit(entry, 'user', env);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(UnsupportedNatureError);
    expect((caught as UnsupportedNatureError).nature).toBe('hook');
    expect((caught as Error).message).toContain('hook');
  });
});

// ---------------------------------------------------------------------------
// Dispatch smoke tests — context + skill
// ---------------------------------------------------------------------------

describe('OpencodeAdapter — context + skill dispatch smoke', () => {
  it('dispatches nature "context" to the context handler', async () => {
    const adapter = createOpencodeAdapter({ agentsContent: 'hello\n' });
    const entry: AdapterEntry = { id: 'context-opencode', nature: 'context', scope: 'user' };

    const report1 = await adapter.audit(entry, 'user', env);
    expect(report1.state).toBe('missing');

    const ops = await adapter.plan(entry, 'user', env);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('write-text');
    await adapter.apply(ops, env);

    const report2 = await adapter.audit(entry, 'user', env);
    expect(report2.state).toBe('present');

    const removeOps = await adapter.planRemove(entry, 'user', env);
    expect(removeOps).toEqual([{ kind: 'delete-file', path: (ops[0] as { path: string }).path }]);
    await adapter.applyRemove(removeOps, env);

    const report3 = await adapter.audit(entry, 'user', env);
    expect(report3.state).toBe('missing');
  });

  it('dispatches nature "skill" to the skill handler', async () => {
    const fixturesDir = path.join(tmp.dir, 'fixtures');
    const srcDir = path.join(fixturesDir, 'spec-workflow');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, 'SKILL.md'), '# spec-workflow\nFixture skill.');

    const adapter = createOpencodeAdapter({ skillSource: (_e: AdapterEntry) => srcDir });
    const entry: AdapterEntry = { id: 'skill:spec-workflow', nature: 'skill', scope: 'user' };

    const report1 = await adapter.audit(entry, 'user', env);
    expect(report1.state).toBe('missing');

    const ops = await adapter.plan(entry, 'user', env);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('link');
    await adapter.apply(ops, env);

    const report2 = await adapter.audit(entry, 'user', env);
    expect(report2.state).toBe('present');

    const removeOps = await adapter.planRemove(entry, 'user', env);
    expect(removeOps).toHaveLength(1);
    expect(removeOps[0]!.kind).toBe('unlink');
    await adapter.applyRemove(removeOps, env);

    const report3 = await adapter.audit(entry, 'user', env);
    expect(report3.state).toBe('missing');
  });
});
