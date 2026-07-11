/**
 * Unit tests for R6 — the context restore baseline in mergeApplied
 * (core/src/applied-merge.ts, design D5).
 *
 * The context payload merges as: `block` replaced by the last run (the plan
 * carries the complete content by construction), `previous` PRESERVED from
 * the first install across upserts. A re-install captures the CURRENT disk
 * content as its own `previous` (post-first-install state), which must never
 * displace the true pre-install baseline — otherwise remove would "restore"
 * an intermediate state (or rigger-written content) instead of the user's
 * original bytes.
 *
 * Retro-compat: a legacy payload without `previous` never ADOPTS the next
 * run's `previous` either — at re-install time the disk state is
 * post-install, not the pre-install baseline. The absence is carried
 * forward so remove keeps its degraded delete-on-exact-match behaviour.
 */

import { describe, expect, it } from 'bun:test';

import { mergeApplied } from '../src/applied-merge';
import type { AppliedContext } from '../src/types';

describe('lot2-R6: mergeApplied context previous', () => {
  it('lot2-R6: block is replaced by the last run, previous is preserved from the first install', () => {
    const previous: AppliedContext = {
      kind: 'context',
      block: 'old canonical\n',
      previous: '# user original\n',
    };
    const next: AppliedContext = {
      kind: 'context',
      block: 'new canonical\n',
      previous: 'drifted content captured at re-install\n',
    };

    expect(mergeApplied(previous, next)).toEqual({
      kind: 'context',
      block: 'new canonical\n',
      previous: '# user original\n',
    });
  });

  it('lot2-R6: a null baseline (file absent before install) is preserved across upserts', () => {
    const previous: AppliedContext = {
      kind: 'context',
      block: 'old canonical\n',
      previous: null,
    };
    const next: AppliedContext = {
      kind: 'context',
      block: 'new canonical\n',
      previous: 'old canonical\n',
    };

    expect(mergeApplied(previous, next)).toEqual({
      kind: 'context',
      block: 'new canonical\n',
      previous: null,
    });
  });

  it('lot2-R6: a legacy payload without previous never adopts the next run baseline', () => {
    // The next run's `previous` is the POST-install disk state — adopting it
    // would make remove "restore" rigger-written content.
    const previous: AppliedContext = { kind: 'context', block: 'old canonical\n' };
    const next: AppliedContext = {
      kind: 'context',
      block: 'new canonical\n',
      previous: 'old canonical\n',
    };

    const merged = mergeApplied(previous, next) as AppliedContext;
    expect(merged.block).toBe('new canonical\n');
    expect(merged.previous).toBeUndefined();
  });

  it('lot2-R6: first install (no previous payload) keeps the run payload as-is, baseline included', () => {
    const next: AppliedContext = {
      kind: 'context',
      block: 'canonical\n',
      previous: '# user original\n',
    };

    expect(mergeApplied(undefined, next)).toEqual(next);
  });
});
