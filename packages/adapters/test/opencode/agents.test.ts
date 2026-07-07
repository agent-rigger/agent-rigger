/**
 * Tests for opencode/agents handler (TDD — written before implementation).
 *
 * Covers:
 * - agentName: strips 'agent:' prefix (mirrors claude/skills.ts skillName guard).
 * - translateAgentFrontmatter: description/mode/model passthrough, 'tools' translated
 *   into a 'permission' allow-list ('"*": deny' first, then one 'allow' per mapped
 *   tool — opencode resolves permission rules with findLast over key order, so the
 *   catch-all must be serialized first), unmappable tool names omitted + warning
 *   (fail-safe: stay denied by '*'), Write/Edit/NotebookEdit fusion warning (opencode's
 *   single 'edit' category also covers apply_patch), unknown fields omitted + warning,
 *   'name' silently dropped (id = filename).
 * - auditAgent: missing (target absent) / present (content matches translation) /
 *   drift (target exists but diverges).
 * - planAgent: [] when translation already installed; [write-text] with translated
 *   content otherwise. Path under opencode agentsDir, user + project scope.
 * - planRemoveAgent: [delete-file] when present; [] when missing or drifted.
 * - end-to-end via createOpencodeAdapter: check missing → apply (reuses write-text/
 *   applyContext) → check present → remove (reuses delete-file/applyRemoveContext) →
 *   check missing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { writeText } from '@agent-rigger/core/fs-json';
import {
  resolveOpencodeProjectTargets,
  resolveOpencodeUserTargets,
} from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { WriteOpWriteText } from '@agent-rigger/core/types';

import { createOpencodeAdapter } from '../../src/opencode/adapter';
import {
  agentName,
  auditAgent,
  planAgent,
  planRemoveAgent,
  translateAgentFrontmatter,
} from '../../src/opencode/agents';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-opencode-agents-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** A resolver that must never be invoked — used to prove a code path skips source access. */
function unreachableAgentSource(_e: AdapterEntry): string {
  throw new Error('agentSource should not be called when entry.applied is set');
}

const REVIEWER_SOURCE = [
  '---',
  'name: reviewer',
  'description: Reviewer agent.',
  'model: opus',
  'effort: xhigh',
  'tools: Read, Grep, Glob, Bash',
  '---',
  '',
  '# Agent Reviewer',
  '',
  'Body content.',
  '',
].join('\n');

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
// agentName
// ---------------------------------------------------------------------------

