/**
 * cshn-force-surfaces.test.ts — ④ (cli-signal-help-naming): --force is a real
 * surface on `update`, not just ad-hoc install.
 *
 * Behaviour anti-drift: symmetric to r27-hook-scan.test.ts (R27-2) on the
 * install side. Where R27-2 proves `install … --force` warns-and-proceeds past
 * a blocking scan, this proves the same for `update <id> --force`. If the
 * threading of --force through the update path ever regresses, this fails —
 * keeping the help text (which now documents install AND update) honest.
 *
 * A stale remote (v1.0.0 installed → v1.1.0 available) forces a re-install
 * during update, which runs scanEntries; a blocking scanner would throw
 * ScanBlockedError without --force. With --force it emits the shared warning
 * `installed anyway via --force` (remote-install.ts) and exits 0.
 *
 * Self-contained harness (mirrors cmd-update.test.ts): isolated RIGGER_HOME,
 * arg-dispatching runner, version-aware tmpFactory. No real git/network.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import type { Env } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';
import type { Scanner } from '@agent-rigger/core/scan';

import { runCli } from '../src/cli';

const SHA_V1_0_0 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_V1_1_0 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TAG_V1_0_0 = 'v1.0.0';
const TAG_V1_1_0 = 'v1.1.0';

const REMOTE_SKILL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:remote-demo',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

/** Scanner that always blocks with a finding. */
function blockingScanner(): Scanner {
  return { scan: () => Promise.resolve({ ok: false, findings: ['suspected-payload'] }) };
}

interface IsolatedEnv {
  env: Env;
  setRemoteTag: (tag: string, sha: string) => void;
  makeRunner: () => CommandRunner;
  makeTmpFactory: () => TmpDirFactory;
  cleanupAll: () => Promise<void>;
}

async function makeIsolatedEnv(): Promise<IsolatedEnv> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-cshn-force-home-'));

  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }] }),
    'utf8',
  );

  const env: Env = { RIGGER_HOME: homeDir };

  let currentTag = TAG_V1_0_0;
  let currentSha = SHA_V1_0_0;
  const setRemoteTag = (tag: string, sha: string) => {
    currentTag = tag;
    currentSha = sha;
  };

  const tmpDirsCreated: string[] = [];

  const makeRunner = (): CommandRunner => (_cmd, args) => {
    const argv = args ?? [];
    if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${currentSha}\trefs/tags/${currentTag}\n`,
        stderr: '',
      });
    }
    if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
      return Promise.resolve({ exitCode: 0, stdout: `${currentSha}\tHEAD\n`, stderr: '' });
    }
    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${currentSha}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };

  const makeTmpFactory = (): TmpDirFactory => async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-cshn-force-checkout-'));
    tmpDirsCreated.push(tmpDir);
    await fs.writeFile(
      path.join(tmpDir, 'catalog.json'),
      JSON.stringify({ meta: { name: 'cshn-force-catalog' }, entries: [REMOTE_SKILL_ENTRY] }),
      'utf8',
    );
    await fs.mkdir(path.join(tmpDir, 'skills', 'remote-demo'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'skills', 'remote-demo', 'SKILL.md'),
      `# Remote Demo Skill ${currentTag}\n`,
      'utf8',
    );
    return {
      path: tmpDir,
      cleanup: () => fs.rm(tmpDir, { recursive: true, force: true }),
    };
  };

  const cleanupAll = async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    for (const d of tmpDirsCreated) {
      await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    }
  };

  return { env, setRemoteTag, makeRunner, makeTmpFactory, cleanupAll };
}

function makeCapture() {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

describe('cshn ④: `update <id> --force` warns-and-proceeds past a blocking scan', () => {
  let iso: IsolatedEnv;

  beforeEach(async () => {
    iso = await makeIsolatedEnv();
  });

  afterEach(async () => {
    await iso.cleanupAll();
  });

  it('exits 0 and surfaces "installed anyway via --force" when a blocking scanner is overridden', async () => {
    // Pre-install at v1.0.0 with a clean scanner.
    iso.setRemoteTag(TAG_V1_0_0, SHA_V1_0_0);
    await runCli(['install', 'principal/skill:remote-demo', '--yes'], {
      print: makeCapture().print,
      env: iso.env,
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    // Remote advances → update re-installs, running the (now blocking) scan.
    iso.setRemoteTag(TAG_V1_1_0, SHA_V1_1_0);

    const cap = makeCapture();
    const code = await runCli(['update', 'principal/skill:remote-demo', '--yes', '--force'], {
      print: cap.print,
      env: iso.env,
      remote: {
        run: iso.makeRunner(),
        tmpFactory: iso.makeTmpFactory(),
        scanner: blockingScanner(),
      },
    });

    expect(code).toBe(0);
    expect(cap.lines.join('\n')).toContain('installed anyway via --force');
  });
});
