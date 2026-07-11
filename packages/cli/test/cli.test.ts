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
import { readJson } from '@agent-rigger/core/fs-json';
import { findEntry, readManifest } from '@agent-rigger/core/manifest';
import { resolveOpencodeUserTargets } from '@agent-rigger/core/paths';

import pkg from '../package.json';
import { parseArgs, runCli } from '../src/cli';
import type { CliPrompts } from '../src/cli';

// ---------------------------------------------------------------------------
// Repo root — resolve relative to this file
// ---------------------------------------------------------------------------

// packages/cli/test → packages/cli → packages → agent-rigger (repo root)

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
    // '--verbose' is not a real CLI flag (KNOWN_FLAGS, R3/lot5) — use '--yes',
    // an actual boolean flag, to exercise the same "no '=' → true" behaviour.
    const result = parseArgs(['--yes']);
    expect(result.flags['yes']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseArgs — space syntax for VALUE_FLAGS (R3, lot5)
// ---------------------------------------------------------------------------

describe('parseArgs — space syntax for --scope/--assistant/--secret-env (R3)', () => {
  it('parses "--assistant opencode" (space) the same as "--assistant=opencode"', () => {
    const spaced = parseArgs(['check', '--assistant', 'opencode']);
    const equalled = parseArgs(['check', '--assistant=opencode']);
    expect(spaced.flags['assistant']).toBe('opencode');
    expect(spaced.error).toBeUndefined();
    expect(spaced.flags).toEqual(equalled.flags);
  });

  it('parses "--scope project" (space) without leaking the value as a positional id', () => {
    const result = parseArgs(['install', 'jr/skill:foo', '--scope', 'project']);
    expect(result.flags['scope']).toBe('project');
    expect(result.resourceIds).toEqual(['jr/skill:foo']);
  });

  it('parses "--secret-env ref=VAR" (space) into secretEnvFlags', () => {
    const result = parseArgs(['install', 'jr/mcp:x', '--secret-env', 'ref=VAR']);
    expect(result.secretEnvFlags).toEqual(['ref=VAR']);
    expect(result.resourceIds).toEqual(['jr/mcp:x']);
  });

  it('a value-flag at the very end of argv (no following token) sets `error`', () => {
    const result = parseArgs(['check', '--assistant']);
    expect(result.error).toBe('--assistant requires a value');
  });

  it('an unknown flag (with "=") sets `error` naming it', () => {
    const result = parseArgs(['install', 'jr/skill:foo', '--sope=project']);
    expect(result.error).toBe('unknown flag "--sope"');
  });

  it('an unknown flag (no "=") also sets `error` naming it', () => {
    const result = parseArgs(['install', '--bogus']);
    expect(result.error).toBe('unknown flag "--bogus"');
  });

  it('boolean flags (--yes/--force/--help/--version) do not consume the next token', () => {
    const result = parseArgs(['install', 'jr/skill:foo', '--yes', 'jr/skill:bar']);
    expect(result.flags['yes']).toBe(true);
    expect(result.resourceIds).toEqual(['jr/skill:foo', 'jr/skill:bar']);
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

  it('reports the version sourced from package.json (not a hardcoded constant)', async () => {
    const cap = makeCapture();
    await runCli(['--version'], { print: cap.print });
    expect(cap.lines.join('\n').trim()).toBe(pkg.version);
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
    });
    // Should not be 2 (scope error); any other code is acceptable
    expect(code).not.toBe(2);
  });

  it('accepts --scope=project without scope error', async () => {
    const cap = makeCapture();
    const code = await runCli(['check', '--scope=project'], {
      print: cap.print,
      env: { RIGGER_HOME: '/tmp/nonexistent-rigger-home-test' },
    });
    expect(code).not.toBe(2);
  });
});

// ---------------------------------------------------------------------------
// runCli — check command
// ---------------------------------------------------------------------------

describe('runCli — check without catalogUrl → empty catalog + actionable message', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('returns exit code 0 when no catalogUrl configured (empty catalog)', async () => {
    const cap = makeCapture();
    const code = await runCli(['check'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
    });
    // No catalogUrl → empty catalog → check returns 0 with actionable message
    expect(code).toBe(0);
  });

  it('output contains actionable message when no catalogUrl configured', async () => {
    const cap = makeCapture();
    await runCli(['check'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
    });
    const out = cap.lines.join('\n');
    expect(out).toMatch(/aucun catalog|agent-rigger init/);
  });
});

// ---------------------------------------------------------------------------
// runCli — install command + idempotence
// ---------------------------------------------------------------------------

