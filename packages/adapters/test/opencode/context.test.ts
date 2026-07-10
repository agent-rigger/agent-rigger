/**
 * Tests for opencode/context handler (TDD — written before implementation).
 *
 * Covers:
 * - auditContext: nothing posed → missing; content matches → present; content diverges → drift.
 * - planContext: missing → 1 op (write-text) with correct path/content; present → [].
 * - planRemoveContext: not installed → []; installed → 1 op (delete-file).
 * - applyContext: writes AGENTS.md verbatim (no CLAUDE.md bridge — ADR-0007), idempotent.
 * - applyRemoveContext: deletes AGENTS.md, tolerant to absence.
 * - end-to-end via engine: createOpencodeAdapter with nature 'context' → check exits 3 → apply →
 *   check exits 0 → 2nd apply no-op.
 *
 * Isolation: every test uses a fresh RIGGER_HOME via makeTmpHome(). Never touches the real ~/.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply, check, reportExitCode } from '@agent-rigger/core/engine';
import { readText, writeText } from '@agent-rigger/core/fs-json';
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

async function makeTmpHome(prefix = 'rigger-opencode-context-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENTS_CONTENT = '# Agent Context\n\nThis is the canonical AGENTS.md content.\n';

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
// auditContext — user scope
// ---------------------------------------------------------------------------

describe('auditContext — user scope', () => {
  it('returns missing when nothing is posed', async () => {
    const report = await auditContext('user', env, AGENTS_CONTENT);

    expect(report.state).toBe('missing');
    expect(report.nature).toBe('context');
    expect(report.id).toBe('context-opencode');
  });

  it('returns present when AGENTS.md content matches the canonical content', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await fs.mkdir(path.dirname(targets.agentsMd), { recursive: true });
    await writeText(targets.agentsMd, AGENTS_CONTENT);

    const report = await auditContext('user', env, AGENTS_CONTENT);

    expect(report.state).toBe('present');
  });

  it('returns drift when AGENTS.md exists but its content diverges', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await fs.mkdir(path.dirname(targets.agentsMd), { recursive: true });
    await writeText(targets.agentsMd, 'a locally edited AGENTS.md\n');

    const report = await auditContext('user', env, AGENTS_CONTENT);

    expect(report.state).toBe('drift');
  });
});

// ---------------------------------------------------------------------------
// auditContext — project scope
// ---------------------------------------------------------------------------

describe('auditContext — project scope', () => {
  it('returns missing when nothing is posed', async () => {
    const cwd = tmp.dir;

    const report = await auditContext('project', env, AGENTS_CONTENT, cwd);

    expect(report.state).toBe('missing');
  });

  it('returns present when project AGENTS.md matches the canonical content', async () => {
    const cwd = tmp.dir;
    const targets = resolveOpencodeProjectTargets(cwd);
    await fs.mkdir(path.dirname(targets.agentsMd), { recursive: true });
    await writeText(targets.agentsMd, AGENTS_CONTENT);

    const report = await auditContext('project', env, AGENTS_CONTENT, cwd);

    expect(report.state).toBe('present');
  });

  it('returns drift when project AGENTS.md diverges', async () => {
    const cwd = tmp.dir;
    const targets = resolveOpencodeProjectTargets(cwd);
    await fs.mkdir(path.dirname(targets.agentsMd), { recursive: true });
    await writeText(targets.agentsMd, 'different content\n');

    const report = await auditContext('project', env, AGENTS_CONTENT, cwd);

    expect(report.state).toBe('drift');
  });
});

// ---------------------------------------------------------------------------
// planContext
// ---------------------------------------------------------------------------

describe('planContext', () => {
  it('returns 1 op (write-text) when artifact is missing', async () => {
    const ops = await planContext('user', env, AGENTS_CONTENT);

    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('write-text');
  });

  it('write-text op has correct path and content (user scope)', async () => {
    const targets = resolveOpencodeUserTargets(env);
    const ops = await planContext('user', env, AGENTS_CONTENT);

    const writeOp = ops[0] as WriteOpWriteText;
    expect(writeOp.path).toBe(targets.agentsMd);
    expect(writeOp.content).toBe(AGENTS_CONTENT);
  });

  it('returns [] when artifact is already present (user scope)', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await fs.mkdir(path.dirname(targets.agentsMd), { recursive: true });
    await writeText(targets.agentsMd, AGENTS_CONTENT);

    const ops = await planContext('user', env, AGENTS_CONTENT);

    expect(ops).toHaveLength(0);
  });

  it('returns 1 op (write-text) when drifted (re-poses canonical content)', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await fs.mkdir(path.dirname(targets.agentsMd), { recursive: true });
    await writeText(targets.agentsMd, 'drifted content\n');

    const ops = await planContext('user', env, AGENTS_CONTENT);

    expect(ops).toHaveLength(1);
    expect((ops[0] as WriteOpWriteText).content).toBe(AGENTS_CONTENT);
  });

  it('write-text op has correct path for project scope', async () => {
    const cwd = tmp.dir;
    const targets = resolveOpencodeProjectTargets(cwd);
    const ops = await planContext('project', env, AGENTS_CONTENT, cwd);

    const writeOp = ops[0] as WriteOpWriteText;
    expect(writeOp.path).toBe(targets.agentsMd);
    expect(writeOp.content).toBe(AGENTS_CONTENT);
  });
});

// ---------------------------------------------------------------------------
// planRemoveContext
// ---------------------------------------------------------------------------

describe('planRemoveContext', () => {
  it('returns [] when not installed', async () => {
    const ops = await planRemoveContext('user', env, AGENTS_CONTENT);

    expect(ops).toHaveLength(0);
  });

  it('returns [delete-file] when installed (content matches, non-empty)', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await fs.mkdir(path.dirname(targets.agentsMd), { recursive: true });
    await writeText(targets.agentsMd, AGENTS_CONTENT);

    const ops = await planRemoveContext('user', env, AGENTS_CONTENT);

    expect(ops).toEqual([{ kind: 'delete-file', path: targets.agentsMd }]);
  });

  it('returns a warning-only leave-alone op when AGENTS.md diverges (drift is conserved, never deleted or purged)', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await fs.mkdir(path.dirname(targets.agentsMd), { recursive: true });
    await writeText(targets.agentsMd, 'drifted content\n');

    const ops = await planRemoveContext('user', env, AGENTS_CONTENT);

    // Non-empty plan (leave-alone) so the engine conserves the manifest entry
    // instead of purging it (R1). The drifted file is never touched.
    expect(ops).toHaveLength(1);
    expect(ops[0]?.kind).toBe('leave-alone');
    expect((ops[0] as { target: string }).target).toBe(targets.agentsMd);
    expect((ops[0] as { warnings: string[] }).warnings.join('\n')).toContain('diverged');
    // The file is left untouched.
    expect(await readText(targets.agentsMd)).toBe('drifted content\n');
  });
});

// ---------------------------------------------------------------------------
// applyContext
// ---------------------------------------------------------------------------

describe('applyContext', () => {
  it('writes AGENTS.md with the exact canonical content', async () => {
    const targets = resolveOpencodeUserTargets(env);
    const ops = await planContext('user', env, AGENTS_CONTENT);

    await applyContext(ops, env);

    const written = await readText(targets.agentsMd);
    expect(written).toBe(AGENTS_CONTENT);
  });

  it('does not touch the Claude store (no CLAUDE.md / harness AGENTS.md bridge)', async () => {
    const ops = await planContext('user', env, AGENTS_CONTENT);

    await applyContext(ops, env);

    const claudeTargets = resolveUserTargets(env);
    const claudeMdExists = await fs.access(claudeTargets.claudeMd).then(() => true).catch(() =>
      false
    );
    expect(claudeMdExists).toBe(false);
  });

  it('is idempotent: applying twice produces the same content', async () => {
    const ops = await planContext('user', env, AGENTS_CONTENT);

    await applyContext(ops, env);
    await applyContext(ops, env);

    const targets = resolveOpencodeUserTargets(env);
    const written = await readText(targets.agentsMd);
    expect(written).toBe(AGENTS_CONTENT);
  });
});

// ---------------------------------------------------------------------------
// applyRemoveContext
// ---------------------------------------------------------------------------

describe('applyRemoveContext', () => {
  it('deletes the managed AGENTS.md file', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await fs.mkdir(path.dirname(targets.agentsMd), { recursive: true });
    await writeText(targets.agentsMd, AGENTS_CONTENT);

    await applyRemoveContext([{ kind: 'delete-file', path: targets.agentsMd }], env);

    const exists = await fs.access(targets.agentsMd).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it('is tolerant to an already-absent file', async () => {
    const targets = resolveOpencodeUserTargets(env);

    await expect(
      applyRemoveContext([{ kind: 'delete-file', path: targets.agentsMd }], env),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// end-to-end via engine
// ---------------------------------------------------------------------------

describe('OpencodeAdapter — context e2e via engine', () => {
  const CONTEXT_ENTRY: AdapterEntry = {
    id: 'context-opencode',
    nature: 'context',
    scope: 'user',
  };

  it('check exits 3 before apply (context missing)', async () => {
    const adapter = createOpencodeAdapter({ agentsContent: AGENTS_CONTENT });
    const report = await check(adapter, [CONTEXT_ENTRY], 'user', env);

    expect(reportExitCode(report)).toBe(3);
    expect(report.entries[0]!.state).toBe('missing');
  });

  it('check exits 0 after apply (context present)', async () => {
    const targets = resolveUserTargets(env);
    const adapter = createOpencodeAdapter({ agentsContent: AGENTS_CONTENT });

    await apply(adapter, [CONTEXT_ENTRY], 'user', env, targets.stateJson);
    const report = await check(adapter, [CONTEXT_ENTRY], 'user', env);

    expect(reportExitCode(report)).toBe(0);
    expect(report.entries[0]!.state).toBe('present');
  });

  it('2nd apply is a no-op (no files written)', async () => {
    const targets = resolveUserTargets(env);
    const adapter = createOpencodeAdapter({ agentsContent: AGENTS_CONTENT });

    await apply(adapter, [CONTEXT_ENTRY], 'user', env, targets.stateJson);
    const result2 = await apply(adapter, [CONTEXT_ENTRY], 'user', env, targets.stateJson);

    expect(result2.written).toHaveLength(0);
  });
});
