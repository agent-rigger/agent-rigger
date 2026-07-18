/**
 * Security-scan seam for agent-rigger.
 *
 * The engine calls a Scanner BEFORE installing a skill / MCP source. M0 ships a
 * stub that always passes; the real implementation (Trivy / Gitleaks / Cisco
 * Skill Scanner / static regex) replaces `stubScanner` only — nothing else in
 * the engine changes. This is the single extension point for the security
 * milestone.
 */

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
