/**
 * Tests for opencode/permission-translate (TDD — written before implementation).
 *
 * Pure, total, never throws. Covers the §7.1 translation table (design.md):
 * - Bash(<pattern>) → nested bash map.
 * - Read/Write/Edit(<arg>) → tool-level state; a specific (non "*"/empty) arg loses
 *   granularity and is surfaced as a warning.
 * - bare tool token → tool-level state (lowercased).
 * - unparseable/composite rules → omitted, warning emitted, never throws.
 * - deny rules → state 'deny'; allow rules → state 'allow'.
 * - dedup: repeated leaves collapse into one.
 */

import { describe, expect, it } from 'bun:test';

import { mergePermission } from '@agent-rigger/core';

import { translateRules } from '../../src/opencode/permission-translate';

// ---------------------------------------------------------------------------
// Review HIGH-1 regression: pattern-level tools are ALWAYS nested, so a tool key
// never mixes flat + nested shapes (which a merge would silently narrow).
// ---------------------------------------------------------------------------

describe('translateRules — bash always nested (HIGH-1)', () => {
  it('translates a bare `Bash` to nested { bash: { "*": deny } }, not a flat state', () => {
    const { permission } = translateRules(['Bash'], []);
    expect(permission).toEqual({ bash: { '*': 'deny' } });
  });

  it('translates `Bash()` (empty arg) to the "*" pattern, not an empty key', () => {
    const { permission } = translateRules(['Bash()'], []);
    expect(permission).toEqual({ bash: { '*': 'deny' } });
  });

  it('mixing bare `Bash` and `Bash(rm -rf *)` never drops the deny-all rule', () => {
    const { permission } = translateRules(['Bash', 'Bash(rm -rf *)'], []);
    // Both survive as sibling patterns under the same nested map — no overwrite.
    expect(permission).toEqual({ bash: { '*': 'deny', 'rm -rf *': 'deny' } });
  });

  it('is order-independent for bash rules (no shape collision either way)', () => {
    const a = translateRules(['Bash(rm -rf *)', 'Bash'], []).permission;
    const b = translateRules(['Bash', 'Bash(rm -rf *)'], []).permission;
    expect(a).toEqual(b);
  });

  it('a translated deny-all-bash is not narrowed when merged over a user pattern', () => {
    // User already has a specific bash pattern; installing deny-all must ADD, not clobber.
    const userConfig = { bash: { 'ls *': 'allow' as const } };
    const { permission } = translateRules(['Bash'], []);
    expect(mergePermission(userConfig, permission)).toEqual({
      bash: { 'ls *': 'allow', '*': 'deny' },
    });
  });
});

