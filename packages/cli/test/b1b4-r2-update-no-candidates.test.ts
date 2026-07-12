/**
 * b1b4-r2-update-no-candidates.test.ts — R2: `update` (no ids) signals the
 * no-op instead of staying silent (finding B2).
 *
 * When `update` without ids finds no installed artifact for the resolved
 * scope + assistant across EVERY configured catalog, the CLI prints
 * `No external artifacts to update.` exactly once and exits 0. The per-catalog
 * `continue` in handleUpdate is silent by design (it protects resolution
 * against reclassifying one catalog's entries against another's url); the
 * signal is raised once after the loop, only when no catalog yielded a
 * candidate — so it means "nothing anywhere", never "nothing for this
 * catalog".
 *
 * One test per scenario in requirements.md (R2), named `b1b4-R2: …` (stock §8
 * traceability). The message is asserted against the exported constant
 * NO_UPDATE_CANDIDATES_MSG (single source of truth, shared with runUpdate's
 * defensive branch). Montage: multi-catalog config.json + seeded manifest
 * (status-aware-picker.test.ts) with the git-fake runner of
 * lot6-r2-update-sha.test.ts (a catalog with an install needs an ls-remote
 * that answers).
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';

import { runCli } from '../src/cli';
import { NO_UPDATE_CANDIDATES_MSG } from '../src/cmd-update';
import { pinStdinIsTTY, pinStdoutIsTTY } from './fixtures/tty';

// update --yes never touches a prompt (the confirm gate passes on --yes), but
// pin both streams non-TTY per the file-level convention so no path can slip
// into an interactive branch.
pinStdoutIsTTY(false);
pinStdinIsTTY(false);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TAG = 'v1.0.0';
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const SKILL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:remote-demo',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

function makeCapture(): { lines: string[]; print: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

/**
 * A git-fake runner (ls-remote --tags → fixed tag/sha, clone/rev-parse noop)
 * wrapped so every invocation increments `count()`. When no candidate is
 * resolved, runUpdate is never entered and `count()` stays 0 — the load-bearing
 * assertion of R2 scenario 1.
 */
function makeCountingRunner(): { runner: CommandRunner; count: () => number } {
  let calls = 0;
  const runner: CommandRunner = (_cmd, args) => {
    calls++;
    const argv = args ?? [];
    if (argv[0] === 'ls-remote' && argv.includes('--tags')) {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\trefs/tags/${TAG}\n`, stderr: '' });
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
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };
  return { runner, count: () => calls };
}

interface Iso {
  env: Env;
  targets: ReturnType<typeof resolveUserTargets>;
  makeTmpFactory: () => TmpDirFactory;
  cleanupAll: () => Promise<void>;
}

/** Isolated env with the given catalogs configured in config.json. */
async function makeIso(catalogs: { name: string; url: string }[]): Promise<Iso> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-b1b4-r2-home-'));
  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({ catalogs }), 'utf8');

  const env: Env = { RIGGER_HOME: homeDir };
  const targets = resolveUserTargets(env);
  const tmpDirs: string[] = [];

  const makeTmpFactory = (): TmpDirFactory => async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-b1b4-r2-checkout-'));
    tmpDirs.push(tmpDir);
    await fs.writeFile(
      path.join(tmpDir, 'catalog.json'),
      JSON.stringify({ meta: { name: 'r2-catalog' }, entries: [SKILL_ENTRY] }),
      'utf8',
    );
    await fs.mkdir(path.join(tmpDir, 'skills', 'remote-demo'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'skills', 'remote-demo', 'SKILL.md'),
      `# Remote Demo\n${TAG}@${SHA} content.`,
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
    for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  };

  return { env, targets, makeTmpFactory, cleanupAll };
}

// ---------------------------------------------------------------------------
// Scenario 1: rien d'installé → le no-op est signalé une fois
// ---------------------------------------------------------------------------

describe('b1b4-R2: update sans candidat', () => {
  it("b1b4-R2: rien d'installé → une seule occurrence du message, exit 0, zéro fetch", async () => {
    const iso = await makeIso([{ name: 'principal', url: 'https://example.com/catalog.git' }]);
    const { runner, count: runCount } = makeCountingRunner();
    const cap = makeCapture();

    try {
      const code = await runCli(['update', '--yes'], {
        print: cap.print,
        env: iso.env,
        remote: { run: runner, tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
      });

      expect(code).toBe(0);
      const occurrences = cap.lines.filter((l) => l.includes(NO_UPDATE_CANDIDATES_MSG));
      expect(occurrences).toHaveLength(1);
      // No candidate to resolve → runUpdate never entered → no fetch.
      expect(runCount()).toBe(0);
    } finally {
      await iso.cleanupAll();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: le message n'apparaît pas quand un catalogue a des candidats
// ---------------------------------------------------------------------------

describe('b1b4-R2: update multi-catalogue avec candidats sur un seul', () => {
  it('b1b4-R2: A et B configurés, installé depuis A seulement → sortie de A présente, message R2 absent', async () => {
    const iso = await makeIso([
      { name: 'catA', url: 'https://example.com/a.git' },
      { name: 'catB', url: 'https://example.com/b.git' },
    ]);
    const cap = makeCapture();

    try {
      // Install one artifact from catA only (catB stays empty).
      const installCode = await runCli(['install', 'catA/skill:remote-demo', '--yes'], {
        print: () => {},
        env: iso.env,
        remote: {
          run: makeCountingRunner().runner,
          tmpFactory: iso.makeTmpFactory(),
          scanner: stubScanner,
        },
      });
      expect(installCode).toBe(0);

      const code = await runCli(['update', '--yes'], {
        print: cap.print,
        env: iso.env,
        remote: {
          run: makeCountingRunner().runner,
          tmpFactory: iso.makeTmpFactory(),
          scanner: stubScanner,
        },
      });

      expect(code).toBe(0);
      const out = cap.lines.join('\n');
      // catA produced update output for its installed artifact...
      expect(out).toContain('catA/skill:remote-demo');
      // ...and because a candidate WAS found, the "nothing anywhere" signal is absent
      // (catB's silent skip must not raise it).
      expect(out).not.toContain(NO_UPDATE_CANDIDATES_MSG);
    } finally {
      await iso.cleanupAll();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: non-régression du chemin ids explicites
// ---------------------------------------------------------------------------

describe('b1b4-R2: non-régression ids explicites', () => {
  it('b1b4-R2: update --yes cat/x avec x non installé → [skipped] not installed, sans le message R2', async () => {
    const iso = await makeIso([{ name: 'principal', url: 'https://example.com/catalog.git' }]);
    const cap = makeCapture();

    try {
      const code = await runCli(['update', '--yes', 'principal/skill:not-there'], {
        print: cap.print,
        env: iso.env,
        remote: {
          run: makeCountingRunner().runner,
          tmpFactory: iso.makeTmpFactory(),
          scanner: stubScanner,
        },
      });

      expect(code).toBe(0);
      const out = cap.lines.join('\n');
      // Explicit-ids branch: not-installed is a per-id skip, unchanged.
      expect(out).toContain('not installed');
      // The R2 no-op signal belongs to the no-ids branch only — never here.
      expect(out).not.toContain(NO_UPDATE_CANDIDATES_MSG);
    } finally {
      await iso.cleanupAll();
    }
  });
});
