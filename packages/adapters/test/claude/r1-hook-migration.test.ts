/**
 * Tests for R1/D8 — traced migration of a hook whose canonical spec changed.
 *
 * Requirement (docs/specs/lot2-remove-reversible/requirements.md, R1, hook
 * scenario): when the catalog changes a hook's matcher or command, a re-install
 * SHALL leave a SINGLE rigger entry in settings.json — the old registration is
 * retired in the SAME run — and `applied` becomes the new spec, so a later
 * remove leaves neither entry behind. Without this, hasHook (event, matcher,
 * command)-strict reads the changed spec as "absent": the hook executes twice
 * on every tool use and remove only cleans half.
 *
 * Design D8: engine.apply enriches the entry with its pre-existing manifest
 * `applied` payload before adapter.plan (additive — other natures ignore it);
 * planHook compares the canonical spec against applied.hook and emits
 * remove-hooks(old) + merge-hooks(new) in the same plan.
 *
 * E2E through the real engine + real claude adapter against real files under
 * a fresh tmp HOME — no mocks of implementation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply, remove } from '@agent-rigger/core/engine';
import { readJson, writeJson } from '@agent-rigger/core/fs-json';
import { hasHook } from '@agent-rigger/core/hooks';
import { findEntry } from '@agent-rigger/core/manifest';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { createClaudeAdapter } from '../../src/claude/adapter';
import { planHook } from '../../src/claude/hooks';
import type { ResolvedHook } from '../../src/claude/hooks';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-hook-migration-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

const ID = 'main/hook:guard';

const V1: ResolvedHook = {
  event: 'PreToolUse',
  matcher: 'Bash',
  command: 'bun run /abs/hooks/guard.ts',
};

/** Catalog v2 changes the matcher only. */
const V2_MATCHER: ResolvedHook = { ...V1, matcher: 'Bash(*)' };

/** Catalog v2 changes the command only. */
const V2_COMMAND: ResolvedHook = { ...V1, command: 'bun run /abs/hooks/guard-v2.ts' };

function makeAdapter(spec: ResolvedHook): ReturnType<typeof createClaudeAdapter> {
  return createClaudeAdapter({ denyRef: [], hookSpec: () => spec });
}

function makeEntry(): AdapterEntry {
  return { id: ID, nature: 'hook', scope: 'user' };
}

/**
 * Count how many times any of `commands` appears across ALL events and matcher
 * entries of the hooks map. The migration invariant is exactly one rigger
 * registration in the whole file — never two (double execution).
 */
