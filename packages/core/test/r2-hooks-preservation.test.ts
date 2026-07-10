/**
 * Tests for R2 — hook rewrite preserves everything rigger does not recognize
 * (core/src/hooks.ts mergeHook / removeHook / hasHook).
 *
 * Requirement (docs/specs/lot2-remove-reversible/requirements.md, R2):
 *   mergeHook/removeHook SHALL reassemble hooks.<event> keeping identical any
 *   entry or item they do not manage: entries without `matcher` (native Claude
 *   Code format for Stop, SessionStart, PreCompact…), items that are not
 *   type:"command", unknown fields. Previously toMatcherEntries coerced the
 *   event array and silently dropped anything unrecognized — user hooks on the
 *   same event were destroyed at install and at remove.
 *
 * Design D2: operate on the RAW event array (unknown[]), locate the entry whose
 * matcher === spec.matcher, only touch recognized command items, reassemble
 * preserving everything else in place and in order. Non-array event value →
 * typed actionable error (fail-closed), file never rewritten. hasHook stays
 * matcher-strict (unchanged).
 */

import { describe, expect, it } from 'bun:test';

import {
  hasHook,
  InvalidHooksEventError,
  InvalidHooksRootError,
  mergeHook,
  removeHook,
} from '../src/hooks';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RIGGER_STOP_SPEC = { event: 'Stop', matcher: '*', command: 'bun run /abs/rigger-stop.ts' };

const RIGGER_BASH_SPEC = {
  event: 'PreToolUse',
  matcher: 'Bash',
  command: 'bun run /abs/guard.ts',
};

/** Native Claude Code entry without matcher (Stop, PreCompact… format). */
const userEntryWithoutMatcher = (): Record<string, unknown> => ({
  hooks: [{ type: 'command', command: '~/bin/notify.sh' }],
});

/** A hooks[] item of a type rigger does not know. */
const foreignItem = (): Record<string, unknown> => ({ type: 'future-type', x: 1 });

// ---------------------------------------------------------------------------
// R2 — install on an event carrying a user entry without matcher
// ---------------------------------------------------------------------------

describe('R2: mergeHook preserves user entries without matcher', () => {
  it('R2: keeps the user entry unchanged and appends the rigger entry', () => {
    const settings = { hooks: { Stop: [userEntryWithoutMatcher()] } };

    const result = mergeHook(settings, RIGGER_STOP_SPEC);

    const hooks = result['hooks'] as Record<string, unknown>;
    const entries = hooks['Stop'] as unknown[];
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(userEntryWithoutMatcher());
    const riggerEntry = entries[1] as Record<string, unknown>;
    expect(riggerEntry['matcher']).toBe('*');
    expect(riggerEntry['hooks']).toEqual([
      { type: 'command', command: RIGGER_STOP_SPEC.command },
    ]);
  });

  it('R2: preserves the order of existing entries (rigger entry appended last)', () => {
    const first = userEntryWithoutMatcher();
    const second = { matcher: 'Edit', hooks: [{ type: 'command', command: 'user-edit.sh' }] };
    const settings = { hooks: { PreToolUse: [first, second] } };

    const result = mergeHook(settings, RIGGER_BASH_SPEC);

    const hooks = result['hooks'] as Record<string, unknown>;
    const entries = hooks['PreToolUse'] as unknown[];
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual(first);
    expect(entries[1]).toEqual(second);
    expect((entries[2] as Record<string, unknown>)['matcher']).toBe('Bash');
  });

  it('R2: preserves entries that are not even objects (unknown future format)', () => {
    const settings = { hooks: { Stop: ['opaque-string-entry', userEntryWithoutMatcher()] } };

    const result = mergeHook(settings, RIGGER_STOP_SPEC);

    const hooks = result['hooks'] as Record<string, unknown>;
    const entries = hooks['Stop'] as unknown[];
    expect(entries[0]).toBe('opaque-string-entry');
    expect(entries[1]).toEqual(userEntryWithoutMatcher());
  });
});

// ---------------------------------------------------------------------------
// R2 — remove only touches the rigger entry (round-trip byte for byte)
// ---------------------------------------------------------------------------

