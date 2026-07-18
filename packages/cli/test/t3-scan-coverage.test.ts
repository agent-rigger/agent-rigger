/**
 * t3-scan-coverage.test.ts — Pre-apply scan coverage gaps closed (T3).
 *
 * Before this change, the pre-apply security gate (scanEntries / scanPathFor
 * in remote-install.ts) had three holes:
 *  (a) nature 'guardrail' was never scanned (no scan path derived for it).
 *  (b) catalog.json — where `mcp` server config (secrets in config.env) and
 *      `check`/`install` command strings for every nature live — was NEVER
 *      scanned, regardless of what was selected.
 *  (c) when a selection produced zero scannable paths (e.g. guardrail-only,
 *      before this change, or mcp-only, always), scanEntries early-returned
 *      silently — it never even verified scanner presence.
 *
 * This file proves the fix: guardrail (and context, investigated separately —
 * see below) now derive a scan path; catalog.json is scanned unconditionally
 * once per call; and the early-returns are gone so degraded/blocking verdicts
 * always surface, even for selections with no scannable natures.
 *
 * `context` investigation: contexts/<name>/AGENTS.md is fetched from the
 * checkout and read verbatim (adapter-builder.ts / opencode-adapter-builder.ts
 * both do `readText(path.join(externalBaseDir, 'contexts', name, 'AGENTS.md'))`)
 * — it becomes part of the assistant's system content, same risk class as a
 * skill/agent file. It DOES have a checkout to scan, so scanPathFor now covers
 * it too. `mcp` deliberately has NO branch: it is inline config in catalog.json,
 * not a checkout — covered by the unconditional catalog.json scan instead.
 *
 * Strategy:
 * - Fake Scanner injected everywhere — no real gitleaks/trivy spawned.
 * - Fake CommandRunner handles git ls-remote/clone/rev-parse (no network).
 * - mcp is opencode-only (claude has no mcp adapter support), so mcp-selection
 *   tests use assistant: 'opencode', mirroring h13-plugin-scan.test.ts.
 *
 * Scenarios:
 * 1. scanPathFor unit tests: guardrail (prefixed + legacy id), context, and a
 *    locked-in regression that mcp still returns null (covered via catalog.json
 *    instead — design decision, not an oversight).
 * 2. Secret-shaped catalog.json (mcp config.env token) + blocking scanner:
 *    no --force → ScanBlockedError, nothing written; --force → warning + installed.
 * 3. Guardrail-only selection (from a multi-nature catalog) → scanner sees
 *    catalog.json AND guardrails/<name>.
 * 4. catalog.json is scanned even for a minimal/no-checkout-path selection (mcp-only).
 * 5. Update parity: runUpdate (cmd-update.ts) scans catalog.json too — same
 *    coverage as runRemoteInstall because it shares scanEntries.
 * 6. Degraded (no scanner tool): warning surfaces even for a selection that had
 *    no scannable path before this change (mcp-only).
 * 7. Nominal: clean scanner + minimal catalog → catalog.json IS scanned, install
 *    proceeds without warning.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type CatalogEntry, type TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { findEntry, readManifest } from '@agent-rigger/core/manifest';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { Scanner } from '@agent-rigger/core/scan';
import { stubScanner } from '@agent-rigger/core/scan';

import { runCli } from '../src/cli';
import { runUpdate } from '../src/cmd-update';
import { runRemoteInstall, ScanBlockedError, scanEntries } from '../src/remote-install';
import { scanPathFor } from '../src/scan-paths';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TAG_NAME = 'v1.0.0';
const SHA = 'ccddeeff00112233445566778899aabbccddeeff';
const CATALOG_URL = 'https://example.com/content-repo.git';

// ---------------------------------------------------------------------------
// Catalog fixtures
// ---------------------------------------------------------------------------

/**
 * Secret-shaped mcp config, inline in catalog.json. `environment.TOKEN` is a
 * ref (lot 6, R6: a literal here is now a hard parse-time error, closed
 * BEFORE any scanner runs — see lot6-r6-mcp-form.test.ts, packages/catalog).
 * The fake scanners in this file don't inspect content — findings are
 * hardcoded by each test — so this fixture only needs to stay schema-valid;
 * it still exercises "does catalog.json get scanned at all" (T3-2/3-4/3-6/3-7),
 * the actual behaviour under test here.
 */