function countCommands(settings: Record<string, unknown>, commands: string[]): number {
  const hooksMap = (settings['hooks'] as Record<string, unknown> | undefined) ?? {};
  let count = 0;
  for (const value of Object.values(hooksMap)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      const hooks = (entry as { hooks?: unknown[] }).hooks ?? [];
      for (const item of hooks) {
        const cmd = (item as { command?: unknown }).command;
        if (typeof cmd === 'string' && commands.includes(cmd)) count++;
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let targets: ReturnType<typeof resolveUserTargets>;
let manifestPath: string;

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
// R1: changed matcher — single entry, remove cleans everything
// ---------------------------------------------------------------------------

describe('R1: hook migration on matcher change', () => {
  it('R1: catalog v2 changes the matcher — one rigger entry remains and remove cleans everything', async () => {
    // v1 install.
    await apply(makeAdapter(V1), [makeEntry()], 'user', env, manifestPath);

    // Catalog v2 changes the matcher → re-install migrates in the SAME run.
    const result = await apply(makeAdapter(V2_MATCHER), [makeEntry()], 'user', env, manifestPath);

    const settings = await readJson(targets.claudeSettings);
    expect(hasHook(settings, V2_MATCHER)).toBe(true);
    // The old registration was retired in the same run — no double execution.
    expect(hasHook(settings, V1)).toBe(false);
    // Exactly ONE rigger entry in the whole hooks map.
    expect(countCommands(settings, [V1.command, V2_MATCHER.command])).toBe(1);

    // applied = the NEW spec (replacement semantics, coherent with D1/T3).
    const entryAfter = findEntry(result.manifest, ID, 'user', 'claude');
    expect(entryAfter?.applied).toEqual({
      kind: 'hook',
      event: V2_MATCHER.event,
      matcher: V2_MATCHER.matcher,
      command: V2_MATCHER.command,
    });

    // A later remove leaves NEITHER entry behind.
    await remove(makeAdapter(V2_MATCHER), [makeEntry()], 'user', env, manifestPath);
    const postRemove = await readJson(targets.claudeSettings);
    expect(postRemove['hooks']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// R1: changed command — single entry, remove cleans everything
// ---------------------------------------------------------------------------

describe('R1: hook migration on command change', () => {
  it('R1: catalog v2 changes the command — old command retired in the same run, remove cleans everything', async () => {
    await apply(makeAdapter(V1), [makeEntry()], 'user', env, manifestPath);

    const result = await apply(makeAdapter(V2_COMMAND), [makeEntry()], 'user', env, manifestPath);

    const settings = await readJson(targets.claudeSettings);
    expect(hasHook(settings, V2_COMMAND)).toBe(true);
    expect(hasHook(settings, V1)).toBe(false);
    expect(countCommands(settings, [V1.command, V2_COMMAND.command])).toBe(1);

    const entryAfter = findEntry(result.manifest, ID, 'user', 'claude');
    expect(entryAfter?.applied).toEqual({
      kind: 'hook',
      event: V2_COMMAND.event,
      matcher: V2_COMMAND.matcher,
      command: V2_COMMAND.command,
    });

    await remove(makeAdapter(V2_COMMAND), [makeEntry()], 'user', env, manifestPath);
    const postRemove = await readJson(targets.claudeSettings);
    expect(postRemove['hooks']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// R1: unchanged spec — idempotence preserved
// ---------------------------------------------------------------------------

describe('R1: unchanged hook spec stays a no-op', () => {
  it('R1: re-install with the same spec is a no-op (no write, no backup, file untouched)', async () => {
    await apply(makeAdapter(V1), [makeEntry()], 'user', env, manifestPath);
    const before = await fs.readFile(targets.claudeSettings, 'utf8');

    const result = await apply(makeAdapter(V1), [makeEntry()], 'user', env, manifestPath);

    expect(result.written).toEqual([]);
    expect(result.backedUp).toEqual([]);
    const after = await fs.readFile(targets.claudeSettings, 'utf8');
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// R1: the migration run is backed up (R8 parity on apply — T1 coverage)
// ---------------------------------------------------------------------------

describe('R1: migration run creates a backup', () => {
  it('R1: a .bak of settings.json captures the pre-migration state', async () => {
    await apply(makeAdapter(V1), [makeEntry()], 'user', env, manifestPath);
    const preMigration = await fs.readFile(targets.claudeSettings, 'utf8');

    const result = await apply(makeAdapter(V2_MATCHER), [makeEntry()], 'user', env, manifestPath);

    const bak = result.backedUp.find((p) => p.includes('settings.json.bak-'));
    expect(bak).toBeDefined();
    const bakContent = await fs.readFile(bak as string, 'utf8');
    // The backup is the state BEFORE the migration — old spec still registered.
    expect(bakContent).toBe(preMigration);
    expect(hasHook(JSON.parse(bakContent) as Record<string, unknown>, V1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// planHook unit level — the migration plan itself (D8)
// ---------------------------------------------------------------------------

describe('planHook — traced migration plan (D8)', () => {
  it('R1: emits remove-hooks(old) + merge-hooks(new) in the same plan when the spec changed', async () => {
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      hooks: {
        [V1.event]: [{ matcher: V1.matcher, hooks: [{ type: 'command', command: V1.command }] }],
      },
    });
    const entry: AdapterEntry = { ...makeEntry(), applied: { kind: 'hook', ...V1 } };

    const ops = await planHook(entry, 'user', env, V2_MATCHER);

    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({
      kind: 'remove-hooks',
      path: targets.claudeSettings,
      event: V1.event,
      matcher: V1.matcher,
      command: V1.command,
    });
    expect(ops[1]).toMatchObject({
      kind: 'merge-hooks',
      path: targets.claudeSettings,
      event: V2_MATCHER.event,
      matcher: V2_MATCHER.matcher,
      command: V2_MATCHER.command,
    });
  });

  it('R1: emits only merge-hooks when the old registration is already gone from disk', async () => {
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {});
    const entry: AdapterEntry = { ...makeEntry(), applied: { kind: 'hook', ...V1 } };

    const ops = await planHook(entry, 'user', env, V2_MATCHER);

    expect(ops).toHaveLength(1);
    expect(ops[0]?.kind).toBe('merge-hooks');
  });

  it('R1: legacy entry without applied keeps the plain merge behaviour (no migration trace)', async () => {
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      hooks: {
        [V1.event]: [{ matcher: V1.matcher, hooks: [{ type: 'command', command: V1.command }] }],
      },
    });

    const ops = await planHook(makeEntry(), 'user', env, V2_MATCHER);

    expect(ops).toHaveLength(1);
    expect(ops[0]?.kind).toBe('merge-hooks');
  });

  it('R1: unchanged spec with applied present stays an empty plan (idempotent)', async () => {
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      hooks: {
        [V1.event]: [{ matcher: V1.matcher, hooks: [{ type: 'command', command: V1.command }] }],
      },
    });
    const entry: AdapterEntry = { ...makeEntry(), applied: { kind: 'hook', ...V1 } };

    const ops = await planHook(entry, 'user', env, V1);

    expect(ops).toHaveLength(0);
  });
});
