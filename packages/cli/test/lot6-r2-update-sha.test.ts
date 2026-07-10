/**
 * lot6-r2-update-sha.test.ts — R2: check/update are sha-aware end-to-end
 * through the CLI (design D2).
 *
 * TDD: written before the call-site wiring existed (RED → GREEN).
 *
 * `isUpdateAvailable` gained a mandatory `installedSha` parameter (proven in
 * isolation in packages/catalog/src/lot6-r2-update-sha.test.ts). This suite
 * proves the 3 call sites actually thread `entry.sha` through:
 *  - cmd-update.ts:231 (runUpdate classification) — via runUpdate directly.
 *  - cli.ts:832 (computeArtifactStatuses, the interactive install picker's
 *    status classification) — via runCli(['install']) with an injected
 *    status-aware picker.
 *  - cli.ts:2380 (resolveCheckRemoteSections, the `check` command's
 *    "--- Updates ---" section) — via runCli(['check']).
 *
 * Two scenarios, proven at each site:
 *  - Tag re-pushed: same tag name, remote sha differs from the installed sha
 *    → classified/reported as stale/update.
 *  - Perpetual false update closed: installed via a tag, the remote has
 *    since lost all its tags (HEAD-fallback), and HEAD equals the sha that
 *    was actually installed → NOT stale/update.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';

import type { CliPrompts } from '../src/cli';
import { runCli } from '../src/cli';
import { runUpdate } from '../src/cmd-update';
import type { StatusedEntry } from '../src/ui';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TAG = 'v1.2.3';
const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
/** What the tag is re-pushed to — same name, different commit. */
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const REMOTE_SKILL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:remote-demo',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

// ---------------------------------------------------------------------------
// Isolated env — mutable remote state (tag/sha, or "tags lost" HEAD-fallback)
// ---------------------------------------------------------------------------

interface IsolatedEnv {
  env: Env;
  targets: ReturnType<typeof resolveUserTargets>;
  /** Remote re-published the SAME tag name pointing at a new commit. */
  setRemoteTag: (tag: string, sha: string) => void;
  /** Remote lost all its tags; ls-remote --tags returns empty, HEAD → headSha. */
  loseRemoteTags: (headSha: string) => void;
  makeRunner: () => CommandRunner;
  makeTmpFactory: () => TmpDirFactory;
  cleanupAll: () => Promise<void>;
}

async function makeIsolatedEnv(): Promise<IsolatedEnv> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-lot6-r2-home-'));
  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }] }),
    'utf8',
  );

  const env: Env = { RIGGER_HOME: homeDir };
  const targets = resolveUserTargets(env);

  let currentTag = TAG;
  let currentSha = SHA_A;
  let tagsLost = false;

  const setRemoteTag = (tag: string, sha: string) => {
    currentTag = tag;
    currentSha = sha;
    tagsLost = false;
  };

  const loseRemoteTags = (headSha: string) => {
    tagsLost = true;
    currentSha = headSha;
  };

  const tmpDirsCreated: string[] = [];

  const makeRunner = (): CommandRunner => (_cmd, args) => {
    const argv = args ?? [];

    if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
      if (tagsLost) {
        // Remote has no semver tags anymore — resolveVersion falls back to HEAD.
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
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
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-lot6-r2-checkout-'));
    tmpDirsCreated.push(tmpDir);
    await fs.writeFile(
      path.join(tmpDir, 'catalog.json'),
      JSON.stringify({ meta: { name: 'lot6-r2-catalog' }, entries: [REMOTE_SKILL_ENTRY] }),
      'utf8',
    );
    await fs.mkdir(path.join(tmpDir, 'skills', 'remote-demo'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'skills', 'remote-demo', 'SKILL.md'),
      `# Remote Demo Skill\n${currentTag}@${currentSha} content.`,
      'utf8',
    );
    return {
      path: tmpDir,
      cleanup: async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
      },
    };
  };

  const cleanupAll = async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    for (const d of tmpDirsCreated) {
      await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    }
  };

  return { env, targets, setRemoteTag, loseRemoteTags, makeRunner, makeTmpFactory, cleanupAll };
}

