/**
 * secret-collect.ts — collect MCP secret overrides for a transaction (R5).
 *
 * Split pure decision from IO (testability, ADR-aligned — mirrors
 * assistant-select.ts's decideAssistant/resolveAssistant split):
 * - parseSecretEnvFlag(s)   Pure, argv-level parsing of `--secret-env=<ref>=<VAR>`.
 * - decideSecretOverride    Pure function, exhaustive branch logic, no I/O.
 * - resolveSecretOverrides  IO wrapper: prompts (injectable) only for a secret
 *                           that has neither a flag override nor a required-secret
 *                           failure.
 *
 * Priority (highest → lowest), same shape as assistant-select.ts:
 * flag override > interactive prompt (TTY) > actionable error (non-TTY,
 * required only) > default to the ref name itself (non-TTY, not required).
 *
 * Scope (T5, lot6-versioning-catalogue): this module collects the ref→VAR
 * mapping. It does NOT check whether the resolved env var is actually present
 * in the environment, and it does NOT substitute anything into a config — both
 * are the render step (mcpSource, T6, ADR-0019 §3).
 *
 * Constraints:
 * - No while loops.
 * - No process.exit — callers decide what to do with a thrown error.
 */

import { cancel, isCancel, text } from '@clack/prompts';

import type { SecretDecl } from '@agent-rigger/catalog';

import { CancelledError } from './ui';

// ---------------------------------------------------------------------------
// InvalidSecretEnvFlagError
// ---------------------------------------------------------------------------

/**
 * Thrown by parseSecretEnvFlag(s) when a `--secret-env` value does not match
 * the `<ref>=<VAR>` grammar (missing `=`, empty ref, or empty VAR name).
 */
export class InvalidSecretEnvFlagError extends Error {
  /** The raw (unparsed) value that failed to match `<ref>=<VAR>`. */
  readonly raw: string;

  constructor(raw: string) {
    super(
      `Invalid --secret-env value: "${raw}". Expected "<ref>=<VAR>" `
        + '(e.g. --secret-env=GITHUB_TOKEN=MY_PAT).',
    );
    this.name = 'InvalidSecretEnvFlagError';
    this.raw = raw;
  }
}

// ---------------------------------------------------------------------------
// parseSecretEnvFlag / parseSecretEnvFlags — pure, argv-level parsing
// ---------------------------------------------------------------------------

/**
 * Parse ONE raw `--secret-env` value (the part after `--secret-env=`) into
 * its ref/envVar pair.
 *
 * Grammar: `<ref>=<VAR>` — both sides non-empty, split on the FIRST `=`
 * (a VAR name never contains `=`, but this keeps the parse total either way).
 *
 * @throws {InvalidSecretEnvFlagError} when `raw` has no `=`, or either side is empty.
 */
export function parseSecretEnvFlag(raw: string): { ref: string; envVar: string } {
  const eqIdx = raw.indexOf('=');
  if (eqIdx <= 0 || eqIdx === raw.length - 1) {
    throw new InvalidSecretEnvFlagError(raw);
  }
  const ref = raw.slice(0, eqIdx);
  const envVar = raw.slice(eqIdx + 1);
  return { ref, envVar };
}

/**
 * Parse every `--secret-env` occurrence (in argv order) into a ref→VAR map.
 *
 * Later occurrences of the SAME ref win (last-one-wins, consistent with how
 * parseArgs treats repeated `--key=value` flags elsewhere in this CLI).
 *
 * @throws {InvalidSecretEnvFlagError} on the FIRST malformed entry.
 */
export function parseSecretEnvFlags(raws: string[]): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const raw of raws) {
    const { ref, envVar } = parseSecretEnvFlag(raw);
    overrides[ref] = envVar;
  }
  return overrides;
}

// ---------------------------------------------------------------------------
// MissingRequiredSecretError
// ---------------------------------------------------------------------------

/**
 * Thrown by resolveSecretOverrides when a `required` secret has no flag
 * override AND the process is not a TTY (so no prompt is possible) — fail
 * closed, actionable (R5: "non-TTY + required non résolu → erreur actionnable").
 */
export class MissingRequiredSecretError extends Error {
  /** The ref of the unresolved required secret. */
  readonly ref: string;

  constructor(message: string, ref: string) {
    super(message);
    this.name = 'MissingRequiredSecretError';
    this.ref = ref;
  }
}

