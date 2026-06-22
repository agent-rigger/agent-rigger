/**
 * Tests for core/src/hooks.ts — mergeHook, removeHook, hasHook.
 *
 * All functions are pure: settings object in → new object out, no I/O.
 * TDD: tests define the contract; implementation follows.
 *
 * Coverage:
 *  - mergeHook: creates event/matcher when absent; adds second matcher;
 *    dedup (same event+matcher+command is idempotent); preserves unrelated keys;
 *    sets timeout only when provided; adds command to existing matcher
 *  - removeHook: removes command; cleans up empty matcher/event/hooks key;
 *    no-op when hook is absent
 *  - hasHook: true/false detection
 *  - immutability: input object is never mutated
 */

import { describe, expect, it } from 'bun:test';

import { hasHook, mergeHook, removeHook } from './hooks';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Empty settings object — represents a fresh settings.json. */
const empty = (): Record<string, unknown> => ({});

/** Settings with a pre-existing permissions.deny array. */
const withDeny = (): Record<string, unknown> => ({
  permissions: { deny: ['Read(~/.ssh/**)'] },
});

// ---------------------------------------------------------------------------
// mergeHook — creates event/matcher when absent
// ---------------------------------------------------------------------------

describe('mergeHook — creates hooks.PreToolUse when absent', () => {
  it('creates the hooks key if missing', () => {
    const result = mergeHook(empty(), {
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'bun run /abs/guard.ts',
    });
    expect(result['hooks']).toBeDefined();
  });

  it('creates the event array under hooks', () => {
    const result = mergeHook(empty(), {
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'bun run /abs/guard.ts',
    });
    const hooks = result['hooks'] as Record<string, unknown>;
    expect(Array.isArray(hooks['PreToolUse'])).toBe(true);
  });

  it('creates a matcher entry with the correct structure', () => {
    const result = mergeHook(empty(), {
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'bun run /abs/guard.ts',
    });
    const hooks = result['hooks'] as Record<string, unknown>;
    const entries = hooks['PreToolUse'] as unknown[];
    expect(entries).toHaveLength(1);
    const entry = entries[0] as Record<string, unknown>;
    expect(entry['matcher']).toBe('Bash');
    const cmds = entry['hooks'] as unknown[];
    expect(cmds).toHaveLength(1);
    const cmd = cmds[0] as Record<string, unknown>;
    expect(cmd['type']).toBe('command');
    expect(cmd['command']).toBe('bun run /abs/guard.ts');
  });

  it('does not set timeout when not provided', () => {
    const result = mergeHook(empty(), {
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'bun run /abs/guard.ts',
    });
    const hooks = result['hooks'] as Record<string, unknown>;
    const entries = hooks['PreToolUse'] as unknown[];
    const entry = entries[0] as Record<string, unknown>;
    const cmds = entry['hooks'] as unknown[];
    const cmd = cmds[0] as Record<string, unknown>;
    expect('timeout' in cmd).toBe(false);
  });

  it('sets timeout when provided', () => {
    const result = mergeHook(empty(), {
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'bun run /abs/guard.ts',
      timeout: 5,
    });
    const hooks = result['hooks'] as Record<string, unknown>;
    const entries = hooks['PreToolUse'] as unknown[];
    const entry = entries[0] as Record<string, unknown>;
    const cmds = entry['hooks'] as unknown[];
    const cmd = cmds[0] as Record<string, unknown>;
    expect(cmd['timeout']).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// mergeHook — adds a second matcher under the same event
// ---------------------------------------------------------------------------

describe('mergeHook — adds second matcher under same event', () => {
  it('appends a new matcher entry when matcher differs', () => {
    const after1 = mergeHook(empty(), {
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'cmd-a',
    });
    const after2 = mergeHook(after1, {
      event: 'PreToolUse',
      matcher: 'Edit',
      command: 'cmd-b',
    });
    const hooks = after2['hooks'] as Record<string, unknown>;
    const entries = hooks['PreToolUse'] as unknown[];
    expect(entries).toHaveLength(2);
  });

  it('keeps both matchers accessible by index', () => {
    const after1 = mergeHook(empty(), {
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'cmd-a',
    });
    const after2 = mergeHook(after1, {
      event: 'PreToolUse',
      matcher: 'Edit',
      command: 'cmd-b',
    });
    const hooks = after2['hooks'] as Record<string, unknown>;
    const entries = hooks['PreToolUse'] as Array<Record<string, unknown>>;
    const matchers = entries.map((e) => e['matcher']);
    expect(matchers).toContain('Bash');
    expect(matchers).toContain('Edit');
  });
});

// ---------------------------------------------------------------------------
// mergeHook — adds command to an existing matcher's hooks[]
// ---------------------------------------------------------------------------

describe('mergeHook — adds command to existing matcher', () => {
  it('appends a second command to the same matcher without creating a new matcher entry', () => {
    const after1 = mergeHook(empty(), {
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'cmd-a',
    });
    const after2 = mergeHook(after1, {
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'cmd-b',
    });
    const hooks = after2['hooks'] as Record<string, unknown>;
    const entries = hooks['PreToolUse'] as Array<Record<string, unknown>>;
    // Still only one matcher entry
    expect(entries).toHaveLength(1);
    const cmds = entries[0]!['hooks'] as Array<Record<string, unknown>>;
    expect(cmds).toHaveLength(2);
    const commands = cmds.map((c) => c['command']);
    expect(commands).toContain('cmd-a');
    expect(commands).toContain('cmd-b');
  });
});

// ---------------------------------------------------------------------------
// mergeHook — idempotent (dedup)
// ---------------------------------------------------------------------------

describe('mergeHook — dedup / idempotent', () => {
  it('re-merging the same (event,matcher,command) is a no-op', () => {
    const spec = { event: 'PreToolUse', matcher: 'Bash', command: 'bun run /abs/guard.ts' };
    const first = mergeHook(empty(), spec);
    const second = mergeHook(first, spec);
    expect(second).toEqual(first);
  });

  it('hook count stays at 1 after re-merge', () => {
    const spec = { event: 'UserPromptSubmit', matcher: '*', command: 'echo hello' };
    const first = mergeHook(empty(), spec);
    const second = mergeHook(first, spec);
    const hooks = second['hooks'] as Record<string, unknown>;
    const entries = hooks['UserPromptSubmit'] as Array<Record<string, unknown>>;
    const cmds = entries[0]!['hooks'] as unknown[];
    expect(cmds).toHaveLength(1);
  });

  it('applying three times still yields same result as once', () => {
    const spec = { event: 'PreToolUse', matcher: 'Bash', command: 'guard.ts', timeout: 10 };
    const once = mergeHook(empty(), spec);
    const twice = mergeHook(once, spec);
    const thrice = mergeHook(twice, spec);
    expect(thrice).toEqual(once);
  });
});

// ---------------------------------------------------------------------------
// mergeHook — preserves unrelated keys
// ---------------------------------------------------------------------------

describe('mergeHook — preserves unrelated keys', () => {
  it('preserves permissions.deny array', () => {
    const result = mergeHook(withDeny(), {
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'cmd',
    });
    const perms = result['permissions'] as Record<string, unknown>;
    expect(perms['deny']).toEqual(['Read(~/.ssh/**)']);
  });

  it('preserves arbitrary top-level keys', () => {
    const input = { customKey: 'keep-me', other: 42 };
    const result = mergeHook(input, { event: 'PreToolUse', matcher: 'Bash', command: 'cmd' });
    expect(result['customKey']).toBe('keep-me');
    expect(result['other']).toBe(42);
  });

  it('does not remove existing hook events when adding a new event', () => {
    const after1 = mergeHook(empty(), { event: 'PreToolUse', matcher: 'Bash', command: 'cmd-a' });
    const after2 = mergeHook(after1, {
      event: 'UserPromptSubmit',
      matcher: '*',
      command: 'cmd-b',
    });
    const hooks = after2['hooks'] as Record<string, unknown>;
    expect(hooks['PreToolUse']).toBeDefined();
    expect(hooks['UserPromptSubmit']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// removeHook — removes command; cleans up empty containers
// ---------------------------------------------------------------------------

describe('removeHook — removes command from matcher', () => {
  it('removes the target command', () => {
    const merged = mergeHook(empty(), { event: 'PreToolUse', matcher: 'Bash', command: 'cmd' });
    const result = removeHook(merged, { event: 'PreToolUse', matcher: 'Bash', command: 'cmd' });
    const hooks = result['hooks'];
    expect(hooks).toBeUndefined();
  });

  it('removes only the target command when matcher has multiple commands', () => {
    const after1 = mergeHook(empty(), { event: 'PreToolUse', matcher: 'Bash', command: 'cmd-a' });
    const after2 = mergeHook(after1, { event: 'PreToolUse', matcher: 'Bash', command: 'cmd-b' });
    const result = removeHook(after2, { event: 'PreToolUse', matcher: 'Bash', command: 'cmd-a' });
    const hooks = result['hooks'] as Record<string, unknown>;
    const entries = hooks['PreToolUse'] as Array<Record<string, unknown>>;
    const cmds = entries[0]!['hooks'] as Array<Record<string, unknown>>;
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!['command']).toBe('cmd-b');
  });
});

describe('removeHook — cleans up empty matcher', () => {
  it('removes the matcher entry when its hooks[] becomes empty', () => {
    const after1 = mergeHook(empty(), { event: 'PreToolUse', matcher: 'Bash', command: 'only' });
    const after2 = mergeHook(after1, {
      event: 'PreToolUse',
      matcher: 'Edit',
      command: 'other-cmd',
    });
    const result = removeHook(after2, {
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'only',
    });
    const hooks = result['hooks'] as Record<string, unknown>;
    const entries = hooks['PreToolUse'] as Array<Record<string, unknown>>;
    const matchers = entries.map((e) => e['matcher']);
    expect(matchers).not.toContain('Bash');
    expect(matchers).toContain('Edit');
  });
});

describe('removeHook — cleans up empty event', () => {
  it('removes the event key when all matchers are removed', () => {
    const merged = mergeHook(empty(), { event: 'PreToolUse', matcher: 'Bash', command: 'cmd' });
    const result = removeHook(merged, { event: 'PreToolUse', matcher: 'Bash', command: 'cmd' });
    const hooks = result['hooks'] as Record<string, unknown> | undefined;
    expect(hooks?.['PreToolUse']).toBeUndefined();
  });
});

describe('removeHook — cleans up empty hooks key', () => {
  it('removes the hooks key entirely when it becomes empty', () => {
    const merged = mergeHook(empty(), { event: 'PreToolUse', matcher: 'Bash', command: 'cmd' });
    const result = removeHook(merged, { event: 'PreToolUse', matcher: 'Bash', command: 'cmd' });
    expect('hooks' in result).toBe(false);
  });

  it('preserves permissions.deny when hooks key is removed', () => {
    const base = mergeHook(withDeny(), { event: 'PreToolUse', matcher: 'Bash', command: 'cmd' });
    const result = removeHook(base, { event: 'PreToolUse', matcher: 'Bash', command: 'cmd' });
    const perms = result['permissions'] as Record<string, unknown>;
    expect(perms['deny']).toEqual(['Read(~/.ssh/**)']);
    expect('hooks' in result).toBe(false);
  });
});

describe('removeHook — no-op when hook is absent', () => {
  it('returns settings unchanged when the event does not exist', () => {
    const original = { permissions: { deny: ['Read(~/.ssh/**)'] } };
    const result = removeHook(original, {
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'ghost',
    });
    expect(result).toEqual(original);
  });

  it('returns settings unchanged when event exists but matcher differs', () => {
    const merged = mergeHook(empty(), { event: 'PreToolUse', matcher: 'Bash', command: 'cmd' });
    const result = removeHook(merged, {
      event: 'PreToolUse',
      matcher: 'Edit',
      command: 'cmd',
    });
    expect(result).toEqual(merged);
  });

  it('returns settings unchanged when matcher exists but command differs', () => {
    const merged = mergeHook(empty(), { event: 'PreToolUse', matcher: 'Bash', command: 'cmd-a' });
    const result = removeHook(merged, {
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'ghost',
    });
    expect(result).toEqual(merged);
  });
});

// ---------------------------------------------------------------------------
// hasHook
// ---------------------------------------------------------------------------

describe('hasHook', () => {
  it('returns false on empty settings', () => {
    expect(hasHook(empty(), { event: 'PreToolUse', matcher: 'Bash', command: 'cmd' })).toBe(false);
  });

  it('returns true after mergeHook', () => {
    const merged = mergeHook(empty(), { event: 'PreToolUse', matcher: 'Bash', command: 'cmd' });
    expect(hasHook(merged, { event: 'PreToolUse', matcher: 'Bash', command: 'cmd' })).toBe(true);
  });

  it('returns false after removeHook', () => {
    const merged = mergeHook(empty(), { event: 'PreToolUse', matcher: 'Bash', command: 'cmd' });
    const removed = removeHook(merged, { event: 'PreToolUse', matcher: 'Bash', command: 'cmd' });
    expect(hasHook(removed, { event: 'PreToolUse', matcher: 'Bash', command: 'cmd' })).toBe(false);
  });

  it('returns false when event matches but matcher differs', () => {
    const merged = mergeHook(empty(), { event: 'PreToolUse', matcher: 'Bash', command: 'cmd' });
    expect(hasHook(merged, { event: 'PreToolUse', matcher: 'Edit', command: 'cmd' })).toBe(false);
  });

  it('returns false when matcher matches but command differs', () => {
    const merged = mergeHook(empty(), { event: 'PreToolUse', matcher: 'Bash', command: 'cmd-a' });
    expect(hasHook(merged, { event: 'PreToolUse', matcher: 'Bash', command: 'cmd-b' })).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Immutability — input must not be mutated
// ---------------------------------------------------------------------------

describe('immutability', () => {
  it('mergeHook does not mutate the input object', () => {
    const input: Record<string, unknown> = {};
    const snapshot = JSON.stringify(input);
    mergeHook(input, { event: 'PreToolUse', matcher: 'Bash', command: 'cmd' });
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('removeHook does not mutate the input object', () => {
    const merged = mergeHook(empty(), { event: 'PreToolUse', matcher: 'Bash', command: 'cmd' });
    const snapshot = JSON.stringify(merged);
    removeHook(merged, { event: 'PreToolUse', matcher: 'Bash', command: 'cmd' });
    expect(JSON.stringify(merged)).toBe(snapshot);
  });

  it('mergeHook returns a new object reference', () => {
    const input: Record<string, unknown> = {};
    const result = mergeHook(input, { event: 'PreToolUse', matcher: 'Bash', command: 'cmd' });
    expect(result).not.toBe(input);
  });

  it('removeHook returns a new object reference', () => {
    const merged = mergeHook(empty(), { event: 'PreToolUse', matcher: 'Bash', command: 'cmd' });
    const result = removeHook(merged, { event: 'PreToolUse', matcher: 'Bash', command: 'cmd' });
    expect(result).not.toBe(merged);
  });
});
