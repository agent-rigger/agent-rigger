/**
 * Tests for catalog/src/effective.ts — mergeCatalogs (built-in ∪ remote) + foldCatalogs (N sources).
 *
 * TDD: tests written before implementation (RED → GREEN).
 *
 * Coverage:
 *  - collision: built-in entry kept, remote shadowed → id in conflicts
 *  - remote-only entry appended after built-in
 *  - internal dedup in remote (same id twice, absent from built-in) → 1st kept
 *  - empty remote → entries == builtin, conflicts == []
 *  - order preserved: built-in first, then remote-only
 *
 * foldCatalogs coverage:
 *  - 0 / 1 / 2 / 3 sources
 *  - collision on fully-qualified id between two sources → first wins, id in conflicts
 *  - homonyms a/skill:x and b/skill:x → both present, no conflict (different prefixes)
 *  - order preserved (source1 entries before source2-only)
 *  - intra-source dedup (same id twice in one source) → first occurrence kept
 */

import { describe, expect, it } from 'bun:test';

import { foldCatalogs, mergeCatalogs } from './effective';
import type { CatalogEntry } from './schema';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeArtifact(id: string): CatalogEntry {
  return {
    kind: 'artifact',
    id,
    nature: 'skill',
    targets: ['claude'],
    scopes: ['user'],
  };
}

// ---------------------------------------------------------------------------
// collision: built-in wins, id lands in conflicts
// ---------------------------------------------------------------------------

describe('mergeCatalogs — id collision: built-in wins, remote shadowed', () => {
  it('entries length equals built-in length (collision removed)', () => {
    const builtin = [makeArtifact('a')];
    const remote = [makeArtifact('a')];
    const { entries } = mergeCatalogs(builtin, remote);
    expect(entries).toHaveLength(1);
  });

  it('entry kept is the built-in one (id matches)', () => {
    const builtinEntry = makeArtifact('guardrails-claude');
    const remoteEntry = makeArtifact('guardrails-claude');
    const { entries } = mergeCatalogs([builtinEntry], [remoteEntry]);
    expect(entries[0]?.id).toBe('guardrails-claude');
  });

  it('colliding id appears in conflicts', () => {
    const builtin = [makeArtifact('guardrails-claude')];
    const remote = [makeArtifact('guardrails-claude')];
    const { conflicts } = mergeCatalogs(builtin, remote);
    expect(conflicts).toContain('guardrails-claude');
  });

  it('conflicts length equals number of shadowed ids', () => {
    const builtin = [makeArtifact('a'), makeArtifact('b')];
    const remote = [makeArtifact('a'), makeArtifact('b'), makeArtifact('c')];
    const { conflicts } = mergeCatalogs(builtin, remote);
    expect(conflicts).toHaveLength(2);
  });

  it('non-colliding remote entry is NOT in conflicts', () => {
    const builtin = [makeArtifact('a')];
    const remote = [makeArtifact('a'), makeArtifact('b')];
    const { conflicts } = mergeCatalogs(builtin, remote);
    expect(conflicts).not.toContain('b');
  });
});

// ---------------------------------------------------------------------------
// remote-only entry appended after built-in
// ---------------------------------------------------------------------------

describe('mergeCatalogs — remote-only entry appended after built-in', () => {
  it('entries contains built-in + remote-only', () => {
    const builtin = [makeArtifact('guardrails-claude')];
    const remote = [makeArtifact('skill:remote-only')];
    const { entries } = mergeCatalogs(builtin, remote);
    expect(entries).toHaveLength(2);
  });

  it('built-in entry comes first', () => {
    const builtin = [makeArtifact('guardrails-claude')];
    const remote = [makeArtifact('skill:remote-only')];
    const { entries } = mergeCatalogs(builtin, remote);
    expect(entries[0]?.id).toBe('guardrails-claude');
  });

  it('remote-only entry comes after built-in', () => {
    const builtin = [makeArtifact('guardrails-claude')];
    const remote = [makeArtifact('skill:remote-only')];
    const { entries } = mergeCatalogs(builtin, remote);
    expect(entries[1]?.id).toBe('skill:remote-only');
  });
});

// ---------------------------------------------------------------------------
// internal dedup in remote
// ---------------------------------------------------------------------------

