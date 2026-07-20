/**
 * scan-staging.ts — materialize the exact union of a selection into one root.
 *
 * The pre-apply scan gate needs to point a scanner at a SINGLE path, yet the
 * surface it must cover is the union of every selected artefact plus
 * catalog.json — a set of files and directories scattered across the checkout.
 * `materializeUnion` fabricates that single root by mirroring each target at its
 * exact checkout-relative position inside a fresh staging directory.
 *
 * Why a copy-mirror rather than some other union mechanism: the staging tree
 * reproduces the checkout layout byte-for-byte, so a finding the scanner reports
 * carries the checkout-relative path R7 already expects — `skills/a/SKILL.md`
 * stays `skills/a/SKILL.md`, `catalog.json` stays `catalog.json`, and two
 * offending skills yield two distinct paths — without a single line of path
 * rewriting on the way out. The rel-position (`path.relative(baseDir, target)`)
 * IS the attribution.
 *
 * Why a sibling of the checkout, never under baseDir: an adapter walking the
 * checkout must never stumble onto the mirror, and no phantom `catalog.json`
 * must ever be confused with the real one. Staging next to the checkout — not
 * inside it — keeps the mirror invisible to everything but the scanner.
 *
 * Why `dereference: false`: the in-place scan passes no dereference flag, so the
 * tool's behaviour on symlinks is whatever it defaults to and is not ours to
 * change here. Copying a symlink verbatim (the link, not its resolved bytes)
 * preserves that behaviour AND honours ADR-0022 §3's no-deref posture — host
 * bytes from beyond a link never get pulled across the gate.
 *
 * A copy that fails (target absent, permission) throws: fail-closed, never a
 * silently partial staging. The partial mirror is torn down on the way out so
 * no half-built root is left behind.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { ArtifactEntry } from '@agent-rigger/catalog';

import { scanPathFor } from './scan-paths';

/** Prefix for the sibling staging directory created by the default factory. */
const STAGING_PREFIX = 'rig-scan-staging-';

export interface MaterializeUnionOpts {
  /** Selected entries; those with no checkout path (mcp/tool/claude-only plugin) are ignored. */
  entries: ArtifactEntry[];
  /** Root of the active remote checkout — the source of every mirrored target. */
  baseDir: string;
  /**
   * Overrides staging-dir creation (tests). Must return an existing, empty
   * directory OUTSIDE baseDir. Defaults to `fs.mkdtemp` sibling of the checkout.
   */
  tmpFactory?: () => Promise<string>;
}

export interface UnionStaging {
  /** The single root the scan gate points at — the mirrored union. */
  stagingDir: string;
  /** Best-effort, idempotent teardown of the staging dir (safe to call twice). */
  cleanup: () => Promise<void>;
}

/**
 * Mirror `catalog.json` (always) plus every selected entry's checkout path into
 * a fresh staging root, each at its exact checkout-relative position.
 *
 * @throws if a resolved target escapes the checkout root (traversal guard, no
 * staging created yet), or if any target cannot be copied (missing source,
 * permission) — the partial staging is removed before the error propagates.
 */
export async function materializeUnion(opts: MaterializeUnionOpts): Promise<UnionStaging> {
  const { entries, baseDir, tmpFactory } = opts;

  // catalog.json is unconditional and always first; the rest are the selection's
  // scan paths, deduplicated on their absolute path (equivalent to a rel-path
  // dedup since baseDir is constant) — many hooks → one hooks/, many plugins →
  // one plugins/, the same mutualisation scanEntries applies via seenPaths.
  // Each surviving target is resolved to its checkout-relative position AND
  // guarded against escaping baseDir before any staging dir or copy exists:
  // catalogue ids are not validated upstream and a `../` in an id is a
  // pre-existing traversal vector (scanPathFor path.joins the raw name), so a
  // target landing outside the checkout would mirror host bytes to an
  // attacker-chosen position — fail closed here by contract.
  const seen = new Set<string>();
  const mirror: { target: string; rel: string }[] = [];
  const enqueue = (target: string): void => {
    if (seen.has(target)) return;
    seen.add(target);
    const rel = path.relative(baseDir, target);
    if (path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep)) {
      throw new Error(
        `scan staging: target '${target}' escapes the checkout root '${baseDir}' `
          + `(rel='${rel}') — refusing to mirror`,
      );
    }
    mirror.push({ target, rel });
  };
  enqueue(path.join(baseDir, 'catalog.json'));
  for (const entry of entries) {
    // scanPathFor returns [] for mcp/tool/claude-only plugin (no checkout of
    // their own) and one path per checkout surface otherwise (R2/R9 — a future
    // multi-target layout may enqueue more than one per entry).
    for (const scanPath of scanPathFor(entry, baseDir)) {
      enqueue(scanPath);
    }
  }

  const stagingDir = tmpFactory
    ? await tmpFactory()
    : await fs.mkdtemp(path.join(path.dirname(baseDir), STAGING_PREFIX));

  const cleanup = (): Promise<void> => fs.rm(stagingDir, { recursive: true, force: true });

  try {
    for (const { target, rel } of mirror) {
      const dest = path.join(stagingDir, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.cp(target, dest, { recursive: true, dereference: false });
    }
  } catch (err) {
    await cleanup().catch(() => {});
    throw err;
  }

  return { stagingDir, cleanup };
}
