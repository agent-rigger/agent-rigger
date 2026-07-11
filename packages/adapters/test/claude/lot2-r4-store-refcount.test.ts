/**
 * Tests for R4 — shared store refcount + truthful audit
 * (lot2-remove-reversible, covers H4).
 *
 * Contract (requirements.md R4 / design D3):
 * - remove keeps the physical store alive as long as at least one symlink —
 *   any scope, any assistant — still resolves to it (ADR-0020 §3: one store,
 *   N symlinks). The last reference removal deletes the store.
 * - Reference candidates come from the shared helper (claude skills/agents ×
 *   user/project, opencode skills/plugins × user/project) PLUS the `files` of
 *   the manifest entries remaining after the removal — a project install made
 *   from another cwd is only discoverable through the manifest.
 * - audit tells the truth: a dangling symlink (store deleted) is `missing`,
 *   never `present`; a subsequent install repairs the broken link.
 *
 * Isolation: fresh RIGGER_HOME tmp dir per test — never touches the real ~/.
 * Project-scope operations chdir into a realpath'd tmp dir (the claude adapter
 * resolves project targets from process.cwd()) and always restore the cwd.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply, check, remove, reportExitCode } from '@agent-rigger/core/engine';
import { resolveOpencodeUserTargets, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { createClaudeAdapter } from '../../src/claude/adapter';
import { createOpencodeAdapter } from '../../src/opencode/adapter';
import { auditSkill as auditOpencodeSkill } from '../../src/opencode/skills';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-r4-refcount-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** mkdtemp + realpath — chdir targets must be symlink-free so the paths the
 * adapter derives from process.cwd() match what the test asserts on. */
async function makeProjectDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return fs.realpath(dir);
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

function agentUserTargetPath(name: string): string {
  return path.join(path.dirname(targets.claudeSettings), 'agents', `${name}.md`);
}

function agentStorePath(name: string): string {
  return path.join(path.dirname(targets.skillsDir), 'agents', `${name}.md`);
}

// ---------------------------------------------------------------------------
// Cross-scope claude — the store outlives the first removal
// ---------------------------------------------------------------------------

