/**
 * Consent ledger for agent-rigger.
 *
 * Tool presence-checks (see @agent-rigger/catalog/tool-check) run arbitrary
 * shell content sourced from the catalog. Confirming the install plan is
 * NOT by itself consent to execute those commands — that consent is
 * granular, tracked separately, and memoized here so a previously-approved
 * command is never re-prompted, while a CHANGED command (even under the
 * same catalog id) always is.
 *
 * The ledger lives at ~/.config/agent-rigger/consent.json — same root as the
 * manifest (~/.config/agent-rigger/state.json). This module is a pure seam:
 * it has no opinion on WHEN or WHETHER a command should run, only on
 * whether a given (id, command) pair has already been approved.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

import { readJson, writeJson } from './fs-json';
import type { Env } from './paths';
import { resolveHome } from './paths';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One approved (catalog id, command) pair, memoized to skip re-prompting. */
export interface ConsentEntry {
  /** Catalog entry id, e.g. "tool:glab". */
  id: string;
  /** sha256 hex digest of the exact command string that was approved. */
  commandHash: string;
  /** ISO-8601 timestamp of the approval. */
  approvedAt: string;
  /**
   * Catalog provenance sha at approval time — audit only. Never part of the
   * match key: a changed sha for an unchanged (id, command) pair does NOT
   * invalidate the consent.
   */
  sha?: string;
}

interface ConsentLedger {
  version: number;
  entries: ConsentEntry[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function emptyLedger(): ConsentLedger {
  return { version: 1, entries: [] };
}

/**
 * Coerce a freshly-read JSON object into a valid ledger shape (robustness,
 * mirrors manifest.ts's readManifest coercion).
 */
function coerceLedger(raw: Record<string, unknown>): ConsentLedger {
  if (typeof raw['version'] !== 'number' || !Array.isArray(raw['entries'])) {
    return emptyLedger();
  }
  return raw as unknown as ConsentLedger;
}

function resolveConsentPath(env: Env): string {
  return path.join(resolveHome(env), '.config', 'agent-rigger', 'consent.json');
}

/** sha256 hex digest of `command` — the TOCTOU-safe half of the consent match key. */
export function hashCommand(command: string): string {
  return createHash('sha256').update(command).digest('hex');
}

async function readLedger(env: Env): Promise<ConsentLedger> {
  const raw = await readJson(resolveConsentPath(env));
  return coerceLedger(raw);
}

// ---------------------------------------------------------------------------
// isConsented
// ---------------------------------------------------------------------------

/**
 * True when `entry.id` was previously approved for the EXACT `entry.command`.
 *
 * Matched by (id, commandHash) — never by sha: a changed command re-prompts
 * even under an unchanged catalog sha, and an unchanged command stays
 * consented even if the catalog sha changes underneath it.
 *
 * Never throws: an absent or malformed ledger file is treated as "not
 * consented" — fail-closed on the prompt (re-ask), never fail-open on trust.
 */
export async function isConsented(
  env: Env,
  entry: { id: string; command: string },
): Promise<boolean> {
  try {
    const ledger = await readLedger(env);
    const hash = hashCommand(entry.command);
    return ledger.entries.some((e) => e.id === entry.id && e.commandHash === hash);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// recordConsent
// ---------------------------------------------------------------------------

/**
 * Append an approval to the ledger.
 *
 * Idempotent: a (id, commandHash) pair already on record is left untouched
 * (no duplicate entry, no timestamp bump). `sha` is stored for audit only —
 * it is never part of the match key.
 *
 * A malformed on-disk ledger is treated as empty rather than thrown: the
 * ledger is advisory memoization, not source-of-truth data worth crashing an
 * install over. The write itself is atomic (delegated to writeJson).
 */
export async function recordConsent(
  env: Env,
  entry: { id: string; command: string; sha?: string },
): Promise<void> {
  const filePath = resolveConsentPath(env);
  const ledger = await readJson(filePath).then(coerceLedger, () => emptyLedger());

  const commandHash = hashCommand(entry.command);
  const alreadyRecorded = ledger.entries.some(
    (e) => e.id === entry.id && e.commandHash === commandHash,
  );
  if (alreadyRecorded) {
    return;
  }

  const newEntry: ConsentEntry = {
    id: entry.id,
    commandHash,
    approvedAt: new Date().toISOString(),
    ...(entry.sha === undefined ? {} : { sha: entry.sha }),
  };

  await writeJson(filePath, {
    version: ledger.version,
    entries: [...ledger.entries, newEntry],
  });
}
