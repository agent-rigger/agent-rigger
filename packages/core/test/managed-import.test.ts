/**
 * Tests for managed-import.ts — ensureImportBlock(claudeMd, target).
 *
 * Function is pure (string → string); no I/O, no filesystem.
 * All cases run synchronously.
 *
 * Invariants:
 * - A single managed block is present after the call.
 * - User content (before / after the block) is preserved intact.
 * - Idempotent: calling twice with the same target returns the same string.
 * - If an equivalent bare `@<target>` line exists outside the markers,
 *   no second block is added.
 * - If a managed block already exists, it is replaced in place.
 */

import { describe, expect, it } from 'bun:test';

import { ensureImportBlock } from '../src/managed-import';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TARGET = '~/.claude/harness/AGENTS.md';
const OTHER_TARGET = '~/.claude/harness/OTHER.md';

const BEGIN_MARKER = '<!-- BEGIN agent-rigger (managed — do not edit) -->';
const END_MARKER = '<!-- END agent-rigger -->';

function makeBlock(target: string): string {
  return `${BEGIN_MARKER}\n@${target}\n${END_MARKER}`;
}

// ---------------------------------------------------------------------------
// Case 1 — Empty CLAUDE.md
// ---------------------------------------------------------------------------

describe('empty CLAUDE.md', () => {
  it('returns only the managed block when input is empty string', () => {
    const result = ensureImportBlock('', TARGET);
    expect(result).toBe(makeBlock(TARGET));
  });
});

// ---------------------------------------------------------------------------
// Case 2 — CLAUDE.md without any managed block
// ---------------------------------------------------------------------------

