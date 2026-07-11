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
 * - applyRemoveSkill: shared-store ref-counting (H7, ADR-0020 §3) — removing the
 *   opencode symlink never deletes a store still referenced by Claude; the store
 *   is deleted only with its last reference.
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
import type { RemovalOp, Verdict } from '@agent-rigger/core/types';

import {
  applySkill as applyClaudeSkill,
  planSkill as planClaudeSkill,
} from '../../src/claude/skills';
import { createOpencodeAdapter } from '../../src/opencode/adapter';
import {
  applyRemoveSkill,
  applySkill,
  auditSkill,
  planRemoveSkill,
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

/** True when `p` exists on disk (lstat: symlinks count even when dangling). */
const exists = (p: string) => fs.lstat(p).then(() => true).catch(() => false);

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

  it('returns present when target is a symlink to the shared rigger store', async () => {
    const entry: AdapterEntry = { id: 'skill:my-skill', nature: 'skill', scope: 'user' };
    const store = path.join(resolveUserTargets(env).skillsDir, 'my-skill');
    await fs.mkdir(store, { recursive: true });
    await fs.writeFile(path.join(store, 'SKILL.md'), '# my-skill');
    const targets = resolveOpencodeUserTargets(env);
    const userSkillTarget = path.join(targets.skillsDir, 'my-skill');
    await fs.mkdir(path.dirname(userSkillTarget), { recursive: true });
    await fs.symlink(store, userSkillTarget);

    const report = await auditSkill(entry, 'user', env);

    expect(report.state).toBe('present');
    expect(report.nature).toBe('skill');
  });

  it('lot2-R3: returns present for a plain directory byte-identical to the store (copy fallback)', async () => {
    const entry: AdapterEntry = { id: 'skill:spec-workflow', nature: 'skill', scope: 'user' };
    const store = path.join(resolveUserTargets(env).skillsDir, 'spec-workflow');
    await fs.mkdir(store, { recursive: true });
    await fs.writeFile(path.join(store, 'SKILL.md'), '# spec-workflow');
    const targets = resolveOpencodeUserTargets(env);
    const targetPath = path.join(targets.skillsDir, 'spec-workflow');
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.cp(store, targetPath, { recursive: true });

    const report = await auditSkill(entry, 'user', env);

    expect(report.state).toBe('present');
  });

  it('lot2-R3: returns drift for a real directory that does not match the store', async () => {
    const entry: AdapterEntry = { id: 'skill:spec-workflow', nature: 'skill', scope: 'user' };
    const targets = resolveOpencodeUserTargets(env);
    const targetPath = path.join(targets.skillsDir, 'spec-workflow');
    await fs.mkdir(targetPath, { recursive: true });
    await fs.writeFile(path.join(targetPath, 'HANDMADE.md'), 'user work');

    const report = await auditSkill(entry, 'user', env);

    expect(report.state).toBe('drift');
    expect(report.detail).toContain(targetPath);
  });

  it('lot2-R3: returns drift for a symlink pointing outside the rigger store', async () => {
    const entry: AdapterEntry = { id: 'skill:my-skill', nature: 'skill', scope: 'user' };
    const targets = resolveOpencodeUserTargets(env);
    const userSkillTarget = path.join(targets.skillsDir, 'my-skill');
    await fs.mkdir(path.dirname(userSkillTarget), { recursive: true });
    const srcDir = await makeSkillFixture(fixturesDir, 'my-skill');
    await fs.symlink(srcDir, userSkillTarget);

    const report = await auditSkill(entry, 'user', env);

    expect(report.state).toBe('drift');
  });

  it('uses the opencode project target path for scope project', async () => {
    const cwd = tmp.dir;
    const entry: AdapterEntry = { id: 'skill:spec-workflow', nature: 'skill', scope: 'project' };
    const store = path.join(resolveUserTargets(env).skillsDir, 'spec-workflow');
    await fs.mkdir(store, { recursive: true });
    await fs.writeFile(path.join(store, 'SKILL.md'), '# spec-workflow');
    const projectSkillTarget = path.join(cwd, '.opencode', 'skills', 'spec-workflow');
    await fs.mkdir(path.dirname(projectSkillTarget), { recursive: true });
    await fs.symlink(store, projectSkillTarget);

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
    expect(await exists(targetPath)).toBe(false);
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
// applyRemoveSkill — shared store ref-counting (H7, ADR-0020 §3)
// ---------------------------------------------------------------------------

describe('applyRemoveSkill: shared store ref-counting', () => {
  it('removing the opencode skill keeps the store and the Claude symlink alive; removing the last reference deletes the store', async () => {
    const entry: AdapterEntry = { id: 'skill:spec-workflow', nature: 'skill', scope: 'user' };
    const srcDir = await makeSkillFixture(fixturesDir, 'spec-workflow');
    const skillSource = (_e: AdapterEntry) => srcDir;
    const scanner = makeSpyScanner();

    // Install the SAME skill for opencode and for claude (shared store).
    const opencodeOps = await planSkill(entry, 'user', env, skillSource);
    await applySkill(opencodeOps, env, scanner);
    const claudeOps = await planClaudeSkill(entry, 'user', env, skillSource);
    await applyClaudeSkill(claudeOps, env, scanner);

    const store = path.join(resolveUserTargets(env).skillsDir, 'spec-workflow');
    const opencodeTarget = path.join(resolveOpencodeUserTargets(env).skillsDir, 'spec-workflow');
    const claudeTarget = path.join(tmp.dir, '.claude', 'skills', 'spec-workflow');
    expect(await exists(opencodeTarget)).toBe(true);
    expect(await exists(claudeTarget)).toBe(true);

    // Remove the opencode install only.
    const removeOps = await planRemoveSkill(entry, 'user', env);
    await applyRemoveSkill(removeOps, env);

    // opencode symlink gone, but store survives and the claude symlink still resolves.
    expect(await exists(opencodeTarget)).toBe(false);
    expect(await exists(store)).toBe(true);
    const claudeSkillMd = await fs.readFile(path.join(claudeTarget, 'SKILL.md'), 'utf-8');
    expect(claudeSkillMd).toContain('spec-workflow');

    // Remove the last reference (claude symlink) → store is deleted.
    const lastRemoveOp: RemovalOp = { kind: 'unlink', target: claudeTarget, store };
    await applyRemoveSkill([lastRemoveOp], env);

    expect(await exists(claudeTarget)).toBe(false);
    expect(await exists(store)).toBe(false);
  });

  it('removing the only install deletes the store (last reference)', async () => {
    const entry: AdapterEntry = { id: 'skill:solo', nature: 'skill', scope: 'user' };
    const srcDir = await makeSkillFixture(fixturesDir, 'solo');
    const skillSource = (_e: AdapterEntry) => srcDir;
    const scanner = makeSpyScanner();

    const ops = await planSkill(entry, 'user', env, skillSource);
    await applySkill(ops, env, scanner);

    const removeOps = await planRemoveSkill(entry, 'user', env);
    await applyRemoveSkill(removeOps, env);

    const store = path.join(resolveUserTargets(env).skillsDir, 'solo');
    const target = path.join(resolveOpencodeUserTargets(env).skillsDir, 'solo');
    expect(await exists(target)).toBe(false);
    expect(await exists(store)).toBe(false);
  });

  it('project-scope removal keeps the store while the user-scope symlink still references it', async () => {
    const cwd = tmp.dir;
    const userEntry: AdapterEntry = { id: 'skill:dual', nature: 'skill', scope: 'user' };
    const projectEntry: AdapterEntry = { id: 'skill:dual', nature: 'skill', scope: 'project' };
    const srcDir = await makeSkillFixture(fixturesDir, 'dual');
    const skillSource = (_e: AdapterEntry) => srcDir;
    const scanner = makeSpyScanner();

    const userOps = await planSkill(userEntry, 'user', env, skillSource);
    await applySkill(userOps, env, scanner);
    const projectOps = await planSkill(projectEntry, 'project', env, skillSource, cwd);
    await applySkill(projectOps, env, scanner);

    const removeOps = await planRemoveSkill(projectEntry, 'project', env, cwd);
    await applyRemoveSkill(removeOps, env, cwd);

    const store = path.join(resolveUserTargets(env).skillsDir, 'dual');
    const projectTarget = path.join(resolveOpencodeProjectTargets(cwd).skillsDir, 'dual');
    const userTarget = path.join(resolveOpencodeUserTargets(env).skillsDir, 'dual');
    expect(await exists(projectTarget)).toBe(false);
    expect(await exists(userTarget)).toBe(true);
    expect(await exists(store)).toBe(true);
  });

  it('plugin-style unlink ops (store outside the skills dir) still remove target and store', async () => {
    // Plugin removal shares the 'unlink' op kind and applyRemoveSkill; its store
    // lives under ~/.config/agent-rigger/plugins/ which no skill candidate ever
    // references — behavior must stay "remove target + store".
    const pluginStore = path.join(
      path.dirname(resolveUserTargets(env).skillsDir),
      'plugins',
      'notify.ts',
    );
    await fs.mkdir(path.dirname(pluginStore), { recursive: true });
    await fs.writeFile(pluginStore, 'export const plugin = {};', 'utf-8');

    const pluginTarget = path.join(resolveOpencodeUserTargets(env).pluginDir, 'notify.ts');
    await fs.mkdir(path.dirname(pluginTarget), { recursive: true });
    await fs.symlink(pluginStore, pluginTarget);

    const op: RemovalOp = { kind: 'unlink', target: pluginTarget, store: pluginStore };
    await applyRemoveSkill([op], env);

    expect(await exists(pluginTarget)).toBe(false);
    expect(await exists(pluginStore)).toBe(false);
  });

  it('tolerates absent target and store (idempotent removal)', async () => {
    const op: RemovalOp = {
      kind: 'unlink',
      target: path.join(tmp.dir, 'nonexistent', 'target'),
      store: path.join(tmp.dir, 'nonexistent', 'store'),
    };

    await expect(applyRemoveSkill([op], env)).resolves.toBeUndefined();
    await expect(applyRemoveSkill([op], env)).resolves.toBeUndefined();
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
