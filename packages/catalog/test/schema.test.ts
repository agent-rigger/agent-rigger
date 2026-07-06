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
  type CatalogFile,
  CatalogFileSchema,
  type CatalogMeta,
  type HookEvent,
  MetaSchema,
  type PackEntry,
  PackEntrySchema,
  parseCatalog,
  parseCatalogEntry,
  safeParseCatalog,
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
  targets: ['claude'],
  scopes: ['user'],
} as const;

/** Fully populated artifact input — all optional fields present. */
const fullArtifact = {
  kind: 'artifact',
  id: 'plugin:prettier',
  nature: 'plugin',
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

// ---------------------------------------------------------------------------
// ArtifactEntrySchema — hook-specific fields (event, matcher, timeout)
// ---------------------------------------------------------------------------

/** A fully populated hook artifact entry. */
const hookArtifact = {
  kind: 'artifact',
  id: 'hook:guard-x',
  nature: 'hook',
  targets: ['claude'],
  scopes: ['user'],
  event: 'PreToolUse',
  matcher: 'Bash',
  timeout: 5,
} as const;

describe('ArtifactEntrySchema — hook artifact with event/matcher/timeout parses OK', () => {
  it('parses a complete hook entry successfully', () => {
    const result = ArtifactEntrySchema.safeParse(hookArtifact);
    expect(result.success).toBe(true);
  });

  it('event field is preserved', () => {
    const result = ArtifactEntrySchema.safeParse(hookArtifact);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.event).toBe('PreToolUse');
  });

  it('matcher field is preserved', () => {
    const result = ArtifactEntrySchema.safeParse(hookArtifact);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.matcher).toBe('Bash');
  });

  it('timeout field is preserved', () => {
    const result = ArtifactEntrySchema.safeParse(hookArtifact);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.timeout).toBe(5);
  });
});

