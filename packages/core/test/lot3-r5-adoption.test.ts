/**
 * Tests for lot3-robustesse-moteur R5 — engine.apply adopts an artifact that is
 * already conforming on disk but absent from the manifest (design D5).
 *
 * The empty-plan branch of apply() (adapter.plan → []) used to `continue`
 * unconditionally: an artifact already present on disk yet missing from the
 * manifest stayed inconvergeable (check exit 3 / install no-op forever, the
 * `remove` escape hatch dead since Lot 2). D5 threads an OPTIONAL `adopt`
 * adapter method through that branch: when the manifest has no record AND the
 * adapter returns an AdoptionResult, the engine records a manifest entry
 * (payload + files) with NO disk write beyond state.json.
 *
 * Invariants proved here (adapter-agnostic engine logic — inline fakes):
 *  - empty plan + no record + adopt returns payload → entry recorded, id in
 *    `adopted`, payload persisted to state.json;
 *  - adopt returns undefined (refusal) → nothing recorded;
 *  - an EXISTING record keeps the idempotent no-op — adopt is never consulted;
 *  - an adapter WITHOUT adopt keeps the legacy no-op (fakes never break);
 *  - a NON-empty plan never routes through adoption (normal install path).
 *
 * Isolation: fresh tmp HOME per test via makeTmpHome().
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { Adapter, AdoptionResult } from '../src/adapter';
import { apply } from '../src/engine';
import { findEntry, readManifest, upsertEntry, writeManifest } from '../src/manifest';
import { resolveUserTargets } from '../src/paths';
import type { Env } from '../src/paths';
import type { AppliedPayload, NatureReport, RemovalOp, WriteOp } from '../src/types';
import { makeTmpHome } from './tmp-home';

// ---------------------------------------------------------------------------
// Inline adapters
// ---------------------------------------------------------------------------

/**
 * Adapter whose plan is ALWAYS empty (artifact conforming on disk) and whose
 * adopt returns the supplied AdoptionResult (or undefined to refuse).
 */
function makeAdoptingAdapter(adoption: AdoptionResult | undefined): Adapter & {
  adoptCalls: number;
} {
  const state = { adoptCalls: 0 };
  const adapter: Adapter = {
    id: 'claude',
    async audit(entry): Promise<NatureReport> {
      return { id: entry.id, nature: entry.nature, state: 'present' };
    },
    async plan(): Promise<WriteOp[]> {
      return [];
    },
    async apply(): Promise<void> {},
    async planRemove(): Promise<RemovalOp[]> {
      return [];
    },
    async applyRemove(): Promise<void> {},
    async adopt(): Promise<AdoptionResult | undefined> {
      state.adoptCalls += 1;
      return adoption;
    },
  };
  return Object.assign(adapter, {
    get adoptCalls(): number {
      return state.adoptCalls;
    },
  });
}

