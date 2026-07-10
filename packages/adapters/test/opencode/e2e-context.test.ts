/**
 * End-to-end lifecycle test for the opencode 'context' nature (AGENTS.md, write-text).
 *
 * Complements context.test.ts (which unit-tests each handler in isolation) by
 * driving the FULL sequential lifecycle through the REAL handlers / engine —
 * never mocks. The dimensions added here (not present in context.test.ts):
 *
 *  1. Continuous lifecycle at USER scope via the direct handlers:
 *     audit→missing → plan+apply → audit→present → plan again→[] (idempotent)
 *     → planRemove+applyRemove → audit→missing (file physically gone).
 *  2. The same continuous lifecycle at PROJECT scope (explicit cwd = tmp dir).
 *  3. Pre-existing user-authored AGENTS.md: the REAL guarantee the opencode
 *     context handler makes for a file it did not write. opencode owns AGENTS.md
 *     wholesale (ADR-0007) — there is NO managed block wrapped around user
 *     content. So the honest, load-bearing guarantees are:
 *       - audit reports 'drift' (never claims 'present' over foreign content);
 *       - planContext produces a WHOLE-FILE replacement that does not embed the
 *         user's bytes (proving there is no user/managed merge region);
 *       - planRemove returns [] for a diverged file, so applyRemove leaves the
 *         user's content byte-for-byte intact — "the user's own content is not
 *         destroyed on remove".
 *  4. Engine round-trip at USER scope: apply → manifest entry recorded (applied
 *     context payload, assistant 'opencode', file tracked) → check exits 0 →
 *     remove → manifest entry gone, file gone, check exits 3.
 *
 * Isolation: every test uses a fresh RIGGER_HOME via makeTmpHome() (user scope)
 * and the tmp dir itself as cwd (project scope). Never touches the real ~/ and
 * never writes to the real repo cwd.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply, check, remove, reportExitCode } from '@agent-rigger/core/engine';
import { readText, writeText } from '@agent-rigger/core/fs-json';
import { findEntry, readManifest } from '@agent-rigger/core/manifest';
import {
  resolveOpencodeProjectTargets,
  resolveOpencodeUserTargets,
  resolveUserTargets,
} from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { WriteOpWriteText } from '@agent-rigger/core/types';

import { createOpencodeAdapter } from '../../src/opencode/adapter';
import {
  applyContext,
  applyRemoveContext,
  auditContext,
  planContext,
  planRemoveContext,
} from '../../src/opencode/context';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-opencode-e2e-context-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

async function fileExists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Canonical, agent-rigger-managed AGENTS.md content. */
const CANONICAL =
  '# Managed AGENTS.md\n\nCanonical opencode agent context (managed by agent-rigger).\n';

/** Content a human wrote by hand BEFORE agent-rigger ever ran. Distinct from CANONICAL. */
const USER_AUTHORED = '# My Project\n\nHand-written agent notes the user owns.\nDo not delete.\n';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// Full lifecycle via direct handlers — user scope
// ---------------------------------------------------------------------------

