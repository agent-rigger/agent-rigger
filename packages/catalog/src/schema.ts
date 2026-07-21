/**
 * Zod schema for catalog entries — discriminated union on `kind`.
 *
 * Two variants:
 *  - kind:'artifact'  A single installable artefact with a concrete nature.
 *  - kind:'pack'      A named bundle that groups other artefact ids.
 *
 * Common fields (id, targets, scopes, requires?) live in both variants.
 * Variant-specific fields are isolated to their branch of the union.
 */

import * as z from 'zod';

import {
  isSafeArtifactName,
  type Nature,
  sanitizeIdForMessage,
  type Scope,
} from '@agent-rigger/core';

// ---------------------------------------------------------------------------
// Nature constants + compile-time coherence check with core.Nature
// ---------------------------------------------------------------------------

/**
 * The 9 natures of installable artefacts. Exported (T7, lib-nature R8.4) so
 * CLI-side exhaustiveness tests can iterate it against the manual per-nature
 * structures (RESOURCE_NATURE_MAP, PREFIX_TO_NATURE, ADAPTER_CHECK_NATURES)
 * without a second, driftable list.
 */
export const NATURES = [
  'plugin',
  'guardrail',
  'context',
  'skill',
  'agent',
  'mcp',
  'tool',
  'hook',
  'lib',
] as const;

/**
 * Compile-time guard: if core's Nature and NATURES diverge, this line fails.
 * Bidirectional: both sides must be subtypes of each other.
 */
type _NatureCheck = (typeof NATURES)[number] extends Nature
  ? Nature extends (typeof NATURES)[number] ? true
  : never
  : never;
const _assertNaturesInSync: _NatureCheck = true;
void _assertNaturesInSync;

// ---------------------------------------------------------------------------
// Scope constants + compile-time coherence check with core.Scope
// ---------------------------------------------------------------------------

const SCOPES = ['user', 'project'] as const;
type _ScopeCheck = (typeof SCOPES)[number] extends Scope
  ? Scope extends (typeof SCOPES)[number] ? true
  : never
  : never;
const _assertScopesInSync: _ScopeCheck = true;
void _assertScopesInSync;

// ---------------------------------------------------------------------------
// Catalog id safety — parse-time path-traversal rejection
// ---------------------------------------------------------------------------

/**
 * Whether a raw catalog id is safe to carry through the install pipeline.
 *
 * Ids follow the `<prefix>:<name>` convention (e.g. "skill:hello-rigger"), but
 * the schema does NOT require the colon — an id without one is validated as a
 * single segment (`nature` is a separate schema field; the prefix is a
 * convention, not an invariant). The id is split at its FIRST colon and each
 * resulting segment must pass core's isSafeArtifactName — the single source of
 * truth for the rule (SAFE_NAME_RE plus rejection of "."/".."/empty), so this
 * parse-time gate can never diverge from the deep guard assertSafeArtifactName.
 *
 * A forged id like "skill:../../evil" is thus rejected at catalog.json parse,
 * before any fetch, resolve, or path construction (brief § Fail-fast).
 *
 * Note: `requires[]`/`members[]` refs are deliberately NOT validated here — they
 * legitimately carry cross-catalog `<catalog>/<id>` references (ADR-0017).
 */
export function isSafeCatalogId(id: string): boolean {
  const colon = id.indexOf(':');
  if (colon === -1) return isSafeArtifactName(id);
  return isSafeArtifactName(id.slice(0, colon)) && isSafeArtifactName(id.slice(colon + 1));
}

/**
 * Deterministic, machine-independent message for an id rejected by isSafeCatalogId.
 * The id is untrusted (out of charset by construction), so it is sanitised and
 * length-bounded via sanitizeIdForMessage before interpolation — no raw control
 * sequence from a hostile catalog ever reaches the terminal or the logs.
 */