describe('runCli — install without catalogUrl → missing precondition, exit 2 (R1, ADR-0024)', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  // Inverted (lot5-R1, ADR-0024): interactive install with no catalog configured
  // used to print an actionable message and exit 0 — a false success (a CI job
  // reading only the exit code believed it had installed). The absence of a
  // catalog is a missing precondition, not a voluntary abort: install is an
  // explicit request, so it now exits 2. See lot5-r1-exit-codes.test.ts for the
  // full scenario coverage; this test keeps the regression pinned in place.
  it('install with fake prompts returns exit code 2 (no catalogUrl → missing precondition)', async () => {
    const cap = makeCapture();
    const code = await runCli(['install'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      prompts: fakePrompts(),
    });
    expect(code).toBe(2);
    const out = cap.lines.join('\n');
    expect(out).toMatch(/\[error\]/);
    expect(out).toMatch(/no catalog configured|agent-rigger init/);
  });

  it('install does not write settings.json when no catalogUrl configured', async () => {
    const cap = makeCapture();
    await runCli(['install'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      prompts: fakePrompts(),
    });
    const settingsPath = path.join(tmp.dir, '.claude', 'settings.json');
    const exists = await fs.stat(settingsPath).then(() => true).catch(() => false);
    // No settings.json without catalogUrl — nothing installed
    expect(exists).toBe(false);
  });

  // Inverted (lot5-R1): duplicate of the scenario above, kept as its own
  // assertion (predates the split into a dedicated exit-code check).
  it('install returns exit code 2 (no catalogUrl, no ids provided)', async () => {
    const cap = makeCapture();
    const code = await runCli(['install'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      prompts: fakePrompts(),
    });
    expect(code).toBe(2);
  });

  it('check without catalogUrl returns exit code 0 (empty catalog → actionable message)', async () => {
    const checkCap = makeCapture();
    const checkCode = await runCli(['check'], {
      print: checkCap.print,
      env: { RIGGER_HOME: tmp.dir },
    });
    // check is a read command (R1: dégradation légitime inchangée) — reading
    // an empty state is not a failure, unlike install's explicit request.
    expect(checkCode).toBe(0);
    const out = checkCap.lines.join('\n');
    expect(out).toMatch(/aucun catalog|agent-rigger init/);
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

describe('runCli — ls (top-level) without catalogUrl → empty + actionable message', () => {
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
    });
    expect(code).toBe(0);
  });

  it('output contains actionable message when no catalogUrl configured', async () => {
    const cap = makeCapture();
    await runCli(['ls'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
    });
    const out = cap.lines.join('\n');
    expect(out).toMatch(/aucun catalog|agent-rigger init/);
  });
});

describe('runCli — skills ls (filtered) without catalogUrl → actionable message', () => {
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
    });
    expect(code).toBe(0);
  });

  it('output contains actionable message when no catalogUrl configured', async () => {
    const cap = makeCapture();
    await runCli(['skills', 'ls'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
    });
    const out = cap.lines.join('\n');
    expect(out).toMatch(/aucun catalog|agent-rigger init/);
  });
});

// ---------------------------------------------------------------------------
// runCli — non-interactive install with --yes
// ---------------------------------------------------------------------------

