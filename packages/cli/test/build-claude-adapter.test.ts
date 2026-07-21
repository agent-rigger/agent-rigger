/**
 * Tests for buildClaudeAdapter() — external resolver seam (B-iii).
 *
 * Verifies (post-B-iii — no artifactsDir):
 * 1. Skills require externalBaseDir — throw when not in externalIds.
 * 2. With externalIds + externalBaseDir → external skill resolves to
 *    externalBaseDir/common/skills/<name> (post-cutover layout, R9).
 * 3. Agent external source resolves to externalBaseDir/common/agents/<name>.md.
 * 4. hookSpec resolves from effectiveEntries when external.
 * 5. External guardrail denyRef is loaded from checkout dir.
 * 6. External context agentsContent is loaded from checkout dir.
 * 7. Without externalBaseDir → denyRef = [] (check/remove path reads from manifest applied).
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
 * Create an external base dir with skill/agent/hook fixtures.
 */
async function makeExternalBaseDir(
  baseDir: string,
  skillNames: string[],
  agentNames: string[] = [],
  hookNames: string[] = [],
): Promise<string> {
  const extDir = path.join(baseDir, 'external');
  for (const name of skillNames) {
    const skillDir = path.join(extDir, 'common', 'skills', name);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), `# ${name}\nExternal fixture.`);
  }
  for (const name of agentNames) {
    const agentDir = path.join(extDir, 'common', 'agents');
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, `${name}.md`), `# ${name}\nExternal agent.`);
  }
  if (hookNames.length > 0) {
    const hooksDir = path.join(extDir, 'claude', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    for (const name of hookNames) {
      await fs.writeFile(path.join(hooksDir, `${name}.ts`), '// hook script');
    }
  }
  return extDir;
}

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
    const grDir = path.join(checkoutDir, 'claude', 'guardrails', opts.guardrailName);
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
    const ctxDir = path.join(checkoutDir, 'claude', 'contexts', opts.contextName);
    await fs.mkdir(ctxDir, { recursive: true });
    await fs.writeFile(path.join(ctxDir, 'AGENTS.md'), opts.agentsMdContent);
  }
  return checkoutDir;
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
// B-iii-1: without externalBaseDir — skills throw (no local fallback)
// ---------------------------------------------------------------------------

