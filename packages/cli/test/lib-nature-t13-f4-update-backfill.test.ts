/**
 * lib-nature-t13-f4-update-backfill.test.ts — Finding 6 (adversarial-close):
 * `rigger update` must backfill the requires edges of an UP-TO-DATE legacy
 * entry, not only stale ones.
 *
 * A legacy entry (no `requires` field, installed before the edge graph shipped)
 * that is already at the latest ref classifies as `upToDate` and never reached
 * the stale remove+apply pipeline — so its edges stayed unbackfilled and the
 * doctor `no-edges` finding was inextinguishable despite advising `rigger
 * update`. The fix re-resolves such an entry's edges from the catalogue and
 * persists them WITHOUT re-posing any file; the finding then empties.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type CatalogEntry, type TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { type DoctorContext, edgeIntegrityScanner } from '@agent-rigger/core';
import { readManifest, writeManifest } from '@agent-rigger/core/manifest';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { ManifestEntry } from '@agent-rigger/core/types';

import { runUpdate } from '../src/cmd-update';

const TAG = 'v1.0.0';
const SHA = 'aabbccddeeff00112233445566778899aabbccdd';
const CATALOG_URL = 'https://example.com/principal.git';
const ENTRY_ID = 'principal/skill:foo';

const SKILL_FOO: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:foo',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user'],
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

function ctxFor(manifestPath: string): DoctorContext {
  return { env: {}, manifestPath, configuredCatalogIds: ['principal'] };
}

function noEdgesFor(
  findings: Awaited<ReturnType<typeof edgeIntegrityScanner>>,
  id: string,
): boolean {
  return findings.some(
    (f) => f.class === 'manifest' && f.issue === 'no-edges' && f.entryId === id,
  );
}

let homeDir: string;
let contentDir: string;
let env: Env;
let manifestPath: string;

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t13-f4-home-'));
  contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t13-f4-content-'));
  env = { RIGGER_HOME: homeDir };

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 'principal' }, entries: [SKILL_FOO] }),
    'utf8',
  );
  await fs.mkdir(path.join(contentDir, 'common', 'skills', 'foo'), { recursive: true });
  await fs.writeFile(
    path.join(contentDir, 'common', 'skills', 'foo', 'SKILL.md'),
    '# foo\n',
    'utf8',
  );
  await fs.mkdir(path.join(homeDir, '.config', 'agent-rigger'), { recursive: true });

  manifestPath = resolveUserTargets(env).stateJson;
  // A legacy entry: already at the latest ref (upToDate), NO `requires` field.
  await writeManifest(manifestPath, {
    version: 1,
    artifacts: [
      {
        id: ENTRY_ID,
        nature: 'skill',
        ref: TAG,
        sha: SHA,
        scope: 'user',
        installedAt: new Date().toISOString(),
        files: [],
        assistant: 'claude',
        // requires: intentionally absent (legacy).
      } satisfies ManifestEntry,
    ],
  });
});

afterEach(async () => {
  await fs.rm(homeDir, { recursive: true, force: true });
  await fs.rm(contentDir, { recursive: true, force: true });
});

describe("F4 — update backfills an up-to-date legacy entry's edges", () => {
  it('empties the doctor no-edges finding after update (edges backfilled without re-pose)', async () => {
    // Before: the legacy entry has no edges → doctor flags no-edges.
    const before = await edgeIntegrityScanner(ctxFor(manifestPath));
    expect(noEdgesFor(before, ENTRY_ID)).toBe(true);

    await runUpdate({
      ids: [],
      scope: 'user',
      env,
      manifestPath,
      catalogUrl: CATALOG_URL,
      runner: makeRunner(),
      tmpFactory: (async () => ({ path: contentDir, cleanup: async () => {} })) as TmpDirFactory,
      confirm: true,
      assistant: 'claude',
    });

    // After: the entry now carries an explicit (empty) requires edge set.
    const manifest = await readManifest(manifestPath);
    const entry = manifest.artifacts.find((e) => e.id === ENTRY_ID);
    expect(entry?.requires).toEqual([]);

    // And the doctor finding is gone.
    const after = await edgeIntegrityScanner(ctxFor(manifestPath));
    expect(noEdgesFor(after, ENTRY_ID)).toBe(false);
  });

  it('surfaces a visible skip line for a legacy entry no longer in the catalogue (never silent)', async () => {
    const GHOST_ID = 'principal/skill:ghost';
    // A legacy up-to-date entry whose catalogue entry has since vanished: its
    // edges cannot be re-resolved, so it stays flagged — and the user must be
    // told why (finding persists), not left with a silent no-op.
    await writeManifest(manifestPath, {
      version: 1,
      artifacts: [
        {
          id: ENTRY_ID,
          nature: 'skill',
          ref: TAG,
          sha: SHA,
          scope: 'user',
          installedAt: new Date().toISOString(),
          files: [],
          assistant: 'claude',
        } satisfies ManifestEntry,
        {
          id: GHOST_ID,
          nature: 'skill',
          ref: TAG,
          sha: SHA,
          scope: 'user',
          installedAt: new Date().toISOString(),
          files: [],
          assistant: 'claude',
        } satisfies ManifestEntry,
      ],
    });

    const result = await runUpdate({
      ids: [],
      scope: 'user',
      env,
      manifestPath,
      catalogUrl: CATALOG_URL,
      runner: makeRunner(),
      tmpFactory: (async () => ({ path: contentDir, cleanup: async () => {} })) as TmpDirFactory,
      confirm: true,
      assistant: 'claude',
    });

    // The unresolvable entry is reported, not swallowed.
    expect(result.output).toContain(GHOST_ID);
    expect(result.output).toContain('edges could not be re-resolved');

    // The resolvable sibling was still backfilled; the ghost's finding persists.
    const manifest = await readManifest(manifestPath);
    expect(manifest.artifacts.find((e) => e.id === ENTRY_ID)?.requires).toEqual([]);
    expect(manifest.artifacts.find((e) => e.id === GHOST_ID)?.requires).toBeUndefined();

    const after = await edgeIntegrityScanner(ctxFor(manifestPath));
    expect(noEdgesFor(after, ENTRY_ID)).toBe(false);
    expect(noEdgesFor(after, GHOST_ID)).toBe(true);
  });
});