describe('runCli — install <id> --yes without catalogUrl → missing precondition (R1)', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome('rigger-install-yes-');
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  // Inverted (lot5-R1, ADR-0024): --yes skips confirmation, not preconditions —
  // no catalog configured is still a missing precondition, so this exits 2
  // (not the false-success 0 it used to return).
  it('returns exit code 2 even when id provided but no catalogUrl configured', async () => {
    const cap = makeCapture();
    const code = await runCli(['install', 'principal/skill:some-skill', '--yes'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
    });
    expect(code).toBe(2);
    const out = cap.lines.join('\n');
    expect(out).toMatch(/no catalog configured|agent-rigger init/);
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
    // ids provided → selectArtifacts must NOT be called (regardless of catalog presence)
    await runCli(['install', 'principal/skill:some-skill', '--yes'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
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
    await runCli(['install', 'principal/skill:some-skill', '--yes'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      prompts,
    });
    expect(confirmCalled).toBe(false);
  });

  // Inverted (lot5-R1, ADR-0024): same missing precondition whether or not
  // --yes is set — the flag only decides whether a confirm prompt would have
  // appeared, not whether the catalog exists.
  it('exits 2 with actionable message when --yes is NOT set and no catalogUrl', async () => {
    const cap = makeCapture();
    const code = await runCli(['install', 'principal/skill:some-skill'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      prompts: fakePrompts(),
    });
    expect(code).toBe(2);
    const out = cap.lines.join('\n');
    expect(out).toMatch(/no catalog configured|agent-rigger init/);
  });
});

// ---------------------------------------------------------------------------
// runCli — resource add validation
// ---------------------------------------------------------------------------

describe('runCli — <resource> add <id> validation', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };
  let catalogDir: string;

  beforeEach(async () => {
    tmp = await makeTmpHome('rigger-res-add-');
    // Write catalogUrl config
    const configDir = path.join(tmp.dir, '.config', 'agent-rigger');
    await fs.mkdir(configDir, { recursive: true });
    await Bun.write(
      path.join(configDir, 'config.json'),
      JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }] }),
    );
    catalogDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-add-catalog-'));
  });

  afterEach(async () => {
    await tmp.cleanup();
    await fs.rm(catalogDir, { recursive: true, force: true });
  });

  it('returns exit code 2 when id does not match resource type', async () => {
    const cap = makeCapture();
    // Inject a catalog that has guardrail-main as guardrail and skill:some-skill as skill
    const fixtureEntries: CatalogEntry[] = [
      {
        kind: 'artifact',
        id: 'guardrail:main',
        nature: 'guardrail',
        targets: ['claude'],
        scopes: ['user'],
      },
      {
        kind: 'artifact',
        id: 'skill:some-skill',
        nature: 'skill',
        targets: ['claude'],
        scopes: ['user'],
      },
    ];
    const code = await runCli(['skills', 'add', 'principal/guardrail:main'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      remote: {
        run: makeSuccessRunner(),
        tmpFactory: makeFakeTmpFactory(catalogDir, fixtureEntries),
      },
    });
    // principal/guardrail:main is a guardrail, not a skill → type mismatch → exit 2
    expect(code).toBe(2);
  });

  it('output contains actionable error message for type mismatch', async () => {
    const cap = makeCapture();
    const fixtureEntries: CatalogEntry[] = [
      {
        kind: 'artifact',
        id: 'guardrail:main',
        nature: 'guardrail',
        targets: ['claude'],
        scopes: ['user'],
      },
    ];
    await runCli(['skills', 'add', 'principal/guardrail:main'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      remote: {
        run: makeSuccessRunner(),
        tmpFactory: makeFakeTmpFactory(catalogDir, fixtureEntries),
      },
    });
    const out = cap.lines.join('\n');
    expect(out).toContain('principal/guardrail:main');
    expect(out.toLowerCase()).toMatch(/not a skill|is not a/);
  });

  it('returns exit code 0 for guardrail add with correct resource', async () => {
    const cap = makeCapture();
    const fixtureEntries: CatalogEntry[] = [
      {
        kind: 'artifact',
        id: 'guardrail:main',
        nature: 'guardrail',
        targets: ['claude'],
        scopes: ['user'],
      },
    ];
    const code = await runCli(['guardrails', 'add', 'principal/guardrail:main', '--yes'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      remote: {
        run: makeSuccessRunner(),
        tmpFactory: makeFakeTmpFactory(catalogDir, fixtureEntries),
      },
    });
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runCli — <resource> info <id>
// ---------------------------------------------------------------------------

describe('runCli — <resource> info <id>', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };
  let catalogDir: string;

  beforeEach(async () => {
    tmp = await makeTmpHome('rigger-info-');
    const configDir = path.join(tmp.dir, '.config', 'agent-rigger');
    await fs.mkdir(configDir, { recursive: true });
    await Bun.write(
      path.join(configDir, 'config.json'),
      JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }] }),
    );
    catalogDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-info-catalog-'));
  });

  afterEach(async () => {
    await tmp.cleanup();
    await fs.rm(catalogDir, { recursive: true, force: true });
  });

  it('returns exit code 0 for known id (from remote catalog)', async () => {
    const cap = makeCapture();
    const fixtureEntries: CatalogEntry[] = [
      {
        kind: 'artifact',
        id: 'guardrail:main',
        nature: 'guardrail',
        targets: ['claude'],
        scopes: ['user'],
      },
    ];
    const code = await runCli(['guardrails', 'info', 'principal/guardrail:main'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      remote: {
        run: makeSuccessRunner(),
        tmpFactory: makeFakeTmpFactory(catalogDir, fixtureEntries),
      },
    });
    expect(code).toBe(0);
  });

  it('output contains entry details (from remote catalog)', async () => {
    const cap = makeCapture();
    const fixtureEntries: CatalogEntry[] = [
      {
        kind: 'artifact',
        id: 'guardrail:main',
        nature: 'guardrail',
        targets: ['claude'],
        scopes: ['user'],
      },
    ];
    await runCli(['guardrails', 'info', 'principal/guardrail:main'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      remote: {
        run: makeSuccessRunner(),
        tmpFactory: makeFakeTmpFactory(catalogDir, fixtureEntries),
      },
    });
    const out = cap.lines.join('\n');
    expect(out).toContain('principal/guardrail:main');
    expect(out.toLowerCase()).toMatch(/status|source|nature|guardrail/);
  });

  it('returns exit code 2 for unknown id', async () => {
    const cap = makeCapture();
    const fixtureEntries: CatalogEntry[] = [
      {
        kind: 'artifact',
        id: 'guardrail:main',
        nature: 'guardrail',
        targets: ['claude'],
        scopes: ['user'],
      },
    ];
    const code = await runCli(['guardrails', 'info', 'does-not-exist'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      remote: {
        run: makeSuccessRunner(),
        tmpFactory: makeFakeTmpFactory(catalogDir, fixtureEntries),
      },
    });
    expect(code).toBe(2);
  });

  it('output contains actionable message for unknown id', async () => {
    const cap = makeCapture();
    const fixtureEntries: CatalogEntry[] = [
      {
        kind: 'artifact',
        id: 'guardrail:main',
        nature: 'guardrail',
        targets: ['claude'],
        scopes: ['user'],
      },
    ];
    await runCli(['guardrails', 'info', 'does-not-exist'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      remote: {
        run: makeSuccessRunner(),
        tmpFactory: makeFakeTmpFactory(catalogDir, fixtureEntries),
      },
    });
    const out = cap.lines.join('\n');
    expect(out).toContain('does-not-exist');
  });

  it('returns exit code 2 for info without catalogUrl (empty catalog)', async () => {
    const tmpNoCatalog = await makeTmpHome('rigger-info-nocatalog-');
    try {
      const cap = makeCapture();
      const code = await runCli(['guardrails', 'info', 'principal/guardrail:main'], {
        print: cap.print,
        env: { RIGGER_HOME: tmpNoCatalog.dir },
      });
      // catalog vide → unknown id → exit 2 OR actionable message with 0
      // Accept either: no catalog → print actionable msg
      const out = cap.lines.join('\n');
      expect(code === 0 || code === 2).toBe(true);
      if (code === 0) {
        expect(out).toMatch(/aucun catalog|agent-rigger init/);
      } else {
        expect(out).toContain('principal/guardrail:main');
      }
    } finally {
      await tmpNoCatalog.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// runCli — <resource> check
// ---------------------------------------------------------------------------

describe('runCli — <resource> check', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };
  let catalogDir: string;

  const GUARDRAIL_ENTRY: CatalogEntry = {
    kind: 'artifact',
    id: 'guardrail:main',
    nature: 'guardrail',
    targets: ['claude'],
    scopes: ['user'],
  };

  beforeEach(async () => {
    tmp = await makeTmpHome('rigger-res-check-');
    const configDir = path.join(tmp.dir, '.config', 'agent-rigger');
    await fs.mkdir(configDir, { recursive: true });
    await Bun.write(
      path.join(configDir, 'config.json'),
      JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }] }),
    );
    catalogDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-check-catalog-'));
  });

  afterEach(async () => {
    await tmp.cleanup();
    await fs.rm(catalogDir, { recursive: true, force: true });
  });

  it('returns exit code 3 when guardrails not installed (catalog configured)', async () => {
    const cap = makeCapture();
    const code = await runCli(['guardrails', 'check'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      remote: {
        run: makeSuccessRunner(),
        tmpFactory: makeFakeTmpFactory(catalogDir, [GUARDRAIL_ENTRY]),
      },
    });
    expect(code).toBe(3);
  });

  it('returns exit code 0 after installing guardrails (with remote catalog)', async () => {
    // Install principal/guardrail:main with remote catalog
    const installCap = makeCapture();
    await runCli(['guardrails', 'add', 'principal/guardrail:main', '--yes'], {
      print: installCap.print,
      env: { RIGGER_HOME: tmp.dir },
      remote: {
        run: makeSuccessRunner(),
        tmpFactory: makeFakeTmpFactory(catalogDir, [GUARDRAIL_ENTRY]),
      },
    });

    // Create a fresh catalogDir for the check call (clone fresh)
    const catalogDir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-check2-catalog-'));
    try {
      const checkCap = makeCapture();
      const code = await runCli(['guardrails', 'check'], {
        print: checkCap.print,
        env: { RIGGER_HOME: tmp.dir },
        remote: {
          run: makeSuccessRunner(),
          tmpFactory: makeFakeTmpFactory(catalogDir2, [GUARDRAIL_ENTRY]),
        },
      });
      expect(code).toBe(0);
    } finally {
      await fs.rm(catalogDir2, { recursive: true, force: true });
    }
  });

  it('returns exit code 0 when no catalogUrl (empty catalog → actionable message)', async () => {
    const tmpNoCatalog = await makeTmpHome('rigger-check-nocatalog-');
    try {
      const cap = makeCapture();
      const code = await runCli(['guardrails', 'check'], {
        print: cap.print,
        env: { RIGGER_HOME: tmpNoCatalog.dir },
      });
      expect(code).toBe(0);
      const out = cap.lines.join('\n');
      expect(out).toMatch(/aucun catalog|agent-rigger init/);
    } finally {
      await tmpNoCatalog.cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // R2 — read-only audit must never execute a catalog `tool` entry's `check`
  // shell command. `check` used to pass the FULL effective catalog (including
  // `tool` entries) to runCheck as `toolEntries`, which ran each `check`
  // command via `sh -c` on every audit — a permanent RCE. Proven here with a
  // tool entry whose `check` command creates a sentinel file: after `<resource>
  // check` completes, the sentinel must NOT exist, i.e. no shell ever ran.
  // ---------------------------------------------------------------------------

  it('never executes a catalog tool entry check command (no shell side effect)', async () => {
    const sentinelDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-check-sentinel-'));
    const sentinelPath = path.join(sentinelDir, 'pwned');
    try {
      const dangerousToolEntry: CatalogEntry = {
        kind: 'artifact',
        id: 'tool:pwned',
        nature: 'tool',
        targets: ['claude'],
        scopes: ['user'],
        level: 'required',
        check: `touch ${sentinelPath}`,
      };

      const cap = makeCapture();
      const code = await runCli(['guardrails', 'check'], {
        print: cap.print,
        env: { RIGGER_HOME: tmp.dir },
        remote: {
          run: makeSuccessRunner(),
          tmpFactory: makeFakeTmpFactory(catalogDir, [GUARDRAIL_ENTRY, dangerousToolEntry]),
        },
      });

      // The read-only audit still runs and reports drift (R2.6) — guardrail
      // not installed → exitCode 3 — unaffected by the tool entry's presence.
      expect(code).toBe(3);

      const sentinelExists = await fs.stat(sentinelPath).then(() => true).catch(() => false);
      expect(sentinelExists).toBe(false);
    } finally {
      await fs.rm(sentinelDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// runCli — <resource> update without catalogUrl → exit 2
// ---------------------------------------------------------------------------

describe('runCli — <resource> update without catalogUrl', () => {
  it('returns exit code 2 when no catalog URL configured', async () => {
    // No env/catalogUrl → CatalogUrlMissingError → exit 2
    const cap = makeCapture();
    const code = await runCli(['guardrails', 'update', 'principal/guardrails-claude'], {
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
  let catalogDir: string;

  const GUARDRAIL_FIXTURE: CatalogEntry = {
    kind: 'artifact',
    id: 'guardrail:main',
    nature: 'guardrail',
    targets: ['claude'],
    scopes: ['user'],
  };
  const CONTEXT_FIXTURE: CatalogEntry = {
    kind: 'artifact',
    id: 'context:main',
    nature: 'context',
    targets: ['claude'],
    scopes: ['user'],
  };

  function makeRemote(dir: string) {
    return {
      run: makeSuccessRunner(),
      tmpFactory: makeFakeTmpFactory(dir, [GUARDRAIL_FIXTURE, CONTEXT_FIXTURE]),
    };
  }

  beforeEach(async () => {
    tmp = await makeTmpHome('rigger-remove-');
    const configDir = path.join(tmp.dir, '.config', 'agent-rigger');
    await fs.mkdir(configDir, { recursive: true });
    await Bun.write(
      path.join(configDir, 'config.json'),
      JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }] }),
    );
    catalogDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-rm-catalog-'));
  });

  afterEach(async () => {
    await tmp.cleanup();
    await fs.rm(catalogDir, { recursive: true, force: true });
  });

  it('returns exit code 0 after add + remove --yes', async () => {
    // Install principal/guardrail:main with remote catalog
    await runCli(['guardrails', 'add', 'principal/guardrail:main', '--yes'], {
      print: makeCapture().print,
      env: { RIGGER_HOME: tmp.dir },
      remote: makeRemote(catalogDir),
    });

    // Remove (fresh catalog clone)
    const catalogDir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-rm-catalog-'));
    try {
      const cap = makeCapture();
      const code = await runCli(['guardrails', 'remove', 'principal/guardrail:main', '--yes'], {
        print: cap.print,
        env: { RIGGER_HOME: tmp.dir },
        remote: makeRemote(catalogDir2),
      });
      expect(code).toBe(0);
    } finally {
      await fs.rm(catalogDir2, { recursive: true, force: true });
    }
  });

  it('returns exit code 2 when no ids provided to remove', async () => {
    const cap = makeCapture();
    const code = await runCli(['guardrails', 'remove'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
    });
    expect(code).toBe(2);
  });

  it('error message for no ids mentions "remove" and "id"', async () => {
    const cap = makeCapture();
    await runCli(['guardrails', 'remove'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
    });
    const out = cap.lines.join('\n');
    expect(out.toLowerCase()).toMatch(/remove|id|argument/);
  });

  it('returns exit code 2 when id does not match resource type', async () => {
    const cap = makeCapture();
    // context:main is context, not a skill — catalog must have the entry to reject it
    const catalogDir3 = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-rm-catalog-'));
    try {
      const code = await runCli(['skills', 'remove', 'principal/context:main', '--yes'], {
        print: cap.print,
        env: { RIGGER_HOME: tmp.dir },
        remote: makeRemote(catalogDir3),
      });
      expect(code).toBe(2);
    } finally {
      await fs.rm(catalogDir3, { recursive: true, force: true });
    }
  });

  it('check returns exit code 3 after remove (missing)', async () => {
    const cDir1 = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-rm-catalog-'));
    const cDir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-rm-catalog-'));
    const cDir3 = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-rm-catalog-'));

    try {
      // Install principal/guardrail:main
      await runCli(['guardrails', 'add', 'principal/guardrail:main', '--yes'], {
        print: makeCapture().print,
        env: { RIGGER_HOME: tmp.dir },
        remote: makeRemote(cDir1),
      });

      // Remove
      await runCli(['guardrails', 'remove', 'principal/guardrail:main', '--yes'], {
        print: makeCapture().print,
        env: { RIGGER_HOME: tmp.dir },
        remote: makeRemote(cDir2),
      });

      // Check — should show missing (exit 3)
      const cap = makeCapture();
      const code = await runCli(['guardrails', 'check'], {
        print: cap.print,
        env: { RIGGER_HOME: tmp.dir },
        remote: makeRemote(cDir3),
      });
      expect(code).toBe(3);
    } finally {
      await fs.rm(cDir1, { recursive: true, force: true });
      await fs.rm(cDir2, { recursive: true, force: true });
      await fs.rm(cDir3, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// runCli — top-level remove <id...>
// ---------------------------------------------------------------------------

describe('runCli — top-level remove <id...>', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };

  const GUARDRAIL_FIXTURE_TL: CatalogEntry = {
    kind: 'artifact',
    id: 'guardrail:main',
    nature: 'guardrail',
    targets: ['claude'],
    scopes: ['user'],
  };

  beforeEach(async () => {
    tmp = await makeTmpHome('rigger-toplevel-remove-');
    const configDir = path.join(tmp.dir, '.config', 'agent-rigger');
    await fs.mkdir(configDir, { recursive: true });
    await Bun.write(
      path.join(configDir, 'config.json'),
      JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }] }),
    );
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('top-level remove returns exit code 0 after install', async () => {
    const cDir1 = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-tl-rm1-'));
    const cDir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-tl-rm2-'));
    try {
      await runCli(['install', 'principal/guardrail:main', '--yes'], {
        print: makeCapture().print,
        env: { RIGGER_HOME: tmp.dir },
        remote: {
          run: makeSuccessRunner(),
          tmpFactory: makeFakeTmpFactory(cDir1, [GUARDRAIL_FIXTURE_TL]),
        },
      });

      const cap = makeCapture();
      const code = await runCli(['remove', 'principal/guardrail:main', '--yes'], {
        print: cap.print,
        env: { RIGGER_HOME: tmp.dir },
        remote: {
          run: makeSuccessRunner(),
          tmpFactory: makeFakeTmpFactory(cDir2, [GUARDRAIL_FIXTURE_TL]),
        },
      });
      expect(code).toBe(0);
    } finally {
      await fs.rm(cDir1, { recursive: true, force: true });
      await fs.rm(cDir2, { recursive: true, force: true });
    }
  });

  it('top-level remove returns exit code 2 when no ids provided', async () => {
    const cap = makeCapture();
    const code = await runCli(['remove'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
    });
    expect(code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// runCli — install --assistant=opencode (wiring slice A, R1)
// ---------------------------------------------------------------------------

describe('runCli — install --assistant=opencode', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };

  const GUARDRAIL_FIXTURE_BOTH: CatalogEntry = {
    kind: 'artifact',
    id: 'guardrail:main',
    nature: 'guardrail',
    targets: ['claude', 'opencode'],
    scopes: ['user'],
  };

  /**
   * Custom checkout writer (not the shared makeFakeTmpFactory): the opencode
   * guardrail is a NATIVE `permission.json` descriptor (ADR-0020 "Option A").
   * makeFakeTmpFactory only writes Claude deny/allow rules, so the opencode
   * builder would fail with MissingOpencodePermissionError; here we ship the
   * native descriptor (plus deny/allow, harmless, for parity with the claude side).
   */
  function makeTranslatableGuardrailTmpFactory(dir: string): TmpDirFactory {
    return async () => {
      await Bun.write(
        path.join(dir, 'catalog.json'),
        JSON.stringify({ meta: { name: 'cli-test-catalog' }, entries: [GUARDRAIL_FIXTURE_BOTH] }),
      );
      const guardrailDir = path.join(dir, 'guardrails', 'main');
      await fs.mkdir(guardrailDir, { recursive: true });
      await Bun.write(
        path.join(guardrailDir, 'deny.json'),
        JSON.stringify({ deny: ['Bash(rm -rf *)'] }),
      );
      await Bun.write(path.join(guardrailDir, 'allow.json'), JSON.stringify({ allow: [] }));
      await Bun.write(
        path.join(guardrailDir, 'permission.json'),
        JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          permission: { bash: { 'rm -rf *': 'deny' } },
        }),
      );
      return { path: dir, cleanup: async () => {} };
    };
  }

  beforeEach(async () => {
    tmp = await makeTmpHome('rigger-install-assistant-');
    const configDir = path.join(tmp.dir, '.config', 'agent-rigger');
    await fs.mkdir(configDir, { recursive: true });
    await Bun.write(
      path.join(configDir, 'config.json'),
      JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }] }),
    );
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('installs into opencode.json (permission key) and stamps the manifest with assistant:"opencode"', async () => {
    const cDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-install-oc-'));
    try {
      const code = await runCli(
        ['install', 'principal/guardrail:main', '--yes', '--assistant=opencode'],
        {
          print: makeCapture().print,
          env: { RIGGER_HOME: tmp.dir },
          remote: {
            run: makeSuccessRunner(),
            tmpFactory: makeTranslatableGuardrailTmpFactory(cDir),
          },
        },
      );
      expect(code).toBe(0);

      const opencodeJson = await readJson(
        resolveOpencodeUserTargets({ RIGGER_HOME: tmp.dir }).opencodeJson,
      );
      expect(opencodeJson['permission']).toBeDefined();

      const manifest = await readManifest(
        path.join(tmp.dir, '.config', 'agent-rigger', 'state.json'),
      );
      expect(findEntry(manifest, 'principal/guardrail:main', 'user', 'opencode')).toBeDefined();
    } finally {
      await fs.rm(cDir, { recursive: true, force: true });
    }
  });

  it('rejects an invalid --assistant value with an actionable message', async () => {
    const cap = makeCapture();
    const code = await runCli(
      ['install', 'principal/guardrail:main', '--yes', '--assistant=bogus'],
      {
        print: cap.print,
        env: { RIGGER_HOME: tmp.dir },
      },
    );
    expect(code).not.toBe(0);
    const out = cap.lines.join('\n');
    expect(out).toMatch(/bogus/);
  });

  it('defaults to claude (back-compat) when --assistant is omitted', async () => {
    const cDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-install-claude-default-'));
    try {
      const code = await runCli(['install', 'principal/guardrail:main', '--yes'], {
        print: makeCapture().print,
        env: { RIGGER_HOME: tmp.dir },
        remote: {
          run: makeSuccessRunner(),
          tmpFactory: makeFakeTmpFactory(cDir, [GUARDRAIL_FIXTURE_BOTH]),
        },
      });
      expect(code).toBe(0);

      const manifest = await readManifest(
        path.join(tmp.dir, '.config', 'agent-rigger', 'state.json'),
      );
      expect(findEntry(manifest, 'principal/guardrail:main', 'user', 'claude')).toBeDefined();
    } finally {
      await fs.rm(cDir, { recursive: true, force: true });
    }
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
  let catalogDir: string;

  const FIXTURE_ENTRIES: CatalogEntry[] = [
    {
      kind: 'artifact',
      id: 'guardrail:main',
      nature: 'guardrail',
      targets: ['claude'],
      scopes: ['user'],
    },
    {
      kind: 'artifact',
      id: 'skill:some-skill',
      nature: 'skill',
      targets: ['claude'],
      scopes: ['user'],
    },
  ];

  beforeEach(async () => {
    tmp = await makeTmpHome('rigger-regression-');
    // Must have catalogUrl so resolveEffectiveCatalog returns entries (not [])
    const configDir = path.join(tmp.dir, '.config', 'agent-rigger');
    await fs.mkdir(configDir, { recursive: true });
    await Bun.write(
      path.join(configDir, 'config.json'),
      JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }] }),
    );
    catalogDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-regression-catalog-'));
  });

  afterEach(async () => {
    await tmp.cleanup();
    await fs.rm(catalogDir, { recursive: true, force: true });
  });

  it('interactive install (no ids) calls selectArtifacts when catalog configured', async () => {
    let selectCalled = false;
    const prompts: CliPrompts = {
      ...fakePrompts(),
      selectArtifacts: async () => {
        selectCalled = true;
        return []; // Return empty to avoid actually installing
      },
    };
    const cap = makeCapture();
    await runCli(['install'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      prompts,
      remote: {
        run: makeSuccessRunner(),
        tmpFactory: makeFakeTmpFactory(catalogDir, FIXTURE_ENTRIES),
      },
    });
    // selectArtifacts must be called when catalog is non-empty
    expect(selectCalled).toBe(true);
  });

  it('interactive install without catalogUrl does not call selectArtifacts (empty catalog)', async () => {
    const tmpNoCatalog = await makeTmpHome('rigger-regression-nocatalog-');
    let selectCalled = false;
    const prompts: CliPrompts = {
      ...fakePrompts(),
      selectArtifacts: async () => {
        selectCalled = true;
        return [];
      },
    };
    try {
      const cap = makeCapture();
      await runCli(['install'], {
        print: cap.print,
        env: { RIGGER_HOME: tmpNoCatalog.dir },
        prompts,
      });
      // Without catalogUrl, catalog is empty → selectArtifacts must NOT be called
      expect(selectCalled).toBe(false);
      const out = cap.lines.join('\n');
      expect(out).toMatch(/aucun catalog|agent-rigger init/);
    } finally {
      await tmpNoCatalog.cleanup();
    }
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
    targets: ['claude'],
    scopes: ['user'],
  };
}

/**
 * Builds a fake TmpDirFactory that writes catalog.json into dir and returns
 * a no-op cleanup (dir is owned by the test and cleaned up in afterEach).
 *
 * Also writes minimal guardrail fixtures for any guardrail entries so that
 * buildClaudeAdapter can call loadCanonicalDeny without throwing EmptyDenyArtifactError.
 */
function makeFakeTmpFactory(dir: string, entries: CatalogEntry[]): TmpDirFactory {
  return async () => {
    await Bun.write(
      path.join(dir, 'catalog.json'),
      JSON.stringify({ meta: { name: 'cli-test-catalog' }, entries }),
    );
    // Write minimal deny.json for each guardrail entry so loadCanonicalDeny succeeds.
    const guardrailEntries = entries.filter(
      (e): e is CatalogEntry & { nature: 'guardrail' } =>
        e.kind === 'artifact' && (e as { nature: string }).nature === 'guardrail',
    );
    await Promise.all(
      guardrailEntries.map(async (e) => {
        const name = e.id.replace(/^guardrail:/, '');
        const guardrailDir = path.join(dir, 'guardrails', name);
        await fs.mkdir(guardrailDir, { recursive: true });
        await Bun.write(
          path.join(guardrailDir, 'deny.json'),
          JSON.stringify({ deny: ['fake-deny-rule'] }),
        );
        await Bun.write(
          path.join(guardrailDir, 'allow.json'),
          JSON.stringify({ allow: [] }),
        );
      }),
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
      JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }] }),
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
      remote: {
        run: makeSuccessRunner(),
        tmpFactory: makeFakeTmpFactory(catalogDir, remoteEntries),
      },
    });

    expect(code).toBe(0);
    const out = cap.lines.join('\n');
    expect(out).toContain('principal/skill:remote-unique');
    // no built-in entries — catalog is remote-only
  });

  it('catalog ls lists configured sources (name + url), not catalog entries', async () => {
    // M5: `catalog ls` now lists configured sources (config.catalogs[]), not artifact entries.
    // Use top-level `ls` to list artifact entries.
    const cap = makeCapture();

    const code = await runCli(['catalog', 'ls'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
    });

    expect(code).toBe(0);
    const out = cap.lines.join('\n');
    // Shows the configured source name + url
    expect(out).toContain('principal');
    expect(out).toContain('https://example.com/catalog.git');
  });
});

describe('runCli — ls without catalogUrl configured → empty + actionable message', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome('rigger-noop-ls-');
    // No config.json written → no catalogUrl
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('ls exits 0 and shows actionable message (no built-in entries)', async () => {
    const cap = makeCapture();
    const code = await runCli(['ls'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
    });
    expect(code).toBe(0);
    const out = cap.lines.join('\n');
    // No built-in catalog → actionable message shown
    expect(out).toMatch(/aucun catalog|agent-rigger init/);
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
      JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }] }),
    );
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('ls exits 0 with warning on remote failure (no built-in fallback)', async () => {
    const cap = makeCapture();
    const code = await runCli(['ls'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      remote: { run: alwaysFailRunner },
    });

    expect(code).toBe(0);
    const out = cap.lines.join('\n');
    expect(out).toContain('[warning]');
    // No built-in catalog → empty result on failure (no guardrails-claude)
    expect(out).not.toContain('guardrails-claude');
  });

  it('warning message mentions remote catalog unavailability', async () => {
    const cap = makeCapture();
    await runCli(['ls'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      remote: { run: alwaysFailRunner },
    });

    const out = cap.lines.join('\n');
    expect(out).toContain('[warning]');
    expect(out).toContain('unavailable');
    expect(out).toMatch(/init|URL/);
  });
});

