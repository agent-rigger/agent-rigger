/**
 * Tests for catalog/src/qualify.ts — qualifyEntries.
 *
 * TDD: tests written before implementation (RED → GREEN).
 *
 * Coverage:
 *  - artifact id is prefixed with catalog name
 *  - pack id is prefixed with catalog name
 *  - requires intra-catalog refs are prefixed
 *  - requires cross-catalog refs (already qualified) are left unchanged
 *  - pack members intra-catalog refs are prefixed
 *  - pack members cross-catalog refs are left unchanged
 *  - idempotence: double call === single call
 *  - empty input → empty output
 *  - input array is not mutated
 *  - already-qualified id is not re-prefixed (idempotence on id)
 */

import { describe, expect, it } from 'bun:test';

import { qualifyEntries } from './qualify';
import type { CatalogEntry } from './schema';

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

function makeArtifact(
  id: string,
  requires?: string[],
): CatalogEntry {
  return {
    kind: 'artifact',
    id,
    nature: 'skill',
    targets: ['claude'],
    scopes: ['user'],
    ...(requires === undefined ? {} : { requires }),
  };
}

function makePack(
  id: string,
  members: string[],
  requires?: string[],
): CatalogEntry {
  return {
    kind: 'pack',
    id,
    targets: ['claude'],
    scopes: ['user'],
    members,
    ...(requires === undefined ? {} : { requires }),
  };
}

// ---------------------------------------------------------------------------
// artifact id qualification
// ---------------------------------------------------------------------------

describe('qualifyEntries — artifact id', () => {
  it('prefixes a simple artifact id with the catalog name', () => {
    const [entry] = qualifyEntries('mycat', [makeArtifact('skill:foo')]);
    expect(entry?.id).toBe('mycat/skill:foo');
  });

  it('handles multiple entries', () => {
    const result = qualifyEntries('mycat', [makeArtifact('tool:glab'), makeArtifact('tool:gh')]);
    expect(result.map((e) => e.id)).toEqual(['mycat/tool:glab', 'mycat/tool:gh']);
  });
});

// ---------------------------------------------------------------------------
// pack id qualification
// ---------------------------------------------------------------------------

describe('qualifyEntries — pack id', () => {
  it('prefixes a pack id with the catalog name', () => {
    const [entry] = qualifyEntries('mycat', [makePack('pack:dev', ['tool:glab'])]);
    expect(entry?.id).toBe('mycat/pack:dev');
  });
});

// ---------------------------------------------------------------------------
// requires qualification
// ---------------------------------------------------------------------------

describe('qualifyEntries — requires', () => {
  it('prefixes intra-catalog requires refs', () => {
    const [entry] = qualifyEntries('mycat', [makeArtifact('skill:foo', ['tool:node', 'tool:git'])]);
    expect(entry?.requires).toEqual(['mycat/tool:node', 'mycat/tool:git']);
  });

  it('leaves already-qualified cross-catalog requires refs unchanged', () => {
    const [entry] = qualifyEntries('mycat', [
      makeArtifact('skill:foo', ['othercat/tool:node', 'tool:git']),
    ]);
    expect(entry?.requires).toEqual(['othercat/tool:node', 'mycat/tool:git']);
  });

  it('returns undefined requires when entry has no requires field', () => {
    const [entry] = qualifyEntries('mycat', [makeArtifact('skill:foo')]);
    expect(entry?.requires).toBeUndefined();
  });

  it('returns empty requires when entry requires is empty array', () => {
    const [entry] = qualifyEntries('mycat', [makeArtifact('skill:foo', [])]);
    expect(entry?.requires).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// pack members qualification
// ---------------------------------------------------------------------------

describe('qualifyEntries — pack members', () => {
  it('prefixes intra-catalog member refs', () => {
    const result = qualifyEntries('mycat', [makePack('pack:dev', ['tool:glab', 'skill:lint'])]);
    const entry = result[0];
    if (!entry || entry.kind !== 'pack') throw new Error('expected pack');
    expect(entry.members).toEqual(['mycat/tool:glab', 'mycat/skill:lint']);
  });

  it('leaves already-qualified cross-catalog member refs unchanged', () => {
    const result = qualifyEntries('mycat', [
      makePack('pack:dev', ['othercat/tool:glab', 'skill:lint']),
    ]);
    const entry = result[0];
    if (!entry || entry.kind !== 'pack') throw new Error('expected pack');
    expect(entry.members).toEqual(['othercat/tool:glab', 'mycat/skill:lint']);
  });
});

// ---------------------------------------------------------------------------
// idempotence
// ---------------------------------------------------------------------------

describe('qualifyEntries — idempotence', () => {
  it('double qualification equals single qualification for artifact', () => {
    const entries = [makeArtifact('skill:foo', ['tool:node'])];
    const once = qualifyEntries('mycat', entries);
    const twice = qualifyEntries('mycat', once);
    expect(twice).toEqual(once);
  });

  it('double qualification equals single qualification for pack', () => {
    const entries = [makePack('pack:dev', ['tool:glab', 'skill:lint'], ['tool:node'])];
    const once = qualifyEntries('mycat', entries);
    const twice = qualifyEntries('mycat', once);
    expect(twice).toEqual(once);
  });

  it('already-qualified id is not re-prefixed', () => {
    const result = qualifyEntries('mycat', [makeArtifact('mycat/skill:foo')]);
    expect(result[0]?.id).toBe('mycat/skill:foo');
  });
});

// ---------------------------------------------------------------------------
// edge cases
// ---------------------------------------------------------------------------

describe('qualifyEntries — edge cases', () => {
  it('returns empty array for empty input', () => {
    expect(qualifyEntries('mycat', [])).toEqual([]);
  });

  it('does not mutate the input entry', () => {
    const original = makeArtifact('skill:foo', ['tool:node']);
    const originalId = original.id;
    const originalRequires = [...(original.requires ?? [])];
    qualifyEntries('mycat', [original]);
    expect(original.id).toBe(originalId);
    expect(original.requires).toEqual(originalRequires);
  });

  it('does not mutate pack members in the input', () => {
    const original = makePack('pack:dev', ['tool:glab']);
    if (original.kind !== 'pack') throw new Error('expected pack');
    const originalMembers = [...original.members];
    qualifyEntries('mycat', [original]);
    expect(original.members).toEqual(originalMembers);
  });
});
