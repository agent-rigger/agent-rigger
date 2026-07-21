/**
 * Tests for engine.ts — lib materialisation channel (R3, lib-nature).
 *
 * Contract under test (design.md §1, "canal parallèle"):
 * - apply({ libs }) materialises each lib into `libsDir(env)/<name>` on a channel
 *   PARALLEL to the adapter loop: the lib is NEVER an AdapterEntry, so
 *   adapter.plan/audit/planRemove never see it (S3 — no UnsupportedNatureError,
 *   no `[skipped]` line by partition).
 * - The lib's manifest entry is the global singleton (id, 'user', 'shared') (S2):
 *   scope constant 'user' regardless of the transaction scope, assistant the
 *   explicit sentinel 'shared' (never coerced to 'claude'), files = [dest],
 *   requires copied verbatim (opaque — empty for a real lib).
 * - Idempotence: identical content on disk → no re-sync (no backup); divergent
 *   content → backupDir BEFORE a destructive re-sync (ratified point 3).
 * - Rollback orphan-safe: a fresh lib materialised then followed by a failing
 *   adapter entry is removed by the shared layer-B rollback, and state.json is
 *   never persisted (ADR-0027 Tier-1).
 *
 * Isolation: fresh tmp HOME per test via makeTmpHome().
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Adapter, AdapterEntry } from '../src/adapter';
import { apply } from '../src/engine';
import { readText, writeText } from '../src/fs-json';
import { readManifest } from '../src/manifest';
import { libsDir, resolveUserTargets } from '../src/paths';
import type { Env } from '../src/paths';
import type { Assistant, LibMaterialization, NatureReport, Scope, WriteOp } from '../src/types';
import { makeTmpHome } from './tmp-home';

// ---------------------------------------------------------------------------
// Test adapter — records the entries it is asked to plan, throws if a lib ever
// leaks into the adapter loop (S3 guard), and can fail on a sentinel op.
// ---------------------------------------------------------------------------

const FAIL_SENTINEL = '__FAIL__';

class ConsumerFailError extends Error {
  constructor() {
    super('adapter.apply deliberately failed on the consumer');
    this.name = 'ConsumerFailError';
  }
}

interface RecordingAdapter extends Adapter {
  planned: string[];
}

/**
 * An adapter whose plan()/apply() write a single write-text op per entry. It
 * records every entry id it plans and THROWS if it is ever handed a lib-nature
 * entry — the engine-level proof that libs travel a channel the adapter never
 * touches (R3, "la lib n'atteint jamais un adapter").
 */
function makeRecordingAdapter(id: Assistant, plans: Record<string, WriteOp[]>): RecordingAdapter {
  const planned: string[] = [];
  return {
    id,
    planned,
    async audit(entry: AdapterEntry): Promise<NatureReport> {
      return { id: entry.id, nature: entry.nature, state: 'missing', detail: 'test' };
    },
    async plan(entry: AdapterEntry): Promise<WriteOp[]> {
      if (entry.nature === 'lib') {
        throw new Error(`lib leaked into the adapter loop: ${entry.id}`);
      }
      planned.push(entry.id);
      return plans[entry.id] ?? [];
    },
    async apply(ops: WriteOp[]): Promise<void> {
      for (const op of ops) {
        if (op.kind === 'write-text') {
          if (op.content === FAIL_SENTINEL) throw new ConsumerFailError();
          await writeText(op.path, op.content);
        }
      }
    },
    async planRemove() {
      return [];
    },
    async applyRemove(): Promise<void> {},
  };
}

function writeTextOp(filePath: string, content: string): WriteOp {
  return { kind: 'write-text', path: filePath, content, description: 'test write' };
}

