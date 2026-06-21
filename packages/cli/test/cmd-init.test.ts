/**
 * Tests for cmd-init.ts — runInit.
 *
 * Isolation: tmp dir per test for configPath. Fakes for askUrl, askMethod, run.
 * No real git, no real network, no TTY, no process.exit.
 *
 * Scenarios:
 * 1. Fresh init — no existing config → askUrl returns URL, ambient probe OK → config persisted.
 * 2. Probe KO → askMethod returns provider-cli, token+re-probe OK → persisted with authMethod.
 * 3. Idempotence — second runInit on existing config → starts from existing, updates, no field loss.
 * 4. Probe definitively KO → PreflightAuthError caught → ok:false, config NOT persisted.
 *
 * Error handling decision: runInit catches PreflightAuthError and returns { ok: false, output: actionable }.
 * Config is only persisted after a successful preflightAuth.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runInit } from '../src/cmd-init';
import { loadConfigFile } from '../src/config';
import type { Config } from '../src/config';
import type { AskMethod, CommandRunner } from '../src/preflight-auth';

// ---------------------------------------------------------------------------
// Helpers / fakes
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-cmd-init-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** CommandRunner that always returns exit 0 (ambient probe succeeds). */
const runAmbientOk: CommandRunner = async (_cmd, _args) => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
});

/** CommandRunner that always returns exit 1 (all probes fail). */
const runAlwaysFail: CommandRunner = async (_cmd, _args) => ({
  exitCode: 1,
  stdout: '',
  stderr: 'auth error',
});

/** AskMethod that always returns the given method. */
function askAlways(method: NonNullable<Config['authMethod']>): AskMethod {
  return () => Promise.resolve(method);
}

/** AskMethod that should never be called (throws in the test if invoked). */
function askNeverCalled(): AskMethod {
  return () => {
    throw new Error('askMethod should not have been called');
  };
}

/** Build a CommandRunner with sequenced responses — first call → first result, etc. */
function makeSequencedRunner(
  responses: Array<{ exitCode: number; stdout: string; stderr: string }>,
): CommandRunner {
  let index = 0;
  return async (_cmd, _args) => {
    const response = responses[index] ?? { exitCode: 1, stdout: '', stderr: 'no more responses' };
    index++;
    return response;
  };
}

const OK_RESULT = { exitCode: 0, stdout: '', stderr: '' };
const FAIL_RESULT = { exitCode: 1, stdout: '', stderr: 'auth error' };
const TOKEN_RESULT = { exitCode: 0, stdout: 'ghp_testtoken123\n', stderr: '' };

// ---------------------------------------------------------------------------
// Scenario 1 — fresh init, no existing config, ambient probe OK
// ---------------------------------------------------------------------------

