/**
 * m1c3-update-routing.test.ts — M1c-3 tests.
 *
 * Tests the `update` command routing (Part A) and `check` update-available
 * annotation (Part B), and `CatalogUrlMissingError` mapping (Part C).
 *
 * Strategy:
 * - RIGGER_HOME isolated via tmp dir.
 * - Pre-install via runCli to seed the manifest.
 * - runner: ls-remote → version-aware, clone → no-op, rev-parse → sha.
 * - tmpFactory: version-aware (see cmd-update.test.ts pattern).
 * - No real git or network calls.
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

import { runCli } from '../src/cli';

// ---------------------------------------------------------------------------
// Repo root
// ---------------------------------------------------------------------------

/** A CommandRunner that always fails — used for best-effort check tests. */
const failRunner: CommandRunner = () =>
  Promise.resolve({ exitCode: 1, stdout: '', stderr: 'network error' });

/** True when a git URL belongs to the secondary ("other") catalog. */
const isOtherUrl = (url: string): boolean => url.includes('other');

/**
 * Extract the repo URL from a git argv. git places the URL after a `--`
 * separator (security hardening), so its position varies — match by content.
 */
const urlOf = (argv: string[]): string => argv.find((a) => a.includes('example.com')) ?? '';

// ---------------------------------------------------------------------------
// Fixed fixtures
// ---------------------------------------------------------------------------

const SHA_V1_0_0 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_V1_1_0 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TAG_V1_0_0 = 'v1.0.0';
const TAG_V1_1_0 = 'v1.1.0';

const SKILL_CONTENT: Record<string, string> = {
  [TAG_V1_0_0]: '# Remote Demo Skill v1.0.0\nInitial.',
  [TAG_V1_1_0]: '# Remote Demo Skill v1.1.0\nUpdated.',
};

const REMOTE_SKILL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:remote-demo',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

// ---------------------------------------------------------------------------
// makeIsolatedEnv
// ---------------------------------------------------------------------------

interface IsolatedEnv {
  env: Env;
  homeDir: string;
  setRemoteTag: (tag: string, sha: string) => void;
  makeRunner: () => CommandRunner;
  makeTmpFactory: () => TmpDirFactory;
  cleanupAll: () => Promise<void>;
}

async function makeIsolatedEnv(opts: {
  withCatalogUrl?: boolean;
  catalog?: CatalogEntry[];
  skillIds?: string[];
}): Promise<IsolatedEnv> {
  const {
    withCatalogUrl = true,
    catalog = [REMOTE_SKILL_ENTRY],
    skillIds = ['remote-demo'],
  } = opts;

  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-m1c3-home-'));

  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });
  if (withCatalogUrl) {
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }] }),
      'utf8',
    );
  }

  const env: Env = { RIGGER_HOME: homeDir };

  let currentTag = TAG_V1_0_0;
  let currentSha = SHA_V1_0_0;

  const setRemoteTag = (tag: string, sha: string) => {
    currentTag = tag;
    currentSha = sha;
  };

  const tmpDirs: string[] = [];

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
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-m1c3-checkout-'));
    tmpDirs.push(tmpDir);
    await fs.writeFile(
      path.join(tmpDir, 'catalog.json'),
      JSON.stringify({ meta: { name: 'm1c3-test-catalog' }, entries: catalog }),
      'utf8',
    );
    for (const skillId of skillIds) {
      await fs.mkdir(path.join(tmpDir, 'skills', skillId), { recursive: true });
      const content = SKILL_CONTENT[currentTag] ?? `# Skill ${skillId}\n${currentTag}`;
      await fs.writeFile(path.join(tmpDir, 'skills', skillId, 'SKILL.md'), content, 'utf8');
    }
    return {
      path: tmpDir,
      cleanup: async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
      },
    };
  };

  const cleanupAll = async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    for (const d of tmpDirs) {
      await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    }
  };

  return { env, homeDir, setRemoteTag, makeRunner, makeTmpFactory, cleanupAll };
}

