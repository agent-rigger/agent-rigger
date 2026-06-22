/**
 * artifact-name.ts — safe artifact name derivation.
 *
 * Responsibilities:
 * - Derive and validate the filesystem name from an artifact id.
 * - Reject names that could cause path traversal attacks.
 *
 * Constraints:
 * - No while loops.
 * - No process.exit.
 * - Pure logic — no I/O.
 *
 * Security model:
 * - The id field in catalog entries is validated by Zod only as `string().min(1)`.
 *   A remote catalog can supply ids like "skill:../../../../etc/evil".
 * - The derived name (id with prefix stripped) is used to construct store paths,
 *   target paths, and symlinks — all via `path.join`. `path.join` collapses `..`
 *   segments, making traversal possible without an explicit guard.
 * - assertSafeArtifactName is the single, central guard: it MUST be called before
 *   any path construction from a user-controlled name.
 */

// ---------------------------------------------------------------------------
// UnsafeArtifactNameError
// ---------------------------------------------------------------------------

/**
 * Thrown when an artifact name derived from a catalog id would cause a path
 * traversal attack. This is a hard rejection — no file operation is performed.
 */
export class UnsafeArtifactNameError extends Error {
  /** The catalog id that produced the unsafe name. */
  readonly id: string;

  constructor(id: string) {
    super(`Unsafe artifact id (path traversal): "${id}"`);
    this.name = 'UnsafeArtifactNameError';
    this.id = id;
  }
}

// ---------------------------------------------------------------------------
// assertSafeArtifactName
// ---------------------------------------------------------------------------

/**
 * Allowlist for artifact names used as filesystem path components.
 *
 * Accepted: letters, digits, underscore, hyphen, dot.
 * Rejected: anything else — in particular `/`, `\`, empty strings, `.`, `..`.
 *
 * This regex is intentionally strict: it accepts only a known-safe character
 * set and rejects by default. We do NOT attempt to sanitise — we reject.
 */
const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/;

/**
 * Assert that a derived artifact name is safe for use as a filesystem path component.
 *
 * - Rejects empty strings (derived from an id that is only a prefix, e.g. "skill:").
 * - Rejects "." and ".." (special filesystem entries).
 * - Rejects any name that contains `/`, `\`, or characters outside [a-zA-Z0-9._-].
 *
 * @param name  The name derived from the id (id with prefix stripped, e.g. "my-skill").
 * @param id    The original catalog id (for error message context).
 *
 * @throws UnsafeArtifactNameError when the name fails validation.
 */
export function assertSafeArtifactName(name: string, id: string): void {
  if (name === '.' || name === '..' || !SAFE_NAME_RE.test(name)) {
    throw new UnsafeArtifactNameError(id);
  }
}
