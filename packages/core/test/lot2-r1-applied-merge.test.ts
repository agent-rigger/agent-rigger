/**
 * Unit tests for R1 — mergeApplied / mergeFiles (core/src/applied-merge.ts).
 *
 * Requirement (docs/specs/lot2-remove-reversible/requirements.md, R1):
 *   The manifest SHALL record, for a re-installed entry, the STRUCTURED MERGE
 *   of the pre-existing `applied` payload and the delta of the run — per
 *   payload kind, within the (id, scope, assistant) identity.
 *
 * Design (design.md, D1): pure module, no I/O. Per-kind semantics:
 *   - guardrail            → dedup union of denyRules/allowRules (mergeDeny)
 *   - opencode-permission  → per-leaf union (mergePermission)
 *   - hook / link / opencode-mcp → replacement (the plan carries the complete
 *     payload by construction; hook migration is D8/T4)
 *   - context              → block replaced; `previous` preservation (R6/D5)
 *     is covered in r6-context-previous.test.ts
 * ManifestEntry.files gets the same stable-order dedup union (mergeFiles).
 */

import { describe, expect, it } from 'bun:test';

import { mergeApplied, mergeFiles } from '../src/applied-merge';
import type {
  AppliedContext,
  AppliedGuardrail,
  AppliedHook,
  AppliedLink,
  AppliedOpencodeMcp,
  AppliedOpencodePermission,
} from '../src/types';

// ---------------------------------------------------------------------------
// guardrail — dedup union, stable order
// ---------------------------------------------------------------------------

describe('lot2-R1: mergeApplied guardrail', () => {
  it('lot2-R1: unions denyRules and allowRules, dedup, previous order preserved and new rules appended', () => {
    const previous: AppliedGuardrail = {
      kind: 'guardrail',
      denyRules: ['Bash(rm -rf *)', 'Bash(curl *)'],
      allowRules: ['Bash(git status:*)'],
    };
    const next: AppliedGuardrail = {
      kind: 'guardrail',
      denyRules: ['Bash(curl *)', 'Bash(wget *)'],
      allowRules: ['Bash(git status:*)', 'Bash(git log:*)'],
    };

    expect(mergeApplied(previous, next)).toEqual({
      kind: 'guardrail',
      denyRules: ['Bash(rm -rf *)', 'Bash(curl *)', 'Bash(wget *)'],
      allowRules: ['Bash(git status:*)', 'Bash(git log:*)'],
    });
  });

  it('lot2-R1: a repair delta (subset of previous) leaves the cumulative payload unchanged', () => {
    const previous: AppliedGuardrail = {
      kind: 'guardrail',
      denyRules: ['Bash(rm -rf *)', 'Bash(curl *)'],
      allowRules: [],
    };
    // Repair run: the user had deleted one rule, the plan re-adds only it.
    const next: AppliedGuardrail = {
      kind: 'guardrail',
      denyRules: ['Bash(rm -rf *)'],
      allowRules: [],
    };

    expect(mergeApplied(previous, next)).toEqual(previous);
  });

  it('lot2-R1: does not mutate its inputs', () => {
    const previous: AppliedGuardrail = {
      kind: 'guardrail',
      denyRules: ['Bash(rm -rf *)'],
      allowRules: ['Bash(git status:*)'],
    };
    const next: AppliedGuardrail = {
      kind: 'guardrail',
      denyRules: ['Bash(curl *)'],
      allowRules: [],
    };
    const previousSnapshot = structuredClone(previous);
    const nextSnapshot = structuredClone(next);

    mergeApplied(previous, next);

    expect(previous).toEqual(previousSnapshot);
    expect(next).toEqual(nextSnapshot);
  });
});

// ---------------------------------------------------------------------------
// opencode-permission — per-leaf union
// ---------------------------------------------------------------------------

describe('lot2-R1: mergeApplied opencode-permission', () => {
  it('lot2-R1: unions permission fragments per leaf', () => {
    const previous: AppliedOpencodePermission = {
      kind: 'opencode-permission',
      permission: { bash: { 'rm -rf *': 'deny' } },
    };
    const next: AppliedOpencodePermission = {
      kind: 'opencode-permission',
      permission: { webfetch: 'ask' },
    };

    expect(mergeApplied(previous, next)).toEqual({
      kind: 'opencode-permission',
      permission: { bash: { 'rm -rf *': 'deny' }, webfetch: 'ask' },
    });
  });

  it('lot2-R1: an already-recorded leaf keeps its previous state (merge is additive, never destructive)', () => {
    // Mirrors the on-disk merge (mergePermission): an existing leaf is never
    // overwritten, so the recorded trace must not drift from what is on disk.
    const previous: AppliedOpencodePermission = {
      kind: 'opencode-permission',
      permission: { bash: { 'rm -rf *': 'deny' } },
    };
    const next: AppliedOpencodePermission = {
      kind: 'opencode-permission',
      permission: { bash: { 'rm -rf *': 'ask', 'curl *': 'deny' } },
    };

    expect(mergeApplied(previous, next)).toEqual({
      kind: 'opencode-permission',
      permission: { bash: { 'rm -rf *': 'deny', 'curl *': 'deny' } },
    });
  });

  it('lot2-R1: does not mutate nested permission objects', () => {
    const previous: AppliedOpencodePermission = {
      kind: 'opencode-permission',
      permission: { bash: { 'rm -rf *': 'deny' } },
    };
    const next: AppliedOpencodePermission = {
      kind: 'opencode-permission',
      permission: { webfetch: 'ask' },
    };
    const previousSnapshot = structuredClone(previous);
    const nextSnapshot = structuredClone(next);

    mergeApplied(previous, next);

    expect(previous).toEqual(previousSnapshot);
    expect(next).toEqual(nextSnapshot);
  });
});

