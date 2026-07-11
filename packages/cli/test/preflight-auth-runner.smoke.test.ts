/**
 * Smoke tests for preflight-auth.ts's defaultRunner — the real Bun.spawn-
 * backed CommandRunner used in production (preflight-auth.ts:52). Every other
 * test in this package injects a fake CommandRunner, so this is the first
 * real spawn (M16 residual, lot7). Env merge (opts.env layered over
 * process.env, preflight-auth.ts:54) is asserted with a sentinel variable
 * against the real child process, not a mock.
 */

import { describe, expect, it } from 'bun:test';

import { defaultRunner } from '../src/preflight-auth';

// ---------------------------------------------------------------------------
// Real spawn — exit code + stdout capture
// ---------------------------------------------------------------------------

describe('defaultRunner — real spawn', () => {
  it('runs sh -c "printf ok" and returns exit 0 + stdout "ok"', async () => {
    const result = await defaultRunner('sh', ['-c', 'printf ok']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
  });

  it('returns the exact exit code of the spawned command', async () => {
    const result = await defaultRunner('sh', ['-c', 'exit 7']);
    expect(result.exitCode).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Env merge — opts.env layered over process.env
// ---------------------------------------------------------------------------

describe('defaultRunner — env merge (opts.env over process.env)', () => {
  const SENTINEL = 'AGENT_RIGGER_SMOKE_PREFLIGHT_SENTINEL';

  it('injects opts.env values into the child process environment', async () => {
    const result = await defaultRunner('sh', ['-c', `printf "%s" "$${SENTINEL}"`], {
      env: { [SENTINEL]: 'injected-value' },
    });
    expect(result.stdout).toBe('injected-value');
  });

  it('inherits process.env when opts.env is not provided', async () => {
    const original = process.env[SENTINEL];
    process.env[SENTINEL] = 'from-parent-env';
    try {
      const result = await defaultRunner('sh', ['-c', `printf "%s" "$${SENTINEL}"`]);
      expect(result.stdout).toBe('from-parent-env');
    } finally {
      if (original === undefined) {
        delete process.env[SENTINEL];
      } else {
        process.env[SENTINEL] = original;
      }
    }
  });
});
