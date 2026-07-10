/**
 * r7-scriptstore-cleanup.test.ts — R7: hook guard scripts leave the disk with
 * the last hook (lot2-remove-reversible, covers L4).
 *
 * Contract (requirements.md R7, design D6):
 * - The scriptStore directory (<dirname(stateJson)>/hooks — guard-*.ts,
 *   _shared/, runtime guard-*.log) is deleted when NO manifest entry of
 *   nature 'hook' remains after a remove run — all scopes confounded.
 * - While at least one hook remains at the manifest, the directory is kept
 *   INTACT (shared _shared/ scripts and the removed hook's copy included:
 *   scripts are copies, the manifest is the only reliable counter).
 * - The whole directory is backed up (backupDir, <dir>.bak-<ISO>-<token>)
 *   through the engine channel before the rm.
 * - Safety gate: a run that removed NO hook-nature entry never touches the
 *   directory, even when the manifest tracks no hooks — a legacy (truncated)
 *   manifest must not lose scripts that still-active hooks execute.
 *
 * Harness mirrors h4-hooks-catalog.test.ts (buildClaudeAdapter + external
 * checkout) but installs through engine.apply so the manifest tracks the
 * entries, and removes through runRemove so the cmd-remove wiring is covered.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply } from '@agent-rigger/core/engine';
import type { Env } from '@agent-rigger/core/paths';
import { resolveUserTargets } from '@agent-rigger/core/paths';

import type { CatalogEntry } from '@agent-rigger/catalog';

import { buildClaudeAdapter } from '../src/cli';
import { runRemove } from '../src/cmd-remove';

// ---------------------------------------------------------------------------
// Fixture catalog — 4 hook guards (same shape as h4-hooks-catalog.test.ts)
// ---------------------------------------------------------------------------

const HOOK_NAMES = ['guard-command', 'guard-secret', 'guard-write-secret', 'guard-prompt'];

const HOOK_IDS = HOOK_NAMES.map((name) => `hook:${name}`);

const FIXTURE_CATALOG: CatalogEntry[] = HOOK_NAMES.map((name) => ({
  kind: 'artifact',
  id: `hook:${name}`,
  nature: 'hook',
  targets: ['claude'],
  scopes: ['user', 'project'],
  event: 'PreToolUse',
  matcher: 'Bash',
  timeout: 5,
}));

const FIXTURE_EFFECTIVE_ENTRIES = new Map<string, CatalogEntry>(
  FIXTURE_CATALOG.map((e) => [e.id, e]),
);

const EXTERNAL_IDS = new Set([...HOOK_IDS, 'skill:demo']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const exists = (p: string) => fs.lstat(p).then(() => true).catch(() => false);

async function makeTmpHome(): Promise<{ dir: string; env: Env; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-r7-'));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/**
 * External checkout: 4 guard scripts + _shared/ (hook deposit source) and one
 * skill fixture (for the non-hook remove scenario).
 */
async function makeCheckoutDir(baseDir: string): Promise<string> {
  const checkoutDir = path.join(baseDir, 'checkout');
  await fs.mkdir(path.join(checkoutDir, 'hooks', '_shared'), { recursive: true });
  for (const name of HOOK_NAMES) {
    await fs.writeFile(path.join(checkoutDir, 'hooks', `${name}.ts`), `// stub ${name}`);
  }
  await fs.writeFile(path.join(checkoutDir, 'hooks', '_shared', 'hook-lib.ts'), '// stub lib');

  await fs.mkdir(path.join(checkoutDir, 'skills', 'demo'), { recursive: true });
  await fs.writeFile(path.join(checkoutDir, 'skills', 'demo', 'SKILL.md'), '# demo skill');

  return checkoutDir;
}

function hookEntries(ids: string[]): AdapterEntry[] {
  return ids.map((id) => ({ id, nature: 'hook' as const, scope: 'user' as const }));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let manifestPath: string;
let scriptStore: string;
let adapter: Awaited<ReturnType<typeof buildClaudeAdapter>>;

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
  const targets = resolveUserTargets(env);
  manifestPath = targets.stateJson;
  // Derivable from the env — D6: the store location is deterministic, never
  // persisted to the manifest (same derivation as adapter-builder hookSpec).
  scriptStore = path.join(path.dirname(targets.stateJson), 'hooks');

  const checkoutDir = await makeCheckoutDir(tmp.dir);
  adapter = await buildClaudeAdapter(env, {
    externalIds: EXTERNAL_IDS,
    externalBaseDir: checkoutDir,
    effectiveEntries: FIXTURE_EFFECTIVE_ENTRIES,
  });
});

