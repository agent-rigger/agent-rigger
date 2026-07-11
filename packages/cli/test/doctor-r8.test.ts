/**
 * doctor-r8.test.ts — Surface CLI: command, consent, exit codes (R8).
 *
 * The six R8 scenarios, each named `doctor-R8: …` (stock §8 traceability):
 *   1. healthy state                → exit 0
 *   2. findings without --fix       → exit 3, grouped report
 *   3. --fix in non-TTY without --yes → exit 2 before any repair work
 *   4. --fix takes the run-lock     → ConcurrentRunError → exit 1
 *   5. manifest unreadable          → salvage (backup + guidance), exit 2, and
 *      the old "delete the file to start fresh" advice is GONE from doctor
 *   6. --fix is in the USAGE Options (the lot5 anti-drift test forces it)
 *
 * Plus the R6 boundary the exit contract inherits: a live/indeterminate lock
 * makes diagnose abstain and exit 0, and a --fix run that repairs everything
 * exits 0.
 *
 * Exit-code scenarios inject a controlled `DoctorScanner[]` so the assertions
 * are deterministic (no dependency on the machine's real ~/.config or tmpdir);
 * the salvage scenario uses the REAL manifest-audit scanner against a malformed
 * state.json on a temp home, since that is the exact production path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  type DoctorScanner,
  type Finding,
  hygieneResidue,
  lockPidRecycledProbable,
  lockRefused,
  manifestAuditScanner,
  manifestMissingSha,
  untrackedAdoptable,
  untrackedDrift,
} from '@agent-rigger/core';
import type { Adapter } from '@agent-rigger/core/adapter';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import { ConcurrentRunError, type RunLock } from '@agent-rigger/core/run-lock';

import { runCli } from '../src/cli';
import { runDoctorState } from '../src/cmd-doctor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function capture(): { lines: string[]; print: (s: string) => void; text: () => string } {
  const lines: string[] = [];
  return { lines, print: (s: string) => lines.push(s), text: () => lines.join('\n') };
}

async function makeTmpHome(): Promise<{ env: Env; home: string; cleanup: () => Promise<void> }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-doctor-r8-'));
  return {
    env: { RIGGER_HOME: home },
    home,
    cleanup: () => fs.rm(home, { recursive: true, force: true }),
  };
}

function scanner(findings: Finding[]): DoctorScanner {
  return async () => findings;
}

/** A stub adapter — used only where the exercised op never touches it (backup-state). */
const STUB_ADAPTER = {} as Adapter;

/** A minimal adapter whose `adopt` always succeeds — enough to drive a real manifest write. */
function fakeAdoptingAdapter(id: 'claude' | 'opencode'): Adapter {
  return {
    id,
    audit: async (entry) => ({ id: entry.id, nature: entry.nature, state: 'present' }),
    plan: async () => [],
    apply: async () => {},
    planRemove: async () => [],
    applyRemove: async () => {},
    adopt: async (entry) => ({ files: [entry.id] }),
  };
}

// ---------------------------------------------------------------------------
// 1. healthy → 0
// ---------------------------------------------------------------------------

describe('doctor-R8: a healthy installed state exits 0', () => {
  let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
  beforeEach(async () => (tmp = await makeTmpHome()));
  afterEach(() => tmp.cleanup());

  it('no findings → exit 0, report says healthy', async () => {
    const cap = capture();
    const code = await runDoctorState({
      env: tmp.env,
      print: cap.print,
      fix: false,
      yes: false,
      isTTY: false,
      configuredCatalogIds: [],
      color: false,
      scanners: [scanner([])],
      adapters: new Map(),
    });

    expect(code).toBe(0);
    expect(cap.text()).toContain('healthy');
  });
});

// ---------------------------------------------------------------------------
// 2. findings without --fix → 3
// ---------------------------------------------------------------------------

describe('doctor-R8: findings without --fix exit 3 with a grouped report', () => {
  let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
  beforeEach(async () => (tmp = await makeTmpHome()));
  afterEach(() => tmp.cleanup());

  it('a manifest issue + a drift → exit 3, both classes rendered', async () => {
    const findings: Finding[] = [
      manifestMissingSha({ entryId: 'x/skill:a', nature: 'skill', scope: 'user' }),
      untrackedDrift({
        nature: 'skill',
        scope: 'user',
        assistant: 'claude',
        path: '/h/.claude/skills/d',
      }),
    ];
    const cap = capture();
    const code = await runDoctorState({
      env: tmp.env,
      print: cap.print,
      fix: false,
      yes: false,
      isTTY: false,
      configuredCatalogIds: [],
      color: false,
      scanners: [scanner(findings)],
      adapters: new Map(),
    });

    expect(code).toBe(3);
    const text = cap.text();
    expect(text).toContain('Manifest issues');
    expect(text).toContain('Untracked artifacts');
  });
});

