/**
 * lib-nature-t5-update-exempt.test.ts — R6 sc.4: the update flow is EXEMPT from
 * the remove refcount gate BY CONSTRUCTION (S5).
 *
 * The gate lives in the CLI remove path (cmd-remove → runRemove). `update` is a
 * remove-then-apply through the ENGINE directly (cmd-update calls remove()/apply()
 * under its single run lock, never runRemove), and it excludes libs from the
 * remove entries entirely (they re-materialise on apply's parallel channel). So
 * updating with a lib whose dependent is still installed can never raise
 * RequiredByError — this test pins that the update completes and the lib survives.
 *
 * Harness mirrors lib-nature-t3-e2e.test.ts: isolated HOME, one catalogue, a
 * deterministic fake git runner, an in-memory checkout via tmpFactory.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type CatalogEntry, type TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { readManifest, writeManifest } from '@agent-rigger/core/manifest';
import { libsDir, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';

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

interface Harness {
  env: Env;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  stateJson: string;
}

async function makeEnv(): Promise<Harness> {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t5-upd-home-'));
  contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t5-upd-content-'));

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 'principal' }, entries: LIB_AND_CONSUMER }),
    'utf8',
  );
  for (const [rel, content] of Object.entries(CHECKOUT_FILES)) {
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

const dirExists = (p: string): Promise<boolean> => fs.stat(p).then(() => true).catch(() => false);

beforeEach(() => {
  homeDir = '';
  contentDir = '';
});

afterEach(async () => {
  await fs.rm(homeDir, { recursive: true, force: true });
  await fs.rm(contentDir, { recursive: true, force: true });
});

describe('R6 sc.4 — update of a lib-with-dependents is not gated', () => {
  it('updates a consumer that still requires the lib without raising RequiredByError', async () => {
    const h = await makeEnv();

    // Install the consumer (pulls + materialises the lib, persists the edge).
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

    const dest = path.join(libsDir(h.env), 'rules-common');
    expect(await dirExists(dest)).toBe(true);

    // Make the consumer stale so update actually re-resolves it (remove-then-
    // apply): a fresh install already sits at the remote ref and would be a
    // no-op skip, which would not exercise the remove path the gate lives on.
    const installed = await readManifest(h.stateJson);
    await writeManifest(h.stateJson, {
      ...installed,
      artifacts: installed.artifacts.map((e) =>
        e.id === 'principal/skill:consumer' ? { ...e, ref: 'v0.0.1', sha: 'stale' } : e
      ),
    });

    // Update the consumer — it still requires the lib. The remove-then-apply
    // goes through the engine directly, so the gate never sees it: no
    // RequiredByError, and the lib re-materialises untouched.
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

    expect(result.updated).toContain('principal/skill:consumer');

    const manifest = await readManifest(h.stateJson);
    // The consumer's edge and the single global lib entry both survive.
    const consumer = manifest.artifacts.find((e) => e.id === 'principal/skill:consumer');
    expect(consumer?.requires).toEqual(['principal/lib:rules-common']);
    const libEntry = manifest.artifacts.filter((e) => e.id === 'principal/lib:rules-common');
    expect(libEntry).toHaveLength(1);
    expect(libEntry[0]!.assistant).toBe('shared');
    expect(await dirExists(dest)).toBe(true);
  });
});