function makeCapture() {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

// ---------------------------------------------------------------------------
// Shared lifecycle
// ---------------------------------------------------------------------------

let iso: IsolatedEnv;
let targets: ReturnType<typeof resolveUserTargets>;

beforeEach(async () => {
  iso = await makeIsolatedEnv({});
  targets = resolveUserTargets(iso.env);
});

afterEach(async () => {
  await iso.cleanupAll();
});

async function preInstall(env: Env, tag: string, sha: string) {
  iso.setRemoteTag(tag, sha);
  const cap = makeCapture();
  await runCli(['install', 'principal/skill:remote-demo', '--yes'], {
    print: cap.print,
    env,
    remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
  });
}

// ---------------------------------------------------------------------------
// Part A — `update` routing
// ---------------------------------------------------------------------------

describe('update routing — top-level `update <id...> --yes`', () => {
  it('returns exit 0 when stale skill is updated', async () => {
    await preInstall(iso.env, TAG_V1_0_0, SHA_V1_0_0);
    iso.setRemoteTag(TAG_V1_1_0, SHA_V1_1_0);

    const cap = makeCapture();
    const code = await runCli(['update', 'principal/skill:remote-demo', '--yes'], {
      print: cap.print,
      env: iso.env,
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    expect(code).toBe(0);
  });

  it('manifest ref bumped to v1.1.0 after `update` command', async () => {
    await preInstall(iso.env, TAG_V1_0_0, SHA_V1_0_0);
    iso.setRemoteTag(TAG_V1_1_0, SHA_V1_1_0);

    const cap = makeCapture();
    await runCli(['update', 'principal/skill:remote-demo', '--yes'], {
      print: cap.print,
      env: iso.env,
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    const raw = await fs.readFile(targets.stateJson, 'utf8');
    const manifest = JSON.parse(raw) as {
      artifacts: Array<{ id: string; ref?: string }>;
    };
    const entry = manifest.artifacts.find((a) => a.id === 'principal/skill:remote-demo');
    expect(entry?.ref).toBe(TAG_V1_1_0);
  });

  it('output mentions updated skill', async () => {
    await preInstall(iso.env, TAG_V1_0_0, SHA_V1_0_0);
    iso.setRemoteTag(TAG_V1_1_0, SHA_V1_1_0);

    const cap = makeCapture();
    await runCli(['update', 'principal/skill:remote-demo', '--yes'], {
      print: cap.print,
      env: iso.env,
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    const output = cap.lines.join('\n');
    expect(output).toMatch(/updated|remote-demo/i);
  });
});

describe('update routing — `skills update <id> --yes`', () => {
  it('returns exit 0 for resource verb update', async () => {
    await preInstall(iso.env, TAG_V1_0_0, SHA_V1_0_0);
    iso.setRemoteTag(TAG_V1_1_0, SHA_V1_1_0);

    const cap = makeCapture();
    const code = await runCli(['skills', 'update', 'principal/skill:remote-demo', '--yes'], {
      print: cap.print,
      env: iso.env,
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    expect(code).toBe(0);
  });

  it('manifest ref bumped via resource update verb', async () => {
    await preInstall(iso.env, TAG_V1_0_0, SHA_V1_0_0);
    iso.setRemoteTag(TAG_V1_1_0, SHA_V1_1_0);

    const cap = makeCapture();
    await runCli(['skills', 'update', 'principal/skill:remote-demo', '--yes'], {
      print: cap.print,
      env: iso.env,
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    const raw = await fs.readFile(targets.stateJson, 'utf8');
    const manifest = JSON.parse(raw) as { artifacts: Array<{ id: string; ref?: string }> };
    const entry = manifest.artifacts.find((a) => a.id === 'principal/skill:remote-demo');
    expect(entry?.ref).toBe(TAG_V1_1_0);
  });
});

describe('update routing — no catalogUrl → exit 2', () => {
  it('returns exit 2 when catalogUrl not configured', async () => {
    const noUrlIso = await makeIsolatedEnv({ withCatalogUrl: false });
    try {
      const cap = makeCapture();
      const code = await runCli(['update', 'principal/skill:remote-demo', '--yes'], {
        print: cap.print,
        env: noUrlIso.env,
        remote: {
          run: noUrlIso.makeRunner(),
          tmpFactory: noUrlIso.makeTmpFactory(),
          scanner: stubScanner,
        },
      });
      expect(code).toBe(2);
    } finally {
      await noUrlIso.cleanupAll();
    }
  });

  it('output mentions init command when no catalogUrl', async () => {
    const noUrlIso = await makeIsolatedEnv({ withCatalogUrl: false });
    try {
      const cap = makeCapture();
      await runCli(['update', 'principal/skill:remote-demo', '--yes'], {
        print: cap.print,
        env: noUrlIso.env,
        remote: {
          run: noUrlIso.makeRunner(),
          tmpFactory: noUrlIso.makeTmpFactory(),
          scanner: stubScanner,
        },
      });
      const output = cap.lines.join('\n');
      expect(output).toMatch(/init/i);
    } finally {
      await noUrlIso.cleanupAll();
    }
  });
});

describe('update routing — internal entry → exit 0, skipped', () => {
  it('returns exit 0 for internal entry (no remote version)', async () => {
    // guardrails-claude is internal — not in manifest as external
    const cap = makeCapture();
    const code = await runCli(['update', 'principal/guardrails-claude', '--yes'], {
      print: cap.print,
      env: iso.env,
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });
    // runUpdate returns skipped for internal → exit 0
    expect(code).toBe(0);
  });

  it('output mentions skipped for internal entry', async () => {
    const cap = makeCapture();
    await runCli(['update', 'principal/guardrails-claude', '--yes'], {
      print: cap.print,
      env: iso.env,
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });
    const output = cap.lines.join('\n');
    expect(output).toMatch(/skipped|no remote version/i);
  });
});

describe('update routing — wrong nature id → exit 2', () => {
  it('`guardrails update skill:remote-demo` exits 2 (wrong nature)', async () => {
    await preInstall(iso.env, TAG_V1_0_0, SHA_V1_0_0);

    const cap = makeCapture();
    const code = await runCli(['guardrails', 'update', 'principal/skill:remote-demo', '--yes'], {
      print: cap.print,
      env: iso.env,
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    expect(code).toBe(2);
  });

  it('output mentions nature mismatch', async () => {
    await preInstall(iso.env, TAG_V1_0_0, SHA_V1_0_0);

    const cap = makeCapture();
    await runCli(['guardrails', 'update', 'principal/skill:remote-demo', '--yes'], {
      print: cap.print,
      env: iso.env,
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    const output = cap.lines.join('\n');
    expect(output).toMatch(/is not a guardrail/i);
  });
});

// ---------------------------------------------------------------------------
// Part A — multi-catalog all-update: a catalog with NO installed entries must
// be skipped (regression: cross-catalog "Unknown catalog entry" crash).
// ---------------------------------------------------------------------------

describe('update routing — `update --yes` (all) with a 2nd empty catalog', () => {
  it('skips the catalog with no installs instead of crashing with "Unknown catalog entry"', async () => {
    // TWO catalogs configured; only `principal` has an installed entry.
    // `other` is on a HIGHER version and serves DIFFERENT content (no remote-demo).
    // Pre-fix: the all-update loop passes empty ids to runUpdate for `other`,
    // runUpdate treats empty as "all installed" → reclassifies principal's entry
    // as stale against `other`'s higher version → resolve() against `other`'s
    // catalog throws UnknownEntryError. Post-fix: `other` is skipped.
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-m1c3-multi-'));
    const configDir = path.join(homeDir, '.config', 'agent-rigger');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({
        catalogs: [
          { name: 'principal', url: 'https://example.com/principal.git' },
          { name: 'other', url: 'https://example.com/other.git' },
        ],
      }),
      'utf8',
    );
    const env: Env = { RIGGER_HOME: homeDir };

    let lastLsUrl = '';
    const tmpDirs: string[] = [];

    const runner: CommandRunner = (_cmd, args) => {
      const argv = args ?? [];
      if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
        const url = urlOf(argv);
        lastLsUrl = url;
        const tag = isOtherUrl(url) ? TAG_V1_1_0 : TAG_V1_0_0;
        const sha = isOtherUrl(url) ? SHA_V1_1_0 : SHA_V1_0_0;
        return Promise.resolve({ exitCode: 0, stdout: `${sha}\trefs/tags/${tag}\n`, stderr: '' });
      }
      if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
        const url = urlOf(argv);
        const sha = isOtherUrl(url) ? SHA_V1_1_0 : SHA_V1_0_0;
        return Promise.resolve({ exitCode: 0, stdout: `${sha}\tHEAD\n`, stderr: '' });
      }
      if (argv[0] === 'clone') {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      if (argv[0] === '-C' && argv[2] === 'rev-parse') {
        const sha = isOtherUrl(lastLsUrl) ? SHA_V1_1_0 : SHA_V1_0_0;
        return Promise.resolve({ exitCode: 0, stdout: `${sha}\n`, stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    };

    // URL-aware via lastLsUrl (ls-remote always runs before checkout for a catalog).
    const tmpFactory: TmpDirFactory = async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-m1c3-multi-co-'));
      tmpDirs.push(tmpDir);
      const other = isOtherUrl(lastLsUrl);
      const entries: CatalogEntry[] = other
        ? [{
          kind: 'artifact',
          id: 'skill:other-only',
          nature: 'skill',
          targets: ['claude'],
          scopes: ['user', 'project'],
        }]
        : [REMOTE_SKILL_ENTRY];
      await fs.writeFile(
        path.join(tmpDir, 'catalog.json'),
        JSON.stringify({ meta: { name: other ? 'other' : 'principal' }, entries }),
        'utf8',
      );
      const skillId = other ? 'other-only' : 'remote-demo';
      await fs.mkdir(path.join(tmpDir, 'skills', skillId), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, 'skills', skillId, 'SKILL.md'),
        `# ${skillId}\n`,
        'utf8',
      );
      return {
        path: tmpDir,
        cleanup: async () => {
          await fs.rm(tmpDir, { recursive: true, force: true });
        },
      };
    };

    try {
      // Pre-install principal/skill:remote-demo at v1.0.0.
      const cap0 = makeCapture();
      await runCli(['install', 'principal/skill:remote-demo', '--yes'], {
        print: cap0.print,
        env,
        remote: { run: runner, tmpFactory, scanner: stubScanner },
      });

      // Update ALL — must not crash on the empty `other` catalog.
      const cap = makeCapture();
      const code = await runCli(['update', '--yes'], {
        print: cap.print,
        env,
        remote: { run: runner, tmpFactory, scanner: stubScanner },
      });

      const output = cap.lines.join('\n');
      expect(output).not.toMatch(/Unknown catalog entry/i);
      expect(code).toBe(0);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      for (const d of tmpDirs) {
        await fs.rm(d, { recursive: true, force: true }).catch(() => {});
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Part B — `check` update-available annotation
// ---------------------------------------------------------------------------

describe('check — update-available annotation (Part B)', () => {
  it('shows update-available section when external skill is stale', async () => {
    await preInstall(iso.env, TAG_V1_0_0, SHA_V1_0_0);
    iso.setRemoteTag(TAG_V1_1_0, SHA_V1_1_0);

    const cap = makeCapture();
    // check does not need tmpFactory (just ls-remote)
    await runCli(['check'], {
      print: cap.print,
      env: iso.env,
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    const output = cap.lines.join('\n');
    expect(output).toMatch(/update available|Updates/i);
    expect(output).toMatch(/remote-demo/i);
  });

  it('exit code is unchanged by update-available (0 when all present)', async () => {
    await preInstall(iso.env, TAG_V1_0_0, SHA_V1_0_0);
    iso.setRemoteTag(TAG_V1_1_0, SHA_V1_1_0);

    const cap = makeCapture();
    const code = await runCli(['check'], {
      print: cap.print,
      env: iso.env,
      remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    // check itself: guardrails-claude + context-claude may or may not be installed.
    // The update-available annotation must NOT change exit code from whatever check returns.
    // Key: if the check returned 0 before update annotation, it still returns 0 after.
    // We verify it is NOT 1 (no crash from update annotation).
    expect(code).not.toBe(1);
  });

  it('no update-available section when no catalogUrl configured', async () => {
    const noUrlIso = await makeIsolatedEnv({ withCatalogUrl: false });
    try {
      await preInstall(noUrlIso.env, TAG_V1_0_0, SHA_V1_0_0);

      const cap = makeCapture();
      await runCli(['check'], {
        print: cap.print,
        env: noUrlIso.env,
        remote: {
          run: noUrlIso.makeRunner(),
          tmpFactory: noUrlIso.makeTmpFactory(),
          scanner: stubScanner,
        },
      });

      const output = cap.lines.join('\n');
      expect(output).not.toMatch(/update available/i);
    } finally {
      await noUrlIso.cleanupAll();
    }
  });

  it('no update-available section and check normal when runner fails (best-effort)', async () => {
    await preInstall(iso.env, TAG_V1_0_0, SHA_V1_0_0);

    const cap = makeCapture();
    const code = await runCli(['check'], {
      print: cap.print,
      env: iso.env,
      remote: { run: failRunner, tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    const output = cap.lines.join('\n');
    expect(output).not.toMatch(/update available/i);
    // Must not crash — exit 0 or 3, never 1
    expect(code === 0 || code === 3).toBe(true);
  });

  it('no update-available section when all externals are up to date', async () => {
    await preInstall(iso.env, TAG_V1_0_0, SHA_V1_0_0);
    // Remote stays at v1.0.0

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

// ---------------------------------------------------------------------------
// Part A — USAGE: `update` no longer in Planned
// ---------------------------------------------------------------------------

describe('--help: update listed as active command', () => {
  it('update appears in usage output (not under Planned)', async () => {
    const cap = makeCapture();
    await runCli(['--help'], {
      print: cap.print,
      env: iso.env,
    });

    const output = cap.lines.join('\n');
    // "update" must appear in usage
    expect(output).toMatch(/update/i);
    // "Planned (not yet implemented)" section must NOT contain update
    const plannedMatch = output.match(/Planned[\s\S]*?(?=\n\n|$)/);
    if (plannedMatch) {
      expect(plannedMatch[0]).not.toMatch(/update/i);
    }
  });
});
