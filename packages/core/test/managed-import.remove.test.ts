/**
 * Tests for managed-import.ts — removeImportBlock(claudeMd).
 *
 * Pure function (string → string); no I/O, no filesystem.
 * All cases run synchronously.
 *
 * Invariants:
 * - Removes the managed block (BEGIN…END markers and content between them).
 * - User content before and after the block is preserved intact.
 * - Residual blank lines left by the removal are cleaned up.
 * - If no managed block is present → input returned unchanged.
 * - Idempotent: calling twice returns the same result as calling once.
 */

import { describe, expect, it } from 'bun:test';

import { removeImportBlock } from '../src/managed-import';

const BEGIN_MARKER = '<!-- BEGIN agent-rigger (managed — do not edit) -->';
const END_MARKER = '<!-- END agent-rigger -->';
const TARGET = '~/.claude/harness/AGENTS.md';

function makeBlock(target: string): string {
  return `${BEGIN_MARKER}\n@${target}\n${END_MARKER}`;
}

// ---------------------------------------------------------------------------
// No block present — no-op
// ---------------------------------------------------------------------------

describe('removeImportBlock: no managed block', () => {
  it('returns input unchanged when no managed block is present', () => {
    const md = '# My Notes\n\nSome user content.';
    expect(removeImportBlock(md)).toBe(md);
  });

  it('returns empty string unchanged', () => {
    expect(removeImportBlock('')).toBe('');
  });

  it('is idempotent when no block is present', () => {
    const md = '# Notes\n\nContent.';
    expect(removeImportBlock(removeImportBlock(md))).toBe(removeImportBlock(md));
  });
});

// ---------------------------------------------------------------------------
// Block present — removal
// ---------------------------------------------------------------------------

describe('removeImportBlock: block present', () => {
  it('removes a block that is the only content', () => {
    const md = makeBlock(TARGET);
    const result = removeImportBlock(md);
    expect(result).not.toContain(BEGIN_MARKER);
    expect(result).not.toContain(END_MARKER);
    expect(result).not.toContain(`@${TARGET}`);
  });

  it('preserves user content that appears before the block', () => {
    const before = '# My Notes\n\nUser content here.';
    const md = `${before}\n\n${makeBlock(TARGET)}`;
    const result = removeImportBlock(md);
    expect(result).toContain('# My Notes');
    expect(result).toContain('User content here.');
    expect(result).not.toContain(BEGIN_MARKER);
  });

  it('preserves user content that appears after the block', () => {
    const after = 'Content after the block.';
    const md = `${makeBlock(TARGET)}\n\n${after}`;
    const result = removeImportBlock(md);
    expect(result).toContain(after);
    expect(result).not.toContain(BEGIN_MARKER);
  });

  it('preserves user content before AND after the block', () => {
    const before = '# Section A\n\nBefore content.';
    const after = 'After content.';
    const md = `${before}\n\n${makeBlock(TARGET)}\n\n${after}`;
    const result = removeImportBlock(md);
    expect(result).toContain('# Section A');
    expect(result).toContain('Before content.');
    expect(result).toContain('After content.');
    expect(result).not.toContain(BEGIN_MARKER);
    expect(result).not.toContain(END_MARKER);
  });

  it('does not produce leading/trailing blank lines when block was the only content', () => {
    const md = makeBlock(TARGET);
    const result = removeImportBlock(md);
    expect(result).toBe('');
  });

  it('does not leave double blank lines between before and after content', () => {
    const before = 'Before.';
    const after = 'After.';
    const md = `${before}\n\n${makeBlock(TARGET)}\n\n${after}`;
    const result = removeImportBlock(md);
    // Should not have more than one consecutive blank line
    expect(result).not.toMatch(/\n{3,}/);
    expect(result).toContain(before);
    expect(result).toContain(after);
  });

  it('is idempotent: calling twice returns the same result as calling once', () => {
    const before = '# Notes\n\nBefore.';
    const after = '\n\nAfter.';
    const md = `${before}\n\n${makeBlock(TARGET)}${after}`;
    const first = removeImportBlock(md);
    const second = removeImportBlock(first);
    expect(second).toBe(first);
  });

  it('removes the block regardless of what target it imports', () => {
    const other = '~/.claude/harness/OTHER.md';
    const md = `# Notes\n\n${makeBlock(other)}`;
    const result = removeImportBlock(md);
    expect(result).not.toContain(BEGIN_MARKER);
    expect(result).not.toContain(`@${other}`);
  });
});
