/**
 * finding-path.ts — shared path hardening for the scanner backends.
 *
 * Two host-topology leaks are closed here, both born of the same fact: a scanner
 * reports paths (in findings) and diagnostics (in stderr) that name the host
 * layout, and that layout must never cross the scan gate verbatim.
 *
 *  1. `relativiseFindingPath` — the R7 rebasing idiom, previously duplicated
 *     byte-for-byte between gitleaks.formatFinding and trivy.collectFindings.
 *     A scanner (gitleaks 8.30.1, or a future trivy drift) reports an ABSOLUTE
 *     File/Target under the scanned staging mirror; relativising it against the
 *     scan root yields the exact checkout-relative attribution. A path that
 *     escapes the root — absolute-outside, or an already-relative `../` — is
 *     clamped to `<outside-scan-root>/<basename>`: deterministic, keeps the tool
 *     hint (the basename), leaks no host topology. Same escape predicate as
 *     scan-staging.ts's traversal guard.
 *
 *  2. `sanitizeToolStderr` — a tool error (exit > 1 / != 0) surfaces the raw
 *     stderr, which routinely embeds the scanned directory (the mkdtemp staging
 *     path). Substituting the scanned dir — and its realpath, since macOS
 *     resolves /var → /private/var — with `<scan-root>` keeps the diagnostic
 *     intact while stripping the host path.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Sentinel replacing a finding path that escapes the scan root. */
const OUTSIDE_SCAN_ROOT = '<outside-scan-root>';

/** Sentinel replacing the scanned directory in sanitised tool stderr. */
const SCAN_ROOT_PLACEHOLDER = '<scan-root>';

/**
 * Maps a scanner-reported path to its checkout-relative attribution, clamping
 * anything that escapes `scanRoot` to `<outside-scan-root>/<basename>`.
 *
 * - absolute under the root → `path.relative(scanRoot, rawPath)` (the attribution)
 * - already-relative and clean → passed through unchanged
 * - absolute outside the root, or relative `..`/`../…` → clamped (host path never
 *   surfaces; only the basename is retained as an identifying hint)
 *
 * The clamp is applied to the RESULT of both branches, so a relative path that is
 * itself an escape (`../secrets`) is clamped just like an absolute escape.
 */
export function relativiseFindingPath(rawPath: string, scanRoot: string): string {
  const rel = path.isAbsolute(rawPath) ? path.relative(scanRoot, rawPath) : rawPath;
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep)) {
    return `${OUTSIDE_SCAN_ROOT}/${path.basename(rawPath)}`;
  }
  return rel;
}

/**
 * Strips the scanned directory (and its realpath) from a tool's stderr, replacing
 * every occurrence with `<scan-root>`, then trims. The realpath pass covers the
 * macOS /var → /private/var symlink: the tool may print the resolved form even
 * when we handed it the /var alias.
 *
 * `scanRoot` may no longer exist (unit-test paths, torn-down staging) — the
 * realpath lookup fails closed to the literal substitution.
 */
export function sanitizeToolStderr(stderr: string, scanRoot: string): string {
  const roots = new Set<string>([scanRoot]);
  try {
    roots.add(fs.realpathSync(scanRoot));
  } catch {
    // scanRoot absent (unit-test dir, torn-down staging): literal substitution only.
  }
  let sanitized = stderr;
  // Longest root first: on macOS the mkdtemp alias (/var/…) is a SUBSTRING of its
  // realpath (/private/var/…) — substituting the alias first would leave a
  // malformed '/private<scan-root>' residue when stderr carries the resolved form.
  for (const root of [...roots].sort((a, b) => b.length - a.length)) {
    if (root !== '') sanitized = sanitized.split(root).join(SCAN_ROOT_PLACEHOLDER);
  }
  return sanitized.trim();
}
