/**
 * Tests for `init --yes` auto-install of defaults (TTY or non-TTY).
 *
 * Requirement: `init --yes` shall install required + recommended entries automatically
 * (no picker), regardless of whether the terminal is a TTY.
 * `--yes` takes priority over the interactive TTY picker branch.
 *
 * Strategy:
 * - RIGGER_HOME isolated via tmp dir.
 * - deps.remote injected: fake runner + tmpFactory with pre-populated catalog.json.
 * - NO deps.prompts.proposeInstall injection → exercises the real --yes gate in runCli.
 * - deps.prompts.askUrl + askMethod injected to bypass TTY prompts.
 * - D5 temporarily sets process.stdout.isTTY = true to confirm --yes still fires before
 *   the interactive picker branch.
 *
 * Scenarios:
 * D1  init --yes non-TTY → catalog configured AND required+recommended installed.
 * D2  init --yes non-TTY, no recommended → only required installed.
 * D3  init (no --yes) non-TTY → configured only, no install.
 * D4  init --yes, catalog.meta empty → config saved, no install, no crash.
 * D5  init --yes with isTTY=true → defaults installed (--yes primes over picker).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';

import { runCli } from '../src/cli';
import type { CliDeps } from '../src/cli';
import { loadConfigFile } from '../src/config';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TAG_NAME = 'v1.0.0';
const SHA = 'cafebabecafebabecafebabecafebabecafebabe';
const CATALOG_URL = 'https://example.com/catalog.git';

// ---------------------------------------------------------------------------
// Catalog fixtures
// ---------------------------------------------------------------------------

/** A skill entry that is "required" in the catalog meta. */
const REQUIRED_SKILL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:required-skill',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user'],
};

/** A skill entry that is "recommended" in the catalog meta. */
const RECOMMENDED_SKILL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:recommended-skill',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user'],
};

/** A skill entry that is neither required nor recommended. */
const OPTIONAL_SKILL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:optional-skill',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user'],
};

// ---------------------------------------------------------------------------
// makeInitEnv — isolated HOME + pre-populated catalog checkout
// ---------------------------------------------------------------------------

interface MakeInitEnvOpts {
  /** catalog.json meta to write in the checkout. */
  meta: {
    name?: string;
    required?: string[];
    recommended?: string[];
  };
  /** CatalogEntry[] to write in the checkout. */
  entries: CatalogEntry[];
}

