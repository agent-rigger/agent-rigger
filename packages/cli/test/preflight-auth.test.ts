/**
 * Tests for preflight-auth.ts — preflightAuth, probeRemote, PreflightAuthError.
 *
 * Isolation: all CommandRunner and AskMethod calls are fakes — no real git,
 * no real network, no process.exit.
 */

import { describe, expect, it } from 'bun:test';

import { preflightAuth, PreflightAuthError, probeRemote } from '../src/preflight-auth';
import type { AskMethod, AuthMethod, CommandRunner } from '../src/preflight-auth';

// ---------------------------------------------------------------------------
// Helpers / fakes
// ---------------------------------------------------------------------------

/** Build a CommandRunner that returns a fixed response for a given command prefix. */
function makeRunner(
  responses: Array<{
    match: (command: string, args: string[]) => boolean;
    result: { exitCode: number; stdout: string; stderr: string };
  }>,
): CommandRunner {
  return async (command, args) => {
    for (const { match, result } of responses) {
      if (match(command, args)) {
        return result;
      }
    }
    return { exitCode: 1, stdout: '', stderr: `unexpected: ${command} ${args.join(' ')}` };
  };
}

const OK = { exitCode: 0, stdout: '', stderr: '' };
const FAIL = { exitCode: 1, stdout: '', stderr: 'auth error' };

/** AskMethod that always returns the given method. */
function askAlways(method: AuthMethod): AskMethod {
  return () => Promise.resolve(method);
}

/** AskMethod that should never be called (asserts in the test). */
function askNeverCalled(): AskMethod {
  return () => {
    throw new Error('askMethod should not have been called');
  };
}

// ---------------------------------------------------------------------------
// probeRemote
// ---------------------------------------------------------------------------

describe('probeRemote', () => {
  it('returns true when git ls-remote exits 0', async () => {
    const run = makeRunner([
      { match: (cmd, args) => cmd === 'git' && args[0] === 'ls-remote', result: OK },
    ]);
    const result = await probeRemote('https://github.com/org/repo.git', run);
    expect(result).toBe(true);
  });

  it('returns false when git ls-remote exits non-zero', async () => {
    const run = makeRunner([
      { match: (cmd, args) => cmd === 'git' && args[0] === 'ls-remote', result: FAIL },
    ]);
    const result = await probeRemote('https://github.com/org/repo.git', run);
    expect(result).toBe(false);
  });

  it('passes the url as an argument to git ls-remote', async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return OK;
    };
    await probeRemote('https://github.com/org/repo.git', run);
    expect(calls[0]).toEqual(['git', 'ls-remote', 'https://github.com/org/repo.git']);
  });

  it('passes env opts through to the runner', async () => {
    const receivedEnvs: Array<Record<string, string | undefined> | undefined> = [];
    const run: CommandRunner = async (_cmd, _args, opts) => {
      receivedEnvs.push(opts?.env);
      return OK;
    };
    await probeRemote('https://example.com/repo.git', run, { env: { GITHUB_TOKEN: 'tok' } });
    expect(receivedEnvs[0]).toEqual({ GITHUB_TOKEN: 'tok' });
  });
});

// ---------------------------------------------------------------------------
// preflightAuth — probe ambiant OK (non-invasif)
// ---------------------------------------------------------------------------

