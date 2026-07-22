/**
 * The edge-integrity scanner (R7, S6) — assistant-agnostic, read-only.
 * Walks the persisted `requires` graph (R5/R6) for drift the CLI remove gate
 * never surfaces (it only ever looks BACKWARD, from a candidate removal to
 * its dependents, and only at the moment of THAT removal) plus a graph-shape
 * backfill concern, and (U1) the lib channel's own on-disk companion file:
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
 * - `lib-imports-missing` (U1, lib-imports-alias): at least one `lib` entry
 *   is installed but the home-managed `package.json` `#libs/*` mapping
 *   (`apply()`'s guarantee, `home-package-json.ts`) is absent, wrong, OR the
 *   file is unreadable (malformed JSON) — a plain existence+shape check via
 *   `ctx.env`, the same posture `manifest-audit.ts`'s `missing-file` check
 *   already takes (a manifest-audit scanner reading real disk truth via
 *   `stat` is not new; this is the analogous read for the lib channel's
 *   companion file). REVIEW FIX: `readJson` throwing `InvalidJsonError` on a
 *   malformed file is caught HERE, never left to propagate — this scanner's
 *   own contract (never refuses, report-only) means it must NEVER throw;
 *   letting `InvalidJsonError` escape would abort `diagnose()` for the WHOLE
 *   run, losing every finding this scanner (and every scanner after it)
 *   would otherwise have produced. An unreadable file plainly carries no
 *   valid mapping, so it degrades to the exact same finding as "absent".
 *
 * Never refuses anything and never carries a `repair`, and NEVER throws: the
 * refusal gate lives in `cmd-remove`'s R6 check, not here — this scanner only
 * reports (design.md §"Surfaces de cycle de vie", R7).
 */

import { InvalidJsonError, readJson } from '../../fs-json';
import { hasLibsImportMapping } from '../../home-package-json';
import { readManifest, requiresIndex } from '../../manifest';
import { homePackageJsonPath } from '../../paths';
import {
  manifestBrokenEdge,
  manifestLibImportsMissing,
  manifestNoEdges,
  manifestOrphanLib,
} from '../finding';
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
  const requiredIds = new Set(requiresIndex(manifest.artifacts).keys());

  let hasLibEntry = false;

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

    if (entry.nature === 'lib') {
      hasLibEntry = true;
      if (!requiredIds.has(entry.id)) {
        findings.push(manifestOrphanLib({ entryId: entry.id, scope: entry.scope }));
      }
    }

    if (entry.requires === undefined) {
      findings.push(
        manifestNoEdges({ entryId: entry.id, nature: entry.nature, scope: entry.scope }),
      );
    }
  }

  // U1: only ever read the home package.json when the manifest actually names
  // a lib — a lib-free install has nothing to guarantee, so this check never
  // runs (and never touches disk) for it.
  if (hasLibEntry) {
    const packageJsonPath = homePackageJsonPath(ctx.env);
    // A malformed file (readJson throws InvalidJsonError) carries no valid
    // mapping either — caught here so it degrades to the same finding
    // instead of aborting diagnose() for the whole run (this scanner is
    // report-only and must never throw).
    let pkg: Record<string, unknown>;
    try {
      pkg = await readJson(packageJsonPath);
    } catch (err) {
      if (!(err instanceof InvalidJsonError)) throw err;
      pkg = {};
    }
    if (!hasLibsImportMapping(pkg)) {
      findings.push(manifestLibImportsMissing({ packageJsonPath }));
    }
  }

  return findings;
};