async function makeInitEnv(opts: MakeInitEnvOpts): Promise<{
  env: Env;
  homeDir: string;
  configDir: string;
  contentDir: string;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  cleanupAll: () => Promise<void>;
}> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-init-yes-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-init-yes-content-'));

  // Catalog checkout: catalog.json + skill fixture files.
  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({
      meta: { name: opts.meta.name ?? 'test-catalog', ...opts.meta },
      entries: opts.entries,
    }),
    'utf8',
  );

  // Write SKILL.md files for each skill entry so the install can place them.
  for (const entry of opts.entries) {
    if (entry.kind === 'artifact' && entry.nature === 'skill') {
      const name = entry.id.replace(/^skill:/, '');
      await fs.mkdir(path.join(contentDir, 'skills', name), { recursive: true });
      await fs.writeFile(
        path.join(contentDir, 'skills', name, 'SKILL.md'),
        `# ${name}\nFixture skill for tests.`,
        'utf8',
      );
    }
  }

  const env: Env = { RIGGER_HOME: homeDir };

  // Fake runner: handles git ls-remote, clone, rev-parse, and preflight auth.
  const runner: CommandRunner = (_cmd, args) => {
    const argv = args ?? [];

    // git ls-remote --tags → one tag
    if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${SHA}\trefs/tags/${TAG_NAME}\n`,
        stderr: '',
      });
    }

    // git ls-remote HEAD → sha
    if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${SHA}\tHEAD\n`,
        stderr: '',
      });
    }

    // git clone → no-op (content already in contentDir)
    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }

    // git -C <dir> rev-parse HEAD → fixed sha
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\n`, stderr: '' });
    }

    // preflight-auth ambient probe (ls-remote <url> HEAD) → already handled above.
    // Default: success
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };

  const tmpFactory: TmpDirFactory = async () => ({
    path: contentDir,
    cleanup: async () => {},
  });

  const cleanupAll = async () => {
    await Promise.all([
      fs.rm(homeDir, { recursive: true, force: true }),
      fs.rm(contentDir, { recursive: true, force: true }),
    ]);
  };

  const configDir = path.join(homeDir, '.config', 'agent-rigger');

  return { env, homeDir, configDir, contentDir, runner, tmpFactory, cleanupAll };
}

/** Builds the CliDeps for an init test (no proposeInstall, injects runner+factory). */
function makeInitDeps(
  fix: Awaited<ReturnType<typeof makeInitEnv>>,
  extra?: Partial<CliDeps>,
): CliDeps {
  return {
    env: fix.env,
    print: () => {},
    remote: {
      run: fix.runner,
      tmpFactory: fix.tmpFactory,
      scanner: stubScanner,
    },
    prompts: {
      selectArtifacts: async () => [],
      selectScope: async () => 'user',
      confirmApply: async () => true,
      askUrl: async () => CATALOG_URL,
      askMethod: async () => 'https',
      // proposeInstall deliberately absent → tests the real --yes gate
    },
    ...extra,
  };
}

async function readManifest(env: Env): Promise<{ artifacts: Array<{ id: string }> }> {
  const targets = resolveUserTargets(env);
  const { readManifest: coreReadManifest } = await import('@agent-rigger/core/manifest');
  return coreReadManifest(targets.stateJson);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let fix: Awaited<ReturnType<typeof makeInitEnv>>;

afterEach(async () => {
  await fix.cleanupAll();
});

// ---------------------------------------------------------------------------
// D1 — init --yes non-TTY → catalog configured AND required+recommended installed
// ---------------------------------------------------------------------------

describe('D1 — init --yes non-TTY: required + recommended installed', () => {
  beforeEach(async () => {
    fix = await makeInitEnv({
      meta: {
        required: ['skill:required-skill'],
        recommended: ['skill:recommended-skill'],
      },
      entries: [REQUIRED_SKILL_ENTRY, RECOMMENDED_SKILL_ENTRY, OPTIONAL_SKILL_ENTRY],
    });
  });

  it('returns exit code 0', async () => {
    const code = await runCli(['init', '--yes'], makeInitDeps(fix));
    expect(code).toBe(0);
  });

  it('persists the catalog url in config', async () => {
    await runCli(['init', '--yes'], makeInitDeps(fix));

    const configPath = path.join(fix.configDir, 'config.json');
    const config = await loadConfigFile(configPath);
    expect(config.catalogs?.[0]?.url).toBe(CATALOG_URL);
    expect(config.catalogs?.[0]?.name).toBe('principal');
  });

  it('installs required entry in manifest (qualified id)', async () => {
    await runCli(['init', '--yes'], makeInitDeps(fix));

    const manifest = await readManifest(fix.env);
    const ids = manifest.artifacts.map((a) => a.id);
    expect(ids.some((id) => id.includes('required-skill'))).toBe(true);
  });

  it('installs recommended entry in manifest (qualified id)', async () => {
    await runCli(['init', '--yes'], makeInitDeps(fix));

    const manifest = await readManifest(fix.env);
    const ids = manifest.artifacts.map((a) => a.id);
    expect(ids.some((id) => id.includes('recommended-skill'))).toBe(true);
  });

  it('does NOT install optional (non-required, non-recommended) entry', async () => {
    await runCli(['init', '--yes'], makeInitDeps(fix));

    const manifest = await readManifest(fix.env);
    const ids = manifest.artifacts.map((a) => a.id);
    expect(ids.some((id) => id.includes('optional-skill'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D2 — init --yes non-TTY, catalog has no recommended → only required installed
// ---------------------------------------------------------------------------

describe('D2 — init --yes non-TTY: no recommended → only required installed', () => {
  beforeEach(async () => {
    fix = await makeInitEnv({
      meta: {
        required: ['skill:required-skill'],
        // recommended deliberately absent
      },
      entries: [REQUIRED_SKILL_ENTRY, OPTIONAL_SKILL_ENTRY],
    });
  });

  it('returns exit code 0', async () => {
    const code = await runCli(['init', '--yes'], makeInitDeps(fix));
    expect(code).toBe(0);
  });

  it('installs required entry', async () => {
    await runCli(['init', '--yes'], makeInitDeps(fix));

    const manifest = await readManifest(fix.env);
    const ids = manifest.artifacts.map((a) => a.id);
    expect(ids.some((id) => id.includes('required-skill'))).toBe(true);
  });

  it('does NOT install optional entry', async () => {
    await runCli(['init', '--yes'], makeInitDeps(fix));

    const manifest = await readManifest(fix.env);
    const ids = manifest.artifacts.map((a) => a.id);
    expect(ids.some((id) => id.includes('optional-skill'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D3 — init (no --yes) non-TTY → configured only, manifest NOT written
// ---------------------------------------------------------------------------

describe('D3 — init without --yes non-TTY: config only, no install', () => {
  beforeEach(async () => {
    fix = await makeInitEnv({
      meta: {
        required: ['skill:required-skill'],
        recommended: ['skill:recommended-skill'],
      },
      entries: [REQUIRED_SKILL_ENTRY, RECOMMENDED_SKILL_ENTRY, OPTIONAL_SKILL_ENTRY],
    });
  });

  it('returns exit code 0', async () => {
    const code = await runCli(['init'], makeInitDeps(fix));
    expect(code).toBe(0);
  });

  it('persists config (catalog url)', async () => {
    await runCli(['init'], makeInitDeps(fix));

    const configPath = path.join(fix.configDir, 'config.json');
    const config = await loadConfigFile(configPath);
    expect(config.catalogs?.[0]?.url).toBe(CATALOG_URL);
  });

  it('does NOT install any entries (no manifest artifacts)', async () => {
    await runCli(['init'], makeInitDeps(fix));

    const manifest = await readManifest(fix.env);
    expect(manifest.artifacts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// D4 — init --yes, catalog meta has no required/recommended → config saved, no crash
// ---------------------------------------------------------------------------

describe('D4 — init --yes: empty meta → config saved, no install, no crash', () => {
  beforeEach(async () => {
    fix = await makeInitEnv({
      meta: {
        required: [],
        recommended: [],
      },
      entries: [OPTIONAL_SKILL_ENTRY],
    });
  });

  it('returns exit code 0', async () => {
    const code = await runCli(['init', '--yes'], makeInitDeps(fix));
    expect(code).toBe(0);
  });

  it('persists config', async () => {
    await runCli(['init', '--yes'], makeInitDeps(fix));

    const configPath = path.join(fix.configDir, 'config.json');
    const config = await loadConfigFile(configPath);
    expect(config.catalogs?.[0]?.url).toBe(CATALOG_URL);
  });

  it('does NOT crash when defaults selection is empty', async () => {
    // No required, no recommended → defaults install is a no-op, no manifest needed.
    const code = await runCli(['init', '--yes'], makeInitDeps(fix));
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// D5 — init --yes with isTTY=true: --yes primes over interactive picker
// ---------------------------------------------------------------------------

describe('D5 — init --yes with isTTY=true: defaults installed, picker NOT invoked', () => {
  const originalIsTTY = process.stdout.isTTY;

  beforeEach(async () => {
    fix = await makeInitEnv({
      meta: {
        required: ['skill:required-skill'],
        recommended: ['skill:recommended-skill'],
      },
      entries: [REQUIRED_SKILL_ENTRY, RECOMMENDED_SKILL_ENTRY, OPTIONAL_SKILL_ENTRY],
    });
    // Temporarily simulate a TTY so the isTTY branch would normally fire.
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
  });

  it('returns exit code 0 even with isTTY=true', async () => {
    // --yes branch fires before isTTY branch → no real picker invoked → no TTY hang.
    const code = await runCli(['init', '--yes'], makeInitDeps(fix));
    expect(code).toBe(0);
  });

  it('installs required entry when isTTY=true and --yes present', async () => {
    await runCli(['init', '--yes'], makeInitDeps(fix));

    const manifest = await readManifest(fix.env);
    const ids = manifest.artifacts.map((a) => a.id);
    expect(ids.some((id) => id.includes('required-skill'))).toBe(true);
  });

  it('installs recommended entry when isTTY=true and --yes present', async () => {
    await runCli(['init', '--yes'], makeInitDeps(fix));

    const manifest = await readManifest(fix.env);
    const ids = manifest.artifacts.map((a) => a.id);
    expect(ids.some((id) => id.includes('recommended-skill'))).toBe(true);
  });

  it('does NOT install optional entry when isTTY=true and --yes present', async () => {
    await runCli(['init', '--yes'], makeInitDeps(fix));

    const manifest = await readManifest(fix.env);
    const ids = manifest.artifacts.map((a) => a.id);
    expect(ids.some((id) => id.includes('optional-skill'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D6 — recommended absent from entries → skipped (no error)
// ---------------------------------------------------------------------------

describe('D6 — init --yes: recommended absent from entries is skipped silently', () => {
  beforeEach(async () => {
    // meta.recommended references 'skill:ghost' which is NOT in entries.
    // meta.required references 'skill:required-skill' which IS in entries.
    fix = await makeInitEnv({
      meta: {
        required: ['skill:required-skill'],
        recommended: ['skill:ghost'],
      },
      entries: [REQUIRED_SKILL_ENTRY], // 'skill:ghost' intentionally absent
    });
  });

  it('returns exit code 0 (no error for absent recommended)', async () => {
    const code = await runCli(['init', '--yes'], makeInitDeps(fix));
    expect(code).toBe(0);
  });

  it('config is saved despite absent recommended', async () => {
    await runCli(['init', '--yes'], makeInitDeps(fix));

    const configPath = path.join(fix.configDir, 'config.json');
    const config = await loadConfigFile(configPath);
    expect(config.catalogs?.[0]?.url).toBe(CATALOG_URL);
  });

  it('installs the required entry that IS in entries', async () => {
    await runCli(['init', '--yes'], makeInitDeps(fix));

    const manifest = await readManifest(fix.env);
    const ids = manifest.artifacts.map((a) => a.id);
    expect(ids.some((id) => id.includes('required-skill'))).toBe(true);
  });

  it('does NOT install the absent recommended entry', async () => {
    await runCli(['init', '--yes'], makeInitDeps(fix));

    const manifest = await readManifest(fix.env);
    const ids = manifest.artifacts.map((a) => a.id);
    expect(ids.some((id) => id.includes('ghost'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D7 — required absent from entries → install fails non-fatally (fail-closed)
// ---------------------------------------------------------------------------

describe('D7 — init --yes: required absent from entries → install errors non-fatally', () => {
  beforeEach(async () => {
    // meta.required references 'skill:ghost' which is NOT in entries.
    // runRemoteInstall will throw UnknownEntryError; runInit catches it non-fatally
    // (config is already saved), so init exits 0 with an actionable hint.
    fix = await makeInitEnv({
      meta: {
        required: ['skill:ghost'],
        recommended: [],
      },
      entries: [OPTIONAL_SKILL_ENTRY], // 'skill:ghost' intentionally absent
    });
  });

  it('returns exit code 0 (init itself succeeds; install error is non-fatal)', async () => {
    // runInit wraps proposeInstall in a try/catch — install failure → config saved +
    // actionable message, no crash. Same behavior as the interactive path.
    const code = await runCli(['init', '--yes'], makeInitDeps(fix));
    expect(code).toBe(0);
  });

  it('config is saved despite the install error', async () => {
    await runCli(['init', '--yes'], makeInitDeps(fix));

    const configPath = path.join(fix.configDir, 'config.json');
    const config = await loadConfigFile(configPath);
    expect(config.catalogs?.[0]?.url).toBe(CATALOG_URL);
  });

  it('ghost id is NOT in the manifest (install was blocked)', async () => {
    await runCli(['init', '--yes'], makeInitDeps(fix));

    const manifest = await readManifest(fix.env);
    const ids = manifest.artifacts.map((a) => a.id);
    expect(ids.some((id) => id.includes('ghost'))).toBe(false);
  });
});
