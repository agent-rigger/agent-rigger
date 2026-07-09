/**
 * t4-scanner-apply-time.test.ts — Real apply-time scanner, shared + memoized (T4).
 *
 * T3 made the pre-apply gate (scanEntries) comprehensive; it runs before every
 * apply and already closes the active security hole. T4 makes the SECOND layer
 * — the adapter's apply-time re-check (`scanner.scan(linkOp.source)` in
 * applySkill) — real instead of a permanently-passing stub, without spawning
 * the underlying scan tool (gitleaks/trivy) twice for the same content.
 *
 * Two independent claims, proven separately (their observable effects overlap
 * if tested together — see rationale inline):
 *
 * 1. "2nd layer is real, not a stub" (buildClaudeAdapter / buildOpencodeAdapter
 *    describe blocks below) — isolated from scanEntries entirely: build an
 *    adapter with an injected blocking scanner and call plan()+apply()
 *    directly. Only possible to observe this if the builder threads
 *    opts.scanner through to applySkill instead of the hardcoded stub.
 *
 * 2. "no double-spawn" (runRemoteInstall / runUpdate describe blocks below):
 *    a spy scanner shared through opts.scanner is invoked exactly once for
 *    the skill's checkout path across the WHOLE install (gate + apply),
 *    proving the same memoized instance backs both call sites rather than
 *    two independent (real) scanners.
 *
 * Claim 1 pins the builder threading (reverting a builder to the stub fails it).
 * Claim 2 pins memoization + instance sharing (two non-shared real scanners
 * would show 2 calls for the skill path instead of 1). Note: the `!force`-only
 * threading at the call sites is defense-in-depth that stays redundant while
 * apply-time coverage (skills) is a subset of the gate's — the gate scans every
 * applied skill first — so dropping it has no observable runtime effect here and
 * no test pins that branch by effect; it guards against a future narrowing of
 * the gate's coverage.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ArtifactEntry, CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { Scanner } from '@agent-rigger/core/scan';
import type { WriteOpLink } from '@agent-rigger/core/types';

import { buildClaudeAdapter } from '../src/cli';
import { runUpdate } from '../src/cmd-update';
import { buildOpencodeAdapter } from '../src/opencode-adapter-builder';
import { runRemoteInstall, scanPathFor } from '../src/remote-install';

// ---------------------------------------------------------------------------
// Shared fake-scanner builders
// ---------------------------------------------------------------------------

function blockingScanner(findings: string[]): Scanner {
  return { scan: (_source: string) => Promise.resolve({ ok: false, findings }) };
}

/** Records every path scanned; always passes. */
function spyScanner(): { scanner: Scanner; calls: string[] } {
  const calls: string[] = [];
  const scanner: Scanner = {
    scan: (source: string) => {
      calls.push(source);
      return Promise.resolve({ ok: true });
    },
  };
  return { scanner, calls };
}

// ---------------------------------------------------------------------------
// Claim 1a — buildClaudeAdapter: apply-time scanner is real, isolated from
// scanEntries (no gate involved at all — plan()+apply() called directly).
// ---------------------------------------------------------------------------

