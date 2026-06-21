/**
 * Tests for deny.ts — computeMissingDeny + mergeDeny.
 *
 * Both functions are pure (string[] → string[]); no I/O, no filesystem.
 * All cases run synchronously.
 */

import { describe, expect, it } from 'bun:test';

import { computeMissingDeny, mergeDeny } from '../src/deny';

// ---------------------------------------------------------------------------
// computeMissingDeny(ref, current)
// Returns rules in ref that are absent from current, deduped, in ref order.
// ---------------------------------------------------------------------------

describe('computeMissingDeny', () => {
  it('returns all ref rules when current is empty', () => {
    const ref = ['Read(~/.ssh/**)', 'Write(~/.aws/**)', 'Bash(curl:*)'];
    expect(computeMissingDeny(ref, [])).toEqual(ref);
  });

  it('returns empty array when current already contains all ref rules', () => {
    const ref = ['Read(~/.ssh/**)', 'Write(~/.aws/**)'];
    const current = ['Read(~/.ssh/**)', 'Write(~/.aws/**)'];
    expect(computeMissingDeny(ref, current)).toEqual([]);
  });

  it('returns empty array when ref is empty', () => {
    expect(computeMissingDeny([], ['Read(./.env)'])).toEqual([]);
  });

  it('returns only the rules absent from current (partial overlap)', () => {
    const ref = ['Read(~/.ssh/**)', 'Write(~/.aws/**)', 'Bash(curl:*)'];
    const current = ['Read(~/.ssh/**)'];
    expect(computeMissingDeny(ref, current)).toEqual([
      'Write(~/.aws/**)',
      'Bash(curl:*)',
    ]);
  });

  it('preserves ref order in the output', () => {
    const ref = ['C', 'A', 'B'];
    const current: string[] = [];
    expect(computeMissingDeny(ref, current)).toEqual(['C', 'A', 'B']);
  });

  it('deduplicates duplicate entries in ref', () => {
    const ref = ['Read(~/.ssh/**)', 'Read(~/.ssh/**)', 'Write(~/.aws/**)'];
    const current: string[] = [];
    // First occurrence wins; second dropped
    expect(computeMissingDeny(ref, current)).toEqual([
      'Read(~/.ssh/**)',
      'Write(~/.aws/**)',
    ]);
  });

  it('uses strict string equality (case-sensitive, character-exact)', () => {
    const ref = ['Read(~/.ssh/**)'];
    const current = ['read(~/.ssh/**)']; // differs in case
    // 'Read' !== 'read' → ref rule is considered missing
    expect(computeMissingDeny(ref, current)).toEqual(['Read(~/.ssh/**)']);
  });
});

// ---------------------------------------------------------------------------
// mergeDeny(current, ref)
// Returns current ++ computeMissingDeny(ref, current), deduped.
// current is always preserved intact at the head.
// ---------------------------------------------------------------------------

describe('mergeDeny', () => {
  it('returns ref deduped when current is empty', () => {
    const ref = ['Read(~/.ssh/**)', 'Write(~/.aws/**)'];
    expect(mergeDeny([], ref)).toEqual(ref);
  });

  it('returns current unchanged when ref is empty', () => {
    const current = ['Read(./.env)', 'Read(~/.ssh/**)'];
    expect(mergeDeny(current, [])).toEqual(current);
  });

  it('appends missing ref rules after current', () => {
    const current = ['Read(./.env)'];
    const ref = ['Read(~/.ssh/**)', 'Write(~/.aws/**)'];
    expect(mergeDeny(current, ref)).toEqual([
      'Read(./.env)',
      'Read(~/.ssh/**)',
      'Write(~/.aws/**)',
    ]);
  });

  it('does not duplicate rules already present in current', () => {
    const current = ['Read(./.env)', 'Read(~/.ssh/**)'];
    const ref = ['Read(~/.ssh/**)', 'Write(~/.aws/**)'];
    expect(mergeDeny(current, ref)).toEqual([
      'Read(./.env)',
      'Read(~/.ssh/**)',
      'Write(~/.aws/**)',
    ]);
  });

  it('preserves current rules that are not in ref (local extras)', () => {
    // 'Read(./local)' is not managed by ref — it must be kept
    const current = ['Read(./local)', 'Read(~/.ssh/**)'];
    const ref = ['Read(~/.ssh/**)', 'Write(~/.aws/**)'];
    expect(mergeDeny(current, ref)).toEqual([
      'Read(./local)',
      'Read(~/.ssh/**)',
      'Write(~/.aws/**)',
    ]);
  });

  it('preserves current order at the head', () => {
    const current = ['B', 'A', 'C'];
    const ref = ['X', 'Y'];
    expect(mergeDeny(current, ref)).toEqual(['B', 'A', 'C', 'X', 'Y']);
  });

  it('deduplicates duplicate entries in ref before appending', () => {
    const current = ['Read(./.env)'];
    const ref = ['Read(~/.ssh/**)', 'Read(~/.ssh/**)', 'Write(~/.aws/**)'];
    expect(mergeDeny(current, ref)).toEqual([
      'Read(./.env)',
      'Read(~/.ssh/**)',
      'Write(~/.aws/**)',
    ]);
  });

  it('is idempotent: mergeDeny(mergeDeny(current, ref), ref) === mergeDeny(current, ref)', () => {
    const current = ['Read(./.env)'];
    const ref = ['Read(~/.ssh/**)', 'Write(~/.aws/**)', 'Bash(curl:*)'];

    const first = mergeDeny(current, ref);
    const second = mergeDeny(first, ref);

    expect(second).toEqual(first);
  });

  it('idempotence holds when current already contains all ref rules', () => {
    const current = ['Read(./.env)', 'Read(~/.ssh/**)', 'Write(~/.aws/**)'];
    const ref = ['Read(~/.ssh/**)', 'Write(~/.aws/**)'];

    const first = mergeDeny(current, ref);
    const second = mergeDeny(first, ref);

    expect(second).toEqual(first);
    // And current is still intact at the head
    expect(first).toEqual(current);
  });

  it('idempotence holds with local extras (rules outside ref)', () => {
    const current = ['Read(./local)'];
    const ref = ['Read(~/.ssh/**)', 'Write(~/.aws/**)'];

    const first = mergeDeny(current, ref);
    const second = mergeDeny(first, ref);

    expect(second).toEqual(first);
  });
});
