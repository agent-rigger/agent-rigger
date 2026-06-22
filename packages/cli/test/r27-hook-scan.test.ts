/**
 * r27-hook-scan.test.ts — Prove that hook entries are scanned (R27.1).
 *
 * Strategy
 * --------
 * All tests use injected runners + tmp dirs (no real network, no real git).
 * The catalog contains a hook: entry. The content dir provides the hooks/
 * directory (including a shared lib) that syncToStore would copy to the store.
 *
 * Scenarios
 * ---------
 * R27-1  hook: entry + blockingScanner (ok:false), no --force
 *        → install is blocked (ScanBlockedError), 0 files in store, 0 hook
 *          entries in settings.json, exit non-0.
 *        Proves: hooks/ directory IS passed to the scanner.
 *
 * R27-2  hook: entry + blockingScanner (ok:false), with --force
 *        → warning emitted, install proceeds (hook appears in settings.json).
 *        Proves: --force respected for hooks.
 *
 * R27-3  Four hook: entries mapping to the same hooks/ dir + spy scanner
 *        → scanner is called exactly once for that directory (deduplication).
 *        Proves: Set-based deduplication in scanEntries.
 *
 * R27-4  scanPathFor returns hooks/ directory for nature === 'hook'.
 *        Unit test — no filesystem I/O needed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type CatalogEntry, type TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { Scanner } from '@agent-rigger/core/scan';

import { runCli } from '../src/cli';
import { ScanBlockedError, scanEntries, scanPathFor } from '../src/remote-install';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TAG_NAME = 'v1.0.0';
const SHA = 'aabbccddeeff00112233445566778899aabbccdd';

// ---------------------------------------------------------------------------
// Catalog fixtures
// ---------------------------------------------------------------------------

const HOOK_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'hook:pre-tool',
  nature: 'hook',
  targets: ['claude'],
  scopes: ['user', 'project'],
  event: 'PreToolUse',
  matcher: 'Bash',
};

const HOOK_ENTRY_2: CatalogEntry = {
  kind: 'artifact',
  id: 'hook:post-tool',
  nature: 'hook',
  targets: ['claude'],
  scopes: ['user', 'project'],
  event: 'PostToolUse',
  matcher: '*',
};

const HOOK_ENTRY_3: CatalogEntry = {
  kind: 'artifact',
  id: 'hook:stop',
  nature: 'hook',
  targets: ['claude'],
  scopes: ['user', 'project'],
  event: 'Stop',
  matcher: '*',
};

const HOOK_ENTRY_4: CatalogEntry = {
  kind: 'artifact',
  id: 'hook:submit',
  nature: 'hook',
  targets: ['claude'],
  scopes: ['user', 'project'],
  event: 'UserPromptSubmit',
  matcher: '*',
};

// ---------------------------------------------------------------------------
// makeHookEnv — isolated HOME + content dir with hooks/ layout
// ---------------------------------------------------------------------------

interface HookEnv {
  env: Env;
  homeDir: string;
  contentDir: string;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  cleanupAll: () => Promise<void>;
}

async function makeHookEnv(entries: CatalogEntry[]): Promise<HookEnv> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-r27-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-r27-content-'));

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 'r27-test-catalog' }, entries }),
    'utf8',
  );

  // Populate hooks/ directory with guard script + shared lib
  const hooksDir = path.join(contentDir, 'hooks');
  const sharedDir = path.join(hooksDir, '_shared');
  await fs.mkdir(sharedDir, { recursive: true });
  await fs.writeFile(
    path.join(hooksDir, 'pre-tool.ts'),
    '// pre-tool hook\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(hooksDir, 'post-tool.ts'),
    '// post-tool hook\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(hooksDir, 'stop.ts'),
    '// stop hook\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(hooksDir, 'submit.ts'),
    '// submit hook\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(sharedDir, 'hook-lib.ts'),
    '// shared hook library\nexport const VERSION = "1.0.0";\n',
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
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };

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

// ---------------------------------------------------------------------------
// Fake scanner builders
// ---------------------------------------------------------------------------

/** Scanner that always blocks with the given findings. */
function blockingScanner(findings: string[] = ['suspected malware: hook-payload']): Scanner {
  return { scan: () => Promise.resolve({ ok: false, findings }) };
}

/** Scanner that always passes. */
function cleanScanner(): Scanner {
  return { scan: () => Promise.resolve({ ok: true }) };
}

/** Scanner that records each path it is called with. */
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
// Helper: read hook commands registered in settings.json
// ---------------------------------------------------------------------------

async function readHookCommands(env: Env): Promise<string[]> {
  const targets = resolveUserTargets(env);
  const raw = await fs.readFile(targets.claudeSettings, 'utf8').catch(() => null);
  if (raw === null) return [];
  const parsed = JSON.parse(raw) as {
    hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };
  if (!parsed.hooks) return [];
  return Object.values(parsed.hooks)
    .flat()
    .flatMap((group) => group.hooks.map((h) => h.command));
}

// ---------------------------------------------------------------------------
// Shared lifecycle
// ---------------------------------------------------------------------------

