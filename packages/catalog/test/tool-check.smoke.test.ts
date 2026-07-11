/**
 * Smoke tests for tool-check.ts's defaultRunner and checkTool's production
 * (no-runner-injected) path — real Bun.spawn processes, never exercised by a
 * real spawn before this file (M16 residual, lot7).
 *
 * `defaultRunner`'s `sh -c` fallback (tool-check.ts:36, taken whenever `run`
 * is called with no `args`) is the exact path `checkTool` uses in production:
 * `checkTool` always calls `run(entry.check)` with no args (tool-check.ts:102).
 * Every other test of `checkTool` in this package injects a fake runner, so
 * that fallback has never actually spawned a shell before these tests.
 *
 * Portable across macOS + ubuntu: only `true`, `false`, `printf`, `echo`,
 * `sh -c` are used — no gitleaks/git/network dependency.
 */

import { describe, expect, it } from 'bun:test';

import type { ArtifactEntry } from '../src/schema';
import { checkTool, defaultRunner } from '../src/tool-check';

// ---------------------------------------------------------------------------
// defaultRunner — real spawn, exit codes
// ---------------------------------------------------------------------------

describe('defaultRunner — real spawn, exit code', () => {
  it('exits 0 for "true"', async () => {
    const result = await defaultRunner('true');
    expect(result.exitCode).toBe(0);
  });

  it('returns the exact non-zero exit code of the command (sh -c "exit 3")', async () => {
    const result = await defaultRunner('exit 3');
    expect(result.exitCode).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// defaultRunner — real spawn, output capture
// ---------------------------------------------------------------------------

describe('defaultRunner — real spawn, output capture', () => {
  it('captures stdout via printf', async () => {
    const result = await defaultRunner('printf hello-stdout');
    expect(result.stdout).toBe('hello-stdout');
  });

  it('captures stderr', async () => {
    const result = await defaultRunner('printf hello-stderr 1>&2');
    expect(result.stderr).toBe('hello-stderr');
  });
});

// ---------------------------------------------------------------------------
// defaultRunner — fallback sh -c quoting
// ---------------------------------------------------------------------------

describe('defaultRunner — fallback sh -c quoting', () => {
  it('lets the shell parse quotes in the command string (internal spacing survives)', async () => {
    // Two spaces inside the quoted argument only survive if `sh -c` really
    // parses the command string as shell syntax (a naive whitespace split of
    // the command, without a real shell, would collapse or scramble this).
    const result = await defaultRunner('echo "a  b"');
    expect(result.stdout).toBe('a  b\n');
  });
});

// ---------------------------------------------------------------------------
// checkTool — production path, no runner injected
// ---------------------------------------------------------------------------

function toolEntry(check: string): ArtifactEntry {
  return {
    kind: 'artifact',
    id: 'tool:smoke-fixture',
    nature: 'tool',
    targets: ['claude'],
    scopes: ['user'],
    level: 'required',
    check,
  };
}

describe('checkTool — no injected runner (production sh -c path)', () => {
  it('reports "present" when entry.check exits 0 ("true")', async () => {
    const result = await checkTool(toolEntry('true'));
    expect(result.presence).toBe('present');
  });

  it('reports "absent" when entry.check exits non-zero ("false")', async () => {
    const result = await checkTool(toolEntry('false'));
    expect(result.presence).toBe('absent');
  });
});
