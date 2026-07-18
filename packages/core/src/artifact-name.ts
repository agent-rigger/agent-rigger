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
// sanitizeIdForMessage — safe rendering of an untrusted id in a message
// ---------------------------------------------------------------------------

/** Upper bound on the rendered id length in an error message. */
const MAX_ID_MESSAGE_LEN = 120;

/**
 * Render a catalog id for safe inclusion in a human-readable error message.
 *
 * An id that reaches an error path is, by construction, outside the safe
 * charset, so it may carry terminal control sequences (ANSI ESC, CR/LF, C0/C1
 * controls) or be arbitrarily long. Interpolated raw, either would let a hostile
 * remote catalog spoof or flood the terminal — or forge log lines — through a
 * single warning. We escape every control character (C0 U+0000–U+001F, DEL
 * U+007F, C1 U+0080–U+009F) as `\xNN` and bound the length. Output is
 * deterministic and machine-independent. Printable characters (including
 * non-ASCII letters and the offending `/`, `..`, spaces) are left readable.
 *
 * Note: this only sanitises the rendered *message*; the raw id is preserved
 * verbatim on the error's `id` field for programmatic use.
 */
export function sanitizeIdForMessage(id: string): string {
  const escaped = Array.from(id, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    return isControl ? `\\x${code.toString(16).padStart(2, '0')}` : ch;
  }).join('');
  return escaped.length > MAX_ID_MESSAGE_LEN
    ? `${escaped.slice(0, MAX_ID_MESSAGE_LEN)}...`
    : escaped;
}

// ---------------------------------------------------------------------------
// UnsafeArtifactNameError
// ---------------------------------------------------------------------------

/**
 * Thrown when an artifact name derived from a catalog id would cause a path
 * traversal attack. This is a hard rejection — no file operation is performed.
 */
export class UnsafeArtifactNameError extends Error {
  /** The catalog id that produced the unsafe name (raw, unsanitised). */
  readonly id: string;

  constructor(id: string) {
    super(`Unsafe artifact id (path traversal): "${sanitizeIdForMessage(id)}"`);
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
 * Predicate form of the artifact-name safety rule: `true` iff `segment` is safe
 * to use as a filesystem path component.
 *
 * A segment is safe when it matches SAFE_NAME_RE and is neither "." nor ".."
 * (SAFE_NAME_RE already rejects the empty string, since it requires at least one
 * character). This is the single source of truth for the rule: both
 * assertSafeArtifactName (below) and the catalog schema's id check
 * (packages/catalog/src/schema.ts, one ':'-separated segment at a time) build on
 * it, so the parse-time gate and the deep guard can never diverge.
 *
 * @param segment  One path component — an id with its nature prefix stripped, or
 *                 a single ':'-separated segment of a raw catalog id.
 */
export function isSafeArtifactName(segment: string): boolean {
  return segment !== '.' && segment !== '..' && SAFE_NAME_RE.test(segment);
}

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
  if (!isSafeArtifactName(name)) {
    throw new UnsafeArtifactNameError(id);
  }
}