function describeUnsafeCatalogId(id: unknown): string {
  return `unsafe catalog id "${sanitizeIdForMessage(String(id))}" — each ':'-separated segment `
    + 'must be a safe artefact name ([a-zA-Z0-9._-], and not "." or "..")';
}

// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------

/** Non-empty list of AI assistants an entry targets. */
const TargetsSchema = z.array(z.enum(['claude', 'opencode', 'copilot'])).min(1);

/** Non-empty list of installation scopes supported by an entry. */
const ScopesSchema = z.array(z.enum(SCOPES)).min(1);

/**
 * Fields common to both artifact and pack entries.
 * Extracted to avoid duplication; each variant spreads these via z.object().merge().
 */
const CommonFieldsSchema = z.object({
  /**
   * Unique, non-empty artefact identifier (e.g. "tool:glab", "pack:dev-tools").
   * Rejected at parse time if any ':'-separated segment could traverse a path
   * (see isSafeCatalogId) — fail-fast before any fetch or path construction.
   */
  id: z.string().min(1).refine(isSafeCatalogId, {
    error: (issue) => describeUnsafeCatalogId(issue.input),
  }),

  /** Non-empty list of AI assistants this entry is compatible with. */
  targets: TargetsSchema,

  /** Non-empty list of installation scopes supported by this entry. */
  scopes: ScopesSchema,

  /**
   * Ids of other catalog entries that must be present before this entry can be installed.
   * Example: ["tool:node", "tool:git"].
   */
  requires: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// HookEvent — Claude Code hook trigger events
// ---------------------------------------------------------------------------

/**
 * Claude Code hook trigger events.
 * Meaningful only for entries with nature 'hook'; ignored for all other natures.
 */
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
  'SessionStart',
  'SessionEnd',
  'Notification',
  'PreCompact',
] as const;

/** Union type of all valid Claude Code hook events. */
export type HookEvent = (typeof HOOK_EVENTS)[number];

// ---------------------------------------------------------------------------
// SecretDeclSchema — mcp secret declarations (R5, ADR-0019 §2)
// ---------------------------------------------------------------------------

/**
 * A single secret an mcp entry needs resolved before it can be rendered.
 *
 * `ref` names the env-var reference used in `config.environment`/`config.headers`
 * (e.g. "GITHUB_TOKEN" for a value written as "${GITHUB_TOKEN}"). `prompt` is
 * the human-readable label shown when the CLI asks which env var actually
 * holds it (--secret-env or an interactive prompt, packages/cli). `required`
 * gates fail-closed behaviour when unresolved; `example`/`help` are advisory
 * text only, never a real value.
 */
export const SecretDeclSchema = z.object({
  /** Env-var ref name used in config.environment/config.headers (e.g. "GITHUB_TOKEN"). */
  ref: z.string().min(1),
  /** Human-readable prompt shown when asking which env var holds this secret. */
  prompt: z.string().min(1),
  /** When true, install SHALL fail-closed if this secret is never resolved. */
  required: z.boolean().optional(),
  /** Advisory example value format (never a real secret). */
  example: z.string().optional(),
  /** Advisory help text or URL (e.g. where to generate the token). */
  help: z.string().optional(),
});

/** Inferred type for a single mcp secret declaration. */
export type SecretDecl = z.infer<typeof SecretDeclSchema>;

// ---------------------------------------------------------------------------
// Strict mcp secret form (R6, residual ADR-0018)
// ---------------------------------------------------------------------------

/**
 * Exact-match "${VAR_NAME}" ref form. Deliberately NOT a "contains a ref"
 * match (e.g. "Bearer ${TOKEN}" is rejected): the ratified gate decision
 * (2026-07-10) is strict — env/headers values are refs only, no embedded
 * interpolation, no plain-list escape hatch.
 */
const SECRET_REF_PATTERN = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/**
 * The mcp config sub-fields whose values may carry a secret (ADR-0019 §2).
 * `environment`/`headers` are opencode's canonical fields; `env` is Claude
 * Code's native stdio field (R8) — the render step (mcp-source.ts) expands
 * secret refs in all three, so the parse-time gate SHALL cover all three too,
 * or a literal written to `env` for a claude-targeted entry parses clean and
 * reopens the exact three-copies leak R6/ADR-0018 closed for
 * `environment`/`headers`.
 */
const MCP_SECRET_FIELDS = ['environment', 'headers', 'env'] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Refuse any `config.environment`/`config.headers` value that is not an
 * exact "${VAR_NAME}" ref — scanner-independent, parse-time only (R6). Adds
 * one issue per offending key, naming both the entry id and the field path.
 */
function checkMcpSecretRefsStrict(
  entryId: string,
  config: Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  for (const field of MCP_SECRET_FIELDS) {
    const sub = config[field];
    if (!isPlainRecord(sub)) continue;
    for (const [key, value] of Object.entries(sub)) {
      if (typeof value === 'string' && SECRET_REF_PATTERN.test(value)) continue;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['config', field, key],
        message: `mcp entry "${entryId}" has a non-ref value at config.${field}.${key} — `
          + 'use a "${VAR_NAME}" reference instead of a literal value',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// ArtifactEntrySchema — kind:'artifact'
// ---------------------------------------------------------------------------

/**
 * A single installable artefact: one of the 8 concrete natures.
 *
 * Artifact-specific optional fields:
 *  - level    Importance hint for the installer ("required" | "recommended").
 *  - check    Shell command to detect presence (exit 0 = already installed).
 *  - install  Package-manager specific install commands; all keys optional.
 *
 * Hook-specific fields (required when nature === 'hook'):
 *  - event    Claude Code hook trigger event (e.g. "PreToolUse").
 *  - matcher  Tool name or pattern the hook listens for.
 *
 * Hook-specific optional fields:
 *  - timeout  Max execution time in seconds (positive integer).
 *
 * Mcp-specific optional fields:
 *  - config   Raw MCP server configuration, passed through verbatim.
 */
export const ArtifactEntrySchema = CommonFieldsSchema.extend({
  /** Discriminator — always 'artifact' for this variant. */
  kind: z.literal('artifact'),

  /** Artefact nature — one of the 9 domain categories. Required for artifacts. */
  nature: z.enum(NATURES),

  /**
   * Overrides CommonFieldsSchema.targets (required, min(1)) with an optional
   * variant: a lib entry (R1, S3) targets no assistant at all — it is
   * referenced by its consumers via requires[], never installed directly.
   * The superRefine below enforces the actual invariant per-nature: absent
   * for 'lib', a non-empty array for every other nature (unchanged behaviour).
   */
  targets: TargetsSchema.optional(),

  /**
   * Importance level. Signals whether the artefact is strictly needed or merely helpful.
   * Most relevant for tool-nature entries.
   */
  level: z.enum(['required', 'recommended']).optional(),

  /**
   * Shell command used to detect whether this artefact is already present on the system.
   * A zero exit code means "present"; non-zero means "absent".
   * Example: "which glab".
   */
  check: z.string().optional(),

  /**
   * Platform / package-manager specific installation instructions.
   * All keys are optional — only list the managers the artefact supports.
   */
  install: z
    .object({
      /** Homebrew formula or cask name. */
      brew: z.string().optional(),
      /** npm package name (installed globally via `npm i -g`). */
      npm: z.string().optional(),
      /** pnpm package name (installed globally via `pnpm add -g`). */
      pnpm: z.string().optional(),
      /** mise plugin or tool name (e.g. "node"). */
      mise: z.string().optional(),
    })
    .optional(),

  /**
   * Claude Code hook trigger event. Required when nature === 'hook'.
   * Specifies which lifecycle event activates this hook.
   */
  event: z.enum(HOOK_EVENTS).optional(),

  /**
   * Tool name or pattern this hook listens for. Required when nature === 'hook'.
   * Example: "Bash" to match only Bash tool calls.
   */
  matcher: z.string().optional(),

  /**
   * Maximum execution time in seconds. Must be a positive integer.
   * Meaningful when nature === 'hook'.
   */
  timeout: z.number().int().positive().optional(),

  /**
   * Raw MCP server configuration. Meaningful when nature === 'mcp'.
   * `environment`/`headers`/`env` values SHALL be "${VAR_NAME}" refs — a
   * literal value is rejected at parse time (R6, superRefine below), for
   * every field the render step expands (MCP_SECRET_FIELDS), independently
   * of any scanner. Substitution of the ref (env-var lookup + fail-closed on
   * a missing `required` secret) happens at render time (mcpSource, ADR-0019
   * §3), not here.
   */
  config: z.record(z.string(), z.unknown()).optional(),

  /**
   * Secrets this mcp entry needs resolved before it can be rendered.
   * Meaningful when nature === 'mcp'. Declarative only — no value ever lives
   * here or anywhere in the catalog (ADR-0019 §2).
   */
  secrets: z.array(SecretDeclSchema).optional(),
}).superRefine((data, ctx) => {
  if (data.nature === 'hook') {
    if (data.event === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['event'],
        message: "hook entries require 'event'",
      });
    }
    if (data.matcher === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['matcher'],
        message: "hook entries require 'matcher'",
      });
    }
  }

  if (data.nature === 'mcp' && data.config !== undefined) {
    checkMcpSecretRefsStrict(data.id, data.config, ctx);
  }

  // R1 / S3: a lib entry targets no assistant — it is referenced by its
  // consumers via requires[], never installed directly (S7). Every other
  // nature keeps the pre-existing invariant (non-empty targets, previously
  // enforced structurally by CommonFieldsSchema before targets became
  // optional above).
  if (data.nature === 'lib') {
    if (data.targets !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targets'],
        message: `lib entry "${data.id}" must not declare 'targets' — a lib nature `
          + 'targets no assistant; it is referenced by its consumers via requires[]',
      });
    }
  } else if (data.targets === undefined || data.targets.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targets'],
      message: `entry "${data.id}" (nature '${data.nature}') requires a non-empty 'targets' array`,
    });
  }
}).transform((data) => ({
  ...data,
  // Normalise the omitted-for-lib case to `[]` rather than `undefined` (R1):
  // every OTHER downstream reader of ArtifactEntry.targets (scan-paths,
  // remote-install, cmd-install, doctor-scan, ui…) keeps a plain `Assistant[]`
  // to iterate/`.includes()` without a narrow-by-nature at every call site.
  // The superRefine above already rejected any invalid shape (lib+targets,
  // non-lib without targets), so by the time this runs `data.targets` is
  // either a validated non-empty array or (lib only) absent.
  targets: data.targets ?? [],
}));

