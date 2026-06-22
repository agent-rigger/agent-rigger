/**
 * e2e.test.ts — End-to-end integration tests for the install → check flow.
 *
 * Strategy:
 * - Local test fixtures from packages/cli/test/fixtures/ (deny.json, allow.json, AGENTS.md).
 *   These fixtures replace the former artifacts/ directory which no longer exists — all
 *   catalog content now originates from a remote checkout, so e2e tests use a fixture
 *   directory that mirrors the catalog layout without recreating the removed artifacts/.
 * - Isolated RIGGER_HOME via tmp dir (never touches real ~/.claude).
 * - buildClaudeAdapter mounts the real adapter from fixture files.
 * - runInstall → runCheck exercised end-to-end with real filesystem writes.
 * - No process.exit, no while loops, no mocks of implementation.
 *
 * Scenarios:
 * 1. install → check = 0
 * 2. check before install = 3
 * 3. idempotence: install×2 → applied:false, no new .bak, settings unchanged, check = 0
 * 4. drift detected: corrupt settings.json after install → check = 3
 * 5. via runCli: check on full HOME → 0 ; check on empty HOME → 3
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createClaudeAdapter,
  loadCanonicalAllow,
  loadCanonicalContext,
  loadCanonicalDeny,
} from '@agent-rigger/adapters';
import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';

import type { CatalogEntry } from '@agent-rigger/catalog';

import { runCli } from '../src/cli';
import { runCheck } from '../src/cmd-check';
import { runInstall } from '../src/cmd-install';

// ---------------------------------------------------------------------------
// Repo root + artifacts dir — resolved from this file's location
// packages/cli/test → packages/cli → packages → agent-rigger (repo root)
// ---------------------------------------------------------------------------

/**
 * Local fixture directory with minimal catalog-layout files for e2e tests.
 * Mirrors the layout that a remote checkout provides:
 *   fixtures/deny.json        — guardrail deny rules
 *   fixtures/allow.json       — guardrail allow rules
 *   fixtures/AGENTS.md        — context document
 *
 * The former artifacts/ directory has been removed (F2: CLI carries no builtin content).
 * All production content now comes from a remote catalog checkout; tests use this
 * fixture dir in its place.
 */
const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixtures');

/**
 * Build a ClaudeAdapter pre-loaded with fixture content from FIXTURE_DIR.
 *
 * Loads deny/allow/AGENTS.md from the local fixture directory and creates
 * the adapter via `createClaudeAdapter`. The e2e tests only need guardrail +
 * context functionality; `env` is accepted for signature compatibility.
 */
async function buildE2eAdapter(_env: Env): Promise<ReturnType<typeof createClaudeAdapter>> {
  const denyRef = await loadCanonicalDeny(path.join(FIXTURE_DIR, 'deny.json'));
  const allowRef = await loadCanonicalAllow(path.join(FIXTURE_DIR, 'allow.json'));
  const agentsContent = await loadCanonicalContext(path.join(FIXTURE_DIR, 'AGENTS.md'));
  return createClaudeAdapter({ denyRef, allowRef, agentsContent, scanner: stubScanner });
}

// ---------------------------------------------------------------------------
// Fixture catalog — provides the minimum entries needed for e2e install/check tests.
// ids match the fixture files in packages/cli/test/fixtures/ (deny.json, AGENTS.md).
// ---------------------------------------------------------------------------

const E2E_FIXTURE_CATALOG: CatalogEntry[] = [
  {
    kind: 'artifact',
    id: 'guardrails-claude',
    nature: 'guardrail',
    targets: ['claude'],
    scopes: ['user'],
  },
  {
    kind: 'artifact',
    id: 'context-claude',
    nature: 'context',
    targets: ['claude'],
    scopes: ['user'],
  },
];

// ---------------------------------------------------------------------------
// Adapter entries for guardrail + context (the two e2e fixture artifacts)
// ---------------------------------------------------------------------------

const GUARDRAIL_ENTRY: AdapterEntry = {
  id: 'guardrails-claude',
  nature: 'guardrail',
  scope: 'user',
};

const CONTEXT_ENTRY: AdapterEntry = {
  id: 'context-claude',
  nature: 'context',
  scope: 'user',
};

const ENTRIES: AdapterEntry[] = [GUARDRAIL_ENTRY, CONTEXT_ENTRY];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-e2e-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

