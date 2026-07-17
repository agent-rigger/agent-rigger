/**
 * cmd-config.test.ts — B6 (fix-bugs-cli-b5-b10): the `config set <key> <value>` verb.
 *
 * Two levels, on purpose:
 *  - handleConfig direct — validation, read-modify-write, header — with configPath
 *    injected (same isolation as cmd-catalog.test.ts).
 *  - runCli integration — proves the parseArgs positional-capture wiring (the B6
 *    trap: without it, `set`/<key>/<value> fall into the generic return with
 *    resourceIds=[] and the verb "runs" with no args) AND the --scope user|project
 *    → config-file routing. The project-scope test uses process.chdir (restored in
 *    afterEach), the same pattern as obs1-r3-cross-cwd-marketplace.test.ts.
 *
 * No real network, no real git, no process.exit.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Env } from '@agent-rigger/core/paths';
import { resolveUserTargets } from '@agent-rigger/core/paths';

import { runCli } from '../src/cli';
import { handleConfig } from '../src/cmd-config';
import { loadConfigFile } from '../src/config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCapture(): { lines: string[]; print: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

/** User-scope config path for a given RIGGER_HOME — mirrors resolveConfigPath. */
function userConfigPath(env: Env): string {
  return path.join(path.dirname(resolveUserTargets(env).stateJson), 'config.json');
}

// ---------------------------------------------------------------------------
// handleConfig — direct (configPath injected)
// ---------------------------------------------------------------------------

describe('handleConfig — set valid keys', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-cmd-config-'));
    configPath = path.join(tmpDir, 'config.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('set defaultScope project → exit 0, value persisted, header written', async () => {
    const cap = makeCapture();
    const code = await handleConfig({
      verb: 'set',
      args: ['defaultScope', 'project'],
      configPath,
      print: cap.print,
    });

    expect(code).toBe(0);
    const written = await loadConfigFile(configPath);
    expect(written.defaultScope).toBe('project');

    const raw = await Bun.file(configPath).text();
    // B6 success criterion: the header now references a real command.
    expect(raw).toContain('rigger config set');
  });

  it('set authMethod ssh → exit 0, value persisted', async () => {
    const cap = makeCapture();
    const code = await handleConfig({
      verb: 'set',
      args: ['authMethod', 'ssh'],
      configPath,
      print: cap.print,
    });

    expect(code).toBe(0);
    const written = await loadConfigFile(configPath);
    expect(written.authMethod).toBe('ssh');
  });

  it('set assistants (CSV) → exit 0, parsed to a validated list', async () => {
    const cap = makeCapture();
    const code = await handleConfig({
      verb: 'set',
      args: ['assistants', 'claude,opencode'],
      configPath,
      print: cap.print,
    });

    expect(code).toBe(0);
    const written = await loadConfigFile(configPath);
    expect(written.assistants).toEqual(['claude', 'opencode']);
  });

  it('extra positionals after <value> are ignored (aligned with runCatalog)', async () => {
    const cap = makeCapture();
    const code = await handleConfig({
      verb: 'set',
      args: ['defaultScope', 'project', 'extra', 'more'],
      configPath,
      print: cap.print,
    });

    expect(code).toBe(0);
    const written = await loadConfigFile(configPath);
    expect(written.defaultScope).toBe('project');
  });

  it('read-modify-write preserves untouched keys (catalogs survive a defaultScope set)', async () => {
    await Bun.write(
      configPath,
      JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/a.git' }] }),
    );

    const cap = makeCapture();
    const code = await handleConfig({
      verb: 'set',
      args: ['defaultScope', 'project'],
      configPath,
      print: cap.print,
    });

    expect(code).toBe(0);
    const written = await loadConfigFile(configPath);
    expect(written.defaultScope).toBe('project');
    expect(written.catalogs).toEqual([{ name: 'principal', url: 'https://example.com/a.git' }]);
  });
});

