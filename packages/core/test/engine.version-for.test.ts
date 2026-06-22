/**
 * Tests for engine.apply() — versionFor seam (M1b-3 Part A).
 *
 * Verifies:
 * 1. apply() with versionFor → manifest entry carries the provided ref/sha.
 * 2. apply() without versionFor → manifest entry defaults to {ref:'v0.0.0', sha:''}.
 * 3. Existing tests (idempotence, apply result shape) remain unaffected by the new param.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Adapter, AdapterEntry } from '../src/adapter';
import { computeMissingDeny, mergeDeny } from '../src/deny';
import { apply } from '../src/engine';
import { readJson, writeJson } from '../src/fs-json';
import { readManifest } from '../src/manifest';
import { resolveUserTargets } from '../src/paths';
import type { Env } from '../src/paths';
import type { NatureReport, Scope, WriteOp } from '../src/types';
import { makeTmpHome } from './tmp-home';

// ---------------------------------------------------------------------------
// Shared fake adapter (deny-based, mirrors idempotence.test.ts)
// ---------------------------------------------------------------------------

const REF_DENY = ['Read(~/.ssh/**)', 'Write(~/.aws/**)'];

function makeDenyAdapter(): Adapter {
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

      const missing = computeMissingDeny(REF_DENY, currentDeny);
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

      const missing = computeMissingDeny(REF_DENY, currentDeny);
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
            const merged = mergeDeny(currentDeny, REF_DENY);
            await writeJson(op.path, { ...raw, permissions: { ...permissions, deny: merged } });
          }
        }),
      );
    },

    async planRemove() {
      return [];
    },

    async applyRemove(): Promise<void> {},
  };
}

function makeCatalogEntry(id: string, scope: Scope = 'user'): AdapterEntry {
  return { id, nature: 'guardrail', scope };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let targets: ReturnType<typeof resolveUserTargets>;
let manifestPath: string;

beforeEach(async () => {
  tmp = await makeTmpHome('rigger-version-for-');
  env = tmp.env;
  targets = resolveUserTargets(env);
  manifestPath = targets.stateJson;

  // Pre-create settings.json so the deny adapter can plan ops
  await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
  await writeJson(targets.claudeSettings, { permissions: { deny: [] } });
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// Part A-1: versionFor provided → manifest carries custom values
// ---------------------------------------------------------------------------

describe('apply() with versionFor', () => {
  it('manifest entry ref/sha match what versionFor returns', async () => {
    const adapter = makeDenyAdapter();
    const entries = [makeCatalogEntry('guardrails-claude')];

    const customVersion = { ref: 'v1.2.0', sha: 'abc123' };

    await apply(adapter, entries, 'user', env, manifestPath, () => customVersion);

    const manifest = await readManifest(manifestPath);
    const artifact = manifest.artifacts.find((a) => a.id === 'guardrails-claude');

    expect(artifact).toBeDefined();
    expect(artifact!.ref).toBe('v1.2.0');
    expect(artifact!.sha).toBe('abc123');
  });

  it('versionFor is called with the AdapterEntry being installed', async () => {
    const adapter = makeDenyAdapter();
    const entries = [makeCatalogEntry('guardrails-claude')];

    const calledWith: AdapterEntry[] = [];
    const versionFor = (entry: AdapterEntry) => {
      calledWith.push(entry);
      return { ref: 'v2.0.0', sha: 'deadbeef' };
    };

    await apply(adapter, entries, 'user', env, manifestPath, versionFor);

    expect(calledWith).toHaveLength(1);
    expect(calledWith[0]!.id).toBe('guardrails-claude');
  });

  it('installedAt is still an ISO date string when versionFor is provided', async () => {
    const adapter = makeDenyAdapter();
    const entries = [makeCatalogEntry('guardrails-claude')];

    await apply(adapter, entries, 'user', env, manifestPath, () => ({
      ref: 'v1.0.0',
      sha: 'cafebabe',
    }));

    const manifest = await readManifest(manifestPath);
    const artifact = manifest.artifacts.find((a) => a.id === 'guardrails-claude');

    expect(artifact).toBeDefined();
    expect(typeof artifact!.installedAt).toBe('string');
    expect(new Date(artifact!.installedAt).toISOString()).toBe(artifact!.installedAt);
  });
});

// ---------------------------------------------------------------------------
// Part A-2: without versionFor → defaults to {ref:'v0.0.0', sha:''}
// ---------------------------------------------------------------------------

describe('apply() without versionFor', () => {
  it('manifest entry defaults to ref:v0.0.0, sha:""', async () => {
    const adapter = makeDenyAdapter();
    const entries = [makeCatalogEntry('guardrails-claude')];

    await apply(adapter, entries, 'user', env, manifestPath);

    const manifest = await readManifest(manifestPath);
    const artifact = manifest.artifacts.find((a) => a.id === 'guardrails-claude');

    expect(artifact).toBeDefined();
    expect(artifact!.ref).toBe('v0.0.0');
    expect(artifact!.sha).toBe('');
  });
});
