/**
 * m8-adhoc-install.test.ts — Ad-hoc install from a URL or local path (M8 / R8).
 *
 * Strategy:
 * - `isAdHocTarget` and `deriveAdHocPrefix` are tested as pure units (no I/O).
 * - Full install flow tested via `runCli` with a fake runner + tmpFactory + scanner.
 * - HOME isolated via tmp dir (RIGGER_HOME override — never touches real ~/.claude).
 * - No real git network calls.
 *
 * Scenarios:
 *  1. Detection — isAdHocTarget:
 *      a. URL with ://          → ad-hoc
 *      b. .git suffix URL       → ad-hoc
 *      c. git@ SSH URL          → ad-hoc
 *      d. starts with ./        → ad-hoc
 *      e. starts with /         → ad-hoc
 *      f. starts with ~/        → ad-hoc
 *      g. existing FS path      → ad-hoc  (resolved in integration, not unit)
 *      h. qualified id x/y:z    → NOT ad-hoc
 *      i. bare id skill:foo     → NOT ad-hoc (not a recognised URL/path)
 *      j. gitlab.com/o/baz      → ad-hoc (no :// but known git host + /)
 *
 *  2. Prefix derivation — deriveAdHocPrefix:
 *      a. https://github.com/owner/bar.git  → gh-bar
 *      b. ./skills                          → local-skills
 *      c. gitlab.com/owner/baz             → glab-baz
 *      d. https://bitbucket.org/x/foo.git  → bitbucket-foo
 *      e. git@github.com:owner/MyRepo.git  → gh-myrepo  (lowercase)
 *      f. /abs/path/to/my_project          → local-my-project  (sanitize _ → -)
 *      g. https://custom.host/o/thing.git  → host-thing  (strip TLD)
 *      h. ~/relative/path/My-Skill         → local-my-skill
 *
 *  3. Sanitization — prefix must match [a-z0-9-]:
 *      a. upper-case letters → lower-case
 *      b. underscores       → hyphen
 *      c. consecutive hyphens deduplicated
 *
 *  4. Install flow — ad-hoc via runCli:
 *      a. `install https://github.com/owner/bar.git --yes` installs skill,
 *         manifest id has prefix gh-bar/<nature:name>
 *      b. no scanner tool (degraded) → warning emitted, install proceeds
 *      c. scanner with real findings → ScanBlockedError / exit 1 (no --force)
 *      d. scanner with findings + --force → exit 0, warning in output
 *
 *  5. parseArgs — `install <url>` captures as resourceIds[0]
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import type { Env } from '@agent-rigger/core/paths';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Scanner } from '@agent-rigger/core/scan';

import { deriveAdHocPrefix, isAdHocTarget, parseArgs, runCli } from '../src/cli';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAKE_SHA = 'aabbccddeeff00112233445566778899aabbccdd';
const TAG_NAME = 'v1.0.0';

const REMOTE_SKILL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:remote-demo',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCapture(): { lines: string[]; print: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

function makeSuccessRunner(): CommandRunner {
  return (_cmd, args) => {
    const argv = args ?? [];
    if (argv[0] === 'ls-remote' && argv.includes('--tags')) {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${FAKE_SHA}\trefs/tags/${TAG_NAME}\n`,
        stderr: '',
      });
    }
    if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
      return Promise.resolve({ exitCode: 0, stdout: `${FAKE_SHA}\tHEAD\n`, stderr: '' });
    }
    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${FAKE_SHA}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };
}

function cleanScanner(): Scanner {
  return { scan: (_source: string) => Promise.resolve({ ok: true }) };
}

function degradedScanner(): Scanner {
  return { scan: (_source: string) => Promise.resolve({ ok: true, degraded: true }) };
}

function blockingScanner(findings: string[]): Scanner {
  return { scan: (_source: string) => Promise.resolve({ ok: false, findings }) };
}

// ---------------------------------------------------------------------------
// makeAdHocEnv — isolated HOME + remote content dir (no config.catalogs)
// ---------------------------------------------------------------------------

async function makeAdHocEnv(entries: CatalogEntry[] = [REMOTE_SKILL_ENTRY]): Promise<{
  env: Env;
  homeDir: string;
  contentDir: string;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  cleanupAll: () => Promise<void>;
}> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-m8-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-m8-content-'));

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({
      meta: { name: 'adhoc-test-catalog' },
      entries,
    }),
    'utf8',
  );

  // Write skill fixture
  await fs.mkdir(path.join(contentDir, 'skills', 'remote-demo'), { recursive: true });
  await fs.writeFile(
    path.join(contentDir, 'skills', 'remote-demo', 'SKILL.md'),
    '# Remote Demo\n\nAd-hoc install test skill.',
    'utf8',
  );

  // No config.json written — config.catalogs is empty (ad-hoc path).
  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });

  const env: Env = { RIGGER_HOME: homeDir };
  const runner = makeSuccessRunner();

  const tmpFactory: TmpDirFactory = async () => ({
    path: contentDir,
    cleanup: async () => {},
  });

  const cleanupAll = async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(contentDir, { recursive: true, force: true });
  };

  return { env, homeDir, contentDir, runner, tmpFactory, cleanupAll };
}

// ---------------------------------------------------------------------------
// Section 1 — isAdHocTarget detection
// ---------------------------------------------------------------------------

describe('isAdHocTarget — URL detection', () => {
  it('URL with :// is ad-hoc', () => {
    expect(isAdHocTarget('https://github.com/o/bar.git')).toBe(true);
  });

  it('.git suffix URL is ad-hoc', () => {
    expect(isAdHocTarget('github.com/o/repo.git')).toBe(true);
  });

  it('git@ SSH URL is ad-hoc', () => {
    expect(isAdHocTarget('git@github.com:owner/repo.git')).toBe(true);
  });

  it('starts with ./ is ad-hoc', () => {
    expect(isAdHocTarget('./skills')).toBe(true);
  });

  it('starts with / is ad-hoc', () => {
    expect(isAdHocTarget('/absolute/path')).toBe(true);
  });

  it('starts with ~/ is ad-hoc', () => {
    expect(isAdHocTarget('~/my/path')).toBe(true);
  });

  it('host/owner/repo without :// but looks like a git host — gitlab.com ad-hoc', () => {
    expect(isAdHocTarget('gitlab.com/o/baz')).toBe(true);
  });

  it('github.com/o/repo without :// is ad-hoc', () => {
    expect(isAdHocTarget('github.com/o/repo')).toBe(true);
  });
});

describe('isAdHocTarget — qualified id NOT ad-hoc', () => {
  it('qualified id principal/skill:foo is NOT ad-hoc', () => {
    expect(isAdHocTarget('principal/skill:foo')).toBe(false);
  });

  it('qualified id with nature gh-bar/skill:x is NOT ad-hoc', () => {
    expect(isAdHocTarget('gh-bar/skill:x')).toBe(false);
  });
});

describe('isAdHocTarget — bare id NOT ad-hoc', () => {
  it('bare id skill:foo is NOT ad-hoc', () => {
    expect(isAdHocTarget('skill:foo')).toBe(false);
  });

  it('bare id agent:demo is NOT ad-hoc', () => {
    expect(isAdHocTarget('agent:demo')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Section 2 — deriveAdHocPrefix
// ---------------------------------------------------------------------------

describe('deriveAdHocPrefix — GitHub', () => {
  it('https://github.com/owner/bar.git → gh-bar', () => {
    expect(deriveAdHocPrefix('https://github.com/owner/bar.git')).toBe('gh-bar');
  });

  it('git@github.com:owner/MyRepo.git → gh-myrepo (lowercase)', () => {
    expect(deriveAdHocPrefix('git@github.com:owner/MyRepo.git')).toBe('gh-myrepo');
  });

  it('github.com/owner/foo → gh-foo', () => {
    expect(deriveAdHocPrefix('github.com/owner/foo')).toBe('gh-foo');
  });
});

describe('deriveAdHocPrefix — GitLab', () => {
  it('gitlab.com/owner/baz → glab-baz', () => {
    expect(deriveAdHocPrefix('gitlab.com/owner/baz')).toBe('glab-baz');
  });

  it('https://gitlab.com/owner/baz.git → glab-baz', () => {
    expect(deriveAdHocPrefix('https://gitlab.com/owner/baz.git')).toBe('glab-baz');
  });
});

describe('deriveAdHocPrefix — other hosts', () => {
  it('https://bitbucket.org/x/foo.git → bitbucket-foo', () => {
    expect(deriveAdHocPrefix('https://bitbucket.org/x/foo.git')).toBe('bitbucket-foo');
  });

  it('https://custom.host/o/thing.git → custom-thing (strip TLD)', () => {
    expect(deriveAdHocPrefix('https://custom.host/o/thing.git')).toBe('custom-thing');
  });
});

describe('deriveAdHocPrefix — local paths', () => {
  it('./skills → local-skills', () => {
    expect(deriveAdHocPrefix('./skills')).toBe('local-skills');
  });

  it('/abs/path/to/my_project → local-my-project (sanitize _ → -)', () => {
    expect(deriveAdHocPrefix('/abs/path/to/my_project')).toBe('local-my-project');
  });

  it('~/relative/path/My-Skill → local-my-skill (lowercase)', () => {
    expect(deriveAdHocPrefix('~/relative/path/My-Skill')).toBe('local-my-skill');
  });
});

// ---------------------------------------------------------------------------
// Section 3 — sanitization edge cases
// ---------------------------------------------------------------------------

describe('deriveAdHocPrefix — sanitization', () => {
  it('upper-case repo name is lowercased', () => {
    expect(deriveAdHocPrefix('https://github.com/owner/MyRepo.git')).toBe('gh-myrepo');
  });

  it('underscores become hyphens', () => {
    expect(deriveAdHocPrefix('/path/to/my_catalog')).toBe('local-my-catalog');
  });

  it('consecutive hyphens are deduplicated', () => {
    // e.g. local part that becomes 'foo--bar' after replacements → 'foo-bar'
    expect(deriveAdHocPrefix('https://github.com/owner/foo--bar.git')).toBe('gh-foo-bar');
  });
});

// ---------------------------------------------------------------------------
// Section 4a — parseArgs picks up URL as resourceIds[0]
// ---------------------------------------------------------------------------

describe('parseArgs — install <url>', () => {
  it('install <url> stores url in resourceIds', () => {
    const result = parseArgs(['install', 'https://github.com/o/bar.git']);
    expect(result.command).toBe('install');
    expect(result.resourceIds).toEqual(['https://github.com/o/bar.git']);
  });

  it('install <url> --yes --force both flags parsed', () => {
    const result = parseArgs([
      'install',
      'https://github.com/o/bar.git',
      '--yes',
      '--force',
    ]);
    expect(result.resourceIds).toEqual(['https://github.com/o/bar.git']);
    expect(result.flags['yes']).toBe(true);
    expect(result.flags['force']).toBe(true);
  });

  it('install ./skills stores path in resourceIds', () => {
    const result = parseArgs(['install', './skills']);
    expect(result.resourceIds).toEqual(['./skills']);
  });
});

// ---------------------------------------------------------------------------
// Section 4b — full install flow via runCli (ad-hoc URL + clean scanner)
// ---------------------------------------------------------------------------

describe('M8 — ad-hoc install from URL (clean scanner)', () => {
  let ctx: Awaited<ReturnType<typeof makeAdHocEnv>>;
  let targets: ReturnType<typeof resolveUserTargets>;

  beforeEach(async () => {
    ctx = await makeAdHocEnv();
    targets = resolveUserTargets(ctx.env);
  });

  afterEach(async () => {
    await ctx.cleanupAll();
  });

  it('returns exit code 0', async () => {
    const { print } = makeCapture();
    const code = await runCli(
      ['install', 'https://github.com/owner/bar.git', '--yes'],
      {
        print,
        env: ctx.env,
        remote: {
          run: ctx.runner,
          tmpFactory: ctx.tmpFactory,
          scanner: cleanScanner(),
        },
      },
    );
    expect(code).toBe(0);
  });

  it('skill is written to store', async () => {
    const { print } = makeCapture();
    await runCli(
      ['install', 'https://github.com/owner/bar.git', '--yes'],
      {
        print,
        env: ctx.env,
        remote: {
          run: ctx.runner,
          tmpFactory: ctx.tmpFactory,
          scanner: cleanScanner(),
        },
      },
    );
    const skillPath = path.join(targets.skillsDir, 'remote-demo');
    const stat = await fs.stat(skillPath).catch(() => null);
    expect(stat).not.toBeNull();
  });

  it('manifest stores qualified id with derived prefix (gh-bar/skill:remote-demo)', async () => {
    const { print } = makeCapture();
    await runCli(
      ['install', 'https://github.com/owner/bar.git', '--yes'],
      {
        print,
        env: ctx.env,
        remote: {
          run: ctx.runner,
          tmpFactory: ctx.tmpFactory,
          scanner: cleanScanner(),
        },
      },
    );
    const { readManifest } = await import('@agent-rigger/core/manifest');
    const manifest = await readManifest(targets.stateJson);
    const entry = manifest.artifacts.find((a) => a.id.includes('skill:remote-demo'));
    expect(entry).toBeDefined();
    expect(entry?.id).toBe('gh-bar/skill:remote-demo');
  });
});

// ---------------------------------------------------------------------------
// Section 4c — warn-only when no scanner tool (degraded)
// ---------------------------------------------------------------------------

describe('M8 — ad-hoc install, degraded scanner (no tool installed)', () => {
  let ctx: Awaited<ReturnType<typeof makeAdHocEnv>>;

  beforeEach(async () => {
    ctx = await makeAdHocEnv();
  });

  afterEach(async () => {
    await ctx.cleanupAll();
  });

  it('returns exit code 0 when scanner is degraded', async () => {
    const { print } = makeCapture();
    const code = await runCli(
      ['install', 'https://github.com/owner/bar.git', '--yes'],
      {
        print,
        env: ctx.env,
        remote: {
          run: ctx.runner,
          tmpFactory: ctx.tmpFactory,
          scanner: degradedScanner(),
        },
      },
    );
    expect(code).toBe(0);
  });

  it('output contains scanner warning', async () => {
    const { lines, print } = makeCapture();
    await runCli(
      ['install', 'https://github.com/owner/bar.git', '--yes'],
      {
        print,
        env: ctx.env,
        remote: {
          run: ctx.runner,
          tmpFactory: ctx.tmpFactory,
          scanner: degradedScanner(),
        },
      },
    );
    const output = lines.join('\n');
    expect(output).toMatch(/\[warning\]/i);
    expect(output).toMatch(/non scanné|not scanned|unscanned/i);
  });
});

// ---------------------------------------------------------------------------
// Section 4d — scanner with findings + no --force → exit 1
// ---------------------------------------------------------------------------

describe('M8 — ad-hoc install, blocking scanner, no --force', () => {
  let ctx: Awaited<ReturnType<typeof makeAdHocEnv>>;

  beforeEach(async () => {
    ctx = await makeAdHocEnv();
  });

  afterEach(async () => {
    await ctx.cleanupAll();
  });

  it('returns exit code 1 when scanner blocks', async () => {
    const { print } = makeCapture();
    const code = await runCli(
      ['install', 'https://github.com/owner/bar.git', '--yes'],
      {
        print,
        env: ctx.env,
        remote: {
          run: ctx.runner,
          tmpFactory: ctx.tmpFactory,
          scanner: blockingScanner(['[gitleaks] aws-key detected']),
        },
      },
    );
    expect(code).toBe(1);
  });

  it('output mentions security scan blocked', async () => {
    const { lines, print } = makeCapture();
    await runCli(
      ['install', 'https://github.com/owner/bar.git', '--yes'],
      {
        print,
        env: ctx.env,
        remote: {
          run: ctx.runner,
          tmpFactory: ctx.tmpFactory,
          scanner: blockingScanner(['[gitleaks] aws-key detected']),
        },
      },
    );
    const output = lines.join('\n');
    expect(output).toContain('[error]');
  });
});

// ---------------------------------------------------------------------------
// Section 4e — scanner with findings + --force → exit 0 + warning
// ---------------------------------------------------------------------------

describe('M8 — ad-hoc install, blocking scanner, with --force', () => {
  let ctx: Awaited<ReturnType<typeof makeAdHocEnv>>;

  beforeEach(async () => {
    ctx = await makeAdHocEnv();
  });

  afterEach(async () => {
    await ctx.cleanupAll();
  });

  it('returns exit code 0 with --force despite blocking scanner', async () => {
    const { print } = makeCapture();
    const code = await runCli(
      ['install', 'https://github.com/owner/bar.git', '--yes', '--force'],
      {
        print,
        env: ctx.env,
        remote: {
          run: ctx.runner,
          tmpFactory: ctx.tmpFactory,
          scanner: blockingScanner(['[gitleaks] aws-key detected']),
        },
      },
    );
    expect(code).toBe(0);
  });

  it('output contains warning about findings when --force used', async () => {
    const { lines, print } = makeCapture();
    await runCli(
      ['install', 'https://github.com/owner/bar.git', '--yes', '--force'],
      {
        print,
        env: ctx.env,
        remote: {
          run: ctx.runner,
          tmpFactory: ctx.tmpFactory,
          scanner: blockingScanner(['[gitleaks] aws-key detected']),
        },
      },
    );
    const output = lines.join('\n');
    expect(output).toContain('[warning]');
  });
});
