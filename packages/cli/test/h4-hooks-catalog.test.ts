/**
 * Tests for H4 — hook guards as catalog entries + pack:harness + script deposit.
 *
 * Covers:
 * - pack:harness resolves to hook guard artifact entries via catalog resolver.
 * - buildClaudeAdapter hookSpec: plan produces correct merge-hooks op (effectiveEntries required).
 * - apply writes hook to settings.json AND deposits scripts to store/hooks/.
 * - Idempotence: 2nd plan after apply returns [].
 * - audit after apply → state present.
 * - planRemove → applyRemove removes hook from settings.json; scripts remain in store.
 * - hookSpec unknown id → actionable error.
 * - apply preserves preexisting permissions.deny.
 *
 * Isolation: each test uses a fresh RIGGER_HOME tmp dir.
 *
 * Post-B-iii: hooks must come from externalBaseDir/hooks/<name>.ts.
 * No internal artifactsDir fallback — all hook scripts source from externalBaseDir.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { readJson, writeJson } from '@agent-rigger/core/fs-json';
import { hasHook } from '@agent-rigger/core/hooks';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import type { CatalogEntry } from '@agent-rigger/catalog';
import { resolve } from '@agent-rigger/catalog/resolver';

import { buildClaudeAdapter } from '../src/cli';

// ---------------------------------------------------------------------------
// Fixture catalog (replaces BUILTIN_CATALOG)
// ---------------------------------------------------------------------------

const FIXTURE_HOOK_GUARD_COMMAND: CatalogEntry = {
  kind: 'artifact',
  id: 'hook:guard-command',
  nature: 'hook',
  targets: ['claude'],
  scopes: ['user', 'project'],
  event: 'PreToolUse',
  matcher: 'Bash',
  timeout: 5,
};

const FIXTURE_HOOK_GUARD_SECRET: CatalogEntry = {
  kind: 'artifact',
  id: 'hook:guard-secret',
  nature: 'hook',
  targets: ['claude'],
  scopes: ['user', 'project'],
  event: 'PreToolUse',
  matcher: 'Read|Edit|MultiEdit|Write|NotebookEdit|Grep|Glob|Bash',
  timeout: 5,
};

const FIXTURE_HOOK_GUARD_WRITE_SECRET: CatalogEntry = {
  kind: 'artifact',
  id: 'hook:guard-write-secret',
  nature: 'hook',
  targets: ['claude'],
  scopes: ['user', 'project'],
  event: 'PreToolUse',
  matcher: 'Write|Edit|MultiEdit',
  timeout: 5,
};

const FIXTURE_HOOK_GUARD_PROMPT: CatalogEntry = {
  kind: 'artifact',
  id: 'hook:guard-prompt',
  nature: 'hook',
  targets: ['claude'],
  scopes: ['user', 'project'],
  event: 'UserPromptSubmit',
  matcher: '*',
  timeout: 5,
};

const FIXTURE_PACK_HARNESS: CatalogEntry = {
  kind: 'pack',
  id: 'pack:harness',
  targets: ['claude'],
  scopes: ['user', 'project'],
  members: [
    'hook:guard-command',
    'hook:guard-secret',
    'hook:guard-write-secret',
    'hook:guard-prompt',
  ],
};

const FIXTURE_CATALOG: CatalogEntry[] = [
  FIXTURE_HOOK_GUARD_COMMAND,
  FIXTURE_HOOK_GUARD_SECRET,
  FIXTURE_HOOK_GUARD_WRITE_SECRET,
  FIXTURE_HOOK_GUARD_PROMPT,
  FIXTURE_PACK_HARNESS,
];

const FIXTURE_EFFECTIVE_ENTRIES = new Map<string, CatalogEntry>(
  FIXTURE_CATALOG.map((e) => [e.id, e]),
);

/** All hook externalIds used by h4 tests. */
const HOOK_EXTERNAL_IDS = new Set([
  'hook:guard-command',
  'hook:guard-secret',
  'hook:guard-write-secret',
  'hook:guard-prompt',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(prefix = 'rigger-h4-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/**
 * Create a minimal external checkout directory that satisfies buildClaudeAdapter
 * hook resolution (post-B-iii: hooks come from externalBaseDir/hooks/).
 *
 * Layout:
 *   <checkoutDir>/hooks/guard-command.ts
 *   <checkoutDir>/hooks/guard-secret.ts
 *   <checkoutDir>/hooks/guard-write-secret.ts
 *   <checkoutDir>/hooks/guard-prompt.ts
 *   <checkoutDir>/hooks/_shared/hook-lib.ts
 */
async function makeCheckoutDir(baseDir: string): Promise<string> {
  const checkoutDir = path.join(baseDir, 'checkout');
  await fs.mkdir(path.join(checkoutDir, 'hooks', '_shared'), { recursive: true });

  // Stub guard scripts (content doesn't matter — syncToStore just copies them)
  for (const name of ['guard-command', 'guard-secret', 'guard-write-secret', 'guard-prompt']) {
    await fs.writeFile(
      path.join(checkoutDir, 'hooks', `${name}.ts`),
      `// stub ${name}`,
    );
  }
  await fs.writeFile(
    path.join(checkoutDir, 'hooks', '_shared', 'hook-lib.ts'),
    '// stub hook-lib',
  );

  return checkoutDir;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpDir>>;
let env: Env;

beforeEach(async () => {
  tmp = await makeTmpDir();
  env = tmp.env;
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// pack:harness → 4 hook guards
// ---------------------------------------------------------------------------

describe('pack:harness resolves to 4 hook guards via catalog resolver', () => {
  it('resolve(["pack:harness"], FIXTURE_CATALOG) returns 4 hook artifact entries', () => {
    const entries = resolve(['pack:harness'], FIXTURE_CATALOG);
    expect(entries).toHaveLength(4);
    const ids = entries.map((e) => e.id);
    expect(ids).toContain('hook:guard-command');
    expect(ids).toContain('hook:guard-secret');
    expect(ids).toContain('hook:guard-write-secret');
    expect(ids).toContain('hook:guard-prompt');
    // All should have nature 'hook'
    for (const entry of entries) {
      expect(entry.nature).toBe('hook');
    }
  });
});

// ---------------------------------------------------------------------------
// hookSpec: hook:guard-secret full lifecycle
// ---------------------------------------------------------------------------

describe('buildClaudeAdapter hookSpec — hook:guard-secret install/remove lifecycle', () => {
  const ENTRY: AdapterEntry = {
    id: 'hook:guard-secret',
    nature: 'hook',
    scope: 'user',
  };

  it('plan produces merge-hooks op with correct event, matcher, command, timeout', async () => {
    const checkoutDir = await makeCheckoutDir(tmp.dir);
    const adapter = await buildClaudeAdapter(env, {
      externalIds: HOOK_EXTERNAL_IDS,
      externalBaseDir: checkoutDir,
      effectiveEntries: FIXTURE_EFFECTIVE_ENTRIES,
    });

    const ops = await adapter.plan(ENTRY, 'user', env);

    expect(ops).toHaveLength(1);
    const op = ops[0] as {
      kind: string;
      event: string;
      matcher: string;
      command: string;
      timeout?: number;
    };
    expect(op.kind).toBe('merge-hooks');
    expect(op.event).toBe('PreToolUse');
    expect(op.matcher).toBe('Read|Edit|MultiEdit|Write|NotebookEdit|Grep|Glob|Bash');
    expect(op.command).toContain('guard-secret.ts');
    expect(op.command).toMatch(/^bun run /);
    expect(op.timeout).toBe(5);
  });

  it('apply writes hook to settings.json + deposits scripts to store/hooks/', async () => {
    const checkoutDir = await makeCheckoutDir(tmp.dir);
    const adapter = await buildClaudeAdapter(env, {
      externalIds: HOOK_EXTERNAL_IDS,
      externalBaseDir: checkoutDir,
      effectiveEntries: FIXTURE_EFFECTIVE_ENTRIES,
    });
    const targets = resolveUserTargets(env);

    const ops = await adapter.plan(ENTRY, 'user', env);
    await adapter.apply(ops, env);

    // settings.json should have the hook
    const settings = await readJson(targets.claudeSettings);
    const hookSpec = {
      event: 'PreToolUse',
      matcher: 'Read|Edit|MultiEdit|Write|NotebookEdit|Grep|Glob|Bash',
      command: (ops[0] as { command: string }).command,
    };
    expect(hasHook(settings, hookSpec)).toBe(true);

    // Scripts should be deposited to store/hooks/
    const scriptStore = path.join(path.dirname(targets.stateJson), 'hooks');
    const guardExists = await fs.stat(path.join(scriptStore, 'guard-secret.ts'))
      .then(() => true).catch(() => false);
    expect(guardExists).toBe(true);

    // _shared/hook-lib.ts should also be deposited
    const sharedExists = await fs.stat(path.join(scriptStore, '_shared', 'hook-lib.ts'))
      .then(() => true).catch(() => false);
    expect(sharedExists).toBe(true);
  });

  it('is idempotent — 2nd plan after apply returns []', async () => {
    const checkoutDir = await makeCheckoutDir(tmp.dir);
    const adapter = await buildClaudeAdapter(env, {
      externalIds: HOOK_EXTERNAL_IDS,
      externalBaseDir: checkoutDir,
      effectiveEntries: FIXTURE_EFFECTIVE_ENTRIES,
    });

    const ops = await adapter.plan(ENTRY, 'user', env);
    await adapter.apply(ops, env);

    const ops2 = await adapter.plan(ENTRY, 'user', env);
    expect(ops2).toHaveLength(0);
  });

  it('audit after apply returns state present', async () => {
    const checkoutDir = await makeCheckoutDir(tmp.dir);
    const adapter = await buildClaudeAdapter(env, {
      externalIds: HOOK_EXTERNAL_IDS,
      externalBaseDir: checkoutDir,
      effectiveEntries: FIXTURE_EFFECTIVE_ENTRIES,
    });

    const ops = await adapter.plan(ENTRY, 'user', env);
    await adapter.apply(ops, env);

    const report = await adapter.audit(ENTRY, 'user', env);
    expect(report.state).toBe('present');
    expect(report.nature).toBe('hook');
  });

  it('planRemove → applyRemove removes hook from settings.json; scripts remain in store', async () => {
    const checkoutDir = await makeCheckoutDir(tmp.dir);
    const adapter = await buildClaudeAdapter(env, {
      externalIds: HOOK_EXTERNAL_IDS,
      externalBaseDir: checkoutDir,
      effectiveEntries: FIXTURE_EFFECTIVE_ENTRIES,
    });
    const targets = resolveUserTargets(env);

    // Install
    const ops = await adapter.plan(ENTRY, 'user', env);
    await adapter.apply(ops, env);

    const command = (ops[0] as { command: string }).command;
    const hookSpec = {
      event: 'PreToolUse',
      matcher: 'Read|Edit|MultiEdit|Write|NotebookEdit|Grep|Glob|Bash',
      command,
    };

    // Remove
    const removeOps = await adapter.planRemove(ENTRY, 'user', env);
    expect(removeOps).toHaveLength(1);
    expect(removeOps[0]!.kind).toBe('remove-hooks');
    await adapter.applyRemove(removeOps, env);

    // Hook removed from settings.json
    const settings = await readJson(targets.claudeSettings);
    expect(hasHook(settings, hookSpec)).toBe(false);

    // Scripts remain in store (not deleted on remove — intentional)
    const scriptStore = path.join(path.dirname(targets.stateJson), 'hooks');
    const guardStillExists = await fs.stat(path.join(scriptStore, 'guard-secret.ts'))
      .then(() => true).catch(() => false);
    expect(guardStillExists).toBe(true);
  });

  it('check → present after install', async () => {
    const checkoutDir = await makeCheckoutDir(tmp.dir);
    const adapter = await buildClaudeAdapter(env, {
      externalIds: HOOK_EXTERNAL_IDS,
      externalBaseDir: checkoutDir,
      effectiveEntries: FIXTURE_EFFECTIVE_ENTRIES,
    });

    // Before install → missing
    const before = await adapter.audit(ENTRY, 'user', env);
    expect(before.state).toBe('missing');

    // Install + re-audit → present
    const ops = await adapter.plan(ENTRY, 'user', env);
    await adapter.apply(ops, env);
    const after = await adapter.audit(ENTRY, 'user', env);
    expect(after.state).toBe('present');
  });

  it('apply preserves preexisting permissions.deny', async () => {
    const checkoutDir = await makeCheckoutDir(tmp.dir);
    const adapter = await buildClaudeAdapter(env, {
      externalIds: HOOK_EXTERNAL_IDS,
      externalBaseDir: checkoutDir,
      effectiveEntries: FIXTURE_EFFECTIVE_ENTRIES,
    });
    const targets = resolveUserTargets(env);

    // Pre-populate settings.json with deny rules
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      permissions: { deny: ['Read(./.env)', 'Read(~/.ssh/**)'] },
    });

    const ops = await adapter.plan(ENTRY, 'user', env);
    await adapter.apply(ops, env);

    const settings = await readJson(targets.claudeSettings);
    const deny = ((settings['permissions'] as Record<string, unknown>)['deny']) as string[];
    expect(deny).toContain('Read(./.env)');
    expect(deny).toContain('Read(~/.ssh/**)');

    const hookSpec = {
      event: 'PreToolUse',
      matcher: 'Read|Edit|MultiEdit|Write|NotebookEdit|Grep|Glob|Bash',
      command: (ops[0] as { command: string }).command,
    };
    expect(hasHook(settings, hookSpec)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hookSpec unknown id → actionable error
// ---------------------------------------------------------------------------

describe('buildClaudeAdapter hookSpec — unknown id', () => {
  it('throws an actionable error for hooks not in externalIds', async () => {
    const checkoutDir = await makeCheckoutDir(tmp.dir);
    // No externalIds → hook:custom-guard not routed to externalBaseDir → throws
    const adapter = await buildClaudeAdapter(env, {
      externalIds: new Set<string>(),
      externalBaseDir: checkoutDir,
      effectiveEntries: new Map(),
    });

    const unknownEntry: AdapterEntry = {
      id: 'hook:custom-guard',
      nature: 'hook',
      scope: 'user',
    };

    await expect(adapter.plan(unknownEntry, 'user', env)).rejects.toThrow(
      'hook:custom-guard',
    );
  });
});
