/**
 * End-to-end lifecycle tests for the opencode 'skill' nature, driven through the
 * REAL core engine (apply/check/remove) + the REAL createOpencodeAdapter — no
 * mocks or stubs. These add the dimensions that skills.test.ts does NOT cover:
 *
 *  - skills.test.ts drives the handlers/adapter DIRECTLY (planSkill/applySkill,
 *    adapter.plan/apply). Here every mutation flows through the engine, so the
 *    manifest (state.json) round-trip, plan→backup→apply→upsert ordering, and
 *    the engine's plan-empty idempotence guard are all exercised.
 *  - The H7 shared-store ref-count (ADR-0020 §3) is proven through the ENGINE
 *    remove path (engine.remove → adapter.applyRemove → applyRemoveSkill), with
 *    BOTH opencode scopes (user + project) AND a cross-assistant claude symlink
 *    referencing one physical store: removing every opencode reference must NOT
 *    delete a store that claude still points at; the final reference deletes it.
 *
 * skills.test.ts already covers: skillName guards, audit/plan unit behaviour,
 * scanner-block, and direct-handler ref-counting — none of that is repeated here.
 *
 * Note: 'skill' never merges into opencode.json (it is a store+symlink nature),
 * so the "third-party opencode.json content survives merge/remove" acceptance
 * dimension does not apply and is intentionally absent.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply, check, remove, reportExitCode } from '@agent-rigger/core/engine';
import { findEntry, readManifest } from '@agent-rigger/core/manifest';
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
import { applyRemoveSkill } from '../../src/opencode/skills';

// ---------------------------------------------------------------------------
// Helpers (inlined per opencode adapter test convention — no shared helper)
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-opencode-e2e-skill-'): Promise<{
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

/** Spy scanner that records the sources it is asked to scan. */
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

// Captured once at module load (the repo root). Guards against a chdir'd test
// leaving the process cwd inside a tmp dir that afterEach is about to delete.
const REPO_CWD = process.cwd();

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
  // Restore cwd BEFORE removing tmp, so a chdir'd project-scope test never
  // leaves the process inside a deleted directory (and never leaks cwd into the
  // next test file).
  process.chdir(REPO_CWD);
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// Full user-scope lifecycle through the engine (manifest round-trip)
// ---------------------------------------------------------------------------

