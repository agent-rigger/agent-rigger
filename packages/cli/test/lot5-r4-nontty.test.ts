/**
 * lot5-r4-nontty.test.ts — R4: non-interactive fail-closed gate (SECURITY,
 * ADR-0018 consent on untrusted content, ADR-0024 exit codes).
 *
 * When the session is not a TTY and `--yes` is absent, any command that would
 * ask for a confirmation (install, remove, update, ad-hoc install) must fail
 * immediately with exit 2 and an actionable message — BEFORE any network
 * fetch, checkout or scan. clack `confirm` on a non-TTY stdin never resolves
 * (hangs forever), so the gate closes that hole and, for ad-hoc content, also
 * removes the silent select-all of untrusted entries.
 *
 * One test per scenario in requirements.md (R4), named `lot5-R4: …` (stock §8
 * traceability convention). The gate is proven "before any fetch/checkout" by
 * spying on the injected `deps.remote.run` runner (and the scanner): both must
 * see zero calls when the gate fires. These tests inject NO `deps.prompts` —
 * the gate is only engaged on the real interactive path (see
 * assertConfirmableOrYes), which is exactly the production configuration.
 *
 * Strategy:
 * - RIGGER_HOME isolated; a catalog IS configured so that the exit-2 on the
 *   gated paths is unambiguously the R4 gate ("non-interactive"), not the R1
 *   no-catalog precondition ("no catalog configured").
 * - `pinStdoutIsTTY(false)` + `pinStdinIsTTY(false)` fix the session as
 *   non-TTY on both streams for every test.
 * - deps.remote.run wrapped in a call counter; deps.remote.scanner counts scans.
 *
 * Post-review fix regression (last describe block): the gate must key off
 * `process.stdin.isTTY`, not `process.stdout.isTTY` — clack's `Prompt` reads
 * keypresses from stdin, so stdout's TTY-ness is irrelevant to whether the
 * hang can happen. Those tests pin stdout to `true` mid-suite (stdin stays
 * `false`) to reproduce the exact stream-desalignment bypass.
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
import { confirmToolChecks } from '../src/ui';
import { pinStdinIsTTY, pinStdoutIsTTY, setStdoutIsTTY } from './fixtures/tty';

// Every scenario here is a non-TTY session (that is the whole point of R4).
// Both streams are pinned independently: the gate keys off stdin (see the
// stream-desalignment describe block below), stdout is pinned for the
// suites that don't care which stream, matching the file-level convention.
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

/**
 * A raw shell command distinctive enough that no other CommandRunner call
 * (git ls-remote/clone/rev-parse) could ever coincide with it — the marker
 * asserted absent from the recording runner's log below.
 */
const TOOL_CHECK_COMMAND = 'lot5-r4-tool-check-marker --version';

const TOOL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'tool:marker',
  nature: 'tool',
  targets: ['claude'],
  scopes: ['user'],
  check: TOOL_CHECK_COMMAND,
};

function makeCapture(): { lines: string[]; print: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

/**
 * A runner that answers the git queries needed by a real install, wrapped so
 * every invocation increments `count()`. When the gate fires before any fetch,
 * `count()` stays 0 — the load-bearing assertion of R4.
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

/**
 * A CommandRunner that answers the same git queries as `makeCountingRunner`
 * but also records every (command, args) call it receives, in order — used
 * to prove that a SPECIFIC command (a tool's `check`, invoked as
 * `run(entry.check)` with no args, see checkTool in
 * @agent-rigger/catalog/tool-check) was never handed to the runner, as
 * opposed to merely counting total calls (which git ls-remote/clone/rev-parse
 * would also bump).
 */
function makeRecordingRunner(): {
  runner: CommandRunner;
  calls: () => { command: string; args: string[] | undefined }[];
} {
  const { runner: base } = makeCountingRunner();
  const log: { command: string; args: string[] | undefined }[] = [];
  const runner: CommandRunner = (command, args) => {
    log.push({ command, args });
    return base(command, args);
  };
  return { runner, calls: () => log };
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
 * skill fixture (plus any `extraEntries`, e.g. a tool with a check command).
 * `withCatalog: false` writes an empty config (used by no test here, but kept
 * explicit).
 */
async function makeEnv(extraEntries: CatalogEntry[] = []): Promise<{
  env: Env;
  contentDir: string;
  tmpFactory: TmpDirFactory;
  cleanupAll: () => Promise<void>;
}> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-lot5-r4-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-lot5-r4-content-'));

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 'r4-catalog' }, entries: [SKILL_ENTRY, ...extraEntries] }),
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

  return { env, contentDir, tmpFactory, cleanupAll };
}

