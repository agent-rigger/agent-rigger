/**
 * lot6-r2-update-sha.test.ts — R2: `isUpdateAvailable` compares the installed
 * commit sha, not just the ref name (design D2).
 *
 * TDD: written before the implementation (RED → GREEN).
 *
 * `isUpdateAvailable` gains a mandatory `installedSha` parameter, inserted
 * between `installedRef` and `remote`. All 3 call sites (cli.ts:832 — status
 * picker, cli.ts:2380 — check's stale list, cmd-update.ts:231) already carry
 * `entry.sha` on the manifest entry they read from (ManifestEntry.sha,
 * core/types.ts:203) — the data existed, the comparison did not.
 *
 * Rule (D2): when `installedSha` is known (non-empty), it is authoritative —
 * it primes over the ref/semver comparison, in BOTH directions:
 *   - differs from `remote.sha` → stale, even under an unchanged ref name
 *     (a re-pushed tag: same name, different commit — a ref-only comparison
 *     reads compareSemver == 0 and would never see this).
 *   - equals `remote.sha`       → NOT stale, even under a changed ref name
 *     (the remote lost its tags and fell back to HEAD, which happens to be
 *     the exact commit already installed — nothing actually changed; the
 *     symmetric case, a renamed ref over identical content, is not an
 *     update either).
 * `installedSha === ''` marks a legacy manifest entry recorded before sha
 * tracking existed — the sha comparison is skipped entirely and this
 * degrades to the pre-R2 ref/semver comparison. Documented, not "fixed": a
 * same-name re-push stays invisible for these entries, exactly as before R2.
 *
 * Coverage:
 *  - Tag re-pushed: same ref name, different sha → stale.
 *  - No more perpetual false update: installed via tag, remote lost its
 *    tags (HEAD fallback), HEAD equals the installed sha → not stale.
 *  - Nominal semver bump preserved (v1.2.3 → v1.3.0, real different commit).
 *  - Identical content under a renamed ref → not an update (symmetric case).
 *  - Legacy entry without a recorded sha (installedSha === '') degrades to
 *    the existing ref/semver comparison.
 */

import { describe, expect, it } from 'bun:test';

import { isUpdateAvailable } from './fetch';
import type { ResolvedVersion } from './fetch';

const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SHA_C = 'cccccccccccccccccccccccccccccccccccccccc';

// ---------------------------------------------------------------------------
// Tag re-pushed — same ref, different sha → stale
// ---------------------------------------------------------------------------

describe('lot6-R2: tag re-pushed — same ref, different sha → stale', () => {
  it('flags stale when installedSha differs from remote.sha under an unchanged tag name', () => {
    const remote: ResolvedVersion = { ref: 'v1.2.3', sha: SHA_B, isTag: true };
    expect(isUpdateAvailable('v1.2.3', SHA_A, remote)).toBe(true);
  });

  it('a ref-only comparison alone would miss this (same name, compareSemver == 0) — sha primes over it', () => {
    // Same ref name both sides: the pre-R2 comparison would read "equal" and
    // never flag it — the sha comparison overrides that regardless.
    const remote: ResolvedVersion = { ref: 'v1.2.3', sha: SHA_B, isTag: true };
    const installedRef = 'v1.2.3';
    expect(installedRef).toBe(remote.ref); // sanity: names really are identical
    expect(isUpdateAvailable(installedRef, SHA_A, remote)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No more perpetual false update
// ---------------------------------------------------------------------------

describe('lot6-R2: no more perpetual false update — remote lost its tags, HEAD equals the installed sha', () => {
  it('is NOT stale when the HEAD-fallback sha equals the sha installed via a tag', () => {
    // Installed via tag v1.2.3, which pointed at SHA_A. The remote has since
    // lost all its tags; resolveVersion falls back to HEAD, which happens to
    // still be SHA_A (nothing actually changed) — remote.ref becomes the raw
    // sha itself and remote.isTag flips to false.
    const remote: ResolvedVersion = { ref: SHA_A, sha: SHA_A, isTag: false };
    expect(isUpdateAvailable('v1.2.3', SHA_A, remote)).toBe(false);
  });

  it('contrast: the ref/sha string-equality fallback alone (installedSha unknown) WOULD flag this forever', () => {
    // Proves this is the actual bug being closed: a tag name never equals a
    // raw sha, so the old fallback always reported "update available" here.
    // Only reachable when installedSha is unknown (legacy path) — R2 fixes it
    // for every entry whose sha IS recorded.
    const remote: ResolvedVersion = { ref: SHA_A, sha: SHA_A, isTag: false };
    expect(isUpdateAvailable('v1.2.3', '', remote)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Nominal semver bump preserved
// ---------------------------------------------------------------------------

describe('lot6-R2: nominal semver bump preserved', () => {
  it('flags stale for a genuinely newer semver tag (real different commit)', () => {
    const remote: ResolvedVersion = { ref: 'v1.3.0', sha: SHA_C, isTag: true };
    expect(isUpdateAvailable('v1.2.3', SHA_A, remote)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Symmetric case: identical content under a renamed ref is not an update
// ---------------------------------------------------------------------------

describe('lot6-R2: identical content under a renamed ref is not an update (symmetric case)', () => {
  it('is NOT stale when sha matches even though the tag name changed', () => {
    const remote: ResolvedVersion = { ref: 'v2.0.0-renamed', sha: SHA_A, isTag: true };
    expect(isUpdateAvailable('v1.2.3', SHA_A, remote)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Legacy entry without a recorded sha — degrades to the ref/semver comparison
// ---------------------------------------------------------------------------

describe('lot6-R2: legacy entry without a recorded sha degrades to the ref/semver comparison', () => {
  it('installedSha === "" — a semver bump is still detected via the ref-based fallback', () => {
    const remote: ResolvedVersion = { ref: 'v1.1.0', sha: SHA_B, isTag: true };
    expect(isUpdateAvailable('v1.0.0', '', remote)).toBe(true);
  });

  it('installedSha === "" — an unchanged tag name is NOT flagged (documented degraded behaviour: a same-name re-push is invisible for legacy entries)', () => {
    const remote: ResolvedVersion = { ref: 'v1.2.0', sha: SHA_B, isTag: true };
    expect(isUpdateAvailable('v1.2.0', '', remote)).toBe(false);
  });

  it('installedSha === "" on the HEAD-fallback path still falls back to ref/sha string comparison', () => {
    const remote: ResolvedVersion = { ref: SHA_B, sha: SHA_B, isTag: false };
    expect(isUpdateAvailable(SHA_A, '', remote)).toBe(true);
  });
});
