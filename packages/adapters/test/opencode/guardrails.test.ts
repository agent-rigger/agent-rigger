/**
 * Tests for opencode/guardrails handler (TDD — written before implementation).
 *
 * Covers:
 * - auditGuardrail: nothing posed → missing; permission present in opencode.json → present.
 * - planGuardrail: missing rules → 1 merge-permission op (only the MISSING subset);
 *   already present → [].
 * - planRemoveGuardrail: installed → 1 remove-permission op (exact fragment); absent → [].
 * - applyGuardrail (merge-permission): merges into opencode.json, preserves $schema/mcp/
 *   pre-existing user permission leaves.
 * - applyRemoveGuardrail (remove-permission): removes exactly the managed leaves, preserves
 *   everything else.
 * - end-to-end via createOpencodeAdapter: check missing → apply → check present → remove →
 *   check missing, idempotent, opencode.json pre-populated survives the whole cycle.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { readJson, writeJson } from '@agent-rigger/core/fs-json';
import {
  resolveOpencodeProjectTargets,
  resolveOpencodeUserTargets,
} from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { OpencodePermission, WriteOpMergePermission } from '@agent-rigger/core/types';

import { createOpencodeAdapter } from '../../src/opencode/adapter';
import {
  applyGuardrail,
  applyRemoveGuardrail,
  auditGuardrail,
  planGuardrail,
  planRemoveGuardrail,
} from '../../src/opencode/guardrails';
import { translateRules } from '../../src/opencode/permission-translate';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-opencode-guardrails-'): Promise<{
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

const REF_DENY = ['Bash(rm -rf *)', 'Read(./.env)'];
const REF_ALLOW = ['Bash(ls *)'];

const PREPOPULATED = {
  $schema: 'https://opencode.ai/config.json',
  mcp: { existing: { type: 'remote' as const, url: 'https://example.com/mcp' } },
  permission: { edit: 'ask' as const },
};

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
// auditGuardrail
// ---------------------------------------------------------------------------

describe('auditGuardrail — user scope', () => {
  it('returns missing when opencode.json does not exist', async () => {
    const { permission } = translateRules(REF_DENY, REF_ALLOW);
    const report = await auditGuardrail('user', env, permission);

    expect(report.state).toBe('missing');
    expect(report.nature).toBe('guardrail');
    expect(report.id).toBe('guardrails-opencode');
  });

  it('returns missing when only some rules are present', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await writeJson(targets.opencodeJson, { permission: { bash: { 'rm -rf *': 'deny' } } });

    const { permission } = translateRules(REF_DENY, REF_ALLOW);
    const report = await auditGuardrail('user', env, permission);

    expect(report.state).toBe('missing');
  });

  it('returns present when all translated rules are present', async () => {
    const targets = resolveOpencodeUserTargets(env);
    const { permission } = translateRules(REF_DENY, REF_ALLOW);
    await writeJson(targets.opencodeJson, { permission });

    const report = await auditGuardrail('user', env, permission);

    expect(report.state).toBe('present');
  });
});

describe('auditGuardrail — project scope', () => {
  it('returns present when project opencode.json has the rules', async () => {
    const cwd = tmp.dir;
    const targets = resolveOpencodeProjectTargets(cwd);
    const { permission } = translateRules(REF_DENY, []);
    await writeJson(targets.opencodeJson, { permission });

    const report = await auditGuardrail('project', env, permission, cwd);

    expect(report.state).toBe('present');
  });
});

// ---------------------------------------------------------------------------
// planGuardrail
// ---------------------------------------------------------------------------

describe('planGuardrail', () => {
  it('returns a merge-permission op with the full fragment when opencode.json is absent', async () => {
    const { permission } = translateRules(REF_DENY, REF_ALLOW);
    const ops = await planGuardrail('user', env, permission);

    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('merge-permission');
    const op = ops[0] as WriteOpMergePermission;
    expect(op.permission).toEqual(permission);
  });

  it('returns only the MISSING subset when some rules already exist', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await writeJson(targets.opencodeJson, { permission: { bash: { 'rm -rf *': 'deny' } } });

    const { permission } = translateRules(REF_DENY, REF_ALLOW);
    const ops = await planGuardrail('user', env, permission);

    const op = ops[0] as WriteOpMergePermission;
    expect(op.permission).toEqual({ read: 'deny', bash: { 'ls *': 'allow' } });
  });

  it('returns [] when everything is already present (idempotent)', async () => {
    const targets = resolveOpencodeUserTargets(env);
    const { permission } = translateRules(REF_DENY, REF_ALLOW);
    await writeJson(targets.opencodeJson, { permission });

    const ops = await planGuardrail('user', env, permission);

    expect(ops).toHaveLength(0);
  });

  it('surfaces warnings on the op (not the description) when provided', async () => {
    const { permission } = translateRules(REF_DENY, REF_ALLOW);
    const ops = await planGuardrail('user', env, permission, undefined, ['a lossy rule warning']);

    const op = ops[0] as WriteOpMergePermission;
    expect(op.warnings).toEqual(['a lossy rule warning']);
    // Description stays clean — warnings have their own channel (HIGH-2).
    expect(op.description).not.toContain('a lossy rule warning');
  });

  it('op path targets the opencode.json path for the given scope', async () => {
    const targets = resolveOpencodeUserTargets(env);
    const { permission } = translateRules(REF_DENY, []);
    const ops = await planGuardrail('user', env, permission);

    const op = ops[0] as WriteOpMergePermission;
    expect(op.path).toBe(targets.opencodeJson);
  });

  it('does not emit an op when permission fragment is empty', async () => {
    const ops = await planGuardrail('user', env, {});

    expect(ops).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// planRemoveGuardrail
// ---------------------------------------------------------------------------

describe('planRemoveGuardrail', () => {
  it('returns [] when not installed', async () => {
    const { permission } = translateRules(REF_DENY, REF_ALLOW);
    const ops = await planRemoveGuardrail('user', env, permission);

    expect(ops).toHaveLength(0);
  });

  it('returns a remove-permission op with the exact applied fragment when installed', async () => {
    const targets = resolveOpencodeUserTargets(env);
    const { permission } = translateRules(REF_DENY, REF_ALLOW);
    await writeJson(targets.opencodeJson, { permission });

    const ops = await planRemoveGuardrail('user', env, permission);

    expect(ops).toEqual([{ kind: 'remove-permission', path: targets.opencodeJson, permission }]);
  });

  it('returns [] for an empty permission fragment', async () => {
    const ops = await planRemoveGuardrail('user', env, {});

    expect(ops).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// applyGuardrail
// ---------------------------------------------------------------------------

describe('applyGuardrail', () => {
  it('merges the permission fragment while preserving $schema, mcp, and existing permission leaves', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await writeJson(targets.opencodeJson, PREPOPULATED);

    const { permission } = translateRules(REF_DENY, REF_ALLOW);
    await applyGuardrail(
      [{ kind: 'merge-permission', path: targets.opencodeJson, permission, description: 'x' }],
      env,
    );

    const result = await readJson(targets.opencodeJson);
    expect(result['$schema']).toBe(PREPOPULATED.$schema);
    expect(result['mcp']).toEqual(PREPOPULATED.mcp);
    const resultPermission = result['permission'] as OpencodePermission;
    expect(resultPermission['edit']).toBe('ask');
    expect(resultPermission['read']).toBe('deny');
    expect(resultPermission['bash']).toEqual({ 'rm -rf *': 'deny', 'ls *': 'allow' });
  });

  it('is idempotent: applying twice does not duplicate or change the result', async () => {
    const targets = resolveOpencodeUserTargets(env);
    const { permission } = translateRules(REF_DENY, REF_ALLOW);

    await applyGuardrail(
      [{ kind: 'merge-permission', path: targets.opencodeJson, permission, description: 'x' }],
      env,
    );
    const once = await readJson(targets.opencodeJson);
    await applyGuardrail(
      [{ kind: 'merge-permission', path: targets.opencodeJson, permission, description: 'x' }],
      env,
    );
    const twice = await readJson(targets.opencodeJson);

    expect(twice).toEqual(once);
  });
});

// ---------------------------------------------------------------------------
// applyRemoveGuardrail
// ---------------------------------------------------------------------------

describe('applyRemoveGuardrail', () => {
  it('removes exactly the managed leaves, preserves $schema/mcp/other permission leaves', async () => {
    const targets = resolveOpencodeUserTargets(env);
    const { permission } = translateRules(REF_DENY, REF_ALLOW);
    await writeJson(targets.opencodeJson, {
      ...PREPOPULATED,
      permission: { ...PREPOPULATED.permission, ...permission },
    });

    await applyRemoveGuardrail(
      [{ kind: 'remove-permission', path: targets.opencodeJson, permission }],
      env,
    );

    const result = await readJson(targets.opencodeJson);
    expect(result['$schema']).toBe(PREPOPULATED.$schema);
    expect(result['mcp']).toEqual(PREPOPULATED.mcp);
    const resultPermission = result['permission'] as OpencodePermission;
    expect(resultPermission['edit']).toBe('ask');
    expect(resultPermission['read']).toBeUndefined();
    expect(resultPermission['bash']).toBeUndefined();
  });

  it('is a no-op when the fragment is already absent', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await writeJson(targets.opencodeJson, PREPOPULATED);

    const { permission } = translateRules(REF_DENY, REF_ALLOW);
    await applyRemoveGuardrail(
      [{ kind: 'remove-permission', path: targets.opencodeJson, permission }],
      env,
    );

    const result = await readJson(targets.opencodeJson);
    expect(result['permission']).toEqual(PREPOPULATED.permission);
  });
});

// ---------------------------------------------------------------------------
// end-to-end via createOpencodeAdapter
// ---------------------------------------------------------------------------

describe('createOpencodeAdapter — guardrail end-to-end', () => {
  const GUARDRAIL_ENTRY: AdapterEntry = {
    id: 'guardrails-opencode',
    nature: 'guardrail',
    scope: 'user',
  };

  it('check missing → apply → check present → remove → check missing (opencode.json pre-populated survives)', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await writeJson(targets.opencodeJson, PREPOPULATED);

    const adapter = createOpencodeAdapter({ denyRef: REF_DENY, allowRef: REF_ALLOW });

    const report1 = await adapter.audit(GUARDRAIL_ENTRY, 'user', env);
    expect(report1.state).toBe('missing');

    const ops = await adapter.plan(GUARDRAIL_ENTRY, 'user', env);
    expect(ops).toHaveLength(1);
    await adapter.apply(ops, env);

    const report2 = await adapter.audit(GUARDRAIL_ENTRY, 'user', env);
    expect(report2.state).toBe('present');

    const afterInstall = await readJson(targets.opencodeJson);
    expect(afterInstall['$schema']).toBe(PREPOPULATED.$schema);
    expect(afterInstall['mcp']).toEqual(PREPOPULATED.mcp);

    // 2nd plan is a no-op (idempotent)
    const ops2 = await adapter.plan(GUARDRAIL_ENTRY, 'user', env);
    expect(ops2).toHaveLength(0);

    const removeOps = await adapter.planRemove(GUARDRAIL_ENTRY, 'user', env);
    expect(removeOps).toHaveLength(1);
    await adapter.applyRemove(removeOps, env);

    const report3 = await adapter.audit(GUARDRAIL_ENTRY, 'user', env);
    expect(report3.state).toBe('missing');

    const afterRemove = await readJson(targets.opencodeJson);
    expect(afterRemove['$schema']).toBe(PREPOPULATED.$schema);
    expect(afterRemove['mcp']).toEqual(PREPOPULATED.mcp);
    expect((afterRemove['permission'] as OpencodePermission)['edit']).toBe('ask');
  });

  it('planRemove reconstructs the effective permission from entry.applied (offline, no re-translation)', async () => {
    const targets = resolveOpencodeUserTargets(env);
    const adapter = createOpencodeAdapter({ denyRef: REF_DENY, allowRef: REF_ALLOW });

    const ops = await adapter.plan(GUARDRAIL_ENTRY, 'user', env);
    await adapter.apply(ops, env);

    // Simulate an entry enriched from the manifest with a DIFFERENT (stale) denyRef context:
    // planRemove must use entry.applied, not re-translate from a (possibly changed) denyRef.
    const { permission: appliedPermission } = translateRules(REF_DENY, REF_ALLOW);
    const enriched: AdapterEntry = {
      ...GUARDRAIL_ENTRY,
      applied: { kind: 'opencode-permission', permission: appliedPermission },
    };

    const removeOps = await adapter.planRemove(enriched, 'user', env);
    expect(removeOps).toEqual([
      { kind: 'remove-permission', path: targets.opencodeJson, permission: appliedPermission },
    ]);
  });
});
