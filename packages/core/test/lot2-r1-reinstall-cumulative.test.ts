/**
 * E2E tests for R1 — the manifest `applied` payload cumulates across installs
 * (engine.ts apply() call-site merging into upsertEntry).
 *
 * Requirement (docs/specs/lot2-remove-reversible/requirements.md, R1):
 *   A re-install (drift repair, catalog update) plans only the DELTA; the
 *   manifest SHALL record the UNION of the pre-existing `applied` payload and
 *   that delta, per (id, scope, assistant). Otherwise `remove` orphans the
 *   rules of earlier runs — an orphaned permissions.allow rule permanently
 *   disables Claude Code's human-approval prompt — and `check` goes blind to
 *   their drift.
 *
 * Uses inline minimal adapters that mirror the real guardrail adapters:
 * plan computes the missing delta against a canonical set (computeMissingDeny /
 * computeMissingPermission), audit and planRemove work from `entry.applied`
 * (enriched by the engine from the manifest). Real core logic against real
 * files under a fresh tmp HOME — no mocks of implementation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { Adapter, AdapterEntry } from '../src/adapter';
import { computeMissingDeny, mergeDeny, removeDeny } from '../src/deny';
import { apply, check, remove, reportExitCode } from '../src/engine';
import { readJson, writeJson } from '../src/fs-json';
import { findEntry } from '../src/manifest';
import {
  computeMissingPermission,
  hasPermission,
  mergePermission,
  removePermission,
} from '../src/opencode-json';
import { resolveOpencodeUserTargets, resolveUserTargets } from '../src/paths';
import type { Env } from '../src/paths';
import type { NatureReport, OpencodePermission, RemovalOp, Scope, WriteOp } from '../src/types';
import { makeTmpHome } from './tmp-home';

const DENY_A = 'Bash(rm -rf *)';
const DENY_B = 'Bash(curl *)';
const ALLOW_X = 'Bash(git status:*)';
const ALLOW_Y = 'Bash(git log:*)';

function makeEntry(id: string, scope: Scope = 'user'): AdapterEntry {
  return { id, nature: 'guardrail', scope };
}

// ---------------------------------------------------------------------------
// settings.json helpers (permissions.deny / permissions.allow)
// ---------------------------------------------------------------------------

function readRules(settings: Record<string, unknown>, key: 'deny' | 'allow'): string[] {
  const permissions = (settings['permissions'] as Record<string, unknown> | undefined) ?? {};
  const value = permissions[key];
  return Array.isArray(value) ? value.filter((r): r is string => typeof r === 'string') : [];
}

async function writeRules(
  settingsPath: string,
  key: 'deny' | 'allow',
  rules: string[],
): Promise<void> {
  const raw = await readJson(settingsPath);
  const permissions = (raw['permissions'] as Record<string, unknown> | undefined) ?? {};
  await writeJson(settingsPath, { ...raw, permissions: { ...permissions, [key]: rules } });
}

/** Simulate user drift: hand-delete one rule from settings.json. */
async function userRemovesRule(
  settingsPath: string,
  key: 'deny' | 'allow',
  rule: string,
): Promise<void> {
  const settings = await readJson(settingsPath);
  await writeRules(settingsPath, key, readRules(settings, key).filter((r) => r !== rule));
}

// ---------------------------------------------------------------------------
// Inline claude-like guardrail adapter
// ---------------------------------------------------------------------------

/**
 * Minimal guardrail adapter mirroring adapters/claude/guardrails.ts:
 * - plan emits the DELTA (computeMissingDeny) against the canonical set;
 * - audit verifies settings.json against entry.applied (the manifest trace);
 * - planRemove reverses entry.applied exactly.
 */
