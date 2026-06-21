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
// runCli — planned verbs (remove, update) → code 2
// ---------------------------------------------------------------------------

describe('runCli — planned verbs (remove, update) return code 2', () => {
  it('returns exit code 2 for <resource> remove', async () => {
    const cap = makeCapture();
    const code = await runCli(['guardrails', 'remove', 'guardrails-claude'], {
      print: cap.print,
    });
    expect(code).toBe(2);
  });

  it('returns exit code 2 for <resource> update', async () => {
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
    const code = await runCli(['skills', 'remove'], { print: cap.print });
    expect(code).toBe(2);
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
