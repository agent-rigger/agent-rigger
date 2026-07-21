/**
 * Tests for R3 at the CLI seam (runRemove) — gated removal of claude skills
 * (lot2-remove-reversible, covers H3).
 *
 * Scenarios (requirements.md R3):
 * 1. Hand-made directory, never installed → NotInstalledError (R5) and the
 *    directory is INTACT: no rm, no write. This is the maximal-destruction
 *    scenario of the 2026-07-06 review — a bare `--yes` used to rm -rf it.
 * 2. Manifest entry present but the target drifted to a real directory →
 *    nothing destroyed, the "present but not managed" warning is surfaced in
 *    the command output, and the manifest entry is preserved.
 * 3. Legitimate target → removal proceeds and the store backup path shows up
 *    in the output recap (backedUp channel wired end-to-end).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createClaudeAdapter } from '@agent-rigger/adapters';
import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply } from '@agent-rigger/core/engine';
import { readManifest } from '@agent-rigger/core/manifest';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { NotInstalledError, runRemove } from '../src/cmd-remove';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-r3-cli-'): Promise<{
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

// ---------------------------------------------------------------------------
// Scenario 1 — hand-made directory, never installed
// ---------------------------------------------------------------------------

describe('lot2-R3 — runRemove on a hand-made directory never installed', () => {
  it('lot2-R3: fails "not installed" and leaves the directory intact', async () => {
    const adapter = createClaudeAdapter({ denyRef: [] });

    // Hand-made directory at the exact target path a remove would hit.
    const target = skillTargetPath('spec-workflow');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'SKILL.md'), 'precious user work');

    const attempt = runRemove({
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['skill:spec-workflow'],
      confirm: true,
    });

    expect(attempt).rejects.toThrow(NotInstalledError);
    await attempt.catch(() => {});

    // No rm, no write: the directory and its content survived.
    expect(await exists(target)).toBe(true);
    const content = await fs.readFile(path.join(target, 'SKILL.md'), 'utf8');
    expect(content).toBe('precious user work');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — drifted target: warning surfaced, entry preserved
// ---------------------------------------------------------------------------

describe('lot2-R3 — runRemove on a drifted target (manifest entry, real directory)', () => {
  it('lot2-R3: destroys nothing, surfaces the "present but not managed" warning, keeps the entry', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'drifted');
    const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => srcDir });
    const entry: AdapterEntry = { id: 'skill:drifted', nature: 'skill', scope: 'user' };

    await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });

    // The user deleted the symlink and recreated a real directory.
    const target = skillTargetPath('drifted');
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'HANDMADE.md'), 'user work');

    const result = await runRemove({
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['skill:drifted'],
      confirm: true,
    });

    // Nothing was removed and the warning names the unmanaged target.
    expect(result.applied).toBe(false);
    expect(result.removed).toHaveLength(0);
    expect(result.output).toContain('present but not managed');

    // Target intact, manifest entry preserved (check keeps reporting it).
    expect(await fs.readFile(path.join(target, 'HANDMADE.md'), 'utf8')).toBe('user work');
    const manifest = await readManifest(manifestPath);
    expect(manifest.artifacts.find((a) => a.id === 'skill:drifted')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — legitimate removal: store backup surfaces in the recap
// ---------------------------------------------------------------------------

describe('lot2-R3 — runRemove on a legitimate install', () => {
  it('lot2-R3: removes the symlink and reports the store backup in backedUp', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'legit');
    const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => srcDir });
    const entry: AdapterEntry = { id: 'skill:legit', nature: 'skill', scope: 'user' };

    await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });

    const store = path.join(targets.skillsDir, 'legit');

    const result = await runRemove({
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['skill:legit'],
      confirm: true,
    });

    expect(result.applied).toBe(true);
    expect(result.removed).toEqual(['skill:legit']);
    expect(await exists(skillTargetPath('legit'))).toBe(false);
    expect(await exists(store)).toBe(false);

    const storeBak = result.backedUp.find((b) => b.startsWith(`${store}.bak-`));
    expect(storeBak).toBeDefined();
    expect(result.output).toContain(storeBak!);
  });
});
