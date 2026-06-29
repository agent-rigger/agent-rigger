/**
 * Tests for engine.ts — apply() transactional rollback (atomicity option A).
 *
 * Contract under test:
 * - apply() writes artifacts entry-by-entry and persists the manifest once at the end.
 * - If any step throws mid-run (adapter.apply for entry #k, or the final
 *   writeManifest), apply() rolls back the on-disk state to what it was BEFORE
 *   the call, then re-throws the original error:
 *     - files that existed before  → restored from their .bak-* backup
 *     - files newly created         → deleted
 *     - manifest                    → never left half-written (not persisted)
 * - Rollback captures the ORIGINAL pre-apply state (first-backup-wins per path),
 *   not an intermediate state produced by an earlier entry in the same run.
 *
 * Isolation: fresh tmp HOME per test via makeTmpHome().
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import path from 'node:path';

import type { Adapter, AdapterEntry } from '../src/adapter';
import { apply, rollbackApply } from '../src/engine';
import { readText, writeText } from '../src/fs-json';
import { readManifest } from '../src/manifest';
import { resolveUserTargets } from '../src/paths';
import type { Env } from '../src/paths';
import type { NatureReport, Scope, WriteOp } from '../src/types';
import { makeTmpHome } from './tmp-home';

// ---------------------------------------------------------------------------
// Test adapter — write-text driven, fails on a sentinel content marker
// ---------------------------------------------------------------------------

/** A write-text op carrying this content makes the adapter throw at that op. */
const FAIL_SENTINEL = '__FAIL__';

class RollbackTestError extends Error {
  constructor() {
    super('adapter.apply deliberately failed');
    this.name = 'RollbackTestError';
  }
}

/**
 * Build an adapter whose plan() returns a fixed WriteOp[] per entry id and
 * whose apply() writes each write-text op in order, throwing the instant it
 * encounters an op whose content is FAIL_SENTINEL (without writing that op).
 * This reproduces a partial-write: ops before the sentinel land on disk.
 */
