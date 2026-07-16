/**
 * version.ts — resolve the CLI version reported by `agent-rigger --version`.
 *
 * Two sources, in priority order:
 *  1. `__AR_VERSION__` — a build-time define injected by `scripts/build.ts`,
 *     valued `git describe --tags --always --dirty` (leading "v" stripped).
 *     A source build therefore reports a version coherent with the git tags.
 *  2. `package.json` version — the permanent `0.0.0` sentinel in the repo, which
 *     the release workflow stamps in place with the tag before it compiles the
 *     binaries. That build path does NOT inject the define, so the stamped
 *     package version is what the released binary reports.
 *
 * When neither git nor a stamp is available (e.g. `bun run` from a tarball with
 * no `.git`), the define is absent and the sentinel is returned unchanged.
 *
 * The pure functions below carry no build coupling, so the resolution logic is
 * unit-testable without compiling anything.
 */

/**
 * Build-time define. `bun build --define __AR_VERSION__='"…"'` replaces every
 * textual occurrence of this identifier with a string literal. When the build
 * does not inject it (plain `bun run`, `bun test`), the identifier is never
 * declared at runtime — `typeof` keeps that read safe (no ReferenceError).
 */
declare const __AR_VERSION__: string;

/**
 * Normalise a raw version token: trim whitespace (git output ends in a newline)
 * and strip a single leading "v" so a `v0.1.2` tag becomes `0.1.2`. Nullish,
 * empty or whitespace-only input yields "" — the signal for "no version here".
 */
export function normalizeVersion(raw: string | undefined | null): string {
  if (raw === undefined || raw === null) return '';
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  return trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;
}

/**
 * Resolve the effective version: a non-empty (normalised) injected define wins;
 * otherwise fall back to the package version. `pkgVersion` is passed verbatim —
 * it is already the value the build path decided on (sentinel or stamped tag).
 */
export function resolveCliVersion(
  injected: string | undefined | null,
  pkgVersion: string,
): string {
  const normalized = normalizeVersion(injected);
  return normalized.length > 0 ? normalized : pkgVersion;
}

/**
 * Runtime-safe read of the build-time define. Returns `undefined` when the
 * binary was not compiled with `--define __AR_VERSION__` (tests, `bun run`).
 */
export function injectedVersion(): string | undefined {
  return typeof __AR_VERSION__ === 'undefined' ? undefined : __AR_VERSION__;
}
