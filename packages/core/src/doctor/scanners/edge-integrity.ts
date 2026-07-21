/**
 * The edge-integrity scanner (R7, S6) — assistant-agnostic, read-only,
 * manifest-only. Walks the persisted `requires` graph (R5/R6) for drift the
 * CLI remove gate never surfaces (it only ever looks BACKWARD, from a
 * candidate removal to its dependents, and only at the moment of THAT
 * removal) plus a graph-shape backfill concern:
 *
 * - `broken-edge`: an entry's `requires` names an id no manifest entry
 *   carries any more — a `--force` removal (R6 "--force documenté") broke
 *   the edge earlier; nothing but doctor ever revisits it afterward. Generic
 *   over every nature, mirroring the R6 gate's own genericity (R6 "générique
 *   — pas spécifique lib").
 * - `orphan-lib`: an installed `lib` entry that NO remaining entry requires
 *   — the same-run GC proposal (`computeGcLibs`, cmd-remove.ts) was refused
 *   at its last dependent's removal, or the lib became orphaned some other
 *   way. Lib-specific: only a lib exists purely to be depended upon, so only
 *   a lib can be "orphaned" by losing its last dependent (R7/S9).
 * - `no-edges` (S6): a legacy entry with NO `requires` field at all
 *   (`undefined` — never a present `[]`, which means "resolved, zero deps")
 *   — installed before this change, pending `rigger update`'s backfill.
 *
 * Never refuses anything and never carries a `repair`: the refusal gate
 * lives in `cmd-remove`'s R6 check, not here — this scanner only reports
 * (design.md §"Surfaces de cycle de vie", R7).
 */

import { readManifest } from '../../manifest';
import { manifestBrokenEdge, manifestNoEdges, manifestOrphanLib } from '../finding';
import type { DoctorContext, DoctorScanner, Finding } from '../finding';

export const edgeIntegrityScanner: DoctorScanner = async (
  ctx: DoctorContext,
): Promise<Finding[]> => {
  const manifest = await readManifest(ctx.manifestPath);
  const findings: Finding[] = [];

  // Referent for both edge checks below: which ids still have a surviving
  // manifest entry, and which ids are still named by SOME entry's requires
  // (by bare id, mirroring cmd-remove.ts's computeRefcountBlocks/computeGcLibs
  // — a lib's manifest identity, (id, 'user', 'shared'), is a global
  // singleton, so id-only matching is exact for it; for other natures this is
  // the same by-id posture the R6 gate already takes).
  const installedIds = new Set(manifest.artifacts.map((entry) => entry.id));
  const requiredIds = new Set(manifest.artifacts.flatMap((entry) => entry.requires ?? []));

  for (const entry of manifest.artifacts) {
    for (const ref of entry.requires ?? []) {
      if (!installedIds.has(ref)) {
        findings.push(
          manifestBrokenEdge({
            entryId: entry.id,
            nature: entry.nature,
            scope: entry.scope,
            missingRef: ref,
          }),
        );
      }
    }

    if (entry.nature === 'lib' && !requiredIds.has(entry.id)) {
      findings.push(manifestOrphanLib({ entryId: entry.id, scope: entry.scope }));
    }

    if (entry.requires === undefined) {
      findings.push(
        manifestNoEdges({ entryId: entry.id, nature: entry.nature, scope: entry.scope }),
      );
    }
  }

  return findings;
};
