import { describe, expect, test } from 'bun:test';

import {
  computeMissingPermission,
  hasMcp,
  hasPermission,
  mergeMcp,
  mergePermission,
  removeMcp,
  removePermission,
} from './opencode-json';
import type { OpencodeMcpServer, OpencodePermission } from './types';

// ---------------------------------------------------------------------------
// permission — computeMissing / merge
// ---------------------------------------------------------------------------

describe('computeMissingPermission', () => {
  test('returns full fragment when current is empty', () => {
    const fragment: OpencodePermission = { edit: 'ask', bash: { 'rm -rf *': 'deny' } };
    expect(computeMissingPermission(fragment, {})).toEqual(fragment);
  });

  test('excludes flat leaves already present (any state)', () => {
    const current: OpencodePermission = { edit: 'allow' };
    const fragment: OpencodePermission = { edit: 'ask', write: 'deny' };
    // edit present (path exists) → not re-added; write missing → added.
    expect(computeMissingPermission(fragment, current)).toEqual({ write: 'deny' });
  });

  test('excludes nested bash patterns already present, keeps missing ones', () => {
    const current: OpencodePermission = { bash: { 'rm -rf *': 'deny' } };
    const fragment: OpencodePermission = {
      bash: { 'rm -rf *': 'deny', 'git push --force': 'deny' },
    };
    expect(computeMissingPermission(fragment, current)).toEqual({
      bash: { 'git push --force': 'deny' },
    });
  });

  test('dedups repeated leaves within the fragment', () => {
    const fragment: OpencodePermission = { bash: { 'rm -rf *': 'deny' } };
    expect(computeMissingPermission(fragment, {})).toEqual(fragment);
  });
});

describe('mergePermission', () => {
  test('adds missing leaves, preserves existing user leaves untouched', () => {
    const current: OpencodePermission = { edit: 'allow', bash: { 'ls *': 'allow' } };
    const fragment: OpencodePermission = { edit: 'deny', bash: { 'rm -rf *': 'deny' } };
    const merged = mergePermission(current, fragment);
    // edit preserved as 'allow' (not overwritten); new bash pattern added.
    expect(merged).toEqual({
      edit: 'allow',
      bash: { 'ls *': 'allow', 'rm -rf *': 'deny' },
    });
  });

  test('does not mutate inputs', () => {
    const current: OpencodePermission = { edit: 'allow' };
    const fragment: OpencodePermission = { write: 'deny' };
    mergePermission(current, fragment);
    expect(current).toEqual({ edit: 'allow' });
    expect(fragment).toEqual({ write: 'deny' });
  });

  test('is idempotent', () => {
    const fragment: OpencodePermission = { bash: { 'rm -rf *': 'deny' } };
    const once = mergePermission({}, fragment);
    const twice = mergePermission(once, fragment);
    expect(twice).toEqual(once);
  });
});

// ---------------------------------------------------------------------------
// permission — remove (inverse) / has
// ---------------------------------------------------------------------------

describe('removePermission', () => {
  test('removes exactly the managed leaves, preserves user leaves', () => {
    const current: OpencodePermission = {
      edit: 'allow',
      bash: { 'ls *': 'allow', 'rm -rf *': 'deny' },
    };
    const applied: OpencodePermission = { bash: { 'rm -rf *': 'deny' } };
    expect(removePermission(current, applied)).toEqual({
      edit: 'allow',
      bash: { 'ls *': 'allow' },
    });
  });

  test('prunes a nested map emptied by removal', () => {
    const current: OpencodePermission = { bash: { 'rm -rf *': 'deny' } };
    const applied: OpencodePermission = { bash: { 'rm -rf *': 'deny' } };
    expect(removePermission(current, applied)).toEqual({});
  });

  test('does not remove a leaf whose state differs (only removes what we added)', () => {
    const current: OpencodePermission = { edit: 'allow' };
    const applied: OpencodePermission = { edit: 'deny' };
    expect(removePermission(current, applied)).toEqual({ edit: 'allow' });
  });

  test('no-op for absent leaves', () => {
    const current: OpencodePermission = { edit: 'allow' };
    expect(removePermission(current, { write: 'deny' })).toEqual({ edit: 'allow' });
  });

  test('merge then remove round-trips to original', () => {
    const original: OpencodePermission = { edit: 'allow', bash: { 'ls *': 'allow' } };
    const fragment: OpencodePermission = { bash: { 'rm -rf *': 'deny' }, write: 'deny' };
    const added = computeMissingPermission(fragment, original);
    const merged = mergePermission(original, fragment);
    expect(removePermission(merged, added)).toEqual(original);
  });
});