function makeGuardrailAdapter(canonical: { deny: string[]; allow: string[] }): Adapter {
  return {
    id: 'claude',
    async audit(entry, _scope, envParam): Promise<NatureReport> {
      const t = resolveUserTargets(envParam);
      const settings = await readJson(t.claudeSettings);
      const applied = entry.applied;
      if (applied === undefined || applied.kind !== 'guardrail') {
        return { id: entry.id, nature: entry.nature, state: 'missing' };
      }
      const missingDeny = computeMissingDeny(applied.denyRules, readRules(settings, 'deny'));
      const missingAllow = computeMissingDeny(applied.allowRules, readRules(settings, 'allow'));
      return {
        id: entry.id,
        nature: entry.nature,
        state: missingDeny.length === 0 && missingAllow.length === 0 ? 'present' : 'missing',
      };
    },
    async plan(_entry, _scope, envParam): Promise<WriteOp[]> {
      const t = resolveUserTargets(envParam);
      const settings = await readJson(t.claudeSettings);
      const ops: WriteOp[] = [];
      const missingDeny = computeMissingDeny(canonical.deny, readRules(settings, 'deny'));
      if (missingDeny.length > 0) {
        ops.push({ kind: 'merge-deny', path: t.claudeSettings, toAdd: missingDeny });
      }
      const missingAllow = computeMissingDeny(canonical.allow, readRules(settings, 'allow'));
      if (missingAllow.length > 0) {
        ops.push({ kind: 'merge-allow', path: t.claudeSettings, toAdd: missingAllow });
      }
      return ops;
    },
    async apply(ops, _env): Promise<void> {
      for (const op of ops) {
        if (op.kind === 'merge-deny') {
          const settings = await readJson(op.path);
          await writeRules(op.path, 'deny', mergeDeny(readRules(settings, 'deny'), op.toAdd));
        } else if (op.kind === 'merge-allow') {
          const settings = await readJson(op.path);
          await writeRules(op.path, 'allow', mergeDeny(readRules(settings, 'allow'), op.toAdd));
        }
      }
    },
    async planRemove(entry, _scope, envParam): Promise<RemovalOp[]> {
      const t = resolveUserTargets(envParam);
      const applied = entry.applied;
      if (applied === undefined || applied.kind !== 'guardrail') {
        return [];
      }
      const ops: RemovalOp[] = [];
      if (applied.denyRules.length > 0) {
        ops.push({ kind: 'remove-deny', path: t.claudeSettings, rules: applied.denyRules });
      }
      if (applied.allowRules.length > 0) {
        ops.push({ kind: 'remove-allow', path: t.claudeSettings, rules: applied.allowRules });
      }
      return ops;
    },
    async applyRemove(ops, _env): Promise<void> {
      for (const op of ops) {
        if (op.kind === 'remove-deny') {
          const settings = await readJson(op.path);
          await writeRules(op.path, 'deny', removeDeny(readRules(settings, 'deny'), op.rules));
        } else if (op.kind === 'remove-allow') {
          const settings = await readJson(op.path);
          await writeRules(op.path, 'allow', removeDeny(readRules(settings, 'allow'), op.rules));
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Inline opencode-like permission adapter
// ---------------------------------------------------------------------------

/**
 * Minimal opencode guardrail adapter mirroring adapters/opencode/guardrails.ts:
 * plan emits only the missing permission sub-fragment; planRemove reverses the
 * `applied` fragment leaf by leaf.
 */
function makePermissionAdapter(canonical: OpencodePermission): Adapter {
  return {
    id: 'opencode',
    async audit(entry, _scope, envParam): Promise<NatureReport> {
      const t = resolveOpencodeUserTargets(envParam);
      const raw = await readJson(t.opencodeJson);
      const current = (raw['permission'] as OpencodePermission | undefined) ?? {};
      const applied = entry.applied;
      const present = applied !== undefined
        && applied.kind === 'opencode-permission'
        && hasPermission(current, applied.permission);
      return { id: entry.id, nature: entry.nature, state: present ? 'present' : 'missing' };
    },
    async plan(_entry, _scope, envParam): Promise<WriteOp[]> {
      const t = resolveOpencodeUserTargets(envParam);
      const raw = await readJson(t.opencodeJson);
      const current = (raw['permission'] as OpencodePermission | undefined) ?? {};
      const missing = computeMissingPermission(canonical, current);
      if (Object.keys(missing).length === 0) {
        return [];
      }
      return [{
        kind: 'merge-permission',
        path: t.opencodeJson,
        permission: missing,
        description: 'merge permission fragment',
      }];
    },
    async apply(ops, _env): Promise<void> {
      for (const op of ops) {
        if (op.kind !== 'merge-permission') continue;
        const raw = await readJson(op.path);
        const current = (raw['permission'] as OpencodePermission | undefined) ?? {};
        await writeJson(op.path, { ...raw, permission: mergePermission(current, op.permission) });
      }
    },
    async planRemove(entry, _scope, envParam): Promise<RemovalOp[]> {
      const applied = entry.applied;
      if (applied === undefined || applied.kind !== 'opencode-permission') {
        return [];
      }
      const t = resolveOpencodeUserTargets(envParam);
      return [{ kind: 'remove-permission', path: t.opencodeJson, permission: applied.permission }];
    },
    async applyRemove(ops, _env): Promise<void> {
      for (const op of ops) {
        if (op.kind !== 'remove-permission') continue;
        const raw = await readJson(op.path);
        const current = (raw['permission'] as OpencodePermission | undefined) ?? {};
        await writeJson(op.path, { ...raw, permission: removePermission(current, op.permission) });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let targets: ReturnType<typeof resolveUserTargets>;
let manifestPath: string;

beforeEach(async () => {
  tmp = await makeTmpHome('rigger-r1-reinstall-');
  env = tmp.env;
  targets = resolveUserTargets(env);
  manifestPath = targets.stateJson;
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// R1: drift repair — applied is the union, remove strips everything
// ---------------------------------------------------------------------------

describe('lot2-R1: drift repair cumulates the applied payload', () => {
  it('lot2-R1: repair install after user drift records the union and remove strips both rules', async () => {
    const ID = 'main/guardrail:base';
    const adapter = makeGuardrailAdapter({ deny: [DENY_A, DENY_B], allow: [] });

    // First install: empty settings → delta is the full canonical set.
    await apply({ adapter, entries: [makeEntry(ID)], scope: 'user', env, manifestPath });

    // User drift: hand-delete DENY_A from settings.json.
    await userRemovesRule(targets.claudeSettings, 'deny', DENY_A);

    // Repair install: the plan delta is [DENY_A] only.
    const result = await apply({
      adapter,
      entries: [makeEntry(ID)],
      scope: 'user',
      env,
      manifestPath,
    });

    // settings.json carries both rules again.
    const settings = await readJson(targets.claudeSettings);
    expect(new Set(readRules(settings, 'deny'))).toEqual(new Set([DENY_A, DENY_B]));

    // The manifest records the UNION, not the last delta.
    const entryAfter = findEntry(result.manifest, ID, 'user', 'claude');
    expect(entryAfter?.applied).toEqual({
      kind: 'guardrail',
      denyRules: [DENY_A, DENY_B],
      allowRules: [],
    });

    // ManifestEntry.files is a dedup union — settings.json appears exactly once.
    expect(entryAfter?.files).toEqual([targets.claudeSettings]);

    // A later remove strips BOTH rules from settings.json.
    await remove(adapter, [makeEntry(ID)], 'user', env, manifestPath);
    const postRemove = await readJson(targets.claudeSettings);
    expect(readRules(postRemove, 'deny')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R1: enriched canonical set (catalog v2) — no orphaned allow rule after remove
// ---------------------------------------------------------------------------

describe('lot2-R1: no orphaned allow rule after remove', () => {
  it('lot2-R1: catalog v2 adds an allow rule — remove leaves neither v1 nor v2 rule behind', async () => {
    const ID = 'main/guardrail:allow';

    // v1 install.
    const v1 = makeGuardrailAdapter({ deny: [], allow: [ALLOW_X] });
    await apply({ adapter: v1, entries: [makeEntry(ID)], scope: 'user', env, manifestPath });

    // Catalog v2 adds ALLOW_Y → re-install plans the delta [ALLOW_Y].
    const v2 = makeGuardrailAdapter({ deny: [], allow: [ALLOW_X, ALLOW_Y] });
    const result = await apply({
      adapter: v2,
      entries: [makeEntry(ID)],
      scope: 'user',
      env,
      manifestPath,
    });

    const entryAfter = findEntry(result.manifest, ID, 'user', 'claude');
    expect(entryAfter?.applied).toEqual({
      kind: 'guardrail',
      denyRules: [],
      allowRules: [ALLOW_X, ALLOW_Y],
    });

    // Security invariant: after remove, permissions.allow contains NEITHER
    // rule — an orphaned allow permanently disables the approval prompt.
    await remove(v2, [makeEntry(ID)], 'user', env, manifestPath);
    const postRemove = await readJson(targets.claudeSettings);
    expect(readRules(postRemove, 'allow')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R1: catalog v2 adds a deny rule — union recorded, remove strips both
// ---------------------------------------------------------------------------

describe('lot2-R1: catalog update cumulates deny rules', () => {
  it('lot2-R1: catalog v2 adds a deny rule — applied is the union and remove strips both', async () => {
    const ID = 'main/guardrail:deny-v2';

    const v1 = makeGuardrailAdapter({ deny: [DENY_A], allow: [] });
    await apply({ adapter: v1, entries: [makeEntry(ID)], scope: 'user', env, manifestPath });

    const v2 = makeGuardrailAdapter({ deny: [DENY_A, DENY_B], allow: [] });
    const result = await apply({
      adapter: v2,
      entries: [makeEntry(ID)],
      scope: 'user',
      env,
      manifestPath,
    });

    const entryAfter = findEntry(result.manifest, ID, 'user', 'claude');
    expect(entryAfter?.applied).toEqual({
      kind: 'guardrail',
      denyRules: [DENY_A, DENY_B],
      allowRules: [],
    });

    await remove(v2, [makeEntry(ID)], 'user', env, manifestPath);
    const postRemove = await readJson(targets.claudeSettings);
    expect(readRules(postRemove, 'deny')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R1: check is exact again after a repair
// ---------------------------------------------------------------------------

describe('lot2-R1: check audits against the cumulative payload', () => {
  it('lot2-R1: after repair, drift of a first-install rule is detected (exit 3)', async () => {
    const ID = 'main/guardrail:check';
    const adapter = makeGuardrailAdapter({ deny: [DENY_A, DENY_B], allow: [] });

    // Install → user deletes DENY_A → repair install (applied = union [A, B]).
    await apply({ adapter, entries: [makeEntry(ID)], scope: 'user', env, manifestPath });
    await userRemovesRule(targets.claudeSettings, 'deny', DENY_A);
    await apply({ adapter, entries: [makeEntry(ID)], scope: 'user', env, manifestPath });

    // User then deletes DENY_B — a rule whose delta belonged to the FIRST run.
    await userRemovesRule(targets.claudeSettings, 'deny', DENY_B);

    // check compares settings.json against the cumulative applied payload:
    // the drift of DENY_B must be detected, exit 3.
    const report = await check(adapter, [makeEntry(ID)], 'user', env, manifestPath);
    expect(report.entries[0]?.state).toBe('missing');
    expect(reportExitCode(report)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// R1: opencode merge-permission — previous fragment folded into the trace
// ---------------------------------------------------------------------------

describe('lot2-R1: opencode permission fragments cumulate per leaf', () => {
  it('lot2-R1: re-install folds the previous fragment and remove cleans both leaves', async () => {
    const ID = 'main/guardrail:opencode';
    const opencodeTargets = resolveOpencodeUserTargets(env);

    // v1: one bash leaf.
    const v1 = makePermissionAdapter({ bash: { 'rm -rf *': 'deny' } });
    await apply({ adapter: v1, entries: [makeEntry(ID)], scope: 'user', env, manifestPath });

    // v2 adds a webfetch leaf → re-install plans only the missing leaf.
    const v2 = makePermissionAdapter({ bash: { 'rm -rf *': 'deny' }, webfetch: 'ask' });
    const result = await apply({
      adapter: v2,
      entries: [makeEntry(ID)],
      scope: 'user',
      env,
      manifestPath,
    });

    // applied is the per-leaf fusion of both fragments.
    const entryAfter = findEntry(result.manifest, ID, 'user', 'opencode');
    expect(entryAfter?.applied).toEqual({
      kind: 'opencode-permission',
      permission: { bash: { 'rm -rf *': 'deny' }, webfetch: 'ask' },
    });

    // remove strips BOTH leaves from opencode.json.
    await remove(v2, [makeEntry(ID)], 'user', env, manifestPath);
    const postRemove = await readJson(opencodeTargets.opencodeJson);
    expect(postRemove['permission']).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// R1: the merge respects the (id, scope, assistant) identity
// ---------------------------------------------------------------------------

describe('lot2-R1: merge respects the triple identity', () => {
  it('lot2-R1: re-installing for claude leaves the opencode entry of the same id intact', async () => {
    const ID = 'shared/guardrail:multi';

    // Same id installed for BOTH assistants — two distinct manifest entries.
    const claudeV1 = makeGuardrailAdapter({ deny: [DENY_A], allow: [] });
    await apply({ adapter: claudeV1, entries: [makeEntry(ID)], scope: 'user', env, manifestPath });

    const opencode = makePermissionAdapter({ bash: { 'rm -rf *': 'deny' } });
    const afterOpencode = await apply({
      adapter: opencode,
      entries: [makeEntry(ID)],
      scope: 'user',
      env,
      manifestPath,
    });
    const opencodeSnapshot = structuredClone(
      findEntry(afterOpencode.manifest, ID, 'user', 'opencode'),
    );
    expect(opencodeSnapshot).toBeDefined();

    // Re-install claude with an enriched canonical set.
    const claudeV2 = makeGuardrailAdapter({ deny: [DENY_A, DENY_B], allow: [] });
    const result = await apply({
      adapter: claudeV2,
      entries: [makeEntry(ID)],
      scope: 'user',
      env,
      manifestPath,
    });

    // Only the (user, claude) entry was merged…
    const claudeEntry = findEntry(result.manifest, ID, 'user', 'claude');
    expect(claudeEntry?.applied).toEqual({
      kind: 'guardrail',
      denyRules: [DENY_A, DENY_B],
      allowRules: [],
    });

    // …the (user, opencode) entry is byte-identical to its pre-run state.
    const opencodeEntry = findEntry(result.manifest, ID, 'user', 'opencode');
    expect(opencodeEntry).toEqual(opencodeSnapshot);
  });
});
