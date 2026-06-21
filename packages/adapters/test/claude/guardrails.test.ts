/**
 * Tests for claude/guardrails handler (TDD — written before implementation).
 *
 * Covers:
 * - loadCanonicalDeny: reads deny.json fixture → array; absent → [].
 * - auditGuardrail: settings without deny → missing; all rules present → present.
 * - auditGuardrail: scope 'project' uses the correct path.
 * - planGuardrail: missing rules → 1 merge-deny op; complete → [].
 * - applyGuardrail: merges deny, preserves other keys (model, etc.), is idempotent.
 *
 * Isolation: every test uses a fresh RIGGER_HOME via makeTmpHome().
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readJson, writeJson } from '@agent-rigger/core/fs-json';
import { resolveProjectTargets, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import {
  applyGuardrail,
  auditGuardrail,
  loadCanonicalDeny,
  planGuardrail,
} from '../../src/claude/guardrails';

// Inline isolation helper — avoids cross-package imports, mirrors core/test/tmp-home.ts pattern.
async function makeTmpHome(prefix = 'rigger-adapters-'): Promise<{
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

const REF_DENY = ['Read(./.env)', 'Read(~/.ssh/**)', 'Read(./secrets/**)'];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;

beforeEach(async () => {
  tmp = await makeTmpHome('rigger-guardrails-');
  env = tmp.env;
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// loadCanonicalDeny
// ---------------------------------------------------------------------------

describe('loadCanonicalDeny', () => {
  it('reads deny array from a valid deny.json file', async () => {
    const denyPath = path.join(tmp.dir, 'deny.json');
    await writeJson(denyPath, { deny: ['Read(./.env)', 'Read(~/.ssh/**)'] });

    const result = await loadCanonicalDeny(denyPath);

    expect(result).toEqual(['Read(./.env)', 'Read(~/.ssh/**)']);
  });

  it('returns [] when the file does not exist', async () => {
    const denyPath = path.join(tmp.dir, 'nonexistent.json');

    const result = await loadCanonicalDeny(denyPath);

    expect(result).toEqual([]);
  });

  it('returns [] when deny field is absent in the file', async () => {
    const denyPath = path.join(tmp.dir, 'deny.json');
    await writeJson(denyPath, { other: 'value' });

    const result = await loadCanonicalDeny(denyPath);

    expect(result).toEqual([]);
  });

  it('returns [] when deny field is not an array', async () => {
    const denyPath = path.join(tmp.dir, 'deny.json');
    await writeJson(denyPath, { deny: 'not-an-array' });

    const result = await loadCanonicalDeny(denyPath);

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// auditGuardrail
// ---------------------------------------------------------------------------

describe('auditGuardrail', () => {
  it('returns state missing when settings.json does not exist', async () => {
    const report = await auditGuardrail('user', env, REF_DENY);

    expect(report.state).toBe('missing');
    expect(report.nature).toBe('guardrail');
  });

  it('returns state missing when settings.json has no deny rules', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, { model: 'sonnet' });

    const report = await auditGuardrail('user', env, REF_DENY);

    expect(report.state).toBe('missing');
  });

  it('returns state missing when some deny rules are absent', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      permissions: { deny: ['Read(./.env)'] },
    });

    const report = await auditGuardrail('user', env, REF_DENY);

    expect(report.state).toBe('missing');
  });

  it('returns state present when all deny rules are present', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      permissions: { deny: REF_DENY },
    });

    const report = await auditGuardrail('user', env, REF_DENY);

    expect(report.state).toBe('present');
    expect(report.id).toBeDefined();
    expect(report.nature).toBe('guardrail');
  });

  it('returns state present when settings has superset of ref deny rules', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      permissions: { deny: [...REF_DENY, 'Read(./extra/**)'] },
    });

    const report = await auditGuardrail('user', env, REF_DENY);

    expect(report.state).toBe('present');
  });

  it('uses project settings path for scope project', async () => {
    const cwd = tmp.dir;
    const targets = resolveProjectTargets(cwd);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      permissions: { deny: REF_DENY },
    });

    const report = await auditGuardrail('project', env, REF_DENY, cwd);

    expect(report.state).toBe('present');
  });

  it('returns missing for scope project when project settings missing rules', async () => {
    const cwd = tmp.dir;

    const report = await auditGuardrail('project', env, REF_DENY, cwd);

    expect(report.state).toBe('missing');
  });
});

// ---------------------------------------------------------------------------
// planGuardrail
// ---------------------------------------------------------------------------

describe('planGuardrail', () => {
  it('returns a merge-deny op when rules are missing', async () => {
    const ops = await planGuardrail('user', env, REF_DENY);

    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('merge-deny');
    expect((ops[0] as { kind: string; toAdd: string[] }).toAdd).toEqual(REF_DENY);
  });

  it('returns the correct path in the merge-deny op', async () => {
    const targets = resolveUserTargets(env);
    const ops = await planGuardrail('user', env, REF_DENY);

    expect(ops[0]!.path).toBe(targets.claudeSettings);
  });

  it('returns only the missing rules in toAdd (partial install)', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      permissions: { deny: ['Read(./.env)'] },
    });

    const ops = await planGuardrail('user', env, REF_DENY);

    expect(ops).toHaveLength(1);
    const op = ops[0] as { kind: string; toAdd: string[] };
    expect(op.toAdd).not.toContain('Read(./.env)');
    expect(op.toAdd).toContain('Read(~/.ssh/**)');
    expect(op.toAdd).toContain('Read(./secrets/**)');
  });

  it('returns empty array when all rules are already present', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      permissions: { deny: REF_DENY },
    });

    const ops = await planGuardrail('user', env, REF_DENY);

    expect(ops).toHaveLength(0);
  });

  it('uses project path for scope project', async () => {
    const cwd = tmp.dir;
    const targets = resolveProjectTargets(cwd);
    const ops = await planGuardrail('project', env, REF_DENY, cwd);

    expect(ops[0]!.path).toBe(targets.claudeSettings);
  });
});

// ---------------------------------------------------------------------------
// applyGuardrail
// ---------------------------------------------------------------------------

describe('applyGuardrail', () => {
  it('writes deny rules to settings.json', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, { permissions: { deny: [] } });

    const ops = [{ kind: 'merge-deny' as const, path: targets.claudeSettings, toAdd: REF_DENY }];
    await applyGuardrail(ops, env);

    const result = await readJson(targets.claudeSettings);
    const deny = ((result['permissions'] as Record<string, unknown>)['deny']) as string[];
    for (const rule of REF_DENY) {
      expect(deny).toContain(rule);
    }
  });

  it('preserves other keys in settings.json (model, theme, etc.)', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      model: 'claude-sonnet',
      theme: 'dark',
      customKey: 42,
      permissions: { deny: [], allowedTools: ['bash'] },
    });

    const ops = [{ kind: 'merge-deny' as const, path: targets.claudeSettings, toAdd: REF_DENY }];
    await applyGuardrail(ops, env);

    const result = await readJson(targets.claudeSettings);
    expect(result['model']).toBe('claude-sonnet');
    expect(result['theme']).toBe('dark');
    expect(result['customKey']).toBe(42);

    const perms = result['permissions'] as Record<string, unknown>;
    expect(Array.isArray(perms['allowedTools'])).toBe(true);
    expect(perms['allowedTools'] as string[]).toContain('bash');
  });

  it('is idempotent: applying twice yields same deny array', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, { permissions: { deny: [] } });

    const ops = [{ kind: 'merge-deny' as const, path: targets.claudeSettings, toAdd: REF_DENY }];
    await applyGuardrail(ops, env);
    const after1 = await readJson(targets.claudeSettings);
    const deny1 = ((after1['permissions'] as Record<string, unknown>)['deny']) as string[];

    await applyGuardrail(ops, env);
    const after2 = await readJson(targets.claudeSettings);
    const deny2 = ((after2['permissions'] as Record<string, unknown>)['deny']) as string[];

    expect(deny2).toEqual(deny1);
  });

  it('preserves pre-existing deny rules not in ref', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      permissions: { deny: ['Read(./private/**)'] },
    });

    const ops = [{ kind: 'merge-deny' as const, path: targets.claudeSettings, toAdd: REF_DENY }];
    await applyGuardrail(ops, env);

    const result = await readJson(targets.claudeSettings);
    const deny = ((result['permissions'] as Record<string, unknown>)['deny']) as string[];
    expect(deny).toContain('Read(./private/**)');
    for (const rule of REF_DENY) {
      expect(deny).toContain(rule);
    }
  });

  it('ignores ops that are not merge-deny kind', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, { model: 'sonnet', permissions: { deny: [] } });

    const ops = [
      { kind: 'write-json' as const, path: targets.claudeSettings, description: 'noop' },
    ];
    await applyGuardrail(ops, env);

    const result = await readJson(targets.claudeSettings);
    expect(result['model']).toBe('sonnet');
  });
});