describe('opencode skill — full lifecycle via engine (user scope)', () => {
  it('check(missing) → apply → check(present) → 2nd apply no-op → remove → check(missing)', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'e2e-demo');
    const scanner = makeSpyScanner();
    const adapter = createOpencodeAdapter({ skillSource: () => srcDir, scanner });
    const manifestPath = resolveUserTargets(env).stateJson;
    const entry: AdapterEntry = { id: 'skill:e2e-demo', nature: 'skill', scope: 'user' };

    const store = path.join(resolveUserTargets(env).skillsDir, 'e2e-demo');
    const target = path.join(resolveOpencodeUserTargets(env).skillsDir, 'e2e-demo');

    // 1. check before apply → missing (exit 3), no manifest entry yet.
    const before = await check(adapter, [entry], 'user', env, manifestPath);
    expect(reportExitCode(before)).toBe(3);
    expect(before.entries[0]!.state).toBe('missing');
    const m0 = await readManifest(manifestPath);
    expect(findEntry(m0, 'skill:e2e-demo', 'user', 'opencode')).toBeUndefined();

    // 2. apply → store filled, symlink created, scanner ran through the engine
    //    path, manifest entry recorded with the reversible 'link' payload.
    const applyResult = await apply(adapter, [entry], 'user', env, manifestPath);
    expect(applyResult.written).toContain(target);
    expect(scanner.calls).toEqual([srcDir]); // scan-before-install ran once
    expect(await exists(store)).toBe(true);
    expect(await exists(target)).toBe(true);
    // The symlink resolves to the store's content.
    const linkedMd = await fs.readFile(path.join(target, 'SKILL.md'), 'utf-8');
    expect(linkedMd).toContain('e2e-demo');

    const m1 = await readManifest(manifestPath);
    const record = findEntry(m1, 'skill:e2e-demo', 'user', 'opencode');
    expect(record).toBeDefined();
    expect(record!.nature).toBe('skill');
    expect(record!.files).toContain(target);
    expect(record!.applied).toEqual({ kind: 'link', files: [target] });

    // 3. check after apply → present (exit 0).
    const after = await check(adapter, [entry], 'user', env, manifestPath);
    expect(reportExitCode(after)).toBe(0);
    expect(after.entries[0]!.state).toBe('present');

    // 4. 2nd apply → idempotent no-op: nothing written, scanner not called again
    //    (a non-idempotent re-install would re-scan and re-write here).
    const scanCountBeforeSecondApply = scanner.calls.length;
    const apply2 = await apply(adapter, [entry], 'user', env, manifestPath);
    expect(apply2.written).toHaveLength(0);
    expect(scanner.calls.length).toBe(scanCountBeforeSecondApply);
    expect(await exists(target)).toBe(true);

    // 5. remove → symlink gone AND store gone (last reference), manifest cleared.
    const removeResult = await remove(adapter, [entry], 'user', env, manifestPath);
    expect(removeResult.removed).toContain('skill:e2e-demo');
    expect(await exists(target)).toBe(false);
    expect(await exists(store)).toBe(false);
    const m2 = await readManifest(manifestPath);
    expect(findEntry(m2, 'skill:e2e-demo', 'user', 'opencode')).toBeUndefined();

    // 6. check after remove → missing again (exit 3). A no-op remove would keep
    //    the symlink and fail this assertion.
    const gone = await check(adapter, [entry], 'user', env, manifestPath);
    expect(reportExitCode(gone)).toBe(3);
    expect(gone.entries[0]!.state).toBe('missing');

    // 7. remove again → idempotent no-op (nothing to remove).
    const removeAgain = await remove(adapter, [entry], 'user', env, manifestPath);
    expect(removeAgain.removed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// H7 shared-store ref-counting across scopes AND assistants via the engine
// ---------------------------------------------------------------------------

describe('opencode skill — shared-store ref-counting via engine (H7, ADR-0020 §3)', () => {
  it('user+project (opencode) + user (claude) share ONE store; removing every opencode reference keeps the store while claude references it; the final removal deletes it', async () => {
    // Make project scope resolve under the tmp home (the adapter derives the
    // project cwd from process.cwd()). Capture the realpath'd cwd so the
    // expected project target matches exactly what the adapter computes (on
    // macOS os.tmpdir() and the chdir'd cwd differ by the /private prefix).
    process.chdir(tmp.dir);
    const projectCwd = process.cwd();

    const srcDir = await makeSkillFixture(fixturesDir, 'shared');
    const scanner = makeSpyScanner();
    const skillSource = (_e: AdapterEntry) => srcDir;
    const adapter = createOpencodeAdapter({ skillSource, scanner });
    const manifestPath = resolveUserTargets(env).stateJson;

    const userEntry: AdapterEntry = { id: 'skill:shared', nature: 'skill', scope: 'user' };
    const projectEntry: AdapterEntry = { id: 'skill:shared', nature: 'skill', scope: 'project' };

    const store = path.join(resolveUserTargets(env).skillsDir, 'shared');
    const opencodeUserTarget = path.join(resolveOpencodeUserTargets(env).skillsDir, 'shared');
    const opencodeProjectTarget = path.join(
      resolveOpencodeProjectTargets(projectCwd).skillsDir,
      'shared',
    );
    const claudeUserTarget = path.join(tmp.dir, '.claude', 'skills', 'shared');

    // Install opencode user + project through the engine (real manifest round-trip).
    await apply(adapter, [userEntry], 'user', env, manifestPath);
    await apply(adapter, [projectEntry], 'project', env, manifestPath);
    // Add a claude reference to the SAME physical store. Not expressible via the
    // opencode adapter, so it is created through the claude handler — exactly one
    // more symlink onto the shared store, no new store.
    const claudeOps = await planClaudeSkill(userEntry, 'user', env, skillSource);
    await applyClaudeSkill(claudeOps, env, scanner);

    // All three symlinks resolve to the single store.
    expect(await exists(store)).toBe(true);
    for (const t of [opencodeUserTarget, opencodeProjectTarget, claudeUserTarget]) {
      expect(await exists(t)).toBe(true);
      const md = await fs.readFile(path.join(t, 'SKILL.md'), 'utf-8');
      expect(md).toContain('shared');
    }
    // The manifest tracks the two opencode scopes as independent records.
    const m1 = await readManifest(manifestPath);
    expect(findEntry(m1, 'skill:shared', 'user', 'opencode')).toBeDefined();
    expect(findEntry(m1, 'skill:shared', 'project', 'opencode')).toBeDefined();

    // Remove ONE scope (opencode project) via the engine → its symlink is gone,
    // but the store and the other two references survive.
    const rmProject = await remove(adapter, [projectEntry], 'project', env, manifestPath);
    expect(rmProject.removed).toContain('skill:shared');
    expect(await exists(opencodeProjectTarget)).toBe(false);
    expect(await exists(store)).toBe(true);
    expect(await exists(opencodeUserTarget)).toBe(true);
    expect(await exists(claudeUserTarget)).toBe(true);
    const m2 = await readManifest(manifestPath);
    expect(findEntry(m2, 'skill:shared', 'project', 'opencode')).toBeUndefined();
    expect(findEntry(m2, 'skill:shared', 'user', 'opencode')).toBeDefined();

    // Remove the LAST opencode reference (user) via the engine → opencode is
    // fully uninstalled, yet the store must SURVIVE because the claude symlink
    // still references it. This is the load-bearing cross-assistant ref-count
    // assertion routed through engine.remove → adapter.applyRemove.
    const rmUser = await remove(adapter, [userEntry], 'user', env, manifestPath);
    expect(rmUser.removed).toContain('skill:shared');
    expect(await exists(opencodeUserTarget)).toBe(false);
    expect(await exists(store)).toBe(true);
    const claudeMd = await fs.readFile(path.join(claudeUserTarget, 'SKILL.md'), 'utf-8');
    expect(claudeMd).toContain('shared');
    const m3 = await readManifest(manifestPath);
    expect(findEntry(m3, 'skill:shared', 'user', 'opencode')).toBeUndefined();
    expect(findEntry(m3, 'skill:shared', 'project', 'opencode')).toBeUndefined();

    // Remove the final reference (the claude symlink) → the store is deleted.
    const lastOp: RemovalOp = { kind: 'unlink', target: claudeUserTarget, store };
    await applyRemoveSkill([lastOp], env, projectCwd);
    expect(await exists(claudeUserTarget)).toBe(false);
    expect(await exists(store)).toBe(false);
  });
});
