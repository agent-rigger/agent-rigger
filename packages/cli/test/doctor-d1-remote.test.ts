/**
 * doctor-d1-remote.test.ts — D1: `--remote` opt-in reading of catalog content.
 *
 * One test per D1 scenario in requirements.md, named `doctor-D1: …` (stock §8
 * traceability convention). Driven through `runCli` at the exit-code level with
 * an isolated RIGGER_HOME and an injected fake git runner + tmpFactory: no
 * network, no real git.
 *
 * The invariant this pins: without `--remote`, doctor never touches the network
 * (the spy runner records zero calls); with `--remote`, every configured
 * catalog is fetched (one clone each), and a single fetch failure is fail-closed
 * (exit 1, the offending catalog named). Combinable with `--fix`, silent in
 * non-TTY, and the flag is in KNOWN_FLAGS + USAGE.
 *
 * TDD: written before the doctor dispatch grew the `--remote` fetch branch and
 * `KNOWN_FLAGS`/USAGE grew `remote` (RED → GREEN).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import type { Env } from '@agent-rigger/core/paths';

import { KNOWN_FLAGS, parseArgs, runCli } from '../src/cli';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_SHA = 'aabbccddeeff00112233445566778899aabbccdd';

function makeCapture(): { lines: string[]; print: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

/**
 * Isolated RIGGER_HOME. `catalogs` (name+url pairs) are written to the CLI
 * config so the doctor dispatch sees them as configured sources. No state.json
 * is written — an absent manifest reads as empty (healthy → exit 0), keeping
 * the exit code determined solely by the `--remote` behaviour under test.
 */
