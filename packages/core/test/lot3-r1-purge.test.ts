/**
 * Tests for lot3-robustesse-moteur R1 — engine.remove purges manifest entries
 * whose target has vanished from disk, WITHOUT purging deliberate leave-alone
 * conservations (design D1).
 *
 * Two empty-plan shapes, opposite semantics:
 *   - plannedOps.length === 0            → target ABSENT from disk → purge the
 *     phantom manifest entry (channel `purged`, no disk mutation). A hook purge
 *     additionally emits the generic "edited or removed" warning (ratified
 *     2026-07-10 — a hand-removed and a hand-edited hook both collapse here).
 *   - ops empty but plannedOps NON-empty → leave-alone (target present but
 *     unmanaged) → conservation, R3 Lot 2 contract, nothing purged.
 *
 * Uses inline minimal adapters — the purge decision is adapter-agnostic engine
 * logic, so no cross-package dependency on @agent-rigger/adapters is needed.
 *
 * Isolation: fresh tmp HOME per test via makeTmpHome().
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { Adapter } from '../src/adapter';
import { remove } from '../src/engine';
import { readManifest, upsertEntry, writeManifest } from '../src/manifest';
import { resolveUserTargets } from '../src/paths';
import type { Env } from '../src/paths';
import type { Nature, NatureReport, RemovalOp, Scope, WriteOp } from '../src/types';
import { makeTmpHome } from './tmp-home';

// ---------------------------------------------------------------------------
// Inline adapters
// ---------------------------------------------------------------------------

/** Adapter whose planRemove always returns [] — simulates a target absent from
 * disk (the planner finds nothing to do). */
function makeAbsentTargetAdapter(): Adapter {
  return {
    id: 'claude',
    async audit(entry): Promise<NatureReport> {
      return { id: entry.id, nature: entry.nature, state: 'missing' };
    },
    async plan(): Promise<WriteOp[]> {
      return [];
    },
    async apply(): Promise<void> {},
    async planRemove(): Promise<RemovalOp[]> {
      return [];
    },
    async applyRemove(): Promise<void> {},
  };
}

/** Adapter whose planRemove returns a warning-only leave-alone op — simulates a
 * target present on disk but not managed by rigger (drift). */
function makeLeaveAloneAdapter(): Adapter {
  return {
    id: 'claude',
    async audit(entry): Promise<NatureReport> {
      return { id: entry.id, nature: entry.nature, state: 'drift' };
    },
    async plan(): Promise<WriteOp[]> {
      return [];
    },
    async apply(): Promise<void> {},
    async planRemove(_entry, _scope, _env): Promise<RemovalOp[]> {
      return [{
        kind: 'leave-alone',
        target: '/tmp/unmanaged',
        warnings: ['present but not managed — left in place'],
      }];
    },
    async applyRemove(): Promise<void> {},
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let manifestPath: string;

beforeEach(async () => {
  tmp = await makeTmpHome('rigger-lot3-r1-purge-');
  env = tmp.env;
  manifestPath = resolveUserTargets(env).stateJson;
});

afterEach(async () => {
  await tmp.cleanup();
});

async function seedEntry(id: string, nature: Nature, scope: Scope = 'user'): Promise<void> {
  let manifest = await readManifest(manifestPath);
  manifest = upsertEntry(manifest, {
    id,
    nature,
    ref: 'v0.0.0',
    sha: '',
    scope,
    installedAt: new Date().toISOString(),
    files: [],
  });
  await writeManifest(manifestPath, manifest);
}

// ---------------------------------------------------------------------------
// Purge — target absent, manifest entry present
// ---------------------------------------------------------------------------

describe('engine.remove — lot3 R1 purge', () => {
  it('lot3-R1: an empty-plan entry still in the manifest is purged (channel + manifest)', async () => {
    const adapter = makeAbsentTargetAdapter();
    await seedEntry('guardrails-claude', 'guardrail');

    const result = await remove(
      adapter,
      [{ id: 'guardrails-claude', nature: 'guardrail', scope: 'user' }],
      'user',
      env,
      manifestPath,
    );

    expect(result.purged).toContain('guardrails-claude');
    expect(result.removed).toHaveLength(0);
    expect(result.backedUp).toHaveLength(0);

    const manifest = await readManifest(manifestPath);
    expect(manifest.artifacts.find((a) => a.id === 'guardrails-claude')).toBeUndefined();
  });

  it('lot3-R1: a purged hook entry emits the edited-or-removed warning', async () => {
    const adapter = makeAbsentTargetAdapter();
    await seedEntry('hook:guard', 'hook');

    const result = await remove(
      adapter,
      [{ id: 'hook:guard', nature: 'hook', scope: 'user' }],
      'user',
      env,
      manifestPath,
    );

    expect(result.purged).toContain('hook:guard');
    expect(result.warnings.join('\n')).toContain(
      'managed hook no longer present (edited or removed) — the current hook in settings.json is yours now',
    );
  });

  it('lot3-R1: a non-hook purge emits no hook warning', async () => {
    const adapter = makeAbsentTargetAdapter();
    await seedEntry('skill:x', 'skill');

    const result = await remove(
      adapter,
      [{ id: 'skill:x', nature: 'skill', scope: 'user' }],
      'user',
      env,
      manifestPath,
    );

    expect(result.purged).toContain('skill:x');
    expect(result.warnings).toHaveLength(0);
  });

  it('lot3-R1: an empty-plan entry with NO manifest record purges nothing (idempotent)', async () => {
    const adapter = makeAbsentTargetAdapter();

    const result = await remove(
      adapter,
      [{ id: 'skill:never', nature: 'skill', scope: 'user' }],
      'user',
      env,
      manifestPath,
    );

    expect(result.purged).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Leave-alone — conservation preserved (R3 Lot 2 contract)
// ---------------------------------------------------------------------------

describe('engine.remove — lot3 R1 leave-alone conservation (R3 Lot 2)', () => {
  it('lot3-R1: a leave-alone plan preserves the entry and purges nothing', async () => {
    const adapter = makeLeaveAloneAdapter();
    await seedEntry('skill:drifted', 'skill');

    const result = await remove(
      adapter,
      [{ id: 'skill:drifted', nature: 'skill', scope: 'user' }],
      'user',
      env,
      manifestPath,
    );

    expect(result.removed).toHaveLength(0);
    expect(result.purged).toHaveLength(0);

    const manifest = await readManifest(manifestPath);
    expect(manifest.artifacts.find((a) => a.id === 'skill:drifted')).toBeDefined();
  });
});
