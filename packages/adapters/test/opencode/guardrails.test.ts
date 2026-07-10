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
import { apply, check, remove } from '@agent-rigger/core/engine';
import { readJson, writeJson } from '@agent-rigger/core/fs-json';
import { findEntry, readManifest } from '@agent-rigger/core/manifest';
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

// Native opencode permission descriptors. The handlers consume an
// OpencodePermission fragment directly — no translation step (ADR-0020 "Option A").
const REF_PERMISSION: OpencodePermission = {
  bash: { 'rm -rf *': 'deny', 'ls *': 'allow' },
  read: 'deny',
};
const REF_PERMISSION_DENY_ONLY: OpencodePermission = {
  bash: { 'rm -rf *': 'deny' },
  read: 'deny',
};
const READ_DENY: OpencodePermission = { read: 'deny' };
const BASH_RM_DENY: OpencodePermission = { bash: { 'rm -rf *': 'deny' } };

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
    const permission = REF_PERMISSION;
    const report = await auditGuardrail('user', env, permission);

    expect(report.state).toBe('missing');
    expect(report.nature).toBe('guardrail');
    expect(report.id).toBe('guardrails-opencode');
  });

  it('returns missing when only some rules are present', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await writeJson(targets.opencodeJson, { permission: { bash: { 'rm -rf *': 'deny' } } });

    const permission = REF_PERMISSION;
    const report = await auditGuardrail('user', env, permission);

    expect(report.state).toBe('missing');
  });

  it('returns present when all translated rules are present', async () => {
    const targets = resolveOpencodeUserTargets(env);
    const permission = REF_PERMISSION;
    await writeJson(targets.opencodeJson, { permission });

    const report = await auditGuardrail('user', env, permission);

    expect(report.state).toBe('present');
  });

  it('returns missing for an empty permission fragment, never vacuously present', async () => {
    const targets = resolveOpencodeUserTargets(env);
    // opencode.json exists with unrelated content: an empty guardrail spec must
    // still audit 'missing' (no false-present of protection that is not installed).
    await writeJson(targets.opencodeJson, { permission: { bash: { 'ls *': 'allow' } } });

    expect((await auditGuardrail('user', env, {})).state).toBe('missing');
    expect((await auditGuardrail('user', env, { read: {} })).state).toBe('missing');
  });
});

