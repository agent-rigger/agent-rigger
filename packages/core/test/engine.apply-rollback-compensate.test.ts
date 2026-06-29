/**
 * Tests for engine.ts — apply() rollback of NON-path side effects (option B,
 * Tier 1 orphan-safe).
 *
 * opt-A rolls back path-based file writes. Option B extends rollback to:
 *   - link ops (skills/agents): symlink + store, undone via adapter.applyRemove
 *     (unlink) — but ONLY for fresh installs (entry absent from the pre-apply
 *     manifest). A re-install of a tracked entry is left in place (Tier 1).
 *   - plugin-install: undone via a best-effort `plugin-uninstall` compensation.
 *   - hook scriptStore (a SHARED directory): removed only if it did NOT exist
 *     before the run (a pre-existing store is left — other hooks share it).
 *
 * The fake adapter performs REAL filesystem side effects (via the core linker)
 * so the test observes the actual rollback, not a mock.
 *
 * Isolation: fresh tmp HOME per test via makeTmpHome().
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import type { Adapter, AdapterEntry } from '../src/adapter';
import { apply } from '../src/engine';
import { readText, writeText } from '../src/fs-json';
import { link, syncToStore, unlink } from '../src/linker';
import { readManifest, upsertEntry, writeManifest } from '../src/manifest';
import { resolveUserTargets } from '../src/paths';
import type { Env } from '../src/paths';
import type { NatureReport, Scope, WriteOp } from '../src/types';
import { makeTmpHome } from './tmp-home';

// ---------------------------------------------------------------------------
// Test adapter — real fs side effects, fails on a write-text sentinel
// ---------------------------------------------------------------------------

const FAIL_SENTINEL = '__FAIL__';
/** Plugin id whose compensating uninstall deliberately throws during rollback. */
const FAIL_UNINSTALL = 'fail-uninstall';

class CompError extends Error {
  constructor() {
    super('adapter.apply deliberately failed');
    this.name = 'CompError';
  }
}

/** Spies for the external (file-less) plugin side effects. */
let pluginInstalls: string[];
let pluginUninstalls: string[];