describe('lot2-R4 — cross-scope claude skill refcount', () => {
  it('lot2-R4: removing the project scope keeps the store; removing the last reference deletes it', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'foo');
    const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => srcDir });
    const userEntry: AdapterEntry = { id: 'skill:foo', nature: 'skill', scope: 'user' };
    const projectEntry: AdapterEntry = { id: 'skill:foo', nature: 'skill', scope: 'project' };

    const projectDir = await makeProjectDir('rigger-r4-proj-');
    const originalCwd = process.cwd();
    try {
      await apply(adapter, [userEntry], 'user', env, manifestPath);
      process.chdir(projectDir);
      await apply(adapter, [projectEntry], 'project', env, manifestPath);

      const store = skillStorePath('foo');
      const userTarget = skillTargetPath('foo');
      const projectTarget = path.join(projectDir, '.claude', 'skills', 'foo');
      expect(await exists(projectTarget)).toBe(true);

      // Remove the project scope only — the user symlink still references the store.
      await remove(adapter, [projectEntry], 'project', env, manifestPath);

      expect(await exists(projectTarget)).toBe(false);
      expect(await exists(store)).toBe(true);

      // check --scope=user is TRUTHFUL: the user symlink still resolves to content.
      const md = await fs.readFile(path.join(userTarget, 'SKILL.md'), 'utf8');
      expect(md).toContain('foo');
      const report = await check(adapter, [userEntry], 'user', env, manifestPath);
      expect(report.entries[0]!.state).toBe('present');
      expect(reportExitCode(report)).toBe(0);

      // Last reference: removing the user scope deletes symlink AND store.
      await remove(adapter, [userEntry], 'user', env, manifestPath);
      expect(await exists(userTarget)).toBe(false);
      expect(await exists(store)).toBe(false);
    } finally {
      process.chdir(originalCwd);
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-assistant claude → opencode
// ---------------------------------------------------------------------------

describe('lot2-R4 — cross-assistant refcount (claude → opencode)', () => {
  it('lot2-R4: removing the claude install keeps the store while opencode still references it', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'shared');
    const claudeAdapter = createClaudeAdapter({ denyRef: [], skillSource: () => srcDir });
    const opencodeAdapter = createOpencodeAdapter({ skillSource: () => srcDir });
    const entry: AdapterEntry = { id: 'skill:shared', nature: 'skill', scope: 'user' };

    await apply(claudeAdapter, [entry], 'user', env, manifestPath);
    await apply(opencodeAdapter, [entry], 'user', env, manifestPath);

    const store = skillStorePath('shared');
    const opencodeTarget = path.join(resolveOpencodeUserTargets(env).skillsDir, 'shared');
    expect(await exists(opencodeTarget)).toBe(true);

    // Remove the claude side only.
    await remove(claudeAdapter, [entry], 'user', env, manifestPath);

    expect(await exists(skillTargetPath('shared'))).toBe(false);
    expect(await exists(store)).toBe(true);
    // The opencode symlink still resolves to real content.
    const md = await fs.readFile(path.join(opencodeTarget, 'SKILL.md'), 'utf8');
    expect(md).toContain('shared');

    // Removing the opencode side (last reference) deletes the store.
    await remove(opencodeAdapter, [entry], 'user', env, manifestPath);
    expect(await exists(opencodeTarget)).toBe(false);
    expect(await exists(store)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Agents store (.md) shared between scopes
// ---------------------------------------------------------------------------

describe('lot2-R4 — agents store (.md) refcount between scopes', () => {
  it('lot2-R4: the agent store survives while the other scope references it', async () => {
    const agentFile = await makeAgentFixture(fixturesDir, 'reviewer');
    const adapter = createClaudeAdapter({ denyRef: [], agentSource: () => agentFile });
    const userEntry: AdapterEntry = { id: 'agent:reviewer', nature: 'agent', scope: 'user' };
    const projectEntry: AdapterEntry = { id: 'agent:reviewer', nature: 'agent', scope: 'project' };

    const projectDir = await makeProjectDir('rigger-r4-agent-proj-');
    const originalCwd = process.cwd();
    try {
      await apply(adapter, [userEntry], 'user', env, manifestPath);
      process.chdir(projectDir);
      await apply(adapter, [projectEntry], 'project', env, manifestPath);

      const store = agentStorePath('reviewer');
      const projectTarget = path.join(projectDir, '.claude', 'agents', 'reviewer.md');

      // Remove the project scope only — the user symlink keeps the store alive.
      await remove(adapter, [projectEntry], 'project', env, manifestPath);

      expect(await exists(projectTarget)).toBe(false);
      expect(await exists(store)).toBe(true);
      const content = await fs.readFile(agentUserTargetPath('reviewer'), 'utf8');
      expect(content).toContain('reviewer');

      // Last reference removal deletes the .md store.
      await remove(adapter, [userEntry], 'user', env, manifestPath);
      expect(await exists(store)).toBe(false);
    } finally {
      process.chdir(originalCwd);
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Dangling symlink — truthful audit, install repairs
// ---------------------------------------------------------------------------

describe('lot2-R4 — dangling symlink: audit tells the truth, install repairs', () => {
  it('lot2-R4: check reports a dangling skill symlink as missing (exit 3) and install repairs it', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'broken');
    const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => srcDir });
    const entry: AdapterEntry = { id: 'skill:broken', nature: 'skill', scope: 'user' };

    await apply(adapter, [entry], 'user', env, manifestPath);

    // Pre-existing broken state: the store is gone, the symlink dangles.
    const store = skillStorePath('broken');
    const target = skillTargetPath('broken');
    await fs.rm(store, { recursive: true, force: true });
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);

    const broken = await check(adapter, [entry], 'user', env, manifestPath);
    expect(broken.entries[0]!.state).toBe('missing');
    expect(reportExitCode(broken)).toBe(3);

    // install replaces the dangling link with a healthy installation.
    await apply(adapter, [entry], 'user', env, manifestPath);
    expect(await exists(store)).toBe(true);
    const md = await fs.readFile(path.join(target, 'SKILL.md'), 'utf8');
    expect(md).toContain('broken');

    const repaired = await check(adapter, [entry], 'user', env, manifestPath);
    expect(repaired.entries[0]!.state).toBe('present');
    expect(reportExitCode(repaired)).toBe(0);
  });

  it('lot2-R4: the opencode audit reports a dangling skill symlink as missing too', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'oc-broken');
    const opencodeAdapter = createOpencodeAdapter({ skillSource: () => srcDir });
    const entry: AdapterEntry = { id: 'skill:oc-broken', nature: 'skill', scope: 'user' };

    await apply(opencodeAdapter, [entry], 'user', env, manifestPath);

    const store = skillStorePath('oc-broken');
    await fs.rm(store, { recursive: true, force: true });

    const report = await auditOpencodeSkill(entry, 'user', env);
    expect(report.state).toBe('missing');
  });

  it('lot2-R4: a dangling agent symlink is missing, not present', async () => {
    const agentFile = await makeAgentFixture(fixturesDir, 'ghost');
    const adapter = createClaudeAdapter({ denyRef: [], agentSource: () => agentFile });
    const entry: AdapterEntry = { id: 'agent:ghost', nature: 'agent', scope: 'user' };

    await apply(adapter, [entry], 'user', env, manifestPath);
    await fs.rm(agentStorePath('ghost'), { force: true });

    const report = await check(adapter, [entry], 'user', env, manifestPath);
    expect(report.entries[0]!.state).toBe('missing');
  });
});

// ---------------------------------------------------------------------------
// Reference candidates come from the manifest, not the cwd
// ---------------------------------------------------------------------------

describe('lot2-R4 — one manifest entry, several folded targets (R1 mergeFiles)', () => {
  it('lot2-R4: removing one cwd of a two-cwd project install keeps the store the sibling references', async () => {
    // The SAME (id, project, claude) identity installed from TWO different
    // cwds: mergeFiles (R1) folds both targets into ONE manifest entry. The
    // removal from projB drops that entry — the reference candidates handed to
    // the adapter must still include projA's target, or the store is deleted
    // under a live symlink while the confirmed preview said "kept".
    const srcDir = await makeSkillFixture(fixturesDir, 'folded');
    const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => srcDir });
    const projectEntry: AdapterEntry = { id: 'skill:folded', nature: 'skill', scope: 'project' };

    const projA = await makeProjectDir('rigger-r4-foldA-');
    const projB = await makeProjectDir('rigger-r4-foldB-');
    const originalCwd = process.cwd();
    try {
      process.chdir(projA);
      await apply(adapter, [projectEntry], 'project', env, manifestPath);
      process.chdir(projB);
      await apply(adapter, [projectEntry], 'project', env, manifestPath);

      const store = skillStorePath('folded');
      const targetA = path.join(projA, '.claude', 'skills', 'folded');
      const targetB = path.join(projB, '.claude', 'skills', 'folded');
      expect(await exists(targetA)).toBe(true);
      expect(await exists(targetB)).toBe(true);

      // Remove from projB only.
      await remove(adapter, [projectEntry], 'project', env, manifestPath);

      // projB's symlink is gone, but the store SURVIVES: projA still points at it.
      expect(await exists(targetB)).toBe(false);
      expect(await exists(store)).toBe(true);
      const md = await fs.readFile(path.join(targetA, 'SKILL.md'), 'utf8');
      expect(md).toContain('folded');
    } finally {
      process.chdir(originalCwd);
      await fs.rm(projA, { recursive: true, force: true });
      await fs.rm(projB, { recursive: true, force: true });
    }
  });
});

