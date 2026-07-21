/**
 * r5-remove-offline.test.ts — R5: remove operates from the manifest alone,
 * fully offline (lot2-remove-reversible, covers H10).
 *
 * Strategy:
 * - Ad-hoc install harness mirrors m8-adhoc-install.test.ts (fake runner +
 *   tmpFactory + clean scanner, RIGGER_HOME isolated in a tmp dir).
 * - Configured-catalog harness mirrors cli.test.ts (config.json with
 *   config.catalogs + fake clone dir).
 * - Every remove runs with a SENTINEL git runner that records and THROWS on
 *   any invocation — the proof that the remove path performs zero network.
 *
 * Scenarios (requirements.md R5):
 *  1. Install ad-hoc then remove offline           → exit 0, entry gone.
 *  2. Configured catalog unreachable               → success, no warning.
 *  3. Id absent from the manifest                  → exit 2, installed listed.
 *  4. Pack id                                      → exit 2, expansion notice.
 *  5. <resource> remove is local too               → nature from manifest.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { readManifest } from '@agent-rigger/core/manifest';
import type { Env } from '@agent-rigger/core/paths';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Scanner } from '@agent-rigger/core/scan';

import { runCli } from '../src/cli';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAKE_SHA = 'aabbccddeeff00112233445566778899aabbccdd';

const REMOTE_SKILL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:remote-demo',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

const GUARDRAIL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'guardrail:main',
  nature: 'guardrail',
  targets: ['claude'],
  scopes: ['user'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCapture(): { lines: string[]; print: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

/** Successful fake git runner (install phase only). */
function makeSuccessRunner(): CommandRunner {
  return (_cmd, args) => {
    const argv = args ?? [];
    if (argv.includes('ls-remote') && argv.includes('--tags')) {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${FAKE_SHA}\trefs/tags/v1.0.0\n`,
        stderr: '',
      });
    }
    if (argv.includes('ls-remote') && argv.includes('HEAD')) {
      return Promise.resolve({ exitCode: 0, stdout: `${FAKE_SHA}\tHEAD\n`, stderr: '' });
    }
    if (argv.includes('clone')) {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argv.includes('rev-parse')) {
      return Promise.resolve({ exitCode: 0, stdout: `${FAKE_SHA}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };
}

/**
 * Network sentinel: records every invocation and throws — proof that the
 * remove path never touches git/network (R5).
 */
function makeSentinelRunner(calls: string[]): CommandRunner {
  return (cmd, args) => {
    const line = [cmd, ...(args ?? [])].join(' ');
    calls.push(line);
    throw new Error(`network sentinel tripped — git invoked during remove: ${line}`);
  };
}

function makeSentinelTmpFactory(calls: string[]): TmpDirFactory {
  return () => {
    calls.push('tmpFactory');
    throw new Error('network sentinel tripped — tmpFactory invoked during remove');
  };
}

function cleanScanner(): Scanner {
  return { scan: (_source: string) => Promise.resolve({ ok: true }) };
}

// ---------------------------------------------------------------------------
// Ad-hoc harness (no config.catalogs) — mirrors m8-adhoc-install.test.ts
// ---------------------------------------------------------------------------

async function makeAdHocEnv(): Promise<{
  env: Env;
  homeDir: string;
  contentDir: string;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  cleanupAll: () => Promise<void>;
}> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-r5-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-r5-content-'));

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 'r5-test-catalog' }, entries: [REMOTE_SKILL_ENTRY] }),
    'utf8',
  );

  await fs.mkdir(path.join(contentDir, 'common', 'skills', 'remote-demo'), { recursive: true });
  await fs.writeFile(
    path.join(contentDir, 'common', 'skills', 'remote-demo', 'SKILL.md'),
    '# Remote Demo\n\nOffline remove test skill.',
    'utf8',
  );

  // No config.json — config.catalogs is empty (ad-hoc path).
  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });

  const env: Env = { RIGGER_HOME: homeDir };
  const runner = makeSuccessRunner();

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

async function installAdHocSkill(ctx: Awaited<ReturnType<typeof makeAdHocEnv>>): Promise<void> {
  const code = await runCli(
    ['install', 'https://github.com/owner/bar.git', '--yes'],
    {
      print: makeCapture().print,
      env: ctx.env,
      remote: { run: ctx.runner, tmpFactory: ctx.tmpFactory, scanner: cleanScanner() },
    },
  );
  expect(code).toBe(0);
}