describe('translateRules — §7.1 table', () => {
  it('translates Bash(<pattern>) into a nested bash map (deny)', () => {
    const { permission, warnings } = translateRules(['Bash(rm -rf *)'], []);

    expect(permission).toEqual({ bash: { 'rm -rf *': 'deny' } });
    expect(warnings).toEqual([]);
  });

  it('translates Bash(*) into a nested bash map', () => {
    const { permission, warnings } = translateRules(['Bash(*)'], []);

    expect(permission).toEqual({ bash: { '*': 'deny' } });
    expect(warnings).toEqual([]);
  });

  it('translates Read(<specific path>) into tool-level state with a warning', () => {
    const { permission, warnings } = translateRules(['Read(./.env)'], []);

    expect(permission).toEqual({ read: 'deny' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Read(./.env)');
  });

  it('translates Write(<specific glob>) into tool-level state with a warning', () => {
    const { permission, warnings } = translateRules(['Write(./secrets/**)'], []);

    expect(permission).toEqual({ write: 'deny' });
    expect(warnings).toHaveLength(1);
  });

  it('translates Edit(<specific path>) into tool-level state with a warning', () => {
    const { permission, warnings } = translateRules(['Edit(./config.json)'], []);

    expect(permission).toEqual({ edit: 'deny' });
    expect(warnings).toHaveLength(1);
  });

  it('does not warn when the Read/Write/Edit arg is "*" (no specificity lost)', () => {
    const { permission, warnings } = translateRules(['Read(*)'], []);

    expect(permission).toEqual({ read: 'deny' });
    expect(warnings).toEqual([]);
  });

  it('does not warn when the Read/Write/Edit arg is empty', () => {
    const { permission, warnings } = translateRules(['Read()'], []);

    expect(permission).toEqual({ read: 'deny' });
    expect(warnings).toEqual([]);
  });

  it('translates a bare tool token into a lowercased tool-level state', () => {
    const { permission, warnings } = translateRules(['WebFetch'], []);

    expect(permission).toEqual({ webfetch: 'deny' });
    expect(warnings).toEqual([]);
  });

  it('uses state "allow" for allow rules', () => {
    const { permission } = translateRules([], ['Bash(git push)', 'WebFetch']);

    expect(permission).toEqual({ bash: { 'git push': 'allow' }, webfetch: 'allow' });
  });

  it('merges multiple deny + allow rules into a single permission object', () => {
    const { permission } = translateRules(
      ['Bash(rm -rf *)', 'Read(./.env)'],
      ['Bash(ls *)', 'WebFetch'],
    );

    expect(permission).toEqual({
      bash: { 'rm -rf *': 'deny', 'ls *': 'allow' },
      read: 'deny',
      webfetch: 'allow',
    });
  });

  it('dedups a repeated leaf', () => {
    const { permission } = translateRules(['Bash(rm -rf *)', 'Bash(rm -rf *)'], []);

    expect(permission).toEqual({ bash: { 'rm -rf *': 'deny' } });
  });

  it('omits an unparseable/composite rule and emits a warning (never throws)', () => {
    expect(() => translateRules(['Bash(rm -rf *) || Bash(curl *)'], [])).not.toThrow();

    const { permission, warnings } = translateRules(['Bash(rm -rf *) || Bash(curl *)'], []);

    expect(permission).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Bash(rm -rf *) || Bash(curl *)');
  });

  it('returns empty permission and no warnings for empty deny/allow', () => {
    const { permission, warnings } = translateRules([], []);

    expect(permission).toEqual({});
    expect(warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Review H8 regression: Claude ":*" prefix syntax (`Bash(cmd:*)`) must be
// converted to equivalent opencode globs — opencode treats ":" literally, so a
// verbatim "cmd:*" pattern would NEVER match "cmd <args>" (silently inert deny).
// Claude semantics of "<prefix>:*": matches "<prefix>" exactly AND
// "<prefix> <anything>" → two glob leaves: "<prefix>" and "<prefix> *".
// ---------------------------------------------------------------------------

describe('translateRules — Claude ":*" prefix syntax (H8)', () => {
  it('expands a deny Bash(git push:*) into the exact prefix and the "prefix *" glob', () => {
    const { permission, warnings } = translateRules(['Bash(git push:*)'], []);

    expect(permission).toEqual({ bash: { 'git push': 'deny', 'git push *': 'deny' } });
    expect(warnings).toEqual([]);
  });

  it('expands an allow Bash(npm run build:*) the same way (state "allow")', () => {
    const { permission, warnings } = translateRules([], ['Bash(npm run build:*)']);

    expect(permission).toEqual({
      bash: { 'npm run build': 'allow', 'npm run build *': 'allow' },
    });
    expect(warnings).toEqual([]);
  });

  it('expands a single-word prefix Bash(git:*) into "git" and "git *"', () => {
    const { permission, warnings } = translateRules(['Bash(git:*)'], []);

    expect(permission).toEqual({ bash: { git: 'deny', 'git *': 'deny' } });
    expect(warnings).toEqual([]);
  });

  it('keeps a literal ":" inside the prefix (Bash(npm run test:unit:*))', () => {
    const { permission, warnings } = translateRules(['Bash(npm run test:unit:*)'], []);

    expect(permission).toEqual({
      bash: { 'npm run test:unit': 'deny', 'npm run test:unit *': 'deny' },
    });
    expect(warnings).toEqual([]);
  });

  it('maps a bare ":*" pattern (empty prefix = everything) to the "*" glob', () => {
    const { permission, warnings } = translateRules(['Bash(:*)'], []);

    expect(permission).toEqual({ bash: { '*': 'deny' } });
    expect(warnings).toEqual([]);
  });

  it('passes a ":" pattern without the ":*" marker through verbatim (":" is literal on both sides)', () => {
    const { permission, warnings } = translateRules(['Bash(npm run build:prod)'], []);

    expect(permission).toEqual({ bash: { 'npm run build:prod': 'deny' } });
    expect(warnings).toEqual([]);
  });

  it('omits a mid-pattern ":*" with an actionable warning instead of an inert glob', () => {
    const { permission, warnings } = translateRules(['Bash(git push:* --force)'], []);

    expect(permission).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('git push:* --force');
  });

  it('omits a pattern with several ":*" markers with a warning (no faithful mapping)', () => {
    const { permission, warnings } = translateRules(['Bash(docker:*:*)'], []);

    expect(permission).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('docker:*:*');
  });

  it('never leaks a ":*" marker into any emitted glob leaf', () => {
    const { permission } = translateRules(
      ['Bash(git push:*)', 'Bash(docker:*:*)', 'Bash(rm -rf *)'],
      ['Bash(npm run build:*)'],
    );

    const bash = permission['bash'];
    expect(typeof bash).toBe('object');
    for (const pattern of Object.keys(bash as Record<string, string>)) {
      expect(pattern).not.toContain(':*');
    }
  });

  it('dedups the exact-prefix leaf when both "foo:*" and bare "foo" forms are given', () => {
    const { permission } = translateRules(['Bash(git push:*)', 'Bash(git push)'], []);

    expect(permission).toEqual({ bash: { 'git push': 'deny', 'git push *': 'deny' } });
  });
});

// ---------------------------------------------------------------------------
// Review M15 regression: deny-over-allow precedence is a security invariant.
// It currently emerges from loop order (deny first) + first-writer-wins merge;
// these tests lock it so an order-inverting refactor fails loudly (fail-open).
// ---------------------------------------------------------------------------

describe('translateRules — deny-over-allow precedence (M15)', () => {
  it('keeps deny when the same bash pattern rule is in both deny and allow', () => {
    const { permission } = translateRules(['Bash(git push)'], ['Bash(git push)']);

    expect(permission).toEqual({ bash: { 'git push': 'deny' } });
  });

  it('keeps deny when the same tool-level leaf comes from different Read rules', () => {
    // Both rules collapse onto the single tool-level `read` leaf → deny must win.
    const { permission } = translateRules(['Read(./.env)'], ['Read(./docs/**)']);

    expect(permission).toEqual({ read: 'deny' });
  });

  it('keeps deny for a bare tool token present in both lists', () => {
    const { permission } = translateRules(['WebFetch'], ['WebFetch']);

    expect(permission).toEqual({ webfetch: 'deny' });
  });

  it('keeps deny on both expanded ":*" leaves when the same prefix rule is in both lists', () => {
    const { permission } = translateRules(['Bash(git push:*)'], ['Bash(git push:*)']);

    expect(permission).toEqual({ bash: { 'git push': 'deny', 'git push *': 'deny' } });
  });

  it('keeps deny on the exact-prefix leaf when allow lists the bare command', () => {
    const { permission } = translateRules(['Bash(git push:*)'], ['Bash(git push)']);

    expect(permission).toEqual({ bash: { 'git push': 'deny', 'git push *': 'deny' } });
  });
});
