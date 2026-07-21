/**
 * lib-nature-t6-layout-pins.test.ts — R9 path_match pins, one per nature that
 * materialises checkout content. Model: t4-scanner-apply-time.test.ts:258-296
 * (skill only, pre-cutover). This is the lockstep net (R9.1): a builder migrated
 * to the new layout while scan-paths stayed old — or the reverse — replays a scan
 * verdict over bytes that were never scanned, SILENTLY (the only bruyant sense is
 * the inverse). Each pin turns that silence into a red.
 *
 * The coupling is driven by scanPathFor, not asserted against a hardcoded literal:
 * every fixture is written AT `scanPathFor(entry, base)`, then the builder is
 * exercised against the same base. If the builder reads a different path than
 * scanPathFor scans, the op source diverges (skill/agent/hook/plugin) or the
 * content load misses (guardrail/context) — either way the pin fails. A pin that
 * merely re-derived the literal both sides compute would pass even if both drifted
 * the same way; placing the fixture at the SCANNED path removes that blind spot.
 *
 * skill/agent/hook/plugin — the builder's read path surfaces as a WriteOp source
 *   (WriteOpLink.source / merge-hooks scriptSource): pinned by equality/containment.
 * guardrail/context — content is loaded at build time (no op source): the fixture
 *   is placed at the scanned path and the load is asserted.
 * lib — pinned in lib-nature-t3-materialize.test.ts (source === scanPathFor(lib)[0]).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ArtifactEntry, CatalogEntry } from '@agent-rigger/catalog';
import type { AdapterEntry } from '@agent-rigger/core/adapter';
import type { Env } from '@agent-rigger/core/paths';
import type { WriteOpLink } from '@agent-rigger/core/types';

import { buildClaudeAdapter } from '../src/cli';
import { buildOpencodeAdapter } from '../src/opencode-adapter-builder';
import { scanPathFor } from '../src/scan-paths';

let tmpDir: string;
let base: string;
let env: Env;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t6-pins-'));
  base = path.join(tmpDir, 'checkout');
  env = { RIGGER_HOME: path.join(tmpDir, 'home') };
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** The single scan path for an entry (natures pinned here scan exactly one). */
function scanned(entry: ArtifactEntry): string {
  const paths = scanPathFor(entry, base);
  expect(paths).toHaveLength(1);
  return paths[0]!;
}

// ---------------------------------------------------------------------------
// skill / agent — WriteOpLink.source === scanPathFor(entry)[0]
// ---------------------------------------------------------------------------

describe('path_match pin — skill', () => {
  it('claude skillSource === scanPathFor(skill)[0] (common/skills/<name>)', async () => {
    const entry: ArtifactEntry = {
      kind: 'artifact',
      id: 'skill:demo',
      nature: 'skill',
      targets: ['claude'],
      scopes: ['user'],
    };
    const skillDir = scanned(entry);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# demo\nfixture');

    const adapter = await buildClaudeAdapter(env, {
      externalIds: new Set(['skill:demo']),
      externalBaseDir: base,
    });
    const ops = await adapter.plan(
      { id: 'skill:demo', nature: 'skill', scope: 'user' } as AdapterEntry,
      'user',
      env,
    );
    const linkOp = ops.find((op): op is WriteOpLink => op.kind === 'link');
    expect(linkOp).toBeDefined();
    expect(linkOp!.source).toBe(skillDir);
  });
});

describe('path_match pin — agent', () => {
  it('claude agentSource === scanPathFor(agent)[0] (common/agents/<name>.md)', async () => {
    const entry: ArtifactEntry = {
      kind: 'artifact',
      id: 'agent:demo',
      nature: 'agent',
      targets: ['claude'],
      scopes: ['user'],
    };
    const agentFile = scanned(entry);
    await fs.mkdir(path.dirname(agentFile), { recursive: true });
    await fs.writeFile(agentFile, '# demo\nagent');

    const adapter = await buildClaudeAdapter(env, {
      externalIds: new Set(['agent:demo']),
      externalBaseDir: base,
    });
    const ops = await adapter.plan(
      { id: 'agent:demo', nature: 'agent', scope: 'user' } as AdapterEntry,
      'user',
      env,
    );
    const linkOp = ops.find((op): op is WriteOpLink => op.kind === 'link');
    expect(linkOp).toBeDefined();
    expect(linkOp!.source).toBe(agentFile);
  });
});