/** Inferred type for an artifact entry. */
export type ArtifactEntry = z.infer<typeof ArtifactEntrySchema>;

// ---------------------------------------------------------------------------
// PackEntrySchema — kind:'pack'
// ---------------------------------------------------------------------------

/**
 * A named bundle that groups other artefact ids.
 *
 * Installing a pack installs each member by id.
 * Strict parsing: unknown fields (e.g. 'nature') are rejected to prevent
 * accidental cross-contamination between variants.
 */
export const PackEntrySchema = CommonFieldsSchema.extend({
  /** Discriminator — always 'pack' for this variant. */
  kind: z.literal('pack'),

  /**
   * Non-empty list of member artefact ids.
   * Each id references another catalog entry that belongs to this pack.
   * Example: ["tool:glab", "tool:gh", "plugin:prettier"].
   */
  members: z.array(z.string()).min(1),
}).strict();

/** Inferred type for a pack entry. */
export type PackEntry = z.infer<typeof PackEntrySchema>;

// ---------------------------------------------------------------------------
// CatalogEntrySchema — discriminated union
// ---------------------------------------------------------------------------

/**
 * Top-level catalog entry schema.
 *
 * Discriminated on `kind`:
 *  - 'artifact' → ArtifactEntrySchema
 *  - 'pack'     → PackEntrySchema
 *
 * Zod routes the input to the correct branch based on the `kind` field before
 * running field-level validation — no ambiguity between variants.
 */
