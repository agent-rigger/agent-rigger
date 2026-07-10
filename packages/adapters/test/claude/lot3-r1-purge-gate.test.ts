/**
 * Tests for lot3-robustesse-moteur R1 — the removal gate reclaims an orphan
 * store when the install symlink was deleted by hand (design D1).
 *
 * The Lot 2 gate returned [] whenever the target was absent, which made the
 * engine preserve the manifest entry forever (M1a) and, worse, orphaned the
 * store left behind by an interrupted unlink→removeStore window. Lot 3 R1:
 *   - target absent, store STILL present → emit the unlink op so the normal
 *     apply flow sweeps the orphan store (rm-force no-op on the absent target,
 *     removeStoreIfUnreferenced reclaims the store) and drops the entry;
 *   - target absent, store ALSO absent → [] (nothing to reclaim; the engine's
 *     purge branch converges the manifest, and idempotent re-removes stay
 *     no-ops — the Lot 2 "not installed" contract holds).
 *
 * Isolation: fresh RIGGER_HOME tmp dir per test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply, remove } from '@agent-rigger/core/engine';
import { readManifest } from '@agent-rigger/core/manifest';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { createClaudeAdapter } from '../../src/claude/adapter';
import { planRemoveGate } from '../../src/shared/remove-gate';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-lot3-r1-gate-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

async function makeSkillFixture(baseDir: string, name: string): Promise<string> {
  const skillDir = path.join(baseDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `# ${name}\nFixture skill.`);
  return skillDir;
}

const exists = (p: string) => fs.lstat(p).then(() => true).catch(() => false);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let targets: ReturnType<typeof resolveUserTargets>;
let manifestPath: string;
let fixturesDir: string;

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
  targets = resolveUserTargets(env);
  manifestPath = targets.stateJson;
  fixturesDir = path.join(tmp.dir, 'fixtures');
  await fs.mkdir(fixturesDir, { recursive: true });
});

afterEach(async () => {
  await tmp.cleanup();
});

function skillTargetPath(name: string): string {
  return path.join(path.dirname(targets.claudeSettings), 'skills', name);
}

function skillStorePath(name: string): string {
  return path.join(targets.skillsDir, name);
}

// ---------------------------------------------------------------------------
// planRemoveGate — unit
// ---------------------------------------------------------------------------

describe('planRemoveGate — lot3 R1 orphan-store reclaim', () => {
  it('lot3-R1: emits the unlink op when the target is absent but the store still exists', async () => {
    const store = skillStorePath('orphan');
    await fs.mkdir(store, { recursive: true });
    await fs.writeFile(path.join(store, 'SKILL.md'), '# orphan');
    const target = skillTargetPath('orphan'); // never created

    const ops = await planRemoveGate('skill:orphan', target, store);

    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('unlink');
    const op = ops[0] as { target: string; store: string };
    expect(op.target).toBe(target);
    expect(op.store).toBe(store);
  });

  it('lot3-R1: returns [] when both the target and the store are absent', async () => {
    const store = skillStorePath('gone');
    const target = skillTargetPath('gone');

    const ops = await planRemoveGate('skill:gone', target, store);

    expect(ops).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// engine.remove — end-to-end: symlink deleted by hand, store reclaimed
// ---------------------------------------------------------------------------

describe('engine.remove — lot3 R1 reclaims the orphan store on re-remove', () => {
  it('lot3-R1: a skill symlink deleted by hand (store present) is removed via the normal flow, store swept, entry dropped', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'reclaim');
    const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => srcDir });
    const entry: AdapterEntry = { id: 'skill:reclaim', nature: 'skill', scope: 'user' };

    await apply(adapter, [entry], 'user', env, manifestPath);

    const target = skillTargetPath('reclaim');
    const store = skillStorePath('reclaim');
    // Simulate the post-crash / hand-removal window: the install symlink is
    // gone but the store lingers.
    await fs.rm(target, { recursive: true, force: true });
    expect(await exists(store)).toBe(true);

    const result = await remove(adapter, [entry], 'user', env, manifestPath);

    // Removed through the normal flow (ops.length > 0), NOT the purge channel.
    expect(result.removed).toEqual(['skill:reclaim']);
    expect(await exists(store)).toBe(false);

    const manifest = await readManifest(manifestPath);
    expect(manifest.artifacts.find((a) => a.id === 'skill:reclaim')).toBeUndefined();
  });

  it('lot3-R1: re-remove after a clean remove is a no-op (idempotent, Lot 2 contract)', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'idem');
    const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => srcDir });
    const entry: AdapterEntry = { id: 'skill:idem', nature: 'skill', scope: 'user' };

    await apply(adapter, [entry], 'user', env, manifestPath);
    await remove(adapter, [entry], 'user', env, manifestPath);

    const result2 = await remove(adapter, [entry], 'user', env, manifestPath);
    expect(result2.removed).toHaveLength(0);
    expect(result2.purged).toHaveLength(0);
  });
});
