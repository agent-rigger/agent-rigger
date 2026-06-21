/**
 * Tests for engine.ts — apply() idempotence.
 *
 * Verifies:
 * 1. apply() → check() = exit 0 (all present after first apply)
 * 2. 2nd apply() = no-op: no new .bak files, manifest unchanged
 * 3. settings.json content after 2 applies == after 1 apply
 * 4. Non-deny keys in settings.json survive both applies (invariant §4)
 *
 * Uses the same realistic deny adapter as engine.check.test.ts.
 * Isolation: fresh tmp HOME per test via makeTmpHome().
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Adapter } from '../src/adapter';
import { computeMissingDeny, mergeDeny } from '../src/deny';
import { apply, check, reportExitCode } from '../src/engine';
import { readJson, writeJson } from '../src/fs-json';
import { readManifest } from '../src/manifest';
import { resolveUserTargets } from '../src/paths';
import type { Env } from '../src/paths';
import type { NatureReport, Scope, WriteOp } from '../src/types';
import { makeTmpHome } from './tmp-home';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REF_DENY = ['Read(~/.ssh/**)', 'Write(~/.aws/**)'];
const ENTRY_ID = 'guardrails-claude';

// ---------------------------------------------------------------------------
// Deny adapter (same logic as engine.check.test.ts)
// ---------------------------------------------------------------------------

function makeDenyAdapter(refDeny: string[] = REF_DENY): Adapter {
  return {
    id: 'claude',

    async audit(entry, _scope, env): Promise<NatureReport> {
      const targets = resolveUserTargets(env);
      const raw = await readJson(targets.claudeSettings);
      const permissions = raw['permissions'];
      const currentDeny: string[] = Array.isArray(
          (permissions as Record<string, unknown> | undefined)?.['deny'],
        )
        ? ((permissions as Record<string, unknown>)['deny'] as string[])
        : [];

      const missing = computeMissingDeny(refDeny, currentDeny);
      return missing.length === 0
        ? { id: entry.id, nature: entry.nature, state: 'present' }
        : { id: entry.id, nature: entry.nature, state: 'missing', detail: 'Missing rules' };
    },

    async plan(_entry, _scope, env): Promise<WriteOp[]> {
      const targets = resolveUserTargets(env);
      const raw = await readJson(targets.claudeSettings);
      const permissions = raw['permissions'];
      const currentDeny: string[] = Array.isArray(
          (permissions as Record<string, unknown> | undefined)?.['deny'],
        )
        ? ((permissions as Record<string, unknown>)['deny'] as string[])
        : [];

      const missing = computeMissingDeny(refDeny, currentDeny);
      if (missing.length === 0) return [];

      return [{ kind: 'merge-deny', path: targets.claudeSettings, toAdd: missing }];
    },

    async apply(ops, _env): Promise<void> {
      await Promise.all(
        ops.map(async (op) => {
          if (op.kind === 'merge-deny') {
            const raw = await readJson(op.path);
            const permissions = (raw['permissions'] as Record<string, unknown> | undefined) ?? {};
            const currentDeny: string[] = Array.isArray(permissions['deny'])
              ? (permissions['deny'] as string[])
              : [];
            const merged = mergeDeny(currentDeny, refDeny);
            await writeJson(op.path, { ...raw, permissions: { ...permissions, deny: merged } });
          }
        }),
      );
    },
  };
}

function makeCatalogEntry(id: string, scope: Scope = 'user') {
  return { id, nature: 'guardrail' as const, scope };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let targets: ReturnType<typeof resolveUserTargets>;
let manifestPath: string;

beforeEach(async () => {
  tmp = await makeTmpHome('rigger-idempotence-');
  env = tmp.env;
  targets = resolveUserTargets(env);
  manifestPath = targets.stateJson;
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count .bak-* files in a directory (non-recursive). */
async function countBakFiles(dir: string): Promise<number> {
  const exists = await Bun.file(dir).exists();
  if (!exists) return 0;
  const entries = await fs.readdir(dir);
  return entries.filter((e) => e.includes('.bak-')).length;
}

// ---------------------------------------------------------------------------
// apply() → check() = exit 0
// ---------------------------------------------------------------------------

describe('apply then check', () => {
  it('check exits 0 after a successful apply', async () => {
    const adapter = makeDenyAdapter();
    const entries = [makeCatalogEntry(ENTRY_ID)];

    await apply(adapter, entries, 'user', env, manifestPath);
    const report = await check(adapter, entries, 'user', env);

    expect(reportExitCode(report)).toBe(0);
    expect(report.entries[0]!.state).toBe('present');
  });

  it('apply writes the deny rules to settings.json', async () => {
    const adapter = makeDenyAdapter();
    const entries = [makeCatalogEntry(ENTRY_ID)];

    await apply(adapter, entries, 'user', env, manifestPath);

    const raw = await readJson(targets.claudeSettings);
    const permissions = raw['permissions'] as Record<string, unknown>;
    const deny = permissions['deny'] as string[];

    for (const rule of REF_DENY) {
      expect(deny).toContain(rule);
    }
  });

  it('apply writes a manifest entry', async () => {
    const adapter = makeDenyAdapter();
    const entries = [makeCatalogEntry(ENTRY_ID)];

    await apply(adapter, entries, 'user', env, manifestPath);

    const manifest = await readManifest(manifestPath);
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0]!.id).toBe(ENTRY_ID);
  });
});

