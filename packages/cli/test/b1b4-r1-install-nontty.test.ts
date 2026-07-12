/**
 * b1b4-r1-install-nontty.test.ts — R1: fail-fast the interactive install
 * picker on a non-TTY stdin when no ids are given (finding B1).
 *
 * `--yes` satisfies the existing confirm gate (assertConfirmableOrYes,
 * cli.ts) but then the interactive branch calls selectScope/the clack status
 * picker, which never resolves on a non-TTY stdin — an indefinite hang. And
 * without `--yes` the existing gate's message ("pass --yes") sends the user
 * straight into that hang. R1 adds a guard at the head of handleInstall that
 * rejects "no ids + non-TTY stdin" with exit 2 and a message pointing at
 * explicit ids, BEFORE any catalog resolution / network fetch / checkout.
 *
 * One test per scenario in requirements.md (R1), named `b1b4-R1: …` (stock §8
 * traceability convention). Pattern mirrors lot5-r4-nontty.test.ts: a counting
 * runner proves the guard fires before any fetch (count stays 0); these tests
 * inject NO `deps.prompts` for the gated scenarios — the real interactive path,
 * where the guard engages (it is bypassed when prompts are injected, since a
 * caller supplying its own answers never hangs). The TTY non-regression
 * scenario injects prompts (the only way to reach the picker without real
 * clack) and pins stdin TTY to exercise the "TTY → proceed" leg.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import type { Env } from '@agent-rigger/core/paths';
import type { Scanner } from '@agent-rigger/core/scan';

import type { CliPrompts } from '../src/cli';
import { runCli } from '../src/cli';
import type { StatusedEntry } from '../src/ui';
import { pinStdinIsTTY, pinStdoutIsTTY, setStdinIsTTY, setStdoutIsTTY } from './fixtures/tty';

// Every gated scenario is a non-TTY session (the point of R1). Both streams
// are pinned: the guard keys off stdin, stdout is pinned so the suites that
// don't care about it never accidentally take the interactive branch.
pinStdoutIsTTY(false);
pinStdinIsTTY(false);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_SHA = 'aabbccddeeff00112233445566778899aabbccdd';
const TAG_NAME = 'v1.0.0';

const SKILL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:remote-demo',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

function makeCapture(): { lines: string[]; print: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

/**
 * A runner that answers the git queries a real install/status-resolution needs,
 * wrapped so every invocation increments `count()`. When the guard fires before
 * any fetch, `count()` stays 0 — the load-bearing assertion of R1.
 */
function makeCountingRunner(): { runner: CommandRunner; count: () => number } {
  let calls = 0;
  const runner: CommandRunner = (_cmd, args) => {
    calls++;
    const argv = args ?? [];
    if (argv[0] === 'ls-remote' && argv.includes('--tags')) {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${FAKE_SHA}\trefs/tags/${TAG_NAME}\n`,
        stderr: '',
      });
    }
    if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
      return Promise.resolve({ exitCode: 0, stdout: `${FAKE_SHA}\tHEAD\n`, stderr: '' });
    }
    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${FAKE_SHA}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };
  return { runner, count: () => calls };
}

/** A scanner wrapped so every scan increments `count()` (proves "no scan"). */
function makeCountingScanner(): { scanner: Scanner; count: () => number } {
  let calls = 0;
  const scanner: Scanner = {
    scan: (_source: string) => {
      calls++;
      return Promise.resolve({ ok: true });
    },
  };
  return { scanner, count: () => calls };
}

/**
 * Isolated env with a configured catalog + a content checkout carrying the
 * skill fixture. A catalog IS configured so the exit-2 on the gated paths is
 * unambiguously the R1 guard ("interactive picker requires a TTY"), not the
 * "no catalog configured" precondition.
 */
async function makeEnv(): Promise<{
  env: Env;
  tmpFactory: TmpDirFactory;
  cleanupAll: () => Promise<void>;
}> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-b1b4-r1-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-b1b4-r1-content-'));

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 'r1-catalog' }, entries: [SKILL_ENTRY] }),
    'utf8',
  );
  await fs.mkdir(path.join(contentDir, 'skills', 'remote-demo'), { recursive: true });
  await fs.writeFile(
    path.join(contentDir, 'skills', 'remote-demo', 'SKILL.md'),
    `# Remote Demo\n${TAG_NAME} content.`,
    'utf8',
  );

  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }] }),
    'utf8',
  );

  const env: Env = { RIGGER_HOME: homeDir };
  const tmpFactory: TmpDirFactory = async () => ({ path: contentDir, cleanup: async () => {} });

  const cleanupAll = async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(contentDir, { recursive: true, force: true });
  };

  return { env, tmpFactory, cleanupAll };
}