afterEach(async () => {
  await tmp.cleanup();
});

/** Install the 4 hooks through the engine + drop a runtime log in the store. */
async function installAllHooks(): Promise<void> {
  await apply(adapter, hookEntries(HOOK_IDS), 'user', env, manifestPath);
  await fs.writeFile(path.join(scriptStore, 'guard-command.log'), 'runtime log line\n');
}

// ---------------------------------------------------------------------------
// Scenario: last hook removed → scriptStore deleted (logs included)
// ---------------------------------------------------------------------------

describe('R7 — the scriptStore leaves the disk with the last hook', () => {
  it('R7: removing every hook deletes the scriptStore directory, runtime logs included', async () => {
    await installAllHooks();
    expect(await exists(scriptStore)).toBe(true);

    const result = await runRemove({
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: HOOK_IDS,
      confirm: true,
    });

    expect(result.applied).toBe(true);
    expect(result.removed).toEqual(HOOK_IDS);
    // The whole directory is gone: scripts, _shared/, guard-*.log.
    expect(await exists(scriptStore)).toBe(false);
  });

  it('R7: the scriptStore is backed up as a whole before deletion (engine backupDir channel)', async () => {
    await installAllHooks();

    const result = await runRemove({
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: HOOK_IDS,
      confirm: true,
    });

    const dirBak = result.backedUp.find((b) => path.basename(b).startsWith('hooks.bak-'));
    expect(dirBak).toBeDefined();
    // The backup preserves the full tree: scripts, shared lib, runtime logs.
    expect(await exists(path.join(dirBak!, 'guard-secret.ts'))).toBe(true);
    expect(await exists(path.join(dirBak!, '_shared', 'hook-lib.ts'))).toBe(true);
    expect(await exists(path.join(dirBak!, 'guard-command.log'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario: hooks remain → scriptStore kept intact
// ---------------------------------------------------------------------------

describe('R7 — the scriptStore is kept while hooks remain at the manifest', () => {
  it('R7: removing a single hook keeps the scriptStore intact (_shared/ and removed copy included)', async () => {
    await installAllHooks();

    const result = await runRemove({
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['hook:guard-command'],
      confirm: true,
    });

    expect(result.applied).toBe(true);
    // Directory intact: scripts are shared copies — the manifest still counts
    // 3 hooks, so NOTHING in the store is touched, not even the removed
    // hook's own script copy.
    expect(await exists(scriptStore)).toBe(true);
    expect(await exists(path.join(scriptStore, 'guard-command.ts'))).toBe(true);
    expect(await exists(path.join(scriptStore, 'guard-secret.ts'))).toBe(true);
    expect(await exists(path.join(scriptStore, '_shared', 'hook-lib.ts'))).toBe(true);
    expect(await exists(path.join(scriptStore, 'guard-command.log'))).toBe(true);
    // No directory backup either — nothing was deleted.
    expect(result.backedUp.some((b) => path.basename(b).startsWith('hooks.bak-'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario: safety gate — a run without hook removals never touches the store
// ---------------------------------------------------------------------------

describe('R7 — a remove run that touched no hook leaves the scriptStore alone', () => {
  it('R7: removing a non-hook entry never deletes a scriptStore the manifest does not track', async () => {
    // Only a skill at the manifest (no hook-nature entries at all)...
    await apply(
      adapter,
      [{ id: 'skill:demo', nature: 'skill', scope: 'user' }],
      'user',
      env,
      manifestPath,
    );
    // ...while a stale scriptStore sits on disk (legacy truncated manifest:
    // hooks still active in settings.json but no longer tracked).
    await fs.mkdir(path.join(scriptStore, '_shared'), { recursive: true });
    await fs.writeFile(path.join(scriptStore, 'guard-command.ts'), '// legacy stub');

    const result = await runRemove({
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['skill:demo'],
      confirm: true,
    });

    expect(result.applied).toBe(true);
    // "No hook-nature entry remains" is TRUE, but this run removed no hook —
    // deleting here would break scripts a legacy manifest fails to count.
    expect(await exists(scriptStore)).toBe(true);
    expect(await exists(path.join(scriptStore, 'guard-command.ts'))).toBe(true);
  });
});
