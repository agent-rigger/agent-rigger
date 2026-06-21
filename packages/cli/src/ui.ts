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
// Path abbreviation helpers
// ---------------------------------------------------------------------------

/**
 * Options for path abbreviation.
 *
 * - home  Absolute home directory string; paths under it become `~/<rel>`.
 * - cwd   Absolute working directory; paths under it become `./<rel>`.
 */
export interface AbbreviatePathOpts {
  home?: string;
  cwd?: string;
}

/**
 * Abbreviate an absolute path for human display.
 *
 * Priority: home prefix > cwd prefix > unchanged.
 * Comparison is prefix-on-separator boundary to avoid false matches
 * (e.g. `/home/me2/foo` must NOT match home `/home/me`).
 */
export function abbreviatePath(p: string, opts: AbbreviatePathOpts = {}): string {
  if (opts.home !== undefined && opts.home !== '') {
    const base = opts.home.endsWith('/') ? opts.home : opts.home + '/';
    if (p === opts.home) return '~';
    if (p.startsWith(base)) return '~/' + p.slice(base.length);
  }

  if (opts.cwd !== undefined && opts.cwd !== '') {
    const base = opts.cwd.endsWith('/') ? opts.cwd : opts.cwd + '/';
    if (p === opts.cwd) return '.';
    if (p.startsWith(base)) return './' + p.slice(base.length);
  }

  return p;
}

/**
 * Options passed to renderPlan.
 */
export interface RenderPlanOpts {
  home?: string;
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Re-exports — callers can use these wrappers instead of importing clack directly
// ---------------------------------------------------------------------------

export { cancel, intro, isCancel, note, outro, spinner };

// ---------------------------------------------------------------------------
// Pure rendering helpers
// ---------------------------------------------------------------------------

/** Fixed-width verb column for plan rendering. */
const VERB_WIDTH = 8;

/** Pad a verb string to VERB_WIDTH with trailing spaces. */
function padVerb(verb: string): string {
  return verb.padEnd(VERB_WIDTH);
}

/** Detail indent (verb column + 2 spaces for the leading "  " prefix). */
const DETAIL_INDENT = '  ' + ' '.repeat(VERB_WIDTH + 1);

/**
 * Render a human-readable diff plan from a list of WriteOps.
 *
 * Format:
 *   Plan (N change(s)):
 *
 *     <verb>   <abbreviated-target>
 *                <detail line(s)>
 *
 * Verbs (ASCII, fixed width):
 *   deny     merge-deny
 *   import   ensure-import
 *   write    write-text / write-json
 *   link     link
 *   plugin   plugin-install
 *
 * Returns a "nothing to apply" message when `ops` is empty.
 */
export function renderPlan(ops: WriteOp[], opts: RenderPlanOpts = {}): string {
  if (ops.length === 0) {
    return 'Nothing to apply — already up to date.';
  }

  const abbr = (p: string): string => abbreviatePath(p, opts);

  const n = ops.length;
  const header = `Plan (${n} ${n === 1 ? 'change' : 'changes'}):`;
  const lines: string[] = [header, ''];

  for (const op of ops) {
    switch (op.kind) {
      case 'merge-deny': {
        lines.push(`  ${padVerb('deny')} ${abbr(op.path)}`);
        for (const rule of op.toAdd) {
          lines.push(`${DETAIL_INDENT}+ ${rule}`);
        }
        break;
      }
      case 'ensure-import': {
        lines.push(`  ${padVerb('import')} ${abbr(op.path)}`);
        lines.push(`${DETAIL_INDENT}${op.importLine}`);
        break;
      }
      case 'write-text': {
        lines.push(`  ${padVerb('write')} ${abbr(op.path)}`);
        break;
      }
      case 'write-json': {
        lines.push(`  ${padVerb('write')} ${abbr(op.path)}`);
        break;
      }
      case 'link': {
        lines.push(`  ${padVerb('link')} ${abbr(op.target)}`);
        lines.push(`${DETAIL_INDENT}from ${abbr(op.source)}`);
        break;
      }
      case 'plugin-install': {
        lines.push(`  ${padVerb('plugin')} ${op.plugin}`);
        lines.push(`${DETAIL_INDENT}via ${abbr(op.marketplace)}`);
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
 * State tags are padded to equal width for column alignment:
 *   [ ok  ]   present
 *   [miss ]   missing
 *   [drift]   drift — detail appended when provided
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
        lines.push(`  [ ok  ]  ${entry.id}  (${entry.nature})`);
        break;
      }
      case 'missing': {
        lines.push(`  [miss ]  ${entry.id}  (${entry.nature})`);
        break;
      }
      case 'drift': {
        const detail = entry.detail === undefined ? '' : `  — ${entry.detail}`;
        lines.push(`  [drift]  ${entry.id}  (${entry.nature})${detail}`);
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
