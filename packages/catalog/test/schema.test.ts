/**
 * Tests for catalog/src/schema.ts — discriminated union CatalogEntrySchema.
 *
 * TDD: tests written before implementation revision (RED → GREEN → refactor).
 *
 * Variants:
 *  - kind:'artifact'  — a single installable artefact (nature required)
 *  - kind:'pack'      — a named bundle of artefact ids (members required)
 *
 * Coverage:
 *  - Artifact: minimal valid, full valid, all 7 natures accepted
 *  - Pack: minimal valid, members non-empty
 *  - Rejections: kind absent/unknown, artifact without nature, pack without members,
 *    pack with empty members, pack with nature field (strict), common fields invalid
 *  - Correct discrimination: pack input rejected by artifact schema and vice versa
 *  - parseCatalogEntry / safeParseCatalogEntry helpers
 *  - Exported variant types: ArtifactEntry, PackEntry
 */

import { describe, expect, it } from 'bun:test';

import {
  type ArtifactEntry,
  ArtifactEntrySchema,
  type CatalogEntry,
  CatalogEntrySchema,
  type PackEntry,
  PackEntrySchema,
  parseCatalogEntry,
  safeParseCatalogEntry,
} from '../src/schema';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal valid artifact input. */
const minimalArtifact = {
  kind: 'artifact',
  id: 'tool:glab',
  nature: 'tool',
  source: 'internal',
  targets: ['claude'],
  scopes: ['user'],
} as const;

/** Fully populated artifact input — all optional fields present. */
const fullArtifact = {
  kind: 'artifact',
  id: 'plugin:prettier',
  nature: 'plugin',
  source: 'external',
  level: 'recommended',
  targets: ['claude', 'opencode'],
  scopes: ['user', 'project'],
  requires: ['tool:node'],
  check: 'which prettier',
  install: {
    brew: 'prettier',
    npm: 'prettier',
    pnpm: 'prettier',
    mise: 'node',
  },
} as const;

/** Minimal valid pack input. */
const minimalPack = {
  kind: 'pack',
  id: 'pack:dev-tools',
  source: 'internal',
  targets: ['claude'],
  scopes: ['user'],
  members: ['tool:glab', 'tool:gh'],
} as const;

// ---------------------------------------------------------------------------
// Artifact — minimal valid
// ---------------------------------------------------------------------------

