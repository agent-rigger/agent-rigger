/**
 * Tests for catalog/src/catalog.builtin.ts — the M0 built-in catalog.
 *
 * TDD: tests written before implementation (RED → GREEN).
 *
 * Coverage:
 *  - Every entry passes schema validation
 *  - All ids are unique
 *  - Pack members reference existing ids
 *  - Artifact requires[] reference existing ids
 *  - Specific entries meet expected shape (pack count, tool level, skill deps)
 *  - Total entry count is coherent
 */

import { describe, expect, it } from 'bun:test';

import { BUILTIN_CATALOG } from '../src/catalog.builtin';
import { parseCatalogEntry } from '../src/schema';

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

const findEntry = (id: string) => BUILTIN_CATALOG.find((e) => e.id === id);

// ---------------------------------------------------------------------------
// Every entry is schema-valid
// ---------------------------------------------------------------------------

describe('BUILTIN_CATALOG — schema validity', () => {
  it('contains at least one entry', () => {
    expect(BUILTIN_CATALOG.length).toBeGreaterThan(0);
  });

  it('every entry passes parseCatalogEntry without throwing', () => {
    for (const entry of BUILTIN_CATALOG) {
      expect(() => parseCatalogEntry(entry)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Unique ids
// ---------------------------------------------------------------------------

describe('BUILTIN_CATALOG — unique ids', () => {
  it('has no duplicate ids', () => {
    const ids = BUILTIN_CATALOG.map((e) => e.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// Referential integrity — pack members
// ---------------------------------------------------------------------------

describe('BUILTIN_CATALOG — referential integrity: pack members', () => {
  it('every pack member id references an existing catalog entry', () => {
    const ids = new Set(BUILTIN_CATALOG.map((e) => e.id));
    for (const entry of BUILTIN_CATALOG) {
      if (entry.kind !== 'pack') continue;
      for (const memberId of entry.members) {
        expect(ids.has(memberId)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Referential integrity — requires
// ---------------------------------------------------------------------------

describe('BUILTIN_CATALOG — referential integrity: requires', () => {
  it('every requires id references an existing catalog entry', () => {
    const ids = new Set(BUILTIN_CATALOG.map((e) => e.id));
    for (const entry of BUILTIN_CATALOG) {
      if (!entry.requires) continue;
      for (const reqId of entry.requires) {
        expect(ids.has(reqId)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Specific entries — expected shape
// ---------------------------------------------------------------------------

describe('BUILTIN_CATALOG — pack:spec-workflow', () => {
  it('exists in the catalog', () => {
    expect(findEntry('pack:spec-workflow')).toBeDefined();
  });

  it('has kind pack', () => {
    const pack = findEntry('pack:spec-workflow');
    expect(pack?.kind).toBe('pack');
  });

  it('has exactly 4 members', () => {
    const pack = findEntry('pack:spec-workflow');
    if (pack?.kind !== 'pack') return;
    expect(pack.members).toHaveLength(4);
  });

  it('members include the four expected ids', () => {
    const pack = findEntry('pack:spec-workflow');
    if (pack?.kind !== 'pack') return;
    const expected = ['skill:spec-workflow', 'agent:tech-lead', 'agent:pm', 'agent:reviewer'];
    for (const id of expected) {
      expect(pack.members).toContain(id);
    }
  });
});

describe('BUILTIN_CATALOG — tool:glab', () => {
  it('exists in the catalog', () => {
    expect(findEntry('tool:glab')).toBeDefined();
  });

  it('has level required', () => {
    const tool = findEntry('tool:glab');
    if (tool?.kind !== 'artifact') return;
    expect(tool.level).toBe('required');
  });

  it('has a check command', () => {
    const tool = findEntry('tool:glab');
    if (tool?.kind !== 'artifact') return;
    expect(typeof tool.check).toBe('string');
    expect((tool.check ?? '').length).toBeGreaterThan(0);
  });

  it('has source external', () => {
    const tool = findEntry('tool:glab');
    expect(tool?.source).toBe('external');
  });
});

describe('BUILTIN_CATALOG — skill:spec-workflow', () => {
  it('exists in the catalog', () => {
    expect(findEntry('skill:spec-workflow')).toBeDefined();
  });

  it('requires tool:glab', () => {
    const skill = findEntry('skill:spec-workflow');
    expect(skill?.requires).toContain('tool:glab');
  });

  it('has nature skill', () => {
    const skill = findEntry('skill:spec-workflow');
    if (skill?.kind !== 'artifact') return;
    expect(skill.nature).toBe('skill');
  });
});

// ---------------------------------------------------------------------------
// Total entry count
// ---------------------------------------------------------------------------

describe('BUILTIN_CATALOG — total count', () => {
  it('has exactly 9 entries (7 artifacts + 1 pack + tooling)', () => {
    // 7 artifacts: guardrails-claude, context-claude, harness-plugin,
    //              skill:spec-workflow, agent:tech-lead, agent:pm, agent:reviewer,
    //              tool:glab
    // 1 pack: pack:spec-workflow
    // Total = 9
    expect(BUILTIN_CATALOG).toHaveLength(9);
  });
});
