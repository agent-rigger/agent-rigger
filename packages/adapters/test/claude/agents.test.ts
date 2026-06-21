/**
 * Tests for claude/agents handler (TDD — written before implementation).
 *
 * Covers:
 * - agentName: strips 'agent:' prefix from entry id.
 * - auditAgent: target absent → missing; target present → present.
 * - planAgent: absent → 1 link op (correct source/store/target .md paths); present → [].
 * - end-to-end link apply: store .md + target symlink to store; readable via target; idempotent.
 * - scope project: target under <cwd>/.claude/agents/.
 * - end-to-end via createClaudeAdapter: check missing → apply → check present → 2nd apply no-op.
 * - non-regression: skills tests (op kind 'link') are unaffected by agents sharing the same op kind.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { link } from '@agent-rigger/core/linker';
import { resolveHome, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { WriteOpLink } from '@agent-rigger/core/types';

import { createClaudeAdapter } from '../../src/claude/adapter';
import { agentName, auditAgent, planAgent } from '../../src/claude/agents';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-agents-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** Create a minimal agent fixture file <name>.md in baseDir. */
async function makeAgentFixture(baseDir: string, name: string): Promise<string> {
  await fs.mkdir(baseDir, { recursive: true });
  const filePath = path.join(baseDir, `${name}.md`);
  await fs.writeFile(filePath, `# ${name}\nFixture agent.`);
  return filePath;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let fixturesDir: string;

beforeEach(async () => {
  tmp = await makeTmpHome('rigger-agents-');
  env = tmp.env;
  fixturesDir = path.join(tmp.dir, 'fixtures');
  await fs.mkdir(fixturesDir, { recursive: true });
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// agentName
// ---------------------------------------------------------------------------

describe('agentName', () => {
  it("strips 'agent:' prefix from entry id", () => {
    const entry: AdapterEntry = { id: 'agent:tech-lead', nature: 'agent', scope: 'user' };
    expect(agentName(entry)).toBe('tech-lead');
  });

  it('returns the id unchanged when no prefix', () => {
    const entry: AdapterEntry = { id: 'my-agent', nature: 'agent', scope: 'user' };
    expect(agentName(entry)).toBe('my-agent');
  });

  it('handles ids with multiple colons (keeps everything after first agent:)', () => {
    const entry: AdapterEntry = { id: 'agent:a:b', nature: 'agent', scope: 'user' };
    expect(agentName(entry)).toBe('a:b');
  });
});

// ---------------------------------------------------------------------------
// auditAgent
// ---------------------------------------------------------------------------

describe('auditAgent', () => {
  it('returns missing when target does not exist', async () => {
    const entry: AdapterEntry = { id: 'agent:tech-lead', nature: 'agent', scope: 'user' };

    const report = await auditAgent(entry, 'user', env);

    expect(report.state).toBe('missing');
    expect(report.nature).toBe('agent');
    expect(report.id).toBe('agent:tech-lead');
  });

  it('returns present when target .md file exists', async () => {
    const entry: AdapterEntry = { id: 'agent:tech-lead', nature: 'agent', scope: 'user' };
    const home = resolveHome(env);
    const targetPath = path.join(home, '.claude', 'agents', 'tech-lead.md');
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, '# tech-lead');

    const report = await auditAgent(entry, 'user', env);

    expect(report.state).toBe('present');
    expect(report.nature).toBe('agent');
  });

  it('returns present when target is a symlink to a .md file', async () => {
    const entry: AdapterEntry = { id: 'agent:my-agent', nature: 'agent', scope: 'user' };
    const home = resolveHome(env);
    const targetPath = path.join(home, '.claude', 'agents', 'my-agent.md');
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const srcFile = await makeAgentFixture(fixturesDir, 'my-agent');
    await fs.symlink(srcFile, targetPath);

    const report = await auditAgent(entry, 'user', env);

    expect(report.state).toBe('present');
  });

  it('uses project target path for scope project', async () => {
    const cwd = tmp.dir;
    const entry: AdapterEntry = { id: 'agent:tech-lead', nature: 'agent', scope: 'project' };
    const projectAgentPath = path.join(cwd, '.claude', 'agents', 'tech-lead.md');
    await fs.mkdir(path.dirname(projectAgentPath), { recursive: true });
    await fs.writeFile(projectAgentPath, '# tech-lead');

    const report = await auditAgent(entry, 'project', env, cwd);

    expect(report.state).toBe('present');
  });
});

// ---------------------------------------------------------------------------
// planAgent
// ---------------------------------------------------------------------------

describe('planAgent', () => {
  it('returns one link op when agent is absent', async () => {
    const entry: AdapterEntry = { id: 'agent:tech-lead', nature: 'agent', scope: 'user' };
    const srcFile = await makeAgentFixture(fixturesDir, 'tech-lead');
    const agentSource = (_e: AdapterEntry) => srcFile;

    const ops = await planAgent(entry, 'user', env, agentSource);

    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('link');
  });

  it('link op has correct source, store (.md), and target (.md) paths', async () => {
    const entry: AdapterEntry = { id: 'agent:tech-lead', nature: 'agent', scope: 'user' };
    const srcFile = await makeAgentFixture(fixturesDir, 'tech-lead');
    const agentSource = (_e: AdapterEntry) => srcFile;
    const home = resolveHome(env);
    const targets = resolveUserTargets(env);

    const ops = await planAgent(entry, 'user', env, agentSource);
    const op = ops[0] as WriteOpLink;

    expect(op.source).toBe(srcFile);
    // store: ~/.config/agent-rigger/agents/tech-lead.md
    expect(op.store).toBe(
      path.join(path.dirname(targets.skillsDir), 'agents', 'tech-lead.md'),
    );
    // target: ~/.claude/agents/tech-lead.md
    expect(op.target).toBe(path.join(home, '.claude', 'agents', 'tech-lead.md'));
  });

  it('returns empty array when agent is already present', async () => {
    const entry: AdapterEntry = { id: 'agent:tech-lead', nature: 'agent', scope: 'user' };
    const srcFile = await makeAgentFixture(fixturesDir, 'tech-lead');
    const agentSource = (_e: AdapterEntry) => srcFile;

    // Pre-install: create the target file
    const home = resolveHome(env);
    const targetPath = path.join(home, '.claude', 'agents', 'tech-lead.md');
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, '# tech-lead');

    const ops = await planAgent(entry, 'user', env, agentSource);

    expect(ops).toHaveLength(0);
  });

  it('uses project target .md path for scope project', async () => {
    const cwd = tmp.dir;
    const entry: AdapterEntry = { id: 'agent:my-agent', nature: 'agent', scope: 'project' };
    const srcFile = await makeAgentFixture(fixturesDir, 'my-agent');
    const agentSource = (_e: AdapterEntry) => srcFile;
    const targets = resolveUserTargets(env);

    const ops = await planAgent(entry, 'project', env, agentSource, cwd);
    const op = ops[0] as WriteOpLink;

    // store is always user-scope (managed store), with .md extension
    expect(op.store).toBe(
      path.join(path.dirname(targets.skillsDir), 'agents', 'my-agent.md'),
    );
    // target is project-scope .md file
    expect(op.target).toBe(path.join(cwd, '.claude', 'agents', 'my-agent.md'));
  });
});

// ---------------------------------------------------------------------------
// apply end-to-end (via linker directly — shared op kind 'link')
// ---------------------------------------------------------------------------

describe('agents apply (via link)', () => {
  it('copies source to store and creates symlink at target; content readable via target', async () => {
    const entry: AdapterEntry = { id: 'agent:tech-lead', nature: 'agent', scope: 'user' };
    const srcFile = await makeAgentFixture(fixturesDir, 'tech-lead');
    const agentSource = (_e: AdapterEntry) => srcFile;

    const ops = await planAgent(entry, 'user', env, agentSource);
    const op = ops[0] as WriteOpLink;

    // Apply via linker directly (shared primitive)
    await link(op.source, op.store, op.target);

    // Content readable through target symlink
    const content = await fs.readFile(op.target, 'utf-8');
    expect(content).toContain('tech-lead');
  });

  it('is idempotent: applying twice does not break the installation', async () => {
    const entry: AdapterEntry = { id: 'agent:tech-lead', nature: 'agent', scope: 'user' };
    const srcFile = await makeAgentFixture(fixturesDir, 'tech-lead');
    const agentSource = (_e: AdapterEntry) => srcFile;

    const ops = await planAgent(entry, 'user', env, agentSource);
    const op = ops[0] as WriteOpLink;

    await link(op.source, op.store, op.target);
    await link(op.source, op.store, op.target);

    const content = await fs.readFile(op.target, 'utf-8');
    expect(content).toContain('tech-lead');
  });

  it('scope project: target is under <cwd>/.claude/agents/', async () => {
    const cwd = tmp.dir;
    const entry: AdapterEntry = { id: 'agent:tech-lead', nature: 'agent', scope: 'project' };
    const srcFile = await makeAgentFixture(fixturesDir, 'tech-lead');
    const agentSource = (_e: AdapterEntry) => srcFile;

    const ops = await planAgent(entry, 'project', env, agentSource, cwd);
    const op = ops[0] as WriteOpLink;

    await link(op.source, op.store, op.target);

    expect(op.target).toBe(path.join(cwd, '.claude', 'agents', 'tech-lead.md'));
    const content = await fs.readFile(op.target, 'utf-8');
    expect(content).toContain('tech-lead');
  });
});

// ---------------------------------------------------------------------------
// end-to-end via createClaudeAdapter
// ---------------------------------------------------------------------------

describe('createClaudeAdapter — agent end-to-end', () => {
  it('check missing → apply → check present → 2nd apply no-op', async () => {
    const srcFile = await makeAgentFixture(fixturesDir, 'tech-lead');
    const agentSource = (_e: AdapterEntry) => srcFile;

    const adapter = createClaudeAdapter({
      denyRef: [],
      agentSource,
    });

    const entry: AdapterEntry = { id: 'agent:tech-lead', nature: 'agent', scope: 'user' };

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

  it('second apply with same ops is a no-op (idempotent)', async () => {
    const srcFile = await makeAgentFixture(fixturesDir, 'my-agent');
    const agentSource = (_e: AdapterEntry) => srcFile;

    const adapter = createClaudeAdapter({
      denyRef: [],
      agentSource,
    });

    const entry: AdapterEntry = { id: 'agent:my-agent', nature: 'agent', scope: 'user' };
    const ops = await adapter.plan(entry, 'user', env);
    await adapter.apply(ops, env);
    // second apply must not throw
    await adapter.apply(ops, env);

    const report = await adapter.audit(entry, 'user', env);
    expect(report.state).toBe('present');
  });
});

// ---------------------------------------------------------------------------
// Non-regression: skills still work when agents share the 'link' op kind
// ---------------------------------------------------------------------------

describe('non-regression: skills unaffected by agents sharing link op kind', () => {
  it('skill link op still works end-to-end via adapter', async () => {
    const skillDir = path.join(fixturesDir, 'spec-workflow');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# spec-workflow\nFixture skill.');
    const skillSource = (_e: AdapterEntry) => skillDir;

    const adapter = createClaudeAdapter({
      denyRef: [],
      skillSource,
    });

    const skillEntry: AdapterEntry = { id: 'skill:spec-workflow', nature: 'skill', scope: 'user' };

    const report1 = await adapter.audit(skillEntry, 'user', env);
    expect(report1.state).toBe('missing');

    const ops = await adapter.plan(skillEntry, 'user', env);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('link');
    await adapter.apply(ops, env);

    const report2 = await adapter.audit(skillEntry, 'user', env);
    expect(report2.state).toBe('present');
  });
});
