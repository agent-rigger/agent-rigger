/**
 * Tests for claude/hooks handler — TDD.
 *
 * Covers:
 * - auditHook: settings absent → missing; hook present → present.
 * - planHook: absent/no-hooks settings → 1 merge-hooks op; idempotent → [].
 * - applyHook: writes hook; preserves permissions.deny; is idempotent.
 * - planRemoveHook: hook present → 1 remove-hooks op; absent → [].
 * - applyRemoveHook: removes hook; hasHook → false; deny preserved.
 * - adapter routing via createClaudeAdapter: audit/plan/apply/planRemove/applyRemove.
 * - InvalidJsonError propagated on corrupt settings.json.
 *
 * Isolation: each test uses a fresh RIGGER_HOME tmp dir. Never touches the real ~/.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { readJson, writeJson } from '@agent-rigger/core/fs-json';
import { hasHook } from '@agent-rigger/core/hooks';
import { resolveProjectTargets, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { createClaudeAdapter } from '../../src/claude/adapter';
import {
  applyHook,
  applyRemoveHook,
  auditHook,
  planHook,
  planRemoveHook,
} from '../../src/claude/hooks';
import type { ResolvedHook } from '../../src/claude/hooks';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-hooks-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPEC: ResolvedHook = {
  event: 'PreToolUse',
  matcher: 'Bash',
  command: '/usr/local/bin/rigger-hook.sh',
};

const SPEC_WITH_TIMEOUT: ResolvedHook = {
  event: 'PostToolUse',
  matcher: '*',
  command: '/usr/local/bin/rigger-post.sh',
  timeout: 10,
};

const ENTRY: AdapterEntry = {
  id: 'hook-rigger',
  nature: 'hook',
  scope: 'user',
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// auditHook
// ---------------------------------------------------------------------------

describe('auditHook', () => {
  it('returns state missing when settings.json does not exist', async () => {
    const report = await auditHook(ENTRY, 'user', env, SPEC);

    expect(report.state).toBe('missing');
    expect(report.nature).toBe('hook');
    expect(report.id).toBe(ENTRY.id);
  });

  it('returns state missing when settings.json has no hooks section', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, { model: 'sonnet' });

    const report = await auditHook(ENTRY, 'user', env, SPEC);

    expect(report.state).toBe('missing');
  });

  it('returns state missing when hook is not registered', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      hooks: {
        PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: '/other.sh' }] }],
      },
    });

    const report = await auditHook(ENTRY, 'user', env, SPEC);

    expect(report.state).toBe('missing');
  });

  it('returns state present when hook is registered', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '/usr/local/bin/rigger-hook.sh' }],
          },
        ],
      },
    });

    const report = await auditHook(ENTRY, 'user', env, SPEC);

    expect(report.state).toBe('present');
    expect(report.id).toBe(ENTRY.id);
    expect(report.nature).toBe('hook');
  });

  it('uses project settings path when scope is project', async () => {
    const cwd = tmp.dir;
    const targets = resolveProjectTargets(cwd);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '/usr/local/bin/rigger-hook.sh' }],
          },
        ],
      },
    });

    const projectEntry: AdapterEntry = { ...ENTRY, scope: 'project' };
    const report = await auditHook(projectEntry, 'project', env, SPEC, cwd);

    expect(report.state).toBe('present');
  });
});

// ---------------------------------------------------------------------------
// planHook
// ---------------------------------------------------------------------------

describe('planHook', () => {
  it('returns a merge-hooks op when settings.json is absent', async () => {
    const ops = await planHook(ENTRY, 'user', env, SPEC);

    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('merge-hooks');
  });

  it('merge-hooks op has correct event, matcher, command', async () => {
    const targets = resolveUserTargets(env);
    const ops = await planHook(ENTRY, 'user', env, SPEC);

    const op = ops[0] as {
      kind: string;
      path: string;
      event: string;
      matcher: string;
      command: string;
    };
    expect(op.path).toBe(targets.claudeSettings);
    expect(op.event).toBe(SPEC.event);
    expect(op.matcher).toBe(SPEC.matcher);
    expect(op.command).toBe(SPEC.command);
  });

  it('does NOT include timeout in op when spec has no timeout (exactOptionalPropertyTypes)', async () => {
    const ops = await planHook(ENTRY, 'user', env, SPEC);

    const op = ops[0] as unknown as Record<string, unknown>;
    expect('timeout' in op).toBe(false);
  });

  it('includes timeout in op when spec has timeout', async () => {
    const ops = await planHook(ENTRY, 'user', env, SPEC_WITH_TIMEOUT);

    const op = ops[0] as { timeout?: number };
    expect(op.timeout).toBe(10);
  });

  it('returns [] when hook is already present (idempotent)', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '/usr/local/bin/rigger-hook.sh' }],
          },
        ],
      },
    });

    const ops = await planHook(ENTRY, 'user', env, SPEC);

    expect(ops).toHaveLength(0);
  });

  it('uses project settings path when scope is project', async () => {
    const cwd = tmp.dir;
    const targets = resolveProjectTargets(cwd);
    const projectEntry: AdapterEntry = { ...ENTRY, scope: 'project' };
    const ops = await planHook(projectEntry, 'project', env, SPEC, cwd);

    const op = ops[0] as { path: string };
    expect(op.path).toBe(targets.claudeSettings);
  });
});

// ---------------------------------------------------------------------------
// applyHook
// ---------------------------------------------------------------------------

describe('applyHook', () => {
  it('writes the hook to settings.json', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {});

    const ops = [
      {
        kind: 'merge-hooks' as const,
        path: targets.claudeSettings,
        event: SPEC.event,
        matcher: SPEC.matcher,
        command: SPEC.command,
      },
    ];
    await applyHook(ops, env);

    const result = await readJson(targets.claudeSettings);
    expect(hasHook(result, SPEC)).toBe(true);
  });

  it('preserves permissions.deny preexisting in settings.json', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      permissions: { deny: ['Read(./.env)', 'Read(~/.ssh/**)'] },
    });

    const ops = [
      {
        kind: 'merge-hooks' as const,
        path: targets.claudeSettings,
        event: SPEC.event,
        matcher: SPEC.matcher,
        command: SPEC.command,
      },
    ];
    await applyHook(ops, env);

    const result = await readJson(targets.claudeSettings);
    const deny = ((result['permissions'] as Record<string, unknown>)['deny']) as string[];
    expect(deny).toContain('Read(./.env)');
    expect(deny).toContain('Read(~/.ssh/**)');
    expect(hasHook(result, SPEC)).toBe(true);
  });

  it('is idempotent (applying twice does not duplicate the hook)', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {});

    const ops = [
      {
        kind: 'merge-hooks' as const,
        path: targets.claudeSettings,
        event: SPEC.event,
        matcher: SPEC.matcher,
        command: SPEC.command,
      },
    ];
    await applyHook(ops, env);
    await applyHook(ops, env);

    const result = await readJson(targets.claudeSettings);
    const hooksMap = result['hooks'] as Record<string, unknown>;
    const entries = hooksMap[SPEC.event] as Array<{ matcher: string; hooks: unknown[] }>;
    const matcherEntry = entries.find((e) => e.matcher === SPEC.matcher);
    expect(matcherEntry).toBeDefined();
    expect(matcherEntry!.hooks).toHaveLength(1);
  });

  it('ignores ops that are not merge-hooks kind', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, { model: 'sonnet' });

    const ops = [
      { kind: 'write-json' as const, path: targets.claudeSettings, description: 'noop' },
    ];
    await applyHook(ops, env);

    const result = await readJson(targets.claudeSettings);
    expect(result['model']).toBe('sonnet');
    expect(result['hooks']).toBeUndefined();
  });

  it('writes hook with timeout when op includes timeout', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {});

    const ops = [
      {
        kind: 'merge-hooks' as const,
        path: targets.claudeSettings,
        event: SPEC_WITH_TIMEOUT.event,
        matcher: SPEC_WITH_TIMEOUT.matcher,
        command: SPEC_WITH_TIMEOUT.command,
        timeout: 10,
      },
    ];
    await applyHook(ops, env);

    const result = await readJson(targets.claudeSettings);
    const hooksMap = result['hooks'] as Record<string, unknown>;
    const entries = hooksMap[SPEC_WITH_TIMEOUT.event] as Array<{
      matcher: string;
      hooks: Array<{ command: string; timeout?: number }>;
    }>;
    const matcherEntry = entries.find((e) => e.matcher === SPEC_WITH_TIMEOUT.matcher);
    expect(matcherEntry).toBeDefined();
    const cmd = matcherEntry!.hooks.find((h) => h.command === SPEC_WITH_TIMEOUT.command);
    expect(cmd).toBeDefined();
    expect(cmd!.timeout).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// planRemoveHook
// ---------------------------------------------------------------------------

describe('planRemoveHook', () => {
  it('returns [] when hook is not present', async () => {
    const ops = await planRemoveHook(ENTRY, 'user', env, SPEC);

    expect(ops).toHaveLength(0);
  });

  it('returns a remove-hooks op when hook is present', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '/usr/local/bin/rigger-hook.sh' }],
          },
        ],
      },
    });

    const ops = await planRemoveHook(ENTRY, 'user', env, SPEC);

    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('remove-hooks');
  });

  it('remove-hooks op has correct path, event, matcher, command', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '/usr/local/bin/rigger-hook.sh' }],
          },
        ],
      },
    });

    const ops = await planRemoveHook(ENTRY, 'user', env, SPEC);

    const op = ops[0] as {
      kind: string;
      path: string;
      event: string;
      matcher: string;
      command: string;
    };
    expect(op.path).toBe(targets.claudeSettings);
    expect(op.event).toBe(SPEC.event);
    expect(op.matcher).toBe(SPEC.matcher);
    expect(op.command).toBe(SPEC.command);
  });

  it('uses project settings path when scope is project', async () => {
    const cwd = tmp.dir;
    const targets = resolveProjectTargets(cwd);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '/usr/local/bin/rigger-hook.sh' }],
          },
        ],
      },
    });

    const projectEntry: AdapterEntry = { ...ENTRY, scope: 'project' };
    const ops = await planRemoveHook(projectEntry, 'project', env, SPEC, cwd);

    const op = ops[0] as { path: string };
    expect(op.path).toBe(targets.claudeSettings);
  });
});

// ---------------------------------------------------------------------------
// applyRemoveHook
// ---------------------------------------------------------------------------

describe('applyRemoveHook', () => {
  it('removes the hook from settings.json', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '/usr/local/bin/rigger-hook.sh' }],
          },
        ],
      },
    });

    const ops = [
      {
        kind: 'remove-hooks' as const,
        path: targets.claudeSettings,
        event: SPEC.event,
        matcher: SPEC.matcher,
        command: SPEC.command,
      },
    ];
    await applyRemoveHook(ops, env);

    const result = await readJson(targets.claudeSettings);
    expect(hasHook(result, SPEC)).toBe(false);
  });

  it('preserves permissions.deny after hook removal', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      permissions: { deny: ['Read(./.env)'] },
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '/usr/local/bin/rigger-hook.sh' }],
          },
        ],
      },
    });

    const ops = [
      {
        kind: 'remove-hooks' as const,
        path: targets.claudeSettings,
        event: SPEC.event,
        matcher: SPEC.matcher,
        command: SPEC.command,
      },
    ];
    await applyRemoveHook(ops, env);

    const result = await readJson(targets.claudeSettings);
    expect(hasHook(result, SPEC)).toBe(false);
    const deny = ((result['permissions'] as Record<string, unknown>)['deny']) as string[];
    expect(deny).toContain('Read(./.env)');
  });

  it('is a no-op when the hook is already absent', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, { model: 'sonnet' });

    const ops = [
      {
        kind: 'remove-hooks' as const,
        path: targets.claudeSettings,
        event: SPEC.event,
        matcher: SPEC.matcher,
        command: SPEC.command,
      },
    ];
    await applyRemoveHook(ops, env);

    const result = await readJson(targets.claudeSettings);
    expect(result['model']).toBe('sonnet');
  });

  it('ignores ops that are not remove-hooks kind', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, { model: 'sonnet' });

    const ops = [
      { kind: 'remove-deny' as const, path: targets.claudeSettings, rules: ['some-rule'] },
    ];
    await applyRemoveHook(ops, env);

    const result = await readJson(targets.claudeSettings);
    expect(result['model']).toBe('sonnet');
  });
});

// ---------------------------------------------------------------------------
// InvalidJsonError propagation
// ---------------------------------------------------------------------------

describe('hooks — InvalidJsonError propagation', () => {
  it('auditHook propagates InvalidJsonError on corrupt settings.json', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await Bun.write(targets.claudeSettings, '{ invalid json ');

    await expect(auditHook(ENTRY, 'user', env, SPEC)).rejects.toMatchObject({
      name: 'InvalidJsonError',
    });
  });

  it('planHook propagates InvalidJsonError on corrupt settings.json', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await Bun.write(targets.claudeSettings, '{ invalid json ');

    await expect(planHook(ENTRY, 'user', env, SPEC)).rejects.toMatchObject({
      name: 'InvalidJsonError',
    });
  });
});

// ---------------------------------------------------------------------------
// createClaudeAdapter — hook nature routing
// ---------------------------------------------------------------------------

describe('createClaudeAdapter — hook nature routing', () => {
  const fakeResolver = (_entry: AdapterEntry): ResolvedHook => SPEC;

  it('adapter.audit routes nature hook → present when installed', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '/usr/local/bin/rigger-hook.sh' }],
          },
        ],
      },
    });

    const adapter = createClaudeAdapter({ denyRef: [], hookSpec: fakeResolver });
    const report = await adapter.audit(ENTRY, 'user', env);

    expect(report.state).toBe('present');
    expect(report.nature).toBe('hook');
  });

  it('adapter.audit routes nature hook → missing when not installed', async () => {
    const adapter = createClaudeAdapter({ denyRef: [], hookSpec: fakeResolver });
    const report = await adapter.audit(ENTRY, 'user', env);

    expect(report.state).toBe('missing');
  });

  it('adapter.plan routes nature hook → merge-hooks ops', async () => {
    const adapter = createClaudeAdapter({ denyRef: [], hookSpec: fakeResolver });
    const ops = await adapter.plan(ENTRY, 'user', env);

    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('merge-hooks');
  });

  it('adapter.apply dispatches merge-hooks ops and writes hook to disk', async () => {
    const targets = resolveUserTargets(env);
    const adapter = createClaudeAdapter({ denyRef: [], hookSpec: fakeResolver });

    const ops = await adapter.plan(ENTRY, 'user', env);
    await adapter.apply(ops, env);

    const result = await readJson(targets.claudeSettings);
    expect(hasHook(result, SPEC)).toBe(true);
  });

  it('adapter.planRemove routes nature hook → remove-hooks when hook present', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '/usr/local/bin/rigger-hook.sh' }],
          },
        ],
      },
    });

    const adapter = createClaudeAdapter({ denyRef: [], hookSpec: fakeResolver });
    const ops = await adapter.planRemove(ENTRY, 'user', env);

    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('remove-hooks');
  });

  it('adapter.applyRemove dispatches remove-hooks ops and removes hook', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '/usr/local/bin/rigger-hook.sh' }],
          },
        ],
      },
    });

    const adapter = createClaudeAdapter({ denyRef: [], hookSpec: fakeResolver });
    const ops = await adapter.planRemove(ENTRY, 'user', env);
    await adapter.applyRemove(ops, env);

    const result = await readJson(targets.claudeSettings);
    expect(hasHook(result, SPEC)).toBe(false);
  });

  it('plan → apply → audit present → planRemove → applyRemove → audit missing', async () => {
    const targets = resolveUserTargets(env);
    const adapter = createClaudeAdapter({ denyRef: [], hookSpec: fakeResolver });

    // Install
    const installOps = await adapter.plan(ENTRY, 'user', env);
    await adapter.apply(installOps, env);

    // Verify present
    const reportAfterInstall = await adapter.audit(ENTRY, 'user', env);
    expect(reportAfterInstall.state).toBe('present');

    // 2nd plan → idempotent
    const secondPlan = await adapter.plan(ENTRY, 'user', env);
    expect(secondPlan).toHaveLength(0);

    // Remove
    const removeOps = await adapter.planRemove(ENTRY, 'user', env);
    await adapter.applyRemove(removeOps, env);

    // Verify missing
    const reportAfterRemove = await adapter.audit(ENTRY, 'user', env);
    expect(reportAfterRemove.state).toBe('missing');

    // Verify deny is untouched (was empty to begin with)
    const result = await readJson(targets.claudeSettings);
    expect(hasHook(result, SPEC)).toBe(false);
  });

  it('apply preserves permissions.deny through the full cycle', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      permissions: { deny: ['Read(./.env)', 'Read(~/.ssh/**)'] },
    });

    const adapter = createClaudeAdapter({ denyRef: [], hookSpec: fakeResolver });

    // Install hook
    const installOps = await adapter.plan(ENTRY, 'user', env);
    await adapter.apply(installOps, env);

    // Verify deny preserved
    let result = await readJson(targets.claudeSettings);
    let deny = ((result['permissions'] as Record<string, unknown>)['deny']) as string[];
    expect(deny).toContain('Read(./.env)');
    expect(hasHook(result, SPEC)).toBe(true);

    // Remove hook
    const removeOps = await adapter.planRemove(ENTRY, 'user', env);
    await adapter.applyRemove(removeOps, env);

    // Verify deny still preserved after removal
    result = await readJson(targets.claudeSettings);
    deny = ((result['permissions'] as Record<string, unknown>)['deny']) as string[];
    expect(deny).toContain('Read(./.env)');
    expect(hasHook(result, SPEC)).toBe(false);
  });

  it('throws when hookSpec is not configured and hook operation is attempted', async () => {
    const adapter = createClaudeAdapter({ denyRef: [] }); // no hookSpec

    await expect(adapter.plan(ENTRY, 'user', env)).rejects.toThrow('hookSpec');
  });
});

// ---------------------------------------------------------------------------
// D4 — guard-*.log files are preserved on re-install (non-destructive sync)
// ---------------------------------------------------------------------------

describe('applyHook — guard-*.log files preserved on re-install (D4)', () => {
  it('preserves a pre-existing guard-*.log runtime log after re-install', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });

    // Create a fake scriptSource directory with a guard script
    const scriptSource = path.join(tmp.dir, 'scripts-src');
    const scriptStore = path.join(tmp.dir, 'scripts-store');
    await fs.mkdir(scriptSource);
    await fs.writeFile(path.join(scriptSource, 'guard.sh'), '#!/bin/sh\necho guard v1');

    // First install — deposits the script
    const ops = [
      {
        kind: 'merge-hooks' as const,
        path: targets.claudeSettings,
        event: SPEC.event,
        matcher: SPEC.matcher,
        command: SPEC.command,
        scriptSource,
        scriptStore,
      },
    ];
    await applyHook(ops, env);

    // Simulate runtime: guard script writes a log into the store
    await fs.writeFile(path.join(scriptStore, 'guard-2026-06-23.log'), 'session run log');

    // Update the guard script source (new version)
    await fs.writeFile(path.join(scriptSource, 'guard.sh'), '#!/bin/sh\necho guard v2');

    // Re-install (same ops)
    await applyHook(ops, env);

    // The runtime log must still be there
    const logContent = await fs.readFile(path.join(scriptStore, 'guard-2026-06-23.log'), 'utf8');
    expect(logContent).toBe('session run log');

    // The script must be updated to v2
    const scriptContent = await fs.readFile(path.join(scriptStore, 'guard.sh'), 'utf8');
    expect(scriptContent).toBe('#!/bin/sh\necho guard v2');
  });

  it('does not leave stale source files in store after re-install', async () => {
    const targets = resolveUserTargets(env);
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });

    const scriptSource = path.join(tmp.dir, 'scripts-src2');
    const scriptStore = path.join(tmp.dir, 'scripts-store2');
    await fs.mkdir(scriptSource);
    await fs.writeFile(path.join(scriptSource, 'guard-old.sh'), '#!/bin/sh old');

    const ops = [
      {
        kind: 'merge-hooks' as const,
        path: targets.claudeSettings,
        event: SPEC.event,
        matcher: SPEC.matcher,
        command: SPEC.command,
        scriptSource,
        scriptStore,
      },
    ];
    await applyHook(ops, env);

    // Update source: old script removed, new one added
    await fs.rm(path.join(scriptSource, 'guard-old.sh'));
    await fs.writeFile(path.join(scriptSource, 'guard-new.sh'), '#!/bin/sh new');

    await applyHook(ops, env);

    const entries = await fs.readdir(scriptStore);
    expect(entries).toContain('guard-new.sh');
    expect(entries).not.toContain('guard-old.sh');
  });
});
