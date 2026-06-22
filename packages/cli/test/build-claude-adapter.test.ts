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
import { readJson } from '@agent-rigger/core/fs-json';
import { resolveUserTargets } from '@agent-rigger/core/paths';
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

// ---------------------------------------------------------------------------
// B-i.3: hookSpec with effectiveEntries — no BUILTIN_CATALOG.find dependency
// ---------------------------------------------------------------------------

describe('buildClaudeAdapter — hookSpec with effectiveEntries (B-i.3)', () => {
  it('resolves external hook event/matcher from effectiveEntries map', async () => {
    const artifactsDir = await makeArtifactsDir(tmp.dir, []);
    const externalBaseDir = await makeExternalBaseDir(tmp.dir, [], []);
    // Create external hooks dir so scriptSource exists
    await fs.mkdir(path.join(externalBaseDir, 'hooks'), { recursive: true });
    await fs.writeFile(path.join(externalBaseDir, 'hooks', 'my-hook.ts'), '// hook script');

    const effectiveEntries: Map<string, import('@agent-rigger/catalog').CatalogEntry> = new Map([
      [
        'hook:my-hook',
        {
          kind: 'artifact',
          id: 'hook:my-hook',
          nature: 'hook',
          targets: ['claude'],
          scopes: ['user'],
          event: 'PreToolUse',
          matcher: 'Bash',
          timeout: 10,
        },
      ],
    ]);

    const adapter = await buildClaudeAdapter(env, artifactsDir, {
      externalIds: new Set(['hook:my-hook']),
      externalBaseDir,
      effectiveEntries,
    });

    const entry: AdapterEntry = { id: 'hook:my-hook', nature: 'hook', scope: 'user' };
    // plan should not throw and should produce a merge-hooks op
    const ops = await adapter.plan(entry, 'user', env);
    expect(ops.length).toBeGreaterThan(0);
    expect(ops[0]!.kind).toBe('merge-hooks');

    const mergeOp = ops[0] as {
      kind: string;
      event: string;
      matcher: string;
      scriptSource: string;
      timeout: number;
    };
    expect(mergeOp.event).toBe('PreToolUse');
    expect(mergeOp.matcher).toBe('Bash');
    expect(mergeOp.timeout).toBe(10);
    // scriptSource points to externalBaseDir/hooks (external path)
    expect(mergeOp.scriptSource).toBe(path.join(externalBaseDir, 'hooks'));
  });

  it('falls back to BUILTIN_CATALOG for builtin hook entries when no effectiveEntries', async () => {
    const artifactsDir = await makeArtifactsDir(tmp.dir, []);
    // Create builtin hooks dir
    await fs.mkdir(path.join(artifactsDir, 'claude', 'hooks'), { recursive: true });
    await fs.writeFile(path.join(artifactsDir, 'claude', 'hooks', 'guard-command.ts'), '// hook');

    const adapter = await buildClaudeAdapter(env, artifactsDir);

    const entry: AdapterEntry = { id: 'hook:guard-command', nature: 'hook', scope: 'user' };
    const ops = await adapter.plan(entry, 'user', env);
    expect(ops.length).toBeGreaterThan(0);
    expect(ops[0]!.kind).toBe('merge-hooks');

    const mergeOp = ops[0] as { event: string; matcher: string; scriptSource: string };
    // guard-command in BUILTIN_CATALOG: PreToolUse / Bash
    expect(mergeOp.event).toBe('PreToolUse');
    expect(mergeOp.matcher).toBe('Bash');
    // scriptSource should be from artifactsDir (builtin fallback)
    expect(mergeOp.scriptSource).toBe(path.join(artifactsDir, 'claude', 'hooks'));
  });

  it('throws for unknown hook not in effectiveEntries or BUILTIN_CATALOG', async () => {
    const artifactsDir = await makeArtifactsDir(tmp.dir, []);

    const effectiveEntries: Map<string, import('@agent-rigger/catalog').CatalogEntry> = new Map();

    const adapter = await buildClaudeAdapter(env, artifactsDir, { effectiveEntries });

    const entry: AdapterEntry = { id: 'hook:totally-unknown', nature: 'hook', scope: 'user' };
    await expect(adapter.plan(entry, 'user', env)).rejects.toThrow('hook:totally-unknown');
  });
});

// ---------------------------------------------------------------------------
// B-i.4: external guardrail/context from checkout
// ---------------------------------------------------------------------------

/**
 * Create a checkout fixture with guardrail and/or context files.
 */
async function makeCheckoutDir(
  baseDir: string,
  opts: {
    guardrailName?: string;
    guardrailDeny?: string[];
    guardrailAllow?: string[];
    contextName?: string;
    agentsMdContent?: string;
  } = {},
): Promise<string> {
  const checkoutDir = path.join(baseDir, 'checkout');
  if (opts.guardrailName !== undefined) {
    const grDir = path.join(checkoutDir, 'guardrails', opts.guardrailName);
    await fs.mkdir(grDir, { recursive: true });
    if (opts.guardrailDeny !== undefined) {
      await fs.writeFile(
        path.join(grDir, 'deny.json'),
        JSON.stringify({ deny: opts.guardrailDeny }),
      );
    }
    if (opts.guardrailAllow !== undefined) {
      await fs.writeFile(
        path.join(grDir, 'allow.json'),
        JSON.stringify({ allow: opts.guardrailAllow }),
      );
    }
  }
  if (opts.contextName !== undefined && opts.agentsMdContent !== undefined) {
    const ctxDir = path.join(checkoutDir, 'contexts', opts.contextName);
    await fs.mkdir(ctxDir, { recursive: true });
    await fs.writeFile(path.join(ctxDir, 'AGENTS.md'), opts.agentsMdContent);
  }
  return checkoutDir;
}