describe('R2: removeHook only touches the rigger entry', () => {
  it('R2: merge then remove restores the settings byte for byte (entry without matcher)', () => {
    const original = {
      hooks: { Stop: [userEntryWithoutMatcher()] },
      permissions: { deny: ['Read(~/.ssh/**)'] },
    };
    const snapshot = JSON.stringify(original);

    const merged = mergeHook(original, RIGGER_STOP_SPEC);
    const removed = removeHook(merged, RIGGER_STOP_SPEC);

    expect(JSON.stringify(removed)).toBe(snapshot);
  });

  it('R2: after remove, hooks.Stop contains exactly the original user entry', () => {
    const settings = { hooks: { Stop: [userEntryWithoutMatcher()] } };

    const merged = mergeHook(settings, RIGGER_STOP_SPEC);
    const removed = removeHook(merged, RIGGER_STOP_SPEC);

    const hooks = removed['hooks'] as Record<string, unknown>;
    expect(hooks['Stop']).toEqual([userEntryWithoutMatcher()]);
  });

  it('R2: a user entry without matcher between two matcher entries stays in place', () => {
    const before = { matcher: 'Edit', hooks: [{ type: 'command', command: 'edit.sh' }] };
    const middle = userEntryWithoutMatcher();
    const after = {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: RIGGER_BASH_SPEC.command }],
    };
    const settings = { hooks: { PreToolUse: [before, middle, after] } };

    const removed = removeHook(settings, RIGGER_BASH_SPEC);

    const hooks = removed['hooks'] as Record<string, unknown>;
    const entries = hooks['PreToolUse'] as unknown[];
    expect(entries).toEqual([before, middle]);
  });
});

// ---------------------------------------------------------------------------
// R2 — non-command items preserved inside the targeted matcher entry
// ---------------------------------------------------------------------------

describe('R2: non-command items preserved in the targeted matcher', () => {
  const originalEntry = () => ({
    matcher: 'Bash',
    hooks: [{ type: 'command', command: 'user.sh' }, foreignItem()],
  });

  it('R2: after merge, both original items are still present next to the rigger command', () => {
    const settings = { hooks: { PreToolUse: [originalEntry()] } };

    const merged = mergeHook(settings, RIGGER_BASH_SPEC);

    const hooks = merged['hooks'] as Record<string, unknown>;
    const entries = hooks['PreToolUse'] as unknown[];
    expect(entries).toHaveLength(1);
    const entry = entries[0] as Record<string, unknown>;
    const items = entry['hooks'] as unknown[];
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({ type: 'command', command: 'user.sh' });
    expect(items[1]).toEqual(foreignItem());
    expect(items[2]).toEqual({ type: 'command', command: RIGGER_BASH_SPEC.command });
  });

  it('R2: after merge then remove, the array is back byte for byte', () => {
    const original = { hooks: { PreToolUse: [originalEntry()] } };
    const snapshot = JSON.stringify(original);

    const merged = mergeHook(original, RIGGER_BASH_SPEC);
    const removed = removeHook(merged, RIGGER_BASH_SPEC);

    expect(JSON.stringify(removed)).toBe(snapshot);
  });

  it('R2: unknown fields on the matcher entry survive merge and remove', () => {
    const entry = {
      matcher: 'Bash',
      description: 'user annotation',
      hooks: [{ type: 'command', command: 'user.sh' }],
    };
    const settings = { hooks: { PreToolUse: [entry] } };

    const merged = mergeHook(settings, RIGGER_BASH_SPEC);
    const mergedEntry =
      ((merged['hooks'] as Record<string, unknown>)['PreToolUse'] as unknown[])[0] as Record<
        string,
        unknown
      >;
    expect(mergedEntry['description']).toBe('user annotation');

    const removed = removeHook(merged, RIGGER_BASH_SPEC);
    const removedEntry =
      ((removed['hooks'] as Record<string, unknown>)['PreToolUse'] as unknown[])[0] as Record<
        string,
        unknown
      >;
    expect(removedEntry).toEqual(entry);
  });
});

