/**
 * lot5-r2-cancel.test.ts — R2: Cancel uniforme, Ctrl+C annule réellement partout.
 *
 * One `describe` per requirements.md scenario (stock §8 convention), named
 * `lot5-R2: …` so traceability grep finds every scenario. Each interactive
 * prompt is exercised at the `CliPrompts` injection boundary — the same
 * convention every other cli.test.ts-family file uses (real clack prompts are
 * never invoked in a non-TTY test env, see ui.test.ts's own doc comment).
 *
 * Strategy:
 * - Prompts injected via `deps.prompts`; a cancelling prompt throws the SAME
 *   `CancelledError` the real ui.ts/cli.ts wiring now throws (post-fix), so
 *   these tests exercise the real `handleError` → 130 mapping end-to-end.
 * - `deps.remote.run` is a counting spy: proves "zero réseau" by asserting the
 *   call count does not grow after the cancelling prompt fires.
 * - Init-wizard scenarios read the config file back to prove nothing was
 *   persisted (no partial write survives a cancelled step).
 *
 * Post-review fix regression: the post-init (cmd-init.ts step 6) and
 * post-catalog-add (cmd-catalog.ts step M7/R9) proposeInstall calls sit
 * inside a pre-existing non-fatal catch meant for fetch failures — a
 * CancelledError from the picker must traverse it (runInit/runCatalog
 * exercised directly, not through the TTY-gated cli.ts wiring).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, CatalogMeta, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import type { Env } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';

import { resolveAssistant } from '../src/assistant-select';
import { runCli } from '../src/cli';
import type { CliPrompts } from '../src/cli';
import { runCatalog } from '../src/cmd-catalog';
import type { CatalogProposal } from '../src/cmd-catalog';
import { runInit } from '../src/cmd-init';
import { loadConfigFile } from '../src/config';
import { resolveSecretOverrides } from '../src/secret-collect';
import { CancelledError } from '../src/ui';

// ---------------------------------------------------------------------------
// Shared fixture — isolated RIGGER_HOME + one configured catalog + a working
// (fake) remote fetch, reused by every install-flow scenario below.
// ---------------------------------------------------------------------------

const REMOTE_TAG = 'v1.0.0';
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:remote-demo',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

interface Iso {
  env: Env;
  /** Returns a fresh CommandRunner + a live call counter for that runner. */
  makeRunner: () => { runner: CommandRunner; callCount: () => number };
  makeTmpFactory: () => TmpDirFactory;
  cleanup: () => Promise<void>;
}

async function makeIso(): Promise<Iso> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-r2-home-'));
  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }] }),
    'utf8',
  );

  const env: Env = { RIGGER_HOME: homeDir };
  const tmpDirs: string[] = [];

  const makeRunner = (): { runner: CommandRunner; callCount: () => number } => {
    let count = 0;
    const runner: CommandRunner = (_cmd, args) => {
      count++;
      const argv = args ?? [];
      if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
        return Promise.resolve({
          exitCode: 0,
          stdout: `${SHA}\trefs/tags/${REMOTE_TAG}\n`,
          stderr: '',
        });
      }
      if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
        return Promise.resolve({ exitCode: 0, stdout: `${SHA}\tHEAD\n`, stderr: '' });
      }
      if (argv[0] === '-C' && argv[2] === 'rev-parse') {
        return Promise.resolve({ exitCode: 0, stdout: `${SHA}\n`, stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    };
    return { runner, callCount: () => count };
  };

  const makeTmpFactory = (): TmpDirFactory => async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-r2-checkout-'));
    tmpDirs.push(tmpDir);
    await fs.writeFile(
      path.join(tmpDir, 'catalog.json'),
      JSON.stringify({ meta: { name: 'r2-test-catalog' }, entries: [ENTRY] }),
      'utf8',
    );
    await fs.mkdir(path.join(tmpDir, 'common', 'skills', 'remote-demo'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'common', 'skills', 'remote-demo', 'SKILL.md'),
      `# Skill remote-demo\n${REMOTE_TAG} content.`,
      'utf8',
    );
    return {
      path: tmpDir,
      cleanup: async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
      },
    };
  };

  const cleanup = async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  };

  return { env, makeRunner, makeTmpFactory, cleanup };
}