describe('buildClaudeAdapter — without externalBaseDir (B-iii)', () => {
  it('throws when planning a skill not in externalIds (no local fallback)', async () => {
    const adapter = await buildClaudeAdapter(env);

    const entry: AdapterEntry = { id: 'skill:some-skill', nature: 'skill', scope: 'user' };
    await expect(adapter.plan(entry, 'user', env)).rejects.toThrow(
      'All skills must come from the remote checkout',
    );
  });

  it('produces empty merge-deny ops when planning guardrail without externalBaseDir (denyRef=[])', async () => {
    const adapter = await buildClaudeAdapter(env);

    const entry: AdapterEntry = { id: 'guardrails-claude', nature: 'guardrail', scope: 'user' };
    // With denyRef=[], no rules are missing → empty plan
    const ops = await adapter.plan(entry, 'user', env);
    expect(ops.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// B-iii-2: with externalIds + externalBaseDir → external skill resolves externally
// ---------------------------------------------------------------------------

describe('buildClaudeAdapter — with externalIds + externalBaseDir', () => {
  it('external skill source resolves to externalBaseDir/skills/<name>', async () => {
    const externalBaseDir = await makeExternalBaseDir(tmp.dir, ['x']);

    const adapter = await buildClaudeAdapter(env, {
      externalIds: new Set(['skill:x']),
      externalBaseDir,
    });

    const entry: AdapterEntry = { id: 'skill:x', nature: 'skill', scope: 'user' };
    const ops = await adapter.plan(entry, 'user', env);

    expect(ops.length).toBeGreaterThan(0);
    const linkOp = ops.find((op): op is WriteOpLink => op.kind === 'link');
    expect(linkOp).toBeDefined();

    const expectedSrc = path.join(externalBaseDir, 'common', 'skills', 'x');
    expect(linkOp!.source).toBe(expectedSrc);
  });

  it('throws when skill not in externalIds (no fallback)', async () => {
    const externalBaseDir = await makeExternalBaseDir(tmp.dir, ['x']);

    const adapter = await buildClaudeAdapter(env, {
      externalIds: new Set(['skill:x']),
      externalBaseDir,
    });

    const entry: AdapterEntry = { id: 'skill:not-external', nature: 'skill', scope: 'user' };
    await expect(adapter.plan(entry, 'user', env)).rejects.toThrow(
      'All skills must come from the remote checkout',
    );
  });

  it('agent external source resolves to externalBaseDir/agents/<name>.md', async () => {
    const externalBaseDir = await makeExternalBaseDir(tmp.dir, [], ['senior-fullstack']);

    const adapter = await buildClaudeAdapter(env, {
      externalIds: new Set(['agent:senior-fullstack']),
      externalBaseDir,
    });

    const entry: AdapterEntry = {
      id: 'agent:senior-fullstack',
      nature: 'agent',
      scope: 'user',
    };
    const ops = await adapter.plan(entry, 'user', env);

    expect(ops.length).toBeGreaterThan(0);
    const linkOp = ops.find((op): op is WriteOpLink => op.kind === 'link');
    expect(linkOp).toBeDefined();

    const expectedSrc = path.join(externalBaseDir, 'common', 'agents', 'senior-fullstack.md');
    expect(linkOp!.source).toBe(expectedSrc);
  });
});

// ---------------------------------------------------------------------------
// hookSpec with effectiveEntries (B-iii)
// ---------------------------------------------------------------------------

describe('buildClaudeAdapter — hookSpec with effectiveEntries (B-iii)', () => {
  it('resolves external hook event/matcher from effectiveEntries map', async () => {
    const externalBaseDir = await makeExternalBaseDir(tmp.dir, [], [], ['my-hook']);

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

    const adapter = await buildClaudeAdapter(env, {
      externalIds: new Set(['hook:my-hook']),
      externalBaseDir,
      effectiveEntries,
    });

    const entry: AdapterEntry = { id: 'hook:my-hook', nature: 'hook', scope: 'user' };
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
    expect(mergeOp.scriptSource).toBe(path.join(externalBaseDir, 'claude', 'hooks'));
  });

  it('throws for unknown hook not in effectiveEntries (empty map)', async () => {
    const effectiveEntries: Map<string, import('@agent-rigger/catalog').CatalogEntry> = new Map();

    const adapter = await buildClaudeAdapter(env, { effectiveEntries });

    const entry: AdapterEntry = { id: 'hook:totally-unknown', nature: 'hook', scope: 'user' };
    await expect(adapter.plan(entry, 'user', env)).rejects.toThrow('hook:totally-unknown');
  });
});

// ---------------------------------------------------------------------------
// External guardrail/context from checkout (B-i.4, still valid)
// ---------------------------------------------------------------------------

describe('buildClaudeAdapter — external guardrail/context from checkout', () => {
  it('loads denyRef from checkout guardrails/<n>/deny.json when guardrail is external', async () => {
    const checkoutDir = await makeCheckoutDir(tmp.dir, {
      guardrailName: 'myguard',
      guardrailDeny: ['Bash(rm **)', 'Read(~/.ssh/**)'],
    });

    const adapter = await buildClaudeAdapter(env, {
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
    const checkoutDir = await makeCheckoutDir(tmp.dir, {
      guardrailName: 'myguard',
      guardrailDeny: ['Bash(rm **)'],
      guardrailAllow: ['Bash(git status)', 'Read(./docs/**)'],
    });

    const adapter = await buildClaudeAdapter(env, {
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
    const checkoutDir = await makeCheckoutDir(tmp.dir, {
      contextName: 'myctx',
      agentsMdContent: '# External Agents\nThis comes from the checkout.',
    });

    const adapter = await buildClaudeAdapter(env, {
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

  it('applies external guardrail rules end-to-end to settings.json', async () => {
    const checkoutDir = await makeCheckoutDir(tmp.dir, {
      guardrailName: 'claude',
      guardrailDeny: ['Bash(curl **)', 'Read(~/.aws/**)'],
      guardrailAllow: ['Bash(git log)'],
    });

    const adapter = await buildClaudeAdapter(env, {
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