describe('handleConfig — validation errors (exit 2)', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-cmd-config-err-'));
    configPath = path.join(tmpDir, 'config.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('unknown key → exit 2, lists the settable keys, nothing written', async () => {
    const cap = makeCapture();
    const code = await handleConfig({
      verb: 'set',
      args: ['nope', 'value'],
      configPath,
      print: cap.print,
    });

    expect(code).toBe(2);
    const out = cap.lines.join('\n');
    expect(out).toContain('defaultScope');
    expect(out).toContain('authMethod');
    expect(out).toContain('assistants');
    expect(await Bun.file(configPath).exists()).toBe(false);
  });

  it('out-of-enum value → exit 2, names the admitted values', async () => {
    const cap = makeCapture();
    const code = await handleConfig({
      verb: 'set',
      args: ['defaultScope', 'bogus'],
      configPath,
      print: cap.print,
    });

    expect(code).toBe(2);
    const out = cap.lines.join('\n');
    expect(out).toContain('user');
    expect(out).toContain('project');
    expect(await Bun.file(configPath).exists()).toBe(false);
  });

  it('assistants with an invalid member → exit 2, names the admitted values', async () => {
    const cap = makeCapture();
    const code = await handleConfig({
      verb: 'set',
      args: ['assistants', 'claude,bogus'],
      configPath,
      print: cap.print,
    });

    expect(code).toBe(2);
    const out = cap.lines.join('\n');
    expect(out).toContain('claude');
    expect(out).toContain('opencode');
    expect(await Bun.file(configPath).exists()).toBe(false);
  });

  it('key present but value missing → exit 2, nothing written', async () => {
    const cap = makeCapture();
    const code = await handleConfig({
      verb: 'set',
      args: ['defaultScope'],
      configPath,
      print: cap.print,
    });

    expect(code).toBe(2);
    expect(cap.lines.join('\n')).toContain('requires a <value>');
    expect(await Bun.file(configPath).exists()).toBe(false);
  });

  it('catalogs → exit 2, redirects to `catalog add/remove`', async () => {
    const cap = makeCapture();
    const code = await handleConfig({
      verb: 'set',
      args: ['catalogs', 'whatever'],
      configPath,
      print: cap.print,
    });

    expect(code).toBe(2);
    const out = cap.lines.join('\n');
    expect(out).toContain('catalog add');
    expect(out).toContain('catalog remove');
  });

  it('unknown sub-verb → exit 2, mentions the available verb (set)', async () => {
    const cap = makeCapture();
    const code = await handleConfig({
      verb: 'get',
      args: ['defaultScope'],
      configPath,
      print: cap.print,
    });

    expect(code).toBe(2);
    expect(cap.lines.join('\n')).toContain('set');
  });

  it('no sub-verb (config alone) → exit 2, mentions the available verb (set)', async () => {
    const cap = makeCapture();
    const code = await handleConfig({
      verb: undefined,
      args: [],
      configPath,
      print: cap.print,
    });

    expect(code).toBe(2);
    expect(cap.lines.join('\n')).toContain('set');
  });
});

// ---------------------------------------------------------------------------
// runCli — integration (parseArgs wiring + scope routing)
// ---------------------------------------------------------------------------

describe('config set — runCli wiring', () => {
  let home: string;
  let env: Env;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-config-home-'));
    env = { RIGGER_HOME: home };
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('captures positionals: `config set defaultScope project` writes the user config, exit 0', async () => {
    const cap = makeCapture();
    const code = await runCli(['config', 'set', 'defaultScope', 'project'], {
      print: cap.print,
      env,
    });

    expect(code).toBe(0);
    const written = await loadConfigFile(userConfigPath(env));
    expect(written.defaultScope).toBe('project');
  });

  it('`config` alone → exit 2 (routed, not "Unknown command")', async () => {
    const cap = makeCapture();
    const code = await runCli(['config'], { print: cap.print, env });

    expect(code).toBe(2);
    const out = cap.lines.join('\n');
    expect(out).not.toContain('Unknown command');
    expect(out).toContain('set');
  });

  it('unknown key end-to-end → exit 2, lists the settable keys', async () => {
    const cap = makeCapture();
    const code = await runCli(['config', 'set', 'nope', 'x'], { print: cap.print, env });

    expect(code).toBe(2);
    expect(cap.lines.join('\n')).toContain('defaultScope');
  });
});

describe('config set — --scope project routing', () => {
  let home: string;
  let env: Env;
  let cwdDir: string;
  const originalCwd = process.cwd();

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-config-home2-'));
    env = { RIGGER_HOME: home };
    cwdDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-config-cwd-'));
    process.chdir(cwdDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(cwdDir, { recursive: true, force: true });
  });

  it('writes the project config (cwd/.agent-rigger), not the user config', async () => {
    const cap = makeCapture();
    const code = await runCli(['config', 'set', 'authMethod', 'https', '--scope', 'project'], {
      print: cap.print,
      env,
    });

    expect(code).toBe(0);

    const projectConfigPath = path.join(cwdDir, '.agent-rigger', 'config.json');
    const projectWritten = await loadConfigFile(projectConfigPath);
    expect(projectWritten.authMethod).toBe('https');

    // The user config must remain untouched.
    expect(await Bun.file(userConfigPath(env)).exists()).toBe(false);
  });
});
