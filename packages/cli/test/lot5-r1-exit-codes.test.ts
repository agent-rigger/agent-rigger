/**
 * lot5-r1-exit-codes.test.ts — R1: a three-level exit code contract (0/2/1,
 * 130 is R2's), identical for a given condition across every command
 * (lot5-ux-dx, ADR-0024).
 *
 * One test per scenario in requirements.md (R1), named `lot5-R1: …` (stock
 * §8 traceability convention). The install-without-catalog scenarios were
 * previously locked at exit 0 by ~6 tests in cli.test.ts (a false success —
 * see that file's inline "Inverted (lot5-R1…)" comments for the regression
 * pin); this file is the scenario-level coverage, cli.test.ts keeps the
 * regression guard.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import type { Env } from '@agent-rigger/core/paths';
import { resolveUserTargets } from '@agent-rigger/core/paths';

import { runCli } from '../src/cli';
import type { CliPrompts } from '../src/cli';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCapture(): { lines: string[]; print: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

async function makeTmpHome(prefix = 'rigger-lot5-r1-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    dir,
    env: { RIGGER_HOME: dir },
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

async function writeConfig(
  dir: string,
  catalogs: Array<{ name: string; url: string }>,
): Promise<void> {
  const configDir = path.join(dir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });
  await Bun.write(path.join(configDir, 'config.json'), JSON.stringify({ catalogs }));
}

/** Minimal CliPrompts — every field required by the type, most unused here. */
function fakePrompts(overrides: Partial<CliPrompts> = {}): CliPrompts {
  return {
    selectArtifacts: async () => [],
    selectScope: async () => 'user',
    confirmApply: async () => true,
    askUrl: async () => 'https://example.com/catalog.git',
    askMethod: async () => 'https',
    ...overrides,
  };
}

/** A CommandRunner where every git invocation fails (offline, R1). */
const alwaysFailRunner: CommandRunner = (_cmd, _args) =>
  Promise.resolve({ exitCode: 1, stdout: '', stderr: 'connection refused' });

const FAKE_SHA = 'aabbccddeeff00112233445566778899aabbccdd';

/**
 * A CommandRunner that fails every git invocation whose args mention
 * `failingUrl` and succeeds (fake tag v1.0.0 → clone → rev-parse) for every
 * other url — models "one source down, one source up" (per-source
 * degradation, unchanged by R1).
 */
function makeMixedRunner(failingUrl: string): CommandRunner {
  return (_cmd, args) => {
    const argsArr = args ?? [];
    if (argsArr.includes(failingUrl)) {
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'connection refused' });
    }
    if (argsArr.includes('ls-remote') && argsArr.includes('--tags')) {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${FAKE_SHA}\trefs/tags/v1.0.0\n`,
        stderr: '',
      });
    }
    if (argsArr.includes('clone')) {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argsArr.includes('rev-parse')) {
      return Promise.resolve({ exitCode: 0, stdout: `${FAKE_SHA}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };
}

/** Fake TmpDirFactory writing a single skill entry's catalog.json into `dir`. */
function makeTmpFactory(dir: string, entries: CatalogEntry[]): TmpDirFactory {
  return async () => {
    await Bun.write(
      path.join(dir, 'catalog.json'),
      JSON.stringify({ meta: { name: 'lot5-r1-catalog' }, entries }),
    );
    return { path: dir, cleanup: async () => {} };
  };
}

const SKILL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:foo',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user'],
};

// ---------------------------------------------------------------------------
// Scenario: install explicite sans catalogue configuré
// ---------------------------------------------------------------------------

