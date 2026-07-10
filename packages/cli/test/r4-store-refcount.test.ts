/**
 * Tests for R4 at the CLI seam — the removal preview announces the fate of the
 * shared store (lot2-remove-reversible, covers H4).
 *
 * Contract (requirements.md R4, checklist "renderRemovalPlan"):
 * - For every unlink op the plan preview states whether the store will be
 *   DELETED with this removal (last reference) or KEPT (still referenced by
 *   another scope/assistant or by a manifest-recorded target from another cwd).
 * - The human confirmation therefore covers what is actually destroyed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createClaudeAdapter } from '@agent-rigger/adapters';
import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply } from '@agent-rigger/core/engine';
import { readManifest, upsertEntry, writeManifest } from '@agent-rigger/core/manifest';
import { resolveOpencodeUserTargets, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { ManifestEntry, RemovalOp } from '@agent-rigger/core/types';

import { runRemove } from '../src/cmd-remove';
import { renderRemovalPlan } from '../src/ui';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-r4-cli-'): Promise<{
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
// renderRemovalPlan — unit: store fate lines
// ---------------------------------------------------------------------------

describe('R4 — renderRemovalPlan shows the fate of the store', () => {
  const unlinkOp: RemovalOp = {
    kind: 'unlink',
    target: '/home/u/.claude/skills/foo',
    store: '/home/u/.config/agent-rigger/skills/foo',
  };

  it('R4: announces the store deletion when this unlink is the last reference', () => {
    const result = renderRemovalPlan(
      [{ id: 'skill:foo', nature: 'skill', ops: [unlinkOp] }],
      { color: false, storeFates: { '/home/u/.config/agent-rigger/skills/foo': 'delete' } },
    );

    expect(result).toContain('store');
    expect(result).toContain('deleted — last reference');
  });

  it('R4: announces the store conservation when it is still referenced elsewhere', () => {
    const result = renderRemovalPlan(
      [{ id: 'skill:foo', nature: 'skill', ops: [unlinkOp] }],
      { color: false, storeFates: { '/home/u/.config/agent-rigger/skills/foo': 'keep' } },
    );

    expect(result).toContain('kept — still referenced');
  });
});

// ---------------------------------------------------------------------------
// runRemove — end-to-end fate in the plan output
// ---------------------------------------------------------------------------

describe('R4 — runRemove plan output announces the store fate', () => {
  it('R4: single reference → "deleted — last reference" and the store is gone', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'solo');
    const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => srcDir });
    const entry: AdapterEntry = { id: 'skill:solo', nature: 'skill', scope: 'user' };

    await apply(adapter, [entry], 'user', env, manifestPath);

    const result = await runRemove({
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['skill:solo'],
      confirm: true,
    });

    expect(result.applied).toBe(true);
    expect(result.output).toContain('deleted — last reference');
    expect(await exists(skillStorePath('solo'))).toBe(false);
  });

  it('R4: another assistant still references the store → "kept — still referenced" and the store survives', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'shared');
    const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => srcDir });
    const entry: AdapterEntry = { id: 'skill:shared', nature: 'skill', scope: 'user' };

    await apply(adapter, [entry], 'user', env, manifestPath);

    // A second reference: an opencode-style symlink pointing at the same store.
    const store = skillStorePath('shared');
    const opencodeTarget = path.join(resolveOpencodeUserTargets(env).skillsDir, 'shared');
    await fs.mkdir(path.dirname(opencodeTarget), { recursive: true });
    await fs.symlink(store, opencodeTarget);

    const result = await runRemove({
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['skill:shared'],
      confirm: true,
    });

    expect(result.applied).toBe(true);
    expect(result.output).toContain('kept — still referenced');
    expect(await exists(store)).toBe(true);
    expect(await exists(opencodeTarget)).toBe(true);
    expect(await exists(skillTargetPath('shared'))).toBe(false);
  });

  it('R4: a manifest-recorded target from another cwd keeps the store (preview + effect)', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'foo');
    const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => srcDir });
    const userEntry: AdapterEntry = { id: 'skill:foo', nature: 'skill', scope: 'user' };

    await apply(adapter, [userEntry], 'user', env, manifestPath);

    // Simulate a project install performed from ANOTHER cwd: a symlink under
    // projA plus a manifest entry whose `files` records that target. Neither
    // the runRemove cwd nor the static candidate paths can see projA.
    const store = skillStorePath('foo');
    const projA = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-r4-projA-')));
    const projTarget = path.join(projA, '.claude', 'skills', 'foo');
    await fs.mkdir(path.dirname(projTarget), { recursive: true });
    await fs.symlink(store, projTarget);

    const manifest = await readManifest(manifestPath);
    const projectEntry: ManifestEntry = {
      id: 'skill:foo',
      nature: 'skill',
      ref: 'v0.0.0',
      sha: '',
      scope: 'project',
      installedAt: new Date().toISOString(),
      files: [projTarget],
      assistant: 'claude',
    };
    await writeManifest(manifestPath, upsertEntry(manifest, projectEntry));

    try {
      const result = await runRemove({
        adapter,
        scope: 'user',
        env,
        manifestPath,
        selectedIds: ['skill:foo'],
        confirm: true,
        cwd: tmp.dir,
      });

      expect(result.applied).toBe(true);
      expect(result.output).toContain('kept — still referenced');
      expect(await exists(store)).toBe(true);
      const md = await fs.readFile(path.join(projTarget, 'SKILL.md'), 'utf8');
      expect(md).toContain('foo');
    } finally {
      await fs.rm(projA, { recursive: true, force: true });
    }
  });
});
