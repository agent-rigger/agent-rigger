/**
 * Tests for catalog/src/schema.ts — parse-time rejection of path-traversal ids
 * (change catalog-id-traversal, 2026-07-18).
 *
 * TDD: written before the schema is hardened (RED → GREEN → refactor).
 *
 * A forged catalog id such as "skill:../../evil" must be rejected at
 * catalog.json parse, before any fetch / resolve / path construction — the same
 * verdict the deep guard assertSafeArtifactName reaches, one layer earlier.
 *
 * This is a security non-regression scenario (brief § Graduation): each reject
 * case is named by its concrete form so the file reads as the traversal-defence
 * table it is. Coverage:
 *  - isSafeCatalogId: forged ids rejected, legitimate ids accepted
 *  - CatalogEntrySchema: the id refine is wired on both artifact and pack
 *  - non-regression: every real id of the two workspace catalogs still passes
 */

import { describe, expect, it } from 'bun:test';

import { CatalogEntrySchema, isSafeCatalogId } from '../src/schema';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal valid artifact input — id is overridden per case. */
const minimalArtifact = {
  kind: 'artifact',
  id: 'skill:x',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user'],
} as const;

/** Minimal valid pack input — id is overridden per case. */
const minimalPack = {
  kind: 'pack',
  id: 'pack:x',
  targets: ['claude'],
  scopes: ['user'],
  members: ['tool:glab'],
} as const;

/**
 * Every id declared by the two workspace catalogs, frozen here so the
 * non-regression test never reads across repos at runtime (brief § Preuve
 * empirique). jr-agent-rigger-catalog (40 entries) + catalog-example (8).
 */
const REAL_WORKSPACE_IDS = [
  // jr-agent-rigger-catalog/catalog.json — 40 entries
  'hook:guard-command',
  'hook:guard-secret',
  'hook:guard-write-secret',
  'hook:guard-prompt',
  'guardrail:claude',
  'guardrail:opencode',
  'context:claude',
  'agent:pm',
  'agent:tech-lead',
  'agent:senior-fullstack',
  'agent:db-postgres',
  'agent:reviewer',
  'agent:tdd-coach',
  'agent:refactoring-specialist',
  'agent:committer',
  'agent:devops-engineer',
  'skill:spec-workflow',
  'skill:grill-with-docs',
  'skill:diagnose',
  'skill:testing',
  'skill:solid-principles',
  'skill:kiss-dry-yagni',
  'skill:typescript-coding-standards',
  'skill:security',
  'skill:documentation',
  'skill:git-workflow',
  'skill:workflow-analysis',
  'skill:react-architecture',
  'skill:react-coding-standards',
  'skill:react-security',
  'skill:react-testing',
  'skill:react-tooling',
  'skill:react-quality-tools',
  'skill:nestjs-standards',
  'pack:secu',
  'pack:spec-workflow',
  'pack:standards',
  'pack:agents-extra',
  'pack:stack-react-nest',
  'pack:baseline',
  // agent-rigger-catalog-example/catalog.json — 8 entries
  'skill:hello-rigger',
  'agent:demo',
  'guardrail:demo',
  'hook:demo',
  'context:demo',
  'tool:git',
  'pack:demo',
  'pack:full',
] as const;

// ---------------------------------------------------------------------------
// isSafeCatalogId — rejects forged ids (named by form)
// ---------------------------------------------------------------------------