// ---------------------------------------------------------------------------
// 2nd apply = no-op
// ---------------------------------------------------------------------------

describe('idempotence: 2nd apply is no-op', () => {
  it('creates backup on first apply, no new backup on second apply', async () => {
    const adapter = makeDenyAdapter();
    const entries = [makeCatalogEntry(ENTRY_ID)];
    const settingsDir = path.dirname(targets.claudeSettings);

    // Pre-create a settings.json so backup() has something to copy
    await fs.mkdir(settingsDir, { recursive: true });
    await writeJson(targets.claudeSettings, {
      permissions: { deny: [] },
      model: 'claude-sonnet',
    });

    // First apply: should create 1 backup
    const result1 = await apply(adapter, entries, 'user', env, manifestPath);
    const bakCountAfter1 = await countBakFiles(settingsDir);

    // Second apply: no new ops (adapter.plan returns []) → no new backup
    const result2 = await apply(adapter, entries, 'user', env, manifestPath);
    const bakCountAfter2 = await countBakFiles(settingsDir);

    expect(result1.backedUp.length).toBeGreaterThan(0);
    expect(result2.backedUp).toHaveLength(0);
    expect(bakCountAfter2).toBe(bakCountAfter1);
  });

  it('manifest is identical after 1st and 2nd apply', async () => {
    const adapter = makeDenyAdapter();
    const entries = [makeCatalogEntry(ENTRY_ID)];

    await apply(adapter, entries, 'user', env, manifestPath);
    const manifest1 = await readManifest(manifestPath);

    await apply(adapter, entries, 'user', env, manifestPath);
    const manifest2 = await readManifest(manifestPath);

    // Same number of entries, same id
    expect(manifest2.artifacts).toHaveLength(manifest1.artifacts.length);
    expect(manifest2.artifacts[0]!.id).toBe(manifest1.artifacts[0]!.id);
    // Installed files list unchanged
    expect(manifest2.artifacts[0]!.files).toEqual(manifest1.artifacts[0]!.files);
  });

  it('settings.json content is identical after 1st and 2nd apply', async () => {
    const adapter = makeDenyAdapter();
    const entries = [makeCatalogEntry(ENTRY_ID)];

    await apply(adapter, entries, 'user', env, manifestPath);
    const content1 = await readJson(targets.claudeSettings);

    await apply(adapter, entries, 'user', env, manifestPath);
    const content2 = await readJson(targets.claudeSettings);

    expect(content2).toEqual(content1);
  });

  it('non-deny keys in settings.json survive both applies (§4 invariant)', async () => {
    const adapter = makeDenyAdapter();
    const entries = [makeCatalogEntry(ENTRY_ID)];

    // Pre-create settings with non-deny keys
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      model: 'claude-sonnet',
      theme: 'dark',
      permissions: { deny: [] },
    });

    await apply(adapter, entries, 'user', env, manifestPath);
    await apply(adapter, entries, 'user', env, manifestPath);

    const final = await readJson(targets.claudeSettings);

    expect(final['model']).toBe('claude-sonnet');
    expect(final['theme']).toBe('dark');
  });

  it('deny array after 2nd apply equals deny array after 1st apply (no duplication)', async () => {
    const adapter = makeDenyAdapter();
    const entries = [makeCatalogEntry(ENTRY_ID)];

    // Start with one pre-existing deny rule that's NOT in ref
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      permissions: { deny: ['Read(./.env)'] },
    });

    await apply(adapter, entries, 'user', env, manifestPath);
    const raw1 = await readJson(targets.claudeSettings);
    const deny1 = ((raw1['permissions'] as Record<string, unknown>)['deny']) as string[];

    await apply(adapter, entries, 'user', env, manifestPath);
    const raw2 = await readJson(targets.claudeSettings);
    const deny2 = ((raw2['permissions'] as Record<string, unknown>)['deny']) as string[];

    expect(deny2).toEqual(deny1);
    // The pre-existing rule is preserved
    expect(deny2).toContain('Read(./.env)');
  });
});

// ---------------------------------------------------------------------------
// apply() — ApplyResult shape
// ---------------------------------------------------------------------------

describe('apply result shape', () => {
  it('returns written, backedUp, and manifest', async () => {
    const adapter = makeDenyAdapter();
    const entries = [makeCatalogEntry(ENTRY_ID)];

    // Pre-create so backup can fire
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, { permissions: { deny: [] } });

    const result = await apply(adapter, entries, 'user', env, manifestPath);

    expect(result).toHaveProperty('written');
    expect(result).toHaveProperty('backedUp');
    expect(result).toHaveProperty('manifest');
    expect(Array.isArray(result.written)).toBe(true);
    expect(Array.isArray(result.backedUp)).toBe(true);
  });

  it('result.written contains the settings.json path after apply', async () => {
    const adapter = makeDenyAdapter();
    const entries = [makeCatalogEntry(ENTRY_ID)];

    const result = await apply(adapter, entries, 'user', env, manifestPath);

    expect(result.written).toContain(targets.claudeSettings);
  });
});
