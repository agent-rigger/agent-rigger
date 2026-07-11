/**
 * r26-atomicity.test.ts — Prove fail-closed atomicity of runRemoteInstall (R26).
 *
 * Strategy
 * --------
 * All tests use injected runners + tmp dirs (no real network, no real git).
 * The `makeAtomicityEnv` helper creates:
 *   - an isolated RIGGER_HOME with a catalogUrl in config.json
 *   - a content dir pre-populated with catalog.json + skill fixture
 *   - a fake runner that can be configured to succeed or fail at specific steps
 *
 * Scenarios
 * ---------
 * R26-1  Fetch failure (clone fails) → runRemoteInstall throws, 0 files written,
 *         manifest absent.
 *         Atomicity: withRemoteCheckout aborts before the callback runs, so
 *         readCatalogDir / scanEntries / buildClaudeAdapter / runInstall are
 *         never reached — nothing can be written.
 *
 * R26-2  Scan blocked (scanner returns ok:false, --force absent) → ScanBlockedError
 *         thrown, 0 files written, manifest absent.
 *         Atomicity: scan occurs BEFORE plan/apply; ScanBlockedError exits before
 *         buildClaudeAdapter / runInstall — no agent placed on disk, no deny-rule
 *         merged ("jamais d'agents-sans-deny").
 *
 * R26-3  Plan aggregation before apply: unknown entry id → UnknownEntryError from
 *         resolve(), 0 files written, manifest absent.
 *         Atomicity: resolve() is called after readCatalogDir but before
 *         buildClaudeAdapter / runInstall — the entire plan fails before any write.
 *
 * Out-of-scope note (YAGNI)
 * -------------------------
 * Partial disk failure during apply (e.g. write of file #3 fails after files #1-2
 * are already on disk) is covered by the backup-before-write mechanism in core/backup.ts,
 * not by a multi-op rollback. Implementing a multi-op rollback is out of scope for R26.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type CatalogEntry, type TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Scanner } from '@agent-rigger/core/scan';
import type { Verdict } from '@agent-rigger/core/types';

import { runCli } from '../src/cli';
import { pinStdoutIsTTY } from './fixtures/tty';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TAG_NAME = 'v1.0.0';
const SHA = 'cafebabecafebabecafebabecafebabecafebabe';

// ---------------------------------------------------------------------------
// Catalog fixtures
// ---------------------------------------------------------------------------

/** Skill entry that has a scan path (skills/<name>) — scannable. */
const SKILL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:demo',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

/**
 * Agent entry — included to prove R26-2 ("jamais d'agents-sans-deny").
 * An agent entry has a scan path (agents/<name>.md); if scan blocks, the agent
 * file must NOT be written to disk.
 */
const AGENT_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'agent:demo',
  nature: 'agent',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

const ALL_ENTRIES: CatalogEntry[] = [SKILL_ENTRY, AGENT_ENTRY];

// ---------------------------------------------------------------------------
// makeAtomicityEnv — isolated home + content dir
// ---------------------------------------------------------------------------

interface AtomicityEnv {
  env: { RIGGER_HOME: string };
  homeDir: string;
  contentDir: string;
  cleanupAll: () => Promise<void>;
  /** Replace the runner mid-test (e.g. to inject a failing clone). */
  setRunner: (r: CommandRunner) => void;
  getRunner: () => CommandRunner;
  /** Track whether tmpFactory cleanup was called. */
  getCleanupCalled: () => boolean;
  tmpFactory: TmpDirFactory;
}