// ---------------------------------------------------------------------------
// Configured-catalog harness — mirrors cli.test.ts remove suites
// ---------------------------------------------------------------------------

async function makeConfiguredEnv(): Promise<{
  env: Env;
  homeDir: string;
  catalogDir: string;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  cleanupAll: () => Promise<void>;
}> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-r5-cfg-home-'));
  const catalogDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-r5-cfg-catalog-'));

  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });
  await Bun.write(
    path.join(configDir, 'config.json'),
    JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }] }),
  );

  const tmpFactory: TmpDirFactory = async () => {
    await Bun.write(
      path.join(catalogDir, 'catalog.json'),
      JSON.stringify({ meta: { name: 'r5-cfg-catalog' }, entries: [GUARDRAIL_ENTRY] }),
    );
    const guardrailDir = path.join(catalogDir, 'claude', 'guardrails', 'main');
    await fs.mkdir(guardrailDir, { recursive: true });
    await Bun.write(
      path.join(guardrailDir, 'deny.json'),
      JSON.stringify({ deny: ['fake-deny-rule'] }),
    );
    await Bun.write(path.join(guardrailDir, 'allow.json'), JSON.stringify({ allow: [] }));
    return { path: catalogDir, cleanup: async () => {} };
  };

  const cleanupAll = async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(catalogDir, { recursive: true, force: true });
  };

  return {
    env: { RIGGER_HOME: homeDir },
    homeDir,
    catalogDir,
    runner: makeSuccessRunner(),
    tmpFactory,
    cleanupAll,
  };
}

async function installConfiguredGuardrail(
  ctx: Awaited<ReturnType<typeof makeConfiguredEnv>>,
): Promise<void> {
  const code = await runCli(['install', 'principal/guardrail:main', '--yes'], {
    print: makeCapture().print,
    env: ctx.env,
    remote: { run: ctx.runner, tmpFactory: ctx.tmpFactory },
  });
  expect(code).toBe(0);
}

// ---------------------------------------------------------------------------
// Scenario 1 — ad-hoc install then remove, fully offline
// ---------------------------------------------------------------------------

