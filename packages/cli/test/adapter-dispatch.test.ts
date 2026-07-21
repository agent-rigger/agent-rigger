/**
 * Tests for adapter-dispatch.ts — buildAdapter(assistant, env, opts) routing (E4).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import type { Env } from '@agent-rigger/core/paths';
import type { WriteOpLink } from '@agent-rigger/core/types';

import { buildAdapter } from '../src/adapter-dispatch';

let tmp: string;
let env: Env;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-adapter-dispatch-'));
  env = { RIGGER_HOME: path.join(tmp, 'home') };
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('buildAdapter', () => {
  it('dispatches "claude" to a ClaudeAdapter (id: "claude")', async () => {
    const adapter = await buildAdapter('claude', env);
    expect(adapter.id).toBe('claude');
  });

  it('dispatches "opencode" to an OpencodeAdapter (id: "opencode")', async () => {
    const adapter = await buildAdapter('opencode', env);
    expect(adapter.id).toBe('opencode');
  });

  it('forwards opts.externalIds/externalBaseDir to the opencode builder', async () => {
    const externalBaseDir = path.join(tmp, 'checkout');
    const skillDir = path.join(externalBaseDir, 'common', 'skills', 'x');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# x');

    const adapter = await buildAdapter('opencode', env, {
      externalIds: new Set(['skill:x']),
      externalBaseDir,
    });

    const entry: AdapterEntry = { id: 'skill:x', nature: 'skill', scope: 'user' };
    const ops = await adapter.plan(entry, 'user', env);
    const linkOp = ops.find((op): op is WriteOpLink => op.kind === 'link');
    expect(linkOp).toBeDefined();
    expect(linkOp!.source).toBe(skillDir);
  });

  it('forwards opts.externalIds/externalBaseDir to the claude builder', async () => {
    const externalBaseDir = path.join(tmp, 'checkout');
    const skillDir = path.join(externalBaseDir, 'common', 'skills', 'x');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# x');

    const adapter = await buildAdapter('claude', env, {
      externalIds: new Set(['skill:x']),
      externalBaseDir,
    });

    const entry: AdapterEntry = { id: 'skill:x', nature: 'skill', scope: 'user' };
    const ops = await adapter.plan(entry, 'user', env);
    const linkOp = ops.find((op): op is WriteOpLink => op.kind === 'link');
    expect(linkOp).toBeDefined();
    expect(linkOp!.source).toBe(skillDir);
  });

  it('rejects "copilot" with an actionable error — reserved, not implemented (M4)', async () => {
    await expect(buildAdapter('copilot', env)).rejects.toThrow(/copilot/i);
  });
});
