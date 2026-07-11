/**
 * Tests for R8 — backup at remove, parity with apply (engine.ts remove()).
 *
 * Requirement (docs/specs/lot2-remove-reversible/requirements.md, R8):
 *   engine.remove SHALL back up every config file targeted by a remove op
 *   BEFORE its first rewrite this run — parity with engine.apply. Previously
 *   only remove-deny / remove-block / delete-file were backed up; remove-hooks,
 *   remove-allow, remove-permission, remove-mcp rewrote settings.json /
 *   opencode.json with no safety net.
 *
 * Uses inline minimal adapters that implement planRemove / applyRemove.
 * No mocks of implementation — exercises real core logic (removeHook,
 * removePermission) against real files under a fresh tmp HOME.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Adapter, AdapterEntry } from '../src/adapter';
import { remove } from '../src/engine';
import { readJson, writeJson } from '../src/fs-json';
import { removeHook } from '../src/hooks';
import { readManifest, upsertEntry, writeManifest } from '../src/manifest';
import { removePermission } from '../src/opencode-json';
import { resolveOpencodeUserTargets, resolveUserTargets } from '../src/paths';
import type { Env } from '../src/paths';
import type { NatureReport, OpencodePermission, RemovalOp, Scope, WriteOp } from '../src/types';
import { makeTmpHome } from './tmp-home';

const ENTRY_NATURE = 'guardrail' as const;
const REF_DENY = ['Read(~/.ssh/**)', 'Write(~/.aws/**)'];
const HOOK_SPEC = { event: 'PreToolUse', matcher: 'Bash', command: 'bun run guard.ts' };

function makeCatalogEntry(id: string, scope: Scope = 'user'): AdapterEntry {
  return { id, nature: ENTRY_NATURE, scope };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let targets: ReturnType<typeof resolveUserTargets>;
let manifestPath: string;

beforeEach(async () => {
  tmp = await makeTmpHome('rigger-r8-remove-backup-');
  env = tmp.env;
  targets = resolveUserTargets(env);
  manifestPath = targets.stateJson;
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// R8: hook removal must back up settings.json
// ---------------------------------------------------------------------------

describe('lot2-R8: hook removal creates a settings.json backup', () => {
  it('lot2-R8: removing a hook creates a .bak of settings.json with pre-remove content', async () => {
    const ENTRY_ID = 'hook-entry';

    const adapter: Adapter = {
      id: 'claude',
      async audit(entry): Promise<NatureReport> {
        return { id: entry.id, nature: entry.nature, state: 'present' };
      },
      async plan(): Promise<WriteOp[]> {
        return [];
      },
      async apply(): Promise<void> {},
      async planRemove(_entry, _scope, envParam): Promise<RemovalOp[]> {
        const t = resolveUserTargets(envParam);
        return [{ kind: 'remove-hooks', path: t.claudeSettings, ...HOOK_SPEC }];
      },
      async applyRemove(ops, _env): Promise<void> {
        await Promise.all(
          ops.map(async (op) => {
            if (op.kind !== 'remove-hooks') return;
            const raw = await readJson(op.path);
            const next = removeHook(raw, {
              event: op.event,
              matcher: op.matcher,
              command: op.command,
            });
            await writeJson(op.path, next);
          }),
        );
      },
    };

    // Pre-remove state: the hook PLUS an unrelated marker, so we can assert
    // the .bak captures the state exactly as it was before the rewrite.
    const preRemoveState = {
      marker: 'pre-remove-hook',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: HOOK_SPEC.command }] }],
      },
    };
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, preRemoveState);

    let manifest = await readManifest(manifestPath);
    manifest = upsertEntry(manifest, {
      id: ENTRY_ID,
      nature: ENTRY_NATURE,
      ref: 'v0.0.0',
      sha: '',
      scope: 'user',
      installedAt: new Date().toISOString(),
      files: [targets.claudeSettings],
    });
    await writeManifest(manifestPath, manifest);

    const result = await remove(adapter, [makeCatalogEntry(ENTRY_ID)], 'user', env, manifestPath);

    expect(result.backedUp).toHaveLength(1);
    const bakExists = await fs.lstat(result.backedUp[0]!).then(() => true).catch(() => false);
    expect(bakExists).toBe(true);

    const bakContent = JSON.parse(await fs.readFile(result.backedUp[0]!, 'utf-8')) as unknown;
    expect(bakContent).toEqual(preRemoveState);

    // The live file no longer carries the hook (removal actually happened).
    const postState = await readJson(targets.claudeSettings);
    expect(postState['hooks']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// R8: opencode guardrail removal must back up opencode.json
// ---------------------------------------------------------------------------

describe('lot2-R8: opencode guardrail removal creates an opencode.json backup', () => {
  it('lot2-R8: removing an opencode guardrail creates a .bak of opencode.json with pre-remove content', async () => {
    const ENTRY_ID = 'opencode-guardrail-entry';
    const PERMISSION_FRAGMENT: OpencodePermission = { bash: { 'rm -rf *': 'deny' } };
    const opencodeTargets = resolveOpencodeUserTargets(env);

    const adapter: Adapter = {
      id: 'opencode',
      async audit(entry): Promise<NatureReport> {
        return { id: entry.id, nature: entry.nature, state: 'present' };
      },
      async plan(): Promise<WriteOp[]> {
        return [];
      },
      async apply(): Promise<void> {},
      async planRemove(_entry, _scope, envParam): Promise<RemovalOp[]> {
        const t = resolveOpencodeUserTargets(envParam);
        return [{
          kind: 'remove-permission',
          path: t.opencodeJson,
          permission: PERMISSION_FRAGMENT,
        }];
      },
      async applyRemove(ops, _env): Promise<void> {
        await Promise.all(
          ops.map(async (op) => {
            if (op.kind !== 'remove-permission') return;
            const raw = await readJson(op.path);
            const currentPermission = (raw['permission'] as OpencodePermission | undefined) ?? {};
            const updated = removePermission(currentPermission, op.permission);
            await writeJson(op.path, { ...raw, permission: updated });
          }),
        );
      },
    };

    const preRemoveState = {
      marker: 'pre-remove-opencode',
      permission: PERMISSION_FRAGMENT,
    };
    await fs.mkdir(path.dirname(opencodeTargets.opencodeJson), { recursive: true });
    await writeJson(opencodeTargets.opencodeJson, preRemoveState);

    let manifest = await readManifest(manifestPath);
    manifest = upsertEntry(manifest, {
      id: ENTRY_ID,
      nature: ENTRY_NATURE,
      ref: 'v0.0.0',
      sha: '',
      scope: 'user',
      installedAt: new Date().toISOString(),
      files: [opencodeTargets.opencodeJson],
      assistant: 'opencode',
    });
    await writeManifest(manifestPath, manifest);

    const result = await remove(adapter, [makeCatalogEntry(ENTRY_ID)], 'user', env, manifestPath);

    expect(result.backedUp).toHaveLength(1);
    const bakExists = await fs.lstat(result.backedUp[0]!).then(() => true).catch(() => false);
    expect(bakExists).toBe(true);

    const bakContent = JSON.parse(await fs.readFile(result.backedUp[0]!, 'utf-8')) as unknown;
    expect(bakContent).toEqual(preRemoveState);

    const postState = await readJson(opencodeTargets.opencodeJson);
    expect(postState['permission']).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// R8: dedup — a single .bak per file per run
// ---------------------------------------------------------------------------

describe('lot2-R8: a single backup per file even across several remove ops', () => {
  it('lot2-R8: a single .bak per file even when several remove ops target it', async () => {
    const HOOK_ENTRY_ID = 'hook-entry-dedup';
    const DENY_ENTRY_ID = 'deny-entry-dedup';

    // One adapter, two entries — planRemove returns a DIFFERENT op kind per
    // entry, but both ops target the SAME settings.json path. Only the
    // FIRST rewrite of the run should trigger a backup (parity with apply's
    // per-run, per-path dedup).
    const adapter: Adapter = {
      id: 'claude',
      async audit(entry): Promise<NatureReport> {
        return { id: entry.id, nature: entry.nature, state: 'present' };
      },
      async plan(): Promise<WriteOp[]> {
        return [];
      },
      async apply(): Promise<void> {},
      async planRemove(entry, _scope, envParam): Promise<RemovalOp[]> {
        const t = resolveUserTargets(envParam);
        if (entry.id === HOOK_ENTRY_ID) {
          return [{ kind: 'remove-hooks', path: t.claudeSettings, ...HOOK_SPEC }];
        }
        return [{ kind: 'remove-deny', path: t.claudeSettings, rules: REF_DENY }];
      },
      async applyRemove(ops, _env): Promise<void> {
        for (const op of ops) {
          if (op.kind === 'remove-hooks') {
            const raw = await readJson(op.path);
            const next = removeHook(raw, {
              event: op.event,
              matcher: op.matcher,
              command: op.command,
            });
            await writeJson(op.path, next);
          } else if (op.kind === 'remove-deny') {
            const raw = await readJson(op.path);
            const permissions = (raw['permissions'] as Record<string, unknown> | undefined) ?? {};
            const currentDeny: string[] = Array.isArray(permissions['deny'])
              ? (permissions['deny'] as string[])
              : [];
            const { removeDeny } = await import('../src/deny');
            const updated = removeDeny(currentDeny, op.rules);
            await writeJson(op.path, { ...raw, permissions: { ...permissions, deny: updated } });
          }
        }
      },
    };

    const preRemoveState = {
      marker: 'pre-remove-dedup',
      permissions: { deny: REF_DENY },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: HOOK_SPEC.command }] }],
      },
    };
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, preRemoveState);

    let manifest = await readManifest(manifestPath);
    for (const id of [HOOK_ENTRY_ID, DENY_ENTRY_ID]) {
      manifest = upsertEntry(manifest, {
        id,
        nature: ENTRY_NATURE,
        ref: 'v0.0.0',
        sha: '',
        scope: 'user',
        installedAt: new Date().toISOString(),
        files: [targets.claudeSettings],
      });
    }
    await writeManifest(manifestPath, manifest);

    const result = await remove(
      adapter,
      [makeCatalogEntry(HOOK_ENTRY_ID), makeCatalogEntry(DENY_ENTRY_ID)],
      'user',
      env,
      manifestPath,
    );

    // Exactly ONE backup for the whole run, even though two entries each
    // produced a remove op against the same settings.json.
    expect(result.backedUp).toHaveLength(1);

    // The single backup captures the ORIGINAL pre-remove state (before
    // EITHER op rewrote the file) — not an intermediate state.
    const bakContent = JSON.parse(await fs.readFile(result.backedUp[0]!, 'utf-8')) as unknown;
    expect(bakContent).toEqual(preRemoveState);

    // Both removals were actually applied to the live file.
    const postState = await readJson(targets.claudeSettings);
    expect(postState['hooks']).toBeUndefined();
    const postPermissions = postState['permissions'] as Record<string, unknown> | undefined;
    expect(postPermissions?.['deny']).toEqual([]);
  });
});