// ---------------------------------------------------------------------------
// R2 — the matcher entry survives if foreign items remain
// ---------------------------------------------------------------------------

describe('R2: matcher entry survives when foreign items remain', () => {
  it('R2: removing the rigger command keeps the entry with its foreign item', () => {
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: RIGGER_BASH_SPEC.command }, foreignItem()],
          },
        ],
      },
    };

    const removed = removeHook(settings, RIGGER_BASH_SPEC);

    const hooks = removed['hooks'] as Record<string, unknown>;
    const entries = hooks['PreToolUse'] as unknown[];
    expect(entries).toHaveLength(1);
    const entry = entries[0] as Record<string, unknown>;
    expect(entry['matcher']).toBe('Bash');
    expect(entry['hooks']).toEqual([foreignItem()]);
  });

  it('R2: the entry is still removed when its hooks[] becomes truly empty', () => {
    const settings = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: RIGGER_BASH_SPEC.command }] },
          { matcher: 'Edit', hooks: [{ type: 'command', command: 'edit.sh' }] },
        ],
      },
    };

    const removed = removeHook(settings, RIGGER_BASH_SPEC);

    const hooks = removed['hooks'] as Record<string, unknown>;
    const entries = hooks['PreToolUse'] as Array<Record<string, unknown>>;
    expect(entries.map((e) => e['matcher'])).toEqual(['Edit']);
  });
});

// ---------------------------------------------------------------------------
// R2 — malformed event value: fail-closed
// ---------------------------------------------------------------------------

