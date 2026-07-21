/**
 * Tests for buildOpencodeAdapter() — external resolver seam (E3).
 *
 * Mirrors build-claude-adapter.test.ts: real tmp dirs, a checkout fixture per
 * nature, adapter.plan() inspected for the right op kind + source/content.
 *
 * Coverage:
 * 1. Without an external guardrail → permission unset, agentsContent = ''.
 * 2. skill/agent/plugin source resolution from externalBaseDir (externalIds gate).
 * 3. guardrail native permission.json loaded verbatim from checkout (ADR-0020
 *    "Option A" — no translation); a missing descriptor is a hard error.
 * 4. context agentsContent loaded from checkout, posed as write-text (no bridge, R3.1).
 * 5. mcp: server + config resolved from effectiveEntries; every field passes
 *    through verbatim EXCEPT environment/headers, whose "${REF}" secret refs
 *    are rendered to opencode's native `{env:VAR}` form (R5, lot 6, D5 — see
 *    lot6-r5-secrets-render.test.ts for the full declared-secret/fail-closed
 *    coverage; this file only proves the base resolution + rendering shape).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry } from '@agent-rigger/catalog';
import type { AdapterEntry } from '@agent-rigger/core/adapter';
import type { Env } from '@agent-rigger/core/paths';
import type { OpencodePermission, WriteOpLink } from '@agent-rigger/core/types';

import { buildOpencodeAdapter } from '../src/opencode-adapter-builder';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(prefix: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** Create a checkout fixture with the given per-nature source files. */
async function makeCheckoutDir(
  baseDir: string,
  opts: {
    guardrailName?: string;
    guardrailPermission?: OpencodePermission;
    contextName?: string;
    agentsMdContent?: string;
    skillNames?: string[];
    agentNames?: string[];
    pluginFiles?: { name: string; ext: string }[];
  } = {},
): Promise<string> {
  const checkoutDir = path.join(baseDir, 'checkout');

  if (opts.guardrailName !== undefined) {
    const grDir = path.join(checkoutDir, 'opencode', 'guardrails', opts.guardrailName);
    await fs.mkdir(grDir, { recursive: true });
    // The native opencode descriptor is written only when provided — omitting it
    // simulates a guardrail directory that ships no permission.json (hard error).
    if (opts.guardrailPermission !== undefined) {
      await fs.writeFile(
        path.join(grDir, 'permission.json'),
        JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          permission: opts.guardrailPermission,
        }),
      );
    }
  }

  if (opts.contextName !== undefined && opts.agentsMdContent !== undefined) {
    const ctxDir = path.join(checkoutDir, 'opencode', 'contexts', opts.contextName);
    await fs.mkdir(ctxDir, { recursive: true });
    await fs.writeFile(path.join(ctxDir, 'AGENTS.md'), opts.agentsMdContent);
  }

  for (const name of opts.skillNames ?? []) {
    const skillDir = path.join(checkoutDir, 'common', 'skills', name);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), `# ${name}\nExternal fixture.`);
  }

  for (const name of opts.agentNames ?? []) {
    const agentDir = path.join(checkoutDir, 'common', 'agents');
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, `${name}.md`),
      ['---', `name: ${name}`, 'description: A test agent.', '---', '', 'Body.', ''].join('\n'),
    );
  }

  for (const plugin of opts.pluginFiles ?? []) {
    const pluginsDir = path.join(checkoutDir, 'opencode', 'plugins');
    await fs.mkdir(pluginsDir, { recursive: true });
    await fs.writeFile(path.join(pluginsDir, `${plugin.name}.${plugin.ext}`), '// plugin module');
  }

  return checkoutDir;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpDir>>;
let env: Env;

