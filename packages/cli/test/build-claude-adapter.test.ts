/**
 * Tests for buildClaudeAdapter() — external resolver seam (M1b-3 Part B).
 *
 * Verifies:
 * 1. Without opts → skill source resolves to artifactsDir/claude/skills/<name> (existing behaviour).
 * 2. With externalIds + externalBaseDir → external skill resolves to externalBaseDir/skills/<name>.
 * 3. Internal skill (not in externalIds) still resolves via artifactsDir when both sets are present.
 * 4. Agent external source resolves to externalBaseDir/agents/<name>.md.
 *
 * Strategy:
 * - Real filesystem (tmp dirs with actual skill/agent fixture files).
 * - buildClaudeAdapter returns an Adapter; we call adapter.plan() and inspect the link op's source.
 * - No real ClaudeAdapter writes here — we only inspect the planned WriteOps.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import type { Env } from '@agent-rigger/core/paths';
import type { WriteOpLink } from '@agent-rigger/core/types';

import { buildClaudeAdapter } from '../src/cli';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(prefix: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/**
 * Create a minimal artifacts dir that satisfies buildClaudeAdapter:
 * - artifacts/claude/deny.json   (loadCanonicalDeny)
 * - artifacts/shared/AGENTS.md   (loadCanonicalContext)
 * - artifacts/claude/skills/<name>/SKILL.md (for internal skill resolution)
 */
async function makeArtifactsDir(baseDir: string, skillNames: string[] = []): Promise<string> {
  const artifactsDir = path.join(baseDir, 'artifacts');
  await fs.mkdir(path.join(artifactsDir, 'claude'), { recursive: true });
  await fs.mkdir(path.join(artifactsDir, 'shared'), { recursive: true });

  // Minimal deny.json
  await fs.writeFile(
    path.join(artifactsDir, 'claude', 'deny.json'),
    JSON.stringify({ deny: ['Read(~/.ssh/**)'] }),
  );

  // Minimal AGENTS.md
  await fs.writeFile(path.join(artifactsDir, 'shared', 'AGENTS.md'), '# Agents\nFixture.');

  // Internal skill fixtures
  for (const name of skillNames) {
    const skillDir = path.join(artifactsDir, 'claude', 'skills', name);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), `# ${name}\nFixture.`);
  }

  return artifactsDir;
}

/**
 * Create an external base dir with a skill fixture at skills/<name>/SKILL.md.
 */
async function makeExternalBaseDir(
  baseDir: string,
  skillNames: string[],
  agentNames: string[] = [],
): Promise<string> {
  const extDir = path.join(baseDir, 'external');
  for (const name of skillNames) {
    const skillDir = path.join(extDir, 'skills', name);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), `# ${name}\nExternal fixture.`);
  }
  for (const name of agentNames) {
    const agentDir = path.join(extDir, 'agents');
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, `${name}.md`), `# ${name}\nExternal agent.`);
  }
  return extDir;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpDir>>;
let env: Env;

beforeEach(async () => {
  tmp = await makeTmpDir('rigger-adapter-ext-');
  // Use a dedicated RIGGER_HOME so we never touch the real home
  env = { RIGGER_HOME: path.join(tmp.dir, 'home') };
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// Part B-1: without opts — existing behaviour unchanged
// ---------------------------------------------------------------------------

describe('buildClaudeAdapter — without opts', () => {
  it('skill source resolves to artifactsDir/claude/skills/<name> (internal path)', async () => {
    const artifactsDir = await makeArtifactsDir(tmp.dir, ['spec-workflow']);

    const adapter = await buildClaudeAdapter(env, artifactsDir);

    const entry: AdapterEntry = { id: 'skill:spec-workflow', nature: 'skill', scope: 'user' };
    const ops = await adapter.plan(entry, 'user', env);

    // Should produce a link op (skill is not yet installed in the tmp home)
    expect(ops.length).toBeGreaterThan(0);
    const linkOp = ops.find((op): op is WriteOpLink => op.kind === 'link');
    expect(linkOp).toBeDefined();
    // source should be the internal artifactsDir path
    const expectedSrc = path.join(artifactsDir, 'claude', 'skills', 'spec-workflow');
    expect(linkOp!.source).toBe(expectedSrc);
  });
});

// ---------------------------------------------------------------------------
// Part B-2: with externalIds + externalBaseDir → external skill resolves externally
// ---------------------------------------------------------------------------

describe('buildClaudeAdapter — with externalIds + externalBaseDir', () => {
  it('external skill source resolves to externalBaseDir/skills/<name>', async () => {
    const artifactsDir = await makeArtifactsDir(tmp.dir, []);
    const externalBaseDir = await makeExternalBaseDir(tmp.dir, ['x']);

    const adapter = await buildClaudeAdapter(env, artifactsDir, {
      externalIds: new Set(['skill:x']),
      externalBaseDir,
    });

    const entry: AdapterEntry = { id: 'skill:x', nature: 'skill', scope: 'user' };
    const ops = await adapter.plan(entry, 'user', env);

    expect(ops.length).toBeGreaterThan(0);
    const linkOp = ops.find((op): op is WriteOpLink => op.kind === 'link');
    expect(linkOp).toBeDefined();

    const expectedSrc = path.join(externalBaseDir, 'skills', 'x');
    expect(linkOp!.source).toBe(expectedSrc);
  });

  it('internal skill (not in externalIds) still resolves via artifactsDir', async () => {
    const artifactsDir = await makeArtifactsDir(tmp.dir, ['internal-skill']);
    const externalBaseDir = await makeExternalBaseDir(tmp.dir, ['x']);

    const adapter = await buildClaudeAdapter(env, artifactsDir, {
      externalIds: new Set(['skill:x']),
      externalBaseDir,
    });

    const entry: AdapterEntry = {
      id: 'skill:internal-skill',
      nature: 'skill',
      scope: 'user',
    };
    const ops = await adapter.plan(entry, 'user', env);

    expect(ops.length).toBeGreaterThan(0);
    const linkOp = ops.find((op): op is WriteOpLink => op.kind === 'link');
    expect(linkOp).toBeDefined();

    const expectedSrc = path.join(artifactsDir, 'claude', 'skills', 'internal-skill');
    expect(linkOp!.source).toBe(expectedSrc);
  });

  it('agent external source resolves to externalBaseDir/agents/<name>.md', async () => {
    const artifactsDir = await makeArtifactsDir(tmp.dir, []);
    const externalBaseDir = await makeExternalBaseDir(tmp.dir, [], ['senior-fullstack']);

    const adapter = await buildClaudeAdapter(env, artifactsDir, {
      externalIds: new Set(['agent:senior-fullstack']),
      externalBaseDir,
    });

    const entry: AdapterEntry = {
      id: 'agent:senior-fullstack',
      nature: 'agent',
      scope: 'user',
    };
    const ops = await adapter.plan(entry, 'user', env);

    // Should produce a link op for the agent
    expect(ops.length).toBeGreaterThan(0);
    const linkOp = ops.find((op): op is WriteOpLink => op.kind === 'link');
    expect(linkOp).toBeDefined();

    const expectedSrc = path.join(externalBaseDir, 'agents', 'senior-fullstack.md');
    expect(linkOp!.source).toBe(expectedSrc);
  });
});
