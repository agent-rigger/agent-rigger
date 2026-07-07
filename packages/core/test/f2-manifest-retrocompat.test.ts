/**
 * F2 — Manifest backward-compatibility integration test (END-TO-END).
 *
 * Proves that a legacy manifest (state.json written by a pre-M3 version:
 * artifacts with NO `assistant` field, plus a stray legacy `source` field) is
 * routed to the assistant 'claude' with ZERO Claude regression, driven through
 * the REAL engine (check / apply / remove) and the REAL Claude adapter — against
 * a REAL temp state.json on disk, never a mock.
 *
 * This ADDS the integration dimension on top of the unit coverage in
 * manifest.test.ts (which already proves, at the pure-function level, that
 * findEntry/upsertEntry default a bare entry to 'claude' — :381-419 — and that
 * readManifest tolerates a stray `source` field — :139-163). Here the same
 * default is exercised through the engine's adapter routing AND its on-disk side
 * effects (settings.json + state.json), which the unit tests do not touch.
 *
 * Acceptance: every assertion FAILS if a legacy entry were ever routed to a
 * non-claude adapter, mis-selected by opencode, or silently dropped.
 *
 * Isolation: fresh RIGGER_HOME via tmp dir per test; afterEach removes the tree.
 * The Claude/Opencode adapters are imported by relative path — packages/core has
 * no dependency on packages/adapters, so the workspace package name does not
 * resolve from a core test; the source file does.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '../src/adapter';
import { apply, check, remove, reportExitCode } from '../src/engine';
import { readJson } from '../src/fs-json';
import { findEntry, readManifest } from '../src/manifest';
import type { Env } from '../src/paths';
import { resolveUserTargets } from '../src/paths';

import { createClaudeAdapter } from '../../adapters/src/claude/adapter';
import { createOpencodeAdapter } from '../../adapters/src/opencode/adapter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-f2-retrocompat-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/**
 * Rewrite the on-disk state.json into a pre-M3 legacy shape: strip the
 * `assistant` field from every artifact and inject a stray legacy `source`
 * field (mirrors manifest.test.ts's legacy `source` fixture). The `applied`
 * payload is intentionally kept — a manifest written after B-iii but before M3
 * has `applied` yet no `assistant`, which is the realistic legacy target.
 *
 * Operates on the raw JSON (not the typed Manifest) so the resulting file is
 * exactly what an OLD binary would have serialized.
 */
async function legacyizeManifest(manifestPath: string): Promise<void> {
  const raw = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as {
    version: number;
    artifacts: Array<Record<string, unknown>>;
  };
  raw.artifacts = raw.artifacts.map((entry) => {
    const { assistant: _assistant, ...rest } = entry;
    return { ...rest, source: 'internal' };
  });
  await fs.writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
}