// ---------------------------------------------------------------------------
// 3. --fix in non-TTY without --yes → 2 (before any work)
// ---------------------------------------------------------------------------

describe('doctor-R8: --fix in a non-TTY without --yes exits 2 before any repair', () => {
  let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
  beforeEach(async () => (tmp = await makeTmpHome()));
  afterEach(() => tmp.cleanup());

  it('gate returns 2 and never acquires a lock', async () => {
    let acquired = false;
    const cap = capture();
    const code = await runDoctorState({
      env: tmp.env,
      print: cap.print,
      fix: true,
      yes: false,
      isTTY: false,
      configuredCatalogIds: [],
      color: false,
      scanners: [scanner([hygieneResidue({ path: '/tmp/x.tmp-deadbeef', ageMs: 100_000 })])],
      adapters: new Map(),
      acquireLock: async () => {
        acquired = true;
        throw new Error('should not acquire');
      },
    });

    expect(code).toBe(2);
    expect(acquired).toBe(false);
    expect(cap.text()).toContain('--fix needs');
  });
});

// ---------------------------------------------------------------------------
// 4. --fix takes the run-lock → ConcurrentRunError → 1
// ---------------------------------------------------------------------------

describe('doctor-R8: --fix acquires the run-lock; a concurrent run exits 1', () => {
  let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
  beforeEach(async () => (tmp = await makeTmpHome()));
  afterEach(() => tmp.cleanup());

  it('ConcurrentRunError from acquire → exit 1', async () => {
    const manifestPath = path.join(tmp.home, '.config', 'agent-rigger', 'state.json');
    const cap = capture();
    const code = await runDoctorState({
      env: tmp.env,
      print: cap.print,
      fix: true,
      yes: true, // safe residue op is granted, so there IS state work → acquire runs
      isTTY: false,
      configuredCatalogIds: [],
      color: false,
      scanners: [scanner([hygieneResidue({ path: '/tmp/x.tmp-deadbeef', ageMs: 100_000 })])],
      adapters: new Map([['claude', STUB_ADAPTER]]),
      acquireLock: async () => {
        throw new ConcurrentRunError(`${manifestPath}.lock`, 9999);
      },
    });

    expect(code).toBe(1);
    expect(cap.text()).toContain('in progress');
  });
});

// ---------------------------------------------------------------------------
// 5. manifest unreadable → salvage (backup + guidance), exit 2
// ---------------------------------------------------------------------------

