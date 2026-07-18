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
 * The problem this once solved on the remote-install/update path: two scan call
 * sites see the same fetched content — the pre-apply gate (scanEntries) and the
 * adapter's apply-time re-check (one scan per link write-op, defense in depth) —
 * both resolving to the SAME checkout path per artifact. Sharing one raw Scanner
 * across both would spawn the underlying tool (gitleaks/trivy) twice per
 * artifact; memoizing on the resolved path collapsed that to one run — the gate's
 * scan populating the cache, the apply-time re-check hitting it.
 *
 * That is NO LONGER how the remote-install/update path holds a constant spawn
 * count. It now scans the whole selection as a single union and threads a
 * constant union verdict to the apply-time re-check (see `constantScanner` and
 * `design.md § Le seam de couplage`), so per-path cache hits no longer carry
 * that path. `memoizeScanner` is kept as the public API for any caller that
 * scans the same resolved path more than once; its behaviour below is unchanged.
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

/**
 * A Scanner that ignores its argument and always resolves the same `verdict`.
 *
 * Threaded to the apply-time re-check (buildAdapter → applySkill) once the gate
 * has scanned the whole selection as one union (scanEntries over a staging
 * mirror). Why handing back a constant verdict there is sound, not a hole:
 *
 * - Under `!force`, the gate scans the union FIRST. If that union verdict is
 *   blocking, `scanEntries` throws before a single apply runs — no write reaches
 *   an adapter, so the re-check is never consulted for a blocked selection.
 * - If the union verdict is ok (or degraded), every apply-time re-check must
 *   pass, because the union is a superset of every source that can be applied:
 *   each staged artefact was materialised into the mirror the gate scanned. That
 *   superset is structural, not hoped-for — `scanPathFor` is exhaustive
 *   (`assertNever`, ADR-0022 §4), so a new artefact nature that materialises
 *   content breaks the build until it joins the union. No apply-time source can
 *   silently escape what the gate already covered.
 *
 * Returning the union verdict for any source is therefore exact, at zero
 * re-spawn — the point of the change, since R1 counts the gate AND the apply.
 * See `design.md § Le seam de couplage`.
 *
 * Honest scope: this Scanner is sound ONLY behind an all-or-nothing gate that
 * has already scanned a superset of every source it will be asked about. It is
 * NOT a general-purpose scanner — used loosely it would pass content nobody
 * scanned. Pure and stateless; `scan` never rejects.
 */
export function constantScanner(verdict: Verdict): Scanner {
  return {
    scan(_source: string): Promise<Verdict> {
      return Promise.resolve(verdict);
    },
  };
}
