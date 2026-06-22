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

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';

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
// Module-level runners (no outer scope captures — extracted per lint)
// ---------------------------------------------------------------------------

/** A CommandRunner that always fails with exit code 1. */
const alwaysFailRunner: CommandRunner = (_cmd, _args) =>
  Promise.resolve({ exitCode: 1, stdout: '', stderr: 'auth required' });

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

// ---------------------------------------------------------------------------
// parseArgs — resource-scoped grammar
// ---------------------------------------------------------------------------

describe('parseArgs — resource grammar', () => {
  it('parses ["skills","ls"] with resource and verb', () => {
    const result = parseArgs(['skills', 'ls']);
    expect(result.command).toBe('skills');
    expect(result.resourceVerb).toBe('ls');
    expect(result.resourceIds).toEqual([]);
  });

  it('parses ["catalog","ls"]', () => {
    const result = parseArgs(['catalog', 'ls']);
    expect(result.command).toBe('catalog');
    expect(result.resourceVerb).toBe('ls');
  });

  it('parses ["ls"] as top-level ls command', () => {
    const result = parseArgs(['ls']);
    expect(result.command).toBe('ls');
    expect(result.resourceVerb).toBeUndefined();
  });

  it('parses ["install","guardrails-claude"] as non-interactive install with ids', () => {
    const result = parseArgs(['install', 'guardrails-claude']);
    expect(result.command).toBe('install');
    expect(result.resourceIds).toContain('guardrails-claude');
  });

  it('parses ["skills","add","skill:spec-workflow"] as resource add', () => {
    const result = parseArgs(['skills', 'add', 'skill:spec-workflow']);
    expect(result.command).toBe('skills');
    expect(result.resourceVerb).toBe('add');
    expect(result.resourceIds).toContain('skill:spec-workflow');
  });

  it('parses ["install","--yes","guardrails-claude"] with yes flag', () => {
    const result = parseArgs(['install', '--yes', 'guardrails-claude']);
    expect(result.command).toBe('install');
    expect(result.flags['yes']).toBe(true);
    expect(result.resourceIds).toContain('guardrails-claude');
  });
});

// ---------------------------------------------------------------------------
// runCli — ls command
// ---------------------------------------------------------------------------

describe('runCli — ls (top-level)', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome('rigger-ls-cli-');
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('returns exit code 0', async () => {
    const cap = makeCapture();
    const code = await runCli(['ls'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });
    expect(code).toBe(0);
  });

  it('output contains catalog listing', async () => {
    const cap = makeCapture();
    await runCli(['ls'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });
    const out = cap.lines.join('\n');
    expect(out).toContain('Catalog');
    expect(out).toContain('guardrails-claude');
  });
});

describe('runCli — skills ls (filtered)', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome('rigger-skills-ls-');
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('returns exit code 0', async () => {
    const cap = makeCapture();
    const code = await runCli(['skills', 'ls'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });
    expect(code).toBe(0);
  });

  it('output contains only skill entries', async () => {
    const cap = makeCapture();
    await runCli(['skills', 'ls'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });
    const out = cap.lines.join('\n');
    expect(out).toContain('skill:spec-workflow');
    expect(out).not.toContain('guardrails-claude');
  });
});

// ---------------------------------------------------------------------------
// runCli — non-interactive install with --yes
// ---------------------------------------------------------------------------