describe('lot5-R1: install explicite sans catalogue configuré', () => {
  let tmp: { dir: string; env: Env; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it("exit 2, message [error] + hint init, rien n'est écrit", async () => {
    const cap = makeCapture();
    const code = await runCli(['install', 'jr/skill:foo', '--yes'], {
      print: cap.print,
      env: tmp.env,
    });

    expect(code).toBe(2);
    const out = cap.lines.join('\n');
    expect(out).toContain('[error]');
    expect(out).toMatch(/agent-rigger init/);

    const manifestPath = resolveUserTargets(tmp.env).stateJson;
    const manifestExists = await fs.stat(manifestPath).then(() => true).catch(() => false);
    expect(manifestExists).toBe(false);

    const configPath = path.join(tmp.dir, '.config', 'agent-rigger', 'config.json');
    const configExists = await fs.stat(configPath).then(() => true).catch(() => false);
    expect(configExists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario: install interactif sans catalogue configuré
// ---------------------------------------------------------------------------

describe('lot5-R1: install interactif sans catalogue configuré', () => {
  let tmp: { dir: string; env: Env; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('exit 2, avec le même message que le chemin explicite', async () => {
    const explicitCap = makeCapture();
    const explicitCode = await runCli(['install', 'jr/skill:foo', '--yes'], {
      print: explicitCap.print,
      env: tmp.env,
    });

    const interactiveCap = makeCapture();
    const interactiveCode = await runCli(['install'], {
      print: interactiveCap.print,
      env: tmp.env,
      prompts: fakePrompts(),
    });

    expect(interactiveCode).toBe(2);
    expect(interactiveCode).toBe(explicitCode);
    expect(interactiveCap.lines.join('\n')).toBe(explicitCap.lines.join('\n'));
  });
});

// ---------------------------------------------------------------------------
// Scenario: resource add hérite du contrat
// ---------------------------------------------------------------------------

describe('lot5-R1: resource add hérite du contrat', () => {
  let tmp: { dir: string; env: Env; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('skills add sans catalogue → exit 2 (délègue à handleInstall)', async () => {
    const cap = makeCapture();
    const code = await runCli(['skills', 'add', 'jr/skill:foo'], {
      print: cap.print,
      env: tmp.env,
    });
    expect(code).toBe(2);
    expect(cap.lines.join('\n')).toContain('[error]');
  });
});

// ---------------------------------------------------------------------------
// Scenario: commandes de lecture — dégradation légitime inchangée
// ---------------------------------------------------------------------------

describe('lot5-R1: commandes de lecture sans catalogue — dégradation légitime inchangée', () => {
  let tmp: { dir: string; env: Env; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it("ls, check et catalog ls exit 0 avec message informatif — lire un état vide n'est pas un échec", async () => {
    for (const argv of [['ls'], ['check'], ['catalog', 'ls']]) {
      const cap = makeCapture();
      const code = await runCli(argv, { print: cap.print, env: tmp.env });
      expect(code).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario: offline, catalogue configuré injoignable — requête explicite
// ---------------------------------------------------------------------------

describe('lot5-R1: offline, catalogue configuré injoignable — requête explicite', () => {
  let tmp: { dir: string; env: Env; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome();
    await writeConfig(tmp.dir, [{ name: 'jr', url: 'https://example.com/jr-catalog.git' }]);
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it("install jr/skill:foo --yes → exit 1, message identifie l'échec réseau et la source", async () => {
    const cap = makeCapture();
    const code = await runCli(['install', 'jr/skill:foo', '--yes'], {
      print: cap.print,
      env: tmp.env,
      remote: { run: alwaysFailRunner },
    });

    expect(code).toBe(1);
    const out = cap.lines.join('\n');
    expect(out).toContain('[error]');
    expect(out).toContain('https://example.com/jr-catalog.git');
    expect(out.toLowerCase()).toMatch(/fetch failed|connection refused/);
  });

  it('update jr/skill:foo --yes → exit 1, même contrat que install', async () => {
    const cap = makeCapture();
    const code = await runCli(['update', 'jr/skill:foo', '--yes'], {
      print: cap.print,
      env: tmp.env,
      remote: { run: alwaysFailRunner },
    });

    expect(code).toBe(1);
    const out = cap.lines.join('\n');
    expect(out).toContain('[error]');
    expect(out).toContain('https://example.com/jr-catalog.git');
  });
});

// ---------------------------------------------------------------------------
// Scenario: offline — install interactif sans catalogue joignable
// ---------------------------------------------------------------------------

describe('lot5-R1: offline — install interactif sans catalogue joignable', () => {
  let tmp: { dir: string; env: Env; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('toutes les sources échouent → exit 1, même intention/code que le chemin explicite', async () => {
    await writeConfig(tmp.dir, [{ name: 'jr', url: 'https://example.com/jr-catalog.git' }]);

    const cap = makeCapture();
    const code = await runCli(['install'], {
      print: cap.print,
      env: tmp.env,
      prompts: fakePrompts(),
      remote: { run: alwaysFailRunner },
    });

    expect(code).toBe(1);
  });

  it("AND si au moins une source répond, l'install continue sur le catalogue partiel (dégradation par source inchangée)", async () => {
    const goodUrl = 'https://good.example.com/catalog.git';
    const badUrl = 'https://bad.example.com/catalog.git';
    await writeConfig(tmp.dir, [
      { name: 'good', url: goodUrl },
      { name: 'bad', url: badUrl },
    ]);

    const catalogDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-lot5-r1-mixed-'));
    try {
      let selectArtifactsCalledWith: CatalogEntry[] | undefined;
      const cap = makeCapture();
      const code = await runCli(['install'], {
        print: cap.print,
        env: tmp.env,
        prompts: fakePrompts({
          selectArtifacts: async (entries) => {
            selectArtifactsCalledWith = entries;
            return [];
          },
        }),
        remote: {
          run: makeMixedRunner(badUrl),
          tmpFactory: makeTmpFactory(catalogDir, [SKILL_ENTRY]),
        },
      });

      // Reached the picker with the surviving source's entries (not an early
      // exit 1) — proves the interactive path did NOT treat partial failure
      // as "offline". Selecting nothing is a voluntary abort → exit 0 (R1/R2).
      expect(code).toBe(0);
      expect(selectArtifactsCalledWith).toBeDefined();
      expect(selectArtifactsCalledWith?.map((e) => e.id)).toContain('good/skill:foo');

      const out = cap.lines.join('\n');
      expect(out).toContain('bad');
      expect(out.toLowerCase()).toContain('unavailable');
    } finally {
      await fs.rm(catalogDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario: id inconnu et préfixe non configuré — uniformité conservée
// ---------------------------------------------------------------------------

describe('lot5-R1: id inconnu et préfixe non configuré — uniformité conservée', () => {
  let tmp: { dir: string; env: Env; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome();
    await writeConfig(tmp.dir, [{ name: 'jr', url: 'https://example.com/jr-catalog.git' }]);
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('préfixe non configuré → exit 2 sur install, update et remove', async () => {
    for (
      const argv of [
        ['install', 'unknown-prefix/skill:foo', '--yes'],
        ['update', 'unknown-prefix/skill:foo', '--yes'],
        ['remove', 'unknown-prefix/skill:foo', '--yes'],
      ]
    ) {
      const cap = makeCapture();
      const code = await runCli(argv, { print: cap.print, env: tmp.env });
      expect(code).toBe(2);
    }
  });

  it('id inconnu → exit 2 sur info (catalogue configuré, id absent du catalogue)', async () => {
    const catalogDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-lot5-r1-info-'));
    try {
      const cap = makeCapture();
      const code = await runCli(['guardrails', 'info', 'jr/does-not-exist'], {
        print: cap.print,
        env: tmp.env,
        remote: {
          run: makeMixedRunner('__never_fails__'),
          tmpFactory: makeTmpFactory(catalogDir, [SKILL_ENTRY]),
        },
      });
      expect(code).toBe(2);
    } finally {
      await fs.rm(catalogDir, { recursive: true, force: true });
    }
  });

  it('id non qualifié (pas de "/") → exit 2 sur install', async () => {
    const cap = makeCapture();
    const code = await runCli(['install', 'skill:foo', '--yes'], {
      print: cap.print,
      env: tmp.env,
    });
    expect(code).toBe(2);
    expect(cap.lines.join('\n')).toMatch(/unqualified/);
  });
});