export const CatalogEntrySchema = z.discriminatedUnion('kind', [
  ArtifactEntrySchema,
  PackEntrySchema,
]);

// ---------------------------------------------------------------------------
// Inferred union type
// ---------------------------------------------------------------------------

/** Fully-typed catalog entry — either an ArtifactEntry or a PackEntry. */
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

// ---------------------------------------------------------------------------
// CatalogFileSchema — top-level wrapper {meta, entries}
// ---------------------------------------------------------------------------

/**
 * Schema for the top-level `meta` object in `catalog.json`.
 *
 * - `name`        : non-empty string identifying this catalog.
 * - `required`    : optional list of entry ids (pack or artefact) deemed required.
 * - `recommended` : optional list of entry ids (pack or artefact) deemed recommended.
 *
 * No referential validation is performed — ids are arbitrary strings.
 */
export const MetaSchema = z.object({
  /** Non-empty catalog name. */
  name: z.string().min(1),

  /**
   * Entry ids (pack or artefact) that are considered required.
   * Arbitrary ids — no referential check performed here.
   */
  required: z.array(z.string()).optional().default([]),

  /**
   * Entry ids (pack or artefact) that are considered recommended.
   * Arbitrary ids — no referential check performed here.
   */
  recommended: z.array(z.string()).optional().default([]),
});

