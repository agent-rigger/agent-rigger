/**
 * b7-adhoc-dirty-warning.test.ts — Warn on `install <local-path>` when the
 * source working tree has uncommitted changes (B7 / design D3).
 *
 * Why: withRemoteCheckout clones `--depth 1` and checks out the resolved sha —
 * the committed state only. An author testing a still-uncommitted skill via a
 * local path silently installs something other than what they are looking at.
 * The fix warns before the plan; it never blocks (exit 0 preserved).
 *
 * Strategy:
 * - `isLocalPathTarget` tested as a pure unit (the extracted local-path
 *   predicate) — the subset of ad-hoc targets the check applies to.
 * - Warning behaviour tested via `runCli` with a recording runner that stubs
 *   `git status --porcelain` (dirty / clean / failing) plus the usual
 *   ls-remote/clone/checkout — no real git.
 * - HOME isolated via tmp dir (RIGGER_HOME override — never touches real ~/.claude).
 *
 * Scenarios:
 *  1. isLocalPathTarget — ./ , / , ~/ → true ; URL, bare id → false.
 *  2. local source dirty  → warning emitted, `git status` called, exit 0, flow continues.
 *  3. local source clean  → no warning, exit 0.
 *  4. `git status` exits non-zero → no warning, no error, exit 0 (fail-open).
 *  5. `git status` throws (git absent) → no warning, no error, exit 0 (fail-open).
 *  6. remote URL source   → `git status` NEVER called (check is local-only).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandResult, CommandRunner } from '@agent-rigger/catalog/tool-check';
import type { Env } from '@agent-rigger/core/paths';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Scanner } from '@agent-rigger/core/scan';

import { isLocalPathTarget, runCli } from '../src/cli';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAKE_SHA = 'aabbccddeeff00112233445566778899aabbccdd';

const REMOTE_SKILL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:remote-demo',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

const DIRTY_STATUS: CommandResult = { exitCode: 0, stdout: ' M SKILL.md\n', stderr: '' };
const CLEAN_STATUS: CommandResult = { exitCode: 0, stdout: '', stderr: '' };
const FAILED_STATUS: CommandResult = {
  exitCode: 128,
  stdout: '',
  stderr: 'fatal: not a git repository',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCapture(): { lines: string[]; print: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

/** True when a recorded call is `git … status …`. */
function isStatusCall(call: string[]): boolean {
  return call[0] === 'git' && call.includes('status');
}

/**
 * A recording runner that answers `git … status …` with `statusResult` (or
 * throws, when `statusThrows` is set) and delegates every other git command to
 * the standard success stubs (ls-remote / clone / rev-parse). `calls` records
 * `[command, ...args]` for each invocation so tests can assert on order and on
 * whether the status probe ran at all.
 */
function makeRecordingRunner(opts: {
  statusResult?: CommandResult;
  statusThrows?: boolean;
}): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CommandRunner = (cmd, args) => {
    const argv = args ?? [];
    calls.push([cmd, ...argv]);

    if (cmd === 'git' && argv.includes('status')) {
      if (opts.statusThrows) {
        return Promise.reject(new Error('spawn git ENOENT'));
      }
      return Promise.resolve(opts.statusResult ?? CLEAN_STATUS);
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
  return { runner, calls };
}

function cleanScanner(): Scanner {
  return { scan: (_source: string) => Promise.resolve({ ok: true }) };
}

// ---------------------------------------------------------------------------
// makeAdHocEnv — isolated HOME + remote content dir (no config.catalogs)
// ---------------------------------------------------------------------------

async function makeAdHocEnv(): Promise<{
  env: Env;
  homeDir: string;
  contentDir: string;
  tmpFactory: TmpDirFactory;
  cleanupAll: () => Promise<void>;
}> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-b7-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-b7-content-'));

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 'adhoc-test-catalog' }, entries: [REMOTE_SKILL_ENTRY] }),
    'utf8',
  );

  await fs.mkdir(path.join(contentDir, 'skills', 'remote-demo'), { recursive: true });
  await fs.writeFile(
    path.join(contentDir, 'skills', 'remote-demo', 'SKILL.md'),
    '# Remote Demo\n\nAd-hoc install test skill.',
    'utf8',
  );

  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });

  const env: Env = { RIGGER_HOME: homeDir };
  const tmpFactory: TmpDirFactory = async () => ({ path: contentDir, cleanup: async () => {} });

  const cleanupAll = async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(contentDir, { recursive: true, force: true });
  };

  return { env, homeDir, contentDir, tmpFactory, cleanupAll };
}

// ---------------------------------------------------------------------------
// Section 1 — isLocalPathTarget (pure unit — the extracted predicate)
// ---------------------------------------------------------------------------