const MCP_LEAKY_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'mcp:leaky',
  nature: 'mcp',
  targets: ['opencode'],
  scopes: ['user', 'project'],
  config: {
    type: 'local',
    command: ['bunx', 'leaky-mcp-server'],
    environment: { TOKEN: '${TOKEN}' },
  },
};

const GUARDRAIL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'guardrail:main',
  nature: 'guardrail',
  targets: ['claude', 'opencode'],
  scopes: ['user', 'project'],
};

const CONTEXT_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'context:main',
  nature: 'context',
  targets: ['claude', 'opencode'],
  scopes: ['user', 'project'],
};

// A tool artefact: advisory check/install commands in catalog.json, no checkout
// of its own → scanPathFor returns null (case 'tool'). Exercised by m6 below.
const TOOL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'tool:glab',
  nature: 'tool',
  targets: ['claude', 'opencode'],
  scopes: ['user', 'project'],
};

const MULTI_NATURE_CATALOG: CatalogEntry[] = [MCP_LEAKY_ENTRY, GUARDRAIL_ENTRY, CONTEXT_ENTRY];

// ---------------------------------------------------------------------------
// Fake scanner builders
// ---------------------------------------------------------------------------

function blockingScanner(findings: string[]): Scanner {
  return { scan: (_source: string) => Promise.resolve({ ok: false, findings }) };
}

function cleanScanner(): Scanner {
  return { scan: (_source: string) => Promise.resolve({ ok: true }) };
}

function degradedScanner(): Scanner {
  return { scan: (_source: string) => Promise.resolve({ ok: true, degraded: true }) };
}

/** Sorted rel-paths of every leaf under `root` (symlinks are leaves, not followed). */
async function walkTree(root: string, dir: string = root): Promise<string[]> {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const d of dirents) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) {
      out.push(...(await walkTree(root, full)));
    } else {
      out.push(path.relative(root, full));
    }
  }
  return out.sort();
}

/**
 * Spy scanner that records each scanned source AND walks its tree at scan time —
 * before scanEntries tears the staging mirror down in its `finally`. `trees[i]`
 * is the sorted rel-path listing of the i-th scanned dir, i.e. the exact union
 * surface (R2). The union is scanned once, so a healthy run has calls.length===1.
 */
function spyScanner(): { scanner: Scanner; calls: string[]; trees: string[][] } {
  const calls: string[] = [];
  const trees: string[][] = [];
  const scanner: Scanner = {
    scan: async (source: string) => {
      calls.push(source);
      trees.push(await walkTree(source));
      return { ok: true };
    },
  };
  return { scanner, calls, trees };
}

// ---------------------------------------------------------------------------
// Scenario 1 — scanPathFor unit tests (guardrail, context, mcp regression)
// ---------------------------------------------------------------------------

describe('T3-1 — scanPathFor: guardrail nature', () => {
  it('returns guardrails/<name> for a "guardrail:"-prefixed id', () => {
    const baseDir = '/tmp/checkout';
    expect(scanPathFor(GUARDRAIL_ENTRY, baseDir)).toBe(path.join(baseDir, 'guardrails', 'main'));
  });

  it('returns guardrails/<id> for a legacy (unprefixed) guardrail id', () => {
    const baseDir = '/tmp/checkout';
    const legacy: CatalogEntry = {
      kind: 'artifact',
      id: 'guardrails-claude',
      nature: 'guardrail',
      targets: ['claude'],
      scopes: ['user'],
    };
    expect(scanPathFor(legacy, baseDir)).toBe(
      path.join(baseDir, 'guardrails', 'guardrails-claude'),
    );
  });

  it('strips the source qualifier before deriving the path', () => {
    const baseDir = '/tmp/checkout';
    const qualified: CatalogEntry = { ...GUARDRAIL_ENTRY, id: 'principal/guardrail:main' };
    expect(scanPathFor(qualified, baseDir)).toBe(path.join(baseDir, 'guardrails', 'main'));
  });
});

