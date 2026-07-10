/**
 * lot6-r3-cross-requires.test.ts — R3: cross-catalogue requires are
 * manifest-satisfied or actionable (design D3), resolver-level seam.
 *
 * TDD: written before `resolve()`'s `externallySatisfied` param,
 * `UnknownEntryError.requiredBy`, `catalogPrefixOf`, and
 * `collectForeignRequires` existed (RED → GREEN).
 *
 * This file covers ONLY the pure resolver.ts primitives — the CLI-level
 * manifest partition (`partitionForeignRequires`, `ForeignRequireUnsatisfiedError`)
 * and end-to-end install/update wiring are covered by
 * packages/cli/test/lot6-r3-cross-requires.test.ts.
 *
 * Coverage:
 *  - resolve(): a ref in `externallySatisfied` is skipped outright — no
 *    UnknownEntryError, not traversed, absent from the output.
 *  - UnknownEntryError.requiredBy: the DFS chain at throw time (precedent:
 *    DependencyCycleError.cyclePath) — empty for a top-level unknown id,
 *    populated for a require/member chain, reflected in the message.
 *  - catalogPrefixOf: prefix extraction built on the localId seam.
 *  - collectForeignRequires: foreign requires are collected (not thrown on);
 *    local requires (same prefix / unqualified) are left for resolve() to
 *    handle; multi-hop chains and pack members are followed.
 */

import { describe, expect, it } from 'bun:test';

import { catalogPrefixOf, collectForeignRequires, resolve, UnknownEntryError } from './resolver';
import type { CatalogEntry } from './schema';

// ---------------------------------------------------------------------------
// Helpers — minimal synthetic catalog builders (mirrors resolver.test.ts)
// ---------------------------------------------------------------------------

function artifact(id: string, requires?: string[]): CatalogEntry {
  return {
    kind: 'artifact',
    id,
    nature: 'skill',
    targets: ['claude'],
    scopes: ['user'],
    ...(requires ? { requires } : {}),
  };
}

function pack(id: string, members: string[], requires?: string[]): CatalogEntry {
  return {
    kind: 'pack',
    id,
    targets: ['claude'],
    scopes: ['user'],
    members,
    ...(requires ? { requires } : {}),
  };
}

// ---------------------------------------------------------------------------
// resolve() — externallySatisfied is skipped, not thrown on
// ---------------------------------------------------------------------------

describe('lot6-R3: resolve — externallySatisfied Set is skipped', () => {
  it('a foreign ref in externallySatisfied is skipped without throwing UnknownEntryError', () => {
    const catalog: CatalogEntry[] = [artifact('skill:bar', ['othercat/skill:foo'])];
    // 'othercat/skill:foo' is NOT in `catalog` — without the Set this throws.
    expect(() => resolve(['skill:bar'], catalog)).toThrow(UnknownEntryError);

    const result = resolve(['skill:bar'], catalog, new Set(['othercat/skill:foo']));
    expect(result.map((e) => e.id)).toEqual(['skill:bar']);
  });

  it('the skipped ref never appears in the resolved output', () => {
    const catalog: CatalogEntry[] = [artifact('skill:bar', ['othercat/skill:foo'])];
    const result = resolve(['skill:bar'], catalog, new Set(['othercat/skill:foo']));
    expect(result.map((e) => e.id)).not.toContain('othercat/skill:foo');
  });

  it('sibling local requires still resolve normally alongside a skipped foreign one', () => {
    const catalog: CatalogEntry[] = [
      artifact('skill:dep'),
      artifact('skill:bar', ['skill:dep', 'othercat/skill:foo']),
    ];
    const result = resolve(['skill:bar'], catalog, new Set(['othercat/skill:foo']));
    const ids = result.map((e) => e.id);
    expect(ids).toContain('skill:dep');
    expect(ids).toContain('skill:bar');
    expect(ids.indexOf('skill:dep')).toBeLessThan(ids.indexOf('skill:bar'));
  });

  it('default (third arg omitted) behaves exactly as before — existing callers unaffected', () => {
    const catalog: CatalogEntry[] = [artifact('skill:dep'), artifact('skill:bar', ['skill:dep'])];
    const result = resolve(['skill:bar'], catalog);
    expect(result.map((e) => e.id)).toEqual(['skill:dep', 'skill:bar']);
  });
});

// ---------------------------------------------------------------------------
// UnknownEntryError.requiredBy — DFS chain at throw time
// ---------------------------------------------------------------------------

