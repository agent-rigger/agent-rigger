/**
 * Security-scan seam for agent-rigger.
 *
 * The engine calls a Scanner BEFORE installing a skill / MCP source. M0 ships a
 * stub that always passes; the real implementation (Trivy / Gitleaks / Cisco
 * Skill Scanner / static regex) replaces `stubScanner` only — nothing else in
 * the engine changes. This is the single extension point for the security
 * milestone.
 */

import path from 'node:path';

import type { Verdict } from './types';

/**
 * A security scanner: inspects an artifact source and returns a verdict.
 * `source` is the path (or locator) of the skill/MCP about to be installed.
 * Async by design — real scanners spawn external tools.
 */
export interface Scanner {
  scan(source: string): Promise<Verdict>;
}

/**
 * M0 stub scanner: passes everything (`{ ok: true }`).
 * Replaced by a real scanner at the security milestone.
 */
export const stubScanner: Scanner = {
  scan(_source: string): Promise<Verdict> {
    return Promise.resolve({ ok: true });
  },
};

/**
 * Wraps `inner` with a per-process, per-resolved-path cache of its Verdict.
 *
 * Two independent security-scan call sites exist for the same fetched content:
 * the pre-apply gate (scanEntries, over the whole selection) and the adapter's
 * apply-time re-check (one scan per link write-op, defense in depth). Both
 * resolve to the SAME checkout path for a given artifact. Without memoization,
 * sharing one Scanner instance across both call sites would spawn the
 * underlying tool (gitleaks/trivy) twice per artifact. `memoizeScanner` makes
 * that safe: `inner.scan` runs at most once per distinct resolved path: the
 * gate's scan populates the cache, and the apply-time re-check hits it.
 *
 * Cache key is `path.resolve(source)` so that equivalent-but-differently-
 * spelled paths (relative segments, `..`, trailing separators) collapse to the
 * same entry. Not bounded/evicted — scoped to a single CLI invocation.
 */
export function memoizeScanner(inner: Scanner): Scanner {
  const cache = new Map<string, Promise<Verdict>>();

  return {
    scan(source: string): Promise<Verdict> {
      const key = path.resolve(source);
      const cached = cache.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const pending = inner.scan(source);
      cache.set(key, pending);
      return pending;
    },
  };
}
