/**
 * Managed-import logic for agent-rigger (R5, ADR-0007).
 *
 * Pure function — no I/O, no filesystem access.
 * Consumers (adapters/claude/context.ts) call this to compute the new
 * CLAUDE.md content; the actual read/write is the adapter's concern.
 *
 * Design invariants (design.md §4 — CLAUDE.md bloc managé):
 * - Exactly one managed block is present after the call.
 * - Idempotent: ensureImportBlock(ensureImportBlock(x, t), t) === ensureImportBlock(x, t).
 * - User content (before / after the block) is always preserved intact.
 * - A bare @<target> import outside the markers prevents block insertion.
 * - When a managed block exists, it is replaced in-place (position preserved).
 *
 * No I/O, no process.exit, no while loops.
 */

const BEGIN_MARKER = '<!-- BEGIN agent-rigger (managed — do not edit) -->';
const END_MARKER = '<!-- END agent-rigger -->';

/**
 * Build the managed block string for a given target.
 */
function buildBlock(target: string): string {
  return `${BEGIN_MARKER}\n@${target}\n${END_MARKER}`;
}

/**
 * Returns true if `claudeMd` contains a managed block (both markers present).
 */
function hasBlock(claudeMd: string): boolean {
  return claudeMd.includes(BEGIN_MARKER) && claudeMd.includes(END_MARKER);
}

/**
 * Returns true if a bare `@<target>` line exists **outside** the managed block.
 *
 * Strategy: strip the managed block (if any) from the content, then check for
 * the import line in the remainder.
 */
function hasBareImport(claudeMd: string, target: string): boolean {
  // Remove the managed block from consideration (if present)
  let outside = claudeMd;
  if (hasBlock(claudeMd)) {
    const beginIdx = outside.indexOf(BEGIN_MARKER);
    const endIdx = outside.indexOf(END_MARKER);
    // Strip from BEGIN to the end of END_MARKER line
    outside = outside.slice(0, beginIdx)
      + outside.slice(endIdx + END_MARKER.length);
  }

  // Check each line for an exact `@<target>` match
  const importLine = `@${target}`;
  for (const line of outside.split('\n')) {
    if (line === importLine) {
      return true;
    }
  }
  return false;
}

/**
 * Replace the managed block in-place, keeping all surrounding content.
 *
 * Assumes `hasBlock(claudeMd)` is true.
 */
function replaceBlock(claudeMd: string, target: string): string {
  const beginIdx = claudeMd.indexOf(BEGIN_MARKER);
  const endIdx = claudeMd.indexOf(END_MARKER);
  const endOfBlock = endIdx + END_MARKER.length;

  const prefix = claudeMd.slice(0, beginIdx);
  const suffix = claudeMd.slice(endOfBlock);

  return prefix + buildBlock(target) + suffix;
}

/**
 * Append the managed block to `claudeMd`, separated by a blank line when
 * there is existing non-empty content.
 */
function appendBlock(claudeMd: string, target: string): string {
  const block = buildBlock(target);
  if (claudeMd === '') {
    return block;
  }
  return `${claudeMd}\n\n${block}`;
}

/**
 * Ensure `claudeMd` contains exactly one managed block importing `target`.
 *
 * Rules (in evaluation order):
 * 1. Managed block present → replace in-place (handles same/different target).
 * 2. Bare `@<target>` line outside markers → return unchanged (user manages it).
 * 3. No block, no bare import → append block at the end.
 *
 * @param claudeMd - Current content of CLAUDE.md (may be empty string).
 * @param target   - The path to import (e.g. `~/.claude/harness/AGENTS.md`).
 * @returns        - The updated CLAUDE.md content.
 */
export function ensureImportBlock(claudeMd: string, target: string): string {
  // Rule 1: managed block already present → replace in-place
  if (hasBlock(claudeMd)) {
    return replaceBlock(claudeMd, target);
  }

  // Rule 2: bare @<target> line exists outside markers → no-op
  if (hasBareImport(claudeMd, target)) {
    return claudeMd;
  }

  // Rule 3: nothing → append block
  return appendBlock(claudeMd, target);
}