describe('T3-1 — scanPathFor: context nature', () => {
  it('returns contexts/<name>/AGENTS.md for a "context:"-prefixed id', () => {
    const baseDir = '/tmp/checkout';
    expect(scanPathFor(CONTEXT_ENTRY, baseDir)).toBe(
      path.join(baseDir, 'contexts', 'main', 'AGENTS.md'),
    );
  });

  it('strips the source qualifier before deriving the path', () => {
    const baseDir = '/tmp/checkout';
    const qualified: CatalogEntry = { ...CONTEXT_ENTRY, id: 'principal/context:main' };
    expect(scanPathFor(qualified, baseDir)).toBe(
      path.join(baseDir, 'contexts', 'main', 'AGENTS.md'),
    );
  });
});

describe('T3-1 — scanPathFor: mcp nature (regression guard — no branch by design)', () => {
  it('returns null for mcp entries (covered via catalog.json instead, not a checkout)', () => {
    expect(scanPathFor(MCP_LEAKY_ENTRY, '/tmp/checkout')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// makeEnv — isolated HOME + content dir with the multi-nature catalog
// ---------------------------------------------------------------------------

interface Fixture {
  env: Env;
  homeDir: string;
  contentDir: string;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  manifestPath: string;
  cleanupAll: () => Promise<void>;
}

async function makeEnv(entries: CatalogEntry[]): Promise<Fixture> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t3-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t3-content-'));

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 't3-test-catalog' }, entries }),
    'utf8',
  );

  // guardrails/main/ fixture
  const guardrailDir = path.join(contentDir, 'guardrails', 'main');
  await fs.mkdir(guardrailDir, { recursive: true });
  await fs.writeFile(
    path.join(guardrailDir, 'deny.json'),
    JSON.stringify({ deny: ['Read(~/.ssh/**)'] }),
    'utf8',
  );
  await fs.writeFile(
    path.join(guardrailDir, 'allow.json'),
    JSON.stringify({ allow: [] }),
    'utf8',
  );
  await fs.writeFile(
    path.join(guardrailDir, 'permission.json'),
    JSON.stringify({ edit: 'ask' }),
    'utf8',
  );

  // contexts/main/AGENTS.md fixture
  const contextDir = path.join(contentDir, 'contexts', 'main');
  await fs.mkdir(contextDir, { recursive: true });
  await fs.writeFile(path.join(contextDir, 'AGENTS.md'), '# Fixture context\n', 'utf8');

  const env: Env = { RIGGER_HOME: homeDir };
  const manifestPath = path.join(homeDir, '.config', 'agent-rigger', 'state.json');

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

  return { env, homeDir, contentDir, runner, tmpFactory, manifestPath, cleanupAll };
}

// ---------------------------------------------------------------------------
// Shared lifecycle
// ---------------------------------------------------------------------------

let fixture: Fixture;

beforeEach(async () => {
  fixture = await makeEnv(MULTI_NATURE_CATALOG);
});

afterEach(async () => {
  await fixture.cleanupAll();
});

function installLeakyMcp(scanner: Scanner, force?: boolean): ReturnType<typeof runRemoteInstall> {
  const base = {
    ids: ['mcp:leaky'],
    catalogUrl: CATALOG_URL,
    scope: 'user' as const,
    env: fixture.env,
    manifestPath: fixture.manifestPath,
    runner: fixture.runner,
    tmpFactory: fixture.tmpFactory,
    confirm: true,
    assistant: 'opencode' as const,
    scanner,
  };
  return force === undefined ? runRemoteInstall(base) : runRemoteInstall({ ...base, force });
}