describe('isLocalPathTarget', () => {
  it('./relative is a local path', () => {
    expect(isLocalPathTarget('./skills')).toBe(true);
  });

  it('/absolute is a local path', () => {
    expect(isLocalPathTarget('/abs/path')).toBe(true);
  });

  it('~/home-relative is a local path', () => {
    expect(isLocalPathTarget('~/my/path')).toBe(true);
  });

  it('a URL is NOT a local path', () => {
    expect(isLocalPathTarget('https://github.com/o/bar.git')).toBe(false);
  });

  it('a bare id is NOT a local path', () => {
    expect(isLocalPathTarget('skill:foo')).toBe(false);
  });

  it('a git host without scheme is NOT a local path', () => {
    expect(isLocalPathTarget('github.com/o/repo')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Section 2 — local source, dirty working tree → warning + continue
// ---------------------------------------------------------------------------

describe('B7 — local install, dirty working tree', () => {
  let ctx: Awaited<ReturnType<typeof makeAdHocEnv>>;

  beforeEach(async () => {
    ctx = await makeAdHocEnv();
  });

  afterEach(async () => {
    await ctx.cleanupAll();
  });

  it('emits an uncommitted-changes warning, probes git status, and still exits 0', async () => {
    const { lines, print } = makeCapture();
    const { runner, calls } = makeRecordingRunner({ statusResult: DIRTY_STATUS });

    const code = await runCli(['install', ctx.contentDir, '--yes'], {
      print,
      env: ctx.env,
      remote: { run: runner, tmpFactory: ctx.tmpFactory, scanner: cleanScanner() },
    });

    expect(code).toBe(0);

    const output = lines.join('\n');
    expect(output).toMatch(/\[warning\]/i);
    expect(output).toMatch(/uncommitted changes/i);

    // The probe ran against the given source, before the clone.
    const statusCalls = calls.filter(isStatusCall);
    expect(statusCalls).toHaveLength(1);
    expect(statusCalls[0]).toEqual(['git', '-C', ctx.contentDir, 'status', '--porcelain']);
  });

  it('continues the flow — the skill is installed despite the warning', async () => {
    const { print } = makeCapture();
    const { runner } = makeRecordingRunner({ statusResult: DIRTY_STATUS });

    await runCli(['install', ctx.contentDir, '--yes'], {
      print,
      env: ctx.env,
      remote: { run: runner, tmpFactory: ctx.tmpFactory, scanner: cleanScanner() },
    });

    const targets = resolveUserTargets(ctx.env);
    const stat = await fs.stat(path.join(targets.skillsDir, 'remote-demo')).catch(() => null);
    expect(stat).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Section 3 — local source, clean working tree → no warning
// ---------------------------------------------------------------------------

describe('B7 — local install, clean working tree', () => {
  let ctx: Awaited<ReturnType<typeof makeAdHocEnv>>;

  beforeEach(async () => {
    ctx = await makeAdHocEnv();
  });

  afterEach(async () => {
    await ctx.cleanupAll();
  });

  it('emits no uncommitted-changes warning and exits 0', async () => {
    const { lines, print } = makeCapture();
    const { runner, calls } = makeRecordingRunner({ statusResult: CLEAN_STATUS });

    const code = await runCli(['install', ctx.contentDir, '--yes'], {
      print,
      env: ctx.env,
      remote: { run: runner, tmpFactory: ctx.tmpFactory, scanner: cleanScanner() },
    });

    expect(code).toBe(0);
    expect(lines.join('\n')).not.toMatch(/uncommitted changes/i);
    // Probe still ran (clean is a real answer, not a skipped check).
    expect(calls.filter(isStatusCall)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Section 4 — fail-open: git status fails → no warning, no error
// ---------------------------------------------------------------------------

describe('B7 — fail-open when git status cannot answer', () => {
  let ctx: Awaited<ReturnType<typeof makeAdHocEnv>>;

  beforeEach(async () => {
    ctx = await makeAdHocEnv();
  });

  afterEach(async () => {
    await ctx.cleanupAll();
  });

  it('git status exits non-zero (not a repo) → no warning, exit 0', async () => {
    const { lines, print } = makeCapture();
    const { runner } = makeRecordingRunner({ statusResult: FAILED_STATUS });

    const code = await runCli(['install', ctx.contentDir, '--yes'], {
      print,
      env: ctx.env,
      remote: { run: runner, tmpFactory: ctx.tmpFactory, scanner: cleanScanner() },
    });

    expect(code).toBe(0);
    expect(lines.join('\n')).not.toMatch(/uncommitted changes/i);
  });

  it('git status throws (git absent) → no warning, exit 0', async () => {
    const { lines, print } = makeCapture();
    const { runner } = makeRecordingRunner({ statusThrows: true });

    const code = await runCli(['install', ctx.contentDir, '--yes'], {
      print,
      env: ctx.env,
      remote: { run: runner, tmpFactory: ctx.tmpFactory, scanner: cleanScanner() },
    });

    expect(code).toBe(0);
    expect(lines.join('\n')).not.toMatch(/uncommitted changes/i);
  });
});

// ---------------------------------------------------------------------------
// Section 5 — remote URL source → check does not apply
// ---------------------------------------------------------------------------

describe('B7 — remote URL install is never probed for a dirty tree', () => {
  let ctx: Awaited<ReturnType<typeof makeAdHocEnv>>;

  beforeEach(async () => {
    ctx = await makeAdHocEnv();
  });

  afterEach(async () => {
    await ctx.cleanupAll();
  });

  it('does not run git status for a URL source', async () => {
    const { print } = makeCapture();
    const { runner, calls } = makeRecordingRunner({ statusResult: DIRTY_STATUS });

    const code = await runCli(['install', 'https://github.com/owner/bar.git', '--yes'], {
      print,
      env: ctx.env,
      remote: { run: runner, tmpFactory: ctx.tmpFactory, scanner: cleanScanner() },
    });

    expect(code).toBe(0);
    expect(calls.filter(isStatusCall)).toHaveLength(0);
  });
});
