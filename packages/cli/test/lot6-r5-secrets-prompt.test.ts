/**
 * lot6-r5-secrets-prompt.test.ts — R5: the TTY interactive prompt actually
 * runs on install (D5 point 2: "flag > prompt > non-TTY erreur actionnable").
 *
 * Bug this guards: resolveSecretOverrides/decideSecretOverride (secret-collect.ts)
 * were built and unit-tested (lot6-r5-secrets-cli.test.ts) but never called from
 * an install path — cli.ts's handleInstall only ever consumed parseSecretEnvFlags
 * (the --secret-env flag half). A declared secret's ref/VAR name can only be
 * asked for once the catalog is known (secrets[] lives in catalog.json), i.e.
 * AFTER checkout — so the seam is runRemoteInstall, not handleInstall. Without
 * this wiring, a TTY install of an mcp entry with an unresolved `required`
 * secret hard-failed (MissingRequiredSecretError) instead of ever prompting.
 *
 * Strategy mirrors remote-install-assistant.test.ts: tmpFactory returns a
 * pre-built checkout dir directly, a fake CommandRunner answers
 * ls-remote/clone/rev-parse, runRemoteInstall runs against real files with no
 * network access. `isTTY`/`secretPicker` are the new injectable seams.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type CatalogEntry, type SecretDecl, type TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { readJson } from '@agent-rigger/core/fs-json';
import { resolveOpencodeUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';
import type { OpencodeMcpServer } from '@agent-rigger/core/types';

import { runRemoteInstall } from '../src/remote-install';
import { MissingRequiredSecretError } from '../src/secret-collect';

const TAG_NAME = 'v1.0.0';
const SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

const MCP_GITHUB_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'mcp:github',
  nature: 'mcp',
  targets: ['opencode'],
  scopes: ['user'],
  config: {
    type: 'local',
    command: ['bunx', 'github-mcp'],
    environment: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
  },
  secrets: [
    { ref: 'GITHUB_TOKEN', prompt: 'GitHub personal access token', required: true },
  ],
};

async function makeRemoteEnv(): Promise<{
  env: Env;
  homeDir: string;
  contentDir: string;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  manifestPath: string;
  cleanupAll: () => Promise<void>;
}> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-r5-prompt-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-r5-prompt-content-'));

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 'r5-prompt-test' }, entries: [MCP_GITHUB_ENTRY] }),
    'utf8',
  );

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

describe('lot6-R5: the TTY prompt actually runs on install for an unresolved declared secret', () => {
  it('invokes the injected picker for the declared ref, and renders its answer', async () => {
    const { runner, tmpFactory, manifestPath } = fixture;
    // The prompted var must actually be present for renderMcpConfig's
    // presence check (a separate, later gate — R5 point 1) to succeed.
    const env: Env = { ...fixture.env, PROMPTED_VAR: 'present-value' };
    const promptedFor: SecretDecl[] = [];

    const result = await runRemoteInstall({
      ids: ['mcp:github'],
      catalogUrl: 'https://example.com/catalog.git',
      scope: 'user',
      env,
      manifestPath,
      runner,
      tmpFactory,
      confirm: true,
      assistant: 'opencode',
      scanner: stubScanner,
      isTTY: true,
      secretPicker: async (secret) => {
        promptedFor.push(secret);
        return 'PROMPTED_VAR';
      },
    });

    expect(result.applied).toBe(true);
    // The picker was invoked for exactly the declared ref — no --secret-env
    // override was passed, so decideSecretOverride's TTY branch is the only
    // way this could have happened.
    expect(promptedFor.map((s) => s.ref)).toEqual(['GITHUB_TOKEN']);

    const opencodeTargets = resolveOpencodeUserTargets(env);
    const onDisk = await readJson(opencodeTargets.opencodeJson);
    const mcp = onDisk['mcp'] as Record<string, OpencodeMcpServer>;
    // Rendered with the PROMPTED var name, not the ref's own default.
    expect((mcp['github'] as { environment?: Record<string, string> }).environment).toEqual({
      GITHUB_TOKEN: '{env:PROMPTED_VAR}',
    });
  });

  it('a --secret-env override wins outright — the picker is never invoked, even in a TTY', async () => {
    const { runner, tmpFactory, manifestPath } = fixture;
    const env: Env = { ...fixture.env, MY_PAT: 'present-value' };
    let pickerCalled = false;

    const result = await runRemoteInstall({
      ids: ['mcp:github'],
      catalogUrl: 'https://example.com/catalog.git',
      scope: 'user',
      env,
      manifestPath,
      runner,
      tmpFactory,
      confirm: true,
      assistant: 'opencode',
      scanner: stubScanner,
      isTTY: true,
      secretOverrides: { GITHUB_TOKEN: 'MY_PAT' },
      secretPicker: async () => {
        pickerCalled = true;
        return 'unused';
      },
    });

    expect(result.applied).toBe(true);
    expect(pickerCalled).toBe(false);

    const opencodeTargets = resolveOpencodeUserTargets(env);
    const onDisk = await readJson(opencodeTargets.opencodeJson);
    const mcp = onDisk['mcp'] as Record<string, OpencodeMcpServer>;
    expect((mcp['github'] as { environment?: Record<string, string> }).environment).toEqual({
      GITHUB_TOKEN: '{env:MY_PAT}',
    });
  });

  it('a cancelled prompt (picker rejects) aborts before any write — fail-closed, not silently ignored', async () => {
    const { env, runner, tmpFactory, manifestPath } = fixture;

    await expect(
      runRemoteInstall({
        ids: ['mcp:github'],
        catalogUrl: 'https://example.com/catalog.git',
        scope: 'user',
        env,
        manifestPath,
        runner,
        tmpFactory,
        confirm: true,
        assistant: 'opencode',
        scanner: stubScanner,
        isTTY: true,
        secretPicker: () => Promise.reject(new Error('Secret prompt cancelled.')),
      }),
    ).rejects.toThrow('cancelled');

    const opencodeTargets = resolveOpencodeUserTargets(env);
    const exists = await fs.stat(opencodeTargets.opencodeJson).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it('non-TTY still fails closed on an unresolved required secret — unchanged, no prompt attempted', async () => {
    const { env, runner, tmpFactory, manifestPath } = fixture;

    await expect(
      runRemoteInstall({
        ids: ['mcp:github'],
        catalogUrl: 'https://example.com/catalog.git',
        scope: 'user',
        env,
        manifestPath,
        runner,
        tmpFactory,
        confirm: true,
        assistant: 'opencode',
        scanner: stubScanner,
        isTTY: false,
      }),
    ).rejects.toThrow(MissingRequiredSecretError);
  });
});
