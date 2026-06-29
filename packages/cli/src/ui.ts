/**
 * UI layer for the agent-rigger CLI.
 *
 * Responsibilities:
 *  - Pure rendering: renderPlan, renderRemovalPlan, renderReport (fully testable, no I/O).
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

// ---------------------------------------------------------------------------
// Group types — new terraform-style plan model
// ---------------------------------------------------------------------------

/**
 * One artefact group in the install plan.
 * Produced by cmd-install; consumed by renderPlan.
 */
export interface PlanGroup {
  /** Qualified artefact id, e.g. 'principal/guardrail:claude'. */
  id: string;
  /** Nature string, e.g. 'guardrail'. */
  nature: string;
  /** '+' when absent from pre-run manifest, '~' when already tracked. */
  action: 'install' | 'update';
  /** Ops planned by the adapter for this artefact. */
  ops: WriteOp[];
}

/**
 * One artefact group in the removal plan.
 * Produced by cmd-remove; consumed by renderRemovalPlan.
 */
export interface PlanRemovalGroup {
  id: string;
  nature: string;
  /** Removal ops planned by the adapter. Action is implicitly 'remove'. */
  ops: RemovalOp[];
}

// ---------------------------------------------------------------------------
// RenderPlanOpts / RenderRemovalPlanOpts
// ---------------------------------------------------------------------------

/**
 * Options passed to renderPlan.
 */
export interface RenderPlanOpts {
  home?: string;
  cwd?: string;
  /** Installation scope — shown in the plan header when provided. */
  scope?: Scope;
  /**
   * Enable ANSI colour codes.
   * Defaults to `process.stdout.isTTY === true && process.env.NO_COLOR === undefined`.
   * Pass `color: false` in tests to get deterministic plain-text output.
   */
  color?: boolean;
  /** Maximum detail lines rendered per op before truncation. Defaults to 6. */
  maxDetail?: number;
}

/**
 * Options passed to renderRemovalPlan.
 */
export interface RenderRemovalPlanOpts {
  home?: string;
  cwd?: string;
  scope?: Scope;
  color?: boolean;
  maxDetail?: number;
}

// ---------------------------------------------------------------------------
// Re-exports — callers can use these wrappers instead of importing clack directly
// ---------------------------------------------------------------------------

export { cancel, intro, isCancel, note, outro, spinner };

// ---------------------------------------------------------------------------
// ANSI colour helpers (hand-rolled — zero external deps)
// ---------------------------------------------------------------------------

const ANSI = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
} as const;

/**
 * Wrap `s` with an ANSI escape code when `on` is true.
 * Returns `s` unchanged when `on` is false — deterministic for tests.
 */
function paint(s: string, code: string, on: boolean): string {
  return on ? `${code}${s}${ANSI.reset}` : s;
}

// ---------------------------------------------------------------------------
// Internal helpers for group rendering
// ---------------------------------------------------------------------------

/**
 * Return the primary target string for a group header line.
 * Priority: link > merge-hooks > path-based ops > plugin-install.
 */
function getGroupPrimaryTarget(ops: WriteOp[], abbr: (p: string) => string): string {
  for (const op of ops) {
    if (op.kind === 'link') return abbr(op.target);
  }
  for (const op of ops) {
    if (op.kind === 'merge-hooks') {
      const hookSuffix = op.scriptStore === undefined
        ? ''
        : ` (+ ${op.scriptStore.split('/').pop() ?? ''})`;
      return `${abbr(op.path)}${hookSuffix}`;
    }
  }
  for (const op of ops) {
    if (
      op.kind === 'merge-deny'
      || op.kind === 'merge-allow'
      || op.kind === 'write-text'
      || op.kind === 'write-json'
      || op.kind === 'ensure-import'
    ) {
      return abbr(op.path);
    }
  }
  for (const op of ops) {
    if (op.kind === 'plugin-install') return op.plugin;
  }
  return '';
}

/**
 * Return the primary target string for a removal group header line.
 */
function getRemovalGroupPrimaryTarget(ops: RemovalOp[], abbr: (p: string) => string): string {
  for (const op of ops) {
    if (op.kind === 'unlink') return abbr(op.target);
  }
  for (const op of ops) {
    if (
      op.kind === 'remove-deny'
      || op.kind === 'remove-allow'
      || op.kind === 'remove-block'
      || op.kind === 'delete-file'
      || op.kind === 'remove-hooks'
    ) {
      return abbr(op.path);
    }
  }
  for (const op of ops) {
    if (op.kind === 'plugin-uninstall') return op.plugin;
  }
  return '';
}

// ---------------------------------------------------------------------------
// renderPlan — grouped terraform-style diff
// ---------------------------------------------------------------------------