describe('lot2-R4 — candidates enumerated from manifest files, not process.cwd()', () => {
  it('lot2-R4: a project install from another cwd counts as a reference (store kept)', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'foo');
    const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => srcDir });
    const userEntry: AdapterEntry = { id: 'skill:foo', nature: 'skill', scope: 'user' };
    const projectEntry: AdapterEntry = { id: 'skill:foo', nature: 'skill', scope: 'project' };

    const projA = await makeProjectDir('rigger-r4-projA-');
    const projB = await makeProjectDir('rigger-r4-projB-');
    const originalCwd = process.cwd();
    try {
      await apply(adapter, [userEntry], 'user', env, manifestPath);
      process.chdir(projA);
      await apply(adapter, [projectEntry], 'project', env, manifestPath);

      // Remove the USER entry from an UNRELATED cwd (projB): the projA symlink
      // is not enumerable from the cwd — only the manifest `files` know it.
      process.chdir(projB);
      await remove(adapter, [userEntry], 'user', env, manifestPath);

      const store = skillStorePath('foo');
      expect(await exists(skillTargetPath('foo'))).toBe(false);
      expect(await exists(store)).toBe(true);
      const md = await fs.readFile(
        path.join(projA, '.claude', 'skills', 'foo', 'SKILL.md'),
        'utf8',
      );
      expect(md).toContain('foo');
    } finally {
      process.chdir(originalCwd);
      await fs.rm(projA, { recursive: true, force: true });
      await fs.rm(projB, { recursive: true, force: true });
    }
  });
});
