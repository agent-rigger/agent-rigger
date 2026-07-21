/**
 * lib-nature-t3-e2e.test.ts — R3 (lib-nature T3) end-to-end through the CLI
 * install and update pipelines, with a real checkout:
 *
 *  - install: a consumer that `requires` an intra-catalogue lib materialises the
 *    lib via the engine's parallel channel, stamped with the REAL catalogue
 *    ref/sha (the lib is remote content — excluded from remoteIds by
 *    targetsAssistant, S3, but unioned into the version-eligible set so it is
 *    never a v0.0.0/'' orphan → no permanent doctor missing-sha).
 *  - update / backfill-lib: a stale legacy consumer (no edges) re-resolves,
 *    backfills its qualified lib edge, and re-materialises the lib — the lib
 *    NEVER reaches the adapter's remove/plan (S3, else UnsupportedNatureError).
 *  - a lib named directly on `update` stays skipped (its 'shared' assistant is a
 *    non-candidate — a real ref/sha does not make it directly updatable).
 *
 * Harness mirrors lib-nature-t2-edges-e2e.test.ts: isolated HOME, one catalogue,
 * a deterministic fake runner, an in-memory checkout via tmpFactory.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type CatalogEntry, type TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { emptyManifest, readManifest, writeManifest } from '@agent-rigger/core/manifest';
import { libsDir, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';
import type { ManifestEntry } from '@agent-rigger/core/types';

import { runUpdate } from '../src/cmd-update';
import { runRemoteInstall } from '../src/remote-install';

const TAG = 'v9.9.9';
const SHA = 'c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff';
const CATALOG_URL = 'https://example.com/principal.git';

function makeRunner(tag: string, sha: string): CommandRunner {
  return (_cmd, args) => {
    const argv = args ?? [];
    if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
      return Promise.resolve({ exitCode: 0, stdout: `${sha}\trefs/tags/${tag}\n`, stderr: '' });
    }
    if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
      return Promise.resolve({ exitCode: 0, stdout: `${sha}\tHEAD\n`, stderr: '' });
    }
    if (argv[0] === 'clone') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${sha}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };
}

interface Harness {
  env: Env;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  stateJson: string;
}

let homeDir: string;
let contentDir: string;

const LIB_AND_CONSUMER: CatalogEntry[] = [
  { kind: 'artifact', id: 'lib:rules-common', nature: 'lib', scopes: ['user'] } as CatalogEntry,
  {
    kind: 'artifact',
    id: 'skill:consumer',
    nature: 'skill',
    targets: ['claude'],
    scopes: ['user'],
    requires: ['lib:rules-common'],
  },
];

const CHECKOUT_FILES: Record<string, string> = {
  'common/skills/consumer/SKILL.md': '# consumer\n',
  'common/libs/rules-common/rules.ts': 'export const rule = 1;\n',
};

async function makeEnv(entries: CatalogEntry[], files: Record<string, string>): Promise<Harness> {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t3-e2e-home-'));
  contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t3-e2e-content-'));

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 'principal' }, entries }),
    'utf8',
  );
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(contentDir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content, 'utf8');
  }

  await fs.mkdir(path.join(homeDir, '.config', 'agent-rigger'), { recursive: true });

  const env: Env = { RIGGER_HOME: homeDir };
  return {
    env,
    runner: makeRunner(TAG, SHA),
    tmpFactory: async () => ({ path: contentDir, cleanup: async () => {} }),
    stateJson: resolveUserTargets(env).stateJson,
  };
}

afterEach(async () => {
  await fs.rm(homeDir, { recursive: true, force: true });
  await fs.rm(contentDir, { recursive: true, force: true });
});

beforeEach(() => {
  homeDir = '';
  contentDir = '';
});

async function dirExists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true).catch(() => false);
}

// ---------------------------------------------------------------------------
// install — lib materialised with the REAL catalogue ref/sha
// ---------------------------------------------------------------------------

describe("install stamps the lib with the catalogue's real ref/sha", () => {
  it('materialises the lib and records ref/sha (not v0.0.0/"")', async () => {
    const h = await makeEnv(LIB_AND_CONSUMER, CHECKOUT_FILES);

    await runRemoteInstall({
      ids: ['principal/skill:consumer'],
      catalogUrl: CATALOG_URL,
      scope: 'user',
      env: h.env,
      manifestPath: h.stateJson,
      runner: h.runner,
      tmpFactory: h.tmpFactory,
      confirm: true,
      scanner: stubScanner,
      sourceName: 'principal',
    });

    const manifest = await readManifest(h.stateJson);
    const dest = path.join(libsDir(h.env), 'rules-common');
    expect(await dirExists(dest)).toBe(true);

    const libEntry = manifest.artifacts.find((e) => e.id === 'principal/lib:rules-common');
    expect(libEntry).toBeDefined();
    expect(libEntry!.assistant).toBe('shared');
    // The MAJOR pin: the lib carries the REAL catalogue ref/sha, symmetric with
    // its consumer from the same checkout — never the v0.0.0/'' default.
    expect(libEntry!.ref).toBe(TAG);
    expect(libEntry!.sha).toBe(SHA);

    // Sanity: the consumer from the same checkout carries the same ref/sha.
    const consumer = manifest.artifacts.find((e) => e.id === 'principal/skill:consumer');
    expect(consumer!.ref).toBe(TAG);
    expect(consumer!.sha).toBe(SHA);
  });
});

// ---------------------------------------------------------------------------
// update re-matérialise + backfill-lib e2e (ref/sha pinned)
// ---------------------------------------------------------------------------

describe('update re-matérialise la lib + backfill de son edge (legacy entry)', () => {
  it('re-materialises the lib with real ref/sha and backfills the edge', async () => {
    const h = await makeEnv(LIB_AND_CONSUMER, CHECKOUT_FILES);

    // Legacy manifest: consumer installed pre-change, NO requires, stale ref so
    // update re-resolves (which pulls the lib in and backfills the edge).
    await writeManifest(h.stateJson, {
      ...emptyManifest(),
      artifacts: [
        {
          id: 'principal/skill:consumer',
          nature: 'skill',
          ref: 'v1.0.0',
          sha: 'dead',
          scope: 'user',
          installedAt: new Date().toISOString(),
          files: [],
        } satisfies ManifestEntry,
      ],
    });

    const result = await runUpdate({
      ids: ['principal/skill:consumer'],
      scope: 'user',
      env: h.env,
      manifestPath: h.stateJson,
      catalogUrl: CATALOG_URL,
      runner: h.runner,
      tmpFactory: h.tmpFactory,
      confirm: true,
      scanner: stubScanner,
    });

    // Update succeeded — the lib never crashed the adapter's remove/plan (S3).
    expect(result.updated).toContain('principal/skill:consumer');

    const manifest = await readManifest(h.stateJson);

    // Edge backfilled (qualified) on the consumer.
    const consumer = manifest.artifacts.find((e) => e.id === 'principal/skill:consumer');
    expect(consumer?.requires).toEqual(['principal/lib:rules-common']);

    // The lib was re-materialised on disk…
    const dest = path.join(libsDir(h.env), 'rules-common');
    expect(await dirExists(dest)).toBe(true);
    expect(await fs.readFile(path.join(dest, 'rules.ts'), 'utf8')).toBe('export const rule = 1;\n');

    // …with the global singleton entry AND the real catalogue ref/sha (MAJOR).
    const libEntry = manifest.artifacts.find((e) => e.id === 'principal/lib:rules-common');
    expect(libEntry).toBeDefined();
    expect(libEntry!.scope).toBe('user');
    expect(libEntry!.assistant).toBe('shared');
    expect(libEntry!.files).toEqual([dest]);
    expect(libEntry!.ref).toBe(TAG);
    expect(libEntry!.sha).toBe(SHA);
  });
});

// ---------------------------------------------------------------------------
// a lib named directly on `update` stays skipped (non-candidate)
// ---------------------------------------------------------------------------

describe('update lib:<name> direct — skipped, never updated', () => {
  it('a lib entry (assistant shared) is not a direct-update candidate', async () => {
    const h = await makeEnv(LIB_AND_CONSUMER, CHECKOUT_FILES);

    // A lib entry already installed with a real ref/sha (as install now stamps).
    await writeManifest(h.stateJson, {
      ...emptyManifest(),
      artifacts: [
        {
          id: 'principal/lib:rules-common',
          nature: 'lib',
          ref: TAG,
          sha: SHA,
          scope: 'user',
          installedAt: new Date().toISOString(),
          files: [path.join(libsDir(h.env), 'rules-common')],
          assistant: 'shared',
        } satisfies ManifestEntry,
      ],
    });

    const result = await runUpdate({
      ids: ['principal/lib:rules-common'],
      scope: 'user',
      env: h.env,
      manifestPath: h.stateJson,
      catalogUrl: CATALOG_URL,
      runner: h.runner,
      tmpFactory: h.tmpFactory,
      confirm: true,
      scanner: stubScanner,
    });

    // Skipped as a non-candidate (assistant 'shared' ≠ the update's 'claude') —
    // a real ref/sha does NOT make a lib directly updatable.
    expect(result.updated).toEqual([]);
    expect(result.skipped).toContain('principal/lib:rules-common');
  });
});