describe('buildClaudeAdapter — external guardrail/context from checkout (B-i.4)', () => {
  it('loads denyRef from checkout guardrails/<n>/deny.json when guardrail is external', async () => {
    const artifactsDir = await makeArtifactsDir(tmp.dir, []);
    const checkoutDir = await makeCheckoutDir(tmp.dir, {
      guardrailName: 'myguard',
      guardrailDeny: ['Bash(rm **)', 'Read(~/.ssh/**)'],
    });

    const adapter = await buildClaudeAdapter(env, artifactsDir, {
      externalIds: new Set(['guardrail:myguard']),
      externalBaseDir: checkoutDir,
    });

    const entry: AdapterEntry = { id: 'guardrail:myguard', nature: 'guardrail', scope: 'user' };
    const ops = await adapter.plan(entry, 'user', env);

    const denyOp = ops.find((op) => op.kind === 'merge-deny');
    expect(denyOp).toBeDefined();
    const toAdd = (denyOp as { kind: string; toAdd: string[] }).toAdd;
    expect(toAdd).toContain('Bash(rm **)');
    expect(toAdd).toContain('Read(~/.ssh/**)');
  });

  it('loads allowRef from checkout guardrails/<n>/allow.json when present', async () => {
    const artifactsDir = await makeArtifactsDir(tmp.dir, []);
    const checkoutDir = await makeCheckoutDir(tmp.dir, {
      guardrailName: 'myguard',
      guardrailDeny: ['Bash(rm **)'],
      guardrailAllow: ['Bash(git status)', 'Read(./docs/**)'],
    });

    const adapter = await buildClaudeAdapter(env, artifactsDir, {
      externalIds: new Set(['guardrail:myguard']),
      externalBaseDir: checkoutDir,
    });

    const entry: AdapterEntry = { id: 'guardrail:myguard', nature: 'guardrail', scope: 'user' };
    const ops = await adapter.plan(entry, 'user', env);

    const allowOp = ops.find((op) => op.kind === 'merge-allow');
    expect(allowOp).toBeDefined();
    const toAdd = (allowOp as { kind: string; toAdd: string[] }).toAdd;
    expect(toAdd).toContain('Bash(git status)');
    expect(toAdd).toContain('Read(./docs/**)');
  });

  it('loads agentsContent from checkout contexts/<n>/AGENTS.md when context is external', async () => {
    const artifactsDir = await makeArtifactsDir(tmp.dir, []);
    const checkoutDir = await makeCheckoutDir(tmp.dir, {
      contextName: 'myctx',
      agentsMdContent: '# External Agents\nThis comes from the checkout.',
    });

    const adapter = await buildClaudeAdapter(env, artifactsDir, {
      externalIds: new Set(['context:myctx']),
      externalBaseDir: checkoutDir,
    });

    const entry: AdapterEntry = { id: 'context:myctx', nature: 'context', scope: 'user' };
    const ops = await adapter.plan(entry, 'user', env);

    const writeTextOp = ops.find((op) => op.kind === 'write-text');
    expect(writeTextOp).toBeDefined();
    expect((writeTextOp as { kind: string; content: string }).content).toBe(
      '# External Agents\nThis comes from the checkout.',
    );
  });

  it('falls back to artifactsDir when no external guardrail in externalIds (only skill external)', async () => {
    const artifactsDir = await makeArtifactsDir(tmp.dir, ['spec-workflow']);
    const externalBaseDir = await makeExternalBaseDir(tmp.dir, ['ext-skill']);

    const adapter = await buildClaudeAdapter(env, artifactsDir, {
      externalIds: new Set(['skill:ext-skill']),
      externalBaseDir,
    });

    // Plan a guardrail entry — should use the builtin deny from artifactsDir
    const entry: AdapterEntry = {
      id: 'guardrails-claude',
      nature: 'guardrail',
      scope: 'user',
    };
    const ops = await adapter.plan(entry, 'user', env);

    // The builtin deny.json has 'Read(~/.ssh/**)' — so that rule should be in the op
    const denyOp = ops.find((op) => op.kind === 'merge-deny');
    expect(denyOp).toBeDefined();
    const toAdd = (denyOp as { kind: string; toAdd: string[] }).toAdd;
    expect(toAdd).toContain('Read(~/.ssh/**)');
  });

  it('applies external guardrail rules end-to-end to settings.json', async () => {
    const artifactsDir = await makeArtifactsDir(tmp.dir, []);
    const checkoutDir = await makeCheckoutDir(tmp.dir, {
      guardrailName: 'claude',
      guardrailDeny: ['Bash(curl **)', 'Read(~/.aws/**)'],
      guardrailAllow: ['Bash(git log)'],
    });

    const adapter = await buildClaudeAdapter(env, artifactsDir, {
      externalIds: new Set(['guardrail:claude']),
      externalBaseDir: checkoutDir,
    });

    const entry: AdapterEntry = { id: 'guardrail:claude', nature: 'guardrail', scope: 'user' };
    const ops = await adapter.plan(entry, 'user', env);
    await adapter.apply(ops, env);

    const targets = resolveUserTargets(env);
    const settings = await readJson(targets.claudeSettings);
    const perms = settings['permissions'] as Record<string, unknown>;
    expect(perms['deny'] as string[]).toContain('Bash(curl **)');
    expect(perms['allow'] as string[]).toContain('Bash(git log)');
  });
});
