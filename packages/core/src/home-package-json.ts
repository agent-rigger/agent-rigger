/**
 * Pure merge logic for the home rigger's managed `package.json` (U1,
 * lib-imports-alias). No I/O, no filesystem access — mirrors opencode-json.ts:
 * the engine's lib-materialisation channel (`engine.ts`) reads the file, calls
 * `mergeLibsImportMapping` to compute the new content, then writes it back
 * under the same transactional rollback ledger as every other file it touches.
 *
 * The managed leaf: `imports["#libs/*"] = "./libs/*"` — the mapping that lets
 * a consumer posed under the rigger home (a hook in the scriptStore, a plugin
 * symlinked from the plugin store) resolve `#libs/<lib>/<mod>.ts` against
 * `libsDir(env)` (2026-07-22 probe, brief lib-imports-alias). This is the
 * ONLY key this module ever touches:
 *
 * - Merge is at LEAF granularity on `imports`, never the whole object: every
 *   other `imports` entry, and every other top-level `package.json` key,
 *   survives untouched (same posture as opencode-json.ts's permission/mcp
 *   merges — add/correct ONE managed unit, never clobber the rest).
 * - Unlike opencode.json's `permission` merge (which never overwrites an
 *   EXISTING user leaf), the `#libs/*` leaf itself is entirely OUR managed
 *   field — there is no "user's own #libs/* mapping" to preserve. If it is
 *   present but diverged (hand-edited, stale from a prior convention), the
 *   merge CORRECTS it to the canonical target: `apply()`'s contract is to
 *   GUARANTEE the mapping, not merely add it when wholly absent.
 * - `current === undefined` means the file itself does not exist on disk (the
 *   engine distinguishes this from "exists and parses to `{}`" by checking
 *   existence before reading) — only THIS case produces the sober fresh stub
 *   (`name` + `imports`). A file that exists — even empty — is case (b):
 *   leaf-merge only, never widened with a `name` key it didn't have.
 *
 * Invariants:
 * - Inputs are never mutated; every function returns a fresh object.
 * - Idempotent: merging the result of a merge is a no-op (`changed: false`).
 */

/** The subpath import specifier the rigger home guarantees. */
export const LIBS_IMPORT_SPECIFIER = '#libs/*';

/** The target every `#libs/*` specifier resolves to, relative to the home root. */
export const LIBS_IMPORT_TARGET = './libs/*';

/** The sober stub written when the managed `package.json` does not exist yet. */
function freshHomePackageJson(): Record<string, unknown> {
  return {
    name: 'agent-rigger-home',
    imports: { [LIBS_IMPORT_SPECIFIER]: LIBS_IMPORT_TARGET },
  };
}

/** `true` when `value` is a plain object (not `null`, not an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * `true` when `pkg.imports['#libs/*']` is already exactly `'./libs/*'`.
 * A malformed (non-object) `imports` value is treated as absent, never thrown.
 */
export function hasLibsImportMapping(pkg: Record<string, unknown>): boolean {
  const imports = pkg['imports'];
  if (!isPlainObject(imports)) return false;
  return imports[LIBS_IMPORT_SPECIFIER] === LIBS_IMPORT_TARGET;
}

/**
 * Compute the managed `package.json` content that guarantees the `#libs/*`
 * mapping.
 *
 * @param current  The file's current parsed content, or `undefined` when the
 *                  file does not exist on disk (the caller — the engine —
 *                  checks existence, since a present-but-empty-object file
 *                  must NOT get the fresh stub's extra `name` key).
 * @returns `result` — the new content to write (or the untouched `current`
 *          when already correct); `changed` — `false` exactly in the
 *          idempotent no-op case, so the engine can skip all I/O.
 */
export function mergeLibsImportMapping(
  current: Record<string, unknown> | undefined,
): { result: Record<string, unknown>; changed: boolean } {
  if (current === undefined) {
    return { result: freshHomePackageJson(), changed: true };
  }

  if (hasLibsImportMapping(current)) {
    return { result: current, changed: false };
  }

  const currentImports = isPlainObject(current['imports']) ? current['imports'] : {};
  return {
    result: {
      ...current,
      imports: { ...currentImports, [LIBS_IMPORT_SPECIFIER]: LIBS_IMPORT_TARGET },
    },
    changed: true,
  };
}
