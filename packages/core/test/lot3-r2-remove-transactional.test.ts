/**
 * Tests for lot3-robustesse-moteur R2 — engine.remove is transactional (design D2).
 *
 * Three guarantees, all on the FAILURE path (the nominal remove is unchanged):
 *
 *   1. Per-entry persistence — writeManifest fires atomically after EACH
 *      successful entry, so a failure on entry N leaves state.json faithful to
 *      the 1..N-1 removals already carried out (SIGKILL-safe: the tiny state.json
 *      is written tmp+rename). Previously a single writeManifest ran after the
 *      loop, so a mid-loop throw left 1..N-1 destroyed on disk but STILL recorded
 *      (each falling back into the M1a phantom case).
 *
 *   2. Rich error — a try/catch around the loop attaches { removed, purged,
 *      backedUp } partials to the thrown error (mirror of apply()'s
 *      err.rollbackFailures) then rethrows, so the .bak paths are never swallowed
 *      by the throw.
 *
 *   3. Best-effort shared-store cleanup — a post-persist removeDir failure
 *      (EACCES/ENOTDIR) becomes a warning in the result, NEVER a throw: a run
 *      whose manifest is already coherent must not report itself as failed.
 *
 * Uses inline minimal adapters — the transaction is adapter-agnostic engine
 * logic. Isolation: fresh tmp HOME per test via makeTmpHome().
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Adapter } from '../src/adapter';
import { remove } from '../src/engine';
import type { RemovePartial } from '../src/engine';
import { readManifest, upsertEntry, writeManifest } from '../src/manifest';
import { resolveUserTargets } from '../src/paths';
import type { Env } from '../src/paths';
import type { Manifest, Nature, NatureReport, RemovalOp, Scope, WriteOp } from '../src/types';
import { makeTmpHome } from './tmp-home';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let manifestPath: string;

beforeEach(async () => {
  tmp = await makeTmpHome('rigger-lot3-r2-remove-');
  env = tmp.env;
  manifestPath = resolveUserTargets(env).stateJson;
});

afterEach(async () => {
  await tmp.cleanup();
});

async function seedEntry(
  id: string,
  nature: Nature,
  files: string[] = [],
  scope: Scope = 'user',
): Promise<void> {
  let manifest = await readManifest(manifestPath);
  manifest = upsertEntry(manifest, {
    id,
    nature,
    ref: 'v0.0.0',
    sha: '',
    scope,
    installedAt: new Date().toISOString(),
    files,
  });
  await writeManifest(manifestPath, manifest);
}

function catalogEntry(id: string, nature: Nature, scope: Scope = 'user') {
  return { id, nature, scope };
}

// ---------------------------------------------------------------------------
// Adapter: removes skill:a (unlink, succeeds), then throws on hook:b
// ---------------------------------------------------------------------------

interface FailSecondOptions {
  /** Symlink target removed for skill:a. */
  symlink: string;
  /** Store dir backed up (backupDir) for skill:a. */
  store: string;
  /** settings.json path carried by the hook:b remove-hooks op. */
  settings: string;
  /** Captures the on-disk manifest observed at the moment hook:b is applied. */
  onApplyHookB?: ((m: Manifest) => void) | undefined;
}

function makeFailSecondAdapter(opts: FailSecondOptions): Adapter {
  return {
    id: 'claude',
    async audit(entry): Promise<NatureReport> {
      return { id: entry.id, nature: entry.nature, state: 'present' };
    },
    async plan(): Promise<WriteOp[]> {
      return [];
    },
    async apply(): Promise<void> {},
    async planRemove(entry): Promise<RemovalOp[]> {
      if (entry.id === 'skill:a') {
        return [{ kind: 'unlink', target: opts.symlink, store: opts.store }];
      }
      return [{
        kind: 'remove-hooks',
        path: opts.settings,
        event: 'PreToolUse',
        matcher: '*',
        command: 'bun run guard.ts',
      }];
    },
    async applyRemove(ops): Promise<void> {
      for (const op of ops) {
        if (op.kind === 'unlink') {
          // skill:a succeeds — remove the symlink (store dir left as-is).
          await fs.rm(op.target, { force: true });
        } else {
          // hook:b fails-closed (malformed hooks root, R2-Lot 2). Observe the
          // on-disk manifest first to prove per-entry persistence.
          if (opts.onApplyHookB !== undefined) {
            opts.onApplyHookB(await readManifest(manifestPath));
          }
          throw new Error('hooks root malformed — fail-closed (R2-Lot 2)');
        }
      }
    },
  };
}

/**
 * Set up a [skill:a, hook:b] removal where skill:a succeeds (unlink + store
 * backup) and hook:b throws. Returns the wiring the tests assert on.
 */