function consumer(id: string, scope: Scope = 'user'): AdapterEntry {
  return { id, nature: 'context', scope };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let manifestPath: string;
let home: string;

/**
 * Create a checkout-side lib source dir with the given files, return its path.
 * Mirrors a `common/libs/<name>/` surface: a directory of plain source files.
 */
async function makeLibSource(name: string, files: Record<string, string>): Promise<string> {
  const src = path.join(home, 'checkout', 'common', 'libs', name);
  await fs.mkdir(src, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(src, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await writeText(dest, content);
  }
  return src;
}

function libDest(name: string): string {
  return path.join(libsDir(env), name);
}

async function exists(p: string): Promise<boolean> {
  // fs.stat (not Bun.file().exists(), which returns false for directories).
  return fs.stat(p).then(() => true).catch(() => false);
}

beforeEach(async () => {
  tmp = await makeTmpHome('rigger-lib-mat-');
  env = tmp.env;
  manifestPath = resolveUserTargets(env).stateJson;
  home = tmp.dir;
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// R3 — la lib n'atteint jamais un adapter (S3)
// ---------------------------------------------------------------------------

describe('R3 jamais-adapter — lib travels the parallel channel', () => {
  it('materialises the lib without the adapter ever planning it', async () => {
    const source = await makeLibSource('rules-common', { 'index.ts': 'export const x = 1;\n' });
    const consumerFile = path.join(home, 'consumer.md');
    const adapter = makeRecordingAdapter('claude', {
      'jr/hook:guard': [writeTextOp(consumerFile, 'consumer body')],
    });

    const lib: LibMaterialization = {
      id: 'jr/lib:rules-common',
      name: 'rules-common',
      source,
      requires: [],
    };

    const result = await apply({
      adapter,
      entries: [consumer('jr/hook:guard')],
      scope: 'user',
      env,
      manifestPath,
      libs: [lib],
    });

    // The adapter only ever saw the consumer — the lib never leaked into its loop.
    expect(adapter.planned).toEqual(['jr/hook:guard']);

    // The lib is on disk under libsDir, byte-identical to the source.
    expect(await exists(libDest('rules-common'))).toBe(true);
    expect(await readText(path.join(libDest('rules-common'), 'index.ts'))).toBe(
      'export const x = 1;\n',
    );

    // Its manifest entry is the global singleton (id, 'user', 'shared').
    const manifest = await readManifest(manifestPath);
    const libEntry = manifest.artifacts.find((a) => a.id === 'jr/lib:rules-common');
    expect(libEntry).toBeDefined();
    expect(libEntry!.nature).toBe('lib');
    expect(libEntry!.scope).toBe('user');
    expect(libEntry!.assistant).toBe('shared');
    expect(libEntry!.files).toEqual([libDest('rules-common')]);
    expect(libEntry!.requires).toEqual([]);

    // The consumer is recorded too (result.manifest reflects persisted truth).
    expect(result.manifest.artifacts.some((a) => a.id === 'jr/hook:guard')).toBe(true);
  });

  it("stamps 'user' scope even when the transaction scope is 'project'", async () => {
    const source = await makeLibSource('rules-common', { 'index.ts': 'x' });
    const consumerFile = path.join(home, 'consumer.md');
    const adapter = makeRecordingAdapter('claude', {
      'jr/hook:guard': [writeTextOp(consumerFile, 'body')],
    });

    await apply({
      adapter,
      entries: [consumer('jr/hook:guard', 'project')],
      scope: 'project',
      env,
      manifestPath,
      libs: [{ id: 'jr/lib:rules-common', name: 'rules-common', source, requires: [] }],
    });

    const manifest = await readManifest(manifestPath);
    const libEntry = manifest.artifacts.find((a) => a.id === 'jr/lib:rules-common');
    // The lib store is a single global (user-level) singleton regardless of the
    // project-scoped consumer that pulled it (S2 / design.md §2).
    expect(libEntry!.scope).toBe('user');
    expect(libEntry!.assistant).toBe('shared');
  });

  it('stamps the lib entry with versionFor ref/sha (not the v0.0.0 default)', async () => {
    const source = await makeLibSource('rules-common', { 'index.ts': 'x' });
    const adapter = makeRecordingAdapter('claude', {});

    await apply({
      adapter,
      entries: [],
      scope: 'user',
      env,
      manifestPath,
      // A lib is remote content — the engine threads versionFor to it exactly
      // like a consumer, so its manifest entry carries the real catalogue
      // ref/sha (else a permanent doctor missing-sha finding).
      versionFor: () => ({ ref: 'v2.5.0', sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }),
      libs: [{ id: 'jr/lib:rules-common', name: 'rules-common', source, requires: [] }],
    });

    const manifest = await readManifest(manifestPath);
    const libEntry = manifest.artifacts.find((a) => a.id === 'jr/lib:rules-common');
    expect(libEntry!.ref).toBe('v2.5.0');
    expect(libEntry!.sha).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  });

  it('copies requires verbatim (opaque transport)', async () => {
    const source = await makeLibSource('rules-common', { 'index.ts': 'x' });
    const adapter = makeRecordingAdapter('claude', {});

    await apply({
      adapter,
      entries: [],
      scope: 'user',
      env,
      manifestPath,
      libs: [{
        id: 'jr/lib:rules-common',
        name: 'rules-common',
        source,
        requires: ['other/lib:base'],
      }],
    });

    const manifest = await readManifest(manifestPath);
    const libEntry = manifest.artifacts.find((a) => a.id === 'jr/lib:rules-common');
    // Whatever the CLI captured is carried through untouched — the engine never
    // interprets an edge (a real lib passes []).
    expect(libEntry!.requires).toEqual(['other/lib:base']);
  });
});

// ---------------------------------------------------------------------------
// R3 — entrée manifest unique et globale (cross-assistant)
// ---------------------------------------------------------------------------

describe('R3 entrée-unique-globale — one entry across two assistant transactions', () => {
  it('a 2nd (opencode) transaction neither duplicates nor re-materialises the lib', async () => {
    const source = await makeLibSource('rules-common', { 'index.ts': 'shared bytes\n' });

    const claudeAdapter = makeRecordingAdapter('claude', {
      'jr/hook:guard': [writeTextOp(path.join(home, 'claude-consumer.md'), 'c')],
    });
    const lib: LibMaterialization = {
      id: 'jr/lib:rules-common',
      name: 'rules-common',
      source,
      requires: [],
    };

    // Transaction 1 (claude) — fresh materialisation.
    const r1 = await apply({
      adapter: claudeAdapter,
      entries: [consumer('jr/hook:guard')],
      scope: 'user',
      env,
      manifestPath,
      libs: [lib],
    });
    expect(r1.backedUp).toEqual([]); // fresh dir → no backup

    // Transaction 2 (opencode) — same lib already on disk, identical content.
    const opencodeAdapter = makeRecordingAdapter('opencode', {
      'jr/plugin:guard': [writeTextOp(path.join(home, 'opencode-consumer.md'), 'o')],
    });
    const r2 = await apply({
      adapter: opencodeAdapter,
      entries: [consumer('jr/plugin:guard')],
      scope: 'user',
      env,
      manifestPath,
      libs: [lib],
    });

    // No re-materialisation: identical content → no destructive re-sync, no backup.
    expect(r2.backedUp).toEqual([]);

    const manifest = await readManifest(manifestPath);
    // Exactly ONE lib entry, all transactions confounded (global singleton).
    const libEntries = manifest.artifacts.filter((a) => a.id === 'jr/lib:rules-common');
    expect(libEntries).toHaveLength(1);
    expect(libEntries[0]!.assistant).toBe('shared');
    // Both consumers recorded under their own assistant.
    expect(manifest.artifacts.filter((a) => a.id === 'jr/hook:guard')).toHaveLength(1);
    expect(manifest.artifacts.filter((a) => a.id === 'jr/plugin:guard')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// R3 — ré-install idempotente (identique → no-op ; divergent → backup + re-sync)
// ---------------------------------------------------------------------------

describe('R3 idempotence — identical no-op vs divergent backup+resync', () => {
  it('identical content on a re-install is a no-op (no backup, content unchanged)', async () => {
    const source = await makeLibSource('rules-common', { 'index.ts': 'v1\n' });
    const adapter = makeRecordingAdapter('claude', {});
    const lib: LibMaterialization = {
      id: 'jr/lib:rules-common',
      name: 'rules-common',
      source,
      requires: [],
    };

    await apply({ adapter, entries: [], scope: 'user', env, manifestPath, libs: [lib] });
    const r2 = await apply({ adapter, entries: [], scope: 'user', env, manifestPath, libs: [lib] });

    expect(r2.backedUp).toEqual([]); // identical → no backup, no re-sync
    expect(await readText(path.join(libDest('rules-common'), 'index.ts'))).toBe('v1\n');
  });

  it('divergent content backs the store up BEFORE a destructive re-sync', async () => {
    const source = await makeLibSource('rules-common', { 'index.ts': 'v1\n' });
    const adapter = makeRecordingAdapter('claude', {});
    const lib: LibMaterialization = {
      id: 'jr/lib:rules-common',
      name: 'rules-common',
      source,
      requires: [],
    };

    // First install → v1 on disk.
    await apply({ adapter, entries: [], scope: 'user', env, manifestPath, libs: [lib] });

    // Catalog content changes to v2 (same source path, new bytes).
    await writeText(path.join(source, 'index.ts'), 'v2\n');

    const r2 = await apply({ adapter, entries: [], scope: 'user', env, manifestPath, libs: [lib] });

    // A store backup was taken (ratified point 3) …
    expect(r2.backedUp).toHaveLength(1);
    expect(r2.backedUp[0]).toContain('.bak-');
    // … and the store now holds the new bytes.
    expect(await readText(path.join(libDest('rules-common'), 'index.ts'))).toBe('v2\n');
  });
});

// ---------------------------------------------------------------------------
// R3 — rollback orphan-safe (fresh lib removed, state.json never persisted)
// ---------------------------------------------------------------------------

describe('R3 rollback-orphan-safe — a failing entry after a fresh lib', () => {
  it('removes the fresh lib dir and never persists state.json', async () => {
    const source = await makeLibSource('rules-common', { 'index.ts': 'x' });
    const adapter = makeRecordingAdapter('claude', {
      'jr/hook:guard': [writeTextOp(path.join(home, 'boom.md'), FAIL_SENTINEL)],
    });

    await expect(
      apply({
        adapter,
        entries: [consumer('jr/hook:guard')],
        scope: 'user',
        env,
        manifestPath,
        libs: [{ id: 'jr/lib:rules-common', name: 'rules-common', source, requires: [] }],
      }),
    ).rejects.toBeInstanceOf(ConsumerFailError);

    // The freshly-materialised lib dir was rolled back (layer B).
    expect(await exists(libDest('rules-common'))).toBe(false);
    // state.json was never persisted — no lib entry, no consumer entry.
    const manifest = await readManifest(manifestPath);
    expect(manifest.artifacts).toHaveLength(0);
  });
});