/**
 * Render a terraform-style install plan grouped by artefact.
 *
 * Format (variante A):
 *   Plan · N changes · scope: user (~/.claude)
 *
 *   + guardrail:claude   ~/.claude/settings.json
 *     deny  (+11)
 *        + Bash(rm -rf /)
 *        … +5 more
 *
 *   Σ  deny +11 · 1 write · 2 links
 *
 * Returns "Nothing to apply — already up to date." when groups is empty.
 */
export function renderPlan(groups: PlanGroup[], opts: RenderPlanOpts = {}): string {
  if (groups.length === 0) {
    return 'Nothing to apply — already up to date.';
  }

  const colorOn = opts.color
    ?? (process.stdout.isTTY === true && process.env.NO_COLOR === undefined);
  const maxDetail = opts.maxDetail ?? 6;
  const abbr = (p: string): string => abbreviatePath(p, opts);

  const totalOps = groups.reduce((s, g) => s + g.ops.length, 0);

  let scopePart = '';
  if (opts.scope !== undefined) {
    let root = '';
    if (opts.scope === 'user' && opts.home !== undefined && opts.home !== '') {
      root = ` (${abbr(opts.home + '/.claude')})`;
    } else if (opts.scope === 'project' && opts.cwd !== undefined && opts.cwd !== '') {
      root = ` (${abbr(opts.cwd + '/.claude')})`;
    }
    scopePart = ` · scope: ${opts.scope}${root}`;
  }

  const changeWord = totalOps === 1 ? 'change' : 'changes';
  const lines: string[] = [`Plan · ${totalOps} ${changeWord}${scopePart}`, ''];

  // Σ counters
  let denyCount = 0;
  let allowCount = 0;
  let writeCount = 0;
  let importCount = 0;
  let hooksCount = 0;
  let linksCount = 0;
  let pluginsCount = 0;

  for (const group of groups) {
    const sym = group.action === 'install' ? '+' : '~';
    const symColor = group.action === 'install' ? ANSI.green : ANSI.yellow;
    const symStr = paint(sym, symColor, colorOn);
    const idStr = paint(group.id, ANSI.bold, colorOn);
    const primaryTarget = getGroupPrimaryTarget(group.ops, abbr);
    const primaryStr = primaryTarget === '' ? '' : `   ${primaryTarget}`;

    lines.push(`${symStr} ${idStr}${primaryStr}`);

    for (const op of group.ops) {
      switch (op.kind) {
        case 'merge-deny': {
          denyCount += op.toAdd.length;
          lines.push(`  deny  (+${op.toAdd.length})`);
          const shownDeny = op.toAdd.slice(0, maxDetail);
          const remainDeny = op.toAdd.length - shownDeny.length;
          for (const rule of shownDeny) {
            lines.push(`     + ${paint(rule, ANSI.green, colorOn)}`);
          }
          if (remainDeny > 0) {
            lines.push(`     … +${remainDeny} more`);
          }
          break;
        }
        case 'merge-allow': {
          allowCount += op.toAdd.length;
          lines.push(`  allow  (+${op.toAdd.length})`);
          const shownAllow = op.toAdd.slice(0, maxDetail);
          const remainAllow = op.toAdd.length - shownAllow.length;
          for (const rule of shownAllow) {
            lines.push(`     + ${paint(rule, ANSI.green, colorOn)}`);
          }
          if (remainAllow > 0) {
            lines.push(`     … +${remainAllow} more`);
          }
          break;
        }
        case 'write-text': {
          writeCount++;
          const contentLines = op.content === '' ? [] : op.content.replace(/\n$/, '').split('\n');
          const lineCount = contentLines.length;
          lines.push(`  write  +${lineCount} / -0`);
          const shownWrite = contentLines.slice(0, maxDetail);
          const remainWrite = lineCount - shownWrite.length;
          for (const l of shownWrite) {
            lines.push(`     ${paint('│', ANSI.dim, colorOn)} ${l}`);
          }
          if (remainWrite > 0) {
            lines.push(`     ${paint('│', ANSI.dim, colorOn)} …`);
          }
          break;
        }
        case 'write-json': {
          writeCount++;
          lines.push(`  write  ${abbr(op.path)}`);
          break;
        }
        case 'ensure-import': {
          importCount++;
          lines.push(`  import  ${op.importLine}`);
          break;
        }
        case 'link': {
          linksCount++;
          lines.push(`  link  ${abbr(op.target)} → store`);
          break;
        }
        case 'plugin-install': {
          pluginsCount++;
          lines.push(`  plugin  ${op.plugin}`);
          lines.push(`     via ${abbr(op.marketplace)}`);
          break;
        }
        case 'merge-hooks': {
          hooksCount++;
          const cmdParts = op.command.trim().split(/\s+/);
          const cmdLast = cmdParts.at(-1) ?? '';
          const scriptName = cmdLast.split('/').pop() ?? cmdLast;
          lines.push(`  hook  ${op.event}/${op.matcher} → ${scriptName}`);
          if (op.scriptStore !== undefined) {
            lines.push(`  link  ${abbr(op.scriptStore)}`);
          }
          break;
        }
      }
    }

    lines.push('');
  }

  // Σ summary line
  const sigmaParts: string[] = [];
  if (denyCount > 0) sigmaParts.push(`deny +${denyCount}`);
  if (allowCount > 0) sigmaParts.push(`allow +${allowCount}`);
  if (writeCount > 0) sigmaParts.push(`${writeCount} write${writeCount > 1 ? 's' : ''}`);
  if (importCount > 0) sigmaParts.push(`${importCount} import${importCount > 1 ? 's' : ''}`);
  if (hooksCount > 0) sigmaParts.push(`${hooksCount} hook${hooksCount > 1 ? 's' : ''}`);
  if (linksCount > 0) sigmaParts.push(`${linksCount} link${linksCount > 1 ? 's' : ''}`);
  if (pluginsCount > 0) sigmaParts.push(`${pluginsCount} plugin${pluginsCount > 1 ? 's' : ''}`);

  if (sigmaParts.length > 0) {
    lines.push(`${paint('Σ', ANSI.bold, colorOn)}  ${sigmaParts.join(' · ')}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// renderRemovalPlan — grouped terraform-style removal diff
// ---------------------------------------------------------------------------

/**
 * Render a terraform-style removal plan grouped by artefact.
 *
 * Format (variante A):
 *   Removal plan · N changes · scope: user (~/.claude)
 *
 *   - guardrail:claude   ~/.claude/settings.json
 *     deny  (-3)
 *        - Read(./.env)
 *
 *   Σ  deny -3 · 1 delete
 *
 * Returns "Nothing to remove — not installed." when groups is empty.
 */
export function renderRemovalPlan(
  groups: PlanRemovalGroup[],
  opts: RenderRemovalPlanOpts = {},
): string {
  if (groups.length === 0) {
    return 'Nothing to remove — not installed.';
  }

  const colorOn = opts.color
    ?? (process.stdout.isTTY === true && process.env.NO_COLOR === undefined);
  const maxDetail = opts.maxDetail ?? 6;
  const abbr = (p: string): string => abbreviatePath(p, opts);

  const totalOps = groups.reduce((s, g) => s + g.ops.length, 0);

  let scopePart = '';
  if (opts.scope !== undefined) {
    let root = '';
    if (opts.scope === 'user' && opts.home !== undefined && opts.home !== '') {
      root = ` (${abbr(opts.home + '/.claude')})`;
    } else if (opts.scope === 'project' && opts.cwd !== undefined && opts.cwd !== '') {
      root = ` (${abbr(opts.cwd + '/.claude')})`;
    }
    scopePart = ` · scope: ${opts.scope}${root}`;
  }

  const changeWord = totalOps === 1 ? 'change' : 'changes';
  const lines: string[] = [`Removal plan · ${totalOps} ${changeWord}${scopePart}`, ''];

  // Σ counters
  let denyCount = 0;
  let allowCount = 0;
  let deleteCount = 0;
  let unimportCount = 0;
  let hooksCount = 0;
  let unlinksCount = 0;
  let pluginsCount = 0;

  for (const group of groups) {
    const symStr = paint('-', ANSI.red, colorOn);
    const idStr = paint(group.id, ANSI.bold, colorOn);
    const primaryTarget = getRemovalGroupPrimaryTarget(group.ops, abbr);
    const primaryStr = primaryTarget === '' ? '' : `   ${primaryTarget}`;

    lines.push(`${symStr} ${idStr}${primaryStr}`);

    for (const op of group.ops) {
      switch (op.kind) {
        case 'remove-deny': {
          denyCount += op.rules.length;
          lines.push(`  deny  (-${op.rules.length})`);
          const shownDeny = op.rules.slice(0, maxDetail);
          const remainDeny = op.rules.length - shownDeny.length;
          for (const rule of shownDeny) {
            lines.push(`     - ${paint(rule, ANSI.red, colorOn)}`);
          }
          if (remainDeny > 0) {
            lines.push(`     … -${remainDeny} more`);
          }
          break;
        }
        case 'remove-allow': {
          allowCount += op.rules.length;
          lines.push(`  allow  (-${op.rules.length})`);
          const shownAllow = op.rules.slice(0, maxDetail);
          const remainAllow = op.rules.length - shownAllow.length;
          for (const rule of shownAllow) {
            lines.push(`     - ${paint(rule, ANSI.red, colorOn)}`);
          }
          if (remainAllow > 0) {
            lines.push(`     … -${remainAllow} more`);
          }
          break;
        }
        case 'remove-block': {
          unimportCount++;
          lines.push(`  unimport  ${abbr(op.path)}`);
          break;
        }
        case 'delete-file': {
          deleteCount++;
          lines.push(`  delete  ${abbr(op.path)}`);
          break;
        }
        case 'unlink': {
          unlinksCount++;
          lines.push(`  unlink  ${abbr(op.target)}`);
          break;
        }
        case 'plugin-uninstall': {
          pluginsCount++;
          lines.push(`  uninstall  ${op.plugin}`);
          break;
        }
        case 'remove-hooks': {
          hooksCount++;
          lines.push(`  un-hook  ${op.event}/${op.matcher}`);
          break;
        }
      }
    }

    lines.push('');
  }

  // Σ summary line
  const sigmaParts: string[] = [];
  if (denyCount > 0) sigmaParts.push(`deny -${denyCount}`);
  if (allowCount > 0) sigmaParts.push(`allow -${allowCount}`);
  if (deleteCount > 0) sigmaParts.push(`${deleteCount} delete${deleteCount > 1 ? 's' : ''}`);
  if (unimportCount > 0) {
    sigmaParts.push(`${unimportCount} unimport${unimportCount > 1 ? 's' : ''}`);
  }
  if (hooksCount > 0) sigmaParts.push(`${hooksCount} hook${hooksCount > 1 ? 's' : ''}`);
  if (unlinksCount > 0) sigmaParts.push(`${unlinksCount} unlink${unlinksCount > 1 ? 's' : ''}`);
  if (pluginsCount > 0) sigmaParts.push(`${pluginsCount} plugin${pluginsCount > 1 ? 's' : ''}`);

  if (sigmaParts.length > 0) {
    lines.push(`${paint('Σ', ANSI.bold, colorOn)}  ${sigmaParts.join(' · ')}`);
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

// ---------------------------------------------------------------------------
// selectArtifactsWithDefaults — post-init catalog proposal picker
// ---------------------------------------------------------------------------

/**
 * Options for selectArtifactsWithDefaults.
 *
 * - required     : ids that are forced into the result (cannot be effectively unchecked).
 *                  Displayed as pre-checked in the picker; re-added to the result even
 *                  if the user unchecks them.
 * - recommended  : ids that are pre-checked but can be deselected by the user.
 */
export interface SelectWithDefaultsOpts {
  required: Set<string>;
  recommended: Set<string>;
}

/**
 * Post-init multiselect picker with pre-checked defaults and forced required ids.
 *
 * Behaviour:
 * - Entries in `required`    → initially checked; always included in the returned ids
 *   (enforced after the picker returns, so even if the user unchecks them they come back).
 *   On CANCEL the full proposal is abandoned — returns [] (no install at all).
 * - Entries in `recommended` → initially checked; can be unchecked by the user.
 * - Remaining entries        → initially unchecked.
 *
 * Cancellation (isCancel): returns [] — the user chose to install nothing.
 * The `required` enforcement only applies to a CONFIRMED selection, not an abort.
 *
 * Note: `enforceRequired` is inlined to avoid a circular dependency with
 * cmd-init; callers (bin/cli.ts) should use this together with cmd-init's helpers.
 */
export async function selectArtifactsWithDefaults(
  entries: CatalogEntry[],
  opts: SelectWithDefaultsOpts,
): Promise<string[]> {
  const { required, recommended } = opts;

  // Build the picker: pre-check required ∪ recommended; mark required with a hint.
  const initialChecked = new Set([...required, ...recommended]);
  const options = entries.map((e) =>
    required.has(e.id)
      ? { value: e.id, label: `${e.id}  [required]`, hint: 'required' }
      : { value: e.id, label: e.id }
  );

  const result = await multiselect<string>({
    message: 'Select artifacts to install (required items are always included):',
    options,
    initialValues: entries.filter((e) => initialChecked.has(e.id)).map((e) => e.id),
    required: false,
  });

  if (isCancel(result)) {
    cancel('Operation cancelled.');
    // Abort = install nothing at all (the user opted out of the entire proposal).
    // `required` enforcement only applies to a confirmed selection, not an abort.
    return [];
  }

  // Enforce: re-add any required ids that were unchecked.
  const seen = new Set(result);
  const enforced = [...result];
  for (const id of required) {
    if (!seen.has(id)) {
      enforced.push(id);
    }
  }
  return enforced;
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
 *   - artifact without level → empty string.
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
      : (entry.level ?? '');
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