function makeCapture(): { lines: string[]; print: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

// ---------------------------------------------------------------------------
// Shared lifecycle
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let targets: ReturnType<typeof resolveUserTargets>;
let manifestPath: string;

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
  targets = resolveUserTargets(env);
  manifestPath = targets.stateJson;
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// Scenario 1: install → check = 0
// Verifies the happy path: install writes all files, then check returns 0.
// Also validates disk state: deny rules, AGENTS.md, CLAUDE.md import block, state.json.
// ---------------------------------------------------------------------------

describe('e2e — install → check = 0', () => {
  it('runInstall applied:true with real artifacts', async () => {
    const adapter = await buildE2eAdapter(env);

    const result = await runInstall({
      catalog: E2E_FIXTURE_CATALOG,
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    expect(result.applied).toBe(true);
    expect(result.written.length).toBeGreaterThan(0);
  });

  it('settings.json contains deny rules from real deny.json', async () => {
    const adapter = await buildE2eAdapter(env);

    await runInstall({
      catalog: E2E_FIXTURE_CATALOG,
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    const raw = await fs.readFile(targets.claudeSettings, 'utf8');
    const parsed = JSON.parse(raw) as { permissions?: { deny?: string[] } };
    const deny = parsed.permissions?.deny ?? [];

    // Real deny.json contains these rules
    expect(deny).toContain('Read(./.env)');
    expect(deny).toContain('Read(~/.ssh/**)');
  });

  it('AGENTS.md is written at target path with real content', async () => {
    const adapter = await buildE2eAdapter(env);

    await runInstall({
      catalog: E2E_FIXTURE_CATALOG,
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    const content = await fs.readFile(targets.agentsMd, 'utf8');
    // Real AGENTS.md starts with this heading
    expect(content).toContain('# Agent Context');
  });

  it('CLAUDE.md contains managed import block referencing AGENTS.md', async () => {
    const adapter = await buildE2eAdapter(env);

    await runInstall({
      catalog: E2E_FIXTURE_CATALOG,
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    const claudeMd = await fs.readFile(targets.claudeMd, 'utf8');
    expect(claudeMd).toContain('AGENTS.md');
  });

  it('state.json manifest has both entry ids', async () => {
    const adapter = await buildE2eAdapter(env);

    await runInstall({
      catalog: E2E_FIXTURE_CATALOG,
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    const stat = await fs.stat(manifestPath).catch(() => null);
    expect(stat).not.toBeNull();

    const raw = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as { artifacts: Array<{ id: string }> };
    const ids = manifest.artifacts.map((a) => a.id);
    expect(ids).toContain('guardrails-claude');
    expect(ids).toContain('context-claude');
  });

  it('runCheck returns exitCode 0 after install', async () => {
    const adapter = await buildE2eAdapter(env);

    await runInstall({
      catalog: E2E_FIXTURE_CATALOG,
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    // Re-mount adapter (simulates a fresh check invocation)
    const checkAdapter = await buildE2eAdapter(env);

    const result = await runCheck({
      adapter: checkAdapter,
      entries: ENTRIES,
      scope: 'user',
      env,
    });

    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: check before install = 3
// Fresh HOME → no files written → guardrail and context are missing.
// ---------------------------------------------------------------------------

describe('e2e — check before install = 3', () => {
  it('runCheck returns exitCode 3 on a fresh empty HOME', async () => {
    const adapter = await buildE2eAdapter(env);

    const result = await runCheck({
      adapter,
      entries: ENTRIES,
      scope: 'user',
      env,
    });

    expect(result.exitCode).toBe(3);
  });

  it('report has missing entries for both guardrail and context', async () => {
    const adapter = await buildE2eAdapter(env);

    const result = await runCheck({
      adapter,
      entries: ENTRIES,
      scope: 'user',
      env,
    });

    const missingIds = result.report.entries
      .filter((e) => e.state === 'missing')
      .map((e) => e.id);

    expect(missingIds).toContain('guardrails-claude');
    expect(missingIds).toContain('context-claude');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: idempotence install×2
// Second install → applied:false (plan empty, "up to date").
// No new .bak files created. settings.json unchanged byte-for-byte. check = 0.
// ---------------------------------------------------------------------------

describe('e2e — idempotence install×2', () => {
  it('second install returns applied:false', async () => {
    const adapter = await buildE2eAdapter(env);
    const installOpts = {
      catalog: E2E_FIXTURE_CATALOG,
      adapter,
      scope: 'user' as const,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    };

    await runInstall(installOpts);
    const result2 = await runInstall(installOpts);

    expect(result2.applied).toBe(false);
  });

  it('second install output indicates up-to-date', async () => {
    const adapter = await buildE2eAdapter(env);
    const installOpts = {
      catalog: E2E_FIXTURE_CATALOG,
      adapter,
      scope: 'user' as const,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    };

    await runInstall(installOpts);
    const result2 = await runInstall(installOpts);

    expect(result2.output.toLowerCase()).toMatch(/up.to.date|nothing to install|already/);
  });

  it('second install creates no .bak files', async () => {
    const adapter = await buildE2eAdapter(env);
    const installOpts = {
      catalog: E2E_FIXTURE_CATALOG,
      adapter,
      scope: 'user' as const,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    };

    await runInstall(installOpts);
    const result2 = await runInstall(installOpts);

    expect(result2.backedUp).toHaveLength(0);
  });

  it('settings.json is unchanged byte-for-byte after second install', async () => {
    const adapter = await buildE2eAdapter(env);
    const installOpts = {
      catalog: E2E_FIXTURE_CATALOG,
      adapter,
      scope: 'user' as const,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    };

    await runInstall(installOpts);
    const contentBefore = await fs.readFile(targets.claudeSettings, 'utf8');

    await runInstall(installOpts);
    const contentAfter = await fs.readFile(targets.claudeSettings, 'utf8');

    expect(contentAfter).toBe(contentBefore);
  });

  it('check returns 0 after two installs', async () => {
    const adapter = await buildE2eAdapter(env);
    const installOpts = {
      catalog: E2E_FIXTURE_CATALOG,
      adapter,
      scope: 'user' as const,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    };

    await runInstall(installOpts);
    await runInstall(installOpts);

    const checkAdapter = await buildE2eAdapter(env);
    const result = await runCheck({
      adapter: checkAdapter,
      entries: ENTRIES,
      scope: 'user',
      env,
    });

    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: drift detected
// After a successful install, overwrite settings.json removing the deny rules.
// runCheck must detect the missing guardrail → exitCode 3.
// ---------------------------------------------------------------------------

describe('e2e — drift detected after install', () => {
  it('runCheck returns exitCode 3 after deny rules are removed from settings.json', async () => {
    const adapter = await buildE2eAdapter(env);

    // Install first
    await runInstall({
      catalog: E2E_FIXTURE_CATALOG,
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    // Simulate drift: overwrite settings.json without deny rules
    await fs.writeFile(
      targets.claudeSettings,
      JSON.stringify({ permissions: { deny: [] } }, null, 2),
      'utf8',
    );

    // Re-mount adapter for check
    const checkAdapter = await buildE2eAdapter(env);

    const result = await runCheck({
      adapter: checkAdapter,
      entries: ENTRIES,
      scope: 'user',
      env,
    });

    expect(result.exitCode).toBe(3);
  });

  it('report shows guardrails-claude as missing after drift', async () => {
    const adapter = await buildE2eAdapter(env);

    await runInstall({
      catalog: E2E_FIXTURE_CATALOG,
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    // Remove deny rules → drift
    await fs.writeFile(
      targets.claudeSettings,
      JSON.stringify({ permissions: { deny: [] } }, null, 2),
      'utf8',
    );

    const checkAdapter = await buildE2eAdapter(env);

    const result = await runCheck({
      adapter: checkAdapter,
      entries: [GUARDRAIL_ENTRY],
      scope: 'user',
      env,
    });

    const missingIds = result.report.entries
      .filter((e) => e.state === 'missing')
      .map((e) => e.id);

    expect(missingIds).toContain('guardrails-claude');
  });

  it('output mentions missing or drift state after deny rules removed', async () => {
    const adapter = await buildE2eAdapter(env);

    await runInstall({
      catalog: E2E_FIXTURE_CATALOG,
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    await fs.writeFile(
      targets.claudeSettings,
      JSON.stringify({ permissions: { deny: [] } }, null, 2),
      'utf8',
    );

    const checkAdapter = await buildE2eAdapter(env);

    const result = await runCheck({
      adapter: checkAdapter,
      entries: ENTRIES,
      scope: 'user',
      env,
    });

    expect(result.output).toMatch(/\[miss\s*\]|\[drift\]/);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 (optional): via runCli
// Validates end-to-end wiring of the binary entry point.
// Without catalogUrl: check → 0 (empty catalog + actionable message).
// ---------------------------------------------------------------------------

describe('e2e — via runCli', () => {
  it('check on empty HOME without catalogUrl returns exit code 0 (empty catalog → actionable)', async () => {
    const cap = makeCapture();

    const code = await runCli(['check'], {
      print: cap.print,
      env,
    });

    // Without catalogUrl → effective catalog is [] → check returns 0 with actionable message
    expect(code).toBe(0);
    const out = cap.lines.join('\n');
    expect(out).toMatch(/aucun catalog|agent-rigger init/);
  });

  it('direct runCheck on empty HOME returns exit code 3 (no catalog involvement)', async () => {
    // runCheck is called directly with known entries — bypasses catalog
    const adapter = await buildE2eAdapter(env);

    const result = await runCheck({
      adapter,
      entries: ENTRIES,
      scope: 'user',
      env,
    });

    // No catalog needed for runCheck — directly checks files → exit 3 (not installed)
    expect(result.exitCode).toBe(3);
  });
});
