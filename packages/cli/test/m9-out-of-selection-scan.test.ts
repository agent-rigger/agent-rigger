/**
 * m9-out-of-selection-scan.test.ts — prove end-to-end that a secret living in a
 * NON-selected artefact never blocks an install of a clean selection, and that
 * the same secret DOES block when its artefact is the one selected (scan-hardening
 * T5, differé m9).
 *
 * Why this file exists
 * --------------------
 * The out-of-selection property ("we only scan what we install") was previously
 * proven only INDIRECTLY: scu-r2-staging asserts the staging mirror omits the
 * non-selected `skills/autre/SKILL.md`, so a scanner "would" never see it. That
 * is an absence-of-mirror argument, not a live scan. Here the property is proven
 * causally, through the real `runRemoteInstall` → `scanEntries` → `materializeUnion`
 * → composite-scanner pipeline, with a CONTENT-SENSITIVE gitleaks mock:
 *
 *   - the mock walks the `--source` dir it is handed (the staging mirror),
 *   - reports a finding (exit 1, gitleaks JSON, absolute File) ONLY for files
 *     that actually contain the planted secret,
 *   - reports nothing (exit 0) otherwise.
 *
 * So the verdict is driven by what materializeUnion actually staged — not by a
 * hard-coded finding list. Test 1 (property) installs a clean skill and the run
 * must complete. Test 2 (inverse control, self-validating) installs the leaking
 * skill and the same mock must block: it proves test 1's success is a real clean
 * scan, not a broken mock that can never fire.
 *
 * The real gitleaks.ts / composite.ts run — only the `gitleaks` CLI itself is
 * mocked (same seam as scu-r7-attribution), so the rebase + verdict logic is
 * under test, not the mock.
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
// Constants + catalog fixtures
// ---------------------------------------------------------------------------

const TAG_NAME = 'v1.0.0';
const SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const CATALOG_URL = 'https://example.com/content-repo.git';

/**
 * Frozen GitHub PAT fixture: `ghp_` + 36 high-entropy chars — the exact literal
 * frozen in core/real-binaries.test.ts, verified to trip gitleaks 8.30.1's
 * `github-pat` rule. Reused here so the content-sensitive mock detects the same
 * token a real gitleaks would (and so m9-real-scan.smoke.test.ts stays aligned).
 */
const FROZEN_PAT = 'ghp_016ABCdef0123456789ghIJKLmnop6789zZq';

/** github-pat regex, no `g` flag → `.test` is stateless across files. */
const PAT_RE = /ghp_[A-Za-z0-9]{36}/;

const SKILL_A: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:a',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

const SKILL_AUTRE: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:autre',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

// ---------------------------------------------------------------------------
// contentSensitiveGitleaksScanner — a composite scanner whose gitleaks mock
// walks the scanned dir and reports a finding ONLY for files containing the PAT.
// The verdict is therefore a function of what materializeUnion actually staged.
// ---------------------------------------------------------------------------

/** gitleaks present, trivy absent — only the gitleaks branch of the composite runs. */
const gitleaksOnlyWhich = (cmd: string): string | null =>
  cmd === 'gitleaks' ? '/usr/bin/gitleaks' : null;

/** Sorted absolute paths of every regular file under `root` (symlinks skipped). */
async function walkFiles(root: string, dir: string = root): Promise<string[]> {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const d of dirents) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) {
      out.push(...(await walkFiles(root, full)));
    } else if (d.isFile()) {
      out.push(full);
    }
  }
  return out.sort();
}

function contentSensitiveGitleaksScanner(): Scanner {
  const run = async (
    cmd: string,
    args: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    if (cmd !== 'gitleaks') {
      return { exitCode: 0, stdout: '[]', stderr: '' };
    }
    const srcIdx = args.indexOf('--source');
    const dir = srcIdx >= 0 ? (args[srcIdx + 1] ?? '') : '';
    const files = await walkFiles(dir);
    const findings: { Description: string; File: string; RuleID: string }[] = [];
    for (const file of files) {
      const content = await fs.readFile(file, 'utf8').catch(() => '');
      if (PAT_RE.test(content)) {
        findings.push({
          Description: 'GitHub PAT detected',
          File: file, // absolute, under the staging mirror — gitleaks.ts rebases it
          RuleID: 'github-pat',
        });
      }
    }
    if (findings.length === 0) {
      return { exitCode: 0, stdout: '[]', stderr: '' };
    }
    return { exitCode: 1, stdout: JSON.stringify(findings), stderr: '' };
  };
  return createCompositeScanner({ run, which: gitleaksOnlyWhich });
}

// ---------------------------------------------------------------------------
// Fixture: isolated HOME + content dir with a clean skill:a and a leaking
// skill:autre (secret ONLY in skills/autre/SKILL.md; catalog.json is clean).
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
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-m9-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-m9-content-'));

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 'm9-catalog' }, entries: [SKILL_A, SKILL_AUTRE] }),
    'utf8',
  );

  // skill:a — clean.
  await fs.mkdir(path.join(contentDir, 'common', 'skills', 'a'), { recursive: true });
  await fs.writeFile(
    path.join(contentDir, 'common', 'skills', 'a', 'SKILL.md'),
    '# skill a\nnothing to see here\n',
    'utf8',
  );
  // skill:autre — the secret lives here, and NOWHERE else.
  await fs.mkdir(path.join(contentDir, 'common', 'skills', 'autre'), { recursive: true });
  await fs.writeFile(
    path.join(contentDir, 'common', 'skills', 'autre', 'SKILL.md'),
    `# skill autre\nconst token = "${FROZEN_PAT}";\n`,
    'utf8',
  );

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

function install(ids: string[]): ReturnType<typeof runRemoteInstall> {
  return runRemoteInstall({
    ids,
    catalogUrl: CATALOG_URL,
    scope: 'user',
    env: fixture.env,
    manifestPath: fixture.manifestPath,
    runner: fixture.runner,
    tmpFactory: fixture.tmpFactory,
    confirm: true,
    scanner: contentSensitiveGitleaksScanner(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('m9: a secret outside the selection does not block a clean install', () => {
  it('installs skill:a — the secret in the non-selected skill:autre is never scanned', async () => {
    // skill:autre is NOT selected → materializeUnion never stages
    // skills/autre/SKILL.md → the content-sensitive mock walks the mirror,
    // finds no PAT, returns exit 0. The install completes end-to-end.
    await install(['skill:a']); // no throw

    const manifest = await readManifest(fixture.manifestPath);
    expect(findEntry(manifest, 'skill:a', 'user', 'claude')).toBeDefined();
    // The out-of-selection secret is provably not what made this pass: the
    // leaking artefact was simply absent from the scanned union.
    expect(findEntry(manifest, 'skill:autre', 'user', 'claude')).toBeUndefined();
  });
});

describe('m9: inverse control — selecting the leaking skill blocks (mock actually fires)', () => {
  it('blocks skill:autre with a ScanBlockedError naming skills/autre/SKILL.md', async () => {
    let caught: unknown;
    try {
      await install(['skill:autre']);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ScanBlockedError);
    const err = caught as ScanBlockedError;
    expect(err.findings.some((f) => f.includes('common/skills/autre/SKILL.md'))).toBe(true);
    // Fail-closed: nothing written.
    const manifest = await readManifest(fixture.manifestPath);
    expect(findEntry(manifest, 'skill:autre', 'user', 'claude')).toBeUndefined();
  });
});
