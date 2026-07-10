/**
 * Lot 3 — R4 (D4): rollback compensates within the TRIPLE identity
 * (id, scope, assistant), and the compensation is informed by the pre-run
 * manifest files so it never destroys a store still referenced elsewhere.
 *
 * Two engine defects this suite pins (both live at HEAD 944dcb0 post-Lot 2):
 *
 *   1. preExistingIds (apply()) snapshots the pre-run ids by SCOPE ALONE, while
 *      the manifest identity is (id, scope, assistant) everywhere else. A FRESH
 *      cross-assistant install (id already tracked for ANOTHER assistant) is
 *      wrongly classified isFreshInstall=false → its symlink is never
 *      compensated on rollback → an orphan symlink outside the manifest,
 *      inconvergeable since Lot 2 (check exit 3 / install no-op / remove exit 2).
 *
 *   2. rollbackCompensations calls adapter.applyRemove([op], env) WITHOUT the
 *      manifestFiles channel. The store refcount (Lot 2 R4) then cannot see a
 *      project-scope symlink installed from another cwd — discoverable ONLY
 *      through ManifestEntry.files (ADR-0020 §3) — and may delete a store still
 *      referenced under a live install.
 *
 * The fake adapters perform REAL filesystem side effects (core linker) and a
 * REAL refcounted store removal (removeStoreIfUnreferenced over the handed-down
 * manifestFiles), so the tests observe the actual rollback, not a mock.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import type { Adapter, AdapterEntry } from '../src/adapter';
import { apply } from '../src/engine';
import { writeText } from '../src/fs-json';
import { link, removeStoreIfUnreferenced, unlinkTarget } from '../src/linker';
import { readManifest, upsertEntry, writeManifest } from '../src/manifest';
import { resolveUserTargets } from '../src/paths';
import type { Env } from '../src/paths';
import type { Assistant, NatureReport, Scope, WriteOp } from '../src/types';
import { makeTmpHome } from './tmp-home';

// ---------------------------------------------------------------------------
// Fake adapter — real fs side effects, refcounted store removal
// ---------------------------------------------------------------------------

const FAIL_SENTINEL = '__FAIL__';

class RollbackTestError extends Error {
  constructor() {
    super('adapter.apply deliberately failed');
    this.name = 'RollbackTestError';
  }
}

/**
 * Adapter whose applyRemove mirrors the real skills refcount: after unlinking
 * the target, it deletes the store ONLY when no handed-down manifestFile still
 * resolves to it. This is what surfaces defect #2 — an empty manifestFiles
 * (the current bug) deletes a store a cross-cwd symlink still references.
 */
