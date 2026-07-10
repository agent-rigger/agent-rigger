/**
 * Tests for lot3-robustesse-moteur R7 — inter-process lock + re-read/merge
 * (design D7).
 *
 * Two complementary defenses against the L3 lost-update, both proved here
 * WITHOUT spawning real processes (the concurrency is simulated by manipulating
 * the lockfile directly and by interleaving a competing writeManifest inside an
 * adapter callback — the exact seam a slow external spawn opens):
 *
 *   1. run-lock.ts — acquireRunLock() creates `<manifestPath>.lock` with O_EXCL
 *      ({pid, startedAt}); a second acquisition while the holder's pid is alive
 *      throws the typed ConcurrentRunError; a stale lock (TTL exceeded AND pid
 *      dead) is broken with a warning and the run proceeds. release() unlinks.
 *
 *   2. engine re-read/merge — just before EACH writeManifest, apply()/remove()
 *      re-read state.json and replay THIS run's mutations onto the fresh copy,
 *      so an entry a concurrent run committed in the window survives (last
 *      writer wins per entry, never per file).
 *
 * check() takes NO lock (reads are per-file consistent via atomicWrite).
 *
 * Isolation: fresh tmp HOME per test via makeTmpHome().
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Adapter } from '../src/adapter';
import { apply, check, remove } from '../src/engine';
import { findEntry, readManifest, upsertEntry, writeManifest } from '../src/manifest';
import { resolveUserTargets } from '../src/paths';
import type { Env } from '../src/paths';
import { acquireRunLock, ConcurrentRunError, type RunLock } from '../src/run-lock';
import type { ManifestEntry, NatureReport, RemovalOp, WriteOp } from '../src/types';
import { makeTmpHome } from './tmp-home';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let manifestPath: string;
let lockPath: string;

beforeEach(async () => {
  tmp = await makeTmpHome('rigger-lot3-r7-concurrency-');
  env = tmp.env;
  manifestPath = resolveUserTargets(env).stateJson;
  lockPath = `${manifestPath}.lock`;
  // Ensure the manifest parent dir exists so lockfile creation never races on
  // an absent directory.
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
});

afterEach(async () => {
  await tmp.cleanup();
});

function fullEntry(id: string, nature: ManifestEntry['nature']): ManifestEntry {
  return {
    id,
    nature,
    ref: 'v0.0.0',
    sha: '',
    scope: 'user',
    installedAt: new Date().toISOString(),
    files: [],
  };
}

async function seed(id: string, nature: ManifestEntry['nature']): Promise<void> {
  let m = await readManifest(manifestPath);
  m = upsertEntry(m, fullEntry(id, nature));
  await writeManifest(manifestPath, m);
}

async function exists(p: string): Promise<boolean> {
  return fs.lstat(p).then(() => true).catch(() => false);
}

// ---------------------------------------------------------------------------
// 1. run-lock.ts — acquire / release / ConcurrentRunError / stale break
// ---------------------------------------------------------------------------

describe('run-lock — lot3 R7 acquire/release', () => {
  it('lot3-R7: acquireRunLock creates the lockfile and release removes it', async () => {
    const lock = await acquireRunLock(manifestPath);
    expect(await exists(lockPath)).toBe(true);
    await lock.release();
    expect(await exists(lockPath)).toBe(false);
  });

  it('lot3-R7: a second acquisition while the holder pid is alive throws ConcurrentRunError', async () => {
    const first = await acquireRunLock(manifestPath);
    try {
      let caught: unknown;
      try {
        // pid written by `first` is process.pid (alive), TTL not exceeded → not stale.
        await acquireRunLock(manifestPath);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConcurrentRunError);
      expect((caught as ConcurrentRunError).pid).toBe(process.pid);
    } finally {
      await first.release();
    }
  });

  it('lot3-R7: release is idempotent and never throws', async () => {
    const lock = await acquireRunLock(manifestPath);
    await lock.release();
    await lock.release();
    expect(await exists(lockPath)).toBe(false);
  });
});

describe('run-lock — lot3 R7 stale break', () => {
  it('lot3-R7: a stale lock (TTL exceeded + pid dead) is broken with a warning and the run proceeds', async () => {
    // Simulate a crashed run: a lockfile left behind by a dead process.
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: 999999, startedAt: new Date(0).toISOString() }),
    );

    const warnings: string[] = [];
    const lock = await acquireRunLock(manifestPath, {
      ttlMs: 1000,
      now: () => Date.now() + 60_000, // clock 60s ahead → mtime is past the TTL
      pidAlive: () => false, // the recorded pid is dead
      warn: (m) => warnings.push(m),
    });

    // A warning was surfaced, the lock was re-acquired, and it is now OURS.
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.join('\n').toLowerCase()).toContain('stale');
    const raw = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { pid: number };
    expect(raw.pid).toBe(process.pid);
    await lock.release();
  });

  it('lot3-R7: a fresh lock whose pid is alive is NOT broken even past the TTL', async () => {
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: 12345, startedAt: new Date(0).toISOString() }),
    );

    let caught: unknown;
    try {
      await acquireRunLock(manifestPath, {
        ttlMs: 1000,
        now: () => Date.now() + 60_000, // TTL exceeded ...
        pidAlive: () => true, // ... but the pid is alive → NOT stale
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConcurrentRunError);
    expect((caught as ConcurrentRunError).pid).toBe(12345);
  });

  it('lot3-R7: the stale break is atomic — a fresh lock that replaced the stale one in the break window is preserved, not clobbered', async () => {
    // A crashed run's stale lock is on disk.
    const staleStartedAt = new Date(0).toISOString();
    await fs.writeFile(lockPath, JSON.stringify({ pid: 999999, startedAt: staleStartedAt }));

    // Simulate a concurrent recoverer that fully re-acquires the lock in the
    // read→break window: the pidAlive probe (the only callback invoked AFTER
    // acquireRunLock has read the stale record but BEFORE it renames it aside)
    // overwrites the lockfile with a FRESH, live record. A non-atomic break
    // would blind-unlink this fresh lock and let us wrongly proceed (double
    // hold); the compare-and-swap must instead detect the identity mismatch,
    // restore the fresh lock, and back off with ConcurrentRunError.
    const freshRecord = { pid: 4242, startedAt: new Date().toISOString() };
    let injected = false;
    const pidAlive = (_pid: number): boolean => {
      if (!injected) {
        injected = true;
        writeFileSync(lockPath, JSON.stringify(freshRecord));
      }
      return false; // the ORIGINAL stale pid is dead → judged stale
    };

    let caught: unknown;
    try {
      await acquireRunLock(manifestPath, {
        ttlMs: 1000,
        now: () => Date.now() + 60_000, // the stale record's mtime is past the TTL
        pidAlive,
      });
    } catch (err) {
      caught = err;
    }

    // We backed off rather than double-holding, and the fresh holder survived.
    expect(caught).toBeInstanceOf(ConcurrentRunError);
    expect((caught as ConcurrentRunError).pid).toBe(freshRecord.pid);
    const onDisk = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { pid: number };
    expect(onDisk.pid).toBe(freshRecord.pid);

    // No `.stale-*` break artifact is left behind next to the lockfile.
    const dir = path.dirname(lockPath);
    const base = path.basename(lockPath);
    const leftovers = (await fs.readdir(dir)).filter((f) => f.startsWith(`${base}.stale-`));
    expect(leftovers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. engine.apply — self-acquires, blocks concurrent, honours a passed handle
// ---------------------------------------------------------------------------

/** Minimal adapter: plan yields ONE write-text op so a manifest entry is built. */
function makeWriteTextAdapter(onApply?: () => Promise<void>): Adapter {
  return {
    id: 'claude',
    async audit(entry): Promise<NatureReport> {
      return { id: entry.id, nature: entry.nature, state: 'present' };
    },
    async plan(entry): Promise<WriteOp[]> {
      return [
        {
          kind: 'write-text',
          path: `${tmp.dir}/artifact-${entry.id.replace(/[:/]/g, '-')}.md`,
          content: `# ${entry.id}\n`,
          description: 'write',
          previous: null,
        },
      ];
    },
    async apply(): Promise<void> {
      if (onApply !== undefined) await onApply();
    },
    async planRemove(): Promise<RemovalOp[]> {
      return [];
    },
    async applyRemove(): Promise<void> {},
  };
}