/** Inferred type for the catalog meta block. */
export type CatalogMeta = z.infer<typeof MetaSchema>;

/**
 * Schema for a complete `catalog.json` file.
 *
 * Expected shape:
 * ```json
 * {
 *   "meta": { "name": "...", "required": [], "recommended": [] },
 *   "entries": [ ... ]
 * }
 * ```
 */
export const CatalogFileSchema = z.object({
  /** Catalog metadata. */
  meta: MetaSchema,
  /** Array of catalog entries (artifact or pack). */
  entries: z.array(CatalogEntrySchema),
});

/** Inferred type for a complete catalog file. */
export type CatalogFile = z.infer<typeof CatalogFileSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse `input` as a CatalogEntry.
 * Throws a ZodError (with structured issue list) if validation fails.
 */
export function parseCatalogEntry(input: unknown): CatalogEntry {
  return CatalogEntrySchema.parse(input);
}

/** Return type of safeParseCatalogEntry — discriminated union with `success` flag. */
export type SafeParseCatalogResult = ReturnType<(typeof CatalogEntrySchema)['safeParse']>;

/**
 * Attempt to parse `input` as a CatalogEntry without throwing.
 * Returns `{ success: true, data }` on success or `{ success: false, error }` on failure.
 */
export function safeParseCatalogEntry(input: unknown): SafeParseCatalogResult {
  return CatalogEntrySchema.safeParse(input);
}

/**
 * Parse `input` as a CatalogFile (the full `catalog.json` wrapper).
 * Throws a ZodError if validation fails.
 */
export function parseCatalog(input: unknown): CatalogFile {
  return CatalogFileSchema.parse(input);
}

/** Return type of safeParseCatalog. */
export type SafeParseCatalogFileResult = ReturnType<(typeof CatalogFileSchema)['safeParse']>;

/**
 * Attempt to parse `input` as a CatalogFile without throwing.
 * Returns `{ success: true, data }` on success or `{ success: false, error }` on failure.
 */
export function safeParseCatalog(input: unknown): SafeParseCatalogFileResult {
  return CatalogFileSchema.safeParse(input);
}
