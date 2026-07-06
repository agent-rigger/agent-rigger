/**
 * Tests for remote-install.ts — assistant threading (wiring slice A).
 *
 * runRemoteInstall used to hardcode buildClaudeAdapter; it now dispatches via
 * buildAdapter(assistant, env, opts), defaulting to 'claude' for back-compat
 * when `assistant` is omitted.
 *
 * Strategy mirrors s4-scanner-remote.test.ts: tmpFactory returns a pre-built
 * "checkout" dir directly (no real git clone), a fake CommandRunner answers
 * ls-remote/clone/rev-parse, so the whole pipeline runs against real files
 * with no network access.
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

const CONTEXT_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'context:main',
  nature: 'context',
  targets: ['claude', 'opencode'],
  scopes: ['user', 'project'],
};

const AGENTS_CONTENT = '# Remote Agents\nposed via remote-install.';

async function makeRemoteEnv(): Promise<{
  env: Env;
  homeDir: string;
  contentDir: string;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  manifestPath: string;
  cleanupAll: () => Promise<void>;
}> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-ri-assistant-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-ri-assistant-content-'));

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 'ri-assistant-test' }, entries: [CONTEXT_ENTRY] }),
    'utf8',
  );

  const ctxDir = path.join(contentDir, 'contexts', 'main');
  await fs.mkdir(ctxDir, { recursive: true });
  await fs.writeFile(path.join(ctxDir, 'AGENTS.md'), AGENTS_CONTENT, 'utf8');

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

describe('runRemoteInstall — assistant threading', () => {
  it('defaults to claude when `assistant` is omitted (back-compat)', async () => {
    const { env, runner, tmpFactory, manifestPath } = fixture;

    const result = await runRemoteInstall({
      ids: ['context:main'],
      catalogUrl: 'https://example.com/catalog.git',
      scope: 'user',
      env,
      manifestPath,
      runner,
      tmpFactory,
      confirm: true,
    });

    expect(result.applied).toBe(true);

    const manifest = await readManifest(manifestPath);
    expect(findEntry(manifest, 'context:main', 'user', 'claude')).toBeDefined();

    const claudeMd = await Bun.file(resolveUserTargets(env).agentsMd).text();
    expect(claudeMd).toBe(AGENTS_CONTENT);
  });

  it('assistant: "opencode" dispatches to buildOpencodeAdapter and poses AGENTS.md natively', async () => {
    const { env, runner, tmpFactory, manifestPath } = fixture;

    const result = await runRemoteInstall({
      ids: ['context:main'],
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

    const manifest = await readManifest(manifestPath);
    expect(findEntry(manifest, 'context:main', 'user', 'opencode')).toBeDefined();
    // Legacy (claude) key must NOT exist for this entry — the two assistants
    // are tracked as distinct manifest identities (id, scope, assistant).
    expect(findEntry(manifest, 'context:main', 'user', 'claude')).toBeUndefined();

    const opencodeAgentsMd = await Bun.file(resolveOpencodeUserTargets(env).agentsMd).text();
    expect(opencodeAgentsMd).toBe(AGENTS_CONTENT);
  });
});
