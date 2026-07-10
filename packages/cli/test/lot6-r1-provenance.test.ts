/**
 * lot6-r1-provenance.test.ts — R1: provenance mismatch blocks install/update
 * end-to-end through the CLI (design D1).
 *
 * TDD: written before the handleError mapping existed (RED → GREEN).
 *
 * Strategy (mirrors e2e-remote-install.test.ts):
 * - HOME isolated via a tmp dir (RIGGER_HOME override).
 * - deps.remote injected: a fake runner resolves the tag to SHA_TAG via
 *   ls-remote, but its `rev-parse HEAD` reports SHA_BRANCH instead — the
 *   observable symptom of a branch/tag homonym or a TOCTOU re-push (the
 *   underlying git behaviour is proven with a real fixture at the catalog
 *   level; this suite proves the CLI wiring + exit code + "nothing written").
 * - No real git/network calls.
 *
 * Scenarios:
 *  - `install <catalog>/<id> --yes` on a mismatch: exit 2, no manifest
 *    written, no store directory created, no symlink created, cleanup ran.
 *  - The printed error names the ref and both shas.
 *  - `update` on a stale entry with a mismatch: exit non-zero, manifest
 *    entry NOT advanced past the previously-installed ref/sha (transactional
 *    abort, nothing removed either).
 *  - Nominal (matching sha): install still succeeds — proves the mismatch
 *    tests above aren't failing for an unrelated reason.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type CatalogEntry, type TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';

import { runCli } from '../src/cli';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TAG_NAME = 'v1.2.3';
/** What ls-remote resolves the tag to — the "expected" sha (manifest-bound). */
const SHA_TAG = 'aabbccddeeff00112233445566778899aabbccdd';
/** What the checkout's rev-parse HEAD actually reports — a different commit. */
const SHA_BRANCH = 'bbccddeeff00112233445566778899aabbccddee';

const REMOTE_SKILL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:remote-demo',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

/**
 * Builds an isolated RIGGER_HOME + a fake CommandRunner whose `rev-parse
 * HEAD` reports a sha DIFFERENT from the one `ls-remote --tags` resolved —
 * simulating the observable outcome of a branch/tag homonym or a TOCTOU
 * re-push. `headSha` lets the nominal test reuse this helper with a matching
 * sha instead.
 */