let hookEnv: HookEnv;

beforeEach(async () => {
  hookEnv = await makeHookEnv([HOOK_ENTRY]);
});

afterEach(async () => {
  await hookEnv.cleanupAll();
});

// ---------------------------------------------------------------------------
// R27-4 — Unit: scanPathFor returns hooks/ directory for hook nature
// ---------------------------------------------------------------------------

describe('R27-4 — scanPathFor: hook nature → hooks/ directory', () => {
  it('returns path.join(baseDir, hooks) for nature=hook', () => {
    const baseDir = '/tmp/checkout';
    const entry: CatalogEntry = {
      kind: 'artifact',
      id: 'hook:pre-tool',
      nature: 'hook',
      targets: ['claude'],
      scopes: ['user'],
      event: 'PreToolUse',
      matcher: 'Bash',
    };
    expect(scanPathFor(entry, baseDir)).toBe(path.join(baseDir, 'hooks'));
  });

  it('returns the same hooks/ dir regardless of which hook id is scanned', () => {
    const baseDir = '/tmp/checkout';
    const entryA: CatalogEntry = {
      kind: 'artifact',
      id: 'hook:stop',
      nature: 'hook',
      targets: ['claude'],
      scopes: ['user'],
      event: 'Stop',
      matcher: '*',
    };
    const entryB: CatalogEntry = {
      kind: 'artifact',
      id: 'hook:submit',
      nature: 'hook',
      targets: ['claude'],
      scopes: ['user'],
      event: 'UserPromptSubmit',
      matcher: '*',
    };
    expect(scanPathFor(entryA, baseDir)).toBe(scanPathFor(entryB, baseDir));
  });

  it('still returns the individual file path for skill nature', () => {
    const baseDir = '/tmp/checkout';
    const entry: CatalogEntry = {
      kind: 'artifact',
      id: 'skill:demo',
      nature: 'skill',
      targets: ['claude'],
      scopes: ['user'],
    };
    expect(scanPathFor(entry, baseDir)).toBe(path.join(baseDir, 'skills', 'demo'));
  });

  it('still returns the individual file path for agent nature', () => {
    const baseDir = '/tmp/checkout';
    const entry: CatalogEntry = {
      kind: 'artifact',
      id: 'agent:demo',
      nature: 'agent',
      targets: ['claude'],
      scopes: ['user'],
    };
    expect(scanPathFor(entry, baseDir)).toBe(path.join(baseDir, 'agents', 'demo.md'));
  });
});

// ---------------------------------------------------------------------------
// R27-3 — scanEntries deduplication: 4 hooks → scanner called once for hooks/
// ---------------------------------------------------------------------------

describe('R27-3 — scanEntries: deduplicates hook paths', () => {
  it('calls scanner exactly once for hooks/ when 4 hook entries are present', async () => {
    const { scanner, calls } = spyScanner();
    const baseDir = '/tmp/checkout';

    await scanEntries({
      entries: [HOOK_ENTRY, HOOK_ENTRY_2, HOOK_ENTRY_3, HOOK_ENTRY_4],
      baseDir,
      scanner,
      force: false,
    });

    const hooksDirPath = path.join(baseDir, 'hooks');
    const hookCalls = calls.filter((c) => c === hooksDirPath);
    expect(hookCalls).toHaveLength(1);
    // Overall: exactly 1 scan call (all 4 hooks share the same directory)
    expect(calls).toHaveLength(1);
  });

  it('blocks on the hooks/ scan even when multiple hook entries share it', async () => {
    const baseDir = '/tmp/checkout';
    await expect(
      scanEntries({
        entries: [HOOK_ENTRY, HOOK_ENTRY_2],
        baseDir,
        scanner: blockingScanner(['evil-payload-in-shared-lib']),
        force: false,
      }),
    ).rejects.toBeInstanceOf(ScanBlockedError);
  });
});

// ---------------------------------------------------------------------------
// R27-1 — hook: entry + blockingScanner, no --force → blocked, 0 store files
// ---------------------------------------------------------------------------

