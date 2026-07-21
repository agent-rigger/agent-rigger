/**
 * scu-r4-exception.test.ts — R4: a scan-layer exception stays fail-closed.
 *
 * The scanner contract resolves a Verdict; a real scanner (gitleaks/trivy) maps
 * tool errors to a fail-closed { ok:false } rather than rejecting. But an
 * injected scanner — or a future one — could still throw/reject outright. This
 * file pins the RUNTIME behaviour of that path today: the raw rejection
 * propagates out of runRemoteInstall (no swallow, no "clean" wrapper we don't
 * promise), and — because the scan gate runs BEFORE any write and tears its
 * staging mirror down in a `finally` — nothing is written and no staging leaks.
 *
 * Level: runRemoteInstall (like the s4 tests), with a real on-disk checkout so
 * the union staging is really materialised before the injected scanner rejects.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { findEntry, readManifest } from '@agent-rigger/core/manifest';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { Scanner } from '@agent-rigger/core/scan';

import { runRemoteInstall } from '../src/remote-install';

// ---------------------------------------------------------------------------
// Constants + fixtures
// ---------------------------------------------------------------------------

const TAG_NAME = 'v1.0.0';
const SHA = 'facefeedfacefeedfacefeedfacefeedfacefeed';
const CATALOG_URL = 'https://example.com/content-repo.git';

const SKILL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:demo',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

/** Scanner whose scan() rejects outright — the exception under test. */
const explodingScanner: Scanner = {
  scan: () => Promise.reject(new Error('scanner exploded')),
};

interface Fixture {
  env: Env;
  parentDir: string;
  contentDir: string;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  manifestPath: string;
  skillsDir: string;
  cleanupAll: () => Promise<void>;
}

async function makeEnv(): Promise<Fixture> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-scu-r4-home-'));
  // contentDir lives under a dedicated parent so the sibling staging dir
  // (materializeUnion creates it next to the checkout) lands in a location we
  // control — letting us assert no `rig-scan-staging-*` residue after cleanup.
  const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-scu-r4-parent-'));
  const contentDir = path.join(parentDir, 'checkout');
  await fs.mkdir(contentDir, { recursive: true });

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 'scu-r4-catalog' }, entries: [SKILL_ENTRY] }),
    'utf8',
  );
  await fs.mkdir(path.join(contentDir, 'common', 'skills', 'demo'), { recursive: true });
  await fs.writeFile(
    path.join(contentDir, 'common', 'skills', 'demo', 'SKILL.md'),
    '# demo\n',
    'utf8',
  );

  const env: Env = { RIGGER_HOME: homeDir };
  const userTargets = resolveUserTargets(env);

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
    return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' });
  };

  const tmpFactory: TmpDirFactory = async () => ({ path: contentDir, cleanup: async () => {} });

  const cleanupAll = async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(parentDir, { recursive: true, force: true });
  };

  return {
    env,
    parentDir,
    contentDir,
    runner,
    tmpFactory,
    manifestPath: userTargets.stateJson,
    skillsDir: userTargets.skillsDir,
    cleanupAll,
  };
}

let fixture: Fixture;

beforeEach(async () => {
  fixture = await makeEnv();
});

afterEach(async () => {
  await fixture.cleanupAll();
});

function install(): ReturnType<typeof runRemoteInstall> {
  return runRemoteInstall({
    ids: ['skill:demo'],
    catalogUrl: CATALOG_URL,
    scope: 'user',
    env: fixture.env,
    manifestPath: fixture.manifestPath,
    runner: fixture.runner,
    tmpFactory: fixture.tmpFactory,
    confirm: true,
    scanner: explodingScanner,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('R4: scan-layer exception stays fail-closed', () => {
  it('R4: propagates the raw scanner rejection out of the install', async () => {
    await expect(install()).rejects.toThrow('scanner exploded');
  });

  it('R4: writes nothing — no manifest entry and no store target', async () => {
    await install().catch(() => {});

    const manifest = await readManifest(fixture.manifestPath);
    expect(findEntry(manifest, 'skill:demo', 'user', 'claude')).toBeUndefined();

    const stat = await fs.stat(path.join(fixture.skillsDir, 'demo')).catch(() => null);
    expect(stat).toBeNull();
  });

  it('R4: leaves no staging mirror behind (cleanup finally ran)', async () => {
    await install().catch(() => {});

    // The staging is a sibling of the checkout, under parentDir. cleanup() in
    // scanEntries' finally must have removed it even though the scan rejected.
    const entries = await fs.readdir(fixture.parentDir);
    expect(entries.filter((e) => e.startsWith('rig-scan-staging-'))).toEqual([]);
  });
});