describe('doctor-R8: an unreadable manifest is salvaged (backup + guidance), not "delete the file"', () => {
  let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
  beforeEach(async () => (tmp = await makeTmpHome()));
  afterEach(() => tmp.cleanup());

  async function writeMalformedState(): Promise<string> {
    const dir = path.join(tmp.home, '.config', 'agent-rigger');
    await fs.mkdir(dir, { recursive: true });
    const stateJson = path.join(dir, 'state.json');
    // Valid JSON, invalid shape (version is a string) → MalformedManifestError.
    await fs.writeFile(stateJson, JSON.stringify({ version: 'nope', artifacts: [] }));
    return stateJson;
  }

  it('without --fix → exit 2, form diagnostic shown, no destructive advice', async () => {
    await writeMalformedState();
    const cap = capture();
    const code = await runDoctorState({
      env: tmp.env,
      print: cap.print,
      fix: false,
      yes: false,
      isTTY: false,
      configuredCatalogIds: [],
      color: false,
      scanners: [manifestAuditScanner],
      adapters: new Map(),
    });

    expect(code).toBe(2);
    const text = cap.text();
    expect(text).toContain('unreadable');
    expect(text).toContain('back it up');
    // The old destructive advice is gone from doctor (ADR-0025).
    expect(text).not.toContain('delete the file to start fresh');
  });

  it('with --fix (--yes) → backs up state.json, still exit 2', async () => {
    const stateJson = await writeMalformedState();
    const dir = path.dirname(stateJson);
    const cap = capture();
    const code = await runDoctorState({
      env: tmp.env,
      print: cap.print,
      fix: true,
      yes: true,
      isTTY: false,
      configuredCatalogIds: [],
      color: false,
      scanners: [manifestAuditScanner],
      adapters: new Map([['claude', STUB_ADAPTER]]),
      // backup-state never touches the run-lock's real acquire; a fake lock with
      // the exact expected path satisfies applyRepairs' wrong-lock guard.
      acquireLock: async (mp): Promise<RunLock> => ({
        path: `${mp}.lock`,
        release: async () => {},
      }),
    });

    expect(code).toBe(2);
    const siblings = await fs.readdir(dir);
    expect(siblings.some((f) => f.startsWith('state.json.bak-'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R6 boundary the exit contract inherits: a live lock → abstain, exit 0
// ---------------------------------------------------------------------------

describe('doctor-R8: a run in progress makes doctor abstain and exit 0', () => {
  let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
  beforeEach(async () => (tmp = await makeTmpHome()));
  afterEach(() => tmp.cleanup());

  it('a lock "refused" (live) finding → exit 0, scan skipped', async () => {
    const refused = lockRefused({
      reason: 'live',
      evidence: {
        pid: 111,
        startedAt: undefined,
        ageMs: 10,
        liveness: 'alive',
        identity: 'rigger',
      },
    });
    const cap = capture();
    const code = await runDoctorState({
      env: tmp.env,
      print: cap.print,
      fix: false,
      yes: false,
      isTTY: false,
      configuredCatalogIds: [],
      color: false,
      scanners: [scanner([refused])],
      adapters: new Map(),
    });

    expect(code).toBe(0);
    expect(cap.text()).toContain('in progress');
  });
});

// ---------------------------------------------------------------------------
// R6 "pid recyclé" — the consented break must actually reach breakLockCas
// (post-review fix: cmd-doctor's default breaker used to always refuse
// `pid-alive`, making this repair unreachable dead code). These tests do NOT
// inject `opts.breakLock` — they exercise the REAL default wiring (only
// `identify` is faked), so a regression here reproduces the exact bug.
// ---------------------------------------------------------------------------

describe('doctor-R6: --fix breaks a confirmed-foreign pid-recycled lock (real breakLockCas)', () => {
  let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
  beforeEach(async () => (tmp = await makeTmpHome()));
  afterEach(() => tmp.cleanup());

  async function writeRealLock(pid: number, startedAt: string): Promise<string> {
    const lockPath = `${resolveUserTargets(tmp.env).stateJson}.lock`;
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify({ pid, startedAt }));
    return lockPath;
  }

  it('identify confirms foreign → the lock is broken, exit 0', async () => {
    const startedAt = new Date().toISOString();
    // process.pid is genuinely alive (it is this test run) — breakLockCas's
    // real, uninjected liveness probe sees a live pid, exactly like a real
    // recycled-pid scenario. Breaking only renames/removes the lockfile, it
    // never touches the process itself.
    const lockPath = await writeRealLock(process.pid, startedAt);
    const finding = lockPidRecycledProbable({
      lockPath,
      evidence: {
        pid: process.pid,
        startedAt,
        ageMs: 10,
        liveness: 'alive',
        identity: 'foreign',
      },
    });

    const cap = capture();
    const code = await runDoctorState({
      env: tmp.env,
      print: cap.print,
      fix: true,
      yes: false,
      isTTY: true,
      configuredCatalogIds: [],
      color: false,
      scanners: [scanner([finding])],
      adapters: new Map(),
      confirmItem: async () => true,
      identify: async () => 'foreign',
    });

    expect(code).toBe(0);
    expect(cap.text()).toContain('Broke the run lock');
    expect(await fs.stat(lockPath).then(() => true).catch(() => false)).toBe(false);
  });

  it('identify does NOT confirm foreign (plausibly rigger) → the break is refused, exit 3, lock untouched', async () => {
    const startedAt = new Date().toISOString();
    const lockPath = await writeRealLock(process.pid, startedAt);
    const finding = lockPidRecycledProbable({
      lockPath,
      evidence: {
        pid: process.pid,
        startedAt,
        ageMs: 10,
        liveness: 'alive',
        identity: 'foreign',
      },
    });

    const cap = capture();
    const code = await runDoctorState({
      env: tmp.env,
      print: cap.print,
      fix: true,
      yes: false,
      isTTY: true,
      configuredCatalogIds: [],
      color: false,
      scanners: [scanner([finding])],
      adapters: new Map(),
      confirmItem: async () => true,
      identify: async () => 'rigger', // act-time re-check no longer says foreign
    });

    expect(code).toBe(3);
    expect(cap.text()).toContain('Lock break refused');
    expect(cap.text()).toContain('pid-alive');
    expect(await fs.stat(lockPath).then(() => true).catch(() => false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// --fix repairs everything → exit 0
// ---------------------------------------------------------------------------

describe('doctor-R8: --fix that repairs every finding exits 0', () => {
  let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
  beforeEach(async () => (tmp = await makeTmpHome()));
  afterEach(() => tmp.cleanup());

  it('a safe residue op is granted, deleted, and the run exits 0', async () => {
    // A real aged `.tmp-<8hex>` residue applyRepairs will actually delete.
    const residue = path.join(tmp.home, 'settings.json.tmp-deadbeef');
    await fs.writeFile(residue, 'stale');
    const old = Date.now() - 48 * 60 * 60 * 1000;
    await fs.utimes(residue, new Date(old), new Date(old));

    const cap = capture();
    const code = await runDoctorState({
      env: tmp.env,
      print: cap.print,
      fix: true,
      yes: true,
      isTTY: false,
      configuredCatalogIds: [],
      color: false,
      scanners: [scanner([hygieneResidue({ path: residue, ageMs: 48 * 60 * 60 * 1000 })])],
      adapters: new Map([['claude', STUB_ADAPTER]]),
      acquireLock: async (mp): Promise<RunLock> => ({
        path: `${mp}.lock`,
        release: async () => {},
      }),
      now: () => Date.now(),
    });

    expect(code).toBe(0);
    expect(await fs.exists(residue)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Low2 — state.json backup guard shared across per-assistant applyRepairs calls
// ---------------------------------------------------------------------------

describe('doctor-R8/Low2: state.json is backed up ONCE across multiple assistants', () => {
  let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
  beforeEach(async () => (tmp = await makeTmpHome()));
  afterEach(() => tmp.cleanup());

  it('a --fix touching claude AND opencode adoptions produces exactly ONE state.json.bak-*', async () => {
    const manifestPath = resolveUserTargets(tmp.env).stateJson;
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify({ version: 1, artifacts: [] }));

    const claudeFinding = untrackedAdoptable({
      nature: 'skill',
      scope: 'user',
      assistant: 'claude',
      path: '/h/.claude/skills/foo',
      candidateId: 'skill:foo',
    });
    const opencodeFinding = untrackedAdoptable({
      nature: 'skill',
      scope: 'user',
      assistant: 'opencode',
      path: '/h/.config/opencode/skill/bar',
      candidateId: 'skill:bar',
    });

    const cap = capture();
    const code = await runDoctorState({
      env: tmp.env,
      print: cap.print,
      fix: true,
      yes: true,
      isTTY: false,
      configuredCatalogIds: [],
      color: false,
      scanners: [scanner([claudeFinding, opencodeFinding])],
      adapters: new Map([
        ['claude', fakeAdoptingAdapter('claude')],
        ['opencode', fakeAdoptingAdapter('opencode')],
      ]),
      acquireLock: async (mp): Promise<RunLock> => ({
        path: `${mp}.lock`,
        release: async () => {},
      }),
    });

    expect(code).toBe(0);
    const dir = path.dirname(manifestPath);
    const siblings = await fs.readdir(dir);
    const baks = siblings.filter((f) => f.startsWith('state.json.bak-'));
    expect(baks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. --fix is documented in USAGE (anti-drift; lot5 test enforces the ↔)
// ---------------------------------------------------------------------------

describe('doctor-R8: --fix is a documented flag in the USAGE Options section', () => {
  it('--help prints a "--fix" option line', async () => {
    const cap = capture();
    const code = await runCli(['--help'], {
      print: cap.print,
      env: { RIGGER_HOME: '/nonexistent' },
    });
    expect(code).toBe(0);
    const usage = cap.text();
    const options = usage.slice(usage.indexOf('Options:'), usage.indexOf('Examples:'));
    expect(options).toContain('--fix');
  });
});
