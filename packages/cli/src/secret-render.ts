/**
 * secret-render.ts — pure secret-substitution helpers for the mcp render step
 * (R5, D5, lot6-versioning-catalogue).
 *
 * Split from secret-collect.ts (the CLI-side COLLECTION half — --secret-env,
 * TTY prompt, fail-closed only when no var NAME can even be decided) — this
 * module is the RENDER half: given the effective ref→VAR overrides (from
 * --secret-env, or replayed from a manifest's secretRefs on update — ADR-0020
 * §1, no re-prompt), it:
 *
 *  1. Resolves the FULL ref→VAR mapping for every secret an mcp entry
 *     declares (secretRefs, D5 point 4 — names only, never a value) and
 *     fail-closes (MissingRequiredSecretError) when a `required` secret's
 *     resolved var is NOT actually present in the environment. This is a
 *     SEPARATE check from secret-collect's: that one verifies a var NAME
 *     could be decided at all (flag/prompt/default); this one verifies the
 *     named var is really set — the last checkpoint before any write, run on
 *     every install AND every re-render (update), independent of whether the
 *     CLI's interactive collection ever ran.
 *  2. Substitutes every exact "${REF}" value (R6 strict form) found in an
 *     environment/headers record with a host-native rendered form — every ref
 *     is translated, including one absent from `secrets[]` declarations (R6
 *     allows any ref-shaped value; an untranslated ref would silently break
 *     at the host, T0).
 *
 * Constraints:
 * - No I/O — `env` is injected (Env = Record<string, string | undefined>).
 * - No while loops.
 */

import type { SecretDecl } from '@agent-rigger/catalog';
import type { Env } from '@agent-rigger/core/paths';

import { MissingRequiredSecretError } from './secret-collect';

// ---------------------------------------------------------------------------
// renderSecretRefs
// ---------------------------------------------------------------------------

/** Options for renderSecretRefs. */
export interface RenderSecretRefsOpts {
  /** The mcp catalog entry id — used only for actionable error messages. */
  entryId: string;
  /** Every secret the mcp entry declares (ArtifactEntry.secrets, R5 schema). */
  secrets: SecretDecl[];
  /**
   * ref→VAR overrides, already decided upstream (--secret-env flags, or a
   * manifest's secretRefs replayed on update). Absent ref → defaults to the
   * ref's own name (the common case: the operator exported a var of that
   * name directly).
   */
  overrides?: Record<string, string>;
  /** Injectable environment for the presence check. */
  env: Env;
}

/**
 * Resolve the effective ref→VAR mapping for every declared secret and verify
 * that a `required` secret's resolved var is actually present in `env`.
 *
 * Returns the FULL map (every declared secret, not only the overridden ones)
 * — this is exactly what a later `update` needs to re-render without asking
 * again (D5 point 4).
 *
 * @throws {MissingRequiredSecretError} when a `required` secret's resolved
 *         env var is absent — thrown BEFORE any config is rendered/written.
 */
export function renderSecretRefs(opts: RenderSecretRefsOpts): Record<string, string> {
  const { entryId, secrets, overrides, env } = opts;
  const secretRefs: Record<string, string> = {};

  for (const secret of secrets) {
    const envVar = overrides?.[secret.ref] ?? secret.ref;
    const present = env[envVar] !== undefined;

    if (secret.required === true && !present) {
      throw new MissingRequiredSecretError(
        `mcp entry "${entryId}" is missing required secret "${secret.ref}" (${secret.prompt}) — `
          + `env var "${envVar}" is not set. Export it (export ${envVar}=<value>) or re-run with `
          + `--secret-env=${secret.ref}=<OTHER_VAR>.`,
        secret.ref,
      );
    }

    secretRefs[secret.ref] = envVar;
  }

  return secretRefs;
}

// ---------------------------------------------------------------------------
// substituteSecretRefs
// ---------------------------------------------------------------------------

/**
 * Exact "${VAR_NAME}" ref form — mirrors catalog/schema.ts's SECRET_REF_PATTERN
 * (R6, strict: env/headers values are refs only, no embedded interpolation).
 */
const SECRET_REF_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Substitute every exact "${REF}" value in `record` with its host-native
 * rendered form.
 *
 * A ref found in `secretRefs` (a declared secret) uses its resolved var; a
 * ref NOT declared anywhere in `secrets[]` (still schema-valid per R6 — any
 * ref-shaped value passes parse) falls back to its own name — every ref gets
 * translated, never left as an untranslatable bash-style literal (T0). A
 * value that is not ref-shaped at all passes through unchanged (defensive;
 * R6 already rejects this at catalog parse time for mcp environment/headers).
 *
 * @param record      `config.environment` or `config.headers` (undefined when absent).
 * @param secretRefs  ref→VAR map from renderSecretRefs.
 * @param render      Host-native rendering of the effective var name
 *                     (e.g. opencode: `(v) => \`{env:${v}}\``).
 */
export function substituteSecretRefs(
  record: Record<string, string> | undefined,
  secretRefs: Record<string, string>,
  render: (envVar: string) => string,
): Record<string, string> | undefined {
  if (record === undefined) return undefined;

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    const match = SECRET_REF_PATTERN.exec(value);
    if (match === null) {
      out[key] = value;
      continue;
    }
    const ref = match[1] as string;
    const envVar = secretRefs[ref] ?? ref;
    out[key] = render(envVar);
  }
  return out;
}
