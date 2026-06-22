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
import type { RemovalOp, Report, Scope, WriteOp } from '@agent-rigger/core';

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
      case 'merge-hooks': {
        lines.push(`  ${padVerb('hook')} ${op.event}/${op.matcher}  ${abbr(op.path)}`);
        lines.push(`${DETAIL_INDENT}${op.command}`);
        break;
      }
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------

/**
 * Options passed to renderRemovalPlan.
 */
export interface RenderRemovalPlanOpts {
  home?: string;
  cwd?: string;
}

/**
 * Render a human-readable removal plan from a list of RemovalOps.
 *
 * Format:
 *   Removal plan (N change(s)):
 *
 *     <verb>   <abbreviated-target>
 *                <detail line(s)>
 *
 * Verbs (ASCII, fixed width):
 *   un-deny    remove-deny
 *   un-import  remove-block
 *   delete     delete-file
 *   unlink     unlink
 *   uninstall  plugin-uninstall
 *
 * Returns "Nothing to remove — not installed." when `ops` is empty.
 */
export function renderRemovalPlan(ops: RemovalOp[], opts: RenderRemovalPlanOpts = {}): string {
  if (ops.length === 0) {
    return 'Nothing to remove — not installed.';
  }

  const abbr = (p: string): string => abbreviatePath(p, opts);

  const n = ops.length;
  const header = `Removal plan (${n} ${n === 1 ? 'change' : 'changes'}):`;
  const lines: string[] = [header, ''];

  for (const op of ops) {
    switch (op.kind) {
      case 'remove-deny': {
        lines.push(`  ${padVerb('un-deny')} ${abbr(op.path)}`);
        for (const rule of op.rules) {
          lines.push(`${DETAIL_INDENT}- ${rule}`);
        }
        break;
      }
      case 'remove-block': {
        lines.push(`  ${padVerb('un-import')} ${abbr(op.path)}`);
        break;
      }
      case 'delete-file': {
        lines.push(`  ${padVerb('delete')} ${abbr(op.path)}`);
        break;
      }
      case 'unlink': {
        lines.push(`  ${padVerb('unlink')} ${abbr(op.target)}`);
        break;
      }
      case 'plugin-uninstall': {
        lines.push(`  ${padVerb('uninstall')} ${op.plugin}`);
        break;
      }
      case 'remove-hooks': {
        lines.push(`  ${padVerb('un-hook')} ${op.event}/${op.matcher}  ${abbr(op.path)}`);
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
// renderEntryInfo — pure single-entry detail view
// ---------------------------------------------------------------------------

/** Options for renderEntryInfo. */
export interface RenderEntryInfoOpts {
  /** Whether this entry is installed in the manifest. */
  installed?: boolean;
}

/**
 * Render a detailed view of a single catalog entry.
 *
 * Format:
 *   <id>  (<nature>)
 *     status:   installed | available
 *     source:   internal | external
 *     targets:  claude, ...
 *     scopes:   user, project, ...
 *     level:    required | recommended   (artifact only, when present)
 *     requires: id1, id2, ...            (artifact only, when present)
 *     members:  id1, id2, ...            (pack only)
 *
 * No emoji.
 */
export function renderEntryInfo(entry: CatalogEntry, opts: RenderEntryInfoOpts = {}): string {
  const status = opts.installed === true ? 'installed' : 'available';
  const natureLabel = entry.kind === 'pack' ? 'pack' : entry.nature;
  const lines: string[] = [];

  lines.push(`${entry.id}  (${natureLabel})`);
  lines.push(`  status:   ${status}`);
  lines.push(`  source:   ${entry.source}`);
  lines.push(`  targets:  ${entry.targets.join(', ')}`);
  lines.push(`  scopes:   ${entry.scopes.join(', ')}`);

  if (entry.kind === 'artifact') {
    if (entry.level !== undefined) {
      lines.push(`  level:    ${entry.level}`);
    }
    if (entry.requires !== undefined && entry.requires.length > 0) {
      lines.push(`  requires: ${entry.requires.join(', ')}`);
    }
  }

  if (entry.kind === 'pack') {
    lines.push(`  members:  ${entry.members.join(', ')}`);
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

// ---------------------------------------------------------------------------
// renderCatalogList — pure catalog listing
// ---------------------------------------------------------------------------

/** Options for renderCatalogList. */
export interface RenderCatalogListOpts {
  /** Set of ids considered installed (from manifest). All available when absent. */
  installedIds?: Set<string>;
  /** Human label for filtered listing, e.g. "Skills". When absent: "Catalog". */
  label?: string;
}

/**
 * Render a human-readable catalog listing.
 *
 * For each entry, one aligned line:
 *   <status-tag>  <id>  <nature|pack>  <hint>
 *
 * Status tags are padded to equal width:
 *   [installed]  — id present in installedIds.
 *   [available]  — id absent from installedIds.
 *
 * Hint:
 *   - artifact with level  → level string (e.g. "required").
 *   - artifact without level → source string (e.g. "internal").
 *   - pack                 → "(N members)".
 *
 * Header: "Catalog (N entries):" or "<label> (N):" when label is provided.
 */
export function renderCatalogList(
  entries: CatalogEntry[],
  opts: RenderCatalogListOpts = {},
): string {
  const { installedIds, label } = opts;

  const n = entries.length;
  const entryWord = n === 1 ? 'entry' : 'entries';
  const header = label === undefined ? `Catalog (${n} ${entryWord}):` : `${label} (${n}):`;

  // Status tag strings — pad to equal width.
  const INSTALLED = '[installed]';
  const AVAILABLE = '[available]';
  // Both are 11 chars; keep explicit pad so future changes stay consistent.
  const TAG_WIDTH = Math.max(INSTALLED.length, AVAILABLE.length);

  const tagFor = (id: string): string => {
    const installed = installedIds !== undefined && installedIds.has(id);
    const raw = installed ? INSTALLED : AVAILABLE;
    return raw.padEnd(TAG_WIDTH);
  };

  // Build rows first, then pad the id and nature columns to their max width so
  // every column lines up regardless of id/nature length.
  const rows = entries.map((entry) => {
    const nature = entry.kind === 'pack' ? 'pack' : entry.nature;
    const hint = entry.kind === 'pack'
      ? `(${entry.members.length} members)`
      : (entry.level ?? entry.source);
    return { tag: tagFor(entry.id), id: entry.id, nature, hint };
  });

  const idWidth = Math.max(0, ...rows.map((r) => r.id.length));
  const natureWidth = Math.max(0, ...rows.map((r) => r.nature.length));

  const lines = [
    header,
    ...rows.map(
      (r) => `  ${r.tag}  ${r.id.padEnd(idWidth)}  ${r.nature.padEnd(natureWidth)}  ${r.hint}`,
    ),
  ];

  return lines.join('\n');
}

// ---------------------------------------------------------------------------

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