describe('runCli — install <id> --yes (non-interactive)', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome('rigger-install-yes-');
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('returns exit code 0 for valid id with --yes', async () => {
    const cap = makeCapture();
    const code = await runCli(['install', 'guardrails-claude', '--yes'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });
    expect(code).toBe(0);
  });

  it('does not call selectArtifacts prompt when ids provided', async () => {
    let selectCalled = false;
    const prompts: CliPrompts = {
      ...fakePrompts(),
      selectArtifacts: async () => {
        selectCalled = true;
        return [];
      },
    };
    const cap = makeCapture();
    await runCli(['install', 'guardrails-claude', '--yes'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
      prompts,
    });
    expect(selectCalled).toBe(false);
  });

  it('does not call confirmApply when --yes flag is set', async () => {
    let confirmCalled = false;
    const prompts: CliPrompts = {
      ...fakePrompts(),
      confirmApply: async () => {
        confirmCalled = true;
        return true;
      },
    };
    const cap = makeCapture();
    await runCli(['install', 'guardrails-claude', '--yes'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
      prompts,
    });
    expect(confirmCalled).toBe(false);
  });

  it('calls confirmApply when --yes is NOT set (non-interactive confirm)', async () => {
    let confirmCalled = false;
    const prompts: CliPrompts = {
      ...fakePrompts(),
      confirmApply: async () => {
        confirmCalled = true;
        return true;
      },
    };
    const cap = makeCapture();
    await runCli(['install', 'guardrails-claude'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
      prompts,
    });
    expect(confirmCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runCli — resource add validation
// ---------------------------------------------------------------------------

describe('runCli — <resource> add <id> validation', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome('rigger-res-add-');
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('returns exit code 2 when id does not match resource type', async () => {
    const cap = makeCapture();
    // guardrails-claude is a guardrail, not a skill
    const code = await runCli(['skills', 'add', 'guardrails-claude'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });
    expect(code).toBe(2);
  });

  it('output contains actionable error message for type mismatch', async () => {
    const cap = makeCapture();
    await runCli(['skills', 'add', 'guardrails-claude'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });
    const out = cap.lines.join('\n');
    expect(out).toContain('guardrails-claude');
    expect(out.toLowerCase()).toMatch(/not a skill|is not a/);
  });

  it('returns exit code 0 for guardrail add with correct resource', async () => {
    const cap = makeCapture();
    const code = await runCli(['guardrails', 'add', 'guardrails-claude', '--yes'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runCli — <resource> info <id>
// ---------------------------------------------------------------------------

describe('runCli — <resource> info <id>', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome('rigger-info-');
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('returns exit code 0 for known id', async () => {
    const cap = makeCapture();
    const code = await runCli(['guardrails', 'info', 'guardrails-claude'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });
    expect(code).toBe(0);
  });

  it('output contains entry details', async () => {
    const cap = makeCapture();
    await runCli(['guardrails', 'info', 'guardrails-claude'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });
    const out = cap.lines.join('\n');
    expect(out).toContain('guardrails-claude');
    expect(out.toLowerCase()).toMatch(/status|source|nature|guardrail/);
  });

  it('returns exit code 2 for unknown id', async () => {
    const cap = makeCapture();
    const code = await runCli(['guardrails', 'info', 'does-not-exist'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });
    expect(code).toBe(2);
  });

  it('output contains actionable message for unknown id', async () => {
    const cap = makeCapture();
    await runCli(['guardrails', 'info', 'does-not-exist'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });
    const out = cap.lines.join('\n');
    expect(out).toContain('does-not-exist');
  });
});

// ---------------------------------------------------------------------------
// runCli — <resource> check
// ---------------------------------------------------------------------------

describe('runCli — <resource> check', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome('rigger-res-check-');
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('returns exit code 3 when guardrails not installed', async () => {
    const cap = makeCapture();
    const code = await runCli(['guardrails', 'check'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });
    expect(code).toBe(3);
  });

  it('returns exit code 0 after installing guardrails', async () => {
    // First install guardrails
    const installCap = makeCapture();
    await runCli(['guardrails', 'add', 'guardrails-claude', '--yes'], {
      print: installCap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });

    const checkCap = makeCapture();
    const code = await runCli(['guardrails', 'check'], {
      print: checkCap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runCli — <resource> update without catalogUrl → exit 2
// ---------------------------------------------------------------------------

describe('runCli — <resource> update without catalogUrl', () => {
  it('returns exit code 2 when no catalog URL configured', async () => {
    // No env/catalogUrl → CatalogUrlMissingError → exit 2
    const cap = makeCapture();
    const code = await runCli(['guardrails', 'update', 'guardrails-claude'], {
      print: cap.print,
    });
    expect(code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// runCli — unknown resource / unknown verb
// ---------------------------------------------------------------------------

describe('runCli — unknown resource or verb', () => {
  it('returns exit code 2 for unknown resource', async () => {
    const cap = makeCapture();
    const code = await runCli(['wizards', 'ls'], { print: cap.print });
    expect(code).toBe(2);
  });

  it('output contains usage hint for unknown resource', async () => {
    const cap = makeCapture();
    await runCli(['wizards', 'ls'], { print: cap.print });
    const out = cap.lines.join('\n');
    expect(out.toLowerCase()).toMatch(/unknown|usage|help/);
  });

  it('returns exit code 2 for known resource with unknown verb', async () => {
    const cap = makeCapture();
    const code = await runCli(['skills', 'foo-verb'], { print: cap.print });
    expect(code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// runCli — <resource> remove <id...> end-to-end
// ---------------------------------------------------------------------------

describe('runCli — <resource> remove <id...>', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome('rigger-remove-');
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('returns exit code 0 after add + remove --yes', async () => {
    // Install first
    await runCli(['guardrails', 'add', 'guardrails-claude', '--yes'], {
      print: makeCapture().print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });

    // Now remove
    const cap = makeCapture();
    const code = await runCli(['guardrails', 'remove', 'guardrails-claude', '--yes'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });
    expect(code).toBe(0);
  });

  it('returns exit code 2 when no ids provided to remove', async () => {
    const cap = makeCapture();
    const code = await runCli(['guardrails', 'remove'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });
    expect(code).toBe(2);
  });

  it('error message for no ids mentions "remove" and "id"', async () => {
    const cap = makeCapture();
    await runCli(['guardrails', 'remove'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });
    const out = cap.lines.join('\n');
    expect(out.toLowerCase()).toMatch(/remove|id|argument/);
  });

  it('returns exit code 2 when id does not match resource type', async () => {
    const cap = makeCapture();
    // context-claude is context, not a skill
    const code = await runCli(['skills', 'remove', 'context-claude', '--yes'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });
    expect(code).toBe(2);
  });

  it('check returns exit code 3 after remove (missing)', async () => {
    // Install
    await runCli(['guardrails', 'add', 'guardrails-claude', '--yes'], {
      print: makeCapture().print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });

    // Remove
    await runCli(['guardrails', 'remove', 'guardrails-claude', '--yes'], {
      print: makeCapture().print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });

    // Check — should show missing
    const cap = makeCapture();
    const code = await runCli(['guardrails', 'check'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });
    expect(code).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// runCli — top-level remove <id...>
// ---------------------------------------------------------------------------

describe('runCli — top-level remove <id...>', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome('rigger-toplevel-remove-');
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('top-level remove returns exit code 0 after install', async () => {
    await runCli(['install', 'guardrails-claude', '--yes'], {
      print: makeCapture().print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });

    const cap = makeCapture();
    const code = await runCli(['remove', 'guardrails-claude', '--yes'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });
    expect(code).toBe(0);
  });

  it('top-level remove returns exit code 2 when no ids provided', async () => {
    const cap = makeCapture();
    const code = await runCli(['remove'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });
    expect(code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// runCli — --help mentions remove as available (not planned)
// ---------------------------------------------------------------------------

describe('runCli — --help mentions remove', () => {
  it('--help output contains "remove" as an available verb', async () => {
    const cap = makeCapture();
    await runCli(['--help'], { print: cap.print });
    const out = cap.lines.join('\n');
    expect(out).toContain('remove');
  });

  it('--help output does NOT list remove as planned', async () => {
    const cap = makeCapture();
    await runCli(['--help'], { print: cap.print });
    const out = cap.lines.join('\n');
    // "update" should still be planned but "remove" should not appear in planned section
    // We check the planned section only contains update, not remove
    const plannedSection = out.match(/planned[^\n]*\n(.*?)(?:\n\n|\n[A-Z]|$)/is)?.[1] ?? '';
    expect(plannedSection).not.toMatch(/remove/i);
  });

  it('--help output lists "update" as an active command (not planned)', async () => {
    const cap = makeCapture();
    await runCli(['--help'], { print: cap.print });
    const out = cap.lines.join('\n');
    // update must appear in the active commands section
    expect(out.toLowerCase()).toMatch(/update/);
    // the Planned section must NOT mention update
    const plannedSection = out.match(/planned[^\n]*\n([\s\S]*?)(?:\n\n[A-Z]|$)/i)?.[1] ?? '';
    expect(plannedSection.toLowerCase()).not.toMatch(/update/);
  });
});

// ---------------------------------------------------------------------------
// runCli — non-regression: interactive install still works
// ---------------------------------------------------------------------------

describe('runCli — non-regression interactive install', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome('rigger-regression-');
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('interactive install (no ids) still calls selectArtifacts', async () => {
    let selectCalled = false;
    const prompts: CliPrompts = {
      ...fakePrompts(),
      selectArtifacts: async () => {
        selectCalled = true;
        return ['guardrails-claude'];
      },
    };
    const cap = makeCapture();
    await runCli(['install'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
      prompts,
    });
    expect(selectCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runCli — ls with remote catalog
// ---------------------------------------------------------------------------

/** SHA constant used in fake git runners. */
const FAKE_SHA = 'aabbccddeeff00112233445566778899aabbccdd';

/** Minimal valid CatalogEntry for test injection. */
function makeRemoteEntry(id: string): CatalogEntry {
  return {
    kind: 'artifact',
    id,
    nature: 'skill',
    source: 'external',
    targets: ['claude'],
    scopes: ['user'],
  };
}

/**
 * Builds a fake TmpDirFactory that writes catalog.json into dir and returns
 * a no-op cleanup (dir is owned by the test and cleaned up in afterEach).
 */
function makeFakeTmpFactory(dir: string, entries: CatalogEntry[]): TmpDirFactory {
  return async () => {
    await Bun.write(
      path.join(dir, 'catalog.json'),
      JSON.stringify({ meta: { name: 'cli-test-catalog' }, entries }),
    );
    return { path: dir, cleanup: async () => {} };
  };
}

/**
 * Builds a fake CommandRunner for a successful remote catalog fetch.
 * - ls-remote --tags → one tag v1.0.0
 * - clone → exit 0 (catalog written by tmpFactory)
 * - rev-parse HEAD → FAKE_SHA
 */
function makeSuccessRunner(): CommandRunner {
  return (_cmd, args) => {
    const argsArr = args ?? [];
    if (argsArr.includes('ls-remote') && argsArr.includes('--tags')) {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${FAKE_SHA}\trefs/tags/v1.0.0\n`,
        stderr: '',
      });
    }
    if (argsArr.includes('clone')) {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argsArr.includes('rev-parse')) {
      return Promise.resolve({ exitCode: 0, stdout: `${FAKE_SHA}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };
}

describe('runCli — ls with remote catalog configured', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };
  let catalogDir: string;

  beforeEach(async () => {
    tmp = await makeTmpHome('rigger-remote-ls-');
    // Write config.json with catalogUrl into the expected config path
    const configDir = path.join(tmp.dir, '.config', 'agent-rigger');
    await fs.mkdir(configDir, { recursive: true });
    await Bun.write(
      path.join(configDir, 'config.json'),
      JSON.stringify({ catalogUrl: 'https://example.com/catalog.git' }),
    );
    // Create a dir for the fake clone
    catalogDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-remote-catalog-'));
  });

  afterEach(async () => {
    await tmp.cleanup();
    await fs.rm(catalogDir, { recursive: true, force: true });
  });

  it('ls shows remote-only entry when fetch succeeds', async () => {
    const remoteEntries = [makeRemoteEntry('skill:remote-unique')];
    const cap = makeCapture();

    const code = await runCli(['ls'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
      remote: {
        run: makeSuccessRunner(),
        tmpFactory: makeFakeTmpFactory(catalogDir, remoteEntries),
      },
    });

    expect(code).toBe(0);
    const out = cap.lines.join('\n');
    expect(out).toContain('skill:remote-unique');
    expect(out).toContain('guardrails-claude'); // built-in still present
  });

  it('ls shows remote entry via catalog ls alias', async () => {
    const remoteEntries = [makeRemoteEntry('skill:remote-alias')];
    const cap = makeCapture();

    const code = await runCli(['catalog', 'ls'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
      remote: {
        run: makeSuccessRunner(),
        tmpFactory: makeFakeTmpFactory(catalogDir, remoteEntries),
      },
    });

    expect(code).toBe(0);
    const out = cap.lines.join('\n');
    expect(out).toContain('skill:remote-alias');
  });
});

describe('runCli — ls without catalogUrl configured (M0 unchanged)', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome('rigger-noop-ls-');
    // No config.json written → no catalogUrl
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('ls shows only built-in entries and exits 0', async () => {
    const cap = makeCapture();
    const code = await runCli(['ls'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
    });
    expect(code).toBe(0);
    const out = cap.lines.join('\n');
    expect(out).toContain('guardrails-claude');
    expect(out).not.toContain('skill:remote');
  });
});

describe('runCli — ls with catalogUrl configured but remote fails', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome('rigger-fail-ls-');
    const configDir = path.join(tmp.dir, '.config', 'agent-rigger');
    await fs.mkdir(configDir, { recursive: true });
    await Bun.write(
      path.join(configDir, 'config.json'),
      JSON.stringify({ catalogUrl: 'https://example.com/catalog.git' }),
    );
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('ls exits 0 with warning and falls back to built-in on remote failure', async () => {
    const cap = makeCapture();
    const code = await runCli(['ls'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
      remote: { run: alwaysFailRunner },
    });

    expect(code).toBe(0);
    const out = cap.lines.join('\n');
    expect(out).toContain('[warning]');
    expect(out).toContain('guardrails-claude'); // built-in still shown
  });

  it('warning message is actionable', async () => {
    const cap = makeCapture();
    await runCli(['ls'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
      remote: { run: alwaysFailRunner },
    });

    const out = cap.lines.join('\n');
    expect(out).toContain('Remote catalog unavailable');
    expect(out).toContain('Falling back to built-in catalog');
  });
});

// ---------------------------------------------------------------------------
// runCli — ls with remote catalog containing a shadowed (conflicting) id
// ---------------------------------------------------------------------------

describe('runCli — ls with remote entry shadowed by built-in', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };
  let catalogDir: string;

  beforeEach(async () => {
    tmp = await makeTmpHome('rigger-shadow-ls-');
    const configDir = path.join(tmp.dir, '.config', 'agent-rigger');
    await fs.mkdir(configDir, { recursive: true });
    await Bun.write(
      path.join(configDir, 'config.json'),
      JSON.stringify({ catalogUrl: 'https://example.com/catalog.git' }),
    );
    catalogDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-shadow-catalog-'));
  });

  afterEach(async () => {
    await tmp.cleanup();
    await fs.rm(catalogDir, { recursive: true, force: true });
  });

  it('ls exits 0 when remote has a built-in id collision', async () => {
    // guardrails-claude is already in BUILTIN_CATALOG — collision expected
    const remoteEntries = [
      makeRemoteEntry('guardrails-claude'),
      makeRemoteEntry('skill:remote-extra'),
    ];
    const cap = makeCapture();

    const code = await runCli(['ls'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
      remote: {
        run: makeSuccessRunner(),
        tmpFactory: makeFakeTmpFactory(catalogDir, remoteEntries),
      },
    });

    expect(code).toBe(0);
  });

  it('prints a shadowing warning mentioning the colliding id', async () => {
    const remoteEntries = [
      makeRemoteEntry('guardrails-claude'),
      makeRemoteEntry('skill:remote-extra'),
    ];
    const cap = makeCapture();

    await runCli(['ls'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
      remote: {
        run: makeSuccessRunner(),
        tmpFactory: makeFakeTmpFactory(catalogDir, remoteEntries),
      },
    });

    const out = cap.lines.join('\n');
    expect(out).toContain('[warning]');
    expect(out).toContain('shadowed by built-in');
    expect(out).toContain('guardrails-claude');
  });

  it('catalog still shows the remote-only entry alongside built-in', async () => {
    const remoteEntries = [
      makeRemoteEntry('guardrails-claude'),
      makeRemoteEntry('skill:remote-extra'),
    ];
    const cap = makeCapture();

    await runCli(['ls'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      artifactsDir: ARTIFACTS_DIR,
      remote: {
        run: makeSuccessRunner(),
        tmpFactory: makeFakeTmpFactory(catalogDir, remoteEntries),
      },
    });

    const out = cap.lines.join('\n');
    expect(out).toContain('guardrails-claude'); // built-in version kept
    expect(out).toContain('skill:remote-extra'); // remote-only visible
  });
});