// ---------------------------------------------------------------------------
// runCli — ls with remote catalog containing multiple entries
// ---------------------------------------------------------------------------

describe('runCli — ls with multiple remote catalog entries', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };
  let catalogDir: string;

  beforeEach(async () => {
    tmp = await makeTmpHome('rigger-multi-ls-');
    const configDir = path.join(tmp.dir, '.config', 'agent-rigger');
    await fs.mkdir(configDir, { recursive: true });
    await Bun.write(
      path.join(configDir, 'config.json'),
      JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }] }),
    );
    catalogDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-multi-catalog-'));
  });

  afterEach(async () => {
    await tmp.cleanup();
    await fs.rm(catalogDir, { recursive: true, force: true });
  });

  it('ls exits 0 when remote has multiple entries', async () => {
    const remoteEntries = [
      makeRemoteEntry('skill:remote-a'),
      makeRemoteEntry('skill:remote-b'),
    ];
    const cap = makeCapture();

    const code = await runCli(['ls'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      remote: {
        run: makeSuccessRunner(),
        tmpFactory: makeFakeTmpFactory(catalogDir, remoteEntries),
      },
    });

    expect(code).toBe(0);
  });

  it('catalog shows all remote entries', async () => {
    const remoteEntries = [
      makeRemoteEntry('skill:remote-first'),
      makeRemoteEntry('skill:remote-second'),
    ];
    const cap = makeCapture();

    await runCli(['ls'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      remote: {
        run: makeSuccessRunner(),
        tmpFactory: makeFakeTmpFactory(catalogDir, remoteEntries),
      },
    });

    const out = cap.lines.join('\n');
    expect(out).toContain('principal/skill:remote-first');
    expect(out).toContain('principal/skill:remote-second');
  });

  it('no [warning] shown when remote catalog has no conflicts', async () => {
    const remoteEntries = [makeRemoteEntry('skill:unique-only')];
    const cap = makeCapture();

    await runCli(['ls'], {
      print: cap.print,
      env: { RIGGER_HOME: tmp.dir },
      remote: {
        run: makeSuccessRunner(),
        tmpFactory: makeFakeTmpFactory(catalogDir, remoteEntries),
      },
    });

    const out = cap.lines.join('\n');
    // No built-in base → no conflicts → no shadow warning
    expect(out).not.toMatch(/shadowed by built-in/);
  });
});