describe('isSafeCatalogId — rejects traversal / unsafe ids', () => {
  it('rejects traversal id "skill:../../evil"', () => {
    expect(isSafeCatalogId('skill:../../evil')).toBe(false);
  });

  it('rejects bare-dotdot name "skill:.."', () => {
    expect(isSafeCatalogId('skill:..')).toBe(false);
  });

  it('rejects bare-dot name "skill:."', () => {
    expect(isSafeCatalogId('skill:.')).toBe(false);
  });

  it('rejects empty name "skill:"', () => {
    expect(isSafeCatalogId('skill:')).toBe(false);
  });

  it('rejects slash in prefix "sk/ill:x"', () => {
    expect(isSafeCatalogId('sk/ill:x')).toBe(false);
  });

  it('rejects slash in name "skill:a/b"', () => {
    expect(isSafeCatalogId('skill:a/b')).toBe(false);
  });

  it('rejects backslash in name "skill:a\\b"', () => {
    expect(isSafeCatalogId('skill:a\\b')).toBe(false);
  });

  it('rejects space (out of charset) "skill:a b"', () => {
    expect(isSafeCatalogId('skill:a b')).toBe(false);
  });

  it('rejects tilde (out of charset) "skill:~x"', () => {
    expect(isSafeCatalogId('skill:~x')).toBe(false);
  });

  it('rejects empty prefix ":x"', () => {
    expect(isSafeCatalogId(':x')).toBe(false);
  });

  it('rejects a second colon in the name "a::b"', () => {
    expect(isSafeCatalogId('a::b')).toBe(false);
  });

  it('rejects a non-ASCII letter (out of charset) "skill:café"', () => {
    expect(isSafeCatalogId('skill:café')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSafeCatalogId — accepts legitimate ids
// ---------------------------------------------------------------------------

describe('isSafeCatalogId — accepts legitimate ids', () => {
  it('accepts "skill:hello-rigger"', () => {
    expect(isSafeCatalogId('skill:hello-rigger')).toBe(true);
  });

  it('accepts "pack:secu"', () => {
    expect(isSafeCatalogId('pack:secu')).toBe(true);
  });

  it('accepts "tool:glab"', () => {
    expect(isSafeCatalogId('tool:glab')).toBe(true);
  });

  it('accepts an id without a colon and a valid charset "hello-rigger"', () => {
    expect(isSafeCatalogId('hello-rigger')).toBe(true);
  });

  it('accepts internal dots "skill:v1.2"', () => {
    expect(isSafeCatalogId('skill:v1.2')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CatalogEntrySchema — the id refine is wired on both variants
// ---------------------------------------------------------------------------

describe('CatalogEntrySchema — forged id rejected at parse', () => {
  it('rejects a forged id on an artifact entry, naming the id', () => {
    const result = CatalogEntrySchema.safeParse({ ...minimalArtifact, id: 'skill:../../evil' });
    expect(result.success).toBe(false);
    if (result.success) return;
    const onId = result.error.issues.find((issue) => issue.path.join('.') === 'id');
    expect(onId).toBeDefined();
    expect(onId?.message).toContain('skill:../../evil');
  });

  it('rejects a forged id on a pack entry', () => {
    const result = CatalogEntrySchema.safeParse({ ...minimalPack, id: 'pack:../../evil' });
    expect(result.success).toBe(false);
  });

  it('accepts a legitimate id on an artifact entry', () => {
    const result = CatalogEntrySchema.safeParse({ ...minimalArtifact, id: 'skill:hello-rigger' });
    expect(result.success).toBe(true);
  });

  it('sanitises a control-bearing id in the parse error message', () => {
    // A hostile id may carry ANSI/control sequences; the refine message must
    // escape them so a warning line cannot spoof the terminal or the logs.
    const raw = `skill:a${String.fromCharCode(0x1b)}[31mevil`;
    const result = CatalogEntrySchema.safeParse({ ...minimalArtifact, id: raw });
    expect(result.success).toBe(false);
    if (result.success) return;
    const onId = result.error.issues.find((issue) => issue.path.join('.') === 'id');
    expect(onId).toBeDefined();
    expect(onId?.message).not.toContain(String.fromCharCode(0x1b));
    expect(onId?.message).toContain('\\x1b');
  });
});

// ---------------------------------------------------------------------------
// Non-regression — every real workspace id passes the hardened schema
// ---------------------------------------------------------------------------

describe('non-regression — real workspace catalog ids stay valid', () => {
  it('accepts all 48 frozen ids from both workspace catalogs', () => {
    const rejected = REAL_WORKSPACE_IDS.filter((id) => !isSafeCatalogId(id));
    expect(rejected).toEqual([]);
  });
});