function makeCapture(): { lines: string[]; print: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

async function preInstall(iso: IsolatedEnv): Promise<void> {
  const code = await runCli(['install', 'principal/skill:remote-demo', '--yes'], {
    print: makeCapture().print,
    env: iso.env,
    remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
  });
  expect(code).toBe(0);
}

let iso: IsolatedEnv;
beforeEach(async () => {
  iso = await makeIsolatedEnv();
});
afterEach(async () => {
  await iso.cleanupAll();
});

// ---------------------------------------------------------------------------
// cmd-update.ts:231 — runUpdate classification
// ---------------------------------------------------------------------------

describe('lot6-R2: runUpdate (cmd-update.ts) is sha-aware', () => {
  it('tag re-pushed (same name, new sha) is detected as stale and re-installed', async () => {
    await preInstall(iso);
    iso.setRemoteTag(TAG, SHA_B); // same tag name, different commit

    const result = await runUpdate({
      ids: ['principal/skill:remote-demo'],
      scope: 'user',
      env: iso.env,
      manifestPath: iso.targets.stateJson,
      catalogUrl: 'https://example.com/catalog.git',
      runner: iso.makeRunner(),
      tmpFactory: iso.makeTmpFactory(),
      scanner: stubScanner,
      confirm: true,
    });

    expect(result.updated).toContain('principal/skill:remote-demo');

    const raw = await fs.readFile(iso.targets.stateJson, 'utf8');
    const manifest = JSON.parse(raw) as { artifacts: Array<{ id: string; sha?: string }> };
    const entry = manifest.artifacts.find((a) => a.id === 'principal/skill:remote-demo');
    expect(entry?.sha).toBe(SHA_B);
  });

  it('perpetual false update closed: remote lost its tags, HEAD equals the installed sha → up-to-date', async () => {
    await preInstall(iso);
    iso.loseRemoteTags(SHA_A); // no tags; HEAD == the sha already installed

    const result = await runUpdate({
      ids: ['principal/skill:remote-demo'],
      scope: 'user',
      env: iso.env,
      manifestPath: iso.targets.stateJson,
      catalogUrl: 'https://example.com/catalog.git',
      runner: iso.makeRunner(),
      tmpFactory: iso.makeTmpFactory(),
      scanner: stubScanner,
      confirm: true,
    });

    expect(result.upToDate).toContain('principal/skill:remote-demo');
    expect(result.updated).not.toContain('principal/skill:remote-demo');

    // Nothing touched: manifest still records the original tag/sha.
    const raw = await fs.readFile(iso.targets.stateJson, 'utf8');
    const manifest = JSON.parse(raw) as {
      artifacts: Array<{ id: string; ref?: string; sha?: string }>;
    };
    const entry = manifest.artifacts.find((a) => a.id === 'principal/skill:remote-demo');
    expect(entry?.ref).toBe(TAG);
    expect(entry?.sha).toBe(SHA_A);
  });
});

// ---------------------------------------------------------------------------
// cli.ts:832 — computeArtifactStatuses (interactive install status picker)
// ---------------------------------------------------------------------------

function makeStatusPrompts(captured: { value: StatusedEntry[] | null }): CliPrompts {
  return {
    selectArtifacts: async () => [],
    selectArtifactsByStatus: async (entries) => {
      captured.value = entries;
      return [];
    },
    selectScope: async () => 'user',
    confirmApply: async () => true,
    askUrl: async () => '',
    askMethod: async () => 'https',
  };
}

describe('lot6-R2: computeArtifactStatuses (cli.ts, install status picker) is sha-aware', () => {
  it('tag re-pushed (same name, new sha) classifies the entry as "update", not "current"', async () => {
    await preInstall(iso);
    iso.setRemoteTag(TAG, SHA_B);

    const captured: { value: StatusedEntry[] | null } = { value: null };
    await runCli(['install'], {
      print: () => {},
      env: iso.env,
      prompts: makeStatusPrompts(captured),
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    const demo = captured.value?.find((s) => s.id === 'principal/skill:remote-demo');
    expect(demo?.status).toBe('update');
  });

  it('perpetual false update closed: HEAD-fallback sha equals installed sha → "current" (short-circuits, picker never called)', async () => {
    await preInstall(iso);
    iso.loseRemoteTags(SHA_A);

    const captured: { value: StatusedEntry[] | null } = { value: null };
    const cap = makeCapture();
    const code = await runCli(['install'], {
      print: cap.print,
      env: iso.env,
      prompts: makeStatusPrompts(captured),
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    expect(code).toBe(0);
    // Single-entry catalog, all "current" → short-circuits before the picker.
    expect(captured.value).toBeNull();
    expect(cap.lines.join('\n')).toMatch(/up-to-date/i);
  });
});

// ---------------------------------------------------------------------------
// cli.ts:2380 — resolveCheckRemoteSections (check's "--- Updates ---" section)
// ---------------------------------------------------------------------------

describe('lot6-R2: resolveCheckRemoteSections (cli.ts, check command) is sha-aware', () => {
  it('tag re-pushed (same name, new sha) surfaces in the update section', async () => {
    await preInstall(iso);
    iso.setRemoteTag(TAG, SHA_B);

    const cap = makeCapture();
    await runCli(['check'], {
      print: cap.print,
      env: iso.env,
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    const output = cap.lines.join('\n');
    expect(output).toMatch(/update available|Updates/i);
    expect(output).toMatch(/remote-demo/i);
  });

  it('perpetual false update closed: no update section when HEAD-fallback sha equals the installed sha', async () => {
    await preInstall(iso);
    iso.loseRemoteTags(SHA_A);

    const cap = makeCapture();
    await runCli(['check'], {
      print: cap.print,
      env: iso.env,
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    const output = cap.lines.join('\n');
    expect(output).not.toMatch(/update available/i);
  });
});