describe('hasPermission', () => {
  test('true when every leaf present with same state', () => {
    const current: OpencodePermission = { edit: 'ask', bash: { 'rm -rf *': 'deny' } };
    expect(hasPermission(current, { bash: { 'rm -rf *': 'deny' } })).toBe(true);
  });

  test('false when a leaf is missing', () => {
    expect(hasPermission({ edit: 'ask' }, { write: 'deny' })).toBe(false);
  });

  test('false when a leaf state differs', () => {
    expect(hasPermission({ edit: 'allow' }, { edit: 'deny' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// permission — shape-conflict is non-destructive (Review HIGH-1)
// ---------------------------------------------------------------------------

describe('mergePermission — flat/nested shape conflicts are non-destructive', () => {
  test('a nested fragment never overwrites an existing flat state for the same tool', () => {
    const current: OpencodePermission = { bash: 'deny' };
    const fragment: OpencodePermission = { bash: { 'rm -rf *': 'deny' } };
    // The existing flat "deny all bash" must be preserved (merge is additive).
    expect(mergePermission(current, fragment)).toEqual({ bash: 'deny' });
    expect(computeMissingPermission(fragment, current)).toEqual({});
  });

  test('a flat fragment never overwrites an existing nested map for the same tool', () => {
    const current: OpencodePermission = { bash: { 'rm -rf *': 'deny' } };
    const fragment: OpencodePermission = { bash: 'deny' };
    expect(mergePermission(current, fragment)).toEqual({ bash: { 'rm -rf *': 'deny' } });
    expect(computeMissingPermission(fragment, current)).toEqual({});
  });

  test('a nested fragment still adds a new pattern to an existing nested map', () => {
    const current: OpencodePermission = { bash: { 'ls *': 'allow' } };
    const fragment: OpencodePermission = { bash: { 'rm -rf *': 'deny' } };
    expect(mergePermission(current, fragment)).toEqual({
      bash: { 'ls *': 'allow', 'rm -rf *': 'deny' },
    });
  });
});

// ---------------------------------------------------------------------------
// mcp
// ---------------------------------------------------------------------------

const localServer: OpencodeMcpServer = {
  type: 'local',
  command: ['npx', '-y', 'some-mcp'],
  environment: { TOKEN: '{env:MY_TOKEN}' },
};

describe('mergeMcp', () => {
  test('adds a server when absent', () => {
    expect(mergeMcp({}, 'srv', localServer)).toEqual({ srv: localServer });
  });

  test('preserves a pre-existing server of the same id (no overwrite)', () => {
    const existing: OpencodeMcpServer = { type: 'remote', url: 'https://x' };
    const merged = mergeMcp({ srv: existing }, 'srv', localServer);
    expect(merged).toEqual({ srv: existing });
  });

  test('does not mutate input', () => {
    const current = {};
    mergeMcp(current, 'srv', localServer);
    expect(current).toEqual({});
  });

  test('is idempotent', () => {
    const once = mergeMcp({}, 'srv', localServer);
    expect(mergeMcp(once, 'srv', localServer)).toEqual(once);
  });
});

describe('removeMcp', () => {
  test('removes the named server, preserves others', () => {
    const other: OpencodeMcpServer = { type: 'remote', url: 'https://y' };
    expect(removeMcp({ srv: localServer, other }, 'srv')).toEqual({ other });
  });

  test('no-op when absent', () => {
    expect(removeMcp({ srv: localServer }, 'missing')).toEqual({ srv: localServer });
  });
});

describe('hasMcp', () => {
  test('true when present, false when absent', () => {
    expect(hasMcp({ srv: localServer }, 'srv')).toBe(true);
    expect(hasMcp({ srv: localServer }, 'nope')).toBe(false);
  });
});
