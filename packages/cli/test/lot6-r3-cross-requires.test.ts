/**
 * lot6-r3-cross-requires.test.ts — R3: a cross-catalogue require is
 * manifest-satisfied or fails actionable (design D3), end-to-end through the
 * CLI (install/update wiring in remote-install.ts / cmd-update.ts).
 *
 * TDD: written before the R3 pre-pass (`partitionForeignRequires`,
 * `ForeignRequireUnsatisfiedError`) was wired into `runRemoteInstall` /
 * `runUpdate` (RED → GREEN).
 *
 * Strategy (mirrors e2e-remote-install.test.ts / lot6-r1-provenance.test.ts):
 * - HOME isolated via a tmp dir (RIGGER_HOME override).
 * - Only ONE catalog ("principal") is ever configured — proves the foreign
 *   require is resolved purely against the MANIFEST, never by fetching the
 *   other catalogue (there is nothing configured to fetch it from).
 * - No real git/network calls — runner is a deterministic fake.
 *
 * Scenarios (deep-map FM1-FM4 + local chain):
 *  - FM1: foreign require absent → exit 2, message names the requirer, the
 *    chain, and the exact remediation command; zero files written.
 *  - Satisfied (same scope + assistant, pre-seeded in the manifest) → install
 *    succeeds without any extra fetch.
 *  - NOT satisfied when the manifest entry is a different scope.
 *  - NOT satisfied when the manifest entry is a different assistant.
 *  - FM4: update poison-pill — a release adding an unsatisfied foreign
 *    require fails actionable; the manifest entry is untouched (nothing
 *    removed); a SEPARATE runUpdate call for a different source (same
 *    manifestPath) is unaffected.
 *  - Local chain: `skill:a requires skill:typo` → message names `skill:a`
 *    (UnknownEntryError.requiredBy, no cross-catalogue involved).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type CatalogEntry, type TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { emptyManifest, writeManifest } from '@agent-rigger/core/manifest';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';
import type { ManifestEntry } from '@agent-rigger/core/types';

import { runCli } from '../src/cli';
import { runUpdate } from '../src/cmd-update';
import { ForeignRequireUnsatisfiedError } from '../src/remote-install';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TAG_NAME = 'v1.0.0';
const SHA = 'c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff';

/** skill:bar requires an artifact from a DIFFERENT catalogue ('othercat'). */
const SKILL_BAR_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:bar',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user', 'project'],
  requires: ['othercat/skill:foo'],
};

/** skill:a requires a LOCAL id that doesn't exist ('skill:typo') — no catalogue involved. */
const SKILL_A_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:a',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user', 'project'],
  requires: ['skill:typo'],
};

const PRINCIPAL_CATALOG_ENTRIES: CatalogEntry[] = [SKILL_BAR_ENTRY, SKILL_A_ENTRY];

// ---------------------------------------------------------------------------
// makePrincipalEnv — isolated HOME + single "principal" catalog checkout
// ---------------------------------------------------------------------------

