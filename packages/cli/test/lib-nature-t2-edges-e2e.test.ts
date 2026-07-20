/**
 * lib-nature-t2-edges-e2e.test.ts — R5 (lib-nature T2), end-to-end through the
 * CLI: the install/update pipeline captures the resolved requires PRE-prune,
 * qualifies them with the same map that qualifies ids, and persists them onto
 * each ManifestEntry (S4).
 *
 * Harness mirrors lot6-r3-cross-requires.test.ts: isolated HOME, a single
 * catalogue configured, a deterministic fake runner (the tag it returns drives
 * resolveVersion — no real fetch, sidestepping the "highest semver tag" pick),
 * an in-memory checkout via tmpFactory.
 *
 * Scenarios:
 *  - R5.1 edge simple qualifié: an intra-catalogue lib require persists as
 *    `<catalog>/lib:<name>` on the consumer.
 *  - R5.2 cross-catalogue pruné mais persisté: a satisfied foreign require is
 *    pruned from the install graph yet stays on the requirer's edges.
 *  - R5.4 legacy toléré + backfill à l'update: a pre-change entry with no
 *    `requires` gains them on the first `update` (re-resolution). Uses a
 *    tool-nature require (adapter-filtered, no checkout) so the backfill is
 *    exercised without T3's lib materialisation.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type CatalogEntry, type TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { emptyManifest, readManifest, writeManifest } from '@agent-rigger/core/manifest';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';
import type { ManifestEntry } from '@agent-rigger/core/types';

import { runCli } from '../src/cli';
import { runUpdate } from '../src/cmd-update';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const TAG = 'v9.9.9';
const SHA = 'c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff';

function makeCapture(): { lines: string[]; print: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

/** A fake runner resolving one catalogue to `tag`/`sha`. */
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

/**
 * Build an isolated HOME + an in-memory checkout for ONE configured catalogue.
 * `files` maps checkout-relative paths to their content (skill dirs, lib dirs…).
 */
async function makeEnv(opts: {
  catalogName: string;
  entries: CatalogEntry[];
  files: Record<string, string>;
  tag?: string;
  sha?: string;
}): Promise<{
  env: Env;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  stateJson: string;
  cleanup: () => Promise<void>;
}> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t2-e2e-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t2-e2e-content-'));

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: opts.catalogName }, entries: opts.entries }),
    'utf8',
  );
  for (const [rel, content] of Object.entries(opts.files)) {
    const dest = path.join(contentDir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content, 'utf8');
  }

  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      catalogs: [{ name: opts.catalogName, url: `https://example.com/${opts.catalogName}.git` }],
    }),
    'utf8',
  );

  const env: Env = { RIGGER_HOME: homeDir };
  const runner = makeRunner(opts.tag ?? TAG, opts.sha ?? SHA);
  const tmpFactory: TmpDirFactory = async () => ({ path: contentDir, cleanup: async () => {} });

  return {
    env,
    runner,
    tmpFactory,
    stateJson: resolveUserTargets(env).stateJson,
    cleanup: async () => {
      await fs.rm(homeDir, { recursive: true, force: true });
      await fs.rm(contentDir, { recursive: true, force: true });
    },
  };
}