describe('R27-1 — hook + blocking scanner, no --force → fail-closed', () => {
  /**
   * The hooks/ directory (including _shared/hook-lib.ts) is passed to the
   * scanner BEFORE any file is written. A blocking verdict must prevent:
   * - any hook script reaching the store
   * - any hook command registered in settings.json
   * - a non-zero exit code from runCli
   */

  it('runCli returns non-zero when scanner blocks a hook entry', async () => {
    const cap = { lines: [] as string[], print: (m: string) => cap.lines.push(m) };

    const code = await runCli(['install', 'hook:pre-tool', '--yes'], {
      print: cap.print,
      env: hookEnv.env,
      remote: {
        run: hookEnv.runner,
        tmpFactory: hookEnv.tmpFactory,
        scanner: blockingScanner(),
      },
    });

    expect(code).not.toBe(0);
  });

  it('no hook command is registered in settings.json when scanner blocks', async () => {
    await runCli(['install', 'hook:pre-tool', '--yes'], {
      print: () => {},
      env: hookEnv.env,
      remote: {
        run: hookEnv.runner,
        tmpFactory: hookEnv.tmpFactory,
        scanner: blockingScanner(),
      },
    });

    const commands = await readHookCommands(hookEnv.env);
    expect(commands).toHaveLength(0);
  });

  it('hooks store directory is NOT created when scanner blocks', async () => {
    await runCli(['install', 'hook:pre-tool', '--yes'], {
      print: () => {},
      env: hookEnv.env,
      remote: {
        run: hookEnv.runner,
        tmpFactory: hookEnv.tmpFactory,
        scanner: blockingScanner(),
      },
    });

    const targets = resolveUserTargets(hookEnv.env);
    const hooksStorePath = path.join(path.dirname(targets.stateJson), 'hooks');
    const stat = await fs.stat(hooksStorePath).catch(() => null);
    expect(stat).toBeNull();
  });

  it('output mentions scan finding when hook is blocked', async () => {
    const cap = { lines: [] as string[], print: (m: string) => cap.lines.push(m) };

    await runCli(['install', 'hook:pre-tool', '--yes'], {
      print: cap.print,
      env: hookEnv.env,
      remote: {
        run: hookEnv.runner,
        tmpFactory: hookEnv.tmpFactory,
        scanner: blockingScanner(['hook-payload']),
      },
    });

    const out = cap.lines.join('\n').toLowerCase();
    expect(out).toMatch(/scan|security|blocked|finding|hook-payload/);
  });
});

// ---------------------------------------------------------------------------
// R27-2 — hook: entry + blockingScanner, with --force → warns + proceeds
// ---------------------------------------------------------------------------

describe('R27-2 — hook + blocking scanner, with --force → warn + proceed', () => {
  /**
   * With --force a blocking scan emits a warning but install completes.
   * The hook command must appear in settings.json.
   */

  it('runCli returns 0 when scanner blocks but --force is set', async () => {
    const cap = { lines: [] as string[], print: (m: string) => cap.lines.push(m) };

    const code = await runCli(['install', 'hook:pre-tool', '--yes', '--force'], {
      print: cap.print,
      env: hookEnv.env,
      remote: {
        run: hookEnv.runner,
        tmpFactory: hookEnv.tmpFactory,
        scanner: blockingScanner(),
      },
    });

    expect(code).toBe(0);
  });

  it('output contains [warning] when --force overrides a blocking hook scan', async () => {
    const cap = { lines: [] as string[], print: (m: string) => cap.lines.push(m) };

    await runCli(['install', 'hook:pre-tool', '--yes', '--force'], {
      print: cap.print,
      env: hookEnv.env,
      remote: {
        run: hookEnv.runner,
        tmpFactory: hookEnv.tmpFactory,
        scanner: blockingScanner(),
      },
    });

    const out = cap.lines.join('\n');
    expect(out).toMatch(/\[warning\]/);
  });

  it('hook command is registered in settings.json when --force overrides scan block', async () => {
    await runCli(['install', 'hook:pre-tool', '--yes', '--force'], {
      print: () => {},
      env: hookEnv.env,
      remote: {
        run: hookEnv.runner,
        tmpFactory: hookEnv.tmpFactory,
        scanner: blockingScanner(),
      },
    });

    const commands = await readHookCommands(hookEnv.env);
    expect(commands.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// R27-CLEAN — hook + clean scanner → normal install (baseline)
// ---------------------------------------------------------------------------

describe('R27-CLEAN — hook + clean scanner → installs normally', () => {
  it('runCli returns 0 when scanner passes a hook entry', async () => {
    const code = await runCli(['install', 'hook:pre-tool', '--yes'], {
      print: () => {},
      env: hookEnv.env,
      remote: {
        run: hookEnv.runner,
        tmpFactory: hookEnv.tmpFactory,
        scanner: cleanScanner(),
      },
    });

    expect(code).toBe(0);
  });

  it('hook command is registered in settings.json after clean scan', async () => {
    await runCli(['install', 'hook:pre-tool', '--yes'], {
      print: () => {},
      env: hookEnv.env,
      remote: {
        run: hookEnv.runner,
        tmpFactory: hookEnv.tmpFactory,
        scanner: cleanScanner(),
      },
    });

    const commands = await readHookCommands(hookEnv.env);
    expect(commands.length).toBeGreaterThan(0);
  });

  it('spy scanner is called with the hooks/ directory path (not just the individual hook script)', async () => {
    const { scanner, calls } = spyScanner();

    await runCli(['install', 'hook:pre-tool', '--yes'], {
      print: () => {},
      env: hookEnv.env,
      remote: {
        run: hookEnv.runner,
        tmpFactory: hookEnv.tmpFactory,
        scanner,
      },
    });

    // The scan must have been called with the hooks/ directory (not hooks/pre-tool.ts)
    const scannedHooksDir = calls.some((c) => c.endsWith(path.join('hooks')));
    expect(scannedHooksDir).toBe(true);
    const scannedIndividualScript = calls.some((c) => c.endsWith('pre-tool.ts'));
    expect(scannedIndividualScript).toBe(false);
  });
});
