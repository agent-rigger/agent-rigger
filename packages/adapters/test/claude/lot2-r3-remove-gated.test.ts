/**
 * Tests for R3 — gated, backed-up removal of claude skills/agents
 * (lot2-remove-reversible, covers H3).
 *
 * Contract (requirements.md R3 / design D3):
 * - planRemoveSkill / planRemoveAgent emit the unlink op ONLY when the target
 *   is a symlink resolving to the expected rigger store. Any other present
 *   target (real directory, real file, foreign symlink) yields NO destructive
 *   op — only a warning-carrying leave-alone op ("present but not managed"),
 *   and the manifest entry is preserved (empty effective plan, engine keeps it,
 *   `check` keeps reporting the divergence).
 * - A legitimate removal backs up the store (backupDir → <store>.bak-<ISO>-<token>)
 *   BEFORE the rm, reported through RemoveResult.backedUp (same channel as R8).
 *
 * Isolation: fresh RIGGER_HOME tmp dir per test — never touches the real ~/.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply, check, remove, reportExitCode } from '@agent-rigger/core/engine';
import { readManifest } from '@agent-rigger/core/manifest';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { createClaudeAdapter } from '../../src/claude/adapter';
import { applyRemoveSkill } from '../../src/claude/skills';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-r3-gated-'): Promise<{
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

/** Create a minimal agent .md fixture file. */
async function makeAgentFixture(baseDir: string, name: string): Promise<string> {
  const agentFile = path.join(baseDir, `${name}.md`);
  await fs.mkdir(baseDir, { recursive: true });
  await fs.writeFile(agentFile, `# Agent: ${name}\nFixture agent.`);
  return agentFile;
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

function agentTargetPath(name: string): string {
  const home = path.dirname(path.dirname(targets.claudeSettings));
  return path.join(home, '.claude', 'agents', `${name}.md`);
}

function agentStorePath(name: string): string {
  return path.join(path.dirname(targets.skillsDir), 'agents', `${name}.md`);
}

// ---------------------------------------------------------------------------
// planRemove — gate on skills
// ---------------------------------------------------------------------------

describe('lot2-R3 — planRemove gate (skill)', () => {
  it('lot2-R3: emits no unlink when the target is a real directory (not a rigger symlink)', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'drifted');
    const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => srcDir });
    const entry: AdapterEntry = { id: 'skill:drifted', nature: 'skill', scope: 'user' };

    await adapter.apply(await adapter.plan(entry, 'user', env), env);

    // User deleted the symlink and recreated a real directory in its place.
    const target = skillTargetPath('drifted');
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'HANDMADE.md'), 'user work');

    const ops = await adapter.planRemove(entry, 'user', env);

    expect(ops.filter((op) => op.kind === 'unlink')).toHaveLength(0);
    const warnings = ops.flatMap((op) =>
      'warnings' in op && Array.isArray(op.warnings) ? op.warnings : []
    );
    expect(warnings.join('\n')).toContain('present but not managed');
  });

  it('lot2-R3: emits no unlink when the target symlink points outside the rigger store', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'foreign');
    const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => srcDir });
    const entry: AdapterEntry = { id: 'skill:foreign', nature: 'skill', scope: 'user' };

    await adapter.apply(await adapter.plan(entry, 'user', env), env);

    // Replace the rigger symlink with a symlink to some other directory.
    const target = skillTargetPath('foreign');
    const otherDir = path.join(tmp.dir, 'some-other-dir');
    await fs.mkdir(otherDir, { recursive: true });
    await fs.rm(target, { recursive: true, force: true });
    await fs.symlink(otherDir, target);

    const ops = await adapter.planRemove(entry, 'user', env);

    expect(ops.filter((op) => op.kind === 'unlink')).toHaveLength(0);
    const warnings = ops.flatMap((op) =>
      'warnings' in op && Array.isArray(op.warnings) ? op.warnings : []
    );
    expect(warnings.join('\n')).toContain('present but not managed');
  });

  it('lot2-R3: emits the unlink op for a legitimate rigger symlink', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'legit');
    const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => srcDir });
    const entry: AdapterEntry = { id: 'skill:legit', nature: 'skill', scope: 'user' };

    await adapter.apply(await adapter.plan(entry, 'user', env), env);

    const ops = await adapter.planRemove(entry, 'user', env);

    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('unlink');
    const op = ops[0] as { target: string; store: string };
    expect(op.target).toBe(skillTargetPath('legit'));
    expect(op.store).toBe(skillStorePath('legit'));
  });
});

