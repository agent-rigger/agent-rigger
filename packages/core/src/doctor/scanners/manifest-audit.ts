/**
 * The manifest-audit scanner (R2, ADR-0025) — assistant-agnostic, read-only.
 *
 * Audits EVERY manifest entry (unlike `check`, which is driven by the
 * configured catalogs' selection) for the R2 checks that need no
 * assistant/path knowledge at all:
 *
 *   - orphan-catalog: the entry's id is qualified (`<catalog>/<local-id>`)
 *     but its catalog prefix is no longer in `ctx.configuredCatalogIds` —
 *     `catalog remove` made it invisible to `check` without a warning.
 *   - missing-sha: `entry.sha` is empty (historic adoption, S5) — suggests
 *     `update <id>` to re-stamp it. Doctor never runs it.
 *   - missing-file: a path in `entry.files` no longer exists on disk — a
 *     plain existence check (same signal as `manifest.ts`'s `detectDrift`,
 *     re-derived here rather than imported so this scanner stays a pure
 *     read-only enumeration, no engine coupling).
 *
 * Deliberately NOT implemented here: `applied` payload drift against the
 * LIVE host config (the fourth check R2's SHALL clause names). Design.md's
 * own enumeration of this scanner's scope (the "Scanners assistant-
 * agnostiques" bullet) lists only files[]/sha/catalog-prefix — reading the
 * live host config (settings.json hooks, guardrails, mcp descriptors, …) to
 * detect `applied` divergence needs assistant path knowledge, which is
 * exactly the boundary `adapters/shared/doctor-scan.ts` (T3) exists to own.
 * `FindingManifestAppliedDrift` (finding.ts, T1) stays modelled but
 * unconstructed until that scanner lands — flagged for the lead, not a
 * silent scope-narrowing.
 *
 * All entries are audited regardless of assistant/scope — `check`'s
 * catalog-driven selection is exactly the blind spot R2 exists to close.
 *
 * Catalog-prefix extraction is a local one-liner (not
 * `@agent-rigger/catalog`'s `catalogPrefixOf`): core has zero dependencies
 * (see packages/core/package.json) and catalog depends on core, never the
 * reverse — importing it here would invert that direction. Same rule
 * (`<name>/<rest>` split on the first `/`) as `catalogPrefixOf`/`localId`.
 */

import { stat } from 'node:fs/promises';

import { readManifest } from '../../manifest';
import { manifestMissingFile, manifestMissingSha, manifestOrphanCatalog } from '../finding';
import type { DoctorContext, DoctorScanner, Finding } from '../finding';

/**
 * Return the catalog prefix of a manifest entry id (`<catalog>/<local-id>` →
 * `<catalog>`), or `undefined` when the id is unqualified (adopted under
 * defaults, R5 "aucun catalogue → adoption sous defaults").
 */
function catalogPrefixOf(id: string): string | undefined {
  const slashIdx = id.indexOf('/');
  return slashIdx === -1 ? undefined : id.slice(0, slashIdx);
}

/**
 * The R2 scanner. Throws `MalformedManifestError` verbatim when
 * `state.json` is present-but-wrong-shape — `diagnose.ts` (T2) is the layer
 * that intercepts it into the R8 salvage Finding, never this scanner.
 */
export const manifestAuditScanner: DoctorScanner = async (
  ctx: DoctorContext,
): Promise<Finding[]> => {
  const manifest = await readManifest(ctx.manifestPath);
  const findings: Finding[] = [];

  for (const entry of manifest.artifacts) {
    const prefix = catalogPrefixOf(entry.id);
    if (prefix !== undefined && !ctx.configuredCatalogIds.includes(prefix)) {
      findings.push(
        manifestOrphanCatalog({ entryId: entry.id, nature: entry.nature, scope: entry.scope }),
      );
    }

    if (!entry.sha) {
      findings.push(
        manifestMissingSha({ entryId: entry.id, nature: entry.nature, scope: entry.scope }),
      );
    }

    for (const filePath of entry.files) {
      // `stat` (not `Bun.file().exists()`, which is false for directories, nor
      // `lstat`, which reports dangling links as present) accepts files AND
      // directories and follows symlinks: a healthy directory symlink resolves
      // to present, a dangling one fails on the dead target and stays missing.
      let exists: boolean;
      try {
        await stat(filePath);
        exists = true;
      } catch {
        exists = false;
      }
      if (!exists) {
        findings.push(
          manifestMissingFile({
            entryId: entry.id,
            nature: entry.nature,
            scope: entry.scope,
            missingPath: filePath,
          }),
        );
      }
    }
  }

  return findings;
};