// ---------------------------------------------------------------------------
// Scenario: install non-TTY sans --yes
// ---------------------------------------------------------------------------

describe('lot5-R4: install non-TTY sans --yes', () => {
  it('exit 2, message "non-interactive — pass --yes", aucun fetch/checkout/scan', async () => {
    const fx = await makeEnv();
    const { runner, count: runCount } = makeCountingRunner();
    const { scanner, count: scanCount } = makeCountingScanner();
    const cap = makeCapture();

    try {
      const code = await runCli(['install', 'principal/skill:remote-demo'], {
        print: cap.print,
        env: fx.env,
        remote: { run: runner, tmpFactory: fx.tmpFactory, scanner },
        // NO prompts injected — the real interactive path, where the gate engages.
      });

      expect(code).toBe(2);
      const out = cap.lines.join('\n');
      expect(out).toContain('non-interactive');
      expect(out).toContain('--yes');
      // The gate must fire BEFORE any network fetch, checkout or scan.
      expect(runCount()).toBe(0);
      expect(scanCount()).toBe(0);
    } finally {
      await fx.cleanupAll();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario: remove / update non-TTY sans --yes
// ---------------------------------------------------------------------------

describe('lot5-R4: remove / update non-TTY sans --yes', () => {
  it('remove … → exit 2 par la gate, avant toute mutation', async () => {
    const fx = await makeEnv();
    const { runner, count: runCount } = makeCountingRunner();
    const cap = makeCapture();

    try {
      const code = await runCli(['remove', 'principal/skill:remote-demo'], {
        print: cap.print,
        env: fx.env,
        remote: { run: runner, tmpFactory: fx.tmpFactory },
      });

      expect(code).toBe(2);
      expect(cap.lines.join('\n')).toContain('non-interactive');
      expect(runCount()).toBe(0);
    } finally {
      await fx.cleanupAll();
    }
  });

  it('update … → même gate, exit 2 avant tout fetch', async () => {
    const fx = await makeEnv();
    const { runner, count: runCount } = makeCountingRunner();
    const cap = makeCapture();

    try {
      const code = await runCli(['update', 'principal/skill:remote-demo'], {
        print: cap.print,
        env: fx.env,
        remote: { run: runner, tmpFactory: fx.tmpFactory },
      });

      expect(code).toBe(2);
      expect(cap.lines.join('\n')).toContain('non-interactive');
      expect(runCount()).toBe(0);
    } finally {
      await fx.cleanupAll();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario: ad-hoc non-TTY — plus de select-all silencieux
// ---------------------------------------------------------------------------

describe('lot5-R4: ad-hoc non-TTY — plus de select-all silencieux', () => {
  it('sans --yes → exit 2 par la gate, aucun fetch de contenu untrusted', async () => {
    const fx = await makeEnv();
    const { runner, count: runCount } = makeCountingRunner();
    const { scanner, count: scanCount } = makeCountingScanner();
    const cap = makeCapture();

    try {
      const code = await runCli(['install', 'https://github.com/org/repo.git'], {
        print: cap.print,
        env: fx.env,
        remote: { run: runner, tmpFactory: fx.tmpFactory, scanner },
      });

      expect(code).toBe(2);
      expect(cap.lines.join('\n')).toContain('non-interactive');
      // No fetch of the untrusted remote, no scan, no silent select-all.
      expect(runCount()).toBe(0);
      expect(scanCount()).toBe(0);
    } finally {
      await fx.cleanupAll();
    }
  });

  it('avec --yes → le select-all reste le comportement documenté consenti (fetch a lieu, pas de gate)', async () => {
    const fx = await makeEnv();
    const { runner, count: runCount } = makeCountingRunner();
    const { scanner } = makeCountingScanner();
    const cap = makeCapture();

    try {
      const code = await runCli(['install', 'https://github.com/org/repo.git', '--yes'], {
        print: cap.print,
        env: fx.env,
        remote: { run: runner, tmpFactory: fx.tmpFactory, scanner },
      });

      // --yes bypasses the gate: the scripted ad-hoc select-all proceeds and the
      // remote is fetched. The install itself succeeds against the fixture.
      const out = cap.lines.join('\n');
      expect(out).not.toContain('non-interactive');
      expect(runCount()).toBeGreaterThan(0);
      expect(code).toBe(0);
    } finally {
      await fx.cleanupAll();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario: non-TTY avec --yes — le chemin scripté procède
// ---------------------------------------------------------------------------

describe('lot5-R4: non-TTY avec --yes — le chemin scripté procède', () => {
  it('install … --yes passe la gate et exécute sans prompt (fetch a lieu, exit 0)', async () => {
    const fx = await makeEnv();
    const { runner, count: runCount } = makeCountingRunner();
    const { scanner } = makeCountingScanner();
    const cap = makeCapture();

    try {
      const code = await runCli(['install', 'principal/skill:remote-demo', '--yes'], {
        print: cap.print,
        env: fx.env,
        remote: { run: runner, tmpFactory: fx.tmpFactory, scanner },
      });

      const out = cap.lines.join('\n');
      expect(out).not.toContain('non-interactive');
      // Past the gate → into the real install flow (fetch happened).
      expect(runCount()).toBeGreaterThan(0);
      expect(code).toBe(0);
    } finally {
      await fx.cleanupAll();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario: tool-checks non-TTY — fail-closed
// ---------------------------------------------------------------------------

describe('lot5-R4: tool-checks non-TTY — fail-closed', () => {
  it('confirmToolChecks retourne false sur session non-TTY (aucun consentement, commandes non exécutées)', async () => {
    // Equivalent to a "no" answer: the caller must run none of the listed check
    // commands. No hang, no execution without consent.
    const result = await confirmToolChecks([
      { id: 'principal/tool:glab', command: 'glab --version' },
    ]);
    expect(result).toBe(false);
  });

  // End-to-end: the unit test above proves confirmToolChecks' own contract in
  // isolation, but only IMPLIES the "commands not executed" half of the R4
  // scenario — it never drives cmd-install's Step 5b, so it can't show the
  // real gate fires there and that checkTools/toolRunner are never reached.
  // This test drives the real flow through runCli.
  //
  // Reaching Step 5b (confirmToolChecks) non-interactively requires bypassing
  // the OUTER gate (assertConfirmableOrYes), which is guarded by
  // `deps.prompts === undefined` (cli.ts) — a caller that injects `deps.prompts`
  // is assumed to answer synchronously, so that gate does not apply and never
  // fires, regardless of the pinned stdin TTY state. This is a deliberate,
  // documented test-injection seam (see assertConfirmableOrYes's doc comment
  // in cli.ts), not a bug: it is exactly what lets this test reach the INNER
  // gate under test. cli.ts never wires an `opts.confirmToolChecks` override
  // through CliDeps (grep confirms no such plumbing exists), so
  // cmd-install.ts's Step 5b always falls back to the real
  // `promptConfirmToolChecks` from ui.ts — the same `confirmToolChecks`
  // exercised directly above — which is the function under test here, reached
  // for real, with stdin still pinned non-TTY at the file level.
  it(
    'install non-TTY (deps.prompts injected) sur une sélection tool → confirmToolChecks réel se déclenche, check jamais exécuté',
    async () => {
      const fx = await makeEnv([TOOL_ENTRY]);
      const { runner, calls } = makeRecordingRunner();
      const { scanner } = makeCountingScanner();
      const cap = makeCapture();

      // Every prompt but confirmApply throws if called — explicit ids on the
      // command line never reach selectArtifacts/selectScope/askUrl/askMethod
      // (same assumption already relied on by lot5-r2-cancel.test.ts's
      // basePrompts). confirmApply must return true so the flow proceeds past
      // the plan confirmation into Step 5b.
      const prompts: CliPrompts = {
        selectArtifacts: async () => {
          throw new Error('selectArtifacts should not be called: explicit ids given');
        },
        selectScope: async () => {
          throw new Error('selectScope should not be called: default scope, no picker');
        },
        confirmApply: async (_planText) => true,
        askUrl: async () => {
          throw new Error('askUrl should not be called: not the init flow');
        },
        askMethod: async () => {
          throw new Error('askMethod should not be called: not the init flow');
        },
      };

      try {
        const code = await runCli(
          ['install', 'principal/skill:remote-demo', 'principal/tool:marker'],
          {
            print: cap.print,
            env: fx.env,
            remote: { run: runner, tmpFactory: fx.tmpFactory, scanner },
            prompts,
          },
        );

        // Advisory only: a refused/unverified tool-check never blocks install.
        expect(code).toBe(0);
        const out = cap.lines.join('\n');
        expect(out).toContain('[not verified]');
        expect(out).toContain('principal/tool:marker');

        // Load-bearing assertion: the check command was never handed to the
        // runner. checkTool (catalog/tool-check.ts) invokes it as
        // `run(entry.check)` — no args — so any call whose command equals the
        // marker string, with or without args, is the check running.
        const toolCheckInvocations = calls().filter((c) => c.command === TOOL_CHECK_COMMAND);
        expect(toolCheckInvocations).toHaveLength(0);
      } finally {
        await fx.cleanupAll();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Post-review fix: the gate must key off STDIN, not stdout. clack's `Prompt`
// reads keypresses from `stdin` (`setRawMode` only applies when
// `stdin.isTTY`) — a hang caused by non-TTY stdin is not prevented by
// checking stdout. This reproduces the exact bypass the finding described:
// stdout still a TTY (e.g. a supervisor that redirects only stdin, or
// `agent-rigger install foo < /dev/null` from an interactive terminal) while
// stdin is not — the gate must still fire.
// ---------------------------------------------------------------------------

describe('lot5-R4: la gate suit stdin, pas stdout (stdout TTY + stdin non-TTY)', () => {
  it('assertConfirmableOrYes (install) se déclenche quand même — exit 2, aucun fetch', async () => {
    const fx = await makeEnv();
    const { runner, count: runCount } = makeCountingRunner();
    const cap = makeCapture();

    // Simulate the bypass: stdout is a real terminal, only stdin is redirected.
    setStdoutIsTTY(true);
    try {
      const code = await runCli(['install', 'principal/skill:remote-demo'], {
        print: cap.print,
        env: fx.env,
        remote: { run: runner, tmpFactory: fx.tmpFactory },
      });

      expect(code).toBe(2);
      expect(cap.lines.join('\n')).toContain('non-interactive');
      // Had the gate wrongly keyed off stdout, it would have passed here and
      // driven the real (unresolvable, non-TTY-stdin) clack prompt instead.
      expect(runCount()).toBe(0);
    } finally {
      await fx.cleanupAll();
    }
  });

  it('confirmToolChecks reste fail-closed (false) — pas de hang potentiel sur stdin non-TTY', async () => {
    setStdoutIsTTY(true);
    const result = await confirmToolChecks([
      { id: 'principal/tool:glab', command: 'glab --version' },
    ]);
    expect(result).toBe(false);
  });
});
