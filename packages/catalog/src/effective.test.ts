/**
 * Tests for catalog/src/effective.ts — mergeCatalogs (built-in ∪ remote).
 *
 * TDD: tests written before implementation (RED → GREEN).
 *
 * Coverage:
 *  - collision: built-in entry kept, remote shadowed → id in conflicts
 *  - remote-only entry appended after built-in
 *  - internal dedup in remote (same id twice, absent from built-in) → 1st kept
 *  - empty remote → entries == builtin, conflicts == []
 *  - order preserved: built-in first, then remote-only
 */

import { describe, expect, it } from 'bun:test';

import { mergeCatalogs } from './effective';
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
