/**
 * Tests for assert-never.ts — the exhaustiveness helper for switches over
 * closed unions.
 */

import { describe, expect, it } from 'bun:test';

import { assertNever } from '../src/assert-never';

describe('assertNever', () => {
  it('throws', () => {
    // Cast: the whole point of assertNever is that callers only reach it once
    // TypeScript has narrowed the value to `never` — this test exercises the
    // runtime fallback for that (should-be-unreachable) case.
    expect(() => assertNever('unexpected' as never)).toThrow();
  });

  it('includes the offending value in the error message', () => {
    expect(() => assertNever('mystery-nature' as never)).toThrow(/mystery-nature/);
  });
});
