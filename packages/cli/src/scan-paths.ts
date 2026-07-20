/**
 * scan-paths.ts — catalogue-layout knowledge: derive the filesystem path(s) to
 * scan inside a checkout for a given artefact.
 *
 * Extracted from remote-install.ts to break the mutual import cycle it formed
 * with scan-staging.ts (remote-install ← materializeUnion, scan-staging ←
 * scanPathFor). This module knows only how a nature maps to its checkout
 * surface; it imports nothing from the install pipeline, so both remote-install
 * and scan-staging can depend on it without a cycle.
 */

import path from 'node:path';

import { type ArtifactEntry, localId } from '@agent-rigger/catalog';
import { assertNever } from '@agent-rigger/core/assert-never';

/**
 * Exhaustive over Nature (9 members, packages/core/src/types.ts): the `default`
 * branch calls assertNever so that a 10th nature materialising checkout content
 * fails the BUILD instead of silently returning `[]` (which would exempt it
 * from every scan except the unconditional catalog.json one).
 *
 * Returns every checkout-relative path this entry's nature can materialise —
 * `[]` for natures with no checkout surface of their own (mcp, tool, a
 * claude-only plugin), never `null`: `materializeUnion` iterates the result
 * unconditionally (R2/R9 — a future multi-target layout returns more than one
 * path; every case today still returns 0 or 1).
 */
export function scanPathFor(entry: ArtifactEntry, baseDir: string): string[] {
  const local = localId(entry.id);
  switch (entry.nature) {
    case 'skill': {
      const name = local.replace(/^skill:/, '');
      return [path.join(baseDir, 'skills', name)];
    }
    case 'agent': {
      const name = local.replace(/^agent:/, '');
      return [path.join(baseDir, 'agents', name + '.md')];
    }
    case 'guardrail': {
      // The whole guardrail dir is scanned: deny.json/allow.json (claude) or
      // permission.json (opencode) all live under guardrails/<name>/.
      const name = local.replace(/^guardrail:/, '');
      return [path.join(baseDir, 'guardrails', name)];
    }
    case 'context': {
      // A context artifact is a single AGENTS.md file fetched from the checkout
      // and injected verbatim into the assistant's system content — same risk
      // class as a skill/agent file, so it is scanned like one.
      const name = local.replace(/^context:/, '');
      return [path.join(baseDir, 'contexts', name, 'AGENTS.md')];
    }
    case 'hook':
      // The entire hooks/ directory is scanned so that guard scripts AND shared
      // libs (e.g. _shared/hook-lib.ts) are covered by the composite scanner.
      return [path.join(baseDir, 'hooks')];
    case 'plugin':
      // An opencode plugin is a native JS/TS module shipped in the checkout's
      // plugins/ directory and copied verbatim into pluginDir (ADR-0020 §4,
      // R8.2) — executable code loaded by opencode at runtime, scanned like
      // hooks (whole directory, so sibling modules are covered too — H13).
      // Claude-only plugins are delegate-installed via `claude plugin install`
      // from the marketplace URL (ADR-0003): no module in the checkout → [].
      return entry.targets.includes('opencode') ? [path.join(baseDir, 'plugins')] : [];
    case 'mcp':
      // Inline server config in catalog.json (secrets can live in config.env) —
      // not a checkout of its own. Covered by the unconditional catalog.json
      // scan in scanEntries instead.
      return [];
    case 'tool':
      // Advisory check/install command strings live in catalog.json — not a
      // checkout of their own. Covered by the unconditional catalog.json scan
      // in scanEntries instead.
      return [];
    case 'lib': {
      // A lib (T1, R1/R2) has no legacy layout to fall back to — introduced by
      // this change with a single, direct checkout position (no per-assistant
      // split; a lib targets no assistant, S3). This IS the source the R3
      // engine materialiser reads from (pin: source === scanPathFor('lib')[0]).
      const name = local.replace(/^lib:/, '');
      return [path.join(baseDir, 'common', 'libs', name)];
    }
    default:
      return assertNever(entry.nature);
  }
}