describe('CatalogEntrySchema — artifact minimal valid', () => {
  it('parses and kind is artifact', () => {
    const result = CatalogEntrySchema.safeParse(minimalArtifact);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.kind).toBe('artifact');
  });

  it('nature is present on artifact', () => {
    const result = CatalogEntrySchema.safeParse(minimalArtifact);
    expect(result.success).toBe(true);
    if (!result.success) return;
    if (result.data.kind !== 'artifact') return;
    expect(result.data.nature).toBe('tool');
  });

  it('common fields are parsed correctly', () => {
    const result = CatalogEntrySchema.safeParse(minimalArtifact);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.id).toBe('tool:glab');
    expect(result.data.source).toBe('internal');
    expect(result.data.targets).toEqual(['claude']);
    expect(result.data.scopes).toEqual(['user']);
  });

  it('optional artifact fields are absent when not provided', () => {
    const result = CatalogEntrySchema.safeParse(minimalArtifact);
    expect(result.success).toBe(true);
    if (!result.success) return;
    if (result.data.kind !== 'artifact') return;
    expect(result.data.level).toBeUndefined();
    expect(result.data.requires).toBeUndefined();
    expect(result.data.check).toBeUndefined();
    expect(result.data.install).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Artifact — full valid
// ---------------------------------------------------------------------------

describe('CatalogEntrySchema — artifact full valid', () => {
  it('parses all optional artifact fields', () => {
    const result = CatalogEntrySchema.safeParse(fullArtifact);
    expect(result.success).toBe(true);
    if (!result.success) return;
    if (result.data.kind !== 'artifact') return;

    expect(result.data.level).toBe('recommended');
    expect(result.data.targets).toEqual(['claude', 'opencode']);
    expect(result.data.scopes).toEqual(['user', 'project']);
    expect(result.data.requires).toEqual(['tool:node']);
    expect(result.data.check).toBe('which prettier');
    expect(result.data.install).toEqual({
      brew: 'prettier',
      npm: 'prettier',
      pnpm: 'prettier',
      mise: 'node',
    });
  });
});

// ---------------------------------------------------------------------------
// Artifact — all 7 natures accepted
// ---------------------------------------------------------------------------

describe('CatalogEntrySchema — artifact all natures', () => {
  const natures = ['plugin', 'guardrail', 'context', 'skill', 'agent', 'mcp', 'tool'] as const;

  for (const nature of natures) {
    it(`accepts nature '${nature}'`, () => {
      const result = CatalogEntrySchema.safeParse({ ...minimalArtifact, nature });
      expect(result.success).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Pack — minimal valid
// ---------------------------------------------------------------------------

describe('CatalogEntrySchema — pack minimal valid', () => {
  it('parses and kind is pack', () => {
    const result = CatalogEntrySchema.safeParse(minimalPack);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.kind).toBe('pack');
  });

  it('members is present and non-empty on pack', () => {
    const result = CatalogEntrySchema.safeParse(minimalPack);
    expect(result.success).toBe(true);
    if (!result.success) return;
    if (result.data.kind !== 'pack') return;
    expect(result.data.members).toEqual(['tool:glab', 'tool:gh']);
  });

  it('nature is not present on pack', () => {
    const result = CatalogEntrySchema.safeParse(minimalPack);
    expect(result.success).toBe(true);
    if (!result.success) return;
    // TypeScript prevents accessing .nature on PackEntry — checking runtime shape
    const data = result.data as Record<string, unknown>;
    expect('nature' in data).toBe(false);
  });

  it('pack with requires optional field', () => {
    const result = CatalogEntrySchema.safeParse({ ...minimalPack, requires: ['tool:git'] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    if (result.data.kind !== 'pack') return;
    expect(result.data.requires).toEqual(['tool:git']);
  });
});

// ---------------------------------------------------------------------------
// Rejections — kind
// ---------------------------------------------------------------------------

describe('CatalogEntrySchema — rejections: kind', () => {
  it('rejects missing kind', () => {
    const { kind: _k, ...rest } = minimalArtifact;
    const result = CatalogEntrySchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects unknown kind', () => {
    const result = CatalogEntrySchema.safeParse({ ...minimalArtifact, kind: 'bundle' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rejections — artifact variant
// ---------------------------------------------------------------------------

describe('CatalogEntrySchema — rejections: artifact', () => {
  it('rejects artifact without nature', () => {
    const { nature: _n, ...rest } = minimalArtifact;
    const result = CatalogEntrySchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects artifact with unknown nature', () => {
    const result = CatalogEntrySchema.safeParse({ ...minimalArtifact, nature: 'unknown-kind' });
    expect(result.success).toBe(false);
  });

  it('rejects artifact with invalid level', () => {
    const result = CatalogEntrySchema.safeParse({ ...minimalArtifact, level: 'optional' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rejections — pack variant
// ---------------------------------------------------------------------------

describe('CatalogEntrySchema — rejections: pack', () => {
  it('rejects pack without members', () => {
    const { members: _m, ...rest } = minimalPack;
    const result = CatalogEntrySchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects pack with empty members array', () => {
    const result = CatalogEntrySchema.safeParse({ ...minimalPack, members: [] });
    expect(result.success).toBe(false);
  });

  it('rejects pack with nature field (PackEntrySchema is strict)', () => {
    const result = PackEntrySchema.safeParse({ ...minimalPack, nature: 'tool' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rejections — common fields
// ---------------------------------------------------------------------------

describe('CatalogEntrySchema — rejections: common fields', () => {
  it('rejects empty id on artifact', () => {
    const result = CatalogEntrySchema.safeParse({ ...minimalArtifact, id: '' });
    expect(result.success).toBe(false);
  });

  it('rejects empty id on pack', () => {
    const result = CatalogEntrySchema.safeParse({ ...minimalPack, id: '' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid source on artifact', () => {
    const result = CatalogEntrySchema.safeParse({ ...minimalArtifact, source: 'interne' });
    expect(result.success).toBe(false);
  });

  it('rejects empty targets array on artifact', () => {
    const result = CatalogEntrySchema.safeParse({ ...minimalArtifact, targets: [] });
    expect(result.success).toBe(false);
  });

  it('rejects empty scopes array on artifact', () => {
    const result = CatalogEntrySchema.safeParse({ ...minimalArtifact, scopes: [] });
    expect(result.success).toBe(false);
  });

  it('rejects targets with unknown assistant on pack', () => {
    const result = CatalogEntrySchema.safeParse({ ...minimalPack, targets: ['unknown-ai'] });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Correct discrimination
// ---------------------------------------------------------------------------

describe('CatalogEntrySchema — discrimination', () => {
  it('pack input is rejected by ArtifactEntrySchema', () => {
    const result = ArtifactEntrySchema.safeParse(minimalPack);
    expect(result.success).toBe(false);
  });

  it('artifact input is rejected by PackEntrySchema', () => {
    const result = PackEntrySchema.safeParse(minimalArtifact);
    expect(result.success).toBe(false);
  });

  it('discriminated union routes artifact correctly', () => {
    const result = CatalogEntrySchema.safeParse(minimalArtifact);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.kind).toBe('artifact');
  });

  it('discriminated union routes pack correctly', () => {
    const result = CatalogEntrySchema.safeParse(minimalPack);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.kind).toBe('pack');
  });
});

// ---------------------------------------------------------------------------
// parseCatalogEntry helper
// ---------------------------------------------------------------------------

describe('parseCatalogEntry', () => {
  it('returns typed ArtifactEntry for valid artifact input', () => {
    const entry: CatalogEntry = parseCatalogEntry(minimalArtifact);
    expect(entry.kind).toBe('artifact');
    expect(entry.id).toBe('tool:glab');
  });

  it('returns typed PackEntry for valid pack input', () => {
    const entry: CatalogEntry = parseCatalogEntry(minimalPack);
    expect(entry.kind).toBe('pack');
  });

  it('throws on invalid input (empty id)', () => {
    expect(() => parseCatalogEntry({ ...minimalArtifact, id: '' })).toThrow();
  });

  it('throws on invalid input (wrong nature)', () => {
    expect(() => parseCatalogEntry({ ...minimalArtifact, nature: 'invalid' })).toThrow();
  });

  it('throws on null, number, empty object', () => {
    expect(() => parseCatalogEntry(null)).toThrow();
    expect(() => parseCatalogEntry(42)).toThrow();
    expect(() => parseCatalogEntry({})).toThrow();
  });
});

// ---------------------------------------------------------------------------
// safeParseCatalogEntry helper
// ---------------------------------------------------------------------------

describe('safeParseCatalogEntry', () => {
  it('returns success=true with data for valid artifact', () => {
    const result = safeParseCatalogEntry(minimalArtifact);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.kind).toBe('artifact');
  });

  it('returns success=true with data for valid pack', () => {
    const result = safeParseCatalogEntry(minimalPack);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.kind).toBe('pack');
  });

  it('returns success=false with error for invalid input', () => {
    const result = safeParseCatalogEntry({ ...minimalArtifact, id: '' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Type exports — compile-time smoke test
// ---------------------------------------------------------------------------

describe('exported types', () => {
  it('ArtifactEntry is assignable from parsed artifact data', () => {
    const result = ArtifactEntrySchema.safeParse(minimalArtifact);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const _entry: ArtifactEntry = result.data;
    expect(_entry.kind).toBe('artifact');
  });

  it('PackEntry is assignable from parsed pack data', () => {
    const result = PackEntrySchema.safeParse(minimalPack);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const _entry: PackEntry = result.data;
    expect(_entry.kind).toBe('pack');
  });
});
