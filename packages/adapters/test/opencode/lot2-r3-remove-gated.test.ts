/**
 * R3 — gated removal of opencode skills (lot2-remove-reversible).
 *
 * The opencode skill handler shares the SAME planRemoveGate as the claude
 * handlers (shared/remove-gate.ts): an unlink op is emitted only for a target
 * rigger recognizes as its own — a symlink resolving to the shared store
 * (including a DANGLING one: cleanup after the store was deleted) or a
 * byte-identical plain copy (linkOrCopy copy fallback). Anything else present
 * at the target (a real directory the user rebuilt with their own edits, a
 * foreign symlink) yields a warning-only leave-alone op: the target is never
 * rm -rf'd, and engine.remove preserves the manifest entry.
 *
 * The previous raw-lstat plan destroyed a user-rebuilt directory with the only
 * backup being the STORE's canonical content — the user's target edits were
 * unrecoverable (the H3 destruction class this lot kills).
 *
 * Isolation: fresh RIGGER_HOME tmp dir per test — never touches the real ~/.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply, remove } from '@agent-rigger/core/engine';
import { readManifest } from '@agent-rigger/core/manifest';
import { resolveOpencodeUserTargets, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { createOpencodeAdapter } from '../../src/opencode/adapter';
import { planRemoveSkill } from '../../src/opencode/skills';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-r3-oc-gated-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** Create a minimal skill fixture directory with a SKILL.md file. */
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
let manifestPath: string;
let fixturesDir: string;

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
  manifestPath = resolveUserTargets(env).stateJson;
  fixturesDir = path.join(tmp.dir, 'fixtures');
  await fs.mkdir(fixturesDir, { recursive: true });
});

afterEach(async () => {
  await tmp.cleanup();
});

function targetPath(name: string): string {
  return path.join(resolveOpencodeUserTargets(env).skillsDir, name);
}

function storePath(name: string): string {
  return path.join(resolveUserTargets(env).skillsDir, name);
}

// ---------------------------------------------------------------------------
// planRemoveSkill — the gate
// ---------------------------------------------------------------------------

describe('lot2-R3 — opencode planRemoveSkill gate', () => {
  it('lot2-R3: emits no unlink when the target is a real directory (user edits preserved)', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'drifted');
    const adapter = createOpencodeAdapter({ skillSource: () => srcDir });
    const entry: AdapterEntry = { id: 'skill:drifted', nature: 'skill', scope: 'user' };

    await adapter.apply(await adapter.plan(entry, 'user', env), env);

    // User deleted the symlink and rebuilt a real directory with their edits.
    const target = targetPath('drifted');
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'SKILL.md'), 'user edited content');

    const ops = await adapter.planRemove(entry, 'user', env);

    expect(ops.filter((op) => op.kind === 'unlink')).toHaveLength(0);
    const warnings = ops.flatMap((op) =>
      'warnings' in op && Array.isArray(op.warnings) ? op.warnings : []
    );
    expect(warnings.join('\n')).toContain('present but not managed');
  });

  it('lot2-R3: emits the unlink op for a legitimate rigger symlink', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'legit');
    const adapter = createOpencodeAdapter({ skillSource: () => srcDir });
    const entry: AdapterEntry = { id: 'skill:legit', nature: 'skill', scope: 'user' };

    await adapter.apply(await adapter.plan(entry, 'user', env), env);

    const ops = await adapter.planRemove(entry, 'user', env);

    expect(ops).toEqual([
      { kind: 'unlink', target: targetPath('legit'), store: storePath('legit') },
    ]);
  });

  it('lot2-R3: still emits the unlink op for a DANGLING symlink (cleanup preserved)', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'dangling');
    const adapter = createOpencodeAdapter({ skillSource: () => srcDir });
    const entry: AdapterEntry = { id: 'skill:dangling', nature: 'skill', scope: 'user' };

    await adapter.apply(await adapter.plan(entry, 'user', env), env);

    // The store is gone (e.g. deleted by hand) — the symlink dangles but its
    // link value still names the store: remove must be able to clean it up.
    await fs.rm(storePath('dangling'), { recursive: true, force: true });

    const ops = await planRemoveSkill(entry, 'user', env);

    expect(ops).toEqual([
      { kind: 'unlink', target: targetPath('dangling'), store: storePath('dangling') },
    ]);
  });

  it('lot2-R3: emits the unlink op for a copy-fallback target (byte-identical to the store)', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'copied');
    const adapter = createOpencodeAdapter({ skillSource: () => srcDir });
    const entry: AdapterEntry = { id: 'skill:copied', nature: 'skill', scope: 'user' };

    await adapter.apply(await adapter.plan(entry, 'user', env), env);

    // Simulate the linkOrCopy COPY FALLBACK: plain copy of the store.
    const target = targetPath('copied');
    await fs.rm(target, { recursive: true, force: true });
    await fs.cp(storePath('copied'), target, { recursive: true });

    const ops = await planRemoveSkill(entry, 'user', env);

    expect(ops).toEqual([
      { kind: 'unlink', target, store: storePath('copied') },
    ]);
  });
});

// ---------------------------------------------------------------------------
// engine.remove — end-to-end: nothing destroyed, entry preserved
// ---------------------------------------------------------------------------

describe('lot2-R3 — engine.remove leaves an unmanaged opencode target alone', () => {
  it('lot2-R3: a user-rebuilt directory survives remove --yes; store and manifest entry are kept', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'kept');
    const adapter = createOpencodeAdapter({ skillSource: () => srcDir });
    const entry: AdapterEntry = { id: 'skill:kept', nature: 'skill', scope: 'user' };

    await apply(adapter, [entry], 'user', env, manifestPath);

    const target = targetPath('kept');
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'SKILL.md'), 'precious user edits');

    const result = await remove(adapter, [entry], 'user', env, manifestPath);

    // Nothing destroyed: the rebuilt directory, its content and the store survive.
    expect(result.removed).toHaveLength(0);
    expect(await exists(target)).toBe(true);
    expect(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8')).toBe('precious user edits');
    expect(await exists(storePath('kept'))).toBe(true);

    // The manifest entry is preserved — check keeps reporting the divergence.
    const manifest = await readManifest(manifestPath);
    expect(manifest.artifacts.find((a) => a.id === 'skill:kept')).toBeDefined();
  });
});