async function makeTmpDir(prefix: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

async function makeExternalSkillFixture(baseDir: string, name: string): Promise<string> {
  const extDir = path.join(baseDir, 'external');
  const skillDir = path.join(extDir, 'skills', name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `# ${name}\nFixture.`);
  return extDir;
}

describe('buildClaudeAdapter — apply-time scanner is real (T4, isolated from the gate)', () => {
  let tmp: Awaited<ReturnType<typeof makeTmpDir>>;
  let env: Env;

  beforeEach(async () => {
    tmp = await makeTmpDir('rigger-t4-claude-');
    env = { RIGGER_HOME: path.join(tmp.dir, 'home') };
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('throws SkillScanBlockedError when opts.scanner blocks the skill source (no scanEntries in the loop)', async () => {
    const extDir = await makeExternalSkillFixture(tmp.dir, 'demo');
    const entry: AdapterEntry = { id: 'skill:demo', nature: 'skill', scope: 'user' };

    const adapter = await buildClaudeAdapter(env, {
      externalIds: new Set(['skill:demo']),
      externalBaseDir: extDir,
      scanner: blockingScanner(['[fake] secret found']),
    });

    const ops = await adapter.plan(entry, 'user', env);
    expect(ops).toHaveLength(1);

    await expect(adapter.apply(ops, env)).rejects.toThrow(/Skill scan blocked/);
  });

  it('does not write to the store when the injected apply-time scanner blocks', async () => {
    const extDir = await makeExternalSkillFixture(tmp.dir, 'demo');
    const entry: AdapterEntry = { id: 'skill:demo', nature: 'skill', scope: 'user' };

    const adapter = await buildClaudeAdapter(env, {
      externalIds: new Set(['skill:demo']),
      externalBaseDir: extDir,
      scanner: blockingScanner(['[fake] secret found']),
    });

    const ops = await adapter.plan(entry, 'user', env);
    await adapter.apply(ops, env).catch(() => {});

    const targets = resolveUserTargets(env);
    const stat = await fs.stat(path.join(targets.skillsDir, 'demo')).catch(() => null);
    expect(stat).toBeNull();
  });

  it('calls opts.scanner exactly once, with the exact WriteOpLink.source, on a clean install', async () => {
    const extDir = await makeExternalSkillFixture(tmp.dir, 'demo');
    const entry: AdapterEntry = { id: 'skill:demo', nature: 'skill', scope: 'user' };

    const { scanner, calls } = spyScanner();
    const adapter = await buildClaudeAdapter(env, {
      externalIds: new Set(['skill:demo']),
      externalBaseDir: extDir,
      scanner,
    });

    const ops = await adapter.plan(entry, 'user', env);
    const linkOp = ops[0] as WriteOpLink;
    await adapter.apply(ops, env);

    expect(calls).toEqual([linkOp.source]);
  });

  it('falls back to the stub (succeeds despite content) when no scanner opt is passed — non-regression', async () => {
    const extDir = await makeExternalSkillFixture(tmp.dir, 'demo');
    const entry: AdapterEntry = { id: 'skill:demo', nature: 'skill', scope: 'user' };

    const adapter = await buildClaudeAdapter(env, {
      externalIds: new Set(['skill:demo']),
      externalBaseDir: extDir,
      // no scanner
    });

    const ops = await adapter.plan(entry, 'user', env);
    await expect(adapter.apply(ops, env)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Claim 1b — buildOpencodeAdapter parity: same wiring, same proof.
// ---------------------------------------------------------------------------

describe('buildOpencodeAdapter — apply-time scanner is real (T4, isolated from the gate)', () => {
  let tmp: Awaited<ReturnType<typeof makeTmpDir>>;
  let env: Env;

  beforeEach(async () => {
    tmp = await makeTmpDir('rigger-t4-opencode-');
    env = { RIGGER_HOME: path.join(tmp.dir, 'home') };
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('throws SkillScanBlockedError when opts.scanner blocks the skill source', async () => {
    const extDir = await makeExternalSkillFixture(tmp.dir, 'demo');
    const entry: AdapterEntry = { id: 'skill:demo', nature: 'skill', scope: 'user' };

    const adapter = await buildOpencodeAdapter(env, {
      externalIds: new Set(['skill:demo']),
      externalBaseDir: extDir,
      scanner: blockingScanner(['[fake] secret found']),
    });

    const ops = await adapter.plan(entry, 'user', env);
    expect(ops).toHaveLength(1);

    await expect(adapter.apply(ops, env)).rejects.toThrow(/Skill scan blocked/);
  });

  it('falls back to the stub when no scanner opt is passed — non-regression', async () => {
    const extDir = await makeExternalSkillFixture(tmp.dir, 'demo');
    const entry: AdapterEntry = { id: 'skill:demo', nature: 'skill', scope: 'user' };

    const adapter = await buildOpencodeAdapter(env, {
      externalIds: new Set(['skill:demo']),
      externalBaseDir: extDir,
    });

    const ops = await adapter.plan(entry, 'user', env);
    await expect(adapter.apply(ops, env)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// path_match — scanPathFor(skill, baseDir) resolves to the SAME absolute path
// as the WriteOpLink.source the adapter scans at apply time. This is what
// makes the memoized cache actually hit instead of miss-then-scan-again.
// ---------------------------------------------------------------------------

describe('scanPathFor(skill) === WriteOpLink.source (T4 — cache-hit precondition)', () => {
  it('resolves identically for the same baseDir/externalBaseDir', async () => {
    const tmp = await makeTmpDir('rigger-t4-pathmatch-');
    try {
      const extDir = await makeExternalSkillFixture(tmp.dir, 'demo');
      const env: Env = { RIGGER_HOME: path.join(tmp.dir, 'home') };
      const entry: AdapterEntry = { id: 'skill:demo', nature: 'skill', scope: 'user' };

      const adapter = await buildClaudeAdapter(env, {
        externalIds: new Set(['skill:demo']),
        externalBaseDir: extDir,
      });
      const ops = await adapter.plan(entry, 'user', env);
      const linkOp = ops[0] as WriteOpLink;

      const catalogEntry: ArtifactEntry = {
        kind: 'artifact',
        id: 'skill:demo',
        nature: 'skill',
        targets: ['claude'],
        scopes: ['user', 'project'],
      };
      const gatePath = scanPathFor(catalogEntry, extDir);
      expect(gatePath).not.toBeNull();

      expect(linkOp.source).toBe(gatePath as string);
      expect(path.resolve(linkOp.source)).toBe(path.resolve(gatePath as string));
    } finally {
      await tmp.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Claim 2a — runRemoteInstall: shared memoized scanner, gate + apply combined
// scan the skill's checkout path exactly once (LA preuve clé — anti-double-spawn).
// ---------------------------------------------------------------------------

const TAG_NAME = 'v1.0.0';
const SHA = 'cafebabecafebabecafebabecafebabecafebabe';

const REMOTE_SKILL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:remote-demo',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

async function makeRemoteEnv(): Promise<{
  env: Env;
  contentDir: string;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  cleanupAll: () => Promise<void>;
}> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t4-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t4-content-'));

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 't4-test-catalog' }, entries: [REMOTE_SKILL_ENTRY] }),
    'utf8',
  );

  await fs.mkdir(path.join(contentDir, 'skills', 'remote-demo'), { recursive: true });
  await fs.writeFile(
    path.join(contentDir, 'skills', 'remote-demo', 'SKILL.md'),
    '# Remote Demo Skill\n\nFixture.',
    'utf8',
  );

  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify({ catalogUrl: 'https://example.com/catalog.git' }),
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
    return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' });
  };

  const tmpFactory: TmpDirFactory = async () => ({ path: contentDir, cleanup: async () => {} });

  const cleanupAll = async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(contentDir, { recursive: true, force: true });
  };

  return { env, contentDir, runner, tmpFactory, cleanupAll };
}

describe('runRemoteInstall — shared memoized scanner scans the skill path exactly once (T4)', () => {
  let remoteEnv: Awaited<ReturnType<typeof makeRemoteEnv>>;
  let targets: ReturnType<typeof resolveUserTargets>;

  beforeEach(async () => {
    remoteEnv = await makeRemoteEnv();
    targets = resolveUserTargets(remoteEnv.env);
  });

  afterEach(async () => {
    await remoteEnv.cleanupAll();
  });

  it('scans catalog.json once and skills/remote-demo once — not twice — across gate + apply', async () => {
    const { scanner, calls } = spyScanner();

    const result = await runRemoteInstall({
      ids: ['skill:remote-demo'],
      catalogUrl: 'https://example.com/catalog.git',
      scope: 'user',
      env: remoteEnv.env,
      manifestPath: targets.stateJson,
      runner: remoteEnv.runner,
      tmpFactory: remoteEnv.tmpFactory,
      confirm: true,
      scanner,
    });

    expect(result.applied).toBe(true);

    const skillPath = path.join(remoteEnv.contentDir, 'skills', 'remote-demo');
    const catalogPath = path.join(remoteEnv.contentDir, 'catalog.json');

    const skillCalls = calls.filter((c) => c === skillPath);
    const catalogCalls = calls.filter((c) => c === catalogPath);

    expect(skillCalls).toHaveLength(1);
    expect(catalogCalls).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it('the skill is actually written to the store (apply really ran, not skipped)', async () => {
    const { scanner } = spyScanner();

    await runRemoteInstall({
      ids: ['skill:remote-demo'],
      catalogUrl: 'https://example.com/catalog.git',
      scope: 'user',
      env: remoteEnv.env,
      manifestPath: targets.stateJson,
      runner: remoteEnv.runner,
      tmpFactory: remoteEnv.tmpFactory,
      confirm: true,
      scanner,
    });

    const stat = await fs.stat(path.join(targets.skillsDir, 'remote-demo')).catch(() => null);
    expect(stat).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Claim 2b — runUpdate parity: same shared-instance, single-scan guarantee.
// ---------------------------------------------------------------------------

describe('runUpdate — shared memoized scanner scans the skill path exactly once (T4)', () => {
  it('scans catalog.json once and skills/remote-demo once — not twice — across gate + apply', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t4-update-home-'));
    const configDir = path.join(homeDir, '.config', 'agent-rigger');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }] }),
      'utf8',
    );

    const env: Env = { RIGGER_HOME: homeDir };
    const targets = resolveUserTargets(env);

    const SHA_V1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const SHA_V2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const TAG_V1 = 'v1.0.0';
    const TAG_V2 = 'v1.1.0';

    let currentTag = TAG_V2;
    let currentSha = SHA_V2;
    let contentDir = '';

    const runner: CommandRunner = (_cmd, args) => {
      const argv = args ?? [];
      if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
        return Promise.resolve({
          exitCode: 0,
          stdout: `${currentSha}\trefs/tags/${currentTag}\n`,
          stderr: '',
        });
      }
      if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
        return Promise.resolve({ exitCode: 0, stdout: `${currentSha}\tHEAD\n`, stderr: '' });
      }
      if (argv[0] === 'clone') {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      }
      if (argv[0] === '-C' && argv[2] === 'rev-parse') {
        return Promise.resolve({ exitCode: 0, stdout: `${currentSha}\n`, stderr: '' });
      }
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' });
    };

    const tmpFactory: TmpDirFactory = async () => {
      contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t4-update-content-'));
      await fs.writeFile(
        path.join(contentDir, 'catalog.json'),
        JSON.stringify({ meta: { name: 't4-update-catalog' }, entries: [REMOTE_SKILL_ENTRY] }),
        'utf8',
      );
      await fs.mkdir(path.join(contentDir, 'skills', 'remote-demo'), { recursive: true });
      await fs.writeFile(
        path.join(contentDir, 'skills', 'remote-demo', 'SKILL.md'),
        '# Remote Demo Skill v2\n\nUpdated fixture.',
        'utf8',
      );
      return { path: contentDir, cleanup: async () => {} };
    };

    try {
      // Pre-install at v1.0.0 via runRemoteInstall (stub scanner — not under test here).
      currentTag = TAG_V1;
      currentSha = SHA_V1;
      await runRemoteInstall({
        ids: ['skill:remote-demo'],
        catalogUrl: 'https://example.com/catalog.git',
        scope: 'user',
        env,
        manifestPath: targets.stateJson,
        runner,
        tmpFactory,
        confirm: true,
      });
      await fs.rm(contentDir, { recursive: true, force: true }).catch(() => {});

      // Advance remote to v1.1.0 → stale. Update with a spy scanner shared
      // across gate + apply.
      currentTag = TAG_V2;
      currentSha = SHA_V2;
      const { scanner, calls } = spyScanner();

      const qualifiedId = 'principal/skill:remote-demo';
      const manifestRaw = JSON.parse(await fs.readFile(targets.stateJson, 'utf8')) as {
        artifacts: { id: string }[];
      };
      // Re-key the manifest entry under the qualified id runUpdate expects,
      // mirroring how a sourced install would have stored it.
      manifestRaw.artifacts = manifestRaw.artifacts.map((a) =>
        a.id === 'skill:remote-demo' ? { ...a, id: qualifiedId } : a
      );
      await fs.writeFile(targets.stateJson, JSON.stringify(manifestRaw, null, 2), 'utf8');

      const result = await runUpdate({
        ids: [qualifiedId],
        scope: 'user',
        env,
        manifestPath: targets.stateJson,
        catalogUrl: 'https://example.com/catalog.git',
        runner,
        tmpFactory,
        confirm: true,
        scanner,
      });

      expect(result.updated).toEqual([qualifiedId]);

      const skillPath = path.join(contentDir, 'skills', 'remote-demo');
      const catalogPath = path.join(contentDir, 'catalog.json');
      expect(calls.filter((c) => c === skillPath)).toHaveLength(1);
      expect(calls.filter((c) => c === catalogPath)).toHaveLength(1);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(contentDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
