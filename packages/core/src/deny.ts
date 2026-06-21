/**
 * Deny-merge logic for agent-rigger (R4 guardrail).
 *
 * Pure functions — no I/O, no filesystem access.
 * Consumers (adapters/claude/guardrails.ts) call these to compute what to
 * write into settings.json; the actual read/write is the adapter's concern.
 *
 * Design invariants (design.md §4 — settings.json merge deny):
 * - Concatenate + deduplicate; nothing else is touched.
 * - current is always preserved intact at the head of the result.
 * - Comparison is strict string equality (case-sensitive, character-exact).
 * - Both functions are idempotent: applying twice yields the same result.
 */

/**
 * Returns the subset of `ref` rules that are **absent** from `current`.
 *
 * - Output order follows `ref` order.
 * - Duplicate entries within `ref` are collapsed: only the first occurrence
 *   is kept (subsequent identical strings are dropped).
 * - An empty `ref` always returns `[]`.
 * - An empty `current` returns `ref` deduplicated.
 *
 * @param ref     - The canonical set of rules (e.g. from artifacts/claude/deny.json).
 * @param current - The rules already present in the target settings.json.
 */
export function computeMissingDeny(ref: string[], current: string[]): string[] {
  const currentSet = new Set(current);
  const seen = new Set<string>();
  const missing: string[] = [];

  for (const rule of ref) {
    if (seen.has(rule)) {
      // Duplicate within ref — skip
      continue;
    }
    seen.add(rule);

    if (!currentSet.has(rule)) {
      missing.push(rule);
    }
  }

  return missing;
}

/**
 * Merges `ref` rules into `current`, preserving `current` intact at the head.
 *
 * Result = `current` ++ `computeMissingDeny(ref, current)`.
 *
 * Properties:
 * - `current` is never modified or reordered.
 * - Rules already present in `current` are not duplicated even if they appear
 *   in `ref`.
 * - Rules in `ref` that are not yet in `current` are appended in `ref` order,
 *   deduped.
 * - Idempotent: `mergeDeny(mergeDeny(x, ref), ref) === mergeDeny(x, ref)`.
 *
 * @param current - Existing deny rules (read from settings.json).
 * @param ref     - Canonical set of deny rules to ensure are present.
 */
export function mergeDeny(current: string[], ref: string[]): string[] {
  return [...current, ...computeMissingDeny(ref, current)];
}
