/**
 * Tests for engine.ts — remove().
 *
 * Uses an inline minimal adapter that implements planRemove / applyRemove.
 * No mocks of implementation — exercises real core logic.
 *
 * Isolation: fresh tmp HOME per test via makeTmpHome().
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Adapter, AdapterEntry } from '../src/adapter';
import { remove } from '../src/engine';
import { writeJson } from '../src/fs-json';
import { readManifest, upsertEntry } from '../src/manifest';
import { resolveUserTargets } from '../src/paths';
import type { Env } from '../src/paths';
import type { NatureReport, RemovalOp, Scope, WriteOp } from '../src/types';
import { makeTmpHome } from './tmp-home';

// ---------------------------------------------------------------------------
// Minimal adapter that removes a deny rule from settings.json
// ---------------------------------------------------------------------------

const ENTRY_ID = 'guardrails-claude';
const ENTRY_NATURE = 'guardrail' as const;
const REF_DENY = ['Read(~/.ssh/**)', 'Write(~/.aws/**)'];

function makeDenyRemoveAdapter(refDeny: string[] = REF_DENY): Adapter {
  return {
    id: 'claude',

    async audit(entry, _scope, _env): Promise<NatureReport> {
      return { id: entry.id, nature: entry.nature, state: 'present' };
    },

    async plan(): Promise<WriteOp[]> {
      return [];
    },

    async apply(): Promise<void> {},

    async planRemove(_entry, _scope, env): Promise<RemovalOp[]> {
      const targets = resolveUserTargets(env);
      return [{ kind: 'remove-deny', path: targets.claudeSettings, rules: refDeny }];
    },

    async applyRemove(ops, _env): Promise<void> {
      await Promise.all(
        ops.map(async (op) => {
          if (op.kind === 'remove-deny') {
            const raw = await (async () => {
              const { readJson } = await import('../src/fs-json');
              return readJson(op.path);
            })();
            const permissions = (raw['permissions'] as Record<string, unknown> | undefined) ?? {};
            const currentDeny: string[] = Array.isArray(permissions['deny'])
              ? (permissions['deny'] as string[])
              : [];
            const { removeDeny } = await import('../src/deny');
            const updated = removeDeny(currentDeny, op.rules);
            const { writeJson } = await import('../src/fs-json');
            await writeJson(op.path, {
              ...raw,
              permissions: { ...permissions, deny: updated },
            });
          }
        }),
      );
    },
  };
}

/** Adapter whose planRemove always returns [] (simulates: not installed). */
function makeNoOpRemoveAdapter(): Adapter {
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

function makeCatalogEntry(id: string, scope: Scope = 'user'): AdapterEntry {
  return { id, nature: ENTRY_NATURE, scope };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let targets: ReturnType<typeof resolveUserTargets>;
let manifestPath: string;

beforeEach(async () => {
  tmp = await makeTmpHome('rigger-engine-remove-');
  env = tmp.env;
  targets = resolveUserTargets(env);
  manifestPath = targets.stateJson;
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// remove() — basic removal
// ---------------------------------------------------------------------------

describe('engine.remove: basic removal', () => {
  it('returns RemoveResult with removed ids and empty backedUp when no file pre-exists', async () => {
    const adapter = makeDenyRemoveAdapter();
    const entries = [makeCatalogEntry(ENTRY_ID)];

    // Pre-seed manifest with an installed entry
    let manifest = await readManifest(manifestPath);
    manifest = upsertEntry(manifest, {
      id: ENTRY_ID,
      nature: ENTRY_NATURE,
      source: 'internal',
      ref: 'v0.0.0',
      sha: '',
      scope: 'user',
      installedAt: new Date().toISOString(),
      files: [targets.claudeSettings],
    });
    const { writeManifest } = await import('../src/manifest');
    await writeManifest(manifestPath, manifest);

    const result = await remove(adapter, entries, 'user', env, manifestPath);

    expect(result.removed).toContain(ENTRY_ID);
    expect(Array.isArray(result.backedUp)).toBe(true);
    expect(result.manifest).toBeDefined();
  });

  it('removes the entry from the manifest after remove()', async () => {
    const adapter = makeDenyRemoveAdapter();
    const entries = [makeCatalogEntry(ENTRY_ID)];

    // Pre-seed manifest
    let manifest = await readManifest(manifestPath);
    manifest = upsertEntry(manifest, {
      id: ENTRY_ID,
      nature: ENTRY_NATURE,
      source: 'internal',
      ref: 'v0.0.0',
      sha: '',
      scope: 'user',
      installedAt: new Date().toISOString(),
      files: [],
    });
    const { writeManifest } = await import('../src/manifest');
    await writeManifest(manifestPath, manifest);

    await remove(adapter, entries, 'user', env, manifestPath);

    const afterManifest = await readManifest(manifestPath);
    const found = afterManifest.artifacts.find((e) => e.id === ENTRY_ID && e.scope === 'user');
    expect(found).toBeUndefined();
  });

  it('backs up the target file when it exists before removal', async () => {
    const adapter = makeDenyRemoveAdapter();
    const entries = [makeCatalogEntry(ENTRY_ID)];

    // Create settings.json so backup fires
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      permissions: { deny: REF_DENY },
    });

    // Pre-seed manifest
    let manifest = await readManifest(manifestPath);
    manifest = upsertEntry(manifest, {
      id: ENTRY_ID,
      nature: ENTRY_NATURE,
      source: 'internal',
      ref: 'v0.0.0',
      sha: '',
      scope: 'user',
      installedAt: new Date().toISOString(),
      files: [targets.claudeSettings],
    });
    const { writeManifest } = await import('../src/manifest');
    await writeManifest(manifestPath, manifest);

    const result = await remove(adapter, entries, 'user', env, manifestPath);

    expect(result.backedUp.length).toBeGreaterThan(0);
    // Backup file should exist
    const bakExists = await fs.lstat(result.backedUp[0]!).then(() => true).catch(() => false);
    expect(bakExists).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// remove() — idempotence (not installed → no-op)
// ---------------------------------------------------------------------------

describe('engine.remove: idempotence when not installed', () => {
  it('is a no-op when planRemove returns empty array', async () => {
    const adapter = makeNoOpRemoveAdapter();
    const entries = [makeCatalogEntry(ENTRY_ID)];

    const manifestBefore = await readManifest(manifestPath);

    const result = await remove(adapter, entries, 'user', env, manifestPath);

    const manifestAfter = await readManifest(manifestPath);

    expect(result.removed).toHaveLength(0);
    expect(result.backedUp).toHaveLength(0);
    expect(manifestAfter.artifacts).toHaveLength(manifestBefore.artifacts.length);
  });

  it('does not alter the manifest when planRemove is empty', async () => {
    const adapter = makeNoOpRemoveAdapter();
    const entries = [makeCatalogEntry(ENTRY_ID)];

    // Pre-seed manifest with an unrelated entry
    let manifest = await readManifest(manifestPath);
    manifest = upsertEntry(manifest, {
      id: 'other-entry',
      nature: 'context' as const,
      source: 'internal',
      ref: 'v0.0.0',
      sha: '',
      scope: 'user',
      installedAt: new Date().toISOString(),
      files: [],
    });
    const { writeManifest } = await import('../src/manifest');
    await writeManifest(manifestPath, manifest);

    await remove(adapter, entries, 'user', env, manifestPath);

    const manifestAfter = await readManifest(manifestPath);
    // The unrelated entry must still be present
    expect(manifestAfter.artifacts.find((e) => e.id === 'other-entry')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// remove() — RemoveResult shape
// ---------------------------------------------------------------------------

describe('engine.remove: RemoveResult shape', () => {
  it('returns an object with removed, backedUp, and manifest fields', async () => {
    const adapter = makeNoOpRemoveAdapter();
    const entries = [makeCatalogEntry(ENTRY_ID)];

    const result = await remove(adapter, entries, 'user', env, manifestPath);

    expect(result).toHaveProperty('removed');
    expect(result).toHaveProperty('backedUp');
    expect(result).toHaveProperty('manifest');
    expect(Array.isArray(result.removed)).toBe(true);
    expect(Array.isArray(result.backedUp)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// remove() — multiple entries
// ---------------------------------------------------------------------------

describe('engine.remove: multiple entries', () => {
  it('removes multiple entries and reports all ids', async () => {
    const id1 = 'entry-one';
    const id2 = 'entry-two';

    const adapter: Adapter = {
      id: 'claude',
      async audit(entry): Promise<NatureReport> {
        return { id: entry.id, nature: entry.nature, state: 'present' };
      },
      async plan(): Promise<WriteOp[]> {
        return [];
      },
      async apply(): Promise<void> {},
      async planRemove(entry, _scope, _env): Promise<RemovalOp[]> {
        // Return a plugin-uninstall op (no file path) to avoid filesystem side effects
        return [{ kind: 'plugin-uninstall', plugin: entry.id }];
      },
      async applyRemove(): Promise<void> {},
    };

    // Pre-seed manifest with both entries
    let manifest = await readManifest(manifestPath);
    for (const id of [id1, id2]) {
      manifest = upsertEntry(manifest, {
        id,
        nature: ENTRY_NATURE,
        source: 'internal',
        ref: 'v0.0.0',
        sha: '',
        scope: 'user',
        installedAt: new Date().toISOString(),
        files: [],
      });
    }
    const { writeManifest } = await import('../src/manifest');
    await writeManifest(manifestPath, manifest);

    const result = await remove(
      adapter,
      [makeCatalogEntry(id1), makeCatalogEntry(id2)],
      'user',
      env,
      manifestPath,
    );

    expect(result.removed).toContain(id1);
    expect(result.removed).toContain(id2);

    const afterManifest = await readManifest(manifestPath);
    expect(afterManifest.artifacts.find((e) => e.id === id1)).toBeUndefined();
    expect(afterManifest.artifacts.find((e) => e.id === id2)).toBeUndefined();
  });
});
