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
