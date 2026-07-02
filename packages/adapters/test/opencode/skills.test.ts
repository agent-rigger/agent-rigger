/**
 * Tests for opencode/skills handler (TDD — written before implementation).
 *
 * Covers:
 * - skillName: strips 'skill:' prefix from entry id (shared guard with Claude).
 * - auditSkill: target absent → missing; target present (dir or symlink) → present.
 * - planSkill: absent → 1 link op (store shared with Claude, target opencode-owned); present → [].
 * - applySkill: poses the skill (store filled + opencode target symlink); scanner called with source.
 * - applySkill: blocking scanner → SkillScanBlockedError, nothing installed.
 * - applySkill: idempotent (2nd apply does not break anything).
 * - end-to-end via createOpencodeAdapter: check missing → apply → check present → 2nd apply no-op.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import {
  resolveOpencodeProjectTargets,
  resolveOpencodeUserTargets,
  resolveUserTargets,
} from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { Scanner } from '@agent-rigger/core/scan';
import type { Verdict } from '@agent-rigger/core/types';

import { createOpencodeAdapter } from '../../src/opencode/adapter';
import {
  applySkill,
  auditSkill,
  planSkill,
  skillName,
  SkillScanBlockedError,
} from '../../src/opencode/skills';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-opencode-skills-'): Promise<{
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

const PASSING_VERDICT: Verdict = { ok: true };

/** Spy scanner that records calls. */
function makeSpyScanner(verdict: Verdict = PASSING_VERDICT): Scanner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    scan(source: string): Promise<Verdict> {
      calls.push(source);
      return Promise.resolve(verdict);
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let fixturesDir: string;

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
  fixturesDir = path.join(tmp.dir, 'fixtures');
  await fs.mkdir(fixturesDir, { recursive: true });
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// skillName
// ---------------------------------------------------------------------------

describe('skillName', () => {
  it("strips 'skill:' prefix from entry id", () => {
    const entry: AdapterEntry = { id: 'skill:spec-workflow', nature: 'skill', scope: 'user' };
    expect(skillName(entry)).toBe('spec-workflow');
  });

  it('returns the id unchanged when no prefix', () => {
    const entry: AdapterEntry = { id: 'my-skill', nature: 'skill', scope: 'user' };
    expect(skillName(entry)).toBe('my-skill');
  });

  it('throws UnsafeArtifactNameError for ids with multiple colons (path traversal guard)', () => {
    const entry: AdapterEntry = { id: 'skill:a:b', nature: 'skill', scope: 'user' };
    expect(() => skillName(entry)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// auditSkill
// ---------------------------------------------------------------------------

describe('auditSkill', () => {
  it('returns missing when target does not exist', async () => {
    const entry: AdapterEntry = { id: 'skill:spec-workflow', nature: 'skill', scope: 'user' };

    const report = await auditSkill(entry, 'user', env);

    expect(report.state).toBe('missing');
    expect(report.nature).toBe('skill');
    expect(report.id).toBe('skill:spec-workflow');
  });

  it('returns present when the opencode user target directory exists', async () => {
    const entry: AdapterEntry = { id: 'skill:spec-workflow', nature: 'skill', scope: 'user' };
    const targets = resolveOpencodeUserTargets(env);
    const targetPath = path.join(targets.skillsDir, 'spec-workflow');
    await fs.mkdir(targetPath, { recursive: true });

    const report = await auditSkill(entry, 'user', env);

    expect(report.state).toBe('present');
    expect(report.nature).toBe('skill');
  });

  it('returns present when target is a symlink', async () => {
    const entry: AdapterEntry = { id: 'skill:my-skill', nature: 'skill', scope: 'user' };
    const targets = resolveOpencodeUserTargets(env);
    const userSkillTarget = path.join(targets.skillsDir, 'my-skill');
    await fs.mkdir(path.dirname(userSkillTarget), { recursive: true });
    const srcDir = await makeSkillFixture(fixturesDir, 'my-skill');
    await fs.symlink(srcDir, userSkillTarget);

    const report = await auditSkill(entry, 'user', env);

    expect(report.state).toBe('present');
  });

  it('uses the opencode project target path for scope project', async () => {
    const cwd = tmp.dir;
    const entry: AdapterEntry = { id: 'skill:spec-workflow', nature: 'skill', scope: 'project' };
    const projectSkillDir = path.join(cwd, '.opencode', 'skills', 'spec-workflow');
    await fs.mkdir(projectSkillDir, { recursive: true });

    const report = await auditSkill(entry, 'project', env, cwd);

    expect(report.state).toBe('present');
  });
});

// ---------------------------------------------------------------------------
// planSkill
// ---------------------------------------------------------------------------

describe('planSkill', () => {
  it('returns one link op when skill is absent', async () => {
    const entry: AdapterEntry = { id: 'skill:spec-workflow', nature: 'skill', scope: 'user' };
    const srcDir = await makeSkillFixture(fixturesDir, 'spec-workflow');
    const skillSource = (_e: AdapterEntry) => srcDir;

    const ops = await planSkill(entry, 'user', env, skillSource);

    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('link');
  });

  it('link op has correct source, store (shared with Claude), and opencode target paths', async () => {
    const entry: AdapterEntry = { id: 'skill:spec-workflow', nature: 'skill', scope: 'user' };
    const srcDir = await makeSkillFixture(fixturesDir, 'spec-workflow');
    const skillSource = (_e: AdapterEntry) => srcDir;
    const sharedStore = resolveUserTargets(env);
    const opencodeTargets = resolveOpencodeUserTargets(env);

    const ops = await planSkill(entry, 'user', env, skillSource);
    const op = ops[0] as { kind: string; source: string; store: string; target: string };

    expect(op.source).toBe(srcDir);
    expect(op.store).toBe(path.join(sharedStore.skillsDir, 'spec-workflow'));
    expect(op.target).toBe(path.join(opencodeTargets.skillsDir, 'spec-workflow'));
  });

  it('returns empty array when skill is already present', async () => {
    const entry: AdapterEntry = { id: 'skill:spec-workflow', nature: 'skill', scope: 'user' };
    const srcDir = await makeSkillFixture(fixturesDir, 'spec-workflow');
    const skillSource = (_e: AdapterEntry) => srcDir;

    const targets = resolveOpencodeUserTargets(env);
    const targetPath = path.join(targets.skillsDir, 'spec-workflow');
    await fs.mkdir(targetPath, { recursive: true });

    const ops = await planSkill(entry, 'user', env, skillSource);

    expect(ops).toHaveLength(0);
  });

  it('uses opencode project target path for scope project, store stays shared/user-scope', async () => {
    const cwd = tmp.dir;
    const entry: AdapterEntry = { id: 'skill:my-skill', nature: 'skill', scope: 'project' };
    const srcDir = await makeSkillFixture(fixturesDir, 'my-skill');
    const skillSource = (_e: AdapterEntry) => srcDir;
    const sharedStore = resolveUserTargets(env);

    const ops = await planSkill(entry, 'project', env, skillSource, cwd);
    const op = ops[0] as { kind: string; source: string; store: string; target: string };

    // store is always user-scope (managed store, shared with Claude)
    expect(op.store).toBe(path.join(sharedStore.skillsDir, 'my-skill'));
    // target is opencode project-scope
    expect(op.target).toBe(
      path.join(resolveOpencodeProjectTargets(cwd).skillsDir, 'my-skill'),
    );
  });
});

// ---------------------------------------------------------------------------
// applySkill
// ---------------------------------------------------------------------------

describe('applySkill', () => {
  it('syncs source to store and creates symlink at the opencode target', async () => {
    const entry: AdapterEntry = { id: 'skill:spec-workflow', nature: 'skill', scope: 'user' };
    const srcDir = await makeSkillFixture(fixturesDir, 'spec-workflow');
    const skillSource = (_e: AdapterEntry) => srcDir;
    const scanner = makeSpyScanner();

    const ops = await planSkill(entry, 'user', env, skillSource);
    await applySkill(ops, env, scanner);

    const targets = resolveOpencodeUserTargets(env);
    const targetPath = path.join(targets.skillsDir, 'spec-workflow');
    const skillMd = await fs.readFile(path.join(targetPath, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('spec-workflow');
  });

  it('calls scanner with the source path', async () => {
    const entry: AdapterEntry = { id: 'skill:spec-workflow', nature: 'skill', scope: 'user' };
    const srcDir = await makeSkillFixture(fixturesDir, 'spec-workflow');
    const skillSource = (_e: AdapterEntry) => srcDir;
    const scanner = makeSpyScanner();

    const ops = await planSkill(entry, 'user', env, skillSource);
    await applySkill(ops, env, scanner);

    expect(scanner.calls).toHaveLength(1);
    expect(scanner.calls[0]).toBe(srcDir);
  });

  it('is idempotent: applying twice does not break the installation', async () => {
    const entry: AdapterEntry = { id: 'skill:spec-workflow', nature: 'skill', scope: 'user' };
    const srcDir = await makeSkillFixture(fixturesDir, 'spec-workflow');
    const skillSource = (_e: AdapterEntry) => srcDir;
    const scanner = makeSpyScanner();

    const ops = await planSkill(entry, 'user', env, skillSource);
    await applySkill(ops, env, scanner);
    await applySkill(ops, env, scanner);

    const targets = resolveOpencodeUserTargets(env);
    const targetPath = path.join(targets.skillsDir, 'spec-workflow');
    const skillMd = await fs.readFile(path.join(targetPath, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('spec-workflow');
  });

  it('the physical store is shared with Claude (same path under agent-rigger)', async () => {
    const entry: AdapterEntry = { id: 'skill:spec-workflow', nature: 'skill', scope: 'user' };
    const srcDir = await makeSkillFixture(fixturesDir, 'spec-workflow');
    const skillSource = (_e: AdapterEntry) => srcDir;
    const scanner = makeSpyScanner();

    const ops = await planSkill(entry, 'user', env, skillSource);
    await applySkill(ops, env, scanner);

    const sharedStore = resolveUserTargets(env);
    const storePath = path.join(sharedStore.skillsDir, 'spec-workflow');
    const skillMd = await fs.readFile(path.join(storePath, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('spec-workflow');
  });

  it('throws SkillScanBlockedError when scanner rejects the source', async () => {
    const entry: AdapterEntry = { id: 'skill:dangerous', nature: 'skill', scope: 'user' };
    const srcDir = await makeSkillFixture(fixturesDir, 'dangerous');
    const skillSource = (_e: AdapterEntry) => srcDir;
    const blockingScanner = makeSpyScanner({ ok: false, findings: ['malicious pattern detected'] });

    const ops = await planSkill(entry, 'user', env, skillSource);

    await expect(applySkill(ops, env, blockingScanner)).rejects.toThrow(SkillScanBlockedError);
  });

  it('does not install anything when scanner blocks', async () => {
    const entry: AdapterEntry = { id: 'skill:dangerous', nature: 'skill', scope: 'user' };
    const srcDir = await makeSkillFixture(fixturesDir, 'dangerous');
    const skillSource = (_e: AdapterEntry) => srcDir;
    const blockingScanner = makeSpyScanner({ ok: false, findings: ['malicious pattern detected'] });

    const ops = await planSkill(entry, 'user', env, skillSource);
    try {
      await applySkill(ops, env, blockingScanner);
    } catch {
      // expected
    }

    const targets = resolveOpencodeUserTargets(env);
    const targetPath = path.join(targets.skillsDir, 'dangerous');
    const exists = await fs.lstat(targetPath).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it('SkillScanBlockedError carries source and findings', async () => {
    const entry: AdapterEntry = { id: 'skill:dangerous', nature: 'skill', scope: 'user' };
    const srcDir = await makeSkillFixture(fixturesDir, 'dangerous');
    const skillSource = (_e: AdapterEntry) => srcDir;
    const blockingScanner = makeSpyScanner({ ok: false, findings: ['malicious pattern'] });

    const ops = await planSkill(entry, 'user', env, skillSource);
    let caught: unknown;
    try {
      await applySkill(ops, env, blockingScanner);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SkillScanBlockedError);
    const err = caught as SkillScanBlockedError;
    expect(err.source).toBe(srcDir);
    expect(err.findings).toContain('malicious pattern');
  });
});

// ---------------------------------------------------------------------------
// end-to-end via createOpencodeAdapter
// ---------------------------------------------------------------------------

describe('createOpencodeAdapter — skill end-to-end', () => {
  it('check missing → apply → check present → 2nd apply no-op', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'spec-workflow');
    const skillSource = (_e: AdapterEntry) => srcDir;
    const scanner = makeSpyScanner();

    const adapter = createOpencodeAdapter({
      skillSource,
      scanner,
    });

    const entry: AdapterEntry = { id: 'skill:spec-workflow', nature: 'skill', scope: 'user' };

    // 1. Initial check: missing
    const report1 = await adapter.audit(entry, 'user', env);
    expect(report1.state).toBe('missing');

    // 2. Plan + apply
    const ops = await adapter.plan(entry, 'user', env);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('link');
    await adapter.apply(ops, env);

    // 3. Post-apply check: present
    const report2 = await adapter.audit(entry, 'user', env);
    expect(report2.state).toBe('present');

    // 4. 2nd plan: no-op
    const ops2 = await adapter.plan(entry, 'user', env);
    expect(ops2).toHaveLength(0);
  });

  it('scanner is called during apply', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'my-skill');
    const skillSource = (_e: AdapterEntry) => srcDir;
    const scanner = makeSpyScanner();

    const adapter = createOpencodeAdapter({
      skillSource,
      scanner,
    });

    const entry: AdapterEntry = { id: 'skill:my-skill', nature: 'skill', scope: 'user' };
    const ops = await adapter.plan(entry, 'user', env);
    await adapter.apply(ops, env);

    expect(scanner.calls).toHaveLength(1);
    expect(scanner.calls[0]).toBe(srcDir);
  });
});