describe('CLAUDE.md without managed block', () => {
  it('appends the managed block at the end, preserving existing content', () => {
    const existing = '# My Notes\n\nSome user content here.';
    const result = ensureImportBlock(existing, TARGET);

    // User content must be intact at the head
    expect(result.startsWith(existing)).toBe(true);
    // Block must appear at the end
    expect(result.endsWith(makeBlock(TARGET))).toBe(true);
    // Separated from user content by a blank line
    expect(result).toContain(`${existing}\n\n${makeBlock(TARGET)}`);
  });

  it('preserves content that comes before the block (multi-line)', () => {
    const line1 = '# Section A';
    const line2 = '';
    const line3 = 'Some important instruction.';
    const existing = [line1, line2, line3].join('\n');

    const result = ensureImportBlock(existing, TARGET);

    expect(result.startsWith(existing)).toBe(true);
    expect(result).toContain(makeBlock(TARGET));
  });

  it('contains exactly one BEGIN marker', () => {
    const existing = '# My Notes\n\nUser content.';
    const result = ensureImportBlock(existing, TARGET);

    const count = result.split(BEGIN_MARKER).length - 1;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Case 3 — Managed block already present with same target
// ---------------------------------------------------------------------------

describe('managed block already present — same target', () => {
  it('returns content with a single managed block (no duplication)', () => {
    const claudeMd = `# My Notes\n\n${makeBlock(TARGET)}`;
    const result = ensureImportBlock(claudeMd, TARGET);

    const count = result.split(BEGIN_MARKER).length - 1;
    expect(count).toBe(1);
  });

  it('is idempotent when called twice with the same target', () => {
    const claudeMd = '# My Notes\n\nUser content.';
    const first = ensureImportBlock(claudeMd, TARGET);
    const second = ensureImportBlock(first, TARGET);

    expect(second).toBe(first);
  });

  it('is idempotent starting from already-managed content', () => {
    const claudeMd = `# My Notes\n\n${makeBlock(TARGET)}`;
    const first = ensureImportBlock(claudeMd, TARGET);
    const second = ensureImportBlock(first, TARGET);

    expect(second).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// Case 4 — Managed block already present with different target → replace in place
// ---------------------------------------------------------------------------

describe('managed block already present — different target', () => {
  it('replaces the target inside the block in place', () => {
    const claudeMd = `# My Notes\n\n${makeBlock(OTHER_TARGET)}`;
    const result = ensureImportBlock(claudeMd, TARGET);

    expect(result).toContain(`@${TARGET}`);
    expect(result).not.toContain(`@${OTHER_TARGET}`);
  });

  it('does not duplicate the managed block when target changes', () => {
    const claudeMd = `# My Notes\n\n${makeBlock(OTHER_TARGET)}`;
    const result = ensureImportBlock(claudeMd, TARGET);

    const count = result.split(BEGIN_MARKER).length - 1;
    expect(count).toBe(1);
  });

  it('keeps the block at the same position (in-place replacement)', () => {
    const before = '# Section A\n\nBefore content.';
    const after = '\n\nAfter content.';
    const claudeMd = `${before}\n\n${makeBlock(OTHER_TARGET)}${after}`;

    const result = ensureImportBlock(claudeMd, TARGET);

    expect(result.startsWith(before)).toBe(true);
    expect(result.endsWith(after)).toBe(true);
    expect(result).toContain(makeBlock(TARGET));
  });
});

// ---------------------------------------------------------------------------
// Case 5 — Bare @<target> import already exists outside the markers
// ---------------------------------------------------------------------------

describe('bare @<target> import already exists outside managed block', () => {
  it('does not add a managed block when an equivalent bare import line is present', () => {
    const claudeMd = `# My Notes\n\n@${TARGET}\n\nMore content.`;
    const result = ensureImportBlock(claudeMd, TARGET);

    // No managed block should be added
    expect(result).not.toContain(BEGIN_MARKER);
    expect(result).not.toContain(END_MARKER);
    // The original content is returned unchanged
    expect(result).toBe(claudeMd);
  });

  it('is idempotent when bare import is present', () => {
    const claudeMd = `# My Notes\n\n@${TARGET}\n\nMore content.`;
    const first = ensureImportBlock(claudeMd, TARGET);
    const second = ensureImportBlock(first, TARGET);

    expect(second).toBe(first);
    expect(second).toBe(claudeMd);
  });

  it('does not treat a different target as equivalent', () => {
    const claudeMd = `# My Notes\n\n@${OTHER_TARGET}\n\nMore content.`;
    const result = ensureImportBlock(claudeMd, TARGET);

    // Should add the managed block since the bare import is for a different target
    expect(result).toContain(BEGIN_MARKER);
    expect(result).toContain(`@${TARGET}`);
  });
});

// ---------------------------------------------------------------------------
// Case 6 — Content after the managed block is preserved
// ---------------------------------------------------------------------------

describe('content after the managed block is preserved', () => {
  it('preserves content that appears after the managed block', () => {
    const before = '# Notes\n\nBefore.';
    const after = '\n\nAfter the block.';
    const claudeMd = `${before}\n\n${makeBlock(TARGET)}${after}`;

    const result = ensureImportBlock(claudeMd, TARGET);

    expect(result).toContain(after);
    expect(result.endsWith(after)).toBe(true);
  });

  it('preserves content after the block when target changes', () => {
    const before = '# Notes\n\nBefore.';
    const after = '\n\nAfter the block.';
    const claudeMd = `${before}\n\n${makeBlock(OTHER_TARGET)}${after}`;

    const result = ensureImportBlock(claudeMd, TARGET);

    expect(result).toContain(after);
    expect(result.endsWith(after)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case 7 — Block markers exact format
// ---------------------------------------------------------------------------

describe('managed block format', () => {
  it('uses exact BEGIN and END markers', () => {
    const result = ensureImportBlock('', TARGET);

    expect(result).toContain(BEGIN_MARKER);
    expect(result).toContain(END_MARKER);
  });

  it('import line is @<target> with no extra spaces', () => {
    const result = ensureImportBlock('', TARGET);

    const lines = result.split('\n');
    const importLine = lines.find((l) => l.startsWith('@'));
    expect(importLine).toBe(`@${TARGET}`);
  });

  it('block has correct structure: BEGIN, import, END on separate lines', () => {
    const result = ensureImportBlock('', TARGET);
    const expected = `${BEGIN_MARKER}\n@${TARGET}\n${END_MARKER}`;
    expect(result).toBe(expected);
  });
});
