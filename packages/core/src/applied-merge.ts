/**
 * Merge logic for ManifestEntry `applied` payloads across install runs (R1).
 *
 * Pure functions — no I/O, no filesystem access (mirrors deny.ts).
 *
 * Why: a re-install (drift repair, catalog update) plans only the DELTA of
 * missing rules, so the payload extracted from that run's ops is partial.
 * Recording it as-is would truncate the manifest trace to the last delta and
 * orphan the rules of earlier runs at remove time (an orphaned
 * permissions.allow rule permanently disables Claude Code's approval prompt).
 * The engine therefore merges the run payload into the pre-existing `applied`
 * of the same (id, scope, assistant) identity BEFORE upserting the entry —
 * upsertEntry itself stays a kind-agnostic replacement (design D1).
 *
 * Per-kind semantics:
 * - guardrail            → dedup union of denyRules/allowRules (mergeDeny),
 *                          stable order: previous first, new rules appended.
 * - opencode-permission  → per-leaf union (mergePermission): a leaf already
 *                          recorded keeps its previous state, matching the
 *                          additive on-disk merge that never overwrites.
 * - context              → `block` replaced (the plan carries the complete
 *                          content), `previous` PRESERVED from the first
 *                          install (R6/D5): the restore baseline never drifts
 *                          to an intermediate post-install state.
 * - hook / link / opencode-mcp → replacement: their plan carries the complete
 *                          payload by construction, so the last run IS the
 *                          full trace (hook migration is design D8).
 * - kind mismatch        → replacement (the artifact changed shape; the old
 *                          trace no longer describes what is on disk).
 */

import { mergeDeny } from './deny';
import { mergePermission } from './opencode-json';
import type { AppliedPayload } from './types';

/**
 * Merge the pre-existing `applied` payload of a manifest entry with the
 * payload extracted from the current run's ops.
 *
 * - `previous` undefined (first install, or legacy entry without payload)
 *   → the run payload as-is.
 * - `next` undefined (the run produced no recognisable payload)
 *   → the previous trace is preserved, never silently dropped.
 * - Same kind → per-kind fusion (see module doc).
 * - Different kinds → `next` replaces `previous`.
 *
 * Pure / immutable: inputs are never mutated.
 */
export function mergeApplied(
  previous: AppliedPayload | undefined,
  next: AppliedPayload | undefined,
): AppliedPayload | undefined {
  if (next === undefined) {
    return previous;
  }
  if (previous === undefined || previous.kind !== next.kind) {
    return next;
  }

  if (previous.kind === 'guardrail' && next.kind === 'guardrail') {
    return {
      kind: 'guardrail',
      denyRules: mergeDeny(previous.denyRules, next.denyRules),
      allowRules: mergeDeny(previous.allowRules, next.allowRules),
    };
  }

  if (previous.kind === 'opencode-permission' && next.kind === 'opencode-permission') {
    return {
      kind: 'opencode-permission',
      permission: mergePermission(previous.permission, next.permission),
    };
  }

  if (previous.kind === 'context' && next.kind === 'context') {
    // R6: the restore baseline is the FIRST install's `previous` — a
    // re-install captures the post-install disk state as its own `previous`,
    // which must never displace the true pre-install content. A legacy
    // payload without `previous` carries the absence forward (never adopt
    // next's post-install capture as a baseline).
    return {
      kind: 'context',
      block: next.block,
      ...(previous.previous === undefined ? {} : { previous: previous.previous }),
    };
  }

  // hook / link / opencode-mcp: the plan carries the complete payload by
  // construction → the last run replaces the previous trace.
  return next;
}

/**
 * Union of ManifestEntry.files across install runs: previous paths preserved
 * in order, new paths appended, duplicates collapsed. Same seam as
 * mergeApplied (R1 checklist) — a settings.json touched by every run must
 * appear exactly once, and a path written by an earlier run must survive a
 * partial re-install.
 *
 * Delegates to mergeDeny: its contract (stable-order dedup union of string
 * arrays) is exactly the semantics needed here.
 */
export function mergeFiles(previous: string[], next: string[]): string[] {
  return mergeDeny(previous, next);
}