describe('engine.apply — lot3 R7 lock integration', () => {
  it('lot3-R7: apply self-acquires and rejects with ConcurrentRunError when a live lock is held', async () => {
    // A live holder: pid = this process (alive), fresh startedAt.
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    const adapter = makeWriteTextAdapter();
    let caught: unknown;
    try {
      await apply(
        adapter,
        [{ id: 'context:x', nature: 'context', scope: 'user' }],
        'user',
        env,
        manifestPath,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConcurrentRunError);

    await fs.rm(lockPath, { force: true });
  });

  it('lot3-R7: apply releases its self-acquired lock on success', async () => {
    const adapter = makeWriteTextAdapter();
    await apply(
      adapter,
      [{ id: 'context:x', nature: 'context', scope: 'user' }],
      'user',
      env,
      manifestPath,
    );
    expect(await exists(lockPath)).toBe(false);
  });

  it('lot3-R7: apply given a held handle does NOT self-acquire and proceeds under it', async () => {
    const held: RunLock = await acquireRunLock(manifestPath);
    try {
      const adapter = makeWriteTextAdapter();
      // Even though the lockfile exists (held by us), passing the handle skips
      // acquisition — this is the cmd-update single-hold path.
      await apply(
        adapter,
        [{ id: 'context:held', nature: 'context', scope: 'user' }],
        'user',
        env,
        manifestPath,
        undefined,
        held,
      );
      const m = await readManifest(manifestPath);
      expect(findEntry(m, 'context:held', 'user')).toBeDefined();
    } finally {
      await held.release();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. engine re-read/merge — the lost update is closed
// ---------------------------------------------------------------------------

describe('engine re-read/merge — lot3 R7 lost update closed', () => {
  it('lot3-R7: apply merges its upsert onto a concurrent write committed in the spawn window', async () => {
    // Adapter whose (slow, external) apply commits a COMPETING entry A directly
    // to state.json — exactly what a concurrent `install my-plugin` does in the
    // window between run B's initial read and its final write.
    const injectConcurrent = async (): Promise<void> => {
      let m = await readManifest(manifestPath);
      m = upsertEntry(m, fullEntry('plugin:concurrent-A', 'plugin'));
      await writeManifest(manifestPath, m);
    };
    const adapter = makeWriteTextAdapter(injectConcurrent);

    await apply(
      adapter,
      [{ id: 'context:B', nature: 'context', scope: 'user' }],
      'user',
      env,
      manifestPath,
    );

    const m = await readManifest(manifestPath);
    // BOTH survive: the concurrent A (re-read from disk) and B (replayed upsert).
    expect(findEntry(m, 'plugin:concurrent-A', 'user')).toBeDefined();
    expect(findEntry(m, 'context:B', 'user')).toBeDefined();
  });

  it('lot3-R7: remove merges its removal onto a concurrent write, preserving the concurrent entry', async () => {
    await seed('hook:B', 'hook');

    // applyRemove commits a competing entry A in its (slow) window.
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
        return [
          {
            kind: 'remove-hooks',
            path: resolveUserTargets(env).claudeSettings,
            event: 'PreToolUse',
            matcher: '*',
            command: 'bun run guard.ts',
          },
        ];
      },
      async applyRemove(): Promise<void> {
        let m = await readManifest(manifestPath);
        m = upsertEntry(m, fullEntry('skill:concurrent-A', 'skill'));
        await writeManifest(manifestPath, m);
      },
    };

    await remove(
      adapter,
      [{ id: 'hook:B', nature: 'hook', scope: 'user' }],
      'user',
      env,
      manifestPath,
    );

    const m = await readManifest(manifestPath);
    // The concurrent entry survives; the removed entry is gone.
    expect(findEntry(m, 'skill:concurrent-A', 'user')).toBeDefined();
    expect(findEntry(m, 'hook:B', 'user')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. check() takes NO lock
// ---------------------------------------------------------------------------

describe('engine.check — lot3 R7 lock-free reads', () => {
  it('lot3-R7: check does not create a lockfile', async () => {
    await seed('guardrail:g', 'guardrail');
    const adapter = makeWriteTextAdapter();
    await check(
      adapter,
      [{ id: 'guardrail:g', nature: 'guardrail', scope: 'user' }],
      'user',
      env,
      manifestPath,
    );
    expect(await exists(lockPath)).toBe(false);
  });

  it('lot3-R7: check succeeds even while an apply lock is held', async () => {
    await seed('guardrail:g', 'guardrail');
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    const adapter = makeWriteTextAdapter();
    // No throw — check never contends for the lock.
    const report = await check(
      adapter,
      [{ id: 'guardrail:g', nature: 'guardrail', scope: 'user' }],
      'user',
      env,
      manifestPath,
    );
    expect(report.entries.length).toBe(1);
    await fs.rm(lockPath, { force: true });
  });
});
