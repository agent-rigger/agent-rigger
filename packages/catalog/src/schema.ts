/**
 * Zod schema for catalog entries — discriminated union on `kind`.
 *
 * Two variants:
 *  - kind:'artifact'  A single installable artefact with a concrete nature.
 *  - kind:'pack'      A named bundle that groups other artefact ids.
 *
 * Common fields (id, source, targets, scopes, requires?) live in both variants.
 * Variant-specific fields are isolated to their branch of the union.
 */

import * as z from 'zod';

import type { Nature, Scope } from '@agent-rigger/core';

// ---------------------------------------------------------------------------
// Nature constants + compile-time coherence check with core.Nature
// ---------------------------------------------------------------------------

/** The 8 natures of installable artefacts. */
const NATURES = [
  'plugin',
  'guardrail',
  'context',
  'skill',
  'agent',
  'mcp',
  'tool',
  'hook',
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
  /** Unique, non-empty artefact identifier (e.g. "tool:glab", "pack:dev-tools"). */
  id: z.string().min(1),

  /** Whether the entry ships with the tool ("internal") or comes from a remote source ("external"). */
  source: z.enum(['internal', 'external']),

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
 * Hook-specific optional fields (meaningful when nature === 'hook'):
 *  - event    Claude Code hook trigger event (e.g. "PreToolUse").
 *  - matcher  Tool name or pattern the hook listens for.
 *  - timeout  Max execution time in seconds (positive integer).
 */
export const ArtifactEntrySchema = CommonFieldsSchema.extend({
  /** Discriminator — always 'artifact' for this variant. */
  kind: z.literal('artifact'),

  /** Artefact nature — one of the 8 domain categories. Required for artifacts. */
  nature: z.enum(NATURES),

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
   * Claude Code hook trigger event. Meaningful when nature === 'hook'.
   * Specifies which lifecycle event activates this hook.
   */
  event: z.enum(HOOK_EVENTS).optional(),

  /**
   * Tool name or pattern this hook listens for. Meaningful when nature === 'hook'.
   * Example: "Bash" to match only Bash tool calls.
   */
  matcher: z.string().optional(),

  /**
   * Maximum execution time in seconds. Must be a positive integer.
   * Meaningful when nature === 'hook'.
   */
  timeout: z.number().int().positive().optional(),
});

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