/** Ambient probe fails (git ls-remote → non-zero) — forces preflightAuth to ask for a method. */
const ambientProbeFailsRunner: CommandRunner = (_cmd, args) => {
  const argv = args ?? [];
  if (argv[0] === 'ls-remote') {
    return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'auth required' });
  }
  return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
};

/** Ambient probe always succeeds — askMethod is never reached. */
const ambientProbeOkRunner: CommandRunner = () =>
  Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });

function makeCapture(): { lines: string[]; print: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

/**
 * Every required CliPrompts field stubbed to fail the test if invoked
 * unexpectedly — each scenario overrides only the prompt it exercises, so an
 * accidental extra prompt call surfaces immediately instead of silently
 * returning a default.
 */
function basePrompts(overrides: Partial<CliPrompts> = {}): CliPrompts {
  return {
    selectArtifacts: async () => {
      throw new Error('selectArtifacts should not be called in this scenario');
    },
    selectScope: async () => {
      throw new Error('selectScope should not be called in this scenario');
    },
    confirmApply: async () => {
      throw new Error('confirmApply should not be called in this scenario');
    },
    askUrl: async () => {
      throw new Error('askUrl should not be called in this scenario');
    },
    askMethod: async () => {
      throw new Error('askMethod should not be called in this scenario');
    },
    ...overrides,
  };
}

let iso: Iso;
beforeEach(async () => {
  iso = await makeIso();
});
afterEach(async () => {
  await iso.cleanup();
});

// ---------------------------------------------------------------------------

describe('lot5-R2: Ctrl+C sur selectScope', () => {
  it("exit 130, zéro appel réseau après le prompt, le picker status ne s'affiche pas", async () => {
    const { runner, callCount } = iso.makeRunner();
    let selectArtifactsByStatusCalled = false;
    let runCallsAtScope = -1;
    const cap = makeCapture();

    const exitCode = await runCli(['install'], {
      print: cap.print,
      env: iso.env,
      prompts: basePrompts({
        selectScope: async () => {
          // Snapshot the network call count at the moment the FIRST interactive
          // prompt of the install flow fires, then cancel — exactly the
          // previously-broken path (silent 'user' fallback continued into
          // computeArtifactStatuses' own resolveVersion calls + the picker).
          runCallsAtScope = callCount();
          throw new CancelledError();
        },
        selectArtifactsByStatus: async () => {
          selectArtifactsByStatusCalled = true;
          return [];
        },
      }),
      remote: { run: runner, tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    expect(exitCode).toBe(130);
    expect(selectArtifactsByStatusCalled).toBe(false);
    expect(runCallsAtScope).toBeGreaterThanOrEqual(0);
    // No additional network call after the scope prompt: computeArtifactStatuses
    // (resolveVersion per catalog) was never reached.
    expect(callCount()).toBe(runCallsAtScope);
  });
});

// ---------------------------------------------------------------------------

describe('lot5-R2: Ctrl+C sur askMethod (wizard init)', () => {
  it('exit 130, aucun authMethod persisté (config jamais écrite)', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-r2-init-'));
    const env: Env = { RIGGER_HOME: homeDir };
    const configPath = path.join(homeDir, '.config', 'agent-rigger', 'config.json');

    const cap = makeCapture();
    const exitCode = await runCli(['init'], {
      print: cap.print,
      env,
      remote: { run: ambientProbeFailsRunner },
      prompts: basePrompts({
        askUrl: async () => 'https://github.com/example/catalog.git',
        askMethod: async () => {
          throw new CancelledError();
        },
      }),
    });

    expect(exitCode).toBe(130);
    const exists = await fs.access(configPath).then(() => true, () => false);
    expect(exists).toBe(false);

    await fs.rm(homeDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------

describe('lot5-R2: Ctrl+C sur askUrl (wizard init)', () => {
  it('exit 130, preflightAuth jamais invoqué (zéro appel réseau), config jamais écrite', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-r2-init-'));
    const env: Env = { RIGGER_HOME: homeDir };
    const configPath = path.join(homeDir, '.config', 'agent-rigger', 'config.json');

    let runCallCount = 0;
    const runner: CommandRunner = (_cmd, _args) => {
      runCallCount++;
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    };

    const cap = makeCapture();
    const exitCode = await runCli(['init'], {
      print: cap.print,
      env,
      remote: { run: runner },
      prompts: basePrompts({
        askUrl: async () => {
          throw new CancelledError();
        },
      }),
    });

    expect(exitCode).toBe(130);
    expect(runCallCount).toBe(0);
    const exists = await fs.access(configPath).then(() => true, () => false);
    expect(exists).toBe(false);

    await fs.rm(homeDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------

describe('lot5-R2: Ctrl+C sur askAssistants (wizard init)', () => {
  it('exit 130, config.assistants (et tout le fichier config) reste inchangé', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-r2-init-'));
    const configDir = path.join(homeDir, '.config', 'agent-rigger');
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, 'config.json');
    const originalContent = JSON.stringify({
      defaultScope: 'user',
      catalogs: [{ name: 'principal', url: 'https://old.example.com/catalog.git' }],
      assistants: ['claude'],
    });
    await fs.writeFile(configPath, originalContent, 'utf8');

    const env: Env = { RIGGER_HOME: homeDir };

    const cap = makeCapture();
    const exitCode = await runCli(['init'], {
      print: cap.print,
      env,
      remote: { run: ambientProbeOkRunner },
      prompts: basePrompts({
        askUrl: async () => 'https://new.example.com/catalog.git',
        askAssistants: async () => {
          throw new CancelledError();
        },
      }),
    });

    expect(exitCode).toBe(130);
    const after = await fs.readFile(configPath, 'utf8');
    // persistConfig (Step 4) never runs — Step 3b's cancellation throws first.
    expect(after).toBe(originalContent);

    await fs.rm(homeDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------

describe("lot5-R2: Ctrl+C sur un multiselect d'artefacts (selectArtifacts)", () => {
  it('exit 130, sans le double message "No artifacts selected" (Previously)', async () => {
    const { runner } = iso.makeRunner();
    const cap = makeCapture();

    const exitCode = await runCli(['install'], {
      print: cap.print,
      env: iso.env,
      prompts: basePrompts({
        selectArtifacts: async () => {
          throw new CancelledError();
        },
      }),
      remote: { run: runner, tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    expect(exitCode).toBe(130);
    expect(cap.lines.some((l) => l.includes('No artifacts selected'))).toBe(false);
  });

  it('soumettre une sélection vide (sans Ctrl+C) reste un abandon volontaire — exit 0', async () => {
    const { runner } = iso.makeRunner();
    const cap = makeCapture();

    const exitCode = await runCli(['install'], {
      print: cap.print,
      env: iso.env,
      prompts: basePrompts({
        selectArtifacts: async () => [],
      }),
      remote: { run: runner, tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    expect(exitCode).toBe(0);
    expect(cap.lines.some((l) => l.includes('No artifacts selected'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Same scenario, status-aware picker variant (the other named function:
// selectArtifactsByStatus) — proves the cancellation propagates identically
// through the grouped install/update picker, not just the flat legacy one.
// ---------------------------------------------------------------------------

describe("lot5-R2: Ctrl+C sur un multiselect d'artefacts (selectArtifactsByStatus)", () => {
  it('exit 130, sans le double message "No artifacts selected"', async () => {
    const { runner } = iso.makeRunner();
    const cap = makeCapture();

    const exitCode = await runCli(['install'], {
      print: cap.print,
      env: iso.env,
      prompts: basePrompts({
        selectScope: async () => 'user',
        selectArtifactsByStatus: async () => {
          throw new CancelledError();
        },
      }),
      remote: { run: runner, tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    expect(exitCode).toBe(130);
    expect(cap.lines.some((l) => l.includes('No artifacts selected'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('lot5-R2: répondre "no" à confirmApply reste un abandon volontaire', () => {
  it("exit 0 inchangé (refuser n'est pas interrompre)", async () => {
    const { runner } = iso.makeRunner();
    const cap = makeCapture();

    const exitCode = await runCli(['install', 'principal/skill:remote-demo'], {
      print: cap.print,
      env: iso.env,
      prompts: basePrompts({
        confirmApply: async () => false,
      }),
      remote: { run: runner, tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
    });

    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('lot5-R2: les throw-on-cancel existants migrent vers CancelledError', () => {
  it("assistant-select et secret-collect propagent CancelledError sans l'altérer", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-r2-assistant-'));
    const env: Env = { RIGGER_HOME: tmp };

    // resolveAssistant: an injected picker throwing CancelledError (the same
    // class the real defaultPicker now throws on isCancel, R2) must surface
    // unchanged — no re-wrap into a generic Error, no swallow.
    await expect(
      resolveAssistant({
        env,
        isTTY: true,
        picker: async () => {
          throw new CancelledError('Assistant selection cancelled.');
        },
      }),
    ).rejects.toBeInstanceOf(CancelledError);

    // resolveSecretOverrides: same contract, mirrored (secret-collect.ts).
    await expect(
      resolveSecretOverrides({
        secrets: [{ ref: 'GITHUB_TOKEN', prompt: 'GitHub token' }],
        overrides: {},
        isTTY: true,
        picker: async () => {
          throw new CancelledError('Secret "GITHUB_TOKEN" prompt cancelled.');
        },
      }),
    ).rejects.toBeInstanceOf(CancelledError);

    await fs.rm(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Post-review fix: the post-init/post-catalog-add proposeInstall call sits
// inside a PRE-EXISTING non-fatal try/catch meant for fetch failures
// (cmd-init.ts step 6, cmd-catalog.ts step M7/R9). A CancelledError thrown by
// the picker (selectArtifactsWithDefaults) must NOT be swallowed by that
// catch — it has to propagate so handleError (cli.ts) maps it to exit 130,
// not be turned into the misleading "Catalog fetch failed" hint + a false
// ok:true/exit-0.
// ---------------------------------------------------------------------------

const R2_META: CatalogMeta = { name: 'r2-catalog', required: [], recommended: [] };
const R2_ENTRIES: CatalogEntry[] = [
  {
    kind: 'artifact',
    id: 'r2-catalog/skill:demo',
    nature: 'skill',
    targets: ['claude'],
    scopes: ['user'],
  },
];

describe('lot5-R2: Ctrl+C sur le multiselect post-init (proposeInstall de `init`)', () => {
  it('CancelledError traverse runInit sans être avalée par le catch non-fatal (pas de "Catalog fetch failed")', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-r2-init-propose-'));
    const configPath = path.join(tmp, 'rigger.jsonc');

    const runInitPromise = runInit({
      configPath,
      askUrl: async () => 'https://example.com/catalog.git',
      askMethod: () => {
        throw new Error('askMethod should not be called — ambient probe succeeds');
      },
      run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      fetchCatalogFn: async (
        _url: string,
      ): Promise<CatalogProposal> => ({
        meta: R2_META,
        entries: R2_ENTRIES,
        sourceName: 'principal',
      }),
      proposeInstall: async () => {
        throw new CancelledError();
      },
    });

    await expect(runInitPromise).rejects.toBeInstanceOf(CancelledError);

    // Config IS persisted (Step 4 runs before the Step 6 proposal) — cancelling
    // the post-init picker does not roll back the already-saved catalog.
    const saved = await loadConfigFile(configPath);
    expect(saved.catalogs?.[0]?.url).toBe('https://example.com/catalog.git');

    await fs.rm(tmp, { recursive: true, force: true });
  });
});

describe('lot5-R2: Ctrl+C sur le multiselect post-catalog-add (proposeInstall de `catalog add`)', () => {
  it('CancelledError traverse runCatalog sans être avalée par le catch non-fatal (pas de "Catalog fetch failed")', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-r2-catalog-propose-'));
    const configPath = path.join(tmp, 'config.json');
    const cap = makeCapture();

    const runCatalogPromise = runCatalog({
      verb: 'add',
      args: ['secondary', 'https://example.com/secondary.git'],
      configPath,
      print: cap.print,
      fetchCatalogFn: async (
        _url: string,
        _name: string,
      ): Promise<CatalogProposal> => ({
        meta: R2_META,
        entries: R2_ENTRIES,
        sourceName: 'secondary',
      }),
      proposeInstall: async () => {
        throw new CancelledError();
      },
    });

    await expect(runCatalogPromise).rejects.toBeInstanceOf(CancelledError);
    expect(cap.lines.join('\n')).not.toContain('Catalog fetch failed');

    // Config IS persisted (persistConfig runs before the post-add proposal).
    const saved = await loadConfigFile(configPath);
    expect(saved.catalogs?.some((c) => c.name === 'secondary')).toBe(true);

    await fs.rm(tmp, { recursive: true, force: true });
  });
});