async function makeAtomicityEnv(): Promise<AtomicityEnv> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-r26-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-r26-content-'));

  // Write catalog.json
  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 'r26-test-catalog' }, entries: ALL_ENTRIES }),
    'utf8',
  );

  // Write skill fixture
  await fs.mkdir(path.join(contentDir, 'skills', 'demo'), { recursive: true });
  await fs.writeFile(
    path.join(contentDir, 'skills', 'demo', 'SKILL.md'),
    '# Demo Skill\n\nAtomicity test fixture.',
    'utf8',
  );

  // Write agent fixture
  await fs.mkdir(path.join(contentDir, 'agents'), { recursive: true });
  await fs.writeFile(
    path.join(contentDir, 'agents', 'demo.md'),
    '# Demo Agent\n\nAtomicity test fixture.',
    'utf8',
  );

  // Write config.json with catalogUrl
  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }] }),
    'utf8',
  );

  const env = { RIGGER_HOME: homeDir };

  // Base runner that succeeds for ls-remote and clone operations
  let activeRunner: CommandRunner = buildSuccessRunner(contentDir);

  let cleanupCalled = false;

  const tmpFactory: TmpDirFactory = async () => ({
    path: contentDir,
    cleanup: async () => {
      cleanupCalled = true;
    },
  });

  return {
    env,
    homeDir,
    contentDir,
    cleanupAll: async () => {
      await fs.rm(homeDir, { recursive: true, force: true });
      await fs.rm(contentDir, { recursive: true, force: true });
    },
    setRunner: (r) => {
      activeRunner = r;
    },
    getRunner: () => activeRunner,
    getCleanupCalled: () => cleanupCalled,
    tmpFactory,
  };
}

/**
 * Build a runner that succeeds for all git operations used in the remote install
 * pipeline (ls-remote, clone, rev-parse).
 *
 * The contentDir is already provided by the tmpFactory; this runner just signals
 * success for each git sub-command so the install pipeline can proceed.
 */