// ---------------------------------------------------------------------------
// hook — merge-hooks scriptSource === scanPathFor(hook)[0] (claude/hooks)
// ---------------------------------------------------------------------------

describe('path_match pin — hook', () => {
  it('claude hookSpec scriptSource === scanPathFor(hook)[0]', async () => {
    const catalogEntry: CatalogEntry = {
      kind: 'artifact',
      id: 'hook:demo',
      nature: 'hook',
      targets: ['claude'],
      scopes: ['user'],
      event: 'PreToolUse',
      matcher: 'Bash',
    };
    const entry: ArtifactEntry = catalogEntry as ArtifactEntry;
    const hooksDir = scanned(entry);
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(path.join(hooksDir, 'demo.ts'), '// hook');

    const adapter = await buildClaudeAdapter(env, {
      externalIds: new Set(['hook:demo']),
      externalBaseDir: base,
      effectiveEntries: new Map([['hook:demo', catalogEntry]]),
    });
    const ops = await adapter.plan(
      { id: 'hook:demo', nature: 'hook', scope: 'user' } as AdapterEntry,
      'user',
      env,
    );
    const mergeOp = ops.find((op) => op.kind === 'merge-hooks') as
      | { kind: string; scriptSource: string }
      | undefined;
    expect(mergeOp).toBeDefined();
    expect(mergeOp!.scriptSource).toBe(hooksDir);
  });
});

// ---------------------------------------------------------------------------
// plugin — opencode WriteOpLink.source lives UNDER scanPathFor(plugin)[0]
// (the scan surface is the whole opencode/plugins dir; the source is a file in it)
// ---------------------------------------------------------------------------

describe('path_match pin — plugin (opencode)', () => {
  it('opencode pluginSource is a file directly under scanPathFor(plugin)[0]', async () => {
    const entry: ArtifactEntry = {
      kind: 'artifact',
      id: 'plugin:demo',
      nature: 'plugin',
      targets: ['opencode'],
      scopes: ['user'],
    };
    const pluginsDir = scanned(entry);
    await fs.mkdir(pluginsDir, { recursive: true });
    await fs.writeFile(path.join(pluginsDir, 'demo.ts'), '// plugin module');

    const adapter = await buildOpencodeAdapter(env, {
      externalIds: new Set(['plugin:demo']),
      externalBaseDir: base,
    });
    const ops = await adapter.plan(
      { id: 'plugin:demo', nature: 'plugin', scope: 'user' } as AdapterEntry,
      'user',
      env,
    );
    const linkOp = ops.find((op): op is WriteOpLink => op.kind === 'link');
    expect(linkOp).toBeDefined();
    expect(path.dirname(linkOp!.source)).toBe(pluginsDir);
  });
});

// ---------------------------------------------------------------------------
// guardrail — content loaded from scanPathFor(guardrail)[0], per target
// ---------------------------------------------------------------------------

describe('path_match pin — guardrail (claude)', () => {
  it('claude denyRef loads from scanPathFor(guardrail,[claude])[0]', async () => {
    const entry: ArtifactEntry = {
      kind: 'artifact',
      id: 'guardrail:main',
      nature: 'guardrail',
      targets: ['claude'],
      scopes: ['user'],
    };
    const grDir = scanned(entry);
    await fs.mkdir(grDir, { recursive: true });
    await fs.writeFile(path.join(grDir, 'deny.json'), JSON.stringify({ deny: ['Bash(rm **)'] }));
    await fs.writeFile(path.join(grDir, 'allow.json'), JSON.stringify({ allow: [] }));

    const adapter = await buildClaudeAdapter(env, {
      externalIds: new Set(['guardrail:main']),
      externalBaseDir: base,
    });
    const ops = await adapter.plan(
      { id: 'guardrail:main', nature: 'guardrail', scope: 'user' } as AdapterEntry,
      'user',
      env,
    );
    const denyOp = ops.find((op) => op.kind === 'merge-deny') as
      | { kind: string; toAdd: string[] }
      | undefined;
    expect(denyOp).toBeDefined();
    expect(denyOp!.toAdd).toContain('Bash(rm **)');
  });
});

