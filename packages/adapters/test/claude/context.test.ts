/**
 * Tests for claude/context handler (TDD — written before implementation).
 *
 * Covers:
 * - loadCanonicalContext: reads AGENTS.md fixture.
 * - auditContext: nothing posed → missing; all correct → present; AGENTS.md ok but CLAUDE.md without block → missing.
 * - planContext: missing → 2 ops (write-text + ensure-import) with correct paths/content/importLine; complete → [].
 * - applyContext: places AGENTS.md (exact content) + adds managed block to CLAUDE.md while preserving existing content; idempotent.
 * - end-to-end via engine: createClaudeAdapter with nature 'context' → check exits 3 → apply → check exits 0 → 2nd apply no-op.
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
import { resolveProjectTargets, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { WriteOpEnsureImport, WriteOpWriteText } from '@agent-rigger/core/types';

import { createClaudeAdapter } from '../../src/claude/adapter';
import {
  applyContext,
  auditContext,
  loadCanonicalContext,
  planContext,
} from '../../src/claude/context';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-context-'): Promise<{
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
// loadCanonicalContext
// ---------------------------------------------------------------------------

describe('loadCanonicalContext', () => {
  it('reads the content of the AGENTS.md file', async () => {
    const agentsMdPath = path.join(tmp.dir, 'AGENTS.md');
    await writeText(agentsMdPath, AGENTS_CONTENT);

    const result = await loadCanonicalContext(agentsMdPath);

    expect(result).toBe(AGENTS_CONTENT);
  });

  it("returns '' when the file does not exist", async () => {
    const agentsMdPath = path.join(tmp.dir, 'nonexistent', 'AGENTS.md');

    const result = await loadCanonicalContext(agentsMdPath);

    expect(result).toBe('');
  });
});

// ---------------------------------------------------------------------------
// auditContext — user scope
// ---------------------------------------------------------------------------

describe('auditContext — user scope', () => {
  it('returns missing when nothing is posed', async () => {
    const report = await auditContext('user', env, AGENTS_CONTENT);

    expect(report.state).toBe('missing');
    expect(report.nature).toBe('context');
    expect(report.id).toBe('context-claude');
  });

  it('returns missing when AGENTS.md is present but CLAUDE.md has no managed block', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.agentsMd), { recursive: true });
    await writeText(targets.agentsMd, AGENTS_CONTENT);
    // CLAUDE.md exists but without the managed import block
    await fs.mkdir(path.dirname(targets.claudeMd), { recursive: true });
    await writeText(targets.claudeMd, '# My config\n');

    const report = await auditContext('user', env, AGENTS_CONTENT);

    expect(report.state).toBe('missing');
  });

  it('returns drift when AGENTS.md content differs from canonical', async () => {
    // Inverted knowingly by lot2-remove-reversible R6: divergent content was
    // reported 'missing', which invited a re-install that overwrote the
    // user's work. It is now 'drift' (three-state audit, exit code unchanged).
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.agentsMd), { recursive: true });
    await writeText(targets.agentsMd, 'different content\n');
    await fs.mkdir(path.dirname(targets.claudeMd), { recursive: true });
    await writeText(
      targets.claudeMd,
      '<!-- BEGIN agent-rigger (managed — do not edit) -->\n@~/.claude/harness/AGENTS.md\n<!-- END agent-rigger -->\n',
    );

    const report = await auditContext('user', env, AGENTS_CONTENT);

    expect(report.state).toBe('drift');
  });

  it('returns present when AGENTS.md content matches and CLAUDE.md has the managed block', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.agentsMd), { recursive: true });
    await writeText(targets.agentsMd, AGENTS_CONTENT);
    await fs.mkdir(path.dirname(targets.claudeMd), { recursive: true });
    await writeText(
      targets.claudeMd,
      '# My config\n\n<!-- BEGIN agent-rigger (managed — do not edit) -->\n@~/.claude/harness/AGENTS.md\n<!-- END agent-rigger -->\n',
    );

    const report = await auditContext('user', env, AGENTS_CONTENT);

    expect(report.state).toBe('present');
    expect(report.id).toBe('context-claude');
    expect(report.nature).toBe('context');
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

  it('returns present when project targets are correctly set up', async () => {
    const cwd = tmp.dir;
    const targets = resolveProjectTargets(cwd);
    await fs.mkdir(path.dirname(targets.agentsMd), { recursive: true });
    await writeText(targets.agentsMd, AGENTS_CONTENT);
    await fs.mkdir(path.dirname(targets.claudeMd), { recursive: true });
    await writeText(
      targets.claudeMd,
      '<!-- BEGIN agent-rigger (managed — do not edit) -->\n@../AGENTS.md\n<!-- END agent-rigger -->\n',
    );

    const report = await auditContext('project', env, AGENTS_CONTENT, cwd);

    expect(report.state).toBe('present');
  });
});

// ---------------------------------------------------------------------------
// planContext
// ---------------------------------------------------------------------------

describe('planContext', () => {
  it('returns 2 ops (write-text + ensure-import) when artifact is missing', async () => {
    const ops = await planContext('user', env, AGENTS_CONTENT);

    expect(ops).toHaveLength(2);
    expect(ops[0]!.kind).toBe('write-text');
    expect(ops[1]!.kind).toBe('ensure-import');
  });

  it('write-text op has correct path and content (user scope)', async () => {
    const targets = resolveUserTargets(env);
    const ops = await planContext('user', env, AGENTS_CONTENT);

    const writeOp = ops[0] as WriteOpWriteText;
    expect(writeOp.path).toBe(targets.agentsMd);
    expect(writeOp.content).toBe(AGENTS_CONTENT);
  });

  it('ensure-import op has correct path and importLine with ~ form (user scope)', async () => {
    const targets = resolveUserTargets(env);
    const ops = await planContext('user', env, AGENTS_CONTENT);

    const importOp = ops[1] as WriteOpEnsureImport;
    expect(importOp.path).toBe(targets.claudeMd);
    expect(importOp.importLine).toBe('@~/.claude/harness/AGENTS.md');
  });

  it('returns [] when artifact is already fully present (user scope)', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.agentsMd), { recursive: true });
    await writeText(targets.agentsMd, AGENTS_CONTENT);
    await fs.mkdir(path.dirname(targets.claudeMd), { recursive: true });
    await writeText(
      targets.claudeMd,
      '<!-- BEGIN agent-rigger (managed — do not edit) -->\n@~/.claude/harness/AGENTS.md\n<!-- END agent-rigger -->\n',
    );

    const ops = await planContext('user', env, AGENTS_CONTENT);

    expect(ops).toHaveLength(0);
  });

  it('write-text op has correct path for project scope', async () => {
    const cwd = tmp.dir;
    const targets = resolveProjectTargets(cwd);
    const ops = await planContext('project', env, AGENTS_CONTENT, cwd);

    const writeOp = ops[0] as WriteOpWriteText;
    expect(writeOp.path).toBe(targets.agentsMd);
  });

  it('ensure-import op has relative importLine for project scope', async () => {
    const cwd = tmp.dir;
    const targets = resolveProjectTargets(cwd);
    const ops = await planContext('project', env, AGENTS_CONTENT, cwd);

    const importOp = ops[1] as WriteOpEnsureImport;
    expect(importOp.path).toBe(targets.claudeMd);
    // importLine must be relative from CLAUDE.md dir to AGENTS.md
    expect(importOp.importLine).toBe('@../AGENTS.md');
  });
});

// ---------------------------------------------------------------------------
// applyContext
// ---------------------------------------------------------------------------

describe('applyContext', () => {
  it('writes AGENTS.md with exact canonical content', async () => {
    const targets = resolveUserTargets(env);
    const ops = await planContext('user', env, AGENTS_CONTENT);

    await applyContext(ops, env);

    const written = await readText(targets.agentsMd);
    expect(written).toBe(AGENTS_CONTENT);
  });

  it('adds managed block to CLAUDE.md', async () => {
    const targets = resolveUserTargets(env);
    const ops = await planContext('user', env, AGENTS_CONTENT);

    await applyContext(ops, env);

    const claudeMd = await readText(targets.claudeMd);
    expect(claudeMd).toContain('<!-- BEGIN agent-rigger (managed — do not edit) -->');
    expect(claudeMd).toContain('@~/.claude/harness/AGENTS.md');
    expect(claudeMd).toContain('<!-- END agent-rigger -->');
  });

  it('preserves existing user content in CLAUDE.md', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeMd), { recursive: true });
    await writeText(targets.claudeMd, '# My existing config\n@OTHER.md\n');

    const ops = await planContext('user', env, AGENTS_CONTENT);
    await applyContext(ops, env);

    const claudeMd = await readText(targets.claudeMd);
    expect(claudeMd).toContain('# My existing config');
    expect(claudeMd).toContain('@OTHER.md');
    expect(claudeMd).toContain('@~/.claude/harness/AGENTS.md');
  });

  it('is idempotent: applying twice does not add a second managed block', async () => {
    const ops = await planContext('user', env, AGENTS_CONTENT);

    await applyContext(ops, env);
    await applyContext(ops, env);

    const targets = resolveUserTargets(env);
    const claudeMd = await readText(targets.claudeMd);
    const occurrences = claudeMd.split('<!-- BEGIN agent-rigger (managed — do not edit) -->').length
      - 1;
    expect(occurrences).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// end-to-end via engine
// ---------------------------------------------------------------------------

describe('ClaudeAdapter — context e2e via engine', () => {
  const CONTEXT_ENTRY: AdapterEntry = {
    id: 'context-claude',
    nature: 'context',
    scope: 'user',
  };

  it('check exits 3 before apply (context missing)', async () => {
    const adapter = createClaudeAdapter({ denyRef: [], agentsContent: AGENTS_CONTENT });
    const report = await check(adapter, [CONTEXT_ENTRY], 'user', env);

    expect(reportExitCode(report)).toBe(3);
    expect(report.entries[0]!.state).toBe('missing');
  });

  it('check exits 0 after apply (context present)', async () => {
    const targets = resolveUserTargets(env);
    const adapter = createClaudeAdapter({ denyRef: [], agentsContent: AGENTS_CONTENT });

    await apply(adapter, [CONTEXT_ENTRY], 'user', env, targets.stateJson);
    const report = await check(adapter, [CONTEXT_ENTRY], 'user', env);

    expect(reportExitCode(report)).toBe(0);
    expect(report.entries[0]!.state).toBe('present');
  });

  it('2nd apply is a no-op (no files written)', async () => {
    const targets = resolveUserTargets(env);
    const adapter = createClaudeAdapter({ denyRef: [], agentsContent: AGENTS_CONTENT });

    await apply(adapter, [CONTEXT_ENTRY], 'user', env, targets.stateJson);
    const result2 = await apply(adapter, [CONTEXT_ENTRY], 'user', env, targets.stateJson);

    expect(result2.written).toHaveLength(0);
  });
});