// ---------------------------------------------------------------------------
// Scenario 2 — secret-shaped catalog.json (mcp config.env token) + blocking scanner
// ---------------------------------------------------------------------------

describe('T3-2 — secret-shaped catalog.json + blocking scanner, no --force', () => {
  it('throws ScanBlockedError', async () => {
    await expect(
      installLeakyMcp(blockingScanner(['[gitleaks] generic-api-key: token (catalog.json)'])),
    ).rejects.toBeInstanceOf(ScanBlockedError);
  });

  it('does not record a manifest entry when blocked', async () => {
    await installLeakyMcp(
      blockingScanner(['[gitleaks] generic-api-key: token (catalog.json)']),
    ).catch(() => {});

    const manifest = await readManifest(fixture.manifestPath);
    expect(findEntry(manifest, 'mcp:leaky', 'user', 'opencode')).toBeUndefined();
  });
});

describe('T3-2 — secret-shaped catalog.json + blocking scanner, with --force', () => {
  it('installs anyway and emits a [warning]', async () => {
    const result = await installLeakyMcp(
      blockingScanner(['[gitleaks] generic-api-key: token (catalog.json)']),
      true,
    );

    expect(result.applied).toBe(true);
    expect(result.output).toMatch(/\[warning\]/);

    const manifest = await readManifest(fixture.manifestPath);
    expect(findEntry(manifest, 'mcp:leaky', 'user', 'opencode')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — guardrail-only selection: catalog.json AND guardrails/<name>
// ---------------------------------------------------------------------------

describe('T3-3 — guardrail-only selection (from a multi-nature catalog)', () => {
  it('scans a single union of catalog.json and guardrails/main, nothing else', async () => {
    const { scanner, calls, trees } = spyScanner();

    await runRemoteInstall({
      ids: ['guardrail:main'],
      catalogUrl: CATALOG_URL,
      scope: 'user',
      env: fixture.env,
      manifestPath: fixture.manifestPath,
      runner: fixture.runner,
      tmpFactory: fixture.tmpFactory,
      confirm: true,
      scanner,
    });

    // One scan over the union staging; its tree is exactly catalog.json plus the
    // full guardrails/main surface — contexts/main (present in the checkout but
    // NOT selected) is absent, re-verifying R2 scope by the staging content.
    expect(calls).toHaveLength(1);
    expect(trees[0]).toEqual([
      'catalog.json',
      'guardrails/main/allow.json',
      'guardrails/main/deny.json',
      'guardrails/main/permission.json',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — catalog.json scanned even for a selection with no checkout path (mcp-only)
// ---------------------------------------------------------------------------

describe('T3-4 — mcp-only selection (no scan path of its own)', () => {
  it('still scans catalog.json (union tree = catalog.json alone)', async () => {
    const { scanner, calls, trees } = spyScanner();

    await installLeakyMcp(scanner);

    expect(calls).toHaveLength(1);
    expect(trees[0]).toEqual(['catalog.json']);
  });
});

// ---------------------------------------------------------------------------
// m6 — tool-only selection: scanPathFor's `case 'tool': return null` branch was
// exercised by no test. A tool contributes no checkout surface, so the union is
// catalog.json alone (like mcp-only, but via a different null branch).
// ---------------------------------------------------------------------------

describe('m6 — tool-only selection (case tool: return null)', () => {
  it('stages catalog.json alone for a tool-only selection', async () => {
    const { scanner, calls, trees } = spyScanner();

    await scanEntries({
      entries: [TOOL_ENTRY],
      baseDir: fixture.contentDir,
      scanner,
      force: false,
    });

    expect(calls).toHaveLength(1);
    expect(trees[0]).toEqual(['catalog.json']);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — update parity: runUpdate shares scanEntries, so catalog.json
// is covered the same way through the update path.
// ---------------------------------------------------------------------------

describe('T3-5 — update parity: runUpdate scans catalog.json too', () => {
  it('scans catalog.json (and the skill dir) when updating a stale skill', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t3-update-home-'));
    const configDir = path.join(homeDir, '.config', 'agent-rigger');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({ catalogs: [{ name: 'principal', url: CATALOG_URL }] }),
      'utf8',
    );
    const env: Env = { RIGGER_HOME: homeDir };
    const manifestPath = resolveUserTargets(env).stateJson;

    const SKILL_ENTRY: CatalogEntry = {
      kind: 'artifact',
      id: 'skill:remote-demo',
      nature: 'skill',
      targets: ['claude'],
      scopes: ['user', 'project'],
    };

    let currentTag = 'v1.0.0';
    let currentSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const tmpDirsCreated: string[] = [];

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
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    };

    const makeTmpFactory = (): TmpDirFactory => async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t3-update-checkout-'));
      tmpDirsCreated.push(tmpDir);
      await fs.writeFile(
        path.join(tmpDir, 'catalog.json'),
        JSON.stringify({ meta: { name: 't3-update-catalog' }, entries: [SKILL_ENTRY] }),
        'utf8',
      );
      await fs.mkdir(path.join(tmpDir, 'skills', 'remote-demo'), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, 'skills', 'remote-demo', 'SKILL.md'),
        `# Remote Demo Skill ${currentTag}\n`,
        'utf8',
      );
      return { path: tmpDir, cleanup: async () => {} };
    };

    try {
      // Pre-install at v1.0.0 (stub scanner, no interest in the scan gate here).
      await runCli(['install', 'principal/skill:remote-demo', '--yes'], {
        print: () => {},
        env,
        remote: { run: runner, tmpFactory: makeTmpFactory(), scanner: stubScanner },
      });

      // Advance remote to v1.1.0 → skill becomes stale.
      currentTag = 'v1.1.0';
      currentSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

      const { scanner, calls, trees } = spyScanner();

      await runUpdate({
        ids: ['principal/skill:remote-demo'],
        scope: 'user',
        env,
        manifestPath,
        catalogUrl: CATALOG_URL,
        runner,
        tmpFactory: makeTmpFactory(),
        confirm: true,
        scanner,
      });

      // Update shares scanEntries: one union scan whose tree carries both
      // catalog.json and the stale skill's checkout surface.
      expect(calls).toHaveLength(1);
      expect(trees[0]).toContain('catalog.json');
      expect(trees[0]).toContain('skills/remote-demo/SKILL.md');
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      for (const d of tmpDirsCreated) {
        await fs.rm(d, { recursive: true, force: true }).catch(() => {});
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — degraded (no scanner tool): warning surfaces even for a
// selection with no scannable path before this change (mcp-only).
// ---------------------------------------------------------------------------

describe('T3-6 — degraded scanner + mcp-only selection', () => {
  it('emits the degraded warning even though mcp itself has no scan path', async () => {
    const result = await installLeakyMcp(degradedScanner());

    expect(result.applied).toBe(true);
    expect(result.output.toLowerCase()).toMatch(/non scanné|not scanned|unscanned/i);
    expect(result.output).toMatch(/gitleaks|trivy/i);
  });
});

// ---------------------------------------------------------------------------
// Scenario 7 — nominal: clean scanner + minimal catalog → no warning, catalog.json scanned.
// ---------------------------------------------------------------------------

describe('T3-7 — nominal: clean scanner, mcp-only install', () => {
  it('installs without warning and still scans catalog.json', async () => {
    const { scanner, calls, trees } = spyScanner();

    const result = await installLeakyMcp(scanner);

    expect(result.applied).toBe(true);
    expect(result.output).not.toMatch(/\[warning\]/);
    expect(calls).toHaveLength(1);
    expect(trees[0]).toContain('catalog.json');
  });

  it('behaves identically with an explicit clean scanner (no findings)', async () => {
    const result = await installLeakyMcp(cleanScanner());
    expect(result.applied).toBe(true);
    expect(result.output).not.toMatch(/\[warning\]/);
  });
});