describe('path_match pin — guardrail (opencode)', () => {
  it('opencode permission loads from scanPathFor(guardrail,[opencode])[0]', async () => {
    const entry: ArtifactEntry = {
      kind: 'artifact',
      id: 'guardrail:main',
      nature: 'guardrail',
      targets: ['opencode'],
      scopes: ['user'],
    };
    const grDir = scanned(entry);
    await fs.mkdir(grDir, { recursive: true });
    await fs.writeFile(
      path.join(grDir, 'permission.json'),
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        permission: { bash: { 'rm -rf *': 'deny' } },
      }),
    );

    const adapter = await buildOpencodeAdapter(env, {
      externalIds: new Set(['guardrail:main']),
      externalBaseDir: base,
    });
    const ops = await adapter.plan(
      { id: 'guardrail:main', nature: 'guardrail', scope: 'user' } as AdapterEntry,
      'user',
      env,
    );
    const permOp = ops.find((op) => op.kind === 'merge-permission') as
      | { kind: string; permission: Record<string, unknown> }
      | undefined;
    expect(permOp).toBeDefined();
    expect(permOp!.permission).toEqual({ bash: { 'rm -rf *': 'deny' } });
  });
});

// ---------------------------------------------------------------------------
// context — AGENTS.md loaded from scanPathFor(context)[0], per assistant (S8)
// ---------------------------------------------------------------------------

describe('path_match pin — context (claude)', () => {
  it('claude agentsContent loads from scanPathFor(context,[claude])[0]', async () => {
    const entry: ArtifactEntry = {
      kind: 'artifact',
      id: 'context:main',
      nature: 'context',
      targets: ['claude'],
      scopes: ['user'],
    };
    const agentsMd = scanned(entry); // .../claude/contexts/main/AGENTS.md
    await fs.mkdir(path.dirname(agentsMd), { recursive: true });
    await fs.writeFile(agentsMd, '# ctx\nfrom the scanned path');

    const adapter = await buildClaudeAdapter(env, {
      externalIds: new Set(['context:main']),
      externalBaseDir: base,
    });
    const ops = await adapter.plan(
      { id: 'context:main', nature: 'context', scope: 'user' } as AdapterEntry,
      'user',
      env,
    );
    const writeOp = ops.find((op) => op.kind === 'write-text') as
      | { kind: string; content: string }
      | undefined;
    expect(writeOp).toBeDefined();
    expect(writeOp!.content).toBe('# ctx\nfrom the scanned path');
  });
});

describe('path_match pin — context (opencode)', () => {
  it('opencode agentsContent loads from scanPathFor(context,[opencode])[0]', async () => {
    const entry: ArtifactEntry = {
      kind: 'artifact',
      id: 'context:main',
      nature: 'context',
      targets: ['opencode'],
      scopes: ['user'],
    };
    const agentsMd = scanned(entry); // .../opencode/contexts/main/AGENTS.md
    await fs.mkdir(path.dirname(agentsMd), { recursive: true });
    await fs.writeFile(agentsMd, '# ctx\nopencode scanned path');

    const adapter = await buildOpencodeAdapter(env, {
      externalIds: new Set(['context:main']),
      externalBaseDir: base,
    });
    const ops = await adapter.plan(
      { id: 'context:main', nature: 'context', scope: 'user' } as AdapterEntry,
      'user',
      env,
    );
    const writeOp = ops.find((op) => op.kind === 'write-text') as
      | { kind: string; content: string }
      | undefined;
    expect(writeOp).toBeDefined();
    expect(writeOp!.content).toBe('# ctx\nopencode scanned path');
  });
});

// ---------------------------------------------------------------------------
// multi-target — a bi-target guardrail returns ONE scan dir PER target (R9.4)
// ---------------------------------------------------------------------------

describe('multi-target scan union — guardrail targeting both assistants', () => {
  it('scanPathFor returns one dir per target — the union covers both builders', () => {
    const entry: ArtifactEntry = {
      kind: 'artifact',
      id: 'guardrail:dual',
      nature: 'guardrail',
      targets: ['claude', 'opencode'],
      scopes: ['user'],
    };
    expect(scanPathFor(entry, base)).toEqual([
      path.join(base, 'claude', 'guardrails', 'dual'),
      path.join(base, 'opencode', 'guardrails', 'dual'),
    ]);
  });
});
