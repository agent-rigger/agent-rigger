/**
 * doctor-R9 — engine.ts fix: purging the LAST hook manifest entry must
 * trigger the shared scriptStore cleanup (trou A de S1, ADR-0025/R9).
 *
 * Before this fix, `removedNatures` was populated only on the `allRemoved`
 * branch of removeInner (a target actually removed from disk). The PURGE
 * branch (M1a: plannedOps.length === 0, existing manifest entry — the target
 * is ALREADY gone, e.g. a hook hand-edited/removed in settings.json) dropped
 * the manifest entry but never recorded the nature in `removedNatures`, so
 * the shared-store cleanup loop's gate (`removedNatures.has(store.nature)`)
 * never fired for a purge-only run. A scriptStore left behind by a purged
 * LAST hook entry became a permanent orphan — invisible to `check` (manifest
 * no longer references it) and never cleaned by `remove` (nothing left to
 * remove) — exactly the S1 gap doctor exists to close, except doctor would
 * have had to re-detect it on every single run forever instead of the engine
 * fixing its own root cause.
 *
 * No mocks of core logic: a minimal fake adapter drives the real
 * `removeInner` / shared-store cleanup path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Adapter, AdapterEntry } from '../src/adapter';
import { remove } from '../src/engine';
import type { SharedNatureStore } from '../src/engine';
import { readManifest, upsertEntry, writeManifest } from '../src/manifest';
import type { Env } from '../src/paths';
import { resolveUserTargets } from '../src/paths';
import type { NatureReport, RemovalOp, WriteOp } from '../src/types';
import { makeTmpHome } from './tmp-home';

const HOOK_ID = 'guard-hook';

/** Adapter whose planRemove ALWAYS returns [] — mirrors a hook hand-edited/removed. */
function makePurgeOnlyAdapter(): Adapter {
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
      // Empty plan: engine.removeInner's M1a branch (target confirmed absent
      // from disk) — the manifest entry is purged, no disk mutation.
      return [];
    },
    async applyRemove(): Promise<void> {},
  };
}

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let manifestPath: string;
let scriptStoreDir: string;

beforeEach(async () => {
  tmp = await makeTmpHome('rigger-doctor-r9-engine-');
  env = tmp.env;
  manifestPath = resolveUserTargets(env).stateJson;
  scriptStoreDir = path.join(tmp.dir, 'shared-hook-scripts');
  await fs.mkdir(scriptStoreDir, { recursive: true });
  await fs.writeFile(path.join(scriptStoreDir, 'guard.sh'), '#!/bin/sh\necho guard');
});

afterEach(async () => {
  await tmp.cleanup();
});

describe('doctor-R9: purge of the last hook entry triggers scriptStore cleanup', () => {
  it('doctor-R9: purging the sole hook manifest entry removes the shared scriptStore', async () => {
    // Seed the manifest with the SOLE hook entry — its removal via purge
    // leaves zero remaining 'hook' entries, the exact gate the cleanup loop
    // checks (`!manifest.artifacts.some(a => a.nature === store.nature)`).
    let manifest = await readManifest(manifestPath);
    manifest = upsertEntry(manifest, {
      id: HOOK_ID,
      nature: 'hook',
      ref: 'v0.0.0',
      sha: '',
      scope: 'user',
      installedAt: new Date().toISOString(),
      files: [],
    });
    await writeManifest(manifestPath, manifest);

    const adapter = makePurgeOnlyAdapter();
    const entry: AdapterEntry = { id: HOOK_ID, nature: 'hook', scope: 'user' };
    const sharedStores: SharedNatureStore[] = [{ nature: 'hook', dir: scriptStoreDir }];

    const result = await remove(adapter, [entry], 'user', env, manifestPath, sharedStores);

    // The purge convergence still fires (manifest-only, no disk mutation from
    // the adapter itself).
    expect(result.purged).toContain(HOOK_ID);

    // The fix: the scriptStore is gone (backed up first, then removed) — it
    // is no longer an orphan the engine forgot about.
    const storeGone = await fs.lstat(scriptStoreDir).then(() => false).catch(() => true);
    expect(storeGone).toBe(true);
    expect(result.backedUp.some((p) => p.startsWith(`${scriptStoreDir}.bak-`))).toBe(true);
    // The purge itself still emits the standard hook-purge notice ("edited or
    // removed") — the fix only closes the scriptStore cleanup gap, it does
    // not add or remove any other warning.
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('no longer present');
  });

  it('doctor-R9: a purge that leaves OTHER hook entries does NOT touch the scriptStore', async () => {
    // Non-regression: the cleanup gate's second condition (no nature remains)
    // must still hold — purging one of TWO hook entries must not delete a
    // store the surviving entry still needs.
    let manifest = await readManifest(manifestPath);
    manifest = upsertEntry(manifest, {
      id: HOOK_ID,
      nature: 'hook',
      ref: 'v0.0.0',
      sha: '',
      scope: 'user',
      installedAt: new Date().toISOString(),
      files: [],
    });
    manifest = upsertEntry(manifest, {
      id: 'other-hook',
      nature: 'hook',
      ref: 'v0.0.0',
      sha: '',
      scope: 'user',
      installedAt: new Date().toISOString(),
      files: [],
    });
    await writeManifest(manifestPath, manifest);

    const adapter = makePurgeOnlyAdapter();
    const entry: AdapterEntry = { id: HOOK_ID, nature: 'hook', scope: 'user' };
    const sharedStores: SharedNatureStore[] = [{ nature: 'hook', dir: scriptStoreDir }];

    const result = await remove(adapter, [entry], 'user', env, manifestPath, sharedStores);

    expect(result.purged).toContain(HOOK_ID);
    const storeStillThere = await fs.lstat(scriptStoreDir).then(() => true).catch(() => false);
    expect(storeStillThere).toBe(true);
  });
});