describe('runInit — fresh init, ambient probe OK', () => {
  it('returns ok:true when askUrl returns URL and ambient probe succeeds', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');
    const url = 'https://github.com/org/catalog.git';

    const result = await runInit({
      configPath,
      askUrl: () => Promise.resolve(url),
      askMethod: askNeverCalled(),
      run: runAmbientOk,
    });

    expect(result.ok).toBe(true);
  });

  it('persists the catalogUrl to the config file', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');
    const url = 'https://github.com/org/catalog.git';

    await runInit({
      configPath,
      askUrl: () => Promise.resolve(url),
      askMethod: askNeverCalled(),
      run: runAmbientOk,
    });

    const saved = await loadConfigFile(configPath);
    expect(saved.catalogUrl).toBe(url);
  });

  it('config file exists after init (parent dirs created)', async () => {
    const configPath = path.join(tmpDir, 'nested', 'deep', 'rigger.jsonc');
    const url = 'https://github.com/org/catalog.git';

    await runInit({
      configPath,
      askUrl: () => Promise.resolve(url),
      askMethod: askNeverCalled(),
      run: runAmbientOk,
    });

    const exists = await Bun.file(configPath).exists();
    expect(exists).toBe(true);
  });

  it('output contains the configured URL', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');
    const url = 'https://github.com/org/catalog.git';

    const result = await runInit({
      configPath,
      askUrl: () => Promise.resolve(url),
      askMethod: askNeverCalled(),
      run: runAmbientOk,
    });

    expect(result.output).toContain(url);
  });

  it('output contains the config file path', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');
    const url = 'https://github.com/org/catalog.git';

    const result = await runInit({
      configPath,
      askUrl: () => Promise.resolve(url),
      askMethod: askNeverCalled(),
      run: runAmbientOk,
    });

    expect(result.output).toContain(configPath);
  });

  it('returned config has defaultScope set', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');

    const result = await runInit({
      configPath,
      askUrl: () => Promise.resolve('https://github.com/org/catalog.git'),
      askMethod: askNeverCalled(),
      run: runAmbientOk,
    });

    expect(result.config.defaultScope).toBeDefined();
    expect(['user', 'project']).toContain(result.config.defaultScope);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — probe KO → askMethod returns provider-cli, token+re-probe OK
// ---------------------------------------------------------------------------

describe('runInit — ambient probe KO, provider-cli succeeds', () => {
  it('returns ok:true after successful provider-cli auth', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');
    // Sequence: ambient probe fail, gh auth token OK, re-probe OK
    const run = makeSequencedRunner([FAIL_RESULT, TOKEN_RESULT, OK_RESULT]);

    const result = await runInit({
      configPath,
      askUrl: () => Promise.resolve('https://github.com/org/catalog.git'),
      askMethod: askAlways('provider-cli'),
      run,
    });

    expect(result.ok).toBe(true);
  });

  it('persists authMethod in config after successful provider-cli auth', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');
    const run = makeSequencedRunner([FAIL_RESULT, TOKEN_RESULT, OK_RESULT]);

    await runInit({
      configPath,
      askUrl: () => Promise.resolve('https://github.com/org/catalog.git'),
      askMethod: askAlways('provider-cli'),
      run,
    });

    const saved = await loadConfigFile(configPath);
    expect(saved.authMethod).toBe('provider-cli');
  });

  it('output mentions auth method', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');
    const run = makeSequencedRunner([FAIL_RESULT, TOKEN_RESULT, OK_RESULT]);

    const result = await runInit({
      configPath,
      askUrl: () => Promise.resolve('https://github.com/org/catalog.git'),
      askMethod: askAlways('provider-cli'),
      run,
    });

    expect(result.output.toLowerCase()).toContain('provider-cli');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — idempotence / relance
// ---------------------------------------------------------------------------

describe('runInit — idempotence (second run)', () => {
  it('second runInit updates catalogUrl without losing other fields', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');
    const url1 = 'https://github.com/org/catalog.git';
    const url2 = 'https://github.com/org/updated-catalog.git';

    // First init — sets url1 + authMethod
    const run1 = makeSequencedRunner([FAIL_RESULT, TOKEN_RESULT, OK_RESULT]);
    await runInit({
      configPath,
      askUrl: () => Promise.resolve(url1),
      askMethod: askAlways('provider-cli'),
      run: run1,
    });

    // Second init — updates to url2, ambient probe OK (no method negotiation)
    const result2 = await runInit({
      configPath,
      askUrl: () => Promise.resolve(url2),
      askMethod: askNeverCalled(),
      run: runAmbientOk,
    });

    expect(result2.ok).toBe(true);
    expect(result2.config.catalogUrl).toBe(url2);

    const saved = await loadConfigFile(configPath);
    expect(saved.catalogUrl).toBe(url2);
    // authMethod set in first run should be preserved (ambient OK → no new method)
    expect(saved.authMethod).toBe('provider-cli');
  });

  it('second runInit on existing config preserves defaultScope', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');

    // First init with defaultScope: 'project'
    await runInit({
      configPath,
      askUrl: () => Promise.resolve('https://github.com/org/catalog.git'),
      askMethod: askNeverCalled(),
      run: runAmbientOk,
      defaultScope: 'project',
    });

    // Second init with a different defaultScope — should use the NEW value
    const result2 = await runInit({
      configPath,
      askUrl: () => Promise.resolve('https://github.com/org/catalog.git'),
      askMethod: askNeverCalled(),
      run: runAmbientOk,
      defaultScope: 'user',
    });

    expect(result2.config.defaultScope).toBe('user');
  });

  it('reading existing config before probe (idempotent start)', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');

    // Write a pre-existing config with a different URL
    await Bun.write(
      configPath,
      JSON.stringify({ catalogUrl: 'https://old.example.com', defaultScope: 'project' }),
    );

    const result = await runInit({
      configPath,
      askUrl: () => Promise.resolve('https://new.example.com'),
      askMethod: askNeverCalled(),
      run: runAmbientOk,
    });

    expect(result.ok).toBe(true);
    expect(result.config.catalogUrl).toBe('https://new.example.com');

    const saved = await loadConfigFile(configPath);
    expect(saved.catalogUrl).toBe('https://new.example.com');
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — probe definitively KO
// ---------------------------------------------------------------------------

describe('runInit — probe definitively KO', () => {
  it('returns ok:false when all probes fail', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');

    const result = await runInit({
      configPath,
      askUrl: () => Promise.resolve('https://github.com/org/catalog.git'),
      askMethod: askAlways('https'),
      run: runAlwaysFail,
    });

    expect(result.ok).toBe(false);
  });

  it('does NOT persist config when auth fails', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');

    await runInit({
      configPath,
      askUrl: () => Promise.resolve('https://github.com/org/catalog.git'),
      askMethod: askAlways('https'),
      run: runAlwaysFail,
    });

    const exists = await Bun.file(configPath).exists();
    expect(exists).toBe(false);
  });

  it('output is actionable (contains URL or error guidance)', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');
    const url = 'https://github.com/org/catalog.git';

    const result = await runInit({
      configPath,
      askUrl: () => Promise.resolve(url),
      askMethod: askAlways('https'),
      run: runAlwaysFail,
    });

    // output should mention the URL or method so the user knows what failed
    const outputLower = result.output.toLowerCase();
    expect(outputLower.includes(url) || outputLower.includes('https')).toBe(true);
  });

  it('ok:false when ambient fails and provider-cli token fetch fails', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');
    // ambient probe fail, gh auth token fail → PreflightAuthError
    const run = makeSequencedRunner([FAIL_RESULT, FAIL_RESULT]);

    const result = await runInit({
      configPath,
      askUrl: () => Promise.resolve('https://github.com/org/catalog.git'),
      askMethod: askAlways('provider-cli'),
      run,
    });

    expect(result.ok).toBe(false);
    expect(await Bun.file(configPath).exists()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — env forwarding
// ---------------------------------------------------------------------------

describe('runInit — env forwarding', () => {
  it('forwards env to the CommandRunner', async () => {
    const configPath = path.join(tmpDir, 'rigger.jsonc');
    const receivedEnvs: Array<Record<string, string | undefined> | undefined> = [];

    const run: CommandRunner = async (_cmd, _args, opts) => {
      receivedEnvs.push(opts?.env);
      return OK_RESULT;
    };

    await runInit({
      configPath,
      askUrl: () => Promise.resolve('https://github.com/org/catalog.git'),
      askMethod: askNeverCalled(),
      run,
      env: { MY_TOKEN: 'secret' },
    });

    expect(receivedEnvs[0]).toMatchObject({ MY_TOKEN: 'secret' });
  });
});