describe('opencode context e2e — full lifecycle at user scope', () => {
  it('audit→missing → apply → audit→present → idempotent → remove → audit→missing', async () => {
    const agentsMd = resolveOpencodeUserTargets(env).agentsMd;

    // 1. Nothing posed yet.
    expect((await auditContext('user', env, CANONICAL)).state).toBe('missing');
    expect(await fileExists(agentsMd)).toBe(false);

    // 2. Plan + apply installs the canonical AGENTS.md verbatim.
    const installOps = await planContext('user', env, CANONICAL);
    expect(installOps).toHaveLength(1);
    expect(installOps[0]!.kind).toBe('write-text');
    await applyContext(installOps, env);

    // 3. Now present, on disk, with the exact canonical bytes.
    expect((await auditContext('user', env, CANONICAL)).state).toBe('present');
    expect(await readText(agentsMd)).toBe(CANONICAL);

    // 4. Idempotence: a second plan is empty, and re-applying the (empty) plan
    //    leaves the content untouched. A no-op install must NOT re-emit an op.
    expect(await planContext('user', env, CANONICAL)).toHaveLength(0);
    await applyContext(await planContext('user', env, CANONICAL), env);
    expect(await readText(agentsMd)).toBe(CANONICAL);

    // 5. Remove: planRemove yields exactly the managed delete, applyRemove runs it.
    const removeOps = await planRemoveContext('user', env, CANONICAL);
    expect(removeOps).toEqual([{ kind: 'delete-file', path: agentsMd }]);
    await applyRemoveContext(removeOps, env);

    // 6. Back to missing — the file is physically gone (so a no-op remove fails here).
    expect((await auditContext('user', env, CANONICAL)).state).toBe('missing');
    expect(await fileExists(agentsMd)).toBe(false);

    // 7. planRemove after removal is a no-op (idempotent uninstall).
    expect(await planRemoveContext('user', env, CANONICAL)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle via direct handlers — project scope
// ---------------------------------------------------------------------------

describe('opencode context e2e — full lifecycle at project scope', () => {
  it('audit→missing → apply → audit→present → idempotent → remove → audit→missing', async () => {
    // Project scope is isolated by using the tmp dir itself as the cwd, so the
    // artifact lands at <tmp>/AGENTS.md — never the real repo AGENTS.md.
    const cwd = tmp.dir;
    const agentsMd = resolveOpencodeProjectTargets(cwd).agentsMd;

    // 1. Missing.
    expect((await auditContext('project', env, CANONICAL, cwd)).state).toBe('missing');
    expect(await fileExists(agentsMd)).toBe(false);

    // 2. Plan targets the project-root AGENTS.md, then apply writes it.
    const installOps = await planContext('project', env, CANONICAL, cwd);
    expect(installOps).toHaveLength(1);
    expect((installOps[0] as WriteOpWriteText).path).toBe(agentsMd);
    await applyContext(installOps, env);

    // 3. Present with canonical bytes.
    expect((await auditContext('project', env, CANONICAL, cwd)).state).toBe('present');
    expect(await readText(agentsMd)).toBe(CANONICAL);

    // 4. Idempotent second plan.
    expect(await planContext('project', env, CANONICAL, cwd)).toHaveLength(0);

    // 5. Remove.
    const removeOps = await planRemoveContext('project', env, CANONICAL, cwd);
    expect(removeOps).toEqual([{ kind: 'delete-file', path: agentsMd }]);
    await applyRemoveContext(removeOps, env);

    // 6. Missing again, file gone.
    expect((await auditContext('project', env, CANONICAL, cwd)).state).toBe('missing');
    expect(await fileExists(agentsMd)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pre-existing user-authored AGENTS.md — real whole-file guarantees (ADR-0007)
// ---------------------------------------------------------------------------

describe('opencode context e2e — pre-existing user-authored AGENTS.md', () => {
  it('audits a foreign AGENTS.md as drift (never silently claims present)', async () => {
    const agentsMd = resolveOpencodeUserTargets(env).agentsMd;
    await fs.mkdir(path.dirname(agentsMd), { recursive: true });
    await writeText(agentsMd, USER_AUTHORED);

    const report = await auditContext('user', env, CANONICAL);

    expect(report.state).toBe('drift');
    // The handler must not confuse foreign content with an install or an absence.
    expect(report.state).not.toBe('present');
    expect(report.state).not.toBe('missing');
  });

  it('plans a WHOLE-FILE replacement — no managed block wrapped around user bytes', async () => {
    const agentsMd = resolveOpencodeUserTargets(env).agentsMd;
    await fs.mkdir(path.dirname(agentsMd), { recursive: true });
    await writeText(agentsMd, USER_AUTHORED);

    const ops = await planContext('user', env, CANONICAL);

    // opencode owns AGENTS.md wholesale (ADR-0007): the drift-repair op replaces
    // the entire file with canonical content and does NOT embed the user's bytes
    // (there is no user/managed merge region). This assertion fails the moment
    // anyone reintroduces a Claude-style managed-block-around-user-content model.
    expect(ops).toHaveLength(1);
    const writeOp = ops[0] as WriteOpWriteText;
    expect(writeOp.content).toBe(CANONICAL);
    expect(writeOp.content.includes(USER_AUTHORED)).toBe(false);
  });

  it("does not destroy the user's own content on remove (planRemove leaves a foreign file alone)", async () => {
    const agentsMd = resolveOpencodeUserTargets(env).agentsMd;
    await fs.mkdir(path.dirname(agentsMd), { recursive: true });
    await writeText(agentsMd, USER_AUTHORED);

    // Remove must refuse to touch a file whose content it did not author: the
    // plan is a warning-only leave-alone op (never delete-file), so applyRemove
    // is a no-op on disk and the user's bytes survive exactly. The leave-alone
    // (vs an empty plan) is what stops the engine purging the manifest entry and
    // leaving the drift untracked (R1). A regression that deleted unrecognized
    // content — or emitted a delete-file — would fail here.
    const removeOps = await planRemoveContext('user', env, CANONICAL);
    expect(removeOps).toHaveLength(1);
    expect(removeOps[0]?.kind).toBe('leave-alone');

    await applyRemoveContext(removeOps, env);

    expect(await fileExists(agentsMd)).toBe(true);
    expect(await readText(agentsMd)).toBe(USER_AUTHORED);
  });
});

// ---------------------------------------------------------------------------
// Engine round-trip — user scope (apply / check / remove + manifest)
// ---------------------------------------------------------------------------

describe('opencode context e2e — engine round-trip at user scope', () => {
  const CONTEXT_ENTRY: AdapterEntry = {
    id: 'context-opencode',
    nature: 'context',
    scope: 'user',
  };

  it('apply records the manifest entry and file; remove clears both (check 0 → 3)', async () => {
    const stateJson = resolveUserTargets(env).stateJson;
    const agentsMd = resolveOpencodeUserTargets(env).agentsMd;
    const adapter = createOpencodeAdapter({ agentsContent: CANONICAL });

    // --- install via engine ------------------------------------------------
    await apply(adapter, [CONTEXT_ENTRY], 'user', env, stateJson);

    // File written with canonical content.
    expect(await readText(agentsMd)).toBe(CANONICAL);

    // check (manifest-aware) reports present → exit 0.
    const afterInstall = await check(adapter, [CONTEXT_ENTRY], 'user', env, stateJson);
    expect(reportExitCode(afterInstall)).toBe(0);
    expect(afterInstall.entries[0]!.state).toBe('present');

    // Manifest records the install: opencode assistant, context payload, tracked file.
    const manifest = await readManifest(stateJson);
    const entry = findEntry(manifest, 'context-opencode', 'user', 'opencode');
    expect(entry).toBeDefined();
    expect(entry!.assistant).toBe('opencode');
    expect(entry!.nature).toBe('context');
    expect(entry!.applied).toEqual({ kind: 'context', block: CANONICAL });
    expect(entry!.files).toContain(agentsMd);
    // The claude-keyed lookup must NOT match this opencode install (identity is
    // (id, scope, assistant)).
    expect(findEntry(manifest, 'context-opencode', 'user', 'claude')).toBeUndefined();

    // --- uninstall via engine ---------------------------------------------
    const removeResult = await remove(adapter, [CONTEXT_ENTRY], 'user', env, stateJson);
    expect(removeResult.removed).toContain('context-opencode');

    // File gone.
    expect(await fileExists(agentsMd)).toBe(false);

    // Manifest entry gone.
    const manifestAfter = await readManifest(stateJson);
    expect(findEntry(manifestAfter, 'context-opencode', 'user', 'opencode')).toBeUndefined();

    // check now reports missing → exit 3 (so a no-op remove would fail here).
    const afterRemove = await check(adapter, [CONTEXT_ENTRY], 'user', env, stateJson);
    expect(reportExitCode(afterRemove)).toBe(3);
    expect(afterRemove.entries[0]!.state).toBe('missing');
  });
});