describe('preflightAuth — ambient probe succeeds', () => {
  it('returns { ok: true } immediately without calling askMethod', async () => {
    const run = makeRunner([
      { match: (cmd, args) => cmd === 'git' && args[0] === 'ls-remote', result: OK },
    ]);
    const result = await preflightAuth({
      url: 'https://github.com/org/repo.git',
      run,
      askMethod: askNeverCalled(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.method).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// preflightAuth — provider-cli (github.com → gh)
// ---------------------------------------------------------------------------

describe('preflightAuth — provider-cli via gh (github.com)', () => {
  it('fetches token via gh, re-probes with token in env, returns ok:true + method', async () => {
    const probeEnvs: Array<Record<string, string | undefined> | undefined> = [];
    let probeCallCount = 0;

    const run: CommandRunner = async (cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'ls-remote') {
        probeCallCount++;
        probeEnvs.push(opts?.env);
        // First call (ambient) fails; second call (with token) succeeds.
        return probeCallCount === 1 ? FAIL : OK;
      }
      if (cmd === 'gh' && args[0] === 'auth' && args[1] === 'token') {
        return { exitCode: 0, stdout: 'ghp_testtoken123\n', stderr: '' };
      }
      return FAIL;
    };

    const result = await preflightAuth({
      url: 'https://github.com/org/repo.git',
      run,
      askMethod: askAlways('provider-cli'),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.method).toBe('provider-cli');
    }
    // Token must have been passed in env on the re-probe
    expect(probeEnvs[1]).toMatchObject({ GITHUB_TOKEN: 'ghp_testtoken123' });
  });

  it('uses gh (not glab) for github.com URLs', async () => {
    const tokenCmds: string[] = [];
    const run: CommandRunner = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'ls-remote') {
        return FAIL;
      }
      if (cmd === 'gh' || cmd === 'glab') {
        tokenCmds.push(cmd);
        return { exitCode: 0, stdout: 'tok\n', stderr: '' };
      }
      return FAIL;
    };

    await preflightAuth({
      url: 'https://github.com/org/repo.git',
      run,
      askMethod: askAlways('provider-cli'),
    }).catch(() => {/* ignore auth error */});

    expect(tokenCmds).toContain('gh');
    expect(tokenCmds).not.toContain('glab');
  });
});

// ---------------------------------------------------------------------------
// preflightAuth — provider-cli (gitlab → glab)
// ---------------------------------------------------------------------------

describe('preflightAuth — provider-cli via glab (gitlab)', () => {
  it('uses glab (not gh) for gitlab.com URLs', async () => {
    const tokenCmds: string[] = [];
    let probeCount = 0;
    const run: CommandRunner = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'ls-remote') {
        probeCount++;
        return probeCount === 1 ? FAIL : OK;
      }
      if (cmd === 'glab' && args[0] === 'auth' && args[1] === 'token') {
        tokenCmds.push(cmd);
        return { exitCode: 0, stdout: 'glpat-testtoken\n', stderr: '' };
      }
      if (cmd === 'gh') {
        tokenCmds.push(cmd);
        return FAIL;
      }
      return FAIL;
    };

    const result = await preflightAuth({
      url: 'https://gitlab.com/org/repo.git',
      run,
      askMethod: askAlways('provider-cli'),
    });

    expect(result.ok).toBe(true);
    expect(tokenCmds).toContain('glab');
    expect(tokenCmds).not.toContain('gh');
  });

  it('uses glab for self-hosted gitlab URLs containing "gitlab"', async () => {
    const tokenCmds: string[] = [];
    let probeCount = 0;
    const run: CommandRunner = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'ls-remote') {
        probeCount++;
        return probeCount === 1 ? FAIL : OK;
      }
      if (cmd === 'glab' && args[0] === 'auth' && args[1] === 'token') {
        tokenCmds.push(cmd);
        return { exitCode: 0, stdout: 'glpat-tok\n', stderr: '' };
      }
      return FAIL;
    };

    await preflightAuth({
      url: 'https://gitlab.mycompany.com/org/repo.git',
      run,
      askMethod: askAlways('provider-cli'),
    });

    expect(tokenCmds).toContain('glab');
  });
});

// ---------------------------------------------------------------------------
// preflightAuth — method provided in opts (no askMethod call)
// ---------------------------------------------------------------------------

describe('preflightAuth — method provided in opts', () => {
  it('does not call askMethod when opts.method is provided', async () => {
    let probeCount = 0;
    const run: CommandRunner = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'ls-remote') {
        probeCount++;
        return probeCount === 1 ? FAIL : OK;
      }
      if (cmd === 'gh' && args[0] === 'auth' && args[1] === 'token') {
        return { exitCode: 0, stdout: 'tok\n', stderr: '' };
      }
      return FAIL;
    };

    const result = await preflightAuth({
      url: 'https://github.com/org/repo.git',
      run,
      askMethod: askNeverCalled(),
      method: 'provider-cli',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.method).toBe('provider-cli');
    }
  });
});

// ---------------------------------------------------------------------------
// preflightAuth — https method
// ---------------------------------------------------------------------------