describe('agentName', () => {
  it("strips 'agent:' prefix from entry id", () => {
    const entry: AdapterEntry = { id: 'agent:reviewer', nature: 'agent', scope: 'user' };
    expect(agentName(entry)).toBe('reviewer');
  });

  it('returns the id unchanged when no prefix', () => {
    const entry: AdapterEntry = { id: 'reviewer', nature: 'agent', scope: 'user' };
    expect(agentName(entry)).toBe('reviewer');
  });

  it('throws for unsafe ids (path traversal guard)', () => {
    const entry: AdapterEntry = { id: 'agent:../../etc/passwd', nature: 'agent', scope: 'user' };
    expect(() => agentName(entry)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// translateAgentFrontmatter
// ---------------------------------------------------------------------------

describe('translateAgentFrontmatter', () => {
  it('passes description through unchanged', () => {
    const { frontmatter } = translateAgentFrontmatter({ description: 'A reviewer.' });
    expect(frontmatter['description']).toBe('A reviewer.');
  });

  it('defaults mode to "subagent"', () => {
    const { frontmatter } = translateAgentFrontmatter({});
    expect(frontmatter['mode']).toBe('subagent');
  });

  it('translates a clean comma-separated tools whitelist into a permission allow-list', () => {
    const { frontmatter, warnings } = translateAgentFrontmatter({
      tools: 'Read, Grep, Glob, Bash',
    });

    expect(frontmatter['tools']).toBeUndefined();
    expect(frontmatter['permission']).toEqual({
      '*': 'deny',
      read: 'allow',
      grep: 'allow',
      glob: 'allow',
      bash: 'allow',
    });
    expect(Object.keys(frontmatter['permission'] as Record<string, unknown>)[0]).toBe('*');
    expect(warnings).toEqual([]);
  });

  it('translates a tools array the same way', () => {
    const { frontmatter, warnings } = translateAgentFrontmatter({ tools: ['Read', 'Bash'] });

    expect(frontmatter['tools']).toBeUndefined();
    expect(frontmatter['permission']).toEqual({ '*': 'deny', read: 'allow', bash: 'allow' });
    expect(warnings).toEqual([]);
  });

  it('omits permission entirely when tools is absent (no restriction, no warning)', () => {
    const { frontmatter, warnings } = translateAgentFrontmatter({ description: 'x' });
    expect(frontmatter['permission']).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('dedups tools mapping to the same category, keeping source order', () => {
    const { frontmatter } = translateAgentFrontmatter({ tools: 'Write, Edit, Read' });

    expect(frontmatter['permission']).toEqual({ '*': 'deny', edit: 'allow', read: 'allow' });
  });

  it('maps Write-only to "edit" and emits a fusion warning (broader than the source)', () => {
    const { frontmatter, warnings } = translateAgentFrontmatter({ tools: 'Write' });

    expect(frontmatter['permission']).toEqual({ '*': 'deny', edit: 'allow' });
    expect(
      warnings.some((w) => w.includes('edit') && w.includes('write') && w.includes('apply_patch')),
    ).toBe(true);
  });

  it('does not emit the fusion warning when both Write and Edit are already listed', () => {
    const { warnings } = translateAgentFrontmatter({ tools: 'Write, Edit' });

    expect(warnings).toEqual([]);
  });

  it('omits an unmappable tool from the allow-list and emits a warning naming it', () => {
    const { frontmatter, warnings } = translateAgentFrontmatter({
      tools: 'Read, mcp__foo__bar',
    });

    expect(frontmatter['permission']).toEqual({ '*': 'deny', read: 'allow' });
    expect(warnings.some((w) => w.includes('mcp__foo__bar'))).toBe(true);
  });

  it('reports a collision when the source has both "tools" and an explicit "permission" field', () => {
    const { frontmatter, warnings } = translateAgentFrontmatter({
      tools: 'Read',
      permission: { bash: 'allow' },
    });

    expect(frontmatter['permission']).toEqual({ '*': 'deny', read: 'allow' });
    expect(warnings.some((w) => w.includes('tools') && w.includes('permission'))).toBe(true);
  });

  it('passes model through unchanged when already in provider/model form', () => {
    const { frontmatter, warnings } = translateAgentFrontmatter({
      model: 'anthropic/claude-opus-4-8',
    });
    expect(frontmatter['model']).toBe('anthropic/claude-opus-4-8');
    expect(warnings).toEqual([]);
  });

  it('passes a bare model through with a warning when the form is ambiguous', () => {
    const { frontmatter, warnings } = translateAgentFrontmatter({ model: 'opus' });
    expect(frontmatter['model']).toBe('opus');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('opus');
  });

  it('silently drops "name" (id is the filename, no field equivalent, no warning)', () => {
    const { frontmatter, warnings } = translateAgentFrontmatter({ name: 'reviewer' });
    expect(frontmatter['name']).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('omits a field with no opencode equivalent and emits a warning', () => {
    const { frontmatter, warnings } = translateAgentFrontmatter({ effort: 'xhigh' });
    expect(frontmatter['effort']).toBeUndefined();
    expect(warnings.some((w) => w.includes('effort'))).toBe(true);
  });

  it('translates the full reviewer-shaped frontmatter with no "tools" warning (clean whitelist)', () => {
    const { frontmatter, warnings } = translateAgentFrontmatter({
      name: 'reviewer',
      description: 'Reviewer agent.',
      model: 'opus',
      effort: 'xhigh',
      tools: 'Read, Grep, Glob, Bash',
    });

    expect(frontmatter).toEqual({
      description: 'Reviewer agent.',
      mode: 'subagent',
      model: 'opus',
      permission: { '*': 'deny', read: 'allow', grep: 'allow', glob: 'allow', bash: 'allow' },
    });
    expect(warnings.filter((w) => w.includes('opus'))).toHaveLength(1);
    expect(warnings.filter((w) => w.includes('effort'))).toHaveLength(1);
    expect(warnings.filter((w) => w.includes('tools'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// auditAgent
// ---------------------------------------------------------------------------

describe('auditAgent', () => {
  it('returns missing when the target does not exist', async () => {
    const entry: AdapterEntry = { id: 'agent:reviewer', nature: 'agent', scope: 'user' };
    const agentSource = (_e: AdapterEntry) => path.join(tmp.dir, 'source.md');

    const report = await auditAgent(entry, 'user', env, agentSource);

    expect(report.state).toBe('missing');
    expect(report.nature).toBe('agent');
  });

  it('returns present when the target content matches the fresh translation', async () => {
    const entry: AdapterEntry = { id: 'agent:reviewer', nature: 'agent', scope: 'user' };
    const sourcePath = path.join(tmp.dir, 'source.md');
    await writeText(sourcePath, REVIEWER_SOURCE);
    const agentSource = (_e: AdapterEntry) => sourcePath;

    const ops = await planAgent(entry, 'user', env, agentSource);
    await writeText((ops[0] as WriteOpWriteText).path, (ops[0] as WriteOpWriteText).content);

    const report = await auditAgent(entry, 'user', env, agentSource);

    expect(report.state).toBe('present');
  });

  it('returns drift when the target content diverges from the fresh translation', async () => {
    const entry: AdapterEntry = { id: 'agent:reviewer', nature: 'agent', scope: 'user' };
    const sourcePath = path.join(tmp.dir, 'source.md');
    await writeText(sourcePath, REVIEWER_SOURCE);
    const agentSource = (_e: AdapterEntry) => sourcePath;
    const targets = resolveOpencodeUserTargets(env);
    const targetPath = path.join(targets.agentsDir, 'reviewer.md');
    await writeText(targetPath, 'locally edited content\n');

    const report = await auditAgent(entry, 'user', env, agentSource);

    expect(report.state).toBe('drift');
  });

  it('uses entry.applied as the effective content when present (offline, no source read)', async () => {
    const targets = resolveOpencodeUserTargets(env);
    const targetPath = path.join(targets.agentsDir, 'reviewer.md');
    await writeText(targetPath, 'applied content\n');

    const entry: AdapterEntry = {
      id: 'agent:reviewer',
      nature: 'agent',
      scope: 'user',
      applied: { kind: 'context', block: 'applied content\n' },
    };
    // agentSource deliberately throws — must not be called when entry.applied is present.
    const report = await auditAgent(entry, 'user', env, unreachableAgentSource);

    expect(report.state).toBe('present');
  });
});

// ---------------------------------------------------------------------------
// planAgent
// ---------------------------------------------------------------------------

describe('planAgent', () => {
  it('returns a write-text op with the translated content when not yet installed', async () => {
    const entry: AdapterEntry = { id: 'agent:reviewer', nature: 'agent', scope: 'user' };
    const sourcePath = path.join(tmp.dir, 'source.md');
    await writeText(sourcePath, REVIEWER_SOURCE);
    const agentSource = (_e: AdapterEntry) => sourcePath;
    const targets = resolveOpencodeUserTargets(env);

    const ops = await planAgent(entry, 'user', env, agentSource);

    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('write-text');
    const op = ops[0] as WriteOpWriteText;
    expect(op.path).toBe(path.join(targets.agentsDir, 'reviewer.md'));
    expect(op.content).toContain('mode: subagent');
    expect(op.content).toContain('Body content.');
    expect(op.content).not.toContain('effort:');
    expect(op.content).not.toContain('tools:');
    expect(op.content).toContain('permission:');
    expect(op.content).toContain('  "*": deny');
    expect(op.content).toContain('  read: allow');
    expect(op.content).toContain('  bash: allow');
    // "*" must be serialized first: opencode resolves permission rules with
    // findLast over key insertion order, so a later "*" would silently override
    // the allow entries above it.
    expect(op.content.indexOf('"*"')).toBeLessThan(op.content.indexOf('read: allow'));
  });

  it('surfaces translation warnings on the op (HIGH-2)', async () => {
    const entry: AdapterEntry = { id: 'agent:reviewer', nature: 'agent', scope: 'user' };
    const sourcePath = path.join(tmp.dir, 'source.md');
    await writeText(sourcePath, REVIEWER_SOURCE);
    const agentSource = (_e: AdapterEntry) => sourcePath;

    const ops = await planAgent(entry, 'user', env, agentSource);

    const op = ops[0] as WriteOpWriteText;
    // REVIEWER_SOURCE's tools (Read, Grep, Glob, Bash) all map cleanly — no tools warning.
    expect(op.warnings?.some((w) => w.includes('effort'))).toBe(true);
    expect(op.description).not.toContain('effort');
  });

  it('returns [] when the translated content is already installed (idempotent)', async () => {
    const entry: AdapterEntry = { id: 'agent:reviewer', nature: 'agent', scope: 'user' };
    const sourcePath = path.join(tmp.dir, 'source.md');
    await writeText(sourcePath, REVIEWER_SOURCE);
    const agentSource = (_e: AdapterEntry) => sourcePath;

    const firstOps = await planAgent(entry, 'user', env, agentSource);
    await writeText(
      (firstOps[0] as WriteOpWriteText).path,
      (firstOps[0] as WriteOpWriteText).content,
    );

    const ops = await planAgent(entry, 'user', env, agentSource);

    expect(ops).toHaveLength(0);
  });

  it('uses the project agentsDir for scope project', async () => {
    const cwd = tmp.dir;
    const entry: AdapterEntry = { id: 'agent:reviewer', nature: 'agent', scope: 'project' };
    const sourcePath = path.join(tmp.dir, 'source.md');
    await writeText(sourcePath, REVIEWER_SOURCE);
    const agentSource = (_e: AdapterEntry) => sourcePath;

    const ops = await planAgent(entry, 'project', env, agentSource, cwd);

    const op = ops[0] as WriteOpWriteText;
    expect(op.path).toBe(path.join(resolveOpencodeProjectTargets(cwd).agentsDir, 'reviewer.md'));
  });
});

// ---------------------------------------------------------------------------
// planRemoveAgent
// ---------------------------------------------------------------------------

describe('planRemoveAgent', () => {
  it('returns [] when not installed', async () => {
    const entry: AdapterEntry = { id: 'agent:reviewer', nature: 'agent', scope: 'user' };
    const agentSource = (_e: AdapterEntry) => path.join(tmp.dir, 'source.md');

    const ops = await planRemoveAgent(entry, 'user', env, agentSource);

    expect(ops).toHaveLength(0);
  });

  it('returns [delete-file] when installed and matching', async () => {
    const entry: AdapterEntry = { id: 'agent:reviewer', nature: 'agent', scope: 'user' };
    const sourcePath = path.join(tmp.dir, 'source.md');
    await writeText(sourcePath, REVIEWER_SOURCE);
    const agentSource = (_e: AdapterEntry) => sourcePath;
    const targets = resolveOpencodeUserTargets(env);

    const installOps = await planAgent(entry, 'user', env, agentSource);
    await writeText(
      (installOps[0] as WriteOpWriteText).path,
      (installOps[0] as WriteOpWriteText).content,
    );

    const ops = await planRemoveAgent(entry, 'user', env, agentSource);

    expect(ops).toEqual([
      { kind: 'delete-file', path: path.join(targets.agentsDir, 'reviewer.md') },
    ]);
  });

  it('returns [] when the target has drifted (local edits are preserved offline)', async () => {
    const entry: AdapterEntry = { id: 'agent:reviewer', nature: 'agent', scope: 'user' };
    const sourcePath = path.join(tmp.dir, 'source.md');
    await writeText(sourcePath, REVIEWER_SOURCE);
    const agentSource = (_e: AdapterEntry) => sourcePath;
    const targets = resolveOpencodeUserTargets(env);
    await writeText(path.join(targets.agentsDir, 'reviewer.md'), 'locally edited\n');

    const ops = await planRemoveAgent(entry, 'user', env, agentSource);

    expect(ops).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// end-to-end via createOpencodeAdapter
// ---------------------------------------------------------------------------

describe('createOpencodeAdapter — agent end-to-end', () => {
  it('check missing → apply → check present → remove → check missing', async () => {
    const sourcePath = path.join(tmp.dir, 'source.md');
    await writeText(sourcePath, REVIEWER_SOURCE);

    const adapter = createOpencodeAdapter({ agentSource: (_e: AdapterEntry) => sourcePath });
    const entry: AdapterEntry = { id: 'agent:reviewer', nature: 'agent', scope: 'user' };

    const report1 = await adapter.audit(entry, 'user', env);
    expect(report1.state).toBe('missing');

    const ops = await adapter.plan(entry, 'user', env);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('write-text');
    await adapter.apply(ops, env);

    const report2 = await adapter.audit(entry, 'user', env);
    expect(report2.state).toBe('present');

    const targets = resolveOpencodeUserTargets(env);
    const written = await fs.readFile(path.join(targets.agentsDir, 'reviewer.md'), 'utf-8');
    expect(written).toContain('mode: subagent');

    const removeOps = await adapter.planRemove(entry, 'user', env);
    expect(removeOps).toEqual([
      { kind: 'delete-file', path: path.join(targets.agentsDir, 'reviewer.md') },
    ]);
    await adapter.applyRemove(removeOps, env);

    const report3 = await adapter.audit(entry, 'user', env);
    expect(report3.state).toBe('missing');
  });
});
