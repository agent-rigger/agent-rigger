/**
 * UI layer for the agent-rigger CLI.
 *
 * Responsibilities:
 *  - Pure rendering: renderPlan, renderReport (fully testable, no I/O).
 *  - Interactive prompts: selectArtifacts, selectScope, confirmApply
 *    (thin glue around @clack/prompts; not unit-tested due to TTY requirement).
 *
 * Constraints:
 *  - No process.exit — the caller decides what to do after cancellation.
 *  - No while loops.
 *  - No emojis in output — ASCII prefix markers only.
 */

import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
  select,
  spinner,
} from '@clack/prompts';

import type { CatalogEntry } from '@agent-rigger/catalog';
import type { Report, Scope, WriteOp } from '@agent-rigger/core';

// ---------------------------------------------------------------------------
// Re-exports — callers can use these wrappers instead of importing clack directly
// ---------------------------------------------------------------------------

export { cancel, intro, isCancel, note, outro, spinner };

// ---------------------------------------------------------------------------
// Pure rendering helpers
// ---------------------------------------------------------------------------

/**
 * Render a human-readable diff plan from a list of WriteOps.
 *
 * Prefix conventions (ASCII only):
 *  +  deny rule added
 *  ~  import ensured
 *  ±  file write (create or overwrite)
 *  -> link (source → store → target)
 *  ⇩  plugin install  (U+21E9, not an emoji, plain Unicode arrow)
 *
 * Returns a "nothing to apply" message when `ops` is empty.
 */
export function renderPlan(ops: WriteOp[]): string {
  if (ops.length === 0) {
    return 'Nothing to apply — already up to date.';
  }

  const lines: string[] = [];

  for (const op of ops) {
    switch (op.kind) {
      case 'merge-deny': {
        lines.push(`  ${op.path}  [deny merge]`);
        for (const rule of op.toAdd) {
          lines.push(`    + deny: ${rule}`);
        }
        break;
      }
      case 'ensure-import': {
        lines.push(`  ${op.path}`);
        lines.push(`    ~ import: ${op.importLine}`);
        break;
      }
      case 'write-text': {
        lines.push(`  ± write: ${op.path}`);
        break;
      }
      case 'write-json': {
        lines.push(`  ± write: ${op.path}`);
        break;
      }
      case 'link': {
        lines.push(`  -> link: ${op.target} -> ${op.store}`);
        lines.push(`       (source: ${op.source})`);
        break;
      }
      case 'plugin-install': {
        lines.push(`  [v] plugin: ${op.plugin} (marketplace ${op.marketplace})`);
        break;
      }
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------

/**
 * Render an audit Report as a human-readable status list.
 *
 * State prefixes:
 *  [ok]      present
 *  [miss]    missing
 *  [drift]   drift — detail appended when provided
 *
 * Returns a "no entries" message when entries is empty.
 */
export function renderReport(report: Report): string {
  if (report.entries.length === 0) {
    return 'Audit complete — no entries to report.';
  }

  const lines: string[] = [];

  for (const entry of report.entries) {
    switch (entry.state) {
      case 'present': {
        lines.push(`  [ok]    ${entry.id}  (${entry.nature})`);
        break;
      }
      case 'missing': {
        lines.push(`  [missing]  ${entry.id}  (${entry.nature})`);
        break;
      }
      case 'drift': {
        const detail = entry.detail === undefined ? '' : `  — ${entry.detail}`;
        lines.push(`  [drift] ${entry.id}  (${entry.nature})${detail}`);
        break;
      }
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Interactive prompts — thin clack glue (not unit-tested)
// ---------------------------------------------------------------------------

/**
 * Present a multiselect prompt listing catalog entries by id.
 * Returns the array of selected ids.
 * Throws a CancelledError (via cancel helper) if the user aborts.
 */
export async function selectArtifacts(entries: CatalogEntry[]): Promise<string[]> {
  const options = entries.map((e) => ({ value: e.id, label: e.id }));
  const result = await multiselect<string>({
    message: 'Select artifacts to install:',
    options,
    required: false,
  });

  if (isCancel(result)) {
    cancel('Operation cancelled.');
    return [];
  }

  return result;
}

/**
 * Present a select prompt for installation scope.
 * Returns 'user' or 'project'.
 * Falls back to 'user' if the user cancels.
 */
export async function selectScope(): Promise<Scope> {
  const result = await select<Scope>({
    message: 'Select installation scope:',
    options: [
      { value: 'user', label: 'user  (~/.claude/)' },
      { value: 'project', label: 'project  (cwd/.claude/)' },
    ],
  });

  if (isCancel(result)) {
    cancel('Operation cancelled.');
    return 'user';
  }

  return result;
}

/**
 * Present a yes/no confirmation prompt.
 * Returns true if the user confirms, false on denial or cancellation.
 */
export async function confirmApply(summary: string): Promise<boolean> {
  const result = await confirm({
    message: `Apply the following plan?\n\n${summary}`,
    initialValue: false,
  });

  if (isCancel(result)) {
    cancel('Operation cancelled.');
    return false;
  }

  return result;
}