function makeRollbackAdapter(plans: Record<string, WriteOp[]>): Adapter {
  return {
    id: 'claude',

    async audit(entry: AdapterEntry): Promise<NatureReport> {
      return { id: entry.id, nature: entry.nature, state: 'missing', detail: 'test' };
    },

    async plan(entry: AdapterEntry): Promise<WriteOp[]> {
      return plans[entry.id] ?? [];
    },

    async apply(ops: WriteOp[]): Promise<void> {
      for (const op of ops) {
        if (op.kind === 'write-text') {
          if (op.content === FAIL_SENTINEL) {
            throw new RollbackTestError();
          }
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

function entry(id: string, scope: Scope = 'user'): AdapterEntry {
  return { id, nature: 'context', scope };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let manifestPath: string;
let home: string;

beforeEach(async () => {
  tmp = await makeTmpHome('rigger-rollback-');
  env = tmp.env;
  manifestPath = resolveUserTargets(env).stateJson;
  home = tmp.dir;
});

afterEach(async () => {
  await tmp.cleanup();
});

async function exists(p: string): Promise<boolean> {
  return Bun.file(p).exists();
}

// ---------------------------------------------------------------------------
// Newly-created files are deleted on rollback
// ---------------------------------------------------------------------------

describe('rollback: newly-created files', () => {
  it('deletes a file created by an earlier entry when a later entry throws', async () => {
    const fileA = path.join(home, 'a.md');
    const fileB = path.join(home, 'b.md');
    const adapter = makeRollbackAdapter({
      good: [writeTextOp(fileA, 'contentA')],
      bad: [writeTextOp(fileB, FAIL_SENTINEL)],
    });

    await expect(
      apply(adapter, [entry('good'), entry('bad')], 'user', env, manifestPath),
    ).rejects.toBeInstanceOf(RollbackTestError);

    expect(await exists(fileA)).toBe(false); // orphan deleted
    expect(await exists(fileB)).toBe(false); // never written
  });

  it('deletes files partially written WITHIN the failing entry', async () => {
    const fileB = path.join(home, 'b.md');
    const fileC = path.join(home, 'c.md');
    // Single entry: writes fileB, then throws before fileC.
    const adapter = makeRollbackAdapter({
      bad: [writeTextOp(fileB, 'partial'), writeTextOp(fileC, FAIL_SENTINEL)],
    });

    await expect(
      apply(adapter, [entry('bad')], 'user', env, manifestPath),
    ).rejects.toBeInstanceOf(RollbackTestError);

    expect(await exists(fileB)).toBe(false); // partial write cleaned
    expect(await exists(fileC)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pre-existing files are restored to their ORIGINAL content
// ---------------------------------------------------------------------------

describe('rollback: pre-existing files', () => {
  it('restores a pre-existing file to its original content', async () => {
    const fileA = path.join(home, 'a.md');
    await writeText(fileA, 'ORIGINAL');

    const fileB = path.join(home, 'b.md');
    const adapter = makeRollbackAdapter({
      good: [writeTextOp(fileA, 'MODIFIED')],
      bad: [writeTextOp(fileB, FAIL_SENTINEL)],
    });

    await expect(
      apply(adapter, [entry('good'), entry('bad')], 'user', env, manifestPath),
    ).rejects.toBeInstanceOf(RollbackTestError);

    expect(await readText(fileA)).toBe('ORIGINAL'); // restored, not 'MODIFIED'
  });

  it('restores to the ORIGINAL state even when two entries touch the same file', async () => {
    const fileA = path.join(home, 'a.md');
    await writeText(fileA, 'ORIGINAL');

    // e1 modifies fileA, e2 modifies fileA again, e3 throws.
    const adapter = makeRollbackAdapter({
      e1: [writeTextOp(fileA, 'V1')],
      e2: [writeTextOp(fileA, 'V2')],
      e3: [writeTextOp(path.join(home, 'z.md'), FAIL_SENTINEL)],
    });

    await expect(
      apply(adapter, [entry('e1'), entry('e2'), entry('e3')], 'user', env, manifestPath),
    ).rejects.toBeInstanceOf(RollbackTestError);

    // First-backup-wins → restored to ORIGINAL, not V1.
    expect(await readText(fileA)).toBe('ORIGINAL');
  });
});

// ---------------------------------------------------------------------------
// Manifest is never left half-written
// ---------------------------------------------------------------------------

describe('rollback: manifest', () => {
  it('does not persist the manifest when apply throws mid-run', async () => {
    const fileA = path.join(home, 'a.md');
    const fileB = path.join(home, 'b.md');
    const adapter = makeRollbackAdapter({
      good: [writeTextOp(fileA, 'contentA')],
      bad: [writeTextOp(fileB, FAIL_SENTINEL)],
    });

    await expect(
      apply(adapter, [entry('good'), entry('bad')], 'user', env, manifestPath),
    ).rejects.toBeInstanceOf(RollbackTestError);

    const manifest = await readManifest(manifestPath);
    expect(manifest.artifacts).toHaveLength(0); // nothing recorded
  });

  it('rolls back written files when the final writeManifest fails', async () => {
    // Make writeManifest throw: point the manifest under a path whose parent is
    // a regular file (mkdir → ENOTDIR). readManifest still sees it as absent.
    const blocker = path.join(home, 'blocker');
    await writeText(blocker, 'i am a file, not a dir');
    const badManifestPath = path.join(blocker, 'state.json');

    const fileA = path.join(home, 'a.md');
    const adapter = makeRollbackAdapter({
      good: [writeTextOp(fileA, 'contentA')],
    });

    await expect(
      apply(adapter, [entry('good')], 'user', env, badManifestPath),
    ).rejects.toBeTruthy();

    expect(await exists(fileA)).toBe(false); // rolled back despite adapter success
  });
});

// ---------------------------------------------------------------------------
// Original error is preserved (rollback does not mask it)
// ---------------------------------------------------------------------------

describe('rollback: error propagation', () => {
  it('re-throws the original adapter error after rolling back', async () => {
    const fileA = path.join(home, 'a.md');
    await writeText(fileA, 'ORIGINAL');
    const adapter = makeRollbackAdapter({
      good: [writeTextOp(fileA, 'MODIFIED')],
      bad: [writeTextOp(path.join(home, 'b.md'), FAIL_SENTINEL)],
    });

    await expect(
      apply(adapter, [entry('good'), entry('bad')], 'user', env, manifestPath),
    ).rejects.toBeInstanceOf(RollbackTestError);

    // Side effect of rollback also happened.
    expect(await readText(fileA)).toBe('ORIGINAL');
  });
});

// ---------------------------------------------------------------------------
// rollbackApply surfaces per-path failures (does not swallow them silently)
// ---------------------------------------------------------------------------

describe('rollbackApply: failure surfacing', () => {
  it('restores/deletes what it can and returns the paths that failed', async () => {
    const good = path.join(home, 'good.md');
    const orphan = path.join(home, 'orphan.md');
    const broken = path.join(home, 'broken.md');

    // good: a real backup exists → restore succeeds
    const goodBackup = path.join(home, 'good.bak');
    await writeText(goodBackup, 'RESTORED');
    await writeText(good, 'CURRENT');

    // orphan: created during the run (null) → delete succeeds
    await writeText(orphan, 'NEW');

    // broken: backup path points nowhere → restore throws
    const ledger = new Map<string, string | null>([
      [good, goodBackup],
      [orphan, null],
      [broken, path.join(home, 'does-not-exist.bak')],
    ]);

    const failures = await rollbackApply(ledger);

    expect(await readText(good)).toBe('RESTORED'); // succeeded despite the broken sibling
    expect(await exists(orphan)).toBe(false); // succeeded
    expect(failures).toHaveLength(1);
    expect(failures[0]!.path).toBe(broken);
  });
});

// ---------------------------------------------------------------------------
// Happy path is unaffected by the rollback machinery
// ---------------------------------------------------------------------------

describe('rollback: happy path unaffected', () => {
  it('a fully successful apply writes files and persists the manifest', async () => {
    const fileA = path.join(home, 'a.md');
    const fileB = path.join(home, 'b.md');
    const adapter = makeRollbackAdapter({
      e1: [writeTextOp(fileA, 'contentA')],
      e2: [writeTextOp(fileB, 'contentB')],
    });

    const result = await apply(adapter, [entry('e1'), entry('e2')], 'user', env, manifestPath);

    expect(await readText(fileA)).toBe('contentA');
    expect(await readText(fileB)).toBe('contentB');
    expect(result.manifest.artifacts).toHaveLength(2);
    const manifest = await readManifest(manifestPath);
    expect(manifest.artifacts).toHaveLength(2);
  });
});
