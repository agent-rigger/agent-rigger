/**
 * R1 — the opencode guardrail lifecycle through the REAL adapter and engine:
 * re-install cumulates the applied permission fragment, and remove reverses
 * the CUMULATIVE trace leaf by leaf (lot2-remove-reversible, R1 fusion review).
 *
 * The core suite (core/test/r1-reinstall-cumulative.test.ts) proves the
 * engine-side merge against an inline adapter double; these tests drive
 * createOpencodeAdapter itself so the production planRemoveGuardrail path —
 * the one that decides removal from `entry.applied` against the live
 * opencode.json — is exercised end to end:
 *
 * - install v1 → install v2 (catalog adds a leaf) → remove: BOTH leaves leave
 *   opencode.json (a regression to all-or-nothing gating would silently keep
 *   them);
 * - the drifted variant: the user hand-edits ONE leaf after install → remove
 *   still strips every intact leaf, preserves the user's edited leaf, and the
 *   plan carries a warning naming it (never a silent global no-op — the exact
 *   "orphaned un-removable rule" class H5/R1 kills).
 *
 * Isolation: fresh RIGGER_HOME tmp dir per test — never touches the real ~/.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply, enrichWithApplied, remove } from '@agent-rigger/core/engine';
import { readJson, writeJson } from '@agent-rigger/core/fs-json';
import { findEntry, readManifest } from '@agent-rigger/core/manifest';
import { resolveOpencodeUserTargets, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { OpencodePermission } from '@agent-rigger/core/types';

import { createOpencodeAdapter } from '../../src/opencode/adapter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-r1-oc-guardrail-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

const ENTRY: AdapterEntry = { id: 'main/guardrail:secu', nature: 'guardrail', scope: 'user' };

const V1_PERMISSION: OpencodePermission = { bash: { 'rm -rf *': 'deny' } };
const V2_PERMISSION: OpencodePermission = { bash: { 'rm -rf *': 'deny' }, webfetch: 'ask' };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let manifestPath: string;
let opencodeJsonPath: string;

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
  manifestPath = resolveUserTargets(env).stateJson;
  opencodeJsonPath = resolveOpencodeUserTargets(env).opencodeJson;
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// R1 — v1 → v2 re-install → remove through the real opencode adapter
// ---------------------------------------------------------------------------

describe('R1: opencode guardrail re-install cumulates and remove reverses (real adapter)', () => {
  it('R1: install v1 then v2 then remove — both leaves leave opencode.json', async () => {
    // v1 install: one bash pattern leaf.
    const v1 = createOpencodeAdapter({ permission: V1_PERMISSION });
    await apply(v1, [ENTRY], 'user', env, manifestPath);

    // v2 install: the catalog adds a webfetch leaf — the plan is the DELTA.
    const v2 = createOpencodeAdapter({ permission: V2_PERMISSION });
    await apply(v2, [ENTRY], 'user', env, manifestPath);

    // The manifest trace is the CUMULATIVE fragment.
    const manifest = await readManifest(manifestPath);
    const entry = findEntry(manifest, ENTRY.id, 'user', 'opencode');
    expect(entry?.applied).toEqual({
      kind: 'opencode-permission',
      permission: V2_PERMISSION,
    });

    // remove reverses the cumulative trace: BOTH leaves leave opencode.json.
    const result = await remove(v2, [ENTRY], 'user', env, manifestPath);
    expect(result.removed).toEqual([ENTRY.id]);

    const cleaned = await readJson(opencodeJsonPath);
    const perm = (cleaned['permission'] as OpencodePermission | undefined) ?? {};
    expect(perm['bash']).toBeUndefined();
    expect(perm['webfetch']).toBeUndefined();

    const after = await readManifest(manifestPath);
    expect(findEntry(after, ENTRY.id, 'user', 'opencode')).toBeUndefined();
  });

  it('R1: one hand-edited leaf never blocks the removal of the others (drift variant)', async () => {
    const v1 = createOpencodeAdapter({ permission: V1_PERMISSION });
    await apply(v1, [ENTRY], 'user', env, manifestPath);
    const v2 = createOpencodeAdapter({ permission: V2_PERMISSION });
    await apply(v2, [ENTRY], 'user', env, manifestPath);

    // User drift: webfetch ask → allow, edited by hand in opencode.json.
    const settings = await readJson(opencodeJsonPath);
    const perm = { ...(settings['permission'] as OpencodePermission) };
    perm['webfetch'] = 'allow';
    await writeJson(opencodeJsonPath, { ...settings, permission: perm });

    // The removal plan warns about the drifted leaf (never a silent skip)…
    const manifest = await readManifest(manifestPath);
    const enriched = enrichWithApplied(ENTRY, manifest, 'opencode');
    const plannedOps = await v2.planRemove(enriched, 'user', env);
    const warnings = plannedOps.flatMap((op) =>
      'warnings' in op && Array.isArray(op.warnings) ? op.warnings : []
    );
    expect(warnings.join('\n')).toContain('webfetch');
    expect(warnings.join('\n')).toContain('was not removed');
    // …and still carries the destructive op for the intact leaves.
    expect(plannedOps.some((op) => op.kind === 'remove-permission')).toBe(true);

    // remove: the intact bash leaf is stripped, the user's webfetch edit is
    // preserved, and the entry leaves the manifest (no eternal orphan).
    const result = await remove(v2, [ENTRY], 'user', env, manifestPath);
    expect(result.removed).toEqual([ENTRY.id]);

    const cleaned = await readJson(opencodeJsonPath);
    const cleanedPerm = (cleaned['permission'] as OpencodePermission | undefined) ?? {};
    expect(cleanedPerm['bash']).toBeUndefined();
    expect(cleanedPerm['webfetch']).toBe('allow');

    const after = await readManifest(manifestPath);
    expect(findEntry(after, ENTRY.id, 'user', 'opencode')).toBeUndefined();
  });

  it('R1: a fully hand-removed fragment plans no destructive op and keeps the entry (idempotent)', async () => {
    const v1 = createOpencodeAdapter({ permission: V1_PERMISSION });
    await apply(v1, [ENTRY], 'user', env, manifestPath);

    // User removes the whole permission key by hand.
    const settings = await readJson(opencodeJsonPath);
    await writeJson(opencodeJsonPath, { ...settings, permission: {} });

    const result = await remove(v1, [ENTRY], 'user', env, manifestPath);

    expect(result.removed).toHaveLength(0);
    const after = await readManifest(manifestPath);
    expect(findEntry(after, ENTRY.id, 'user', 'opencode')).toBeDefined();
  });
});