function makeCompAdapter(plans: Record<string, WriteOp[]>): Adapter {
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
          if (op.content === FAIL_SENTINEL) throw new CompError();
          await writeText(op.path, op.content);
        } else if (op.kind === 'link') {
          await link(op.source, op.store, op.target); // real store copy + symlink
        } else if (op.kind === 'plugin-install') {
          pluginInstalls.push(op.plugin);
        } else if (op.kind === 'merge-hooks') {
          if (op.scriptSource !== undefined && op.scriptStore !== undefined) {
            await syncToStore(op.scriptSource, op.scriptStore, { preserveGlobs: ['guard-*.log'] });
          }
          await writeText(op.path, 'hook-installed');
        }
      }
    },

    async planRemove() {
      return [];
    },

    async applyRemove(ops): Promise<void> {
      for (const op of ops) {
        if (op.kind === 'unlink') {
          await unlink(op.target, op.store);
        } else if (op.kind === 'plugin-uninstall') {
          // Sentinel: simulate an external `claude plugin uninstall` failure.
          if (op.plugin === FAIL_UNINSTALL) {
            throw new Error('plugin uninstall failed');
          }
          pluginUninstalls.push(op.plugin);
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
function pluginOp(plugin: string): WriteOp {
  return { kind: 'plugin-install', plugin, marketplace: 'https://example.com/mp' };
}
function hookOp(settingsPath: string, scriptSource: string, scriptStore: string): WriteOp {
  return {
    kind: 'merge-hooks',
    path: settingsPath,
    event: 'PreToolUse',
    matcher: 'Bash',
    command: `bun run ${scriptStore}/guard.ts`,
    scriptSource,
    scriptStore,
  };
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
  tmp = await makeTmpHome('rigger-comp-');
  env = tmp.env;
  manifestPath = resolveUserTargets(env).stateJson;
  home = tmp.dir;
  pluginInstalls = [];
  pluginUninstalls = [];
});

afterEach(async () => {
  await tmp.cleanup();
});

async function exists(p: string): Promise<boolean> {
  return lstat(p).then(() => true).catch(() => false);
}

/** A populated source directory to link from. */
async function makeSource(name: string): Promise<string> {
  const src = path.join(home, 'src', name);
  await writeText(path.join(src, 'SKILL.md'), `# ${name}`);
  return src;
}

// ---------------------------------------------------------------------------
// B1a — skills/agents link compensation
// ---------------------------------------------------------------------------

describe('rollback: link ops (skills/agents)', () => {
  it('unlinks a freshly-installed skill (target + store) when a later entry throws', async () => {
    const source = await makeSource('my-skill');
    const store = path.join(home, '.config', 'agent-rigger', 'skills', 'my-skill');
    const target = path.join(home, '.claude', 'skills', 'my-skill');

    const adapter = makeCompAdapter({
      skill: [linkOp(source, store, target)],
      bad: [failOp(path.join(home, 'b.md'))],
    });

    await expect(
      apply(adapter, [entry('skill', 'skill'), entry('bad', 'context')], 'user', env, manifestPath),
    ).rejects.toBeInstanceOf(CompError);

    expect(await exists(target)).toBe(false); // symlink removed
    expect(await exists(store)).toBe(false); // store removed
  });

  it('does NOT unlink a re-installed (already-tracked) skill on rollback', async () => {
    const source = await makeSource('my-skill');
    const store = path.join(home, '.config', 'agent-rigger', 'skills', 'my-skill');
    const target = path.join(home, '.claude', 'skills', 'my-skill');

    // Pre-seed: skill already installed AND recorded in the manifest.
    await link(source, store, target);
    let manifest = await readManifest(manifestPath);
    manifest = upsertEntry(manifest, {
      id: 'skill',
      nature: 'skill',
      scope: 'user',
      ref: 'v1.0.0',
      sha: '',
      installedAt: '2026-01-01T00:00:00.000Z',
      files: [target],
    });
    await writeManifest(manifestPath, manifest);

    const adapter = makeCompAdapter({
      skill: [linkOp(source, store, target)],
      bad: [failOp(path.join(home, 'b.md'))],
    });

    await expect(
      apply(adapter, [entry('skill', 'skill'), entry('bad', 'context')], 'user', env, manifestPath),
    ).rejects.toBeInstanceOf(CompError);

    // Tier 1: a tracked re-install is left in place (not unlinked).
    expect(await exists(target)).toBe(true);
    expect(await exists(store)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B1c — plugin compensation
// ---------------------------------------------------------------------------

describe('rollback: plugin-install', () => {
  it('issues a plugin-uninstall compensation for a freshly-installed plugin', async () => {
    const adapter = makeCompAdapter({
      plugin: [pluginOp('my-plugin')],
      bad: [failOp(path.join(home, 'b.md'))],
    });

    await expect(
      apply(
        adapter,
        [entry('plugin', 'plugin'), entry('bad', 'context')],
        'user',
        env,
        manifestPath,
      ),
    ).rejects.toBeInstanceOf(CompError);

    expect(pluginInstalls).toEqual(['my-plugin']);
    expect(pluginUninstalls).toEqual(['my-plugin']); // compensated
  });

  it('surfaces a failing compensation in err.rollbackFailures without masking the original error', async () => {
    const adapter = makeCompAdapter({
      plugin: [pluginOp(FAIL_UNINSTALL)],
      bad: [failOp(path.join(home, 'b.md'))],
    });

    let caught: unknown;
    try {
      await apply(
        adapter,
        [entry('plugin', 'plugin'), entry('bad', 'context')],
        'user',
        env,
        manifestPath,
      );
    } catch (err) {
      caught = err;
    }

    // Original error preserved (not masked by the rollback failure).
    expect(caught).toBeInstanceOf(CompError);
    // The failed compensation is surfaced, not swallowed.
    const failures = (caught as { rollbackFailures?: Array<{ path: string }> }).rollbackFailures;
    expect(failures).toBeDefined();
    expect(failures!.some((f) => f.path === `plugin:${FAIL_UNINSTALL}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B1b — hook scriptStore (shared dir)
// ---------------------------------------------------------------------------

describe('rollback: hook scriptStore (shared dir)', () => {
  it('removes a scriptStore created by this run when a later entry throws', async () => {
    const scriptSource = path.join(home, 'src', 'hooks');
    await writeText(path.join(scriptSource, 'guard.ts'), '// guard');
    const scriptStore = path.join(home, '.config', 'agent-rigger', 'hooks');
    const settings = path.join(home, '.claude', 'settings.json');

    const adapter = makeCompAdapter({
      hook: [hookOp(settings, scriptSource, scriptStore)],
      bad: [failOp(path.join(home, 'b.md'))],
    });

    await expect(
      apply(adapter, [entry('hook', 'hook'), entry('bad', 'context')], 'user', env, manifestPath),
    ).rejects.toBeInstanceOf(CompError);

    expect(await exists(scriptStore)).toBe(false); // freshly-created store removed
  });

  it('LEAVES a pre-existing scriptStore (shared by other hooks) on rollback', async () => {
    const scriptSource = path.join(home, 'src', 'hooks');
    await writeText(path.join(scriptSource, 'guard.ts'), '// guard');
    const scriptStore = path.join(home, '.config', 'agent-rigger', 'hooks');
    const settings = path.join(home, '.claude', 'settings.json');

    // Pre-existing store with a runtime log already present. The log matches the
    // preserveGlob, so syncToStore keeps it across the install — and rollback must
    // not wipe the shared store either.
    await writeText(path.join(scriptStore, 'guard-runtime.log'), 'prior-run');

    const adapter = makeCompAdapter({
      hook: [hookOp(settings, scriptSource, scriptStore)],
      bad: [failOp(path.join(home, 'b.md'))],
    });

    await expect(
      apply(adapter, [entry('hook', 'hook'), entry('bad', 'context')], 'user', env, manifestPath),
    ).rejects.toBeInstanceOf(CompError);

    // Shared store left intact (not removed by rollback); the preserved log survives.
    expect(await exists(scriptStore)).toBe(true);
    expect(await readText(path.join(scriptStore, 'guard-runtime.log'))).toBe('prior-run');
  });
});

// ---------------------------------------------------------------------------
// Happy path — compensations only fire on failure
// ---------------------------------------------------------------------------

describe('rollback: happy path leaves everything installed', () => {
  it('a fully successful apply installs all artifacts and compensates nothing', async () => {
    const source = await makeSource('ok-skill');
    const store = path.join(home, '.config', 'agent-rigger', 'skills', 'ok-skill');
    const target = path.join(home, '.claude', 'skills', 'ok-skill');

    const adapter = makeCompAdapter({
      skill: [linkOp(source, store, target)],
      plugin: [pluginOp('ok-plugin')],
    });

    const result = await apply(
      adapter,
      [entry('skill', 'skill'), entry('plugin', 'plugin')],
      'user',
      env,
      manifestPath,
    );

    expect(await exists(target)).toBe(true);
    expect(await exists(store)).toBe(true);
    expect(pluginInstalls).toEqual(['ok-plugin']);
    expect(pluginUninstalls).toEqual([]); // no rollback
    expect(result.manifest.artifacts).toHaveLength(2);
  });
});