async function requiresOf(stateJson: string, id: string): Promise<string[] | undefined> {
  const manifest = await readManifest(stateJson);
  return manifest.artifacts.find((e) => e.id === id)?.requires;
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
// R5.1 — edge simple qualifié (intra-catalogue lib require)
// ---------------------------------------------------------------------------

describe('R5.1 — edge simple qualifié <catalog>/lib:<name>', () => {
  it('persiste jr/lib:rules-common sur le consommateur installé', async () => {
    const h = await makeEnv({
      catalogName: 'jr',
      entries: [
        {
          kind: 'artifact',
          id: 'lib:rules-common',
          nature: 'lib',
          scopes: ['user'],
        } as CatalogEntry,
        {
          kind: 'artifact',
          id: 'skill:consumer',
          nature: 'skill',
          targets: ['claude'],
          scopes: ['user'],
          requires: ['lib:rules-common'],
        },
      ],
      files: {
        'skills/consumer/SKILL.md': '# consumer\n',
        'common/libs/rules-common/rules.ts': 'export const x = 1;\n',
      },
    });
    try {
      const cap = makeCapture();
      const code = await runCli(['install', 'jr/skill:consumer', '--yes'], {
        print: cap.print,
        env: h.env,
        remote: { run: h.runner, tmpFactory: h.tmpFactory, scanner: stubScanner },
      });
      expect(code).toBe(0);
      expect(await requiresOf(h.stateJson, 'jr/skill:consumer')).toEqual(['jr/lib:rules-common']);
    } finally {
      await h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// R5.2 — cross-catalogue pruné mais persisté
// ---------------------------------------------------------------------------

describe("R5.2 — cross-catalogue pruné du graphe mais persisté sur l'edge", () => {
  it('persiste la ref étrangère satisfaite sur le consommateur', async () => {
    const h = await makeEnv({
      catalogName: 'principal',
      entries: [
        {
          kind: 'artifact',
          id: 'skill:bar',
          nature: 'skill',
          targets: ['claude'],
          scopes: ['user'],
          requires: ['othercat/skill:foo'],
        },
      ],
      files: { 'skills/bar/SKILL.md': '# bar\n' },
    });
    try {
      // Pre-seed the satisfied foreign require (same scope + assistant) so the
      // R3 pre-pass prunes it from the install graph.
      await writeManifest(h.stateJson, {
        ...emptyManifest(),
        artifacts: [manifestEntry({ id: 'othercat/skill:foo', scope: 'user' })],
      });

      const cap = makeCapture();
      const code = await runCli(['install', 'principal/skill:bar', '--yes'], {
        print: cap.print,
        env: h.env,
        remote: { run: h.runner, tmpFactory: h.tmpFactory, scanner: stubScanner },
      });
      expect(code).toBe(0);

      // Pruned from the graph (never re-fetched), yet persisted on the edge.
      expect(await requiresOf(h.stateJson, 'principal/skill:bar')).toEqual(['othercat/skill:foo']);
    } finally {
      await h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// R5.4 — legacy toléré + backfill au premier update
// ---------------------------------------------------------------------------

describe("R5.4 — entrée legacy sans edges backfillée à l'update", () => {
  it('lecture tolérante puis edges backfillés par la re-résolution de update', async () => {
    // Consumer requires a TOOL (adapter-filtered, no checkout) so the backfill
    // is exercised without T3's lib materialisation.
    const h = await makeEnv({
      catalogName: 'principal',
      entries: [
        {
          kind: 'artifact',
          id: 'tool:git',
          nature: 'tool',
          targets: ['claude'],
          scopes: ['user'],
          level: 'recommended',
          check: 'which git',
        },
        {
          kind: 'artifact',
          id: 'skill:consumer',
          nature: 'skill',
          targets: ['claude'],
          scopes: ['user'],
          requires: ['tool:git'],
        },
      ],
      files: { 'skills/consumer/SKILL.md': '# consumer\n' },
    });
    try {
      // Legacy manifest entry: installed before the change, NO requires field,
      // stale ref so `update` re-resolves.
      await writeManifest(h.stateJson, {
        ...emptyManifest(),
        artifacts: [
          manifestEntry({
            id: 'principal/skill:consumer',
            ref: 'v1.0.0',
            sha: 'dead',
            scope: 'user',
          }),
        ],
      });

      // Tolerant read: the legacy entry loads with requires absent.
      expect(await requiresOf(h.stateJson, 'principal/skill:consumer')).toBeUndefined();

      const result = await runUpdate({
        ids: ['principal/skill:consumer'],
        scope: 'user',
        env: h.env,
        manifestPath: h.stateJson,
        catalogUrl: 'https://example.com/principal.git',
        runner: h.runner,
        tmpFactory: h.tmpFactory,
        confirm: true,
        scanner: stubScanner,
      });
      expect(result.updated).toContain('principal/skill:consumer');

      // Backfilled by the re-resolution.
      expect(await requiresOf(h.stateJson, 'principal/skill:consumer')).toEqual([
        'principal/tool:git',
      ]);
    } finally {
      await h.cleanup();
    }
  });
});