/**
 * Prompts with a capturing status picker (mirrors status-aware-picker.test.ts's
 * makePrompts). `captured.called` records whether the interactive picker was
 * reached — the non-regression assertion for the TTY scenario. Every prompt
 * returns synchronously, so nothing hangs regardless of stdin state.
 */
function makePrompts(captured: { called: boolean }): CliPrompts {
  return {
    selectArtifacts: async () => [],
    selectArtifactsByStatus: async (_entries: StatusedEntry[]) => {
      captured.called = true;
      return [];
    },
    selectScope: async () => 'user',
    confirmApply: async () => true,
    askUrl: async () => '',
    askMethod: async () => 'https',
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: fail-fast avec --yes (le hang B1)
// ---------------------------------------------------------------------------

describe('b1b4-R1: install --yes sans ids non-TTY', () => {
  it('b1b4-R1: install --yes sans ids non-TTY → exit 2, message actionnable, zéro fetch', async () => {
    const fx = await makeEnv();
    const { runner, count: runCount } = makeCountingRunner();
    const { scanner, count: scanCount } = makeCountingScanner();
    const cap = makeCapture();

    try {
      const code = await runCli(['install', '--yes'], {
        print: cap.print,
        env: fx.env,
        remote: { run: runner, tmpFactory: fx.tmpFactory, scanner },
        // NO prompts injected — the real interactive path, where the guard engages.
      });

      expect(code).toBe(2);
      const out = cap.lines.join('\n');
      expect(out).toContain('interactive picker requires a TTY');
      expect(out).toContain('pass explicit ids');
      // The guard must fire BEFORE any network fetch, checkout or scan.
      expect(runCount()).toBe(0);
      expect(scanCount()).toBe(0);
    } finally {
      await fx.cleanupAll();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: sans --yes, le message ne mène plus au hang
// ---------------------------------------------------------------------------

describe('b1b4-R1: install sans ids sans --yes non-TTY', () => {
  it('b1b4-R1: install sans ids sans --yes non-TTY → exit 2, message oriente vers ids explicites', async () => {
    const fx = await makeEnv();
    const { runner, count: runCount } = makeCountingRunner();
    const cap = makeCapture();

    try {
      const code = await runCli(['install'], {
        print: cap.print,
        env: fx.env,
        remote: { run: runner, tmpFactory: fx.tmpFactory },
        // NO prompts — without the R1 guard this would hit the existing gate's
        // "pass --yes" message, which routes the user into the hang.
      });

      expect(code).toBe(2);
      const out = cap.lines.join('\n');
      expect(out).toContain('explicit ids');
      // The message must NOT be (only) "pass --yes": adding --yes alone would
      // reproduce the hang. The R1 message points at explicit ids and never
      // mentions --yes (the "add --yes → add ids" two-error escalation is
      // forbidden for this path, requirements.md §R1 scenario 2).
      expect(out).not.toContain('--yes');
      expect(runCount()).toBe(0);
    } finally {
      await fx.cleanupAll();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: --scope explicite ne contourne pas la garde
// ---------------------------------------------------------------------------

describe('b1b4-R1: --scope explicite ne contourne pas la garde', () => {
  it('b1b4-R1: install --yes --scope=user sans ids non-TTY → exit 2', async () => {
    const fx = await makeEnv();
    const { runner, count: runCount } = makeCountingRunner();
    const cap = makeCapture();

    try {
      // --scope would skip the scope prompt, but the status picker still opens:
      // the guard covers every prompt of the interactive branch, not just the
      // first one, so it does not depend on the scope flag.
      const code = await runCli(['install', '--yes', '--scope=user'], {
        print: cap.print,
        env: fx.env,
        remote: { run: runner, tmpFactory: fx.tmpFactory },
      });

      expect(code).toBe(2);
      expect(cap.lines.join('\n')).toContain('pass explicit ids');
      expect(runCount()).toBe(0);
    } finally {
      await fx.cleanupAll();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: non-régression TTY interactif
// ---------------------------------------------------------------------------

describe('b1b4-R1: non-régression TTY interactif', () => {
  it("b1b4-R1: sans ids, TTY + prompts injectés → le flux interactif s'engage", async () => {
    const fx = await makeEnv();
    const { runner } = makeCountingRunner();
    const { scanner } = makeCountingScanner();
    const cap = makeCapture();
    const captured = { called: false };

    // Real TTY stdin: the "TTY → proceed" leg of the guard. Injected prompts
    // are the only way to reach the picker without real clack (and they also
    // bypass the guard by design, since a caller answering synchronously never
    // hangs) — together they prove the interactive branch engages unchanged.
    setStdinIsTTY(true);
    try {
      const code = await runCli(['install'], {
        print: cap.print,
        env: fx.env,
        prompts: makePrompts(captured),
        remote: { run: runner, tmpFactory: fx.tmpFactory, scanner },
      });

      // Fresh home → the skill classifies as "install" (actionable), so the
      // status picker is reached rather than short-circuited.
      expect(captured.called).toBe(true);
      expect(cap.lines.join('\n')).not.toContain('interactive picker requires a TTY');
      expect(code).toBe(0);
    } finally {
      await fx.cleanupAll();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: non-régression non-TTY avec ids
// ---------------------------------------------------------------------------

describe('b1b4-R1: non-régression non-TTY avec ids', () => {
  it('b1b4-R1: install --yes cat/skill non-TTY → install non-interactif se déroule', async () => {
    const fx = await makeEnv();
    const { runner, count: runCount } = makeCountingRunner();
    const { scanner } = makeCountingScanner();
    const cap = makeCapture();

    try {
      const code = await runCli(['install', '--yes', 'principal/skill:remote-demo'], {
        print: cap.print,
        env: fx.env,
        remote: { run: runner, tmpFactory: fx.tmpFactory, scanner },
        // NO prompts: ids.length > 0 means the guard is skipped by construction,
        // --yes passes the existing confirm gate, install proceeds.
      });

      const out = cap.lines.join('\n');
      // The R1 guard did not fire (ids were given); install ran for real.
      expect(out).not.toContain('interactive picker requires a TTY');
      expect(runCount()).toBeGreaterThan(0);
      expect(code).toBe(0);
    } finally {
      await fx.cleanupAll();
    }
  });
});

// ---------------------------------------------------------------------------
// Hardening: the guard keys off STDIN, not stdout (stream desalignment).
// Mirrors lot5-r4-nontty.test.ts:465-497 for the confirm gate — materializes
// the rationale of cli.ts:2023-2028 for the R1 guard: clack's Prompt reads
// keypresses from stdin, so a stdin→stdout typo in the predicate would let a
// redirected-stdin session (stdout still a TTY) drive the unresolvable picker.
// ---------------------------------------------------------------------------

describe('b1b4-R1: la garde tire sur stdin seul', () => {
  it('b1b4-R1: la garde tire sur stdin seul — stdout TTY + stdin non-TTY → exit 2', async () => {
    const fx = await makeEnv();
    const { runner, count: runCount } = makeCountingRunner();
    const cap = makeCapture();

    // Reproduce the bypass: stdout is a real terminal (a supervisor that
    // redirects only stdin, or `install --yes < /dev/null` from an interactive
    // shell), stdin is not (stays false from the file-level pinStdinIsTTY).
    // The guard must still fire — it tracks the stream the picker blocks on.
    setStdoutIsTTY(true);
    try {
      const code = await runCli(['install', '--yes'], {
        print: cap.print,
        env: fx.env,
        remote: { run: runner, tmpFactory: fx.tmpFactory },
        // NO prompts — the real interactive path, where the guard engages.
      });

      expect(code).toBe(2);
      expect(cap.lines.join('\n')).toContain('pass explicit ids');
      // Had the guard wrongly keyed off stdout, it would have passed here and
      // driven the real (unresolvable, non-TTY-stdin) clack picker instead.
      expect(runCount()).toBe(0);
    } finally {
      await fx.cleanupAll();
    }
  });
});
