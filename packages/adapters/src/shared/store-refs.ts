/**
 * Shared enumeration of store reference candidates (R4, ADR-0020 §3 —
 * "one store, N symlinks").
 *
 * A managed store (skill directory, agent .md, plugin module) may be
 * referenced by symlinks installed for EITHER assistant (claude, opencode) at
 * EITHER scope (user, project). Removing one reference must never destroy a
 * store another install still points at, so every remover needs the same
 * candidate list. This module is that single source of truth — it lives in
 * `adapters/` (not core) because the candidate paths are assistant-specific
 * knowledge core must not carry (ADR-0020: core stays assistant-agnostic).
 *
 * Two seams feed the list:
 * - **Static family paths** — every known install target derived from the
 *   store's basename, both assistants × both scopes under `cwd`. All families
 *   are enumerated unconditionally rather than branching on the store's
 *   location: a candidate that does not exist is skipped by the reference
 *   check (lstat → null), and a candidate that DOES exist only counts when its
 *   symlink resolves to *this* store, so cross-family paths can never produce
 *   a false positive.
 * - **Manifest files** — the `files` recorded by the manifest entries that
 *   REMAIN after the removal (passed down from the engine). A project-scope
 *   install performed from another cwd is only discoverable through them
 *   (requirements R4: "references are enumerated from the manifest, not the
 *   cwd").
 *
 * Reference detection itself stays in core (`resolvesToStore`,
 * `removeStoreIfUnreferenced`): filesystem truth, offline, copy-fallback
 * installs never count as references.
 */

import path from 'node:path';

import { resolvesToStore } from '@agent-rigger/core/linker';
import {
  resolveOpencodeProjectTargets,
  resolveOpencodeUserTargets,
  resolveUserTargets,
} from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

// ---------------------------------------------------------------------------
// storeReferenceCandidates
// ---------------------------------------------------------------------------

/**
 * Enumerate every install target path that may keep `store` alive.
 *
 * @param store          Path to the managed store entry (skill dir, agent .md,
 *                       plugin module). Only its basename drives the static
 *                       family paths.
 * @param env            Injectable env for HOME resolution.
 * @param cwd            Working directory for project-scope candidates.
 * @param manifestFiles  Target paths recorded by the manifest entries that
 *                       remain after the removal (opaque — passed through the
 *                       engine). Deduplicated with the static candidates.
 * @returns Deduplicated candidate list, ready for removeStoreIfUnreferenced.
 */
export function storeReferenceCandidates(
  store: string,
  env: Env,
  cwd: string,
  manifestFiles: string[] = [],
): string[] {
  const fileName = path.basename(store);
  const claudeDir = path.dirname(resolveUserTargets(env).claudeSettings);
  const opencodeUser = resolveOpencodeUserTargets(env);
  const opencodeProject = resolveOpencodeProjectTargets(cwd);

  return [
    ...new Set([
      // claude skills (user, project) — mirrors claude/skills.ts resolveTargetPath
      path.join(claudeDir, 'skills', fileName),
      path.join(cwd, '.claude', 'skills', fileName),
      // claude agents (user, project) — mirrors claude/agents.ts resolveTargetPath
      path.join(claudeDir, 'agents', fileName),
      path.join(cwd, '.claude', 'agents', fileName),
      // opencode skills (user, project) — mirrors opencode/skills.ts resolveTargetPath
      path.join(opencodeUser.skillsDir, fileName),
      path.join(opencodeProject.skillsDir, fileName),
      // opencode plugins (user, project) — mirrors opencode/plugins.ts resolveTargetDir
      path.join(opencodeUser.pluginDir, fileName),
      path.join(opencodeProject.pluginDir, fileName),
      // manifest-recorded targets of the entries remaining after the removal
      ...manifestFiles,
    ]),
  ];
}

// ---------------------------------------------------------------------------
// isStoreReferenced
// ---------------------------------------------------------------------------

/**
 * True when at least one candidate is a live symlink resolving to `store`.
 *
 * Read-only companion of core's removeStoreIfUnreferenced — used by the CLI to
 * PREVIEW the fate of the store in the removal plan (deleted with the last
 * reference vs kept because still referenced) without touching the disk.
 * Callers deciding a fate for a pending removal must exclude the targets being
 * unlinked in the same run from `candidates` (they still resolve at plan time
 * but will be gone before the store decision).
 */
export async function isStoreReferenced(
  store: string,
  candidates: string[],
): Promise<boolean> {
  for (const candidate of candidates) {
    if (await resolvesToStore(candidate, store)) {
      return true;
    }
  }
  return false;
}
