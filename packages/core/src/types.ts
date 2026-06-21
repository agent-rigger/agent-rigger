/**
 * Domain types for agent-rigger.
 *
 * Keep this file types-only — no logic, no imports from node:* or bun.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** 7 natures of installable artefacts. */
export type Nature = 'plugin' | 'guardrail' | 'context' | 'skill' | 'agent' | 'mcp' | 'tool';

/** Installation scope: user-level (~/) or project-level (cwd). */
export type Scope = 'user' | 'project';

// ---------------------------------------------------------------------------
// Artefact
// ---------------------------------------------------------------------------

/**
 * Minimal installable unit.
 * Enriched by CatalogEntry (packages/catalog) — kept lean here (YAGNI).
 */
export interface Artifact {
  id: string;
  nature: Nature;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * One record in the local manifest (~/.config/agent-rigger/state.json).
 * Tracks what is installed, where it came from, and what it wrote to disk.
 *
 * - source: 'internal' for tool-coupled artefacts, 'external' for remote ones.
 * - ref: semver tag (human version).
 * - sha: resolved commit sha (reproducibility + drift detection).
 * - installedAt: ISO-8601 timestamp string.
 * - files: absolute paths of files written or managed.
 */
export interface ManifestEntry {
  id: string;
  nature: Nature;
  source: 'internal' | 'external';
  ref: string;
  sha: string;
  scope: Scope;
  installedAt: string;
  files: string[];
}

/**
 * Root of ~/.config/agent-rigger/state.json.
 * version tracks the manifest schema (bump when breaking changes).
 */
export interface Manifest {
  version: number;
  artifacts: ManifestEntry[];
}

// ---------------------------------------------------------------------------
// WriteOp — planned filesystem operations (for dry-run diff display)
// ---------------------------------------------------------------------------

/**
 * Discriminated union of write operations produced by an Adapter.plan() call.
 *
 * NOTE: this union is intentionally minimal for M0. New kinds will be added as
 * adapters (guardrails, managed-import, skills, agents) are implemented in
 * tasks B3-B6. Do not extend speculatively.
 */

/** Overwrite (or create) a JSON file, keeping unrelated keys intact. */
export interface WriteOpWriteJson {
  kind: 'write-json';
  path: string;
  /** Human-readable summary of what changes (e.g. keys added). */
  description: string;
}

/** Overwrite (or create) a plain-text file. */
export interface WriteOpWriteText {
  kind: 'write-text';
  path: string;
  description: string;
}

/**
 * Merge entries into permissions.deny (settings.json).
 * Only the deny array is touched; all other keys are preserved.
 */
export interface WriteOpMergeDeny {
  kind: 'merge-deny';
  path: string;
  /** Deny rules that will be appended (after dedup). */
  toAdd: string[];
}

/**
 * Ensure a managed import block exists in a Markdown file (CLAUDE.md bridge).
 * Idempotent: existing blocks are replaced in-place; no duplicate is added.
 */
export interface WriteOpEnsureImport {
  kind: 'ensure-import';
  path: string;
  /** The @import line to embed inside the managed block. */
  importLine: string;
}

export type WriteOp =
  | WriteOpWriteJson
  | WriteOpWriteText
  | WriteOpMergeDeny
  | WriteOpEnsureImport;

// ---------------------------------------------------------------------------
// Scanner / Verdict
// ---------------------------------------------------------------------------

/**
 * Result of a security scan (core/scan.ts seam).
 * M0: stub always returns { ok: true }.
 * Future: findings array populated by Trivy/Gitleaks/regex scanners.
 */
export interface Verdict {
  ok: boolean;
  /** Human-readable findings when ok is false. */
  findings?: string[];
}

// ---------------------------------------------------------------------------
// Audit / Report
// ---------------------------------------------------------------------------

/**
 * State of a single artefact as observed on disk.
 *
 * - 'missing'  → not installed; check exits 3.
 * - 'present'  → installed and matches manifest sha/content; check exits 0.
 * - 'drift'    → installed but diverged (file modified or sha mismatch); check exits 3.
 */
export type ArtifactState = 'missing' | 'present' | 'drift';

/**
 * Audit result for one artefact entry.
 * The engine (B7) derives exit codes from a collection of NatureReports.
 */
export interface NatureReport {
  id: string;
  nature: Nature;
  state: ArtifactState;
  /** Optional detail message (e.g. which file is missing / drifted). */
  detail?: string;
}

/**
 * Aggregated audit report returned by engine.check().
 * Use entries to derive exit code: 0 if all present, 3 if any missing/drift.
 * Exit code logic lives in engine.ts (B7), not here.
 */
export interface Report {
  entries: NatureReport[];
}
