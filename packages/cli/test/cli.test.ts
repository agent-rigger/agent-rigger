/**
 * Tests for cli.ts — parseArgs + runCli routing.
 *
 * Strategy:
 * - parseArgs: pure unit tests, no I/O.
 * - runCli: inject deps (print capture, tmp HOME, fake prompts, real artifacts dir).
 *   No real process.exit — runCli returns the exit code.
 * - Real filesystem via tmp dirs for install/check tests.
 * - No while loops.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseArgs, runCli } from '../src/cli';
import type { CliPrompts } from '../src/cli';

// ---------------------------------------------------------------------------
// Repo root — resolve relative to this file
// ---------------------------------------------------------------------------

// packages/cli/test → packages/cli → packages → agent-rigger (repo root)
const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const ARTIFACTS_DIR = path.join(REPO_ROOT, 'artifacts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-cli-test-'): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

function makeCapture(): { lines: string[]; print: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

function fakePrompts(): CliPrompts {
  return {
    selectArtifacts: async () => ['guardrails-claude', 'context-claude'],
    selectScope: async () => 'user',
    confirmApply: async (_planText) => true,
    askUrl: async () => 'https://github.com/example/catalog.git',
    askMethod: async () => 'https',
  };
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('parses "check" command', () => {
    const result = parseArgs(['check']);
    expect(result.command).toBe('check');
    expect(result.flags).toEqual({});
  });

  it('parses "install" command', () => {
    const result = parseArgs(['install']);
    expect(result.command).toBe('install');
  });

  it('parses "init" command', () => {
    const result = parseArgs(['init']);
    expect(result.command).toBe('init');
  });

  it('parses --scope=user flag', () => {
    const result = parseArgs(['check', '--scope=user']);
    expect(result.command).toBe('check');
    expect(result.flags['scope']).toBe('user');
  });

  it('parses --scope=project flag', () => {
    const result = parseArgs(['install', '--scope=project']);
    expect(result.flags['scope']).toBe('project');
  });

  it('parses --help flag', () => {
    const result = parseArgs(['--help']);
    expect(result.flags['help']).toBe(true);
  });

  it('parses --version flag', () => {
    const result = parseArgs(['--version']);
    expect(result.flags['version']).toBe(true);
  });

  it('handles no args', () => {
    const result = parseArgs([]);
    expect(result.command).toBeUndefined();
    expect(result.flags).toEqual({});
  });

  it('handles unknown command', () => {
    const result = parseArgs(['foobar']);
    expect(result.command).toBe('foobar');
  });

  it('handles boolean flag without value', () => {
    const result = parseArgs(['--verbose']);
    expect(result.flags['verbose']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runCli — help / version / unknown
// ---------------------------------------------------------------------------

describe('runCli — --help', () => {
  it('returns exit code 0', async () => {
    const cap = makeCapture();
    const code = await runCli(['--help'], { print: cap.print });
    expect(code).toBe(0);
  });

  it('output contains usage keywords', async () => {
    const cap = makeCapture();
    await runCli(['--help'], { print: cap.print });
    const out = cap.lines.join('\n');
    expect(out).toContain('agent-rigger');
    expect(out).toMatch(/check|install|init/);
  });

  it('output mentions all three commands', async () => {
    const cap = makeCapture();
    await runCli(['--help'], { print: cap.print });
    const out = cap.lines.join('\n');
    expect(out).toContain('check');
    expect(out).toContain('install');
    expect(out).toContain('init');
  });
});

describe('runCli — --version', () => {
  it('returns exit code 0', async () => {
    const cap = makeCapture();
    const code = await runCli(['--version'], { print: cap.print });
    expect(code).toBe(0);
  });

  it('output contains a version string', async () => {
    const cap = makeCapture();
    await runCli(['--version'], { print: cap.print });
    const out = cap.lines.join('\n');
    // Should look like a semver or at least contain a number
    expect(out).toMatch(/\d/);
  });
});

describe('runCli — no args', () => {
  it('returns exit code 0 (shows usage)', async () => {
    const cap = makeCapture();
    const code = await runCli([], { print: cap.print });
    expect(code).toBe(0);
  });

  it('prints usage', async () => {
    const cap = makeCapture();
    await runCli([], { print: cap.print });
    const out = cap.lines.join('\n');
    expect(out).toContain('agent-rigger');
  });
});

describe('runCli — unknown command', () => {
  it('returns exit code 2', async () => {
    const cap = makeCapture();
    const code = await runCli(['foobar'], { print: cap.print });
    expect(code).toBe(2);
  });

  it('output contains usage hint', async () => {
    const cap = makeCapture();
    await runCli(['foobar'], { print: cap.print });
    const out = cap.lines.join('\n');
    // Should mention what went wrong or how to get help
    expect(out.toLowerCase()).toMatch(/unknown|usage|help/);
  });
});

// ---------------------------------------------------------------------------
// runCli — invalid --scope
// ---------------------------------------------------------------------------

describe('runCli — invalid --scope', () => {
  it('returns exit code 2 for unknown scope value', async () => {
    const cap = makeCapture();
    const code = await runCli(['check', '--scope=usr'], { print: cap.print });
    expect(code).toBe(2);
  });

  it('output contains actionable message for invalid scope', async () => {
    const cap = makeCapture();
    await runCli(['check', '--scope=usr'], { print: cap.print });
    const out = cap.lines.join('\n');
    expect(out).toMatch(/scope|user|project/i);
  });

  it('returns exit code 2 for --scope=admin', async () => {
    const cap = makeCapture();
    const code = await runCli(['install', '--scope=admin'], { print: cap.print });
    expect(code).toBe(2);
  });

  it('accepts --scope=user without error', async () => {
    const cap = makeCapture();
    // No real env needed — scope validation happens before buildClaudeAdapter
    // We just need it not to return 2 on scope validation
    // It may fail later (no artifacts dir) but that's code 1 not 2 from scope
    const code = await runCli(['check', '--scope=user'], {
      print: cap.print,
      env: { RIGGER_HOME: '/tmp/nonexistent-rigger-home-test' },
      artifactsDir: ARTIFACTS_DIR,
    });
    // Should not be 2 (scope error); any other code is acceptable
    expect(code).not.toBe(2);
  });

  it('accepts --scope=project without scope error', async () => {
    const cap = makeCapture();
    const code = await runCli(['check', '--scope=project'], {
      print: cap.print,
      env: { RIGGER_HOME: '/tmp/nonexistent-rigger-home-test' },
      artifactsDir: ARTIFACTS_DIR,
    });
    expect(code).not.toBe(2);
  });
});

// ---------------------------------------------------------------------------
// runCli — check command
// ---------------------------------------------------------------------------

describe('runCli — check, incomplete HOME', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('returns exit code 3 when guardrails are not installed', async () => {
    const cap = makeCapture();
    const code = await runCli(['check'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });
    // 3 = missing entries
    expect(code).toBe(3);
  });

  it('output mentions missing or check state', async () => {
    const cap = makeCapture();
    await runCli(['check'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });
    const out = cap.lines.join('\n');
    expect(out.toLowerCase()).toMatch(/missing|check|present/);
  });
});

// ---------------------------------------------------------------------------
// runCli — install command + idempotence
// ---------------------------------------------------------------------------

describe('runCli — install + check flow', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('install with fake prompts returns exit code 0', async () => {
    const cap = makeCapture();
    const code = await runCli(['install'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
      prompts: fakePrompts(),
    });
    expect(code).toBe(0);
  });

  it('install writes settings.json', async () => {
    const cap = makeCapture();
    await runCli(['install'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
      prompts: fakePrompts(),
    });
    const settingsPath = path.join(tmp.dir, '.claude', 'settings.json');
    const exists = await fs.stat(settingsPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it('re-run install is idempotent (exit code 0)', async () => {
    const caps = [makeCapture(), makeCapture()];
    const sharedEnv = { RIGGER_HOME: tmp.dir };
    const prompts = fakePrompts();

    await runCli(['install'], {
      print: caps[0]!.print,
      env: sharedEnv,
      artifactsDir: ARTIFACTS_DIR,
      prompts,
    });
    const code2 = await runCli(['install'], {
      print: caps[1]!.print,
      env: sharedEnv,
      artifactsDir: ARTIFACTS_DIR,
      prompts,
    });
    expect(code2).toBe(0);
  });

  it('check returns 0 after successful install', async () => {
    const installCap = makeCapture();
    const checkCap = makeCapture();
    const sharedEnv = { RIGGER_HOME: tmp.dir };
    const prompts = fakePrompts();

    await runCli(['install'], {
      print: installCap.print,
      env: sharedEnv,
      artifactsDir: ARTIFACTS_DIR,
      prompts,
    });
    const checkCode = await runCli(['check'], {
      print: checkCap.print,
      env: sharedEnv,
      artifactsDir: ARTIFACTS_DIR,
    });
    // After install, check should see guardrail + context as present
    expect(checkCode).toBe(0);
  });

  it('install with confirmApply=false returns exit code 0 (aborted cleanly)', async () => {
    const cap = makeCapture();
    const prompts: CliPrompts = {
      ...fakePrompts(),
      confirmApply: async (_planText) => false,
    };
    const code = await runCli(['install'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
      prompts,
    });
    // Aborted cleanly = 0 (no error, user cancelled)
    expect(code).toBe(0);
  });
});
