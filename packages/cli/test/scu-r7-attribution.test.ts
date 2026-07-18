/**
 * scu-r7-attribution.test.ts — R7 finding attribution end-to-end (scan-par-catalogue).
 *
 * The union scan runs the composite scanner once over a staging mirror of the
 * whole selection. gitleaks (8.30.1) reports an ABSOLUTE File; because the
 * mirror reproduces the checkout layout, gitleaks.ts rebases that File against
 * the scanned staging dir, so the finding carries the exact checkout-relative
 * path (`skills/a/SKILL.md`) — no rewrite in the gate. This file proves that
 * attribution end-to-end through runRemoteInstall:
 *  - two skills leaking → ONE ScanBlockedError aggregating both, each finding
 *    carrying its own distinct checkout-relative path (R3 scénario 2 + R7).
 *  - a secret in catalog.json → the finding names `catalog.json`.
 *
 * The gitleaks CLI is mocked: the mock reads `--source <stagingDir>` from the
 * args and reports its findings as absolute Files under that dir, exactly as the
 * real tool would — so the rebase in gitleaks.ts is what's under test, not the mock.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { createCompositeScanner } from '@agent-rigger/core';
import { findEntry, readManifest } from '@agent-rigger/core/manifest';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { Scanner } from '@agent-rigger/core/scan';

import { runRemoteInstall, ScanBlockedError } from '../src/remote-install';

// ---------------------------------------------------------------------------
// Constants + catalog fixtures (two independent skills)
// ---------------------------------------------------------------------------

const TAG_NAME = 'v1.0.0';
const SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const CATALOG_URL = 'https://example.com/content-repo.git';

const SKILL_A: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:a',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

const SKILL_B: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:b',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

// ---------------------------------------------------------------------------
// leakyStagingScanner — composite scanner whose gitleaks mock reports the given
// checkout-relative paths as ABSOLUTE Files under the staging dir it is handed.
// ---------------------------------------------------------------------------

/** gitleaks present, trivy absent — only the gitleaks branch of the composite runs. */
const gitleaksOnlyWhich = (cmd: string): string | null =>
  cmd === 'gitleaks' ? '/usr/bin/gitleaks' : null;

function leakyStagingScanner(relFiles: string[]): Scanner {
  const run = (
    cmd: string,
    args: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    if (cmd !== 'gitleaks') {
      return Promise.resolve({ exitCode: 0, stdout: '[]', stderr: '' });
    }
    const srcIdx = args.indexOf('--source');
    const dir = srcIdx >= 0 ? (args[srcIdx + 1] ?? '') : '';
    const findings = relFiles.map((rel, i) => ({
      Description: 'AWS Access Key detected',
      File: path.join(dir, ...rel.split('/')), // absolute, under the staging mirror
      RuleID: `aws-access-key-${i}`,
    }));
    return Promise.resolve({ exitCode: 1, stdout: JSON.stringify(findings), stderr: '' });
  };
  return createCompositeScanner({ run, which: gitleaksOnlyWhich });
}

// ---------------------------------------------------------------------------
// Fixture: isolated HOME + content dir with skills/a and skills/b
// ---------------------------------------------------------------------------

interface Fixture {
  env: Env;
  contentDir: string;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  manifestPath: string;
  cleanupAll: () => Promise<void>;
}

async function makeEnv(): Promise<Fixture> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-scu-r7-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-scu-r7-content-'));

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 'scu-r7-catalog' }, entries: [SKILL_A, SKILL_B] }),
    'utf8',
  );
  for (const name of ['a', 'b']) {
    await fs.mkdir(path.join(contentDir, 'skills', name), { recursive: true });
    await fs.writeFile(
      path.join(contentDir, 'skills', name, 'SKILL.md'),
      `# skill ${name}\nAWS_KEY=AKIAIOSFODNN7EXAMPLE\n`,
      'utf8',
    );
  }

  const env: Env = { RIGGER_HOME: homeDir };
  const manifestPath = resolveUserTargets(env).stateJson;

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
    await fs.rm(contentDir, { recursive: true, force: true });
  };

  return { env, contentDir, runner, tmpFactory, manifestPath, cleanupAll };
}

let fixture: Fixture;

beforeEach(async () => {
  fixture = await makeEnv();
});

afterEach(async () => {
  await fixture.cleanupAll();
});

function install(ids: string[], scanner: Scanner): ReturnType<typeof runRemoteInstall> {
  return runRemoteInstall({
    ids,
    catalogUrl: CATALOG_URL,
    scope: 'user',
    env: fixture.env,
    manifestPath: fixture.manifestPath,
    runner: fixture.runner,
    tmpFactory: fixture.tmpFactory,
    confirm: true,
    scanner,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('R7: attribution — two leaking skills aggregate into one ScanBlockedError', () => {
  it('names each skill by its distinct checkout-relative path', async () => {
    let caught: unknown;
    try {
      await install(
        ['skill:a', 'skill:b'],
        leakyStagingScanner(['skills/a/SKILL.md', 'skills/b/SKILL.md']),
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ScanBlockedError);
    const err = caught as ScanBlockedError;

    // One error, two distinct checkout-relative attributions (R3 scénario 2 + R7).
    expect(err.findings.some((f) => f.includes('skills/a/SKILL.md'))).toBe(true);
    expect(err.findings.some((f) => f.includes('skills/b/SKILL.md'))).toBe(true);
    // The staging temp dir must NOT leak into the finding — attribution is
    // checkout-relative, not absolute.
    expect(err.message).not.toContain(fixture.contentDir);
    expect(err.message).not.toContain('rig-scan-staging');
  });

  it('writes nothing when blocked (fail-closed)', async () => {
    await install(['skill:a', 'skill:b'], leakyStagingScanner(['skills/a/SKILL.md'])).catch(
      () => {},
    );

    const manifest = await readManifest(fixture.manifestPath);
    expect(findEntry(manifest, 'skill:a', 'user', 'claude')).toBeUndefined();

    const skillsDir = resolveUserTargets(fixture.env).skillsDir;
    const stat = await fs.stat(path.join(skillsDir, 'a')).catch(() => null);
    expect(stat).toBeNull();
  });
});

describe('R7: attribution — a secret in catalog.json is named catalog.json', () => {
  it('attributes the finding to catalog.json', async () => {
    let caught: unknown;
    try {
      await install(['skill:a'], leakyStagingScanner(['catalog.json']));
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ScanBlockedError);
    const err = caught as ScanBlockedError;
    expect(err.findings.some((f) => f.includes('catalog.json'))).toBe(true);
    expect(err.message).not.toContain('rig-scan-staging');
  });
});
