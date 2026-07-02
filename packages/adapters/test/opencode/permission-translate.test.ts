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
