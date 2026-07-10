/**
 * Shared R3 removal gate for store-and-link artifacts (lot2-remove-reversible).
 *
 * Used by the claude skill/agent handlers AND the opencode skill handler: the
 * decision "is this target rigger's to delete?" is assistant-agnostic — only
 * the target/store paths differ. Lives in `shared/` next to store-refs.ts for
 * the same reason (cross-assistant knowledge that core must not carry).
 *
 * A target is recognized as rigger-managed when EITHER:
 * - it is a symlink resolving to the rigger store (the normal install shape;
 *   a DANGLING symlink still resolving to the store path counts — remove must
 *   be able to clean up a dead link after the store was deleted), or
 * - it is a plain file/directory byte-identical to the store (the linkOrCopy
 *   COPY FALLBACK on filesystems without symlink support): such a copy
 *   contains nothing user-authored, so removing it destroys no user work —
 *   refusing it would make an artifact installed on that FS un-removable
 *   forever (the inverse of ADR-0016's reversible-remove intent).
 *
 * Anything else present at the target (hand-made directory/file, foreign or
 * edited content, symlink pointing elsewhere) is NOT rigger's: the plan gate
 * yields a warning-only leave-alone op, and the apply-time re-check refuses
 * the deletion even when a plan raced against a concurrent mutation (TOCTOU).
 */

import { lstat } from 'node:fs/promises';

import { contentMatchesStore, resolvesToStore } from '@agent-rigger/core/linker';
import type { RemovalOp } from '@agent-rigger/core/types';

// ---------------------------------------------------------------------------
// isRemovableTarget
// ---------------------------------------------------------------------------

/**
 * True when `target` may be deleted as part of removing the artifact stored at
 * `store`: absent (nothing to destroy — deletion primitives are rm-force
 * tolerant, and rollback compensations must still clear the store), a symlink
 * resolving to the store, or a byte-identical copy of it (copy fallback).
 *
 * Shared predicate of the plan gate (planRemoveGate) and the apply-time
 * re-check in applyRemoveSkill (both adapters): the plan decision must hold at
 * the moment of destruction, not only at plan time — the window between the
 * two spans config backups and the store backupDir, long enough for a symlink
 * to be swapped for a real directory (no inter-process lock before Lot 3).
 */
export async function isRemovableTarget(target: string, store: string): Promise<boolean> {
  const targetStat = await lstat(target).catch(() => null);
  if (targetStat === null) {
    return true;
  }
  if (await resolvesToStore(target, store)) {
    return true;
  }
  return contentMatchesStore(target, store);
}

// ---------------------------------------------------------------------------
// planRemoveGate
// ---------------------------------------------------------------------------

/**
 * R3 gate shared by planRemoveSkill (claude + opencode) and planRemoveAgent:
 * decide the removal plan for a store-and-link artifact from what the disk
 * actually holds.
 *
 * - target absent → [] (not installed, idempotent no-op);
 * - target is a symlink resolving to the rigger store → [unlink] (legitimate;
 *   includes a dangling link whose store was already deleted — cleanup);
 * - target is a plain copy byte-identical to the store → [unlink] (linkOrCopy
 *   copy fallback: nothing user-authored is destroyed, the engine's store
 *   backup keeps the bytes);
 * - anything else present (real directory/file with foreign content, foreign
 *   symlink) → a warning-only leave-alone op: rigger does not manage that
 *   path, so remove MUST NOT delete it. The effective plan is empty, which
 *   makes the engine preserve the manifest entry — the audit reports the
 *   target as 'drift', so `check` keeps reporting the divergence (exit 3).
 */
export async function planRemoveGate(
  entryId: string,
  target: string,
  store: string,
): Promise<RemovalOp[]> {
  const targetStat = await lstat(target).catch(() => null);
  if (targetStat === null) {
    return [];
  }

  if (!(await resolvesToStore(target, store)) && !(await contentMatchesStore(target, store))) {
    return [{
      kind: 'leave-alone',
      target,
      warnings: [
        `"${entryId}": ${target} is present but not managed (target is not a rigger symlink) — left in place`,
      ],
    }];
  }

  return [{ kind: 'unlink', target, store }];
}
