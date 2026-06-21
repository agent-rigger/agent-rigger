/**
 * Tests for deny.ts — removeDeny(current, ref).
 *
 * Pure function (string[] → string[]); no I/O, no filesystem.
 * All cases run synchronously.
 *
 * Invariants:
 * - Returns current minus the rules present in ref.
 * - Preserves order of remaining rules.
 * - Rules in current that are NOT in ref are kept intact.
 * - Idempotent: removeDeny(removeDeny(c, r), r) === removeDeny(c, r).
 * - ref empty → current unchanged.
 * - Strict string equality.
 */

import { describe, expect, it } from 'bun:test';

import { removeDeny } from '../src/deny';

describe('removeDeny', () => {
  it('removes rules present in ref from current', () => {
    const current = ['Read(~/.ssh/**)', 'Write(~/.aws/**)', 'Bash(curl:*)'];
    const ref = ['Read(~/.ssh/**)', 'Write(~/.aws/**)'];
    expect(removeDeny(current, ref)).toEqual(['Bash(curl:*)']);
  });

  it('returns current unchanged when ref is empty', () => {
    const current = ['Read(~/.ssh/**)', 'Write(~/.aws/**)'];
    expect(removeDeny(current, [])).toEqual(current);
  });

  it('returns empty array when all current rules are in ref', () => {
    const rules = ['Read(~/.ssh/**)', 'Write(~/.aws/**)'];
    expect(removeDeny(rules, rules)).toEqual([]);
  });

  it('preserves rules in current that are not in ref (user extras)', () => {
    const current = ['Read(./local)', 'Read(~/.ssh/**)', 'Write(~/.aws/**)'];
    const ref = ['Read(~/.ssh/**)', 'Write(~/.aws/**)'];
    expect(removeDeny(current, ref)).toEqual(['Read(./local)']);
  });

  it('preserves the order of remaining rules', () => {
    const current = ['C', 'A', 'B', 'D'];
    const ref = ['A', 'C'];
    expect(removeDeny(current, ref)).toEqual(['B', 'D']);
  });

  it('is idempotent: removeDeny(removeDeny(c, ref), ref) equals removeDeny(c, ref)', () => {
    const current = ['Read(./local)', 'Read(~/.ssh/**)', 'Write(~/.aws/**)'];
    const ref = ['Read(~/.ssh/**)', 'Write(~/.aws/**)'];
    const first = removeDeny(current, ref);
    const second = removeDeny(first, ref);
    expect(second).toEqual(first);
  });

  it('returns empty array when current is empty', () => {
    const ref = ['Read(~/.ssh/**)', 'Write(~/.aws/**)'];
    expect(removeDeny([], ref)).toEqual([]);
  });

  it('uses strict string equality (case-sensitive)', () => {
    const current = ['Read(~/.ssh/**)', 'read(~/.ssh/**)'];
    const ref = ['Read(~/.ssh/**)'];
    // Only exact match 'Read(~/.ssh/**)' is removed; 'read(...)' survives
    expect(removeDeny(current, ref)).toEqual(['read(~/.ssh/**)']);
  });

  it('handles ref rules not present in current without error', () => {
    const current = ['Read(./.env)'];
    const ref = ['Read(~/.ssh/**)', 'Write(~/.aws/**)'];
    // None of ref rules are in current; current returned unchanged
    expect(removeDeny(current, ref)).toEqual(['Read(./.env)']);
  });
});