// ---------------------------------------------------------------------------
// planRemove — gate on agents
// ---------------------------------------------------------------------------

describe('lot2-R3 — planRemove gate (agent)', () => {
  it('lot2-R3: emits no unlink when the agent target is a real file (not a rigger symlink)', async () => {
    const agentFile = await makeAgentFixture(fixturesDir, 'drifted-agent');
    const adapter = createClaudeAdapter({ denyRef: [], agentSource: () => agentFile });
    const entry: AdapterEntry = { id: 'agent:drifted-agent', nature: 'agent', scope: 'user' };

    await adapter.apply(await adapter.plan(entry, 'user', env), env);

    // User replaced the symlink with a real file.
    const target = agentTargetPath('drifted-agent');
    await fs.rm(target, { force: true });
    await fs.writeFile(target, '# my own agent\n');

    const ops = await adapter.planRemove(entry, 'user', env);

    expect(ops.filter((op) => op.kind === 'unlink')).toHaveLength(0);
    const warnings = ops.flatMap((op) =>
      'warnings' in op && Array.isArray(op.warnings) ? op.warnings : []
    );
    expect(warnings.join('\n')).toContain('present but not managed');
  });

  it('lot2-R3: emits the unlink op for a legitimate rigger agent symlink', async () => {
    const agentFile = await makeAgentFixture(fixturesDir, 'legit-agent');
    const adapter = createClaudeAdapter({ denyRef: [], agentSource: () => agentFile });
    const entry: AdapterEntry = { id: 'agent:legit-agent', nature: 'agent', scope: 'user' };

    await adapter.apply(await adapter.plan(entry, 'user', env), env);

    const ops = await adapter.planRemove(entry, 'user', env);

    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('unlink');
    const op = ops[0] as { target: string; store: string };
    expect(op.target).toBe(agentTargetPath('legit-agent'));
    expect(op.store).toBe(agentStorePath('legit-agent'));
  });
});

// ---------------------------------------------------------------------------
// engine.remove — end-to-end gating
// ---------------------------------------------------------------------------