async function makeMismatchEnv(opts: { headSha: string }): Promise<{
  env: Env;
  homeDir: string;
  contentDir: string;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  cleanupAll: () => Promise<void>;
  getCleanupCalled: () => boolean;
}> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-lot6-r1-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-lot6-r1-content-'));

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 'lot6-r1-catalog' }, entries: [REMOTE_SKILL_ENTRY] }),
    'utf8',
  );
  await fs.mkdir(path.join(contentDir, 'skills', 'remote-demo'), { recursive: true });
  await fs.writeFile(
    path.join(contentDir, 'skills', 'remote-demo', 'SKILL.md'),
    '# Remote Demo Skill\n',
    'utf8',
  );

  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }] }),
    'utf8',
  );

  const env: Env = { RIGGER_HOME: homeDir };

  const runner: CommandRunner = (_cmd, args) => {
    const argv = args ?? [];

    if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${SHA_TAG}\trefs/tags/${TAG_NAME}\n`,
        stderr: '',
      });
    }
    if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA_TAG}\tHEAD\n`, stderr: '' });
    }
    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    // The provenance check's rev-parse HEAD — reports a DIFFERENT commit than
    // the tag resolved to, simulating the homonym/TOCTOU outcome.
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${opts.headSha}\n`, stderr: '' });
    }
    if (_cmd === 'sh' || argv.length === 0) {
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };

  let cleanupCalled = false;
  const tmpFactory: TmpDirFactory = async () => ({
    path: contentDir,
    cleanup: async () => {
      cleanupCalled = true;
    },
  });

  const cleanupAll = async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(contentDir, { recursive: true, force: true });
  };

  return {
    env,
    homeDir,
    contentDir,
    runner,
    tmpFactory,
    cleanupAll,
    getCleanupCalled: () => cleanupCalled,
  };
}

function makeCapture(): { lines: string[]; print: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

// ---------------------------------------------------------------------------
// install — mismatch blocks with exit 2, nothing written
// ---------------------------------------------------------------------------

describe('lot6-R1: install refuses a provenance mismatch (exit 2, CLI mapping)', () => {
  let mismatchEnv: Awaited<ReturnType<typeof makeMismatchEnv>>;
  let targets: ReturnType<typeof resolveUserTargets>;

  beforeEach(async () => {
    mismatchEnv = await makeMismatchEnv({ headSha: SHA_BRANCH });
    targets = resolveUserTargets(mismatchEnv.env);
  });

  afterEach(async () => {
    await mismatchEnv.cleanupAll();
  });

  it('exits with code 2', async () => {
    const cap = makeCapture();
    const code = await runCli(['install', 'principal/skill:remote-demo', '--yes'], {
      print: cap.print,
      env: mismatchEnv.env,
      remote: { run: mismatchEnv.runner, tmpFactory: mismatchEnv.tmpFactory, scanner: stubScanner },
    });
    expect(code).toBe(2);
  });

  it('the printed error names the ref and both shas', async () => {
    const cap = makeCapture();
    await runCli(['install', 'principal/skill:remote-demo', '--yes'], {
      print: cap.print,
      env: mismatchEnv.env,
      remote: { run: mismatchEnv.runner, tmpFactory: mismatchEnv.tmpFactory, scanner: stubScanner },
    });
    const output = cap.lines.join('\n');
    expect(output).toContain(TAG_NAME);
    expect(output).toContain(SHA_TAG);
    expect(output).toContain(SHA_BRANCH);
  });

  it('no manifest (state.json) is written', async () => {
    await runCli(['install', 'principal/skill:remote-demo', '--yes'], {
      print: makeCapture().print,
      env: mismatchEnv.env,
      remote: { run: mismatchEnv.runner, tmpFactory: mismatchEnv.tmpFactory, scanner: stubScanner },
    });
    const exists = await fs
      .stat(targets.stateJson)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it('no skill store directory is created', async () => {
    await runCli(['install', 'principal/skill:remote-demo', '--yes'], {
      print: makeCapture().print,
      env: mismatchEnv.env,
      remote: { run: mismatchEnv.runner, tmpFactory: mismatchEnv.tmpFactory, scanner: stubScanner },
    });
    const skillStorePath = path.join(targets.skillsDir, 'remote-demo');
    const stat = await fs.stat(skillStorePath).catch(() => null);
    expect(stat).toBeNull();
  });

  it('no symlink is created in ~/.claude/skills', async () => {
    await runCli(['install', 'principal/skill:remote-demo', '--yes'], {
      print: makeCapture().print,
      env: mismatchEnv.env,
      remote: { run: mismatchEnv.runner, tmpFactory: mismatchEnv.tmpFactory, scanner: stubScanner },
    });
    const claudeDir = path.dirname(targets.claudeSettings);
    const symlinkPath = path.join(claudeDir, 'skills', 'remote-demo');
    const stat = await fs.lstat(symlinkPath).catch(() => null);
    expect(stat).toBeNull();
  });

  it('cleanup is still called (no orphaned checkout)', async () => {
    await runCli(['install', 'principal/skill:remote-demo', '--yes'], {
      print: makeCapture().print,
      env: mismatchEnv.env,
      remote: { run: mismatchEnv.runner, tmpFactory: mismatchEnv.tmpFactory, scanner: stubScanner },
    });
    expect(mismatchEnv.getCleanupCalled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// install — nominal (matching sha) still succeeds
// ---------------------------------------------------------------------------

describe('lot6-R1: install succeeds when the sha matches (sanity check)', () => {
  it('exits 0 and writes the manifest entry with the resolved (matching) sha', async () => {
    const nominalEnv = await makeMismatchEnv({ headSha: SHA_TAG });
    const targets = resolveUserTargets(nominalEnv.env);
    try {
      const cap = makeCapture();
      const code = await runCli(['install', 'principal/skill:remote-demo', '--yes'], {
        print: cap.print,
        env: nominalEnv.env,
        remote: { run: nominalEnv.runner, tmpFactory: nominalEnv.tmpFactory, scanner: stubScanner },
      });
      expect(code).toBe(0);

      const raw = await fs.readFile(targets.stateJson, 'utf8');
      const manifest = JSON.parse(raw) as { artifacts: Array<{ id: string; sha?: string }> };
      const entry = manifest.artifacts.find((a) => a.id === 'principal/skill:remote-demo');
      expect(entry?.sha).toBe(SHA_TAG);
    } finally {
      await nominalEnv.cleanupAll();
    }
  });
});

// ---------------------------------------------------------------------------
// update — mismatch aborts the transaction, nothing removed/advanced
// ---------------------------------------------------------------------------

describe('lot6-R1: update refuses a provenance mismatch on the stale checkout', () => {
  it('exits non-zero and leaves the manifest entry at its previously-installed sha', async () => {
    // Step 1: install nominally (matching sha) so there is a manifest entry to update.
    const env = await makeMismatchEnv({ headSha: SHA_TAG });
    const targets = resolveUserTargets(env.env);
    try {
      const installCode = await runCli(['install', 'principal/skill:remote-demo', '--yes'], {
        print: makeCapture().print,
        env: env.env,
        remote: { run: env.runner, tmpFactory: env.tmpFactory, scanner: stubScanner },
      });
      expect(installCode).toBe(0);

      const rawBefore = await fs.readFile(targets.stateJson, 'utf8');
      const manifestBefore = JSON.parse(rawBefore) as {
        artifacts: Array<{ id: string; sha?: string; ref?: string }>;
      };
      const entryBefore = manifestBefore.artifacts.find(
        (a) => a.id === 'principal/skill:remote-demo',
      );
      expect(entryBefore?.sha).toBe(SHA_TAG);

      // Step 2: bump the remote tag to a new sha (a real update) AND make the
      // checkout's rev-parse HEAD diverge from THAT new sha too (mismatch).
      const SHA_NEW_TAG = 'ccddeeff00112233445566778899aabbccddeeff';
      const SHA_UNEXPECTED = 'ddeeff00112233445566778899aabbccddeeffaa';
      const updateRunner: CommandRunner = (_cmd, args) => {
        const argv = args ?? [];
        if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
          return Promise.resolve({
            exitCode: 0,
            stdout: `${SHA_NEW_TAG}\trefs/tags/v9.9.9\n`,
            stderr: '',
          });
        }
        if (argv[0] === 'clone') {
          return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        }
        if (argv[0] === '-C' && argv[2] === 'rev-parse') {
          return Promise.resolve({ exitCode: 0, stdout: `${SHA_UNEXPECTED}\n`, stderr: '' });
        }
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      };

      const cap = makeCapture();
      const updateCode = await runCli(['update', '--yes'], {
        print: cap.print,
        env: env.env,
        remote: { run: updateRunner, tmpFactory: env.tmpFactory, scanner: stubScanner },
      });
      expect(updateCode).not.toBe(0);

      // Manifest entry unchanged — still the original tag/sha, not removed either.
      const rawAfter = await fs.readFile(targets.stateJson, 'utf8');
      const manifestAfter = JSON.parse(rawAfter) as {
        artifacts: Array<{ id: string; sha?: string; ref?: string }>;
      };
      const entryAfter = manifestAfter.artifacts.find(
        (a) => a.id === 'principal/skill:remote-demo',
      );
      expect(entryAfter).toBeDefined();
      expect(entryAfter?.sha).toBe(SHA_TAG);
      expect(entryAfter?.ref).toBe(TAG_NAME);
    } finally {
      await env.cleanupAll();
    }
  });
});