async function makePrincipalEnv(): Promise<{
  env: Env;
  homeDir: string;
  contentDir: string;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  cleanupAll: () => Promise<void>;
}> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-lot6-r3-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-lot6-r3-content-'));

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 'lot6-r3-catalog' }, entries: PRINCIPAL_CATALOG_ENTRIES }),
    'utf8',
  );

  for (const name of ['bar', 'a']) {
    await fs.mkdir(path.join(contentDir, 'skills', name), { recursive: true });
    await fs.writeFile(
      path.join(contentDir, 'skills', name, 'SKILL.md'),
      `# skill ${name}\n`,
      'utf8',
    );
  }

  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });
  // Only "principal" is configured — proves R3 resolves via the manifest,
  // never by fetching "othercat" (there is no source configured for it).
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/principal.git' }] }),
    'utf8',
  );

  const env: Env = { RIGGER_HOME: homeDir };

  const runner: CommandRunner = (_cmd, args) => {
    const argv = args ?? [];
    if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${SHA}\trefs/tags/${TAG_NAME}\n`,
        stderr: '',
      });
    }
    if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\tHEAD\n`, stderr: '' });
    }
    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\n`, stderr: '' });
    }
    if (_cmd === 'sh' || argv.length === 0) {
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };

  const tmpFactory: TmpDirFactory = async () => ({
    path: contentDir,
    cleanup: async () => {},
  });

  const cleanupAll = async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(contentDir, { recursive: true, force: true });
  };

  return { env, homeDir, contentDir, runner, tmpFactory, cleanupAll };
}

function makeCapture(): { lines: string[]; print: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

function manifestEntry(overrides: Partial<ManifestEntry> & { id: string }): ManifestEntry {
  return {
    nature: 'skill',
    ref: 'v0.0.1',
    sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    scope: 'user',
    installedAt: new Date().toISOString(),
    files: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// FM1 — foreign require absent → exit 2, actionable message, zero writes
// ---------------------------------------------------------------------------

describe('lot6-R3: foreign require absent — actionable error, zero writes', () => {
  let principalEnv: Awaited<ReturnType<typeof makePrincipalEnv>>;
  let targets: ReturnType<typeof resolveUserTargets>;

  beforeEach(async () => {
    principalEnv = await makePrincipalEnv();
    targets = resolveUserTargets(principalEnv.env);
  });

  afterEach(async () => {
    await principalEnv.cleanupAll();
  });

  it('exits with code 2', async () => {
    const cap = makeCapture();
    const code = await runCli(['install', 'principal/skill:bar', '--yes'], {
      print: cap.print,
      env: principalEnv.env,
      remote: {
        run: principalEnv.runner,
        tmpFactory: principalEnv.tmpFactory,
        scanner: stubScanner,
      },
    });
    expect(code).toBe(2);
  });

  it('names the requirer, the chain, and the exact remediation command', async () => {
    const cap = makeCapture();
    await runCli(['install', 'principal/skill:bar', '--yes'], {
      print: cap.print,
      env: principalEnv.env,
      remote: {
        run: principalEnv.runner,
        tmpFactory: principalEnv.tmpFactory,
        scanner: stubScanner,
      },
    });
    const output = cap.lines.join('\n');
    expect(output).toContain('principal/skill:bar'); // requérant
    expect(output).toContain('othercat/skill:foo'); // the unsatisfied ref
    expect(output).toContain('rigger install othercat/skill:foo'); // remediation
  });

  it('writes no manifest (state.json absent)', async () => {
    await runCli(['install', 'principal/skill:bar', '--yes'], {
      print: makeCapture().print,
      env: principalEnv.env,
      remote: {
        run: principalEnv.runner,
        tmpFactory: principalEnv.tmpFactory,
        scanner: stubScanner,
      },
    });
    const exists = await fs.stat(targets.stateJson).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it('writes no skill store directory (fail-closed, group-wide)', async () => {
    await runCli(['install', 'principal/skill:bar', '--yes'], {
      print: makeCapture().print,
      env: principalEnv.env,
      remote: {
        run: principalEnv.runner,
        tmpFactory: principalEnv.tmpFactory,
        scanner: stubScanner,
      },
    });
    const stat = await fs.stat(path.join(targets.skillsDir, 'bar')).catch(() => null);
    expect(stat).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Satisfied — same scope + assistant, pre-seeded in the manifest
// ---------------------------------------------------------------------------

describe('lot6-R3: foreign require satisfied by the manifest (same scope + assistant)', () => {
  it('install succeeds — the dependency is satisfied, not re-fetched', async () => {
    const principalEnv = await makePrincipalEnv();
    const targets = resolveUserTargets(principalEnv.env);
    try {
      await writeManifest(targets.stateJson, {
        ...emptyManifest(),
        artifacts: [
          manifestEntry({ id: 'othercat/skill:foo', scope: 'user' }), // assistant omitted → defaults to claude
        ],
      });

      const cap = makeCapture();
      const code = await runCli(['install', 'principal/skill:bar', '--yes'], {
        print: cap.print,
        env: principalEnv.env,
        remote: {
          run: principalEnv.runner,
          tmpFactory: principalEnv.tmpFactory,
          scanner: stubScanner,
        },
      });
      expect(code).toBe(0);

      const raw = await fs.readFile(targets.stateJson, 'utf8');
      const manifest = JSON.parse(raw) as { artifacts: Array<{ id: string }> };
      expect(manifest.artifacts.some((a) => a.id === 'principal/skill:bar')).toBe(true);

      // The actual skill content was installed (not merely a no-op success).
      const stat = await fs.stat(path.join(targets.skillsDir, 'bar')).catch(() => null);
      expect(stat).not.toBeNull();
    } finally {
      await principalEnv.cleanupAll();
    }
  });
});

// ---------------------------------------------------------------------------
// NOT satisfied — different scope
// ---------------------------------------------------------------------------

describe('lot6-R3: foreign require NOT satisfied — manifest entry is a different scope', () => {
  it('exits 2 even though othercat/skill:foo IS installed, but for scope "project"', async () => {
    const principalEnv = await makePrincipalEnv();
    const targets = resolveUserTargets(principalEnv.env);
    try {
      await writeManifest(targets.stateJson, {
        ...emptyManifest(),
        artifacts: [manifestEntry({ id: 'othercat/skill:foo', scope: 'project' })],
      });

      const cap = makeCapture();
      // Default install scope is 'user' (no --project flag) — scope mismatch.
      const code = await runCli(['install', 'principal/skill:bar', '--yes'], {
        print: cap.print,
        env: principalEnv.env,
        remote: {
          run: principalEnv.runner,
          tmpFactory: principalEnv.tmpFactory,
          scanner: stubScanner,
        },
      });
      expect(code).toBe(2);
      const output = cap.lines.join('\n');
      expect(output).toContain('othercat/skill:foo');
      // Distinguishes this from the generic UnknownEntryError path: the
      // scope-mismatched entry was found and rejected by partitionForeignRequires
      // (ForeignRequireUnsatisfiedError), not by resolve() failing to find the ref.
      expect(output).toContain('rigger install othercat/skill:foo');
    } finally {
      await principalEnv.cleanupAll();
    }
  });
});

// ---------------------------------------------------------------------------
// NOT satisfied — different assistant
// ---------------------------------------------------------------------------

describe('lot6-R3: foreign require NOT satisfied — manifest entry is a different assistant', () => {
  it('exits 2 even though othercat/skill:foo IS installed, but for assistant "opencode"', async () => {
    const principalEnv = await makePrincipalEnv();
    const targets = resolveUserTargets(principalEnv.env);
    try {
      await writeManifest(targets.stateJson, {
        ...emptyManifest(),
        artifacts: [
          manifestEntry({ id: 'othercat/skill:foo', scope: 'user', assistant: 'opencode' }),
        ],
      });

      const cap = makeCapture();
      // Default install assistant is 'claude' — assistant mismatch.
      const code = await runCli(['install', 'principal/skill:bar', '--yes'], {
        print: cap.print,
        env: principalEnv.env,
        remote: {
          run: principalEnv.runner,
          tmpFactory: principalEnv.tmpFactory,
          scanner: stubScanner,
        },
      });
      expect(code).toBe(2);
      const output = cap.lines.join('\n');
      expect(output).toContain('othercat/skill:foo');
      expect(output).toContain('rigger install othercat/skill:foo');
    } finally {
      await principalEnv.cleanupAll();
    }
  });
});

// ---------------------------------------------------------------------------
// Local chain — skill:a requires skill:typo (no catalogue involved)
// ---------------------------------------------------------------------------

describe('lot6-R3: local unknown require — the message names the requirer', () => {
  it('exits 2 naming "skill:typo" and its requirer "skill:a"', async () => {
    const principalEnv = await makePrincipalEnv();
    try {
      const cap = makeCapture();
      const code = await runCli(['install', 'principal/skill:a', '--yes'], {
        print: cap.print,
        env: principalEnv.env,
        remote: {
          run: principalEnv.runner,
          tmpFactory: principalEnv.tmpFactory,
          scanner: stubScanner,
        },
      });
      expect(code).toBe(2);
      const output = cap.lines.join('\n');
      expect(output).toContain('skill:typo');
      expect(output).toContain('skill:a');
    } finally {
      await principalEnv.cleanupAll();
    }
  });
});

// ---------------------------------------------------------------------------
// FM4 — update poison-pill: a new release's unsatisfied foreign require fails
// actionable; nothing removed; a different source is unaffected.
// ---------------------------------------------------------------------------

/** Isolated HOME with TWO catalogs configured ('principal', 'second') — no shared state. */
async function makeUpdateHome(): Promise<{ env: Env; cleanup: () => Promise<void> }> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-lot6-r3-update-home-'));
  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      catalogs: [
        { name: 'principal', url: 'https://example.com/principal.git' },
        { name: 'second', url: 'https://example.com/second.git' },
      ],
    }),
    'utf8',
  );
  return {
    env: { RIGGER_HOME: homeDir },
    cleanup: () => fs.rm(homeDir, { recursive: true, force: true }),
  };
}

/** One versioned checkout + fake runner for a single catalogue update call. */
async function makeSourceCheckout(opts: {
  entries: CatalogEntry[];
  skillDirs: string[];
  tag: string;
  sha: string;
}): Promise<{ runner: CommandRunner; tmpFactory: TmpDirFactory; cleanup: () => Promise<void> }> {
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-lot6-r3-src-'));
  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 'src' }, entries: opts.entries }),
    'utf8',
  );
  for (const name of opts.skillDirs) {
    await fs.mkdir(path.join(contentDir, 'skills', name), { recursive: true });
    await fs.writeFile(path.join(contentDir, 'skills', name, 'SKILL.md'), `# ${name}\n`, 'utf8');
  }

  const runner: CommandRunner = (_cmd, args) => {
    const argv = args ?? [];
    if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${opts.sha}\trefs/tags/${opts.tag}\n`,
        stderr: '',
      });
    }
    if (argv[0] === 'clone') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${opts.sha}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };

  const tmpFactory: TmpDirFactory = async () => ({ path: contentDir, cleanup: async () => {} });

  return { runner, tmpFactory, cleanup: () => fs.rm(contentDir, { recursive: true, force: true }) };
}

describe('lot6-R3: update poison-pill — release adds an unsatisfied foreign require', () => {
  const SHA_V1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const SHA_V2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  it('principal update fails actionable; manifest entry untouched (nothing removed)', async () => {
    const home = await makeUpdateHome();
    const targets = resolveUserTargets(home.env);
    const principalV2 = await makeSourceCheckout({
      entries: [{ ...SKILL_BAR_ENTRY }], // v2 release: now requires othercat/skill:foo
      skillDirs: ['bar'],
      tag: 'v1.1.0',
      sha: SHA_V2,
    });

    try {
      await writeManifest(targets.stateJson, {
        ...emptyManifest(),
        artifacts: [
          manifestEntry({ id: 'principal/skill:bar', ref: 'v1.0.0', sha: SHA_V1, scope: 'user' }),
        ],
      });

      await expect(
        runUpdate({
          ids: ['principal/skill:bar'],
          scope: 'user',
          env: home.env,
          manifestPath: targets.stateJson,
          catalogUrl: 'https://example.com/principal.git',
          runner: principalV2.runner,
          tmpFactory: principalV2.tmpFactory,
          confirm: true,
          scanner: stubScanner,
        }),
      ).rejects.toThrow(ForeignRequireUnsatisfiedError);

      const raw = await fs.readFile(targets.stateJson, 'utf8');
      const manifest = JSON.parse(raw) as {
        artifacts: Array<{ id: string; ref: string; sha: string }>;
      };
      const entry = manifest.artifacts.find((a) => a.id === 'principal/skill:bar');
      expect(entry).toBeDefined();
      expect(entry?.ref).toBe('v1.0.0');
      expect(entry?.sha).toBe(SHA_V1);
    } finally {
      await principalV2.cleanup();
      await home.cleanup();
    }
  });

  it('a separate source (same manifestPath) updates normally, unaffected by the other failure', async () => {
    const home = await makeUpdateHome();
    const targets = resolveUserTargets(home.env);

    const skillBazEntry: CatalogEntry = {
      kind: 'artifact',
      id: 'skill:baz',
      nature: 'skill',
      targets: ['claude'],
      scopes: ['user', 'project'],
    };
    const secondV2 = await makeSourceCheckout({
      entries: [skillBazEntry],
      skillDirs: ['baz'],
      tag: 'v1.1.0',
      sha: SHA_V2,
    });

    try {
      await writeManifest(targets.stateJson, {
        ...emptyManifest(),
        artifacts: [
          manifestEntry({ id: 'second/skill:baz', ref: 'v1.0.0', sha: SHA_V1, scope: 'user' }),
        ],
      });

      const result = await runUpdate({
        ids: ['second/skill:baz'],
        scope: 'user',
        env: home.env,
        manifestPath: targets.stateJson,
        catalogUrl: 'https://example.com/second.git',
        runner: secondV2.runner,
        tmpFactory: secondV2.tmpFactory,
        confirm: true,
        scanner: stubScanner,
      });

      expect(result.updated).toContain('second/skill:baz');

      const raw = await fs.readFile(targets.stateJson, 'utf8');
      const manifest = JSON.parse(raw) as {
        artifacts: Array<{ id: string; ref: string; sha: string }>;
      };
      const entry = manifest.artifacts.find((a) => a.id === 'second/skill:baz');
      expect(entry?.ref).toBe('v1.1.0');
      expect(entry?.sha).toBe(SHA_V2);
    } finally {
      await secondV2.cleanup();
      await home.cleanup();
    }
  });
});