describe('mergeCatalogs — duplicate id within remote (absent from built-in): only 1st kept', () => {
  it('remote with two identical ids produces one entry', () => {
    const builtin: CatalogEntry[] = [];
    const remote = [makeArtifact('skill:dupe'), makeArtifact('skill:dupe')];
    const { entries } = mergeCatalogs(builtin, remote);
    expect(entries).toHaveLength(1);
  });

  it('the kept entry is the first occurrence', () => {
    const firstRemote: CatalogEntry = makeArtifact('skill:dupe');
    const secondRemote: CatalogEntry = {
      kind: 'artifact',
      id: 'skill:dupe',
      nature: 'agent',
      targets: ['claude'],
      scopes: ['user'],
    };
    const { entries } = mergeCatalogs([], [firstRemote, secondRemote]);
    // First occurrence has nature 'skill', second has 'agent'
    expect(entries[0]?.kind === 'artifact' && entries[0]?.nature === 'skill').toBe(true);
  });

  it('duplicated remote id is NOT added to conflicts (not a built-in collision)', () => {
    const builtin: CatalogEntry[] = [];
    const remote = [makeArtifact('skill:dupe'), makeArtifact('skill:dupe')];
    const { conflicts } = mergeCatalogs(builtin, remote);
    expect(conflicts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// empty remote
// ---------------------------------------------------------------------------

describe('mergeCatalogs — empty remote', () => {
  it('entries equals built-in unchanged', () => {
    const builtin = [makeArtifact('a'), makeArtifact('b')];
    const { entries } = mergeCatalogs(builtin, []);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('conflicts is empty', () => {
    const builtin = [makeArtifact('a')];
    const { conflicts } = mergeCatalogs(builtin, []);
    expect(conflicts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// order preserved
// ---------------------------------------------------------------------------

describe('mergeCatalogs — order preserved: built-in then remote-only', () => {
  it('multiple built-ins preserve insertion order', () => {
    const builtin = [makeArtifact('a'), makeArtifact('b'), makeArtifact('c')];
    const remote = [makeArtifact('d')];
    const { entries } = mergeCatalogs(builtin, remote);
    expect(entries.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('multiple remote-only entries preserve insertion order after built-in', () => {
    const builtin = [makeArtifact('a')];
    const remote = [makeArtifact('b'), makeArtifact('c'), makeArtifact('d')];
    const { entries } = mergeCatalogs(builtin, remote);
    expect(entries.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('mixed collision + remote-only: built-in first, then non-colliding remote in order', () => {
    const builtin = [makeArtifact('a'), makeArtifact('b')];
    const remote = [makeArtifact('b'), makeArtifact('c'), makeArtifact('d')];
    const { entries } = mergeCatalogs(builtin, remote);
    expect(entries.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('both inputs empty → entries and conflicts are empty arrays', () => {
    const { entries, conflicts } = mergeCatalogs([], []);
    expect(entries).toHaveLength(0);
    expect(conflicts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// foldCatalogs — 0 / 1 / 2 / 3 sources
// ---------------------------------------------------------------------------

describe('foldCatalogs — 0 sources', () => {
  it('returns empty entries and empty conflicts', () => {
    const { entries, conflicts } = foldCatalogs([]);
    expect(entries).toHaveLength(0);
    expect(conflicts).toHaveLength(0);
  });
});

describe('foldCatalogs — 1 source', () => {
  it('entries equal source entries deduplicated, no conflicts', () => {
    const source = [makeArtifact('a/skill:x'), makeArtifact('a/skill:y')];
    const { entries, conflicts } = foldCatalogs([source]);
    expect(entries.map((e) => e.id)).toEqual(['a/skill:x', 'a/skill:y']);
    expect(conflicts).toHaveLength(0);
  });

  it('intra-source dedup: duplicate id in single source → first occurrence kept, no conflict', () => {
    const source = [makeArtifact('a/skill:x'), makeArtifact('a/skill:x')];
    const { entries, conflicts } = foldCatalogs([source]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe('a/skill:x');
    expect(conflicts).toHaveLength(0);
  });

  it('empty single source → empty result', () => {
    const { entries, conflicts } = foldCatalogs([[]]);
    expect(entries).toHaveLength(0);
    expect(conflicts).toHaveLength(0);
  });
});

describe('foldCatalogs — 2 sources', () => {
  it('non-overlapping sources → all entries present, no conflicts', () => {
    const src1 = [makeArtifact('a/skill:x'), makeArtifact('a/skill:y')];
    const src2 = [makeArtifact('b/skill:z')];
    const { entries, conflicts } = foldCatalogs([src1, src2]);
    expect(entries.map((e) => e.id)).toEqual(['a/skill:x', 'a/skill:y', 'b/skill:z']);
    expect(conflicts).toHaveLength(0);
  });

  it('collision on same fully-qualified id → first source wins, id in conflicts', () => {
    const src1 = [makeArtifact('a/skill:x')];
    const src2 = [makeArtifact('a/skill:x')];
    const { entries, conflicts } = foldCatalogs([src1, src2]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe('a/skill:x');
    expect(conflicts).toContain('a/skill:x');
  });

  it('homonyms with different catalog prefixes → both present, no conflict', () => {
    const src1 = [makeArtifact('a/skill:x')];
    const src2 = [makeArtifact('b/skill:x')];
    const { entries, conflicts } = foldCatalogs([src1, src2]);
    expect(entries.map((e) => e.id)).toEqual(['a/skill:x', 'b/skill:x']);
    expect(conflicts).toHaveLength(0);
  });

  it('order preserved: source1 entries come before source2-only entries', () => {
    const src1 = [makeArtifact('a/skill:x'), makeArtifact('a/skill:y')];
    const src2 = [makeArtifact('b/skill:z'), makeArtifact('b/skill:w')];
    const { entries } = foldCatalogs([src1, src2]);
    expect(entries.map((e) => e.id)).toEqual([
      'a/skill:x',
      'a/skill:y',
      'b/skill:z',
      'b/skill:w',
    ]);
  });

  it('intra-source dedup in second source: duplicate kept first, no conflict', () => {
    const src1 = [makeArtifact('a/skill:x')];
    const src2 = [makeArtifact('b/skill:y'), makeArtifact('b/skill:y')];
    const { entries, conflicts } = foldCatalogs([src1, src2]);
    expect(entries.map((e) => e.id)).toEqual(['a/skill:x', 'b/skill:y']);
    expect(conflicts).toHaveLength(0);
  });

  it('partial collision: one colliding id, one unique per source', () => {
    const src1 = [makeArtifact('a/skill:shared'), makeArtifact('a/skill:only1')];
    const src2 = [makeArtifact('a/skill:shared'), makeArtifact('b/skill:only2')];
    const { entries, conflicts } = foldCatalogs([src1, src2]);
    expect(entries.map((e) => e.id)).toEqual([
      'a/skill:shared',
      'a/skill:only1',
      'b/skill:only2',
    ]);
    expect(conflicts).toEqual(['a/skill:shared']);
  });
});

describe('foldCatalogs — 3 sources', () => {
  it('entries from all 3 non-overlapping sources present in order', () => {
    const src1 = [makeArtifact('a/skill:x')];
    const src2 = [makeArtifact('b/skill:y')];
    const src3 = [makeArtifact('c/skill:z')];
    const { entries, conflicts } = foldCatalogs([src1, src2, src3]);
    expect(entries.map((e) => e.id)).toEqual(['a/skill:x', 'b/skill:y', 'c/skill:z']);
    expect(conflicts).toHaveLength(0);
  });

  it('collision between source1 and source3 → source1 wins, id in conflicts once', () => {
    const src1 = [makeArtifact('a/skill:x')];
    const src2 = [makeArtifact('b/skill:y')];
    const src3 = [makeArtifact('a/skill:x')];
    const { entries, conflicts } = foldCatalogs([src1, src2, src3]);
    expect(entries.map((e) => e.id)).toEqual(['a/skill:x', 'b/skill:y']);
    expect(conflicts).toContain('a/skill:x');
  });

  it('homonyms across all 3 sources with different prefixes → all 3 present, no conflict', () => {
    const src1 = [makeArtifact('a/skill:x')];
    const src2 = [makeArtifact('b/skill:x')];
    const src3 = [makeArtifact('c/skill:x')];
    const { entries, conflicts } = foldCatalogs([src1, src2, src3]);
    expect(entries.map((e) => e.id)).toEqual(['a/skill:x', 'b/skill:x', 'c/skill:x']);
    expect(conflicts).toHaveLength(0);
  });
});