// ---------------------------------------------------------------------------
// decideSecretOverride — pure decision (mirrors decideAssistant)
// ---------------------------------------------------------------------------

/** Input to decideSecretOverride. */
export interface DecideSecretOverrideInput {
  /** The secret declaration this decision resolves. */
  secret: SecretDecl;
  /** Raw override for this secret's ref, from --secret-env. Flag wins outright. */
  override?: string;
  /** Whether the current process is an interactive TTY. */
  isTTY: boolean;
}

/** Outcome of decideSecretOverride — exactly one branch is populated. */
export type DecideSecretOverrideResult =
  | { envVar: string }
  | { needsPrompt: SecretDecl }
  | { error: string };

/**
 * Decide the effective env-var name for `secret`, with no I/O.
 *
 * Priority:
 * 1. `override` (from --secret-env) wins outright.
 * 2. Otherwise, in a TTY: the caller must prompt (needsPrompt).
 * 3. Otherwise (non-TTY), a `required` secret is an actionable error — never
 *    a silent guess at the right env var.
 * 4. Otherwise (non-TTY, not required): default to the ref's own name — the
 *    common case where the operator already exported a var of that name.
 */
export function decideSecretOverride(
  input: DecideSecretOverrideInput,
): DecideSecretOverrideResult {
  const { secret, override, isTTY } = input;

  if (override !== undefined) {
    return { envVar: override };
  }

  if (isTTY) {
    return { needsPrompt: secret };
  }

  if (secret.required === true) {
    return {
      error: `missing required secret "${secret.ref}" (${secret.prompt}) — `
        + `pass --secret-env=${secret.ref}=<VAR_NAME> or export ${secret.ref} directly`,
    };
  }

  return { envVar: secret.ref };
}

// ---------------------------------------------------------------------------
// resolveSecretOverrides — IO wrapper (mirrors resolveAssistant)
// ---------------------------------------------------------------------------

/** Options for resolveSecretOverrides. */
export interface ResolveSecretOverridesOpts {
  /** Every secret declared by the entries being installed. */
  secrets: SecretDecl[];
  /** Raw ref→VAR overrides parsed from --secret-env. */
  overrides: Record<string, string>;
  /** Whether the current process is an interactive TTY. */
  isTTY: boolean;
  /** Injectable picker, invoked only when a secret needs a prompt. Defaults to a clack text prompt. */
  picker?: (secret: SecretDecl) => Promise<string>;
}

/**
 * Default interactive picker — thin glue around @clack/prompts, not
 * unit-tested (TTY requirement), mirroring assistant-select.ts's defaultPicker.
 */
async function defaultSecretPicker(secret: SecretDecl): Promise<string> {
  const result = await text({
    message: `${secret.prompt} — which env var holds it?`,
    placeholder: secret.ref,
    defaultValue: secret.ref,
  });

  if (isCancel(result)) {
    // R2: migrated from a generic Error (→ exit 1, indistinguishable from a
    // runtime failure) to CancelledError (→ exit 130 via handleError).
    cancel('Operation cancelled.');
    throw new CancelledError(`Secret "${secret.ref}" prompt cancelled.`);
  }

  return result.length === 0 ? secret.ref : result;
}

/**
 * Resolve the ref→VAR mapping for every declared secret, prompting
 * interactively only when a secret has no flag override and the process is
 * a TTY.
 *
 * @throws {MissingRequiredSecretError} when a `required` secret has no
 *         override and no prompt is possible (non-TTY).
 */
export async function resolveSecretOverrides(
  opts: ResolveSecretOverridesOpts,
): Promise<Record<string, string>> {
  const { secrets, overrides, isTTY, picker = defaultSecretPicker } = opts;
  const resolved: Record<string, string> = {};

  for (const secret of secrets) {
    const override = overrides[secret.ref];
    const decision = decideSecretOverride({
      secret,
      isTTY,
      ...(override === undefined ? {} : { override }),
    });

    if ('envVar' in decision) {
      resolved[secret.ref] = decision.envVar;
    } else if ('error' in decision) {
      throw new MissingRequiredSecretError(decision.error, secret.ref);
    } else {
      resolved[secret.ref] = await picker(decision.needsPrompt);
    }
  }

  return resolved;
}
