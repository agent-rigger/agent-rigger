/**
 * lib-nature-t13-f2-preflight-installed-lib.test.ts — Finding 2 (adversarial-
 * close, R4): the pre-flight's lib set must cover libs ALREADY installed, not
 * only libs materialised THIS run.
 *
 * A cross-catalogue lib is the global singleton `(id, 'user', 'shared')` (S2).
 * When a plugin from catalogue B requires catalogue A's lib and that lib is
 * already installed, the require is satisfied by the manifest and PRUNED — so
 * it never lands in this run's materialised `libs`. The old pre-flight built
 * its lib set from `libs` alone, saw an empty set for that plugin, and stayed
 * silent — shipping a copy whose `../libs/<name>/…` import breaks at runtime.
 *
 * Reaching the gate at all first required a second fix in the same flow:
 * `partitionForeignRequires` looked a foreign lib up under `(scope, assistant)`
 * — never where a lib lives — so an installed lib wrongly failed
 * `ForeignRequireUnsatisfiedError` before the pre-flight ran. Both are covered
 * here: the end-to-end path now reaches the gate AND the gate now fires.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type CatalogEntry, type TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { emptyManifest, readManifest, writeManifest } from '@agent-rigger/core/manifest';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';
import type { Manifest, ManifestEntry } from '@agent-rigger/core/types';

import {
  collectRequiredLibIds,
  runRemoteInstall,
  SymlinkUnavailableError,
} from '../src/remote-install';

const TAG = 'v1.0.0';
const SHA = 'aabbccddeeff00112233445566778899aabbccdd';
const CATALOG_URL = 'https://example.com/principal.git';
const FOREIGN_LIB_ID = 'other/lib:rules-common';

/** A symlink seam that always rejects — simulates a host without symlink support. */
const noSymlink = () => Promise.reject(new Error('ENOSYS: symlink not supported'));

// ---------------------------------------------------------------------------
// Unit — collectRequiredLibIds
// ---------------------------------------------------------------------------

describe('F2 unit — collectRequiredLibIds covers already-installed foreign libs', () => {
  function manifestWithInstalledLib(): Manifest {
    return {
      version: 1,
      artifacts: [
        {
          id: FOREIGN_LIB_ID,
          nature: 'lib',
          ref: TAG,
          sha: SHA,
          scope: 'user',
          installedAt: new Date().toISOString(),
          files: ['/somewhere/libs/rules-common'],
          assistant: 'shared',
        } satisfies ManifestEntry,
      ],
    };
  }

  it('includes a pre-installed foreign lib named by a pre-prune requires edge', () => {
    const requiresById = new Map<string, string[]>([
      ['principal/plugin:guard', [FOREIGN_LIB_ID]],
    ]);

    const libIds = collectRequiredLibIds([], requiresById, manifestWithInstalledLib());

    expect(libIds.has(FOREIGN_LIB_ID)).toBe(true);
  });

  it('keeps the in-run libs and ignores non-lib requires', () => {
    const requiresById = new Map<string, string[]>([
      ['principal/plugin:guard', ['principal/skill:helper']],
    ]);

    const libIds = collectRequiredLibIds(['principal/lib:local'], requiresById, emptyManifest());

    expect([...libIds]).toEqual(['principal/lib:local']);
  });
});

// ---------------------------------------------------------------------------
// End-to-end — runRemoteInstall reaches AND fires the gate
// ---------------------------------------------------------------------------

const PLUGIN_WITH_FOREIGN_LIB: CatalogEntry = {
  kind: 'artifact',
  id: 'plugin:guard',
  nature: 'plugin',
  targets: ['opencode'],
  scopes: ['user'],
  requires: [FOREIGN_LIB_ID],
};

function makeRunner(): CommandRunner {
  return (_cmd, args) => {
    const argv = args ?? [];
    if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\trefs/tags/${TAG}\n`, stderr: '' });
    }
    if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\tHEAD\n`, stderr: '' });
    }
    if (argv[0] === 'clone') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };
}

describe('F2 e2e — a plugin requiring an already-installed foreign lib is refused on a no-symlink host', () => {
  let homeDir: string;
  let contentDir: string;
  let env: Env;
  let manifestPath: string;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t13-f2-home-'));
    contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t13-f2-content-'));
    env = { RIGGER_HOME: homeDir };

    await fs.writeFile(
      path.join(contentDir, 'catalog.json'),
      JSON.stringify({ meta: { name: 'principal' }, entries: [PLUGIN_WITH_FOREIGN_LIB] }),
      'utf8',
    );
    await fs.mkdir(path.join(contentDir, 'opencode', 'plugins'), { recursive: true });
    await fs.writeFile(
      path.join(contentDir, 'opencode', 'plugins', 'guard.ts'),
      'export const plugin = 1;\n',
      'utf8',
    );
    await fs.mkdir(path.join(homeDir, '.config', 'agent-rigger'), { recursive: true });

    manifestPath = resolveUserTargets(env).stateJson;
    // The foreign lib is already installed — the global singleton (user, shared).
    await writeManifest(manifestPath, {
      version: 1,
      artifacts: [
        {
          id: FOREIGN_LIB_ID,
          nature: 'lib',
          ref: TAG,
          sha: SHA,
          scope: 'user',
          installedAt: new Date().toISOString(),
          files: [path.join(homeDir, '.config', 'agent-rigger', 'libs', 'rules-common')],
          assistant: 'shared',
        } satisfies ManifestEntry,
      ],
    });
  });

  afterEach(async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(contentDir, { recursive: true, force: true });
  });

  it('throws SymlinkUnavailableError (not ForeignRequireUnsatisfiedError, not a silent copy)', async () => {
    await expect(
      runRemoteInstall({
        ids: ['principal/plugin:guard'],
        catalogUrl: CATALOG_URL,
        scope: 'user',
        env,
        manifestPath,
        runner: makeRunner(),
        tmpFactory: (async () => ({ path: contentDir, cleanup: async () => {} })) as TmpDirFactory,
        confirm: true,
        assistant: 'opencode',
        scanner: stubScanner,
        sourceName: 'principal',
        symlink: noSymlink,
      }),
    ).rejects.toBeInstanceOf(SymlinkUnavailableError);

    // Nothing was posed — the plugin target dir stays absent.
    const manifest = await readManifest(manifestPath);
    expect(manifest.artifacts.some((e) => e.id === 'principal/plugin:guard')).toBe(false);
  });
});