describe('lot2-R5 — ad-hoc install then remove offline', () => {
  let ctx: Awaited<ReturnType<typeof makeAdHocEnv>>;

  beforeEach(async () => {
    ctx = await makeAdHocEnv();
    await installAdHocSkill(ctx);
  });

  afterEach(async () => {
    await ctx.cleanupAll();
  });

  it('lot2-R5: remove of the qualified ad-hoc id succeeds with a sentinel git runner (zero network)', async () => {
    const calls: string[] = [];
    const cap = makeCapture();

    const code = await runCli(['remove', 'gh-bar/skill:remote-demo', '--yes'], {
      print: cap.print,
      env: ctx.env,
      remote: { run: makeSentinelRunner(calls), tmpFactory: makeSentinelTmpFactory(calls) },
    });

    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('lot2-R5: remove deletes the manifest entry and the installed skill target', async () => {
    const calls: string[] = [];
    const targets = resolveUserTargets(ctx.env);

    await runCli(['remove', 'gh-bar/skill:remote-demo', '--yes'], {
      print: makeCapture().print,
      env: ctx.env,
      remote: { run: makeSentinelRunner(calls), tmpFactory: makeSentinelTmpFactory(calls) },
    });

    const manifest = await readManifest(targets.stateJson);
    expect(manifest.artifacts.find((a) => a.id === 'gh-bar/skill:remote-demo')).toBeUndefined();

    const skillTarget = path.join(targets.skillsDir, 'remote-demo');
    const stat = await fs.lstat(skillTarget).catch(() => null);
    expect(stat).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — configured catalog unreachable: no fetch, no warning
// ---------------------------------------------------------------------------

describe('lot2-R5 — remove with config.catalogs configured and network down', () => {
  let ctx: Awaited<ReturnType<typeof makeConfiguredEnv>>;

  beforeEach(async () => {
    ctx = await makeConfiguredEnv();
    await installConfiguredGuardrail(ctx);
  });

  afterEach(async () => {
    await ctx.cleanupAll();
  });

  it('lot2-R5: remove succeeds without any "Catalog unavailable" warning — no fetch is attempted', async () => {
    const calls: string[] = [];
    const cap = makeCapture();

    const code = await runCli(['remove', 'principal/guardrail:main', '--yes'], {
      print: cap.print,
      env: ctx.env,
      remote: { run: makeSentinelRunner(calls), tmpFactory: makeSentinelTmpFactory(calls) },
    });

    const output = cap.lines.join('\n');
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(output).not.toContain('unavailable');
    expect(output).not.toMatch(/\[warning\] Catalog/);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — id absent from the manifest: exit 2, installed entries listed
// ---------------------------------------------------------------------------

describe('lot2-R5 — remove of an id absent from the manifest', () => {
  let ctx: Awaited<ReturnType<typeof makeConfiguredEnv>>;

  beforeEach(async () => {
    ctx = await makeConfiguredEnv();
    await installConfiguredGuardrail(ctx);
  });

  afterEach(async () => {
    await ctx.cleanupAll();
  });

  it('lot2-R5: exits 2 and names the id, with zero fetch', async () => {
    const calls: string[] = [];
    const cap = makeCapture();

    const code = await runCli(['remove', 'principal/skill:never-installed', '--yes'], {
      print: cap.print,
      env: ctx.env,
      remote: { run: makeSentinelRunner(calls), tmpFactory: makeSentinelTmpFactory(calls) },
    });

    const output = cap.lines.join('\n');
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    expect(output).toContain('principal/skill:never-installed');
    expect(output.toLowerCase()).toContain('not installed');
  });

  it('lot2-R5: message lists the entries actually installed (from the manifest), never "agent-rigger ls"', async () => {
    const cap = makeCapture();

    await runCli(['remove', 'principal/skill:never-installed', '--yes'], {
      print: cap.print,
      env: ctx.env,
      remote: { run: makeSentinelRunner([]), tmpFactory: makeSentinelTmpFactory([]) },
    });

    const output = cap.lines.join('\n');
    expect(output).toContain('principal/guardrail:main');
    expect(output).not.toContain('agent-rigger ls');
    expect(output).not.toContain('rigger ls');
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — pack id: packs are expanded at install, removed via members
// ---------------------------------------------------------------------------

describe('lot2-R5 — remove of a pack id', () => {
  let ctx: Awaited<ReturnType<typeof makeConfiguredEnv>>;

  beforeEach(async () => {
    ctx = await makeConfiguredEnv();
    await installConfiguredGuardrail(ctx);
  });

  afterEach(async () => {
    await ctx.cleanupAll();
  });

  it('lot2-R5: exits 2 and explains packs are expanded at install and removed via their members', async () => {
    const calls: string[] = [];
    const cap = makeCapture();

    const code = await runCli(['remove', 'principal/pack:harness', '--yes'], {
      print: cap.print,
      env: ctx.env,
      remote: { run: makeSentinelRunner(calls), tmpFactory: makeSentinelTmpFactory(calls) },
    });

    const output = cap.lines.join('\n');
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    expect(output.toLowerCase()).toContain('not installed');
    expect(output.toLowerCase()).toMatch(/expanded at install/);
    expect(output.toLowerCase()).toMatch(/member/);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — <resource> remove path is local too
// ---------------------------------------------------------------------------

describe('lot2-R5 — <resource> remove without network', () => {
  let ctx: Awaited<ReturnType<typeof makeAdHocEnv>>;

  beforeEach(async () => {
    ctx = await makeAdHocEnv();
    await installAdHocSkill(ctx);
  });

  afterEach(async () => {
    await ctx.cleanupAll();
  });

  it('lot2-R5: skills remove succeeds offline — nature validated from manifest.nature, zero fetch', async () => {
    const calls: string[] = [];
    const cap = makeCapture();

    const code = await runCli(['skills', 'remove', 'gh-bar/skill:remote-demo', '--yes'], {
      print: cap.print,
      env: ctx.env,
      remote: { run: makeSentinelRunner(calls), tmpFactory: makeSentinelTmpFactory(calls) },
    });

    expect(code).toBe(0);
    expect(calls).toHaveLength(0);

    const targets = resolveUserTargets(ctx.env);
    const manifest = await readManifest(targets.stateJson);
    expect(manifest.artifacts.find((a) => a.id === 'gh-bar/skill:remote-demo')).toBeUndefined();
  });

  it('lot2-R5: nature mismatch is rejected locally from the manifest (agents remove <skill id>)', async () => {
    const calls: string[] = [];
    const cap = makeCapture();

    const code = await runCli(['agents', 'remove', 'gh-bar/skill:remote-demo', '--yes'], {
      print: cap.print,
      env: ctx.env,
      remote: { run: makeSentinelRunner(calls), tmpFactory: makeSentinelTmpFactory(calls) },
    });

    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    expect(cap.lines.join('\n')).toContain('is not a agent');
  });
});