describe('ArtifactEntrySchema — non-hook fields event/matcher/timeout are optional', () => {
  it('parses skill without event/matcher/timeout (all optional for non-hook)', () => {
    const result = ArtifactEntrySchema.safeParse({
      kind: 'artifact',
      id: 'skill:x',
      nature: 'skill',
      targets: ['claude'],
      scopes: ['user'],
    });
    expect(result.success).toBe(true);
  });

  it('event is absent on non-hook when not provided', () => {
    const result = ArtifactEntrySchema.safeParse({
      kind: 'artifact',
      id: 'skill:x',
      nature: 'skill',
      targets: ['claude'],
      scopes: ['user'],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.event).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// B-i.1: hook entries require event + matcher
// ---------------------------------------------------------------------------

describe('ArtifactEntrySchema — hook requires event + matcher (B-i.1)', () => {
  it('rejects hook without event', () => {
    const result = ArtifactEntrySchema.safeParse({
      kind: 'artifact',
      id: 'hook:x',
      nature: 'hook',
      targets: ['claude'],
      scopes: ['user'],
      matcher: 'Bash',
    });
    expect(result.success).toBe(false);
  });

  it('rejects hook without matcher', () => {
    const result = ArtifactEntrySchema.safeParse({
      kind: 'artifact',
      id: 'hook:x',
      nature: 'hook',
      targets: ['claude'],
      scopes: ['user'],
      event: 'PreToolUse',
    });
    expect(result.success).toBe(false);
  });

  it('rejects hook without both event and matcher', () => {
    const result = ArtifactEntrySchema.safeParse({
      kind: 'artifact',
      id: 'hook:x',
      nature: 'hook',
      targets: ['claude'],
      scopes: ['user'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid hook with both event and matcher', () => {
    const result = ArtifactEntrySchema.safeParse({
      kind: 'artifact',
      id: 'hook:x',
      nature: 'hook',
      targets: ['claude'],
      scopes: ['user'],
      event: 'PreToolUse',
      matcher: 'Bash',
    });
    expect(result.success).toBe(true);
  });

  it('accepts non-hook without event or matcher', () => {
    const result = ArtifactEntrySchema.safeParse({
      kind: 'artifact',
      id: 'skill:x',
      nature: 'skill',
      targets: ['claude'],
      scopes: ['user'],
    });
    expect(result.success).toBe(true);
  });

  it('CatalogEntrySchema also rejects hook without event', () => {
    const result = CatalogEntrySchema.safeParse({
      kind: 'artifact',
      id: 'hook:x',
      nature: 'hook',
      targets: ['claude'],
      scopes: ['user'],
      matcher: 'Bash',
    });
    expect(result.success).toBe(false);
  });

  it('CatalogEntrySchema also rejects hook without matcher', () => {
    const result = CatalogEntrySchema.safeParse({
      kind: 'artifact',
      id: 'hook:x',
      nature: 'hook',
      targets: ['claude'],
      scopes: ['user'],
      event: 'PreToolUse',
    });
    expect(result.success).toBe(false);
  });
});

describe('ArtifactEntrySchema — invalid event is rejected', () => {
  it('rejects unknown event value "Foo"', () => {
    const result = ArtifactEntrySchema.safeParse({ ...hookArtifact, event: 'Foo' });
    expect(result.success).toBe(false);
  });

  it('rejects lowercase event value "preToolUse"', () => {
    const result = ArtifactEntrySchema.safeParse({ ...hookArtifact, event: 'preToolUse' });
    expect(result.success).toBe(false);
  });
});

describe('ArtifactEntrySchema — invalid timeout is rejected', () => {
  it('rejects negative timeout', () => {
    const result = ArtifactEntrySchema.safeParse({ ...hookArtifact, timeout: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects zero timeout (not positive)', () => {
    const result = ArtifactEntrySchema.safeParse({ ...hookArtifact, timeout: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer timeout (float)', () => {
    const result = ArtifactEntrySchema.safeParse({ ...hookArtifact, timeout: 1.5 });
    expect(result.success).toBe(false);
  });
});

describe('ArtifactEntrySchema — all HookEvent values are valid', () => {
  const events: HookEvent[] = [
    'PreToolUse',
    'PostToolUse',
    'UserPromptSubmit',
    'Stop',
    'SubagentStop',
    'SessionStart',
    'SessionEnd',
    'Notification',
    'PreCompact',
  ];

  for (const event of events) {
    it(`accepts event '${event}'`, () => {
      const result = ArtifactEntrySchema.safeParse({ ...hookArtifact, event });
      expect(result.success).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// MetaSchema
// ---------------------------------------------------------------------------

/** Minimal valid meta input. */
const minimalMeta = { name: 'my-catalog' } as const;

/** Full meta input with required + recommended. */
const fullMeta = {
  name: 'my-catalog',
  required: ['pack:essentials', 'tool:glab'],
  recommended: ['pack:extras', 'skill:remote-demo'],
} as const;

describe('MetaSchema — valid inputs', () => {
  it('parses minimal meta with only name', () => {
    const result = MetaSchema.safeParse(minimalMeta);
    expect(result.success).toBe(true);
  });

  it('name is preserved', () => {
    const result = MetaSchema.safeParse(minimalMeta);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.name).toBe('my-catalog');
  });

  it('required defaults to [] when absent', () => {
    const result = MetaSchema.safeParse(minimalMeta);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.required).toEqual([]);
  });

  it('recommended defaults to [] when absent', () => {
    const result = MetaSchema.safeParse(minimalMeta);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.recommended).toEqual([]);
  });

  it('parses full meta with required and recommended', () => {
    const result = MetaSchema.safeParse(fullMeta);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.required).toEqual(['pack:essentials', 'tool:glab']);
    expect(result.data.recommended).toEqual(['pack:extras', 'skill:remote-demo']);
  });

  it('accepts arbitrary ids (pack and artifact) in required', () => {
    const result = MetaSchema.safeParse({
      name: 'test',
      required: ['pack:x', 'tool:y', 'skill:z', 'arbitrary-id'],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.required).toHaveLength(4);
  });

  it('accepts arbitrary ids in recommended', () => {
    const result = MetaSchema.safeParse({
      name: 'test',
      recommended: ['artifact:any', 'pack:y'],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.recommended).toHaveLength(2);
  });
});

describe('MetaSchema — rejections', () => {
  it('rejects missing name', () => {
    const result = MetaSchema.safeParse({ required: [] });
    expect(result.success).toBe(false);
  });

  it('rejects empty name', () => {
    const result = MetaSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
  });

  it('rejects null', () => {
    const result = MetaSchema.safeParse(null);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CatalogFileSchema
// ---------------------------------------------------------------------------

/** Minimal valid catalog file input. */
const minimalCatalogFile = {
  meta: { name: 'test-catalog' },
  entries: [],
} as const;

/** Catalog file with entries. */
const catalogFileWithEntries = {
  meta: { name: 'test-catalog', required: ['pack:essentials'] },
  entries: [minimalArtifact, minimalPack],
} as const;

describe('CatalogFileSchema — valid inputs', () => {
  it('parses minimal catalog file with empty entries', () => {
    const result = CatalogFileSchema.safeParse(minimalCatalogFile);
    expect(result.success).toBe(true);
  });

  it('meta.name is preserved', () => {
    const result = CatalogFileSchema.safeParse(minimalCatalogFile);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.meta.name).toBe('test-catalog');
  });

  it('parses catalog file with artifact and pack entries', () => {
    const result = CatalogFileSchema.safeParse(catalogFileWithEntries);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.entries).toHaveLength(2);
  });

  it('meta.required is present when provided', () => {
    const result = CatalogFileSchema.safeParse(catalogFileWithEntries);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.meta.required).toEqual(['pack:essentials']);
  });

  it('meta.required defaults to [] when absent', () => {
    const result = CatalogFileSchema.safeParse(minimalCatalogFile);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.meta.required).toEqual([]);
  });

  it('meta.recommended defaults to [] when absent', () => {
    const result = CatalogFileSchema.safeParse(minimalCatalogFile);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.meta.recommended).toEqual([]);
  });

  it('entries array can contain both artifact and pack', () => {
    const result = CatalogFileSchema.safeParse(catalogFileWithEntries);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.entries[0]?.kind).toBe('artifact');
    expect(result.data.entries[1]?.kind).toBe('pack');
  });
});

describe('CatalogFileSchema — rejections', () => {
  it('rejects bare array (legacy format)', () => {
    const result = CatalogFileSchema.safeParse([minimalArtifact]);
    expect(result.success).toBe(false);
  });

  it('rejects object without meta', () => {
    const result = CatalogFileSchema.safeParse({ entries: [] });
    expect(result.success).toBe(false);
  });

  it('rejects object with meta.name missing', () => {
    const result = CatalogFileSchema.safeParse({ meta: { required: [] }, entries: [] });
    expect(result.success).toBe(false);
  });

  it('rejects object with meta.name empty string', () => {
    const result = CatalogFileSchema.safeParse({ meta: { name: '' }, entries: [] });
    expect(result.success).toBe(false);
  });

  it('rejects object without entries', () => {
    const result = CatalogFileSchema.safeParse({ meta: { name: 'test' } });
    expect(result.success).toBe(false);
  });

  it('rejects when an entry has invalid nature', () => {
    const badEntry = { ...minimalArtifact, nature: 'unknown' };
    const result = CatalogFileSchema.safeParse({ meta: { name: 'test' }, entries: [badEntry] });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseCatalog / safeParseCatalog helpers
// ---------------------------------------------------------------------------

describe('parseCatalog', () => {
  it('returns typed CatalogFile for valid wrapped input', () => {
    const file: CatalogFile = parseCatalog(minimalCatalogFile);
    expect(file.meta.name).toBe('test-catalog');
    expect(file.entries).toEqual([]);
  });

  it('throws on bare array input', () => {
    expect(() => parseCatalog([minimalArtifact])).toThrow();
  });

  it('throws when meta.name is empty', () => {
    expect(() => parseCatalog({ meta: { name: '' }, entries: [] })).toThrow();
  });

  it('throws on null / number / string inputs', () => {
    expect(() => parseCatalog(null)).toThrow();
    expect(() => parseCatalog(42)).toThrow();
    expect(() => parseCatalog('string')).toThrow();
  });
});

describe('safeParseCatalog', () => {
  it('returns success=true with data for valid wrapped input', () => {
    const result = safeParseCatalog(minimalCatalogFile);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.meta.name).toBe('test-catalog');
  });

  it('returns success=false for bare array input', () => {
    const result = safeParseCatalog([minimalArtifact]);
    expect(result.success).toBe(false);
  });

  it('returns success=false when meta.name is missing', () => {
    const result = safeParseCatalog({ meta: {}, entries: [] });
    expect(result.success).toBe(false);
  });

  it('returns success=false when meta.name is empty string', () => {
    const result = safeParseCatalog({ meta: { name: '' }, entries: [] });
    expect(result.success).toBe(false);
  });

  it('returns error object when parsing fails', () => {
    const result = safeParseCatalog({ meta: { name: '' }, entries: [] });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Type exports — compile-time smoke test for new types
// ---------------------------------------------------------------------------

describe('exported types — CatalogMeta and CatalogFile', () => {
  it('CatalogMeta is assignable from parsed meta data', () => {
    const result = MetaSchema.safeParse(fullMeta);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const _meta: CatalogMeta = result.data;
    expect(_meta.name).toBe('my-catalog');
  });

  it('CatalogFile is assignable from parsed catalog file data', () => {
    const result = CatalogFileSchema.safeParse(minimalCatalogFile);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const _file: CatalogFile = result.data;
    expect(_file.meta.name).toBe('test-catalog');
  });
});

// ---------------------------------------------------------------------------
// E3 (opencode-adapter) — mcp entries carry a raw `config` object
// ---------------------------------------------------------------------------

describe('ArtifactEntrySchema — mcp config field (E3, additive)', () => {
  it('parses an mcp entry with a config object', () => {
    const result = ArtifactEntrySchema.safeParse({
      kind: 'artifact',
      id: 'mcp:my-server',
      nature: 'mcp',
      targets: ['opencode'],
      scopes: ['user'],
      config: { type: 'local', command: ['bunx', 'my-mcp-server'] },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.config).toEqual({ type: 'local', command: ['bunx', 'my-mcp-server'] });
  });

  it('config is absent when not provided (non-mcp entries)', () => {
    const result = ArtifactEntrySchema.safeParse(minimalArtifact);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.config).toBeUndefined();
  });

  it('config is not required for mcp entries at the schema level (builder enforces it)', () => {
    const result = ArtifactEntrySchema.safeParse({
      kind: 'artifact',
      id: 'mcp:my-server',
      nature: 'mcp',
      targets: ['opencode'],
      scopes: ['user'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-object config value', () => {
    const result = ArtifactEntrySchema.safeParse({
      kind: 'artifact',
      id: 'mcp:my-server',
      nature: 'mcp',
      targets: ['opencode'],
      scopes: ['user'],
      config: 'not-an-object',
    });
    expect(result.success).toBe(false);
  });
});