describe('preflightAuth — https method', () => {
  it('re-probes using the same URL (credential helper path) and returns ok:true on success', async () => {
    let probeCount = 0;
    const run: CommandRunner = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'ls-remote') {
        probeCount++;
        return probeCount === 1 ? FAIL : OK;
      }
      return FAIL;
    };

    const result = await preflightAuth({
      url: 'https://github.com/org/repo.git',
      run,
      askMethod: askAlways('https'),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.method).toBe('https');
    }
    expect(probeCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// preflightAuth — ssh method
// ---------------------------------------------------------------------------

describe('preflightAuth — ssh method', () => {
  it('converts https URL to ssh URL for re-probe', async () => {
    const probedUrls: string[] = [];
    let probeCount = 0;
    const run: CommandRunner = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'ls-remote') {
        probeCount++;
        probedUrls.push(args[1] ?? '');
        return probeCount === 1 ? FAIL : OK;
      }
      return FAIL;
    };

    const result = await preflightAuth({
      url: 'https://github.com/org/repo.git',
      run,
      askMethod: askAlways('ssh'),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.method).toBe('ssh');
    }
    // The re-probe URL must be an ssh URL
    expect(probedUrls[1]).toMatch(/^git@/);
    expect(probedUrls[1]).toContain('github.com');
    expect(probedUrls[1]).toContain('org/repo.git');
  });

  it('re-probes the original URL when it is already an ssh URL', async () => {
    const probedUrls: string[] = [];
    let probeCount = 0;
    const run: CommandRunner = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'ls-remote') {
        probeCount++;
        probedUrls.push(args[1] ?? '');
        return probeCount === 1 ? FAIL : OK;
      }
      return FAIL;
    };

    await preflightAuth({
      url: 'git@github.com:org/repo.git',
      run,
      askMethod: askAlways('ssh'),
    });

    expect(probedUrls[0]).toBe('git@github.com:org/repo.git');
    expect(probedUrls[1]).toBe('git@github.com:org/repo.git');
  });
});

// ---------------------------------------------------------------------------
// preflightAuth — all methods fail → PreflightAuthError
// ---------------------------------------------------------------------------

describe('preflightAuth — all methods fail', () => {
  it('throws PreflightAuthError when ambient probe and re-probe both fail', async () => {
    const run = makeRunner([
      { match: (cmd, args) => cmd === 'git' && args[0] === 'ls-remote', result: FAIL },
      {
        match: (cmd, args) => cmd === 'gh' && args[0] === 'auth',
        result: { exitCode: 0, stdout: 'tok\n', stderr: '' },
      },
    ]);

    await expect(
      preflightAuth({
        url: 'https://github.com/org/repo.git',
        run,
        askMethod: askAlways('provider-cli'),
      }),
    ).rejects.toThrow(PreflightAuthError);
  });

  it('PreflightAuthError carries url and method', async () => {
    const run: CommandRunner = async () => FAIL;

    let caught: unknown;
    try {
      await preflightAuth({
        url: 'https://github.com/org/repo.git',
        run,
        askMethod: askAlways('https'),
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PreflightAuthError);
    const err = caught as PreflightAuthError;
    expect(err.url).toBe('https://github.com/org/repo.git');
    expect(err.method).toBe('https');
  });

  it('PreflightAuthError message is actionable and mentions the method', async () => {
    const run: CommandRunner = async () => FAIL;

    let caught: unknown;
    try {
      await preflightAuth({
        url: 'https://github.com/org/repo.git',
        run,
        askMethod: askAlways('provider-cli'),
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PreflightAuthError);
    const err = caught as PreflightAuthError;
    // Message must mention the method and contain actionable guidance
    expect(err.message.toLowerCase()).toContain('provider-cli');
    expect(err.message).toMatch(/gh auth login|glab auth login/i);
  });

  it('ssh method failure message is actionable', async () => {
    const run: CommandRunner = async () => FAIL;

    let caught: unknown;
    try {
      await preflightAuth({
        url: 'https://github.com/org/repo.git',
        run,
        askMethod: askAlways('ssh'),
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PreflightAuthError);
    const err = caught as PreflightAuthError;
    expect(err.message.toLowerCase()).toContain('ssh');
  });

  it('https method failure message is actionable', async () => {
    const run: CommandRunner = async () => FAIL;

    let caught: unknown;
    try {
      await preflightAuth({
        url: 'https://github.com/org/repo.git',
        run,
        askMethod: askAlways('https'),
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PreflightAuthError);
    const err = caught as PreflightAuthError;
    expect(err.message.toLowerCase()).toContain('https');
    expect(err.message).toMatch(/git credential|credential helper/i);
  });
});
