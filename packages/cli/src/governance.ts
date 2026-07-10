/**
 * governance.ts — which guardrail/context entries the global `check` audits.
 *
 * Background: a catalog entry is an OFFER, not an obligation. Auditing every
 * available guardrail/context across all configured catalogs makes `check` exit
 * non-zero the moment a second catalog is added (its guardrails/context show up
 * as "missing" even though the user never opted into them).
 *
 * Middle-ground semantics implemented here — `check` audits a guardrail/context
 * id when it is EITHER:
 *   - DECLARED as part of a catalog's governance baseline: present in that
 *     catalog's `meta.required ∪ meta.recommended`, with pack ids expanded to
 *     their members (restricted to guardrail/context natures); OR
 *   - currently INSTALLED (so drift is still detected for à-la-carte guardrail/
 *     context the user installed without the catalog declaring them).
 *
 * An available-but-undeclared, not-installed guardrail/context is NOT audited.
 */

import type { CatalogEntry } from '@agent-rigger/catalog';
import { qualifyRef } from '@agent-rigger/catalog';

/** The governance-relevant slice of a catalog's `meta` block. */
export interface CatalogGovernanceMeta {
  required?: string[];
  recommended?: string[];
}

/**
 * Compute the set of qualified guardrail/context ids the global `check` should
 * audit, given the effective (merged, qualified) catalog, each source's
 * governance meta, and the ids currently installed for the target scope.
 *
 * Pure and deterministic — no I/O.
 */
export function auditableGovernanceIds(
  effective: CatalogEntry[],
  metaBySource: Map<string, CatalogGovernanceMeta>,
  installedGovernanceIds: Iterable<string> = [],
): Set<string> {
  const packMembers = new Map<string, readonly string[]>();
  const natureById = new Map<string, string>();
  for (const e of effective) {
    if (e.kind === 'pack') {
      packMembers.set(e.id, e.members ?? []);
    } else if (e.kind === 'artifact') {
      natureById.set(e.id, e.nature);
    }
  }

  const result = new Set<string>();
  const addIfGovernance = (id: string): void => {
    const nature = natureById.get(id);
    if (nature === 'guardrail' || nature === 'context') result.add(id);
  };

  // 1. Declared governance: expand required ∪ recommended through packs.
  // Recursive DFS through pack membership (transitive); `seen` guards cycles.
  // No while loop (project convention): recursion + for...of instead of a stack.
  for (const [source, meta] of metaBySource) {
    const seen = new Set<string>();
    const visit = (id: string): void => {
      if (seen.has(id)) return;
      seen.add(id);
      const members = packMembers.get(id);
      if (members === undefined) {
        addIfGovernance(id);
      } else {
        for (const member of members) visit(member);
      }
    };
    for (const seed of [...(meta.required ?? []), ...(meta.recommended ?? [])]) {
      visit(qualifyRef(source, seed));
    }
  }

  // 2. Installed guardrail/context — always audited so drift is caught.
  for (const id of installedGovernanceIds) result.add(id);

  return result;
}