function makeAdapter(id: 'claude' | 'opencode', plans: Record<string, WriteOp[]>): Adapter {
  return {
    id,

    async audit(entry: AdapterEntry): Promise<NatureReport> {
      return { id: entry.id, nature: entry.nature, state: 'missing', detail: 'test' };
    },

    async plan(entry: AdapterEntry): Promise<WriteOp[]> {
      return plans[entry.id] ?? [];
    },

    async apply(ops: WriteOp[]): Promise<void> {
      for (const op of ops) {
        if (op.kind === 'write-text') {
          if (op.content === FAIL_SENTINEL) throw new RollbackTestError();
          await writeText(op.path, op.content);
        } else if (op.kind === 'link') {
          await link(op.source, op.store, op.target); // real store sync + symlink
        }
      }
    },

    async planRemove() {
      return [];
    },

    async applyRemove(ops, _env, manifestFiles = []): Promise<void> {
      for (const op of ops) {
        if (op.kind === 'unlink') {
          await unlinkTarget(op.target);
          // Refcount over the manifestFiles the engine hands down (R4): a
          // symlink recorded there — e.g. another assistant's install or a
          // project-scope symlink from another cwd — keeps the store alive.
          await removeStoreIfUnreferenced(op.store, [...manifestFiles]);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Op + entry builders
// ---------------------------------------------------------------------------

function linkOp(source: string, store: string, target: string): WriteOp {
  return { kind: 'link', source, store, target };
}
function failOp(p: string): WriteOp {
  return { kind: 'write-text', path: p, content: FAIL_SENTINEL, description: 'fail' };
}
function entry(id: string, nature: NatureReport['nature'], scope: Scope = 'user'): AdapterEntry {
  return { id, nature, scope };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let manifestPath: string;
let home: string;

beforeEach(async () => {
  tmp = await makeTmpHome('rigger-lot3-r4-');
  env = tmp.env;
  manifestPath = resolveUserTargets(env).stateJson;
  home = tmp.dir;
});

afterEach(async () => {
  await tmp.cleanup();
});

async function exists(p: string): Promise<boolean> {
  return lstat(p).then(() => true).catch(() => false);
}

async function makeSource(name: string): Promise<string> {
  const src = path.join(home, 'src', name);
  await writeText(path.join(src, 'SKILL.md'), `# ${name}`);
  return src;
}

/** Pre-seed a tracked skill install (real symlink + store) at (scope, assistant). */
async function seedInstall(
  id: string,
  store: string,
  target: string,
  source: string,
  scope: Scope,
  assistant: Assistant,
): Promise<void> {
  await link(source, store, target);
  let manifest = await readManifest(manifestPath);
  manifest = upsertEntry(manifest, {
    id,
    nature: 'skill',
    scope,
    ref: 'v1.0.0',
    sha: '',
    installedAt: '2026-01-01T00:00:00.000Z',
    files: [target],
    assistant,
  });
  await writeManifest(manifestPath, manifest);
}

// ---------------------------------------------------------------------------
// Scenario 1 — fresh cross-assistant install IS compensated, store kept
// ---------------------------------------------------------------------------

describe('lot3-R4: rollback identity is the (id, scope, assistant) triple', () => {
  it(
    'lot3-R4: compensates a fresh cross-assistant symlink on rollback while keeping the shared store',
    async () => {
      const source = await makeSource('foo');
      const store = path.join(home, '.config', 'agent-rigger', 'skills', 'foo');
      const claudeTarget = path.join(home, '.claude', 'skills', 'foo');
      // foo already installed for claude (user) — store shared, recorded in manifest.
      await seedInstall('cat/foo', store, claudeTarget, source, 'user', 'claude');

      // Fresh opencode install of [foo, bar] where bar fails AFTER foo is linked.
      const opencodeTarget = path.join(home, '.config', 'opencode', 'skill', 'foo');
      const adapter = makeAdapter('opencode', {
        'cat/foo': [linkOp(source, store, opencodeTarget)],
        'cat/bar': [failOp(path.join(home, 'bar.md'))],
      });

      await expect(
        apply(
          adapter,
          [entry('cat/foo', 'skill'), entry('cat/bar', 'context')],
          'user',
          env,
          manifestPath,
        ),
      ).rejects.toBeInstanceOf(RollbackTestError);

      // Fresh opencode symlink compensated (defect #1: scope-only snapshot skipped it).
      expect(await exists(opencodeTarget)).toBe(false);
      // Store KEPT — still referenced by the claude install (via manifestFiles, defect #2).
      expect(await exists(store)).toBe(true);
      // Claude install untouched.
      expect(await exists(claudeTarget)).toBe(true);
      // Manifest unchanged: still exactly the pre-run claude entry.
      const after = await readManifest(manifestPath);
      expect(after.artifacts).toHaveLength(1);
      expect(after.artifacts[0]?.id).toBe('cat/foo');
      expect(after.artifacts[0]?.assistant).toBe('claude');
    },
  );

  // -------------------------------------------------------------------------
  // Scenario 2 — same-identity re-install is still NOT compensated (Tier 1)
  // -------------------------------------------------------------------------

  it(
    'lot3-R4: does NOT compensate a re-install of the same (id, scope, assistant) — Tier 1 preserved',
    async () => {
      const source = await makeSource('foo');
      const store = path.join(home, '.config', 'agent-rigger', 'skills', 'foo');
      const claudeTarget = path.join(home, '.claude', 'skills', 'foo');
      await seedInstall('cat/foo', store, claudeTarget, source, 'user', 'claude');

      // Re-install foo for the SAME identity (claude, user) in a run that fails.
      const adapter = makeAdapter('claude', {
        'cat/foo': [linkOp(source, store, claudeTarget)],
        'cat/bar': [failOp(path.join(home, 'bar.md'))],
      });

      await expect(
        apply(
          adapter,
          [entry('cat/foo', 'skill'), entry('cat/bar', 'context')],
          'user',
          env,
          manifestPath,
        ),
      ).rejects.toBeInstanceOf(RollbackTestError);

      // Tier 1: a tracked re-install of the same identity is left in place.
      expect(await exists(claudeTarget)).toBe(true);
      expect(await exists(store)).toBe(true);
    },
  );

  // -------------------------------------------------------------------------
  // Scenario 3 — compensation does not destroy a store referenced cross-cwd
  // -------------------------------------------------------------------------

  it(
    'lot3-R4: rollback keeps a store referenced by a claude project-scope symlink from another cwd',
    async () => {
      const source = await makeSource('foo');
      const store = path.join(home, '.config', 'agent-rigger', 'skills', 'foo');
      // A project-scope claude symlink posed from ANOTHER cwd — discoverable
      // only through the manifest entry's files, never by scanning the run's cwd.
      const otherCwdTarget = path.join(home, 'other-project', '.claude', 'skills', 'foo');
      await seedInstall('cat/foo', store, otherCwdTarget, source, 'project', 'claude');

      // Fresh opencode (user) install of foo sharing the store; bar fails.
      const opencodeTarget = path.join(home, '.config', 'opencode', 'skill', 'foo');
      const adapter = makeAdapter('opencode', {
        'cat/foo': [linkOp(source, store, opencodeTarget)],
        'cat/bar': [failOp(path.join(home, 'bar.md'))],
      });

      await expect(
        apply(
          adapter,
          [entry('cat/foo', 'skill'), entry('cat/bar', 'context')],
          'user',
          env,
          manifestPath,
        ),
      ).rejects.toBeInstanceOf(RollbackTestError);

      // The fresh opencode symlink is compensated…
      expect(await exists(opencodeTarget)).toBe(false);
      // …but the store SURVIVES: the cross-cwd claude project symlink references
      // it, discoverable only via the pre-run manifestFiles handed to applyRemove.
      expect(await exists(store)).toBe(true);
      expect(await exists(otherCwdTarget)).toBe(true);
    },
  );
});