describe('auditGuardrail — project scope', () => {
  it('returns present when project opencode.json has the rules', async () => {
    const cwd = tmp.dir;
    const targets = resolveOpencodeProjectTargets(cwd);
    const permission = REF_PERMISSION_DENY_ONLY;
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
    const permission = REF_PERMISSION;
    const ops = await planGuardrail('user', env, permission);

    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('merge-permission');
    const op = ops[0] as WriteOpMergePermission;
    expect(op.permission).toEqual(permission);
  });

  it('returns only the MISSING subset when some rules already exist', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await writeJson(targets.opencodeJson, { permission: { bash: { 'rm -rf *': 'deny' } } });

    const permission = REF_PERMISSION;
    const ops = await planGuardrail('user', env, permission);

    const op = ops[0] as WriteOpMergePermission;
    expect(op.permission).toEqual({ read: 'deny', bash: { 'ls *': 'allow' } });
  });

  it('returns [] when everything is already present (idempotent)', async () => {
    const targets = resolveOpencodeUserTargets(env);
    const permission = REF_PERMISSION;
    await writeJson(targets.opencodeJson, { permission });

    const ops = await planGuardrail('user', env, permission);

    expect(ops).toHaveLength(0);
  });

  it('surfaces warnings on the op (not the description) when provided', async () => {
    const permission = REF_PERMISSION;
    const ops = await planGuardrail('user', env, permission, undefined, ['a lossy rule warning']);

    const op = ops[0] as WriteOpMergePermission;
    expect(op.warnings).toEqual(['a lossy rule warning']);
    // Description stays clean — warnings have their own channel (HIGH-2).
    expect(op.description).not.toContain('a lossy rule warning');
  });

  it('op path targets the opencode.json path for the given scope', async () => {
    const targets = resolveOpencodeUserTargets(env);
    const permission = REF_PERMISSION_DENY_ONLY;
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
// planGuardrail — conflicting user config (M7)
// ---------------------------------------------------------------------------

describe('planGuardrail — conflicting user config (M7)', () => {
  it('warns on the op when a deny leaf is dropped because of a flat user state', async () => {
    const targets = resolveOpencodeUserTargets(env);
    // Flat "bash": "allow" blocks the nested "rm -rf *": "deny" leaf (never overwritten).
    await writeJson(targets.opencodeJson, { permission: { bash: 'allow' } });

    const permission = REF_PERMISSION;
    const ops = await planGuardrail('user', env, permission);

    expect(ops).toHaveLength(1);
    const op = ops[0] as WriteOpMergePermission;
    // Only the non-conflicting leaf is merged...
    expect(op.permission).toEqual({ read: 'deny' });
    // ...and the dropped deny leaf is reported, naming the rule and the user value.
    // "ls *": "allow" matches the user's flat "allow" → no warning for it.
    expect(op.warnings).toHaveLength(1);
    expect(op.warnings?.[0]).toContain('rm -rf *');
    expect(op.warnings?.[0]).toContain('"deny"');
    expect(op.warnings?.[0]).toContain('"allow"');
  });

  it('still emits a warning-carrying op when EVERY leaf conflicts (nothing missing)', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await writeJson(targets.opencodeJson, { permission: { bash: 'allow', read: 'ask' } });

    const permission = REF_PERMISSION;
    const ops = await planGuardrail('user', env, permission);

    // Nothing is mergeable, but the plan must NOT be silently empty (R10.4/R5.3).
    expect(ops).toHaveLength(1);
    const op = ops[0] as WriteOpMergePermission;
    expect(op.permission).toEqual({});
    expect(op.warnings).toHaveLength(2);
    const joined = (op.warnings ?? []).join('\n');
    expect(joined).toContain('rm -rf *');
    expect(joined).toContain('"read"');
    expect(joined).toContain('"ask"');
  });

  it('appends conflict warnings after the translation warnings on the same op', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await writeJson(targets.opencodeJson, { permission: { bash: 'allow' } });

    const permission = REF_PERMISSION;
    const ops = await planGuardrail('user', env, permission, undefined, ['a lossy rule warning']);

    const op = ops[0] as WriteOpMergePermission;
    expect(op.warnings?.[0]).toBe('a lossy rule warning');
    expect(op.warnings).toHaveLength(2);
    expect(op.warnings?.[1]).toContain('rm -rf *');
  });

  it('warns when a flat leaf is dropped because the user has a nested map for the tool', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await writeJson(targets.opencodeJson, { permission: { read: { '.env': 'allow' } } });

    // A path-glob deny that collapses onto the flat read leaf in this scenario.
    const permission = READ_DENY;
    const ops = await planGuardrail('user', env, permission);

    expect(ops).toHaveLength(1);
    const op = ops[0] as WriteOpMergePermission;
    expect(op.permission).toEqual({});
    expect(op.warnings).toHaveLength(1);
    expect(op.warnings?.[0]).toContain('"read"');
    expect(op.warnings?.[0]).toContain('"deny"');
  });

  it('stays silent ([] and no warnings) when a flat user state already enforces the same state', async () => {
    const targets = resolveOpencodeUserTargets(env);
    // Flat "bash": "deny" is broader than the nested deny leaf — same enforcement, no conflict.
    await writeJson(targets.opencodeJson, { permission: { bash: 'deny' } });

    const permission = BASH_RM_DENY;
    const ops = await planGuardrail('user', env, permission);

    expect(ops).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// planGuardrail — cross-pattern glob-overlap conflicts (F4, R10.4)
// ---------------------------------------------------------------------------

describe('planGuardrail — cross-pattern glob-overlap conflicts (F4, R10.4)', () => {
  // Mirrors the shipped catalog descriptor's read map: two globbed denies plus
  // the concrete `.env.example` allow carve-out that re-opens our own deny.
  const READ_SECRET_FRAGMENT: OpencodePermission = {
    read: {
      '*.env': 'deny',
      '*.env.*': 'deny',
      '.env.example': 'allow',
    },
  };

  it('warns when our concrete "allow" leaf overrides an overlapping user "deny" (fail-open)', async () => {
    const targets = resolveOpencodeUserTargets(env);
    // User denies every *.example file; opencode findLast lets our appended
    // ".env.example": "allow" (written LAST) win — a silent re-open without F4.
    await writeJson(targets.opencodeJson, { permission: { read: { '*.example': 'deny' } } });

    const ops = await planGuardrail('user', env, READ_SECRET_FRAGMENT);

    expect(ops).toHaveLength(1);
    const op = ops[0] as WriteOpMergePermission;
    // The exact-key detector stays silent (no shared key) — only F4 catches it.
    expect(op.warnings).toHaveLength(1);
    const warning = op.warnings?.[0] ?? '';
    expect(warning).toContain('.env.example');
    expect(warning).toContain('"allow"');
    expect(warning).toContain('*.example');
    expect(warning).toContain('"deny"');
    // The merge still applies the carve-out (warn, don't drop) — reversibility intact.
    expect((op.permission.read as Record<string, string>)['.env.example']).toBe('allow');
  });

  it('warns when our globbed "deny" leaf overrides an overlapping user "allow" (fail-secure)', async () => {
    const targets = resolveOpencodeUserTargets(env);
    // User explicitly permits one env file; our "*.env": "deny" matches it
    // (opencode's `*` crosses `/`) and, written LAST, nullifies the allow.
    await writeJson(targets.opencodeJson, {
      permission: { read: { 'config/prod.env': 'allow' } },
    });

    const ops = await planGuardrail('user', env, READ_SECRET_FRAGMENT);

    expect(ops).toHaveLength(1);
    const op = ops[0] as WriteOpMergePermission;
    expect(op.warnings).toHaveLength(1);
    const warning = op.warnings?.[0] ?? '';
    expect(warning).toContain('*.env');
    expect(warning).toContain('"deny"');
    expect(warning).toContain('config/prod.env');
    expect(warning).toContain('"allow"');
  });

  it('warns on a broad user deny (".*") that our ".env.example" allow re-opens', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await writeJson(targets.opencodeJson, { permission: { read: { '.*': 'deny' } } });

    const ops = await planGuardrail('user', env, READ_SECRET_FRAGMENT);

    const op = ops[0] as WriteOpMergePermission;
    expect(op.warnings).toHaveLength(1);
    expect(op.warnings?.[0]).toContain('.env.example');
    expect(op.warnings?.[0]).toContain('.*');
  });

  it('does NOT warn when the overlapping user leaf already enforces the same state', async () => {
    const targets = resolveOpencodeUserTargets(env);
    // User already denies config/prod.env; our "*.env": "deny" agrees → no flip.
    await writeJson(targets.opencodeJson, {
      permission: { read: { 'config/prod.env': 'deny' } },
    });

    const ops = await planGuardrail('user', env, READ_SECRET_FRAGMENT);

    expect(ops).toHaveLength(1);
    const op = ops[0] as WriteOpMergePermission;
    expect(op.warnings).toBeUndefined();
  });

  it('does NOT warn when the user map does not overlap any guardrail pattern', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await writeJson(targets.opencodeJson, {
      permission: { read: { 'docs/notes.md': 'deny' } },
    });

    const ops = await planGuardrail('user', env, READ_SECRET_FRAGMENT);

    const op = ops[0] as WriteOpMergePermission;
    expect(op.warnings).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// planRemoveGuardrail
// ---------------------------------------------------------------------------

describe('planRemoveGuardrail', () => {
  it('returns [] when not installed', async () => {
    const permission = REF_PERMISSION;
    const ops = await planRemoveGuardrail('user', env, permission);

    expect(ops).toHaveLength(0);
  });

  it('returns a remove-permission op with the exact applied fragment when installed', async () => {
    const targets = resolveOpencodeUserTargets(env);
    const permission = REF_PERMISSION;
    await writeJson(targets.opencodeJson, { permission });

    const ops = await planRemoveGuardrail('user', env, permission);

    expect(ops).toEqual([{ kind: 'remove-permission', path: targets.opencodeJson, permission }]);
  });

  it('returns [] for an empty permission fragment', async () => {
    const ops = await planRemoveGuardrail('user', env, {});

    expect(ops).toHaveLength(0);
  });

  it('R1: a single drifted leaf does not block the removal of the intact ones', async () => {
    const targets = resolveOpencodeUserTargets(env);
    // Recorded fragment: bash rm-rf deny + read deny. On disk the user flipped
    // `read` to "allow" — the remaining leaves must still be removable.
    await writeJson(targets.opencodeJson, {
      permission: { bash: { 'rm -rf *': 'deny', 'ls *': 'allow' }, read: 'allow' },
    });

    const ops = await planRemoveGuardrail('user', env, REF_PERMISSION);

    // The destructive op carries the FULL recorded fragment (removePermission
    // is exact-per-leaf: the drifted `read` leaf is left intact on apply)…
    expect(ops.filter((op) => op.kind === 'remove-permission')).toEqual([
      { kind: 'remove-permission', path: targets.opencodeJson, permission: REF_PERMISSION },
    ]);
    // …and the drifted leaf is named in a warning, never silently skipped.
    const warnings = ops.flatMap((op) =>
      'warnings' in op && Array.isArray(op.warnings) ? op.warnings : []
    );
    expect(warnings.join('\n')).toContain('"read"');
    expect(warnings.join('\n')).toContain('was not removed');
  });

  it('R1: every leaf drifted → warning-only plan (no destructive op, entry preserved by the engine)', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await writeJson(targets.opencodeJson, {
      permission: { bash: { 'rm -rf *': 'ask', 'ls *': 'deny' }, read: 'allow' },
    });

    const ops = await planRemoveGuardrail('user', env, REF_PERMISSION);

    expect(ops.filter((op) => op.kind === 'remove-permission')).toHaveLength(0);
    const leaveAlone = ops.find((op) => op.kind === 'leave-alone') as
      | { kind: 'leave-alone'; warnings: string[] }
      | undefined;
    expect(leaveAlone).toBeDefined();
    expect(leaveAlone!.warnings.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// applyGuardrail
// ---------------------------------------------------------------------------

describe('applyGuardrail', () => {
  it('merges the permission fragment while preserving $schema, mcp, and existing permission leaves', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await writeJson(targets.opencodeJson, PREPOPULATED);

    const permission = REF_PERMISSION;
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
    const permission = REF_PERMISSION;

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
    const permission = REF_PERMISSION;
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

    const permission = REF_PERMISSION;
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

    const adapter = createOpencodeAdapter({ permission: REF_PERMISSION });

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
    const adapter = createOpencodeAdapter({ permission: REF_PERMISSION });

    const ops = await adapter.plan(GUARDRAIL_ENTRY, 'user', env);
    await adapter.apply(ops, env);

    // Simulate an entry enriched from the manifest with its own applied payload:
    // planRemove must use entry.applied, not the (possibly changed) canonical descriptor.
    const appliedPermission = REF_PERMISSION;
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

// ---------------------------------------------------------------------------
// Engine round-trip — fully-conflicting install (M7 follow-up)
// ---------------------------------------------------------------------------

describe('engine round-trip — fully-conflicting install creates no phantom manifest entry (M7)', () => {
  it('warning-only plan applies nothing: no manifest entry, check stays missing, remove stays no-op', async () => {
    const targets = resolveOpencodeUserTargets(env);
    // Every translated leaf conflicts with the user's config:
    // read: 'deny' vs 'ask'; bash 'rm -rf *': 'deny' vs flat 'allow'
    // ('ls *': 'allow' is already satisfied by the flat 'allow').
    const userConfig = { permission: { bash: 'allow' as const, read: 'ask' as const } };
    await writeJson(targets.opencodeJson, userConfig);

    const adapter = createOpencodeAdapter({ permission: REF_PERMISSION });
    const entry: AdapterEntry = { id: 'guardrail:main', nature: 'guardrail', scope: 'user' };
    const manifestPath = path.join(tmp.dir, 'state.json');

    // The plan is a warning-carrying op with an EMPTY fragment (R10.4: not silent)...
    const ops = await adapter.plan(entry, 'user', env);
    expect(ops).toHaveLength(1);
    const op = ops[0] as WriteOpMergePermission;
    expect(op.permission).toEqual({});
    expect(op.warnings?.length).toBeGreaterThan(0);

    // ...but the engine must treat it as "nothing to apply": no write, no
    // manifest entry — a recorded applied:{} would flip check to a vacuous
    // 'present' and make remove a permanent silent no-op (phantom entry).
    const applyResult = await apply(adapter, [entry], 'user', env, manifestPath);
    expect(applyResult.written).toHaveLength(0);
    const manifest = await readManifest(manifestPath);
    expect(findEntry(manifest, 'guardrail:main', 'user', 'opencode')).toBeUndefined();

    // The user config is untouched (no no-op rewrite of opencode.json).
    expect(await readJson(targets.opencodeJson)).toEqual(userConfig);

    // check stays truthful: zero enforcement → 'missing' (pre-fix late signal preserved).
    const report = await check(adapter, [entry], 'user', env, manifestPath);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]!.state).toBe('missing');

    // remove is a truthful "not installed" no-op, not an unremovable phantom.
    const removeResult = await remove(adapter, [entry], 'user', env, manifestPath);
    expect(removeResult.removed).toHaveLength(0);
  });
});