describe('lot6-R3: UnknownEntryError.requiredBy (chain enrichment)', () => {
  it('is empty when the missing id is itself a top-level selection', () => {
    const catalog: CatalogEntry[] = [artifact('skill:present')];
    try {
      resolve(['skill:ghost'], catalog);
      throw new Error('expected resolve to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownEntryError);
      expect((e as UnknownEntryError).requiredBy).toEqual([]);
    }
  });

  it('names the direct requirer when the missing id is a require', () => {
    const catalog: CatalogEntry[] = [artifact('skill:a', ['skill:typo'])];
    try {
      resolve(['skill:a'], catalog);
      throw new Error('expected resolve to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownEntryError);
      expect((e as UnknownEntryError).unknownId).toBe('skill:typo');
      expect((e as UnknownEntryError).requiredBy).toEqual(['skill:a']);
    }
  });

  it('carries the full multi-hop chain (a → mid → missing)', () => {
    const catalog: CatalogEntry[] = [
      artifact('skill:mid', ['skill:missing']),
      artifact('skill:a', ['skill:mid']),
    ];
    try {
      resolve(['skill:a'], catalog);
      throw new Error('expected resolve to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownEntryError);
      expect((e as UnknownEntryError).requiredBy).toEqual(['skill:a', 'skill:mid']);
    }
  });

  it('the message names the requirer chain when non-empty', () => {
    const catalog: CatalogEntry[] = [artifact('skill:a', ['skill:typo'])];
    try {
      resolve(['skill:a'], catalog);
      throw new Error('expected resolve to throw');
    } catch (e) {
      expect((e as Error).message).toContain('skill:typo');
      expect((e as Error).message).toContain('skill:a');
    }
  });

  it('the message has no chain suffix when requiredBy is empty (top-level)', () => {
    const err = new UnknownEntryError('skill:ghost');
    expect(err.message).toBe('Unknown catalog entry: "skill:ghost"');
  });
});

// ---------------------------------------------------------------------------
// catalogPrefixOf
// ---------------------------------------------------------------------------

describe('lot6-R3: catalogPrefixOf', () => {
  it('returns the prefix of a qualified ref', () => {
    expect(catalogPrefixOf('othercat/skill:foo')).toBe('othercat');
  });

  it('returns undefined for an unqualified ref', () => {
    expect(catalogPrefixOf('skill:foo')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// collectForeignRequires
// ---------------------------------------------------------------------------

describe('lot6-R3: collectForeignRequires', () => {
  it('collects a direct foreign require with the direct requirer as chain', () => {
    const catalog: CatalogEntry[] = [artifact('skill:bar', ['othercat/skill:foo'])];
    const foreign = collectForeignRequires(['skill:bar'], catalog, 'principal');
    expect(foreign).toEqual([{ ref: 'othercat/skill:foo', requiredBy: ['skill:bar'] }]);
  });

  it('does not collect a local require (same prefix as sourceName, unqualified)', () => {
    const catalog: CatalogEntry[] = [artifact('skill:dep'), artifact('skill:bar', ['skill:dep'])];
    const foreign = collectForeignRequires(['skill:bar'], catalog, 'principal');
    expect(foreign).toEqual([]);
  });

  it('does not throw when a local require is genuinely missing (leaves it for resolve())', () => {
    const catalog: CatalogEntry[] = [artifact('skill:a', ['skill:typo'])];
    expect(() => collectForeignRequires(['skill:a'], catalog, 'principal')).not.toThrow();
    expect(collectForeignRequires(['skill:a'], catalog, 'principal')).toEqual([]);
  });

  it('carries the full multi-hop chain down to the entry declaring the foreign require', () => {
    const catalog: CatalogEntry[] = [
      artifact('skill:mid', ['othercat/skill:foo']),
      artifact('skill:a', ['skill:mid']),
    ];
    const foreign = collectForeignRequires(['skill:a'], catalog, 'principal');
    expect(foreign).toEqual([
      { ref: 'othercat/skill:foo', requiredBy: ['skill:a', 'skill:mid'] },
    ]);
  });

  it('discovers a foreign require declared by a pack member', () => {
    const catalog: CatalogEntry[] = [
      artifact('skill:member', ['othercat/skill:foo']),
      pack('pack:wrapper', ['skill:member']),
    ];
    const foreign = collectForeignRequires(['pack:wrapper'], catalog, 'principal');
    expect(foreign).toEqual([
      { ref: 'othercat/skill:foo', requiredBy: ['pack:wrapper', 'skill:member'] },
    ]);
  });

  it('treats an explicit self-qualified ref (same prefix as sourceName) as local, not foreign', () => {
    const catalog: CatalogEntry[] = [
      artifact('skill:dep'),
      artifact('skill:bar', ['principal/skill:dep']),
    ];
    // 'principal/skill:dep' is not foreign (same prefix) — but it also isn't
    // found in this RAW (unqualified) index, so it's silently left alone,
    // exactly like a local typo. Not collected as foreign either way.
    const foreign = collectForeignRequires(['skill:bar'], catalog, 'principal');
    expect(foreign).toEqual([]);
  });

  it('returns an empty array for a selection with no requires at all', () => {
    const catalog: CatalogEntry[] = [artifact('skill:solo')];
    expect(collectForeignRequires(['skill:solo'], catalog, 'principal')).toEqual([]);
  });
});