describe('R2: non-array event value fails closed', () => {
  it('R2: mergeHook throws InvalidHooksEventError naming the path and expected shape', () => {
    const settings = { hooks: { Stop: { oops: true } } };

    expect(() => mergeHook(settings, RIGGER_STOP_SPEC)).toThrow(InvalidHooksEventError);
    try {
      mergeHook(settings, RIGGER_STOP_SPEC);
      throw new Error('expected mergeHook to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidHooksEventError);
      const typed = err as InvalidHooksEventError;
      expect(typed.event).toBe('Stop');
      expect(typed.jsonPath).toBe('hooks.Stop');
      expect(typed.message).toContain('hooks.Stop');
      expect(typed.message).toContain('array');
    }
  });

  it('R2: removeHook throws InvalidHooksEventError on a non-array event value', () => {
    const settings = { hooks: { Stop: 'not-an-array' } };

    expect(() => removeHook(settings, RIGGER_STOP_SPEC)).toThrow(InvalidHooksEventError);
  });

  it('R2: the input settings object is not mutated when the event value is malformed', () => {
    const settings = { hooks: { Stop: { oops: true } } };
    const snapshot = JSON.stringify(settings);

    expect(() => mergeHook(settings, RIGGER_STOP_SPEC)).toThrow(InvalidHooksEventError);
    expect(() => removeHook(settings, RIGGER_STOP_SPEC)).toThrow(InvalidHooksEventError);
    expect(JSON.stringify(settings)).toBe(snapshot);
  });

  it('R2: a malformed value on ANOTHER event does not block the targeted event', () => {
    const settings = {
      hooks: { PreCompact: { oops: true }, Stop: [userEntryWithoutMatcher()] },
    };

    const merged = mergeHook(settings, RIGGER_STOP_SPEC);

    const hooks = merged['hooks'] as Record<string, unknown>;
    expect(hooks['PreCompact']).toEqual({ oops: true });
    expect(hooks['Stop']).toHaveLength(2);
  });

  it('R2: hasHook stays matcher-strict and lenient — false on a non-array event value', () => {
    const settings = { hooks: { Stop: { oops: true } } };

    expect(hasHook(settings, RIGGER_STOP_SPEC)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R2 — malformed hooks ROOT: fail-closed one level above the event
// ---------------------------------------------------------------------------

describe('R2: non-object hooks root fails closed', () => {
  it('R2: mergeHook throws InvalidHooksRootError when hooks is an array (user content never replaced)', () => {
    const settings = { hooks: ['user-opaque-entry', { custom: true }] };
    const snapshot = JSON.stringify(settings);

    expect(() => mergeHook(settings, RIGGER_STOP_SPEC)).toThrow(InvalidHooksRootError);
    try {
      mergeHook(settings, RIGGER_STOP_SPEC);
      throw new Error('expected mergeHook to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidHooksRootError);
      const typed = err as InvalidHooksRootError;
      expect(typed.jsonPath).toBe('hooks');
      expect(typed.message).toContain('"hooks"');
      expect(typed.message).toContain('object');
    }
    expect(JSON.stringify(settings)).toBe(snapshot);
  });

  it('R2: removeHook throws InvalidHooksRootError when hooks is a string (user content never deleted)', () => {
    const settings = { hooks: 'str' };

    expect(() => removeHook(settings, RIGGER_STOP_SPEC)).toThrow(InvalidHooksRootError);
  });

  it('R2: mergeHook and removeHook throw on hooks: null and hooks: 42', () => {
    for (const value of [null, 42]) {
      const settings = { hooks: value };
      expect(() => mergeHook(settings, RIGGER_STOP_SPEC)).toThrow(InvalidHooksRootError);
      expect(() => removeHook(settings, RIGGER_STOP_SPEC)).toThrow(InvalidHooksRootError);
    }
  });

  it('R2: an ABSENT hooks key is not an error — mergeHook creates the map', () => {
    const merged = mergeHook({ permissions: { deny: [] } }, RIGGER_STOP_SPEC);

    expect(hasHook(merged, RIGGER_STOP_SPEC)).toBe(true);
  });

  it('R2: hasHook stays lenient — false on a malformed hooks root, never a throw', () => {
    expect(hasHook({ hooks: ['x'] }, RIGGER_STOP_SPEC)).toBe(false);
    expect(hasHook({ hooks: 'str' }, RIGGER_STOP_SPEC)).toBe(false);
    expect(hasHook({ hooks: null }, RIGGER_STOP_SPEC)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R2 — duplicate matcher entries: recognition spans ALL of them
// ---------------------------------------------------------------------------

describe('R2: duplicate matcher entries are all inspected', () => {
  /** The rigger command lives in the SECOND Bash entry (manual reorder/edit —
   * a format Claude Code accepts). */
  const duplicateMatcherSettings = () => ({
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'user-first.sh' }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: RIGGER_BASH_SPEC.command }] },
      ],
    },
  });

  it('R2: hasHook finds the command in a later same-matcher entry', () => {
    expect(hasHook(duplicateMatcherSettings(), RIGGER_BASH_SPEC)).toBe(true);
  });

  it('R2: mergeHook does not register the command a second time (no double execution)', () => {
    const settings = duplicateMatcherSettings();
    const snapshot = JSON.stringify(settings);

    const merged = mergeHook(settings, RIGGER_BASH_SPEC);

    // Idempotent: the command already lives in the second entry — merging it
    // into the first would make the guard run twice on every tool use.
    expect(JSON.stringify(merged)).toBe(snapshot);
    const entries = (merged['hooks'] as Record<string, unknown>)['PreToolUse'] as Array<
      { hooks: unknown[] }
    >;
    const registrations = entries.flatMap((e) => e.hooks).filter(
      (cmd) => (cmd as { command?: string }).command === RIGGER_BASH_SPEC.command,
    );
    expect(registrations).toHaveLength(1);
  });

  it('R2: removeHook strips the command from every same-matcher entry', () => {
    const settings = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: RIGGER_BASH_SPEC.command }] },
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: 'user.sh' },
              { type: 'command', command: RIGGER_BASH_SPEC.command },
            ],
          },
        ],
      },
    };

    const removed = removeHook(settings, RIGGER_BASH_SPEC);

    expect(hasHook(removed, RIGGER_BASH_SPEC)).toBe(false);
    const entries = (removed['hooks'] as Record<string, unknown>)['PreToolUse'] as Array<
      { hooks: unknown[] }
    >;
    // First entry emptied → dropped; second keeps the user command only.
    expect(entries).toHaveLength(1);
    expect(entries[0]!.hooks).toEqual([{ type: 'command', command: 'user.sh' }]);
  });
});