beforeEach(async () => {
  tmp = await makeTmpDir('rigger-opencode-adapter-ext-');
  env = { RIGGER_HOME: path.join(tmp.dir, 'home') };
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// Without externalBaseDir — graceful defaults
// ---------------------------------------------------------------------------

describe('buildOpencodeAdapter — without externalBaseDir', () => {
  it('throws when planning a skill not in externalIds (no local fallback)', async () => {
    const adapter = await buildOpencodeAdapter(env);

    const entry: AdapterEntry = { id: 'skill:some-skill', nature: 'skill', scope: 'user' };
    await expect(adapter.plan(entry, 'user', env)).rejects.toThrow(
      'All skills must come from the remote checkout',
    );
  });

  it('produces no permission ops when planning guardrail without externalBaseDir (permission unset)', async () => {
    const adapter = await buildOpencodeAdapter(env);

    const entry: AdapterEntry = { id: 'guardrail:main', nature: 'guardrail', scope: 'user' };
    const ops = await adapter.plan(entry, 'user', env);
    expect(ops.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// skill / agent / plugin — external source resolution
// ---------------------------------------------------------------------------

describe('buildOpencodeAdapter — skill/agent/plugin external source resolution', () => {
  it('external skill source resolves to externalBaseDir/skills/<name>', async () => {
    const externalBaseDir = await makeCheckoutDir(tmp.dir, { skillNames: ['x'] });

    const adapter = await buildOpencodeAdapter(env, {
      externalIds: new Set(['skill:x']),
      externalBaseDir,
    });

    const entry: AdapterEntry = { id: 'skill:x', nature: 'skill', scope: 'user' };
    const ops = await adapter.plan(entry, 'user', env);

    const linkOp = ops.find((op): op is WriteOpLink => op.kind === 'link');
    expect(linkOp).toBeDefined();
    expect(linkOp!.source).toBe(path.join(externalBaseDir, 'common', 'skills', 'x'));
  });

  it('throws when skill not in externalIds (no fallback)', async () => {
    const externalBaseDir = await makeCheckoutDir(tmp.dir, { skillNames: ['x'] });

    const adapter = await buildOpencodeAdapter(env, {
      externalIds: new Set(['skill:x']),
      externalBaseDir,
    });

    const entry: AdapterEntry = { id: 'skill:not-external', nature: 'skill', scope: 'user' };
    await expect(adapter.plan(entry, 'user', env)).rejects.toThrow(
      'All skills must come from the remote checkout',
    );
  });

  it('agent external source resolves to externalBaseDir/agents/<name>.md (write-text, translated)', async () => {
    const externalBaseDir = await makeCheckoutDir(tmp.dir, { agentNames: ['reviewer'] });

    const adapter = await buildOpencodeAdapter(env, {
      externalIds: new Set(['agent:reviewer']),
      externalBaseDir,
    });

    const entry: AdapterEntry = { id: 'agent:reviewer', nature: 'agent', scope: 'user' };
    const ops = await adapter.plan(entry, 'user', env);

    expect(ops.length).toBeGreaterThan(0);
    expect(ops[0]!.kind).toBe('write-text');
  });

  it('throws when agent not in externalIds (no fallback)', async () => {
    const externalBaseDir = await makeCheckoutDir(tmp.dir, { agentNames: ['reviewer'] });

    const adapter = await buildOpencodeAdapter(env, {
      externalIds: new Set(['agent:reviewer']),
      externalBaseDir,
    });

    const entry: AdapterEntry = { id: 'agent:not-external', nature: 'agent', scope: 'user' };
    await expect(adapter.plan(entry, 'user', env)).rejects.toThrow(
      'All agents must come from the remote checkout',
    );
  });

  it('plugin source resolves by basename lookup under externalBaseDir/plugins/ (extension-agnostic)', async () => {
    const externalBaseDir = await makeCheckoutDir(tmp.dir, {
      pluginFiles: [{ name: 'guard', ext: 'ts' }],
    });

    const adapter = await buildOpencodeAdapter(env, {
      externalIds: new Set(['plugin:guard']),
      externalBaseDir,
    });

    const entry: AdapterEntry = { id: 'plugin:guard', nature: 'plugin', scope: 'user' };
    const ops = await adapter.plan(entry, 'user', env);

    const linkOp = ops.find((op): op is WriteOpLink => op.kind === 'link');
    expect(linkOp).toBeDefined();
    expect(linkOp!.source).toBe(path.join(externalBaseDir, 'opencode', 'plugins', 'guard.ts'));
  });

  it('throws an actionable error when the plugin file is absent from externalBaseDir/plugins/', async () => {
    const externalBaseDir = await makeCheckoutDir(tmp.dir, {});

    const adapter = await buildOpencodeAdapter(env, {
      externalIds: new Set(['plugin:missing']),
      externalBaseDir,
    });

    const entry: AdapterEntry = { id: 'plugin:missing', nature: 'plugin', scope: 'user' };
    await expect(adapter.plan(entry, 'user', env)).rejects.toThrow(/plugin:missing/);
  });

  it('throws when plugin not in externalIds (no fallback)', async () => {
    const externalBaseDir = await makeCheckoutDir(tmp.dir, {
      pluginFiles: [{ name: 'guard', ext: 'ts' }],
    });

    const adapter = await buildOpencodeAdapter(env, {
      externalIds: new Set(['plugin:guard']),
      externalBaseDir,
    });

    const entry: AdapterEntry = { id: 'plugin:not-external', nature: 'plugin', scope: 'user' };
    await expect(adapter.plan(entry, 'user', env)).rejects.toThrow(
      'All plugins must come from the remote checkout',
    );
  });
});

// ---------------------------------------------------------------------------
// guardrail / context — checkout resolution (native descriptor, no translation)
// ---------------------------------------------------------------------------

describe('buildOpencodeAdapter — external guardrail/context from checkout', () => {
  it('loads the native permission.json descriptor verbatim into a merge-permission op', async () => {
    const descriptor: OpencodePermission = {
      read: { '.env.local': 'deny', '.env.example': 'allow' },
      bash: { 'rm -rf *': 'deny' },
    };
    const checkoutDir = await makeCheckoutDir(tmp.dir, {
      guardrailName: 'main',
      guardrailPermission: descriptor,
    });

    const adapter = await buildOpencodeAdapter(env, {
      externalIds: new Set(['guardrail:main']),
      externalBaseDir: checkoutDir,
    });

    const entry: AdapterEntry = { id: 'guardrail:main', nature: 'guardrail', scope: 'user' };
    const ops = await adapter.plan(entry, 'user', env);

    const permOp = ops.find((op) => op.kind === 'merge-permission') as
      | { kind: string; permission: OpencodePermission }
      | undefined;
    expect(permOp).toBeDefined();
    // The descriptor is installed verbatim — no translation, no lossy collapse.
    expect(permOp!.permission).toEqual(descriptor);
  });

  it('throws a MissingOpencodePermissionError when the external guardrail ships no permission.json', async () => {
    // guardrailName present but guardrailPermission omitted → the directory
    // exists with no descriptor: a native guardrail MUST ship one (never a
    // silent fallback to translation).
    const checkoutDir = await makeCheckoutDir(tmp.dir, { guardrailName: 'main' });

    await expect(
      buildOpencodeAdapter(env, {
        externalIds: new Set(['guardrail:main']),
        externalBaseDir: checkoutDir,
      }),
    ).rejects.toThrow(/missing or empty/);
  });

  it('loads agentsContent from checkout and poses it verbatim (no import block, R3.1)', async () => {
    const checkoutDir = await makeCheckoutDir(tmp.dir, {
      contextName: 'main',
      agentsMdContent: '# External Agents\nposed as-is.',
    });

    const adapter = await buildOpencodeAdapter(env, {
      externalIds: new Set(['context:main']),
      externalBaseDir: checkoutDir,
    });

    const entry: AdapterEntry = { id: 'context:main', nature: 'context', scope: 'user' };
    const ops = await adapter.plan(entry, 'user', env);

    const writeTextOp = ops.find((op) => op.kind === 'write-text');
    expect(writeTextOp).toBeDefined();
    expect((writeTextOp as { kind: string; content: string }).content).toBe(
      '# External Agents\nposed as-is.',
    );
  });
});

// ---------------------------------------------------------------------------
// mcp — resolved from effectiveEntries; environment/headers refs rendered (R5)
// ---------------------------------------------------------------------------

describe('buildOpencodeAdapter — mcp source resolution from effectiveEntries', () => {
  it('resolves server (id, "mcp:" stripped) and renders the env-ref to opencode native form', async () => {
    const effectiveEntries: Map<string, CatalogEntry> = new Map([
      [
        'mcp:my-server',
        {
          kind: 'artifact',
          id: 'mcp:my-server',
          nature: 'mcp',
          targets: ['opencode'],
          scopes: ['user'],
          config: {
            type: 'local',
            command: ['bunx', 'my-mcp-server'],
            environment: { TOKEN: '${MY_TOKEN}' },
          },
        },
      ],
    ]);

    const adapter = await buildOpencodeAdapter(env, { effectiveEntries });

    const entry: AdapterEntry = { id: 'mcp:my-server', nature: 'mcp', scope: 'user' };
    const ops = await adapter.plan(entry, 'user', env);

    const mcpOp = ops.find((op) => op.kind === 'merge-mcp') as
      | { kind: string; server: string; config: Record<string, unknown> }
      | undefined;
    expect(mcpOp).toBeDefined();
    expect(mcpOp!.server).toBe('my-server');
    // command/type pass through verbatim; the env-ref is rendered to opencode's
    // native `{env:VAR}` form (T0: opencode does not expand bash-style "${VAR}").
    expect(mcpOp!.config).toEqual({
      type: 'local',
      command: ['bunx', 'my-mcp-server'],
      environment: { TOKEN: '{env:MY_TOKEN}' },
    });
  });

  it('throws an actionable error when the mcp entry is missing from effectiveEntries', async () => {
    const adapter = await buildOpencodeAdapter(env, { effectiveEntries: new Map() });

    const entry: AdapterEntry = { id: 'mcp:unknown', nature: 'mcp', scope: 'user' };
    await expect(adapter.plan(entry, 'user', env)).rejects.toThrow(/mcp:unknown/);
  });

  it('throws an actionable error when the catalog entry has no config field', async () => {
    const effectiveEntries: Map<string, CatalogEntry> = new Map([
      [
        'mcp:no-config',
        {
          kind: 'artifact',
          id: 'mcp:no-config',
          nature: 'mcp',
          targets: ['opencode'],
          scopes: ['user'],
        },
      ],
    ]);

    const adapter = await buildOpencodeAdapter(env, { effectiveEntries });

    const entry: AdapterEntry = { id: 'mcp:no-config', nature: 'mcp', scope: 'user' };
    await expect(adapter.plan(entry, 'user', env)).rejects.toThrow(/config/);
  });
});

// ---------------------------------------------------------------------------
// mono-guardrail policy — ≥2 selected guardrails is a hard error (D6, ADR-0021)
// ---------------------------------------------------------------------------

describe('buildOpencodeAdapter — multiple guardrails selected (mono-guardrail policy)', () => {
  it('throws at build time, naming BOTH ids, when two guardrails are selected via the guardrail: prefix', async () => {
    const err = await buildOpencodeAdapter(env, {
      externalIds: new Set(['guardrail:alpha', 'guardrail:beta']),
    }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );

    expect(err).toBeInstanceOf(Error);
    // The message names every offending id (order-independent) and stays actionable.
    expect(err!.message).toContain('multiple guardrails selected for opencode');
    expect(err!.message).toContain('guardrail:alpha');
    expect(err!.message).toContain('guardrail:beta');
    expect(err!.message).toContain('select a single guardrail per install');
  });

  it('throws when the second guardrail is detected by nature only (union of both detection modes)', async () => {
    // One id carries the guardrail: prefix; the other has no prefix but its catalog
    // entry declares nature 'guardrail' — the filter must union both modes, not just
    // the prefixed one, so this counts as two guardrails and errors.
    const effectiveEntries: Map<string, CatalogEntry> = new Map([
      [
        'nature-only-guard',
        {
          kind: 'artifact',
          id: 'nature-only-guard',
          nature: 'guardrail',
          targets: ['opencode'],
          scopes: ['user'],
        },
      ],
    ]);

    await expect(
      buildOpencodeAdapter(env, {
        externalIds: new Set(['guardrail:alpha', 'nature-only-guard']),
        effectiveEntries,
      }),
    ).rejects.toThrow(/multiple guardrails selected for opencode/);
  });

  it('builds unchanged with exactly one guardrail among other selected ids (no throw, descriptor resolved)', async () => {
    // A single guardrail alongside a skill must still resolve its descriptor
    // verbatim — the filter isolates the one guardrail; behavior identical to before.
    const descriptor: OpencodePermission = { bash: { 'rm -rf *': 'deny' } };
    const checkoutDir = await makeCheckoutDir(tmp.dir, {
      guardrailName: 'main',
      guardrailPermission: descriptor,
      skillNames: ['x'],
    });

    const adapter = await buildOpencodeAdapter(env, {
      externalIds: new Set(['guardrail:main', 'skill:x']),
      externalBaseDir: checkoutDir,
    });

    const entry: AdapterEntry = { id: 'guardrail:main', nature: 'guardrail', scope: 'user' };
    const ops = await adapter.plan(entry, 'user', env);

    const permOp = ops.find((op) => op.kind === 'merge-permission') as
      | { kind: string; permission: OpencodePermission }
      | undefined;
    expect(permOp).toBeDefined();
    expect(permOp!.permission).toEqual(descriptor);
  });

  it('does not throw and leaves permission unset when no guardrail is selected', async () => {
    // externalIds present but none is a guardrail (by prefix or nature) → length 0,
    // permission stays unset (no merge-permission op) — unchanged from before.
    const checkoutDir = await makeCheckoutDir(tmp.dir, { skillNames: ['x'] });

    const adapter = await buildOpencodeAdapter(env, {
      externalIds: new Set(['skill:x']),
      externalBaseDir: checkoutDir,
    });

    const entry: AdapterEntry = { id: 'skill:x', nature: 'skill', scope: 'user' };
    const ops = await adapter.plan(entry, 'user', env);

    expect(ops.find((op) => op.kind === 'merge-permission')).toBeUndefined();
  });
});