async function setupFailSecond(
  onApplyHookB?: (m: Manifest) => void,
): Promise<{ adapter: Adapter; store: string; entries: ReturnType<typeof catalogEntry>[] }> {
  const store = path.join(tmp.dir, 'store', 'skill-a');
  await fs.mkdir(store, { recursive: true });
  await fs.writeFile(path.join(store, 'SKILL.md'), '# skill a\n');

  const symlink = path.join(tmp.dir, '.claude', 'skills', 'a');
  await fs.mkdir(path.dirname(symlink), { recursive: true });
  await fs.symlink(store, symlink).catch(async () => {
    // Fallback for environments without symlink support: a plain marker file.
    await fs.writeFile(symlink, 'link');
  });

  const settings = resolveUserTargets(env).claudeSettings;

  await seedEntry('skill:a', 'skill', [symlink]);
  await seedEntry('hook:b', 'hook', [settings]);

  const adapter = makeFailSecondAdapter({ symlink, store, settings, onApplyHookB });
  const entries = [catalogEntry('skill:a', 'skill'), catalogEntry('hook:b', 'hook')];
  return { adapter, store, entries };
}

// ---------------------------------------------------------------------------
// 1. Per-entry persistence — a failure on entry N persists 1..N-1
// ---------------------------------------------------------------------------

describe('engine.remove — lot3 R2 per-entry persistence', () => {
  it('lot3-R2: a failure on entry N leaves state.json without the removed skill:a but with hook:b', async () => {
    const { adapter, entries } = await setupFailSecond();

    await expect(remove(adapter, entries, 'user', env, manifestPath)).rejects.toThrow();

    const manifest = await readManifest(manifestPath);
    expect(manifest.artifacts.find((a) => a.id === 'skill:a')).toBeUndefined();
    expect(manifest.artifacts.find((a) => a.id === 'hook:b')).toBeDefined();
  });

  it('lot3-R2: per-entry persistence is observable — skill:a is already absent when hook:b applies', async () => {
    let observed: Manifest | undefined;
    const { adapter, entries } = await setupFailSecond((m) => {
      observed = m;
    });

    await expect(remove(adapter, entries, 'user', env, manifestPath)).rejects.toThrow();

    // The manifest read from disk mid-run (while hook:b is being applied) must
    // already reflect skill:a removed — proving the write happened per entry,
    // not once after the loop.
    expect(observed).toBeDefined();
    expect(observed?.artifacts.find((a) => a.id === 'skill:a')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Rich error — removed ids + .bak paths ride on the throw
// ---------------------------------------------------------------------------

describe('engine.remove — lot3 R2 rich error', () => {
  it('lot3-R2: the thrown error carries the removed ids and the .bak paths (removePartial)', async () => {
    const { adapter, entries } = await setupFailSecond();

    let caught: unknown;
    try {
      await remove(adapter, entries, 'user', env, manifestPath);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const partial = (caught as Error & { removePartial?: RemovePartial }).removePartial;
    expect(partial).toBeDefined();
    expect(partial?.removed).toContain('skill:a');
    // skill:a's store was backed up as a whole before the unlink (backupDir).
    expect(partial?.backedUp.length).toBeGreaterThan(0);
    const bakExists = await fs.lstat(partial!.backedUp[0]!).then(() => true).catch(() => false);
    expect(bakExists).toBe(true);
    // hook:b never succeeded → not reported as removed.
    expect(partial?.removed).not.toContain('hook:b');
  });
});

// ---------------------------------------------------------------------------
// 3. Best-effort shared-store cleanup — removeDir failure → warning, not throw
// ---------------------------------------------------------------------------

/** Adapter that removes one hook entry successfully (no throw). */
function makeHookRemoveAdapter(settings: string): Adapter {
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
      return [{
        kind: 'remove-hooks',
        path: settings,
        event: 'PreToolUse',
        matcher: '*',
        command: 'bun run guard.ts',
      }];
    },
    async applyRemove(): Promise<void> {
      // Removal succeeds — the run is fully coherent before cleanup.
    },
  };
}

describe('engine.remove — lot3 R2 best-effort shared-store cleanup', () => {
  it('lot3-R2: a removeDir failure after a coherent run is reported as a warning, not thrown', async () => {
    const settings = resolveUserTargets(env).claudeSettings;
    await seedEntry('hook:guard', 'hook', [settings]);

    // A shared-store dir whose parent is a regular FILE: rm(recursive,force)
    // raises ENOTDIR (not ignored by force), deterministically simulating an
    // EACCES-class cleanup failure without fragile chmod juggling.
    const parentFile = path.join(tmp.dir, 'not-a-dir');
    await fs.writeFile(parentFile, 'x');
    const unremovableStore = path.join(parentFile, 'hooks');

    const adapter = makeHookRemoveAdapter(settings);

    let result: Awaited<ReturnType<typeof remove>> | undefined;
    let threw = false;
    try {
      result = await remove(
        adapter,
        [catalogEntry('hook:guard', 'hook')],
        'user',
        env,
        manifestPath,
        [{ nature: 'hook', dir: unremovableStore }],
      );
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result).toBeDefined();
    expect(result?.removed).toContain('hook:guard');
    expect(result?.warnings.join('\n').toLowerCase()).toContain('cleanup');

    // The manifest write already happened — the entry is gone, run coherent.
    const manifest = await readManifest(manifestPath);
    expect(manifest.artifacts.find((a) => a.id === 'hook:guard')).toBeUndefined();
  });
});