/** Adapter with an empty plan and NO adopt method (legacy fake). */
function makeNoAdoptAdapter(): Adapter {
  return {
    id: 'claude',
    async audit(entry): Promise<NatureReport> {
      return { id: entry.id, nature: entry.nature, state: 'present' };
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let manifestPath: string;

beforeEach(async () => {
  tmp = await makeTmpHome('rigger-lot3-r5-adoption-');
  env = tmp.env;
  manifestPath = resolveUserTargets(env).stateJson;
});

afterEach(async () => {
  await tmp.cleanup();
});

const GUARDRAIL_APPLIED: AppliedPayload = {
  kind: 'guardrail',
  denyRules: ['Read(./.env)', 'Read(~/.ssh/**)'],
  allowRules: [],
};

// ---------------------------------------------------------------------------
// Adoption — empty plan, no manifest record
// ---------------------------------------------------------------------------

describe('engine.apply — lot3 R5 adoption', () => {
  it('lot3-R5: an empty-plan entry absent from the manifest is adopted (entry + payload + files)', async () => {
    const adapter = makeAdoptingAdapter({
      applied: GUARDRAIL_APPLIED,
      files: ['/home/user/.claude/settings.json'],
    });

    const result = await apply(
      adapter,
      [{ id: 'guardrails-claude', nature: 'guardrail', scope: 'user' }],
      'user',
      env,
      manifestPath,
    );

    expect(result.adopted).toContain('guardrails-claude');
    expect(result.written).toHaveLength(0);

    const entry = findEntry(result.manifest, 'guardrails-claude', 'user', 'claude');
    expect(entry).toBeDefined();
    expect(entry?.applied).toEqual(GUARDRAIL_APPLIED);
    expect(entry?.files).toEqual(['/home/user/.claude/settings.json']);
  });

  it('lot3-R5: the adopted entry is persisted to state.json', async () => {
    const adapter = makeAdoptingAdapter({
      applied: GUARDRAIL_APPLIED,
      files: ['/x/settings.json'],
    });

    await apply(
      adapter,
      [{ id: 'guardrails-claude', nature: 'guardrail', scope: 'user' }],
      'user',
      env,
      manifestPath,
    );

    const persisted = await readManifest(manifestPath);
    const entry = findEntry(persisted, 'guardrails-claude', 'user', 'claude');
    expect(entry?.applied).toEqual(GUARDRAIL_APPLIED);
  });

  it('lot3-R5: adopt returning undefined records nothing', async () => {
    const adapter = makeAdoptingAdapter(undefined);

    const result = await apply(
      adapter,
      [{ id: 'skill:x', nature: 'skill', scope: 'user' }],
      'user',
      env,
      manifestPath,
    );

    expect(result.adopted).toHaveLength(0);
    expect(findEntry(result.manifest, 'skill:x', 'user', 'claude')).toBeUndefined();

    const persisted = await readManifest(manifestPath);
    expect(persisted.artifacts).toHaveLength(0);
  });

  it('lot3-R5: an adopted payload-less nature records files with no applied field', async () => {
    const adapter = makeAdoptingAdapter({ files: [] });

    const result = await apply(
      adapter,
      [{ id: 'plugin:foo', nature: 'plugin', scope: 'user' }],
      'user',
      env,
      manifestPath,
    );

    expect(result.adopted).toContain('plugin:foo');
    const entry = findEntry(result.manifest, 'plugin:foo', 'user', 'claude');
    expect(entry).toBeDefined();
    expect(entry?.applied).toBeUndefined();
    expect(entry?.files).toEqual([]);
  });

  it('lot3-R5: an EXISTING manifest record keeps the idempotent no-op — adopt is never called', async () => {
    const adapter = makeAdoptingAdapter({ applied: GUARDRAIL_APPLIED, files: ['/x'] });

    // Seed a pre-existing record for the same identity.
    let manifest = await readManifest(manifestPath);
    manifest = upsertEntry(manifest, {
      id: 'guardrails-claude',
      nature: 'guardrail',
      ref: 'v1.2.3',
      sha: 'deadbeef',
      scope: 'user',
      installedAt: '2020-01-01T00:00:00.000Z',
      files: ['/existing'],
      assistant: 'claude',
    });
    await writeManifest(manifestPath, manifest);

    const result = await apply(
      adapter,
      [{ id: 'guardrails-claude', nature: 'guardrail', scope: 'user' }],
      'user',
      env,
      manifestPath,
    );

    expect(adapter.adoptCalls).toBe(0);
    expect(result.adopted).toHaveLength(0);
    // The pre-existing record is untouched (idempotence intact).
    const entry = findEntry(result.manifest, 'guardrails-claude', 'user', 'claude');
    expect(entry?.ref).toBe('v1.2.3');
    expect(entry?.files).toEqual(['/existing']);
  });

  it('lot3-R5: an adapter WITHOUT adopt keeps the legacy empty-plan no-op', async () => {
    const adapter = makeNoAdoptAdapter();

    const result = await apply(
      adapter,
      [{ id: 'skill:x', nature: 'skill', scope: 'user' }],
      'user',
      env,
      manifestPath,
    );

    expect(result.adopted).toHaveLength(0);
    expect(result.manifest.artifacts).toHaveLength(0);
  });

  it('lot3-R5: adoption honours the versionFor seam for ref/sha', async () => {
    const adapter = makeAdoptingAdapter({ applied: GUARDRAIL_APPLIED, files: ['/x'] });

    const result = await apply(
      adapter,
      [{ id: 'guardrails-claude', nature: 'guardrail', scope: 'user' }],
      'user',
      env,
      manifestPath,
      () => ({ ref: 'v9.9.9', sha: 'cafebabe' }),
    );

    const entry = findEntry(result.manifest, 'guardrails-claude', 'user', 'claude');
    expect(entry?.ref).toBe('v9.9.9');
    expect(entry?.sha).toBe('cafebabe');
  });
});
