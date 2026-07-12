/**
 * lot6-r4-qualify-seam.test.ts — R4: the CLI has a single qualification seam.
 *
 * `packages/catalog/src/qualify.ts` exposes `qualifyRef` (forward) and
 * `localId` (inverse). No site under `packages/cli/src` SHALL reimplement
 * either heuristic inline — every forward/inverse site imports the couture.
 *
 * TDD: written before the CLI sites are switched to the couture (RED → GREEN).
 * At RED time, this structural test fails against the *current* sources —
 * 4 forward sites (cli.ts ×2, governance.ts, remote-install.ts) and 6 inverse
 * sites (adapter-builder.ts, opencode-adapter-builder.ts, remote-install.ts,
 * cmd-update.ts, cmd-remove.ts's isPackId, cli.ts) still reimplement it.
 *
 * Structural patterns (precise, to avoid false positives):
 *  - FORWARD: `<x>.includes('/')` guarding a `` `${a}/${b}` `` prefix template
 *    in the same statement — the `qualifyRef` reimplementation.
 *  - INVERSE: `const <idx> = <src>.indexOf('/'); … <idx> === -1 ? <src> :
 *    <src>.slice(<idx> + 1)` — the `localId` reimplementation. This does NOT
 *    match the deferred "prefix extraction" sites (`.slice(0, <idx>)`,
 *    5 sites in cli.ts — out of scope, see requirements.md § Hors périmètre),
 *    nor the unrelated git-URL host/repo parsing in cli.ts (which slices both
 *    sides of the boundary, not the `=== -1 ? original : original.slice(+1)`
 *    ternary shape).
 *
 * Coverage:
 *  - Zero forward-heuristic reimplementations in packages/cli/src.
 *  - Zero inverse-heuristic (localId) reimplementations in packages/cli/src.
 *  - No divergent `catalog.sourceName ?? …` fallback remains in cli.ts
 *    (CatalogProposal.sourceName is required — the 3 fallbacks are dead).
 *  - Governance still qualifies meta.required/recommended correctly
 *    (regression — same behavior, now routed through the couture).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'bun:test';

import type { CatalogEntry } from '@agent-rigger/catalog';

import { auditableGovernanceIds } from '../src/governance';
import type { CatalogGovernanceMeta } from '../src/governance';

// ---------------------------------------------------------------------------
// Source walker
// ---------------------------------------------------------------------------

const SRC_DIR = path.resolve(import.meta.dirname, '../src');

/** Recursively collect every `.ts` file under `dir` (no while loop: recursion). */
function collectTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  return entries.flatMap((name) => {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) return collectTsFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

const SRC_FILES = collectTsFiles(SRC_DIR);

// ---------------------------------------------------------------------------
// Structural patterns
// ---------------------------------------------------------------------------

/**
 * Forward heuristic: `.includes('/')` guarding a `${a}/${b}` prefix template
 * within ~60 chars on the same statement — the `qualifyRef` reimplementation
 * (`sourceName !== '' && !id.includes('/') ? \`${sourceName}/${id}\` : id`,
 * or the equivalent `id.includes('/') ? id : \`${source}/${id}\``).
 */
const FORWARD_HEURISTIC_RE = /\.includes\(['"]\/['"]\)[\s\S]{0,60}?`\$\{[^`]+?\}\/\$\{[^`]+?\}`/;

/**
 * Inverse heuristic: `const <idx> = <src>.indexOf('/');` followed (within the
 * same block) by the ternary `<idx> === -1 ? <src> : <src>.slice(<idx> + 1)`
 * — the `localId` reimplementation, regardless of the variable names chosen.
 * Backreferences anchor both halves to the SAME index/source variables so
 * this does not match the unrelated "extract both host and rest" URL parsing,
 * nor the deferred prefix-extraction sites (`.slice(0, <idx>)`).
 */
const INVERSE_HEURISTIC_RE =
  /const\s+(\w+)\s*=\s*(\w+)\.indexOf\(['"]\/['"]\)\s*;[\s\S]{0,80}?\1\s*===\s*-1\s*\?\s*\2\s*:\s*\2\.slice\(\s*\1\s*\+\s*1\s*\)/;

// ---------------------------------------------------------------------------
// Structural tests
// ---------------------------------------------------------------------------

describe('lot6-R4: single qualification seam — no inline reimplementation', () => {
  it('has at least one .ts file to scan (sanity check on the walker)', () => {
    expect(SRC_FILES.length).toBeGreaterThan(10);
  });

  it('zero site reimplements the forward (qualifyRef) heuristic inline', () => {
    const offenders = SRC_FILES.filter((f) => FORWARD_HEURISTIC_RE.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC_DIR, f));

    expect(offenders).toEqual([]);
  });

  it('zero site reimplements the inverse (localId) heuristic inline', () => {
    const offenders = SRC_FILES.filter((f) => INVERSE_HEURISTIC_RE.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC_DIR, f));

    expect(offenders).toEqual([]);
  });

  it('cli.ts carries no divergent catalog.sourceName fallback (?? …)', () => {
    const cliSource = readFileSync(path.join(SRC_DIR, 'cli.ts'), 'utf8');
    expect(/catalog\.sourceName\s*\?\?/.test(cliSource)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Governance qualifies via the couture (regression — same behavior)
// ---------------------------------------------------------------------------

describe('lot6-R4: governance qualifies meta.required/recommended via the couture', () => {
  const EFFECTIVE: CatalogEntry[] = [
    {
      kind: 'artifact',
      id: 'jr/guardrail:main',
      nature: 'guardrail',
      targets: ['claude'],
      scopes: ['user'],
    },
    {
      kind: 'artifact',
      id: 'jr/context:main',
      nature: 'context',
      targets: ['claude'],
      scopes: ['user'],
    },
    // Already-qualified seed referencing a DIFFERENT catalog — present in the
    // effective catalog, but jr may not forge it into its own audit (govid).
    {
      kind: 'artifact',
      id: 'othercat/guardrail:shared',
      nature: 'guardrail',
      targets: ['claude'],
      scopes: ['user'],
    },
  ];

  it('qualifies a bare seed with the source name', () => {
    const meta: Map<string, CatalogGovernanceMeta> = new Map([
      ['jr', { required: ['guardrail:main'], recommended: ['context:main'] }],
    ]);
    const ids = auditableGovernanceIds(EFFECTIVE, meta);
    expect(ids.has('jr/guardrail:main')).toBe(true);
    expect(ids.has('jr/context:main')).toBe(true);
  });

  it("drops an already-qualified cross-catalog seed (govid: a catalog's opinion covers only its own ids)", () => {
    // govid (decision 2026-07-12): a catalog's meta may reference only its OWN
    // ids (bare or self-qualified). jr declaring othercat/guardrail:shared can
    // no longer forge it into jr's governance audit — the lot6 cross-catalog
    // floor capability is retired (partitionMetaIds discards the foreign seed).
    const meta: Map<string, CatalogGovernanceMeta> = new Map([
      ['jr', { required: ['othercat/guardrail:shared'] }],
    ]);
    const ids = auditableGovernanceIds(EFFECTIVE, meta);
    expect(ids.has('othercat/guardrail:shared')).toBe(false);
    // Discarded, never double-prefixed either.
    expect(ids.has('jr/othercat/guardrail:shared')).toBe(false);
  });

  it('keeps a self-qualified own seed unchanged in the audit (never double-prefixed)', () => {
    // The mechanical property the retired cross-catalog assert really protected:
    // a seed jr declares already prefixed by ITS OWN name stays as-is in the
    // auditable set — qualifyRef leaves it intact, so it is never re-prefixed to
    // jr/jr/… (govid, no-double-prefix at the governance site).
    const meta: Map<string, CatalogGovernanceMeta> = new Map([
      ['jr', { required: ['jr/guardrail:main'] }],
    ]);
    const ids = auditableGovernanceIds(EFFECTIVE, meta);
    expect(ids.has('jr/guardrail:main')).toBe(true);
    expect(ids.has('jr/jr/guardrail:main')).toBe(false);
  });
});