describe('lot2-R3 — engine.remove leaves unmanaged targets alone', () => {
  it('lot2-R3: a hand-made directory never installed is left intact', async () => {
    const adapter = createClaudeAdapter({ denyRef: [] });
    const entry: AdapterEntry = { id: 'skill:spec-workflow', nature: 'skill', scope: 'user' };

    // Hand-made directory at the target path, NO manifest entry, NO store.
    const target = skillTargetPath('spec-workflow');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'SKILL.md'), 'precious user work');

    const result = await remove(adapter, [entry], 'user', env, manifestPath);

    expect(result.removed).toHaveLength(0);
    expect(await exists(target)).toBe(true);
    const content = await fs.readFile(path.join(target, 'SKILL.md'), 'utf8');
    expect(content).toBe('precious user work');
  });

  it('lot2-R3: a drifted target (real directory) is preserved and the manifest entry is kept', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'kept');
    const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => srcDir });
    const entry: AdapterEntry = { id: 'skill:kept', nature: 'skill', scope: 'user' };

    await apply(adapter, [entry], 'user', env, manifestPath);

    const target = skillTargetPath('kept');
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'HANDMADE.md'), 'user work');

    const result = await remove(adapter, [entry], 'user', env, manifestPath);

    // Nothing destroyed: target, its content, and the store are all intact.
    expect(result.removed).toHaveLength(0);
    expect(await exists(target)).toBe(true);
    expect(await fs.readFile(path.join(target, 'HANDMADE.md'), 'utf8')).toBe('user work');
    expect(await exists(skillStorePath('kept'))).toBe(true);

    // The manifest entry is preserved — check keeps reporting the divergence.
    const manifest = await readManifest(manifestPath);
    expect(manifest.artifacts.find((a) => a.id === 'skill:kept')).toBeDefined();
  });

  it('lot2-R3: a foreign symlink is preserved and the manifest entry is kept', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'foreign-e2e');
    const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => srcDir });
    const entry: AdapterEntry = { id: 'skill:foreign-e2e', nature: 'skill', scope: 'user' };

    await apply(adapter, [entry], 'user', env, manifestPath);

    const target = skillTargetPath('foreign-e2e');
    const otherDir = path.join(tmp.dir, 'elsewhere');
    await fs.mkdir(otherDir, { recursive: true });
    await fs.rm(target, { recursive: true, force: true });
    await fs.symlink(otherDir, target);

    const result = await remove(adapter, [entry], 'user', env, manifestPath);

    expect(result.removed).toHaveLength(0);
    const stat = await fs.lstat(target);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(await fs.readlink(target)).toBe(otherDir);

    const manifest = await readManifest(manifestPath);
    expect(manifest.artifacts.find((a) => a.id === 'skill:foreign-e2e')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// apply-time re-check — the gate holds at the moment of destruction (TOCTOU)
// ---------------------------------------------------------------------------

describe('lot2-R3 — applyRemoveSkill re-verifies the gate before deleting (TOCTOU)', () => {
  it('lot2-R3: an unlink op whose target became a real directory deletes NOTHING (target and store intact)', async () => {
    // Reproduces the reviewed probe: a plan-time unlink op raced against a
    // symlink→directory swap (2nd rigger process, or a tool recreating the
    // folder) must not rm -rf the directory — engine.remove backs up only the
    // STORE, never the target, so this would be unrecoverable destruction.
    const store = skillStorePath('raced');
    await fs.mkdir(store, { recursive: true });
    await fs.writeFile(path.join(store, 'SKILL.md'), '# raced');

    const target = skillTargetPath('raced');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'PRECIOUS.md'), 'user work created in the window');

    await applyRemoveSkill([{ kind: 'unlink', target, store }], env);

    expect(await exists(target)).toBe(true);
    expect(await fs.readFile(path.join(target, 'PRECIOUS.md'), 'utf8'))
      .toBe('user work created in the window');
    expect(await exists(store)).toBe(true);
  });

  it('lot2-R3: an unlink op whose target is still the rigger symlink proceeds normally', async () => {
    const store = skillStorePath('sane');
    await fs.mkdir(store, { recursive: true });
    await fs.writeFile(path.join(store, 'SKILL.md'), '# sane');
    const target = skillTargetPath('sane');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(store, target);

    await applyRemoveSkill([{ kind: 'unlink', target, store }], env);

    expect(await exists(target)).toBe(false);
    expect(await exists(store)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// copy-fallback installs are removable (target byte-identical to the store)
// ---------------------------------------------------------------------------

describe('lot2-R3 — copy-fallback installs stay removable', () => {
  it('lot2-R3: a plain-copy target byte-identical to the store audits present and is removed with it', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'copied');
    const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => srcDir });
    const entry: AdapterEntry = { id: 'skill:copied', nature: 'skill', scope: 'user' };

    await apply(adapter, [entry], 'user', env, manifestPath);

    // Simulate the linkOrCopy COPY FALLBACK (symlink unavailable): the target
    // is a plain copy of the store, byte for byte.
    const target = skillTargetPath('copied');
    const store = skillStorePath('copied');
    await fs.rm(target, { recursive: true, force: true });
    await fs.cp(store, target, { recursive: true });

    // The audit counts the copy as installed…
    const report = await check(adapter, [entry], 'user', env, manifestPath);
    expect(report.entries[0]!.state).toBe('present');

    // …and remove is NOT blocked forever: target, store and entry all go.
    const result = await remove(adapter, [entry], 'user', env, manifestPath);
    expect(result.removed).toEqual(['skill:copied']);
    expect(await exists(target)).toBe(false);
    expect(await exists(store)).toBe(false);
    const manifest = await readManifest(manifestPath);
    expect(manifest.artifacts.find((a) => a.id === 'skill:copied')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// check keeps reporting the divergence after a leave-alone
// ---------------------------------------------------------------------------

describe('lot2-R3 — check reports the drifted target the remove gate refused', () => {
  it('lot2-R3: a real directory replacing the symlink makes check exit 3 (drift), before and after remove', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'visible');
    const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => srcDir });
    const entry: AdapterEntry = { id: 'skill:visible', nature: 'skill', scope: 'user' };

    await apply(adapter, [entry], 'user', env, manifestPath);

    // User replaces the install symlink with a real directory.
    const target = skillTargetPath('visible');
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'HANDMADE.md'), 'user work');

    // The divergence is visible BEFORE remove…
    const before = await check(adapter, [entry], 'user', env, manifestPath);
    expect(before.entries[0]!.state).toBe('drift');
    expect(reportExitCode(before)).toBe(3);

    // …remove leaves the target alone and preserves the entry (existing gate)…
    const result = await remove(adapter, [entry], 'user', env, manifestPath);
    expect(result.removed).toHaveLength(0);

    // …and check KEEPS reporting it afterwards — the promise the leave-alone
    // warning makes ("check keeps reporting the divergence") holds.
    const after = await check(adapter, [entry], 'user', env, manifestPath);
    expect(after.entries[0]!.state).toBe('drift');
    expect(reportExitCode(after)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// engine.remove — store backed up before deletion
// ---------------------------------------------------------------------------

describe('lot2-R3 — engine.remove backs up the store before deletion', () => {
  it('lot2-R3: a legitimate skill remove backs up the store directory (user edits survive)', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'backed');
    const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => srcDir });
    const entry: AdapterEntry = { id: 'skill:backed', nature: 'skill', scope: 'user' };

    await apply(adapter, [entry], 'user', env, manifestPath);

    // User edits the skill through the symlink — the edit lives in the store.
    const store = skillStorePath('backed');
    await fs.writeFile(path.join(store, 'SKILL.md'), '# backed\nuser modified\n');

    const result = await remove(adapter, [entry], 'user', env, manifestPath);

    // Removal happened: symlink and store are gone, entry dropped.
    expect(result.removed).toEqual(['skill:backed']);
    expect(await exists(skillTargetPath('backed'))).toBe(false);
    expect(await exists(store)).toBe(false);

    // The store was backed up first — reported in backedUp (same channel as R8).
    const storeBak = result.backedUp.find((b) => b.startsWith(`${store}.bak-`));
    expect(storeBak).toBeDefined();
    const saved = await fs.readFile(path.join(storeBak!, 'SKILL.md'), 'utf8');
    expect(saved).toBe('# backed\nuser modified\n');
  });

  it('lot2-R3: a legitimate agent remove backs up the store .md file', async () => {
    const agentFile = await makeAgentFixture(fixturesDir, 'backed-agent');
    const adapter = createClaudeAdapter({ denyRef: [], agentSource: () => agentFile });
    const entry: AdapterEntry = { id: 'agent:backed-agent', nature: 'agent', scope: 'user' };

    await apply(adapter, [entry], 'user', env, manifestPath);

    const store = agentStorePath('backed-agent');
    const result = await remove(adapter, [entry], 'user', env, manifestPath);

    expect(result.removed).toEqual(['agent:backed-agent']);
    expect(await exists(agentTargetPath('backed-agent'))).toBe(false);
    expect(await exists(store)).toBe(false);

    const storeBak = result.backedUp.find((b) => b.startsWith(`${store}.bak-`));
    expect(storeBak).toBeDefined();
    const saved = await fs.readFile(storeBak!, 'utf8');
    expect(saved).toBe('# Agent: backed-agent\nFixture agent.');
  });
});
