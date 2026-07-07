/**
 * End-to-end lifecycle tests for the opencode 'guardrail' nature.
 *
 * The guardrail is a NATIVE opencode `permission` descriptor (ADR-0020 "Option
 * A") — the handlers consume an OpencodePermission fragment directly, so these
 * tests feed a realistic descriptor subset (read/edit path-globs with an
 * allow carve-out, plus a bash leaf to exercise the M7 conflict path) and drive
 * the real handlers / createOpencodeAdapter with no mocks.
 *
 * These ADD the dimensions that guardrails.test.ts's existing E2E does NOT cover
 * (its E2E is user-scope + third-party key survival; its engine round-trip is
 * the FULLY-conflicting M7 case). Here we add:
 *
 * (a) PROJECT-scope full lifecycle against a pre-filled project opencode.json —
 *     plan → apply → present → idempotent plan [] → remove → missing, asserting
 *     foreign $schema/mcp/permission leaves survive BOTH the merge AND the remove.
 *     Project scope is driven through the real handlers with an explicit `cwd`
 *     (the codebase convention: the adapter's project branch reads process.cwd(),
 *     so project scope is never exercised through createOpencodeAdapter in tests).
 * (b) An explicit idempotence assertion: a second plan once the fragment is
 *     present returns [] (no phantom re-merge).
 * (c) A PARTIAL-conflict case: a pre-existing user leaf (bash "rm -rf *": "allow")
 *     conflicts with a managed deny leaf. Asserts the M7 warning is surfaced on
 *     the op AND the user leaf is preserved through apply (never clobbered to
 *     "deny") — proven load-bearingly by audit staying 'missing' after a
 *     successful apply (it would flip to 'present' had the leaf been overwritten).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { readJson, writeJson } from '@agent-rigger/core/fs-json';
import type { Env } from '@agent-rigger/core/paths';
import {
  resolveOpencodeProjectTargets,
  resolveOpencodeUserTargets,
} from '@agent-rigger/core/paths';
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

async function makeTmpHome(prefix = 'rigger-opencode-e2e-guardrail-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Constants — a realistic native descriptor subset
// ---------------------------------------------------------------------------

// A subset of the real catalog descriptor: read/edit path-globs (with an allow
// carve-out) plus a single bash leaf so the M7 conflict dimension is exercised.
const REF_PERMISSION: OpencodePermission = {
  read: { '.env.local': 'deny', '.env.example': 'allow' },
  edit: { '.env.local': 'deny', '.env.example': 'allow' },
  bash: { 'rm -rf *': 'deny' },
};

// Foreign project config: a $schema, an mcp server, and a permission leaf on a
// tool the guardrail never touches (webfetch). All must survive the merge AND
// the remove untouched.
const PROJECT_PREPOPULATED = {
  $schema: 'https://opencode.ai/config.json',
  mcp: { legacy: { type: 'remote' as const, url: 'https://example.com/legacy' } },
  permission: { webfetch: 'allow' as const },
};

// User config whose bash "rm -rf *" leaf CONFLICTS with the managed deny leaf
// (user says "allow", the guardrail wants "deny"). `webfetch` is a foreign leaf
// that must also survive the additive merge.
const CONFLICTING_USER_CONFIG = {
  $schema: 'https://opencode.ai/config.json',
  permission: { bash: { 'rm -rf *': 'allow' as const }, webfetch: 'allow' as const },
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
// (a) + (b) PROJECT-scope full lifecycle + explicit idempotence
// ---------------------------------------------------------------------------

describe('guardrail — project-scope full lifecycle (foreign leaves survive merge + remove)', () => {
  it('plan → apply → present → idempotent plan [] → remove → missing, project opencode.json foreign content preserved', async () => {
    const cwd = tmp.dir;
    const targets = resolveOpencodeProjectTargets(cwd);
    await writeJson(targets.opencodeJson, PROJECT_PREPOPULATED);

    const permission = REF_PERMISSION;

    // --- audit: managed leaves absent → missing (guards against a no-op install
    // reporting a false 'present' from the start) ---
    const before = await auditGuardrail('project', env, permission, cwd);
    expect(before.state).toBe('missing');

    // --- plan: one merge-permission op targeting the PROJECT opencode.json ---
    const ops = await planGuardrail('project', env, permission, cwd, []);
    expect(ops).toHaveLength(1);
    const mergeOp = ops[0] as WriteOpMergePermission;
    expect(mergeOp.kind).toBe('merge-permission');
    // Project scope resolves the path under cwd, NOT the user config dir.
    expect(mergeOp.path).toBe(targets.opencodeJson);
    expect(mergeOp.path).toBe(path.join(cwd, 'opencode.json'));
    // No conflict in the project fixture → the FULL fragment is missing/merged.
    expect(mergeOp.permission).toEqual(permission);

    // --- apply ---
    await applyGuardrail(ops, env);

    // --- audit: present (fails if apply was a no-op) ---
    const afterApply = await auditGuardrail('project', env, permission, cwd);
    expect(afterApply.state).toBe('present');

    // Foreign $schema / mcp / permission leaves survive the MERGE; managed leaves added.
    const merged = await readJson(targets.opencodeJson);
    expect(merged['$schema']).toBe(PROJECT_PREPOPULATED.$schema);
    expect(merged['mcp']).toEqual(PROJECT_PREPOPULATED.mcp);
    const mergedPerm = merged['permission'] as OpencodePermission;
    expect(mergedPerm['webfetch']).toBe('allow');
    expect(mergedPerm['read']).toEqual({ '.env.local': 'deny', '.env.example': 'allow' });
    expect(mergedPerm['edit']).toEqual({ '.env.local': 'deny', '.env.example': 'allow' });
    expect(mergedPerm['bash']).toEqual({ 'rm -rf *': 'deny' });

    // --- (b) explicit idempotence: a second plan while present is a no-op ---
    const idempotentOps = await planGuardrail('project', env, permission, cwd, []);
    expect(idempotentOps).toHaveLength(0);

    // --- planRemove → one remove-permission op with the exact applied fragment ---
    const removeOps = await planRemoveGuardrail('project', env, permission, cwd);
    expect(removeOps).toEqual([
      { kind: 'remove-permission', path: targets.opencodeJson, permission },
    ]);

    // --- applyRemove ---
    await applyRemoveGuardrail(removeOps, env);

    // --- audit: missing again (fails if remove was a no-op) ---
    const afterRemove = await auditGuardrail('project', env, permission, cwd);
    expect(afterRemove.state).toBe('missing');

    // Foreign content survives the REMOVE; only managed leaves are gone.
    const cleaned = await readJson(targets.opencodeJson);
    expect(cleaned['$schema']).toBe(PROJECT_PREPOPULATED.$schema);
    expect(cleaned['mcp']).toEqual(PROJECT_PREPOPULATED.mcp);
    const cleanedPerm = cleaned['permission'] as OpencodePermission;
    expect(cleanedPerm['webfetch']).toBe('allow');
    expect(cleanedPerm['read']).toBeUndefined();
    expect(cleanedPerm['edit']).toBeUndefined();
    expect(cleanedPerm['bash']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (c) PARTIAL conflict — M7 warning surfaced + user leaf preserved (not clobbered)
// ---------------------------------------------------------------------------

describe('createOpencodeAdapter — guardrail partial conflict (M7 warning + user leaf preserved)', () => {
  const ENTRY: AdapterEntry = { id: 'guardrails-opencode', nature: 'guardrail', scope: 'user' };

  it('surfaces the M7 conflict warning on the op and never clobbers the conflicting user bash leaf', async () => {
    const targets = resolveOpencodeUserTargets(env);
    await writeJson(targets.opencodeJson, CONFLICTING_USER_CONFIG);

    const adapter = createOpencodeAdapter({ permission: REF_PERMISSION });

    // --- plan: the op carries ONLY the non-conflicting missing subset ---
    const ops = await adapter.plan(ENTRY, 'user', env);
    expect(ops).toHaveLength(1);
    const op = ops[0] as WriteOpMergePermission;
    // The conflicting bash "rm -rf *" leaf is excluded; read/edit are still merged.
    expect(op.permission).toEqual({
      read: { '.env.local': 'deny', '.env.example': 'allow' },
      edit: { '.env.local': 'deny', '.env.example': 'allow' },
    });

    // --- (c) the M7 conflict warning is surfaced on the op ---
    expect(op.warnings).toBeDefined();
    const conflictWarning = (op.warnings ?? []).find((w) => w.includes('was not applied'));
    expect(conflictWarning).toBeDefined();
    expect(conflictWarning!).toContain('rm -rf *');
    expect(conflictWarning!).toContain('"deny"'); // the managed state that was dropped
    expect(conflictWarning!).toContain('allow'); // the preserved user value, rendered

    // --- apply ---
    await adapter.apply(ops, env);

    // --- the conflicting user leaf is PRESERVED (not clobbered to "deny") ---
    const result = await readJson(targets.opencodeJson);
    expect(result['$schema']).toBe(CONFLICTING_USER_CONFIG.$schema);
    const perm = result['permission'] as OpencodePermission;
    const bash = perm['bash'] as Record<string, string>;
    expect(bash['rm -rf *']).toBe('allow'); // user leaf intact, NOT overwritten
    // Non-conflicting managed leaves were still merged alongside it.
    expect(perm['read']).toEqual({ '.env.local': 'deny', '.env.example': 'allow' });
    expect(perm['edit']).toEqual({ '.env.local': 'deny', '.env.example': 'allow' });
    // Foreign leaf on an untouched tool survives.
    expect(perm['webfetch']).toBe('allow');

    // --- audit stays truthfully 'missing': the deny rule is NOT enforced,
    // precisely because the user's conflicting leaf was preserved. Had apply
    // clobbered "rm -rf *" to "deny", this would read 'present'. This is the
    // load-bearing link between "user leaf preserved" and the audit signal. ---
    const report = await adapter.audit(ENTRY, 'user', env);
    expect(report.state).toBe('missing');
  });
});