async function makeHome(
  catalogs: { name: string; url: string }[],
): Promise<{ env: Env; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-d1-remote-'));
  const configDir = path.join(dir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });
  await Bun.write(path.join(configDir, 'config.json'), JSON.stringify({ catalogs }));
  return { env: { RIGGER_HOME: dir }, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/**
 * A fake git runner that records every argv it is asked to run (the spy). It
 * answers the three commands the canon fetch drives — `ls-remote --tags`
 * (resolveVersion), `clone` (checkout), `rev-parse HEAD` (provenance) — with a
 * single fixed tag/sha so provenance matches. `failCloneFor`, when set, makes
 * the clone of that url fail (exit 1) so the caller sees a RemoteFetchError.
 */
function makeSpyRunner(opts: { failCloneFor?: string } = {}): {
  run: CommandRunner;
  calls: string[][];
  cloneUrls: string[];
} {
  const calls: string[][] = [];
  const cloneUrls: string[] = [];
  const run: CommandRunner = (_cmd, args) => {
    const argv = args ?? [];
    calls.push(argv);
    if (argv.includes('ls-remote') && argv.includes('--tags')) {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${FAKE_SHA}\trefs/tags/v1.0.0\n`,
        stderr: '',
      });
    }
    if (argv[0] === 'clone') {
      // The url is the token just before the destination path (after `--`).
      const url = argv[argv.indexOf('--') + 1] ?? '';
      cloneUrls.push(url);
      if (opts.failCloneFor !== undefined && url === opts.failCloneFor) {
        return Promise.resolve({
          exitCode: 128,
          stdout: '',
          stderr: 'fatal: repository not found',
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argv.includes('rev-parse')) {
      return Promise.resolve({ exitCode: 0, stdout: `${FAKE_SHA}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };
  return { run, calls, cloneUrls };
}

/**
 * A tmpFactory that materialises a minimal, valid catalog.json (empty entries →
 * no host-diff findings, healthy state) in a throwaway dir, then removes it on
 * cleanup. Shared across sequential fetches — each fetch rewrites the same dir.
 */
function makeCanonTmpFactory(
  dir: string,
): () => Promise<{ path: string; cleanup: () => Promise<void> }> {
  return async () => {
    await Bun.write(
      path.join(dir, 'catalog.json'),
      JSON.stringify({ meta: { name: 'd1-canon' }, entries: [] }),
    );
    return { path: dir, cleanup: async () => {} };
  };
}

// ---------------------------------------------------------------------------
// Scenario: sans flag, rien ne change — zéro accès réseau
// ---------------------------------------------------------------------------

describe('doctor-D1: without --remote, no network access at all', () => {
  let home: { env: Env; cleanup: () => Promise<void> };
  let canonDir: string;

  beforeEach(async () => {
    home = await makeHome([{ name: 'principal', url: 'https://example.com/a.git' }]);
    canonDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-d1-canon-'));
  });

  afterEach(async () => {
    await home.cleanup();
    await fs.rm(canonDir, { recursive: true, force: true });
  });

  it('runs the fetch runner zero times when the flag is absent', async () => {
    const cap = makeCapture();
    const spy = makeSpyRunner();
    const code = await runCli(['doctor'], {
      print: cap.print,
      env: home.env,
      remote: { run: spy.run, tmpFactory: makeCanonTmpFactory(canonDir) },
    });
    // v1 contract on a healthy isolated home: exit 0.
    expect(code).toBe(0);
    // The proof: the injected git runner was never invoked.
    expect(spy.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario: avec flag, fetch de tous les configurés
// ---------------------------------------------------------------------------

describe('doctor-D1: with --remote, every configured catalog is fetched', () => {
  let home: { env: Env; cleanup: () => Promise<void> };
  let canonDir: string;
  const urls = ['https://example.com/a.git', 'https://example.com/b.git'];

  beforeEach(async () => {
    home = await makeHome([
      { name: 'alpha', url: urls[0] as string },
      { name: 'beta', url: urls[1] as string },
    ]);
    canonDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-d1-canon-'));
  });

  afterEach(async () => {
    await home.cleanup();
    await fs.rm(canonDir, { recursive: true, force: true });
  });

  it('clones each of the two configured catalogs exactly once', async () => {
    const cap = makeCapture();
    const spy = makeSpyRunner();
    const code = await runCli(['doctor', '--remote'], {
      print: cap.print,
      env: home.env,
      remote: { run: spy.run, tmpFactory: makeCanonTmpFactory(canonDir) },
    });
    expect(code).toBe(0);
    expect(spy.cloneUrls).toEqual(urls);
  });
});

// ---------------------------------------------------------------------------
// Scenario: fetch en échec → fail-closed
// ---------------------------------------------------------------------------

describe('doctor-D1: a single fetch failure is fail-closed (exit 1, catalog named)', () => {
  let home: { env: Env; cleanup: () => Promise<void> };
  let canonDir: string;
  const badUrl = 'https://example.com/unreachable.git';

  beforeEach(async () => {
    home = await makeHome([
      { name: 'ok', url: 'https://example.com/ok.git' },
      { name: 'broken', url: badUrl },
    ]);
    canonDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-d1-canon-'));
  });

  afterEach(async () => {
    await home.cleanup();
    await fs.rm(canonDir, { recursive: true, force: true });
  });

  it('exits 1 and names the offending catalog, never degrading to disk-only', async () => {
    const cap = makeCapture();
    const spy = makeSpyRunner({ failCloneFor: badUrl });
    const code = await runCli(['doctor', '--remote'], {
      print: cap.print,
      env: home.env,
      remote: { run: spy.run, tmpFactory: makeCanonTmpFactory(canonDir) },
    });
    expect(code).toBe(1);
    const out = cap.lines.join('\n');
    expect(out).toContain('broken');
    expect(out).toContain(badUrl);
  });
});

// ---------------------------------------------------------------------------
// Scenario: --remote en non-TTY (report-only, aucun prompt)
// ---------------------------------------------------------------------------

describe('doctor-D1: --remote in a non-TTY session never prompts', () => {
  let home: { env: Env; cleanup: () => Promise<void> };
  let canonDir: string;

  beforeEach(async () => {
    home = await makeHome([{ name: 'principal', url: 'https://example.com/a.git' }]);
    canonDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-d1-canon-'));
  });

  afterEach(async () => {
    await home.cleanup();
    await fs.rm(canonDir, { recursive: true, force: true });
  });

  it('completes read-only with no interaction (diagnose is report-only)', async () => {
    const cap = makeCapture();
    const spy = makeSpyRunner();
    // No prompt deps injected — a completed run under a non-TTY stdin proves
    // the differential never blocks on interaction.
    const code = await runCli(['doctor', '--remote'], {
      print: cap.print,
      env: home.env,
      remote: { run: spy.run, tmpFactory: makeCanonTmpFactory(canonDir) },
    });
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario: --remote --fix combinables
// ---------------------------------------------------------------------------

describe('doctor-D1: --remote --fix is accepted (no exclusion rule)', () => {
  let home: { env: Env; cleanup: () => Promise<void> };
  let canonDir: string;

  beforeEach(async () => {
    home = await makeHome([{ name: 'principal', url: 'https://example.com/a.git' }]);
    canonDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-d1-canon-'));
  });

  afterEach(async () => {
    await home.cleanup();
    await fs.rm(canonDir, { recursive: true, force: true });
  });

  it('accepts --remote --fix --yes without a rejection exit', async () => {
    const cap = makeCapture();
    const spy = makeSpyRunner();
    // --yes is required because bun test runs non-TTY; the point is that
    // --remote adds no exclusion of its own.
    const code = await runCli(['doctor', '--remote', '--fix', '--yes'], {
      print: cap.print,
      env: home.env,
      remote: { run: spy.run, tmpFactory: makeCanonTmpFactory(canonDir) },
    });
    // Healthy state, nothing to repair → exit 0; never the non-TTY rejection (2).
    expect(code).toBe(0);
    expect(spy.cloneUrls).toEqual(['https://example.com/a.git']);
  });
});

// ---------------------------------------------------------------------------
// Scenario: --remote dans l'allowlist et le USAGE
// ---------------------------------------------------------------------------

describe('doctor-D1: --remote is a known flag documented in USAGE', () => {
  it('parses --remote as a boolean flag, not an unknown-flag error', () => {
    const parsed = parseArgs(['doctor', '--remote']);
    expect(parsed.error).toBeUndefined();
    expect(parsed.flags['remote']).toBe(true);
    expect(KNOWN_FLAGS.has('remote')).toBe(true);
  });

  it('documents --remote in the USAGE Options section', async () => {
    const cap = makeCapture();
    await runCli(['--help'], { print: cap.print, env: { RIGGER_HOME: '/nonexistent' } });
    const usage = cap.lines.join('\n');
    const options = usage.slice(usage.indexOf('Options:'), usage.indexOf('Examples:'));
    expect(options).toContain('--remote');
  });
});