function buildSuccessRunner(_contentDir: string): CommandRunner {
  return (_cmd, args) => {
    const argv = args ?? [];

    // git ls-remote --tags -- <url>
    if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${SHA}\trefs/tags/${TAG_NAME}\n`,
        stderr: '',
      });
    }

    // git ls-remote -- <url> HEAD
    if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\tHEAD\n`, stderr: '' });
    }

    // git clone → content already in contentDir, no-op
    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }

    // git -C <dir> rev-parse HEAD
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\n`, stderr: '' });
    }

    // Fallback: success
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };
}

/**
 * Build a runner where git clone exits non-zero (simulates network/auth failure).
 * ls-remote still succeeds (resolveVersion must work to reach withRemoteCheckout).
 */
function buildCloneFailRunner(): CommandRunner {
  return (_cmd, args) => {
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

    // clone fails — simulates auth or network failure
    if (argv[0] === 'clone') {
      return Promise.resolve({
        exitCode: 128,
        stdout: '',
        stderr: 'fatal: repository not found',
      });
    }

    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };
}

/** Scanner that always blocks (returns ok:false). */
const blockingScanner: Scanner = {
  scan(_source: string): Promise<Verdict> {
    return Promise.resolve({ ok: false, findings: ['suspected malware: evil-payload'] });
  },
};

/** Helper to check whether the manifest exists and has entries. */
async function readManifestEntries(
  env: { RIGGER_HOME: string },
): Promise<Array<{ id: string }>> {
  const targets = resolveUserTargets(env);
  const raw = await fs.readFile(targets.stateJson, 'utf8').catch(() => null);
  if (raw === null) return [];
  const parsed = JSON.parse(raw) as { artifacts?: Array<{ id: string }> };
  return parsed.artifacts ?? [];
}

/** Helper: count all files under a directory recursively. */
async function countFilesUnder(dir: string): Promise<number> {
  let count = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += await countFilesUnder(path.join(dir, entry.name));
    } else {
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Shared lifecycle
// ---------------------------------------------------------------------------

let env_: AtomicityEnv;

/**
 * Pin process.stdout.isTTY = false so the init/ad-hoc interactive picker branch
 * is never taken when this suite runs in a real terminal. The R26-CLI
 * "no proposeInstall injected → config-only" test asserts the non-TTY path; with
 * an ambient TTY the production code would enter the interactive proposeInstall
 * branch and await a real stdin prompt → 5s timeout (flaky in a real terminal).
 */
pinStdoutIsTTY(false);

beforeEach(async () => {
  env_ = await makeAtomicityEnv();
});

afterEach(async () => {
  await env_.cleanupAll();
});

// ---------------------------------------------------------------------------
// tty fixture sanity — proves pinStdoutIsTTY restores the exact pre-suite
// descriptor rather than merely forcing it back to `false` (the L13 bug).
// ---------------------------------------------------------------------------

let ttyDescriptorBeforeSuite: PropertyDescriptor | undefined;

beforeAll(() => {
  ttyDescriptorBeforeSuite = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
});

afterAll(() => {
  expect(Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')).toEqual(
    ttyDescriptorBeforeSuite,
  );
});

// ---------------------------------------------------------------------------
// R26-1 — Fetch failure (clone fails) → 0 files written, manifest absent
// ---------------------------------------------------------------------------

describe('R26-1 — clone failure → fail-closed, 0 files written', () => {
  /**
   * Atomicity basis: withRemoteCheckout throws RemoteFetchError when clone
   * exits non-zero. The callback (readCatalogDir → scan → plan → apply) is
   * never invoked, so nothing is written to RIGGER_HOME.
   */

  it('runCli returns non-zero exit code when clone fails', async () => {
    const cap = { lines: [] as string[], print: (m: string) => cap.lines.push(m) };

    const code = await runCli(['install', 'principal/skill:demo', '--yes'], {
      print: cap.print,
      env: env_.env,
      remote: {
        run: buildCloneFailRunner(),
        tmpFactory: env_.tmpFactory,
        scanner: blockingScanner, // scanner is irrelevant: clone fails first
      },
    });

    expect(code).not.toBe(0);
  });

  it('manifest does not exist when clone fails', async () => {
    await runCli(['install', 'principal/skill:demo', '--yes'], {
      print: () => {},
      env: env_.env,
      remote: {
        run: buildCloneFailRunner(),
        tmpFactory: env_.tmpFactory,
        scanner: blockingScanner,
      },
    }).catch(() => {});

    const entries = await readManifestEntries(env_.env);
    expect(entries).toHaveLength(0);
  });

  it('skill store directory is NOT created when clone fails', async () => {
    await runCli(['install', 'principal/skill:demo', '--yes'], {
      print: () => {},
      env: env_.env,
      remote: {
        run: buildCloneFailRunner(),
        tmpFactory: env_.tmpFactory,
        scanner: blockingScanner,
      },
    }).catch(() => {});

    const targets = resolveUserTargets(env_.env);
    const skillStorePath = path.join(targets.skillsDir, 'demo');
    const stat = await fs.stat(skillStorePath).catch(() => null);
    expect(stat).toBeNull();
  });

  it('RIGGER_HOME config dir contains only config.json (nothing written by install)', async () => {
    // Snapshot how many files are in RIGGER_HOME before the failed install.
    const targets = resolveUserTargets(env_.env);
    const configDir = path.dirname(targets.stateJson);
    const filesBefore = await countFilesUnder(configDir);

    await runCli(['install', 'principal/skill:demo', '--yes'], {
      print: () => {},
      env: env_.env,
      remote: {
        run: buildCloneFailRunner(),
        tmpFactory: env_.tmpFactory,
        scanner: blockingScanner,
      },
    }).catch(() => {});

    const filesAfter = await countFilesUnder(configDir);
    // No additional files should have been written.
    expect(filesAfter).toBe(filesBefore);
  });

  it('output mentions error (fetch/network failure surfaced to user)', async () => {
    const cap = { lines: [] as string[], print: (m: string) => cap.lines.push(m) };

    await runCli(['install', 'principal/skill:demo', '--yes'], {
      print: cap.print,
      env: env_.env,
      remote: {
        run: buildCloneFailRunner(),
        tmpFactory: env_.tmpFactory,
        scanner: blockingScanner,
      },
    }).catch(() => {});

    const out = cap.lines.join('\n').toLowerCase();
    expect(out).toMatch(/error|fatal|repository|fetch/);
  });
});

// ---------------------------------------------------------------------------
// R26-2 — Scan blocked → ScanBlockedError, 0 files written, no agent on disk
// ---------------------------------------------------------------------------

describe('R26-2 — scan blocked → fail-closed, 0 files written, no agent placed', () => {
  /**
   * Atomicity basis: scanEntries() is called AFTER readCatalogDir + frontier
   * guard but BEFORE buildClaudeAdapter / runInstall. A blocking verdict throws
   * ScanBlockedError before any file write — the plan is never built and apply
   * never runs.
   *
   * "jamais d'agents-sans-deny": the agent:demo entry would write an agents/demo.md
   * file to ~/.claude/agents/. Scan must block BEFORE that write.
   */

  it('runCli returns non-zero when scanner blocks', async () => {
    const cap = { lines: [] as string[], print: (m: string) => cap.lines.push(m) };

    const code = await runCli(['install', 'principal/skill:demo', '--yes'], {
      print: cap.print,
      env: env_.env,
      remote: {
        run: buildSuccessRunner(env_.contentDir),
        tmpFactory: env_.tmpFactory,
        scanner: blockingScanner,
      },
    });

    expect(code).not.toBe(0);
  });

  it('manifest is absent when scanner blocks', async () => {
    await runCli(['install', 'principal/skill:demo', '--yes'], {
      print: () => {},
      env: env_.env,
      remote: {
        run: buildSuccessRunner(env_.contentDir),
        tmpFactory: env_.tmpFactory,
        scanner: blockingScanner,
      },
    });

    const entries = await readManifestEntries(env_.env);
    expect(entries).toHaveLength(0);
  });

  it('skill store directory is NOT created when scanner blocks', async () => {
    await runCli(['install', 'principal/skill:demo', '--yes'], {
      print: () => {},
      env: env_.env,
      remote: {
        run: buildSuccessRunner(env_.contentDir),
        tmpFactory: env_.tmpFactory,
        scanner: blockingScanner,
      },
    });

    const targets = resolveUserTargets(env_.env);
    const skillStorePath = path.join(targets.skillsDir, 'demo');
    const stat = await fs.stat(skillStorePath).catch(() => null);
    expect(stat).toBeNull();
  });

  it('agent file is NOT written to ~/.claude/agents when scanner blocks (no-agents-without-deny invariant)', async () => {
    /**
     * This verifies the "jamais d'agents-sans-deny" invariant:
     * an agent entry must never reach disk if the scan gate blocks.
     * The scan happens BEFORE apply, so agent:demo.md is never written.
     */
    await runCli(['install', 'principal/agent:demo', '--yes'], {
      print: () => {},
      env: env_.env,
      remote: {
        run: buildSuccessRunner(env_.contentDir),
        tmpFactory: env_.tmpFactory,
        scanner: blockingScanner,
      },
    });

    const targets = resolveUserTargets(env_.env);
    const claudeDir = path.dirname(targets.claudeSettings);
    const agentPath = path.join(claudeDir, 'agents', 'demo.md');
    const stat = await fs.stat(agentPath).catch(() => null);
    expect(stat).toBeNull();
  });

  it('output mentions scan blocked or security', async () => {
    const cap = { lines: [] as string[], print: (m: string) => cap.lines.push(m) };

    await runCli(['install', 'principal/skill:demo', '--yes'], {
      print: cap.print,
      env: env_.env,
      remote: {
        run: buildSuccessRunner(env_.contentDir),
        tmpFactory: env_.tmpFactory,
        scanner: blockingScanner,
      },
    });

    const out = cap.lines.join('\n').toLowerCase();
    expect(out).toMatch(/scan|security|blocked|finding/);
  });

  it('output mentions the scanner finding (malware keyword)', async () => {
    const cap = { lines: [] as string[], print: (m: string) => cap.lines.push(m) };

    await runCli(['install', 'principal/skill:demo', '--yes'], {
      print: cap.print,
      env: env_.env,
      remote: {
        run: buildSuccessRunner(env_.contentDir),
        tmpFactory: env_.tmpFactory,
        scanner: blockingScanner,
      },
    });

    const out = cap.lines.join('\n');
    expect(out).toContain('malware');
  });

  it('cleanup is called even when scan blocks (withRemoteCheckout finally guard)', async () => {
    await runCli(['install', 'principal/skill:demo', '--yes'], {
      print: () => {},
      env: env_.env,
      remote: {
        run: buildSuccessRunner(env_.contentDir),
        tmpFactory: env_.tmpFactory,
        scanner: blockingScanner,
      },
    });

    expect(env_.getCleanupCalled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R26-3 — Unknown entry id → UnknownEntryError from resolve(), 0 files written
// ---------------------------------------------------------------------------

describe('R26-3 — unknown entry in plan → resolve() fails, 0 files written', () => {
  /**
   * Atomicity basis: resolve(ids, effective) is called before buildClaudeAdapter
   * and before runInstall. When an id is not in the catalog, UnknownEntryError
   * is thrown — the plan is never built and apply never runs.
   *
   * This scenario covers the "plan agrégé avant apply" requirement: all ids
   * must be resolvable before any file is written.
   */

  it('runCli returns non-zero when requested id is not in the catalog', async () => {
    const cap = { lines: [] as string[], print: (m: string) => cap.lines.push(m) };
    const { stubScanner } = await import('@agent-rigger/core/scan');

    const code = await runCli(['install', 'skill:nonexistent', '--yes'], {
      print: cap.print,
      env: env_.env,
      remote: {
        run: buildSuccessRunner(env_.contentDir),
        tmpFactory: env_.tmpFactory,
        scanner: stubScanner,
      },
    });

    expect(code).not.toBe(0);
  });

  it('manifest does not exist when unknown id prevents install', async () => {
    const { stubScanner } = await import('@agent-rigger/core/scan');

    await runCli(['install', 'skill:nonexistent', '--yes'], {
      print: () => {},
      env: env_.env,
      remote: {
        run: buildSuccessRunner(env_.contentDir),
        tmpFactory: env_.tmpFactory,
        scanner: stubScanner,
      },
    }).catch(() => {});

    const entries = await readManifestEntries(env_.env);
    expect(entries).toHaveLength(0);
  });

  it('skill store is NOT created when id resolution fails', async () => {
    const { stubScanner } = await import('@agent-rigger/core/scan');

    await runCli(['install', 'skill:nonexistent', '--yes'], {
      print: () => {},
      env: env_.env,
      remote: {
        run: buildSuccessRunner(env_.contentDir),
        tmpFactory: env_.tmpFactory,
        scanner: stubScanner,
      },
    }).catch(() => {});

    const targets = resolveUserTargets(env_.env);
    const skillStorePath = path.join(targets.skillsDir, 'nonexistent');
    const stat = await fs.stat(skillStorePath).catch(() => null);
    expect(stat).toBeNull();
  });

  it('when one valid + one invalid id are requested, nothing is written (all-or-nothing plan)', async () => {
    /**
     * Both ids must be resolved before any write happens.
     * skill:demo is valid; skill:nonexistent is not.
     * Even skill:demo must NOT be written if the plan cannot be fully resolved.
     */
    const { stubScanner } = await import('@agent-rigger/core/scan');

    await runCli(['install', 'principal/skill:demo', 'principal/skill:nonexistent', '--yes'], {
      print: () => {},
      env: env_.env,
      remote: {
        run: buildSuccessRunner(env_.contentDir),
        tmpFactory: env_.tmpFactory,
        scanner: stubScanner,
      },
    }).catch(() => {});

    // skill:demo must also be absent — the plan failed, nothing was applied.
    const entries = await readManifestEntries(env_.env);
    expect(entries.find((e) => e.id === 'skill:demo')).toBeUndefined();

    const targets = resolveUserTargets(env_.env);
    const skillStorePath = path.join(targets.skillsDir, 'demo');
    const stat = await fs.stat(skillStorePath).catch(() => null);
    expect(stat).toBeNull();
  });

  it('output mentions unknown artifact', async () => {
    const { stubScanner } = await import('@agent-rigger/core/scan');
    const cap = { lines: [] as string[], print: (m: string) => cap.lines.push(m) };

    await runCli(['install', 'skill:nonexistent', '--yes'], {
      print: cap.print,
      env: env_.env,
      remote: {
        run: buildSuccessRunner(env_.contentDir),
        tmpFactory: env_.tmpFactory,
        scanner: stubScanner,
      },
    }).catch(() => {});

    const out = cap.lines.join('\n').toLowerCase();
    expect(out).toMatch(/unknown|artifact|nonexistent/);
  });
});

// ---------------------------------------------------------------------------
// R26-CLI — runCli init wiring: proposeInstall injectable via prompts
// ---------------------------------------------------------------------------

describe('R26-CLI — init command: proposeInstall wired via deps.prompts', () => {
  /**
   * Proves Part 1 (cable):
   * - deps.prompts.proposeInstall is forwarded to runInit as proposeInstall.
   * - fetchCatalogFn is built from runner+tmpFactory and calls fetchCatalog.
   * - proposeInstall receives catalog with meta + entries.
   * - Empty selection → config persisted, no install.
   * - Non-empty selection with injected proposeInstall → install triggered.
   */

  it('proposeInstall is called with fetched catalog when injected via deps.prompts', async () => {
    let receivedCatalog: { meta: { name: string }; entries: Array<{ id: string }> } | undefined;
    const cap = { lines: [] as string[], print: (m: string) => cap.lines.push(m) };

    await runCli(['init'], {
      print: cap.print,
      env: env_.env,
      remote: {
        run: buildSuccessRunner(env_.contentDir),
        tmpFactory: env_.tmpFactory,
        scanner: blockingScanner,
      },
      prompts: {
        selectArtifacts: async () => [],
        selectScope: async () => 'user',
        confirmApply: async () => false,
        askUrl: async () => 'https://example.com/catalog.git',
        askMethod: async () => 'https',
        proposeInstall: async (catalog) => {
          receivedCatalog = catalog as typeof receivedCatalog;
          return [];
        },
      },
    });

    expect(receivedCatalog).toBeDefined();
    expect(receivedCatalog?.meta.name).toBe('r26-test-catalog');
    expect(receivedCatalog?.entries.length).toBeGreaterThan(0);
  });

  it('config is persisted when proposeInstall returns empty (user cancelled)', async () => {
    const { loadConfigFile } = await import('../src/config');

    const homeDir = env_.homeDir;
    const configDir = path.join(homeDir, '.config', 'agent-rigger');
    const configPath = path.join(configDir, 'config.json');

    // Remove existing config so init writes fresh
    await fs.rm(configPath, { force: true });

    await runCli(['init'], {
      print: () => {},
      env: env_.env,
      remote: {
        run: buildSuccessRunner(env_.contentDir),
        tmpFactory: env_.tmpFactory,
        scanner: blockingScanner,
      },
      prompts: {
        selectArtifacts: async () => [],
        selectScope: async () => 'user',
        confirmApply: async () => false,
        askUrl: async () => 'https://example.com/catalog.git',
        askMethod: async () => 'https',
        proposeInstall: async () => [],
      },
    });

    const saved = await loadConfigFile(configPath);
    expect(saved.catalogs?.[0]?.url).toBe('https://example.com/catalog.git');
  });

  it('no manifest entry when proposeInstall returns empty (user cancelled)', async () => {
    await runCli(['init'], {
      print: () => {},
      env: env_.env,
      remote: {
        run: buildSuccessRunner(env_.contentDir),
        tmpFactory: env_.tmpFactory,
        scanner: blockingScanner,
      },
      prompts: {
        selectArtifacts: async () => [],
        selectScope: async () => 'user',
        confirmApply: async () => false,
        askUrl: async () => 'https://example.com/catalog.git',
        askMethod: async () => 'https',
        proposeInstall: async () => [],
      },
    });

    const entries = await readManifestEntries(env_.env);
    expect(entries).toHaveLength(0);
  });

  it('exits 0 when init succeeds (config persisted)', async () => {
    const homeDir = env_.homeDir;
    const configDir = path.join(homeDir, '.config', 'agent-rigger');
    const configPath = path.join(configDir, 'config.json');
    await fs.rm(configPath, { force: true });

    const code = await runCli(['init'], {
      print: () => {},
      env: env_.env,
      remote: {
        run: buildSuccessRunner(env_.contentDir),
        tmpFactory: env_.tmpFactory,
        scanner: blockingScanner,
      },
      prompts: {
        selectArtifacts: async () => [],
        selectScope: async () => 'user',
        confirmApply: async () => false,
        askUrl: async () => 'https://example.com/catalog.git',
        askMethod: async () => 'https',
        proposeInstall: async () => [],
      },
    });

    expect(code).toBe(0);
  });

  it('no proposeInstall injected via deps.prompts → config-only mode, fetchCatalogFn never invoked', async () => {
    const { loadConfigFile } = await import('../src/config');

    const homeDir = env_.homeDir;
    const configDir = path.join(homeDir, '.config', 'agent-rigger');
    const configPath = path.join(configDir, 'config.json');
    await fs.rm(configPath, { force: true });

    // Spy wrapper around the base runner: records every (command, args) call.
    // The init wizard always calls the runner once — preflightAuth's ambient
    // probe `git ls-remote <url>` (cmd-init.ts → preflight-auth.ts), which runs
    // regardless of the proposeInstall/TTY gate. What must NOT happen in
    // config-only mode is any *catalog-fetch* call: fetchCatalogFn is only
    // built when proposeInstallFn is defined (cli.ts:1309), and
    // proposeInstallFn only becomes defined via test injection, --yes, or a
    // real TTY (cli.ts:1177-1274) — none apply here. A regression that takes
    // the TTY branch (cli.ts:1250) in a non-TTY context would wrongly build
    // proposeInstallFn/fetchCatalogFn and add resolveVersion's
    // `ls-remote --tags`/`ls-remote -- <url> HEAD` and fetchCatalog's `clone`
    // calls to this list, changing it from the single preflight probe below.
    const calls: Array<{ command: string; args: string[] }> = [];
    const baseRunner = buildSuccessRunner(env_.contentDir);
    const spyRunner: CommandRunner = (command, args) => {
      calls.push({ command, args: args ?? [] });
      return baseRunner(command, args);
    };

    // No proposeInstall key in prompts → config-only (non-TTY path)
    const code = await runCli(['init'], {
      print: () => {},
      env: env_.env,
      remote: {
        run: spyRunner,
        tmpFactory: env_.tmpFactory,
        scanner: blockingScanner,
      },
      prompts: {
        selectArtifacts: async () => [],
        selectScope: async () => 'user',
        confirmApply: async () => false,
        askUrl: async () => 'https://example.com/catalog.git',
        askMethod: async () => 'https',
        // proposeInstall deliberately absent
      },
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      { command: 'git', args: ['ls-remote', 'https://example.com/catalog.git'] },
    ]);

    const entries = await readManifestEntries(env_.env);
    expect(entries).toHaveLength(0);

    const saved = await loadConfigFile(configPath);
    expect(saved.catalogs?.[0]?.url).toBe('https://example.com/catalog.git');
  });
});