/** Read the permissions.deny array from settings.json (or [] when absent). */
async function readDeny(settingsPath: string): Promise<string[]> {
  const settings = await readJson(settingsPath);
  const perms = settings['permissions'];
  if (perms === null || typeof perms !== 'object') return [];
  const deny = (perms as Record<string, unknown>)['deny'];
  return Array.isArray(deny) ? (deny as string[]) : [];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REF_DENY = ['Read(./.env)', 'Read(~/.ssh/**)', 'Read(./secrets/**)'];
const AGENTS_CONTENT = '# Managed AGENTS.md\nLegacy retro-compat fixture.\n';

const GUARDRAIL_ENTRY: AdapterEntry = {
  id: 'guardrails-claude',
  nature: 'guardrail',
  scope: 'user',
};
const CONTEXT_ENTRY: AdapterEntry = { id: 'context-claude', nature: 'context', scope: 'user' };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let targets: ReturnType<typeof resolveUserTargets>;
let manifestPath: string;

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
  targets = resolveUserTargets(env);
  manifestPath = targets.stateJson;
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// Legacy manifest is routed to the claude adapter (check + remove)
// ---------------------------------------------------------------------------

describe('legacy manifest routed to claude', () => {
  it('legacy state.json is genuinely pre-M3 shaped (no assistant, stray source, keeps applied)', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });
    await apply(adapter, [GUARDRAIL_ENTRY], 'user', env, manifestPath);
    await legacyizeManifest(manifestPath);

    // Guards the whole suite: assert the fixture really is legacy so no later
    // test passes vacuously against an already-stamped entry.
    const legacy = await readManifest(manifestPath);
    const entry = legacy.artifacts.find((e) => e.id === 'guardrails-claude');
    expect(entry).toBeDefined();
    expect(entry!.assistant).toBeUndefined();
    expect((entry as unknown as { source?: string }).source).toBe('internal');
    // The applied payload survived the down-conversion (realistic post-B-iii legacy).
    expect(entry!.applied?.kind).toBe('guardrail');

    // A bare entry resolves under the 'claude' identity (default), not opencode.
    expect(findEntry(legacy, 'guardrails-claude', 'user', 'claude')).toBeDefined();
    expect(findEntry(legacy, 'guardrails-claude', 'user', 'opencode')).toBeUndefined();
  });

  it('check routes the legacy entry to the claude adapter and audits it present', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });
    await apply(adapter, [GUARDRAIL_ENTRY], 'user', env, manifestPath);
    await legacyizeManifest(manifestPath);

    const report = await check(adapter, [GUARDRAIL_ENTRY], 'user', env, manifestPath);

    // 'present' proves the legacy entry was FOUND under the claude identity (not
    // short-circuited to 'missing' by the engine's manifest lookup) and audited
    // via its applied payload. A broken claude-default would report 'missing'.
    expect(reportExitCode(report)).toBe(0);
    expect(report.entries[0]!.state).toBe('present');
  });

  it('remove operates on the legacy entry (routes to claude, not skipped, not dropped)', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY });
    await apply(adapter, [GUARDRAIL_ENTRY], 'user', env, manifestPath);
    await legacyizeManifest(manifestPath);

    // Precondition: managed deny rules really are on disk before remove.
    const denyBefore = await readDeny(targets.claudeSettings);
    for (const rule of REF_DENY) expect(denyBefore).toContain(rule);

    const result = await remove(adapter, [GUARDRAIL_ENTRY], 'user', env, manifestPath);

    // The legacy entry was claimed by the claude adapter — not silently skipped
    // (which is how a mis-routed / opencode-treated legacy entry would present).
    expect(result.removed).toContain('guardrails-claude');

    // Disk side effect: the managed deny rules are gone from settings.json.
    const denyAfter = await readDeny(targets.claudeSettings);
    for (const rule of REF_DENY) expect(denyAfter).not.toContain(rule);

    // Manifest side effect: the legacy claude entry is dropped from state.json.
    const after = await readManifest(manifestPath);
    expect(findEntry(after, 'guardrails-claude', 'user', 'claude')).toBeUndefined();
    expect(after.artifacts.some((e) => e.id === 'guardrails-claude')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A legacy entry is NOT mis-selected when the user targets opencode
// ---------------------------------------------------------------------------

describe('legacy entry is not mis-selected by opencode', () => {
  it('opencode check does not see the legacy claude entry as present', async () => {
    const claude = createClaudeAdapter({ denyRef: REF_DENY });
    await apply(claude, [GUARDRAIL_ENTRY], 'user', env, manifestPath);
    await legacyizeManifest(manifestPath);

    const opencode = createOpencodeAdapter({});
    const report = await check(opencode, [GUARDRAIL_ENTRY], 'user', env, manifestPath);

    // The legacy entry lives under the claude identity only; opencode's lookup
    // must not resolve it, so its audit reports 'missing' (nothing installed for
    // opencode), never 'present' off the back of the claude entry.
    expect(report.entries[0]!.state).toBe('missing');
    expect(reportExitCode(report)).toBe(3);
  });

  it('opencode remove is a no-op: it neither drops the legacy entry nor touches claude settings', async () => {
    const claude = createClaudeAdapter({ denyRef: REF_DENY });
    await apply(claude, [GUARDRAIL_ENTRY], 'user', env, manifestPath);
    await legacyizeManifest(manifestPath);

    const opencode = createOpencodeAdapter({});
    const result = await remove(opencode, [GUARDRAIL_ENTRY], 'user', env, manifestPath);

    // opencode must NOT claim the legacy claude entry.
    expect(result.removed).not.toContain('guardrails-claude');
    expect(result.removed).toHaveLength(0);

    // The claude-managed deny rules are untouched by an opencode remove.
    const deny = await readDeny(targets.claudeSettings);
    for (const rule of REF_DENY) expect(deny).toContain(rule);

    // The legacy entry survives — still resolvable under claude, still invisible
    // under opencode (identity is the (id, scope, assistant) triple).
    const after = await readManifest(manifestPath);
    expect(findEntry(after, 'guardrails-claude', 'user', 'claude')).toBeDefined();
    expect(findEntry(after, 'guardrails-claude', 'user', 'opencode')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A fresh claude entry coexists with a legacy entry (no clobber)
// ---------------------------------------------------------------------------

describe('fresh claude entry coexists with a legacy entry', () => {
  it('installing a fresh claude artifact next to a legacy one keeps both, both auditable and removable', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    // 1) Install a guardrail, then down-convert it to a pre-M3 legacy entry.
    await apply(adapter, [GUARDRAIL_ENTRY], 'user', env, manifestPath);
    await legacyizeManifest(manifestPath);

    // 2) Freshly install a second artifact — the engine stamps assistant='claude'.
    await apply(adapter, [CONTEXT_ENTRY], 'user', env, manifestPath);

    // Coexistence on disk: two artifacts; the legacy one still has NO assistant
    // (the fresh install did not clobber or re-stamp it), the fresh one is
    // stamped 'claude'.
    const manifest = await readManifest(manifestPath);
    expect(manifest.artifacts).toHaveLength(2);
    const legacy = manifest.artifacts.find((e) => e.id === 'guardrails-claude');
    const fresh = manifest.artifacts.find((e) => e.id === 'context-claude');
    expect(legacy).toBeDefined();
    expect(fresh).toBeDefined();
    expect(legacy!.assistant).toBeUndefined();
    expect(fresh!.assistant).toBe('claude');

    // Both resolve under the claude identity.
    expect(findEntry(manifest, 'guardrails-claude', 'user', 'claude')).toBeDefined();
    expect(findEntry(manifest, 'context-claude', 'user', 'claude')).toBeDefined();

    // check: both audited present (exit 0) — the legacy entry is not regressed.
    const report = await check(
      adapter,
      [GUARDRAIL_ENTRY, CONTEXT_ENTRY],
      'user',
      env,
      manifestPath,
    );
    expect(reportExitCode(report)).toBe(0);
    expect(report.entries.every((e) => e.state === 'present')).toBe(true);

    // remove: both removed via the claude adapter; state.json ends up empty.
    const result = await remove(
      adapter,
      [GUARDRAIL_ENTRY, CONTEXT_ENTRY],
      'user',
      env,
      manifestPath,
    );
    expect(result.removed).toContain('guardrails-claude');
    expect(result.removed).toContain('context-claude');

    const after = await readManifest(manifestPath);
    expect(after.artifacts).toHaveLength(0);
  });
});
