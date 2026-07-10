/**
 * lot6-r4-qualify-seam.test.ts — R4: the qualification seam is exported (D4).
 *
 * `qualify.ts` SHALL expose `qualifyRef` (forward: prefix an unqualified ref)
 * and `localId` (inverse: strip a qualifier prefix), both transiting through
 * the package entrypoint (`export * from './qualify'` in index.ts) so that
 * every consumer (CLI, governance, remote-install…) imports the SAME seam
 * instead of reimplementing the `includes('/') ? … : prefix` heuristic.
 *
 * TDD: written before `qualifyRef`/`localId` are exported (RED → GREEN).
 *
 * Coverage:
 *  - qualifyRef: already-qualified id left intact, unqualified id prefixed.
 *  - localId: inverse — strips the prefix, already-local id left intact.
 *  - Round-trip both directions (qualifyRef ∘ localId, localId ∘ qualifyRef).
 *  - Both functions transit through index.ts (the single public seam).
 */

import { describe, expect, it } from 'bun:test';

// Import from the package entrypoint (index.ts), not the source module directly —
// this is the contract under test: the seam SHALL be reachable via `export *`.
import { localId, qualifyRef } from './index';

// ---------------------------------------------------------------------------
// qualifyRef — forward
// ---------------------------------------------------------------------------

describe('lot6-R4: qualifyRef (forward seam)', () => {
  it('prefixes an unqualified ref with `<name>/`', () => {
    expect(qualifyRef('mycat', 'skill:foo')).toBe('mycat/skill:foo');
  });

  it('leaves an already-qualified ref intact (idempotent)', () => {
    expect(qualifyRef('mycat', 'othercat/skill:foo')).toBe('othercat/skill:foo');
  });

  it('is idempotent when applied twice with the same name', () => {
    const once = qualifyRef('mycat', 'skill:foo');
    const twice = qualifyRef('mycat', once);
    expect(twice).toBe(once);
  });
});

// ---------------------------------------------------------------------------
// localId — inverse
// ---------------------------------------------------------------------------

describe('lot6-R4: localId (inverse seam)', () => {
  it('strips the qualifier prefix from a qualified id', () => {
    expect(localId('mycat/skill:foo')).toBe('skill:foo');
  });

  it('leaves an already-local id unchanged (no slash)', () => {
    expect(localId('skill:foo')).toBe('skill:foo');
  });

  it('only strips the FIRST segment (ids never contain more than one qualifier)', () => {
    // Defensive: if a value somehow carries two slashes, only the leading
    // qualifier is stripped — the rest of the id (e.g. a path-like local id)
    // is preserved verbatim.
    expect(localId('mycat/scope/skill:foo')).toBe('scope/skill:foo');
  });
});

// ---------------------------------------------------------------------------
// Round-trip — the two directions share one invariant
// ---------------------------------------------------------------------------

describe('lot6-R4: qualifyRef / localId round-trip', () => {
  it('qualifyRef then localId returns the original local id', () => {
    const local = 'skill:foo';
    expect(localId(qualifyRef('mycat', local))).toBe(local);
  });

  it('localId then qualifyRef (same name) returns the original qualified id', () => {
    const qualified = 'mycat/skill:foo';
    expect(qualifyRef('mycat', localId(qualified))).toBe(qualified);
  });
});

// ---------------------------------------------------------------------------
// Single seam — both exports transit through index.ts
// ---------------------------------------------------------------------------

describe('lot6-R4: single seam (package entrypoint)', () => {
  it('exports qualifyRef as a function from the package entrypoint', () => {
    expect(typeof qualifyRef).toBe('function');
  });

  it('exports localId as a function from the package entrypoint', () => {
    expect(typeof localId).toBe('function');
  });
});