// ---------------------------------------------------------------------------
// hook / link / opencode-mcp / context — replacement
// ---------------------------------------------------------------------------

describe('lot2-R1: mergeApplied replacement kinds', () => {
  it('lot2-R1: hook payload is replaced by the last run', () => {
    const previous: AppliedHook = {
      kind: 'hook',
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'bun run guard.ts',
    };
    const next: AppliedHook = {
      kind: 'hook',
      event: 'PreToolUse',
      matcher: 'Bash(*)',
      command: 'bun run guard.ts',
      timeout: 30,
    };

    expect(mergeApplied(previous, next)).toEqual(next);
  });

  it('lot2-R1: link payload is replaced by the last run', () => {
    const previous: AppliedLink = { kind: 'link', files: ['/old/target', '/old/store'] };
    const next: AppliedLink = { kind: 'link', files: ['/new/target', '/new/store'] };

    expect(mergeApplied(previous, next)).toEqual(next);
  });

  it('lot2-R1: opencode-mcp payload is replaced by the last run', () => {
    const previous: AppliedOpencodeMcp = {
      kind: 'opencode-mcp',
      server: 'context7',
      config: { type: 'remote', url: 'https://old.example' },
    };
    const next: AppliedOpencodeMcp = {
      kind: 'opencode-mcp',
      server: 'context7',
      config: { type: 'remote', url: 'https://new.example' },
    };

    expect(mergeApplied(previous, next)).toEqual(next);
  });

  it('lot2-R1: context block is replaced by the last run (previous preservation: r6-context-previous)', () => {
    const previous: AppliedContext = { kind: 'context', block: 'old content\n' };
    const next: AppliedContext = { kind: 'context', block: 'new content\n' };

    expect(mergeApplied(previous, next)).toEqual(next);
  });
});

// ---------------------------------------------------------------------------
// edges — absent sides, kind mismatch
// ---------------------------------------------------------------------------

describe('lot2-R1: mergeApplied edges', () => {
  it('lot2-R1: first install (no previous) returns the run payload as-is', () => {
    const next: AppliedGuardrail = {
      kind: 'guardrail',
      denyRules: ['Bash(rm -rf *)'],
      allowRules: [],
    };

    expect(mergeApplied(undefined, next)).toEqual(next);
  });

  it('lot2-R1: a run with no recognisable payload preserves the previous trace', () => {
    const previous: AppliedGuardrail = {
      kind: 'guardrail',
      denyRules: ['Bash(rm -rf *)'],
      allowRules: [],
    };

    expect(mergeApplied(previous, undefined)).toEqual(previous);
  });

  it('lot2-R1: both sides absent → undefined', () => {
    expect(mergeApplied(undefined, undefined)).toBeUndefined();
  });

  it('lot2-R1: kind mismatch → the last run replaces the previous payload', () => {
    const previous: AppliedGuardrail = {
      kind: 'guardrail',
      denyRules: ['Bash(rm -rf *)'],
      allowRules: [],
    };
    const next: AppliedLink = { kind: 'link', files: ['/target', '/store'] };

    expect(mergeApplied(previous, next)).toEqual(next);
  });
});

// ---------------------------------------------------------------------------
// mergeFiles — ManifestEntry.files union
// ---------------------------------------------------------------------------

describe('lot2-R1: mergeFiles', () => {
  it('lot2-R1: unions file lists, dedup, previous order preserved and new paths appended', () => {
    expect(mergeFiles(['/a/settings.json', '/b/store'], ['/b/store', '/c/target'])).toEqual([
      '/a/settings.json',
      '/b/store',
      '/c/target',
    ]);
  });

  it('lot2-R1: identical lists stay unchanged (idempotent re-install)', () => {
    expect(mergeFiles(['/a/settings.json'], ['/a/settings.json'])).toEqual(['/a/settings.json']);
  });

  it('lot2-R1: duplicates within the run delta are collapsed', () => {
    expect(mergeFiles([], ['/a', '/a', '/b'])).toEqual(['/a', '/b']);
  });
});
