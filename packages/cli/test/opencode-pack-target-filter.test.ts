/**
 * Regression tests for opencode-pack-target-filter.
 *
 * Bug (docs/specs/opencode-pack-target-filter/brief.md, workspace root): a pack
 * with one guardrail PER target (e.g. guardrail:claude + guardrail:opencode) is
 * legitimate — the user picks one assistant, not one guardrail. But
 * `runRemoteInstall` (remote-install.ts) computed the adapter's `externalIds`
 * from the RAW resolved pack members, before the target-routing filter that
 * `runInstall` (cmd-install.ts, step 1b) applies further down the pipeline. So
 * `buildOpencodeAdapter` saw BOTH guardrails and its mono-guardrail policy
 * (fix-bugs-cli-b5-b10, ADR-0021 — correct in itself: it protects against two
 * guardrails of the SAME target) fired on a mixed-target pack that should
 * install cleanly.
 *
 * Strategy mirrors remote-install-assistant.test.ts: tmpFactory returns a
 * pre-built "checkout" dir directly (no real git clone), a fake CommandRunner
 * answers ls-remote/clone/rev-parse, so the whole pipeline runs against real
 * files with no network access.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type CatalogEntry, type TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { findEntry, readManifest } from '@agent-rigger/core/manifest';
import { resolveOpencodeUserTargets, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { runRemoteInstall } from '../src/remote-install';

const TAG_NAME = 'v1.0.0';
const SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefx'.slice(0, 40);

// ---------------------------------------------------------------------------
// Catalog fixture
// ---------------------------------------------------------------------------

const GUARDRAIL_CLAUDE_ID = 'guardrail:claude-only';
const GUARDRAIL_OPENCODE_ID = 'guardrail:opencode-only';
const PACK_MIXED_ID = 'pack:secu';

const GUARDRAIL_OC_A_ID = 'guardrail:oc-a';
const GUARDRAIL_OC_B_ID = 'guardrail:oc-b';
const PACK_OC_DUP_ID = 'pack:oc-dup';

const DENY_RULE = 'Bash(rm -rf *)';
const PERMISSION_DESCRIPTOR = { bash: { 'rm -rf *': 'deny' as const } };

const CATALOG_ENTRIES: CatalogEntry[] = [
  {
    kind: 'artifact',
    id: GUARDRAIL_CLAUDE_ID,
    nature: 'guardrail',
    targets: ['claude'],
    scopes: ['user', 'project'],
  },
  {
    kind: 'artifact',
    id: GUARDRAIL_OPENCODE_ID,
    nature: 'guardrail',
    targets: ['opencode'],
    scopes: ['user', 'project'],
  },
  {
    kind: 'pack',
    id: PACK_MIXED_ID,
    targets: ['claude', 'opencode'],
    scopes: ['user', 'project'],
    // opencode-only listed FIRST: with the bug, externalIds is an unfiltered
    // Set built in this same insertion order — the claude adapter's `.find()`
    // over that Set would silently resolve THIS (wrong) guardrail for a
    // claude install instead of throwing, which is exactly the failure mode
    // this ordering is chosen to catch (not just the opencode throw).
    members: [GUARDRAIL_OPENCODE_ID, GUARDRAIL_CLAUDE_ID],
  },
  {
    kind: 'artifact',
    id: GUARDRAIL_OC_A_ID,
    nature: 'guardrail',
    targets: ['opencode'],
    scopes: ['user', 'project'],
  },
  {
    kind: 'artifact',
    id: GUARDRAIL_OC_B_ID,
    nature: 'guardrail',
    targets: ['opencode'],
    scopes: ['user', 'project'],
  },
  {
    kind: 'pack',
    id: PACK_OC_DUP_ID,
    targets: ['opencode'],
    scopes: ['user', 'project'],
    // Two guardrails targeting the SAME assistant — the mono-guardrail policy
    // (ADR-0021) must still block this pack, unchanged by the fix.
    members: [GUARDRAIL_OC_A_ID, GUARDRAIL_OC_B_ID],
  },
];

async function makeRemoteEnv(): Promise<{
  env: Env;
  homeDir: string;
  contentDir: string;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  manifestPath: string;
  cleanupAll: () => Promise<void>;
}> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-pack-target-filter-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-pack-target-filter-content-'));

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 'pack-target-filter-test' }, entries: CATALOG_ENTRIES }),
    'utf8',
  );

  const writeGuardrailDeny = async (name: string, deny: string[]): Promise<void> => {
    const dir = path.join(contentDir, 'claude', 'guardrails', name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'deny.json'), JSON.stringify({ deny }), 'utf8');
  };

  const writeGuardrailPermission = async (
    name: string,
    permission: Record<string, unknown>,
  ): Promise<void> => {
    const dir = path.join(contentDir, 'opencode', 'guardrails', name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'permission.json'), JSON.stringify({ permission }), 'utf8');
  };

  await writeGuardrailDeny('claude-only', [DENY_RULE]);
  await writeGuardrailPermission('opencode-only', PERMISSION_DESCRIPTOR);
  await writeGuardrailPermission('oc-a', { bash: { 'ls *': 'allow' } });
  await writeGuardrailPermission('oc-b', { bash: { 'cat *': 'allow' } });

  const env: Env = { RIGGER_HOME: homeDir };
  const manifestPath = path.join(homeDir, '.config', 'agent-rigger', 'state.json');

  const runner: CommandRunner = (_cmd, args) => {
    const argv = args ?? [];
    if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${SHA}\trefs/tags/${TAG_NAME}\n`,
        stderr: '',
      });
    }
    if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\tHEAD\n`, stderr: '' });
    }
    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' });
  };

  const tmpFactory: TmpDirFactory = async () => ({ path: contentDir, cleanup: async () => {} });

  const cleanupAll = async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(contentDir, { recursive: true, force: true });
  };

  return { env, homeDir, contentDir, runner, tmpFactory, manifestPath, cleanupAll };
}

let fixture: Awaited<ReturnType<typeof makeRemoteEnv>>;

beforeEach(async () => {
  fixture = await makeRemoteEnv();
});

afterEach(async () => {
  await fixture.cleanupAll();
});

describe('runRemoteInstall — pack target filter (opencode-pack-target-filter)', () => {
  it('installs a mixed-target pack for opencode, selecting only the opencode guardrail', async () => {
    const { env, runner, tmpFactory, manifestPath } = fixture;

    const result = await runRemoteInstall({
      ids: [PACK_MIXED_ID],
      catalogUrl: 'https://example.com/catalog.git',
      scope: 'user',
      env,
      manifestPath,
      runner,
      tmpFactory,
      confirm: true,
      assistant: 'opencode',
    });

    expect(result.applied).toBe(true);
    // The claude-only guardrail is excluded by target routing (E-targets),
    // never silently applied nor counted against opencode's mono-guardrail gate.
    expect(result.skipped.map((s) => s.id)).toContain(GUARDRAIL_CLAUDE_ID);

    const manifest = await readManifest(manifestPath);
    expect(findEntry(manifest, GUARDRAIL_OPENCODE_ID, 'user', 'opencode')).toBeDefined();
    expect(findEntry(manifest, GUARDRAIL_CLAUDE_ID, 'user', 'opencode')).toBeUndefined();

    const opencodeJson = JSON.parse(
      await Bun.file(resolveOpencodeUserTargets(env).opencodeJson).text(),
    ) as { permission?: Record<string, unknown> };
    expect(opencodeJson.permission).toEqual(PERMISSION_DESCRIPTOR);
  });

  it('installs the SAME mixed-target pack for claude, selecting only the claude guardrail', async () => {
    const { env, runner, tmpFactory, manifestPath } = fixture;

    const result = await runRemoteInstall({
      ids: [PACK_MIXED_ID],
      catalogUrl: 'https://example.com/catalog.git',
      scope: 'user',
      env,
      manifestPath,
      runner,
      tmpFactory,
      confirm: true,
      assistant: 'claude',
    });

    expect(result.applied).toBe(true);
    expect(result.skipped.map((s) => s.id)).toContain(GUARDRAIL_OPENCODE_ID);

    const manifest = await readManifest(manifestPath);
    expect(findEntry(manifest, GUARDRAIL_CLAUDE_ID, 'user', 'claude')).toBeDefined();
    expect(findEntry(manifest, GUARDRAIL_OPENCODE_ID, 'user', 'claude')).toBeUndefined();

    const settings = JSON.parse(
      await Bun.file(resolveUserTargets(env).claudeSettings).text(),
    ) as { permissions?: { deny?: string[] } };
    expect(settings.permissions?.deny).toContain(DENY_RULE);
  });

  it('still blocks a pack with two guardrails targeting the SAME assistant (mono-guardrail policy preserved)', async () => {
    const { env, runner, tmpFactory, manifestPath } = fixture;

    await expect(
      runRemoteInstall({
        ids: [PACK_OC_DUP_ID],
        catalogUrl: 'https://example.com/catalog.git',
        scope: 'user',
        env,
        manifestPath,
        runner,
        tmpFactory,
        confirm: true,
        assistant: 'opencode',
      }),
    ).rejects.toThrow(/multiple guardrails selected for opencode/);
  });
});
