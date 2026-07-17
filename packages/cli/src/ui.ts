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
  groupMultiselect,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
  select,
  spinner,
} from '@clack/prompts';

import type { CatalogEntry } from '@agent-rigger/catalog';
import type {
  Assistant,
  Finding,
  FindingClass,
  RemovalOp,
  RepairOp,
  RepairOutcome,
  Report,
  Scope,
  WriteOp,
} from '@agent-rigger/core';
import { assistantRoot, isReportOnly } from '@agent-rigger/core';
import { assertNever } from '@agent-rigger/core/assert-never';

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
   * Target assistant (R5) — the plan header's root path is derived from this
   * (via `assistantRoot`) instead of assuming `.claude`. Defaults to 'claude'
   * for backward compatibility with callers that don't pass it.
   */
  assistant?: Assistant;
  /**
   * Enable ANSI colour codes.
   * Defaults to `process.stdout.isTTY === true && process.env.NO_COLOR === undefined`.
   * Pass `color: false` in tests to get deterministic plain-text output.
   */
  color?: boolean;
  /** Maximum detail lines rendered per op before truncation. Defaults to 6. */
  maxDetail?: number;
  /**
   * Compact mode (plan-compact-summary D1/D2): collapse each artefact's op
   * block into a single recap line (symbol + id + primary target + a per-group
   * op digest reusing the Σ vocabulary), and drop the blank separators. The
   * header and the final Σ line are unchanged, so a reader who knows one reads
   * the other. Absent/false → the full terraform-style diff (byte-identical to
   * before this option existed).
   */
  summary?: boolean;
}

/**
 * Options passed to renderRemovalPlan.
 */
export interface RenderRemovalPlanOpts {
  home?: string;
  cwd?: string;
  scope?: Scope;
  /**
   * Target assistant (R5) — see RenderPlanOpts.assistant. Defaults to
   * 'claude' for backward compatibility with callers that don't pass it.
   */
  assistant?: Assistant;
  color?: boolean;
  maxDetail?: number;
  /**
   * Fate of the shared store for each unlink op, keyed by store path (R4):
   * 'delete' — this removal drops the last reference, the store is deleted;
   * 'keep'   — another scope/assistant (or a manifest-recorded target from
   *            another cwd) still references it, the store is preserved.
   * Computed by cmd-remove from the reference candidates; when absent no store
   * line is rendered (backward compatibility for callers without a manifest).
   */
  storeFates?: Record<string, 'delete' | 'keep'>;
}

// ---------------------------------------------------------------------------
// Re-exports — callers can use these wrappers instead of importing clack directly
// ---------------------------------------------------------------------------

export { cancel, intro, isCancel, note, outro, spinner };

// ---------------------------------------------------------------------------
// ANSI colour helpers (hand-rolled — zero external deps)
// ---------------------------------------------------------------------------

export const ANSI = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
} as const;

/**
 * Wrap `s` with an ANSI escape code when `on` is true.
 * Returns `s` unchanged when `on` is false — deterministic for tests.
 */
export function paint(s: string, code: string, on: boolean): string {
  return on ? `${code}${s}${ANSI.reset}` : s;
}

/**
 * Resolve whether ANSI colour should be emitted.
 *
 * Precedence: explicit `color` flag > auto-detection.
 * Auto-detection enables colour only on a real TTY with NO_COLOR unset
 * (https://no-color.org). Pass `false` in tests for deterministic output.
 */
export function shouldColor(color?: boolean): boolean {
  return color ?? (process.stdout.isTTY === true && process.env.NO_COLOR === undefined);
}

// ---------------------------------------------------------------------------
// Internal helpers for group rendering
// ---------------------------------------------------------------------------

/**
 * Render the "(<root>)" suffix for a plan/removal-plan header's scope part
 * (R5): resolves the true root directory for `assistant`/`scope` via
 * `assistantRoot` (single source of truth, `core/paths`) instead of assuming
 * `.claude`, abbreviates it with `abbr`, and returns '' when no root is
 * resolvable (missing home/cwd for the scope, or a fail-soft assistant like
 * copilot) — same behaviour as before this option existed.
 */
function scopeRootSuffix(
  assistant: Assistant | undefined,
  scope: Scope,
  opts: { home?: string; cwd?: string },
  abbr: (p: string) => string,
): string {
  const root = assistantRoot(assistant ?? 'claude', scope, opts);
  return root === undefined ? '' : ` (${abbr(root)})`;
}

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
 * Op tallies for one artefact group (and, summed, for the whole run). A single
 * per-op switch in renderPlan feeds this — the Σ line accumulates it across
 * groups and the summary digest formats it per group, so the two can never
 * disagree (D1: divergence impossible by construction). `writeLines` carries
 * the write-text content-line count for the digest's `(+lines)` suffix; it has
 * no Σ counterpart (the Σ line shows only `N write(s)`).
 */
interface OpCounts {
  deny: number;
  allow: number;
  write: number;
  writeLines: number;
  import: number;
  hooks: number;
  links: number;
  plugins: number;
}

/** A zeroed OpCounts tally — reset at each group's open. */
function emptyOpCounts(): OpCounts {
  return { deny: 0, allow: 0, write: 0, writeLines: 0, import: 0, hooks: 0, links: 0, plugins: 0 };
}

/**
 * Format an OpCounts tally into a compact digest string, reusing the exact
 * vocabulary of the final Σ line (`deny +N`, `allow +N`, `N write(s)`,
 * `N import(s)`, `N hook(s)`, `N link(s)`, `N plugin(s)`) — plus a `(+lines)`
 * suffix on writes carrying a write-text line count, mirroring the full-mode
 * `write  +L / -0` line. Used by renderPlan's summary branch (D2) on the same
 * counts that feed Σ. A `remove-hooks` op (traced hook migration) contributes
 * no token — it increments no counter, parity with the Σ line. Returns '' for a
 * tally with no token.
 */
function formatGroupDigest(c: OpCounts): string {
  const parts: string[] = [];
  if (c.deny > 0) parts.push(`deny +${c.deny}`);
  if (c.allow > 0) parts.push(`allow +${c.allow}`);
  if (c.write > 0) {
    const lineSuffix = c.writeLines > 0 ? ` (+${c.writeLines})` : '';
    parts.push(`${c.write} write${c.write > 1 ? 's' : ''}${lineSuffix}`);
  }
  if (c.import > 0) parts.push(`${c.import} import${c.import > 1 ? 's' : ''}`);
  if (c.hooks > 0) parts.push(`${c.hooks} hook${c.hooks > 1 ? 's' : ''}`);
  if (c.links > 0) parts.push(`${c.links} link${c.links > 1 ? 's' : ''}`);
  if (c.plugins > 0) parts.push(`${c.plugins} plugin${c.plugins > 1 ? 's' : ''}`);
  return parts.join(' · ');
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
      || op.kind === 'restore-file'
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

  const colorOn = shouldColor(opts.color);
  const maxDetail = opts.maxDetail ?? 6;
  const summary = opts.summary === true;
  const abbr = (p: string): string => abbreviatePath(p, opts);

  const totalOps = groups.reduce((s, g) => s + g.ops.length, 0);

  let scopePart = '';
  if (opts.scope !== undefined) {
    const root = scopeRootSuffix(opts.assistant, opts.scope, opts, abbr);
    scopePart = ` · scope: ${opts.scope}${root}`;
  }

  const changeWord = totalOps === 1 ? 'change' : 'changes';
  // Summary drops the blank after the header (and the per-group blanks below).
  const header = `Plan · ${totalOps} ${changeWord}${scopePart}`;
  const lines: string[] = summary ? [header] : [header, ''];

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

    const groupStart = lines.length;
    lines.push(`${symStr} ${idStr}${primaryStr}`);

    // Single counting site: the switch tallies this group; the run-level Σ
    // counters accumulate it at group close (below). The summary digest formats
    // the same tally — no second traversal, no divergence (D1).
    const g = emptyOpCounts();

    for (const op of group.ops) {
      switch (op.kind) {
        case 'merge-deny': {
          g.deny += op.toAdd.length;
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
          g.allow += op.toAdd.length;
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
          g.write++;
          const contentLines = op.content === '' ? [] : op.content.replace(/\n$/, '').split('\n');
          const lineCount = contentLines.length;
          g.writeLines += lineCount;
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
          g.write++;
          lines.push(`  write  ${abbr(op.path)}`);
          break;
        }
        case 'ensure-import': {
          g.import++;
          lines.push(`  import  ${op.importLine}`);
          break;
        }
        case 'link': {
          g.links++;
          lines.push(`  link  ${abbr(op.target)} → store`);
          break;
        }
        case 'plugin-install': {
          g.plugins++;
          lines.push(`  plugin  ${op.plugin}`);
          lines.push(`     via ${abbr(op.marketplace)}`);
          // obs1-R4: the plan shows the exact native commands that will be
          // spawned at apply (parity with the tool-checks display) — the
          // user must be able to read them BEFORE confirming, not discover
          // them after the fact. Verbatim: same command/args applyPlugin runs.
          lines.push(
            `     $ ${paint(`claude plugin marketplace add ${op.marketplace}`, ANSI.dim, colorOn)}`,
          );
          lines.push(
            `     $ ${paint(`claude plugin install ${op.plugin}`, ANSI.dim, colorOn)}`,
          );
          break;
        }
        case 'merge-hooks': {
          g.hooks++;
          const cmdParts = op.command.trim().split(/\s+/);
          const cmdLast = cmdParts.at(-1) ?? '';
          const scriptName = cmdLast.split('/').pop() ?? cmdLast;
          lines.push(`  hook  ${op.event}/${op.matcher} → ${scriptName}`);
          if (op.scriptStore !== undefined) {
            lines.push(`  link  ${abbr(op.scriptStore)}`);
          }
          break;
        }
        case 'remove-hooks': {
          // Traced hook migration (R1/D8): the plan retires the previously
          // installed spec before merging the new one — shown so the confirm
          // prompt tells the whole story of the run.
          const cmdParts = op.command.trim().split(/\s+/);
          const cmdLast = cmdParts.at(-1) ?? '';
          const scriptName = cmdLast.split('/').pop() ?? cmdLast;
          lines.push(
            `  ${
              paint('unhook', ANSI.yellow, colorOn)
            }  ${op.event}/${op.matcher} → ${scriptName} (spec changed)`,
          );
          break;
        }
      }
    }

    // Fold this group's tally into the run-level Σ counters — the ONLY place
    // the Σ totals grow, from the same increments the digest reads.
    denyCount += g.deny;
    allowCount += g.allow;
    writeCount += g.write;
    importCount += g.import;
    hooksCount += g.hooks;
    linksCount += g.links;
    pluginsCount += g.plugins;

    if (summary) {
      // Collapse the whole group block (the header + the detail lines the switch
      // just pushed) into a single recap line, formatted from the same tally the
      // Σ line derives from.
      lines.length = groupStart;
      const digest = formatGroupDigest(g);
      const digestStr = digest === '' ? '' : `   ${digest}`;
      lines.push(`${symStr} ${idStr}${primaryStr}${digestStr}`);
    } else {
      lines.push('');
    }
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

  const colorOn = shouldColor(opts.color);
  const maxDetail = opts.maxDetail ?? 6;
  const abbr = (p: string): string => abbreviatePath(p, opts);

  const totalOps = groups.reduce((s, g) => s + g.ops.length, 0);

  let scopePart = '';
  if (opts.scope !== undefined) {
    const root = scopeRootSuffix(opts.assistant, opts.scope, opts, abbr);
    scopePart = ` · scope: ${opts.scope}${root}`;
  }

  const changeWord = totalOps === 1 ? 'change' : 'changes';
  const lines: string[] = [`Removal plan · ${totalOps} ${changeWord}${scopePart}`, ''];

  // Σ counters
  let denyCount = 0;
  let allowCount = 0;
  let deleteCount = 0;
  let restoreCount = 0;
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
        case 'restore-file': {
          // R6: the confirmation must state that the file returns to its
          // pre-install content — a "delete" line here would misrepresent
          // what the remove actually does.
          restoreCount++;
          lines.push(`  restore  ${abbr(op.path)}`);
          break;
        }
        case 'unlink': {
          unlinksCount++;
          lines.push(`  unlink  ${abbr(op.target)}`);
          // R4: the confirmation must state what is actually destroyed — the
          // shared store's fate is part of the preview, not a surprise.
          const fate = opts.storeFates?.[op.store];
          if (fate === 'delete') {
            lines.push(
              `  store   ${abbr(op.store)}  ${
                paint('(deleted — last reference)', ANSI.red, colorOn)
              }`,
            );
          } else if (fate === 'keep') {
            lines.push(
              `  store   ${abbr(op.store)}  ${
                paint('(kept — still referenced)', ANSI.dim, colorOn)
              }`,
            );
          }
          break;
        }
        case 'plugin-uninstall': {
          pluginsCount++;
          lines.push(`  uninstall  ${op.plugin}`);
          // obs1-R4: verbatim parity — same command applyRemovePlugin runs.
          lines.push(
            `     $ ${paint(`claude plugin uninstall ${op.plugin}`, ANSI.dim, colorOn)}`,
          );
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
  if (restoreCount > 0) sigmaParts.push(`${restoreCount} restore${restoreCount > 1 ? 's' : ''}`);
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

/** Options for renderReport. */
export interface RenderReportOpts {
  /**
   * Enable ANSI colour codes.
   * Defaults to TTY auto-detection (see {@link shouldColor}).
   * Pass `false` in tests for deterministic plain-text output.
   */
  color?: boolean;
}

/**
 * Render an audit Report as a human-readable status list.
 *
 * State tags are padded to equal width for column alignment, and colourised
 * as a contiguous unit (green/red/yellow/cyan) so substring assertions stay
 * stable:
 *   [ ok  ]   present  (green)
 *   [miss ]   missing  (red)
 *   [drift]   drift    (yellow) — detail appended when provided
 *   [ ?   ]   unknown  (cyan)   — advisory, detail appended when provided;
 *     never counted as drift by reportExitCode (engine.ts)
 *
 * Returns a "no entries" message when entries is empty.
 */
export function renderReport(report: Report, opts: RenderReportOpts = {}): string {
  if (report.entries.length === 0) {
    return 'Audit complete — no entries to report.';
  }

  const colorOn = shouldColor(opts.color);
  const lines: string[] = [];

  for (const entry of report.entries) {
    switch (entry.state) {
      case 'present': {
        lines.push(`  ${paint('[ ok  ]', ANSI.green, colorOn)}  ${entry.id}  (${entry.nature})`);
        break;
      }
      case 'missing': {
        lines.push(`  ${paint('[miss ]', ANSI.red, colorOn)}  ${entry.id}  (${entry.nature})`);
        break;
      }
      case 'drift': {
        const detail = entry.detail === undefined ? '' : `  — ${entry.detail}`;
        lines.push(
          `  ${paint('[drift]', ANSI.yellow, colorOn)}  ${entry.id}  (${entry.nature})${detail}`,
        );
        break;
      }
      case 'unknown': {
        const detail = entry.detail === undefined ? '' : `  — ${entry.detail}`;
        lines.push(
          `  ${paint('[ ?   ]', ANSI.cyan, colorOn)}  ${entry.id}  (${entry.nature})${detail}`,
        );
        break;
      }
      default:
        assertNever(entry.state);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// renderDoctorReport — grouped installed-state findings (doctor R8)
// ---------------------------------------------------------------------------

/** Human label + display order for each finding class (R8 grouped report). */
const DOCTOR_CLASS_ORDER: { class: FindingClass; label: string }[] = [
  { class: 'untracked', label: 'Untracked artifacts' },
  { class: 'dangling', label: 'Dangling symlinks' },
  { class: 'phantom', label: 'Phantom stores' },
  { class: 'manifest', label: 'Manifest issues' },
  { class: 'lock', label: 'Run lock' },
  { class: 'hygiene', label: 'Hygiene' },
];

/** Options for renderDoctorReport. */
export interface RenderDoctorReportOpts {
  /** Enable ANSI colour. Defaults to TTY auto-detection; pass false in tests. */
  color?: boolean;
}

/**
 * The consent tag shown after a repairable finding: `[fix]` for a `safe` op
 * (`--yes` suffices), `[confirm]` for an `item-confirm` op (per-item
 * confirmation, never `--yes` alone), `[report]` for a report-only finding
 * (no repair — the summary carries the manual way out).
 */
function repairTag(finding: Finding, colorOn: boolean): string {
  if (isReportOnly(finding)) return paint('[report]', ANSI.dim, colorOn);
  const op = (finding as Extract<Finding, { repair: RepairOp }>).repair;
  return op.consent === 'safe'
    ? paint('[fix]', ANSI.green, colorOn)
    : paint('[confirm]', ANSI.yellow, colorOn);
}

/**
 * Render the installed-state findings grouped by class (R8). Pure — no I/O.
 * Returns a "healthy" line when there are no findings. Each finding is one
 * line: a marker, its `summary`, and a consent/report tag; report-only
 * findings carry their manual way out inside the summary itself — except
 * host-diff findings, whose generic summary is completed by a `detail`
 * naming the element, its catalog and the manual ways out, rendered as an
 * indented dim line right under the summary.
 */
export function renderDoctorReport(findings: Finding[], opts: RenderDoctorReportOpts = {}): string {
  const colorOn = shouldColor(opts.color);

  if (findings.length === 0) {
    return paint('Installed state is healthy — no findings.', ANSI.green, colorOn);
  }

  const n = findings.length;
  const word = n === 1 ? 'finding' : 'findings';
  const lines: string[] = [`Installed-state check · ${n} ${word}`, ''];

  for (const { class: cls, label } of DOCTOR_CLASS_ORDER) {
    const group = findings.filter((f) => f.class === cls);
    if (group.length === 0) continue;

    lines.push(paint(`${label} (${group.length})`, ANSI.bold, colorOn));
    for (const finding of group) {
      const marker = isReportOnly(finding)
        ? paint('~', ANSI.dim, colorOn)
        : paint('+', ANSI.cyan, colorOn);
      lines.push(`  ${marker} ${finding.summary}  ${repairTag(finding, colorOn)}`);
      if ('detail' in finding && typeof finding.detail === 'string' && finding.detail !== '') {
        lines.push(paint(`      ${finding.detail}`, ANSI.dim, colorOn));
      }
    }
    lines.push('');
  }

  return lines.join('\n').replace(/\n+$/, '');
}

// ---------------------------------------------------------------------------
// renderRepairOutcomes — the --fix result list (doctor R8)
// ---------------------------------------------------------------------------

/** Options for renderRepairOutcomes. */
export interface RenderRepairOutcomesOpts {
  color?: boolean;
}

/** One-line description of a repair op for the outcome list. */
function opLabel(op: RepairOp): string {
  switch (op.kind) {
    case 'adopt':
      return `adopt ${op.candidateId}`;
    case 'unlink-dangling':
      return `unlink ${op.target}`;
    case 'remove-store':
      return `remove store ${op.store}`;
    case 'break-lock':
      return `break lock ${op.lockPath}`;
    case 'delete-residue':
      return `delete residue ${op.path}`;
    case 'delete-bak':
      return `delete backup ${op.path}`;
    case 'backup-state':
      return `back up ${op.path}`;
    default:
      return assertNever(op);
  }
}

/**
 * Render the `applyRepairs` outcomes (R8). Pure — no I/O. `repaired` shows in
 * green, `skipped` (TOCTOU refusal / declined / ambiguous id) in yellow,
 * `failed` in red. Returns an empty string when there were no outcomes (the
 * caller prints its own "nothing to repair" line).
 */
export function renderRepairOutcomes(
  outcomes: RepairOutcome[],
  opts: RenderRepairOutcomesOpts = {},
): string {
  if (outcomes.length === 0) return '';

  const colorOn = shouldColor(opts.color);
  const lines: string[] = [paint('Repairs', ANSI.bold, colorOn)];

  for (const outcome of outcomes) {
    const label = opLabel(outcome.op);
    switch (outcome.status) {
      case 'repaired':
        lines.push(
          `  ${paint('[ ok  ]', ANSI.green, colorOn)}  ${label}${
            outcome.detail === undefined ? '' : `  — ${outcome.detail}`
          }`,
        );
        break;
      case 'skipped':
        lines.push(
          `  ${paint('[skip ]', ANSI.yellow, colorOn)}  ${label}  — ${outcome.reason}`,
        );
        break;
      case 'failed':
        lines.push(
          `  ${paint('[fail ]', ANSI.red, colorOn)}  ${label}  — ${outcome.error}`,
        );
        break;
      default:
        assertNever(outcome);
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
 * Thrown by every interactive prompt in this module — and by
 * assistant-select.ts / secret-collect.ts, which migrate their own
 * `throw new Error(...)` to it — when the user cancels via Ctrl+C
 * (clack's `isCancel`). `handleError` (cli.ts) maps it to exit 130 without
 * re-printing a message: the `cancel()` call already printed clack's own
 * cancellation line (R2, ADR-0024).
 *
 * Cancelling is an INTERRUPTION, not a refusal: it carries no default value,
 * triggers no further I/O (no network, no write), and is distinct from a
 * confirmed negative/empty response — which returns normally and lets the
 * caller decide (e.g. exit 0 for `confirmApply`'s "no", or a submitted empty
 * multiselect).
 */
export class CancelledError extends Error {
  constructor(message = 'Operation cancelled.') {
    super(message);
    this.name = 'CancelledError';
  }
}

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
    throw new CancelledError();
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
 *   On CANCEL (Ctrl+C) the proposal is interrupted — throws CancelledError (R2).
 * - Entries in `recommended` → initially checked; can be unchecked by the user.
 * - Remaining entries        → initially unchecked.
 *
 * Cancellation (isCancel): throws CancelledError (R2) — handleError maps it to
 * exit 130. The `required` enforcement only applies to a CONFIRMED selection,
 * not a cancellation.
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
    // Cancellation (R2): the caller (handleError) maps CancelledError to exit
    // 130. `required` enforcement only applies to a confirmed selection.
    throw new CancelledError();
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

// ---------------------------------------------------------------------------
// selectArtifactsByStatus — status-aware grouped install/update picker
// ---------------------------------------------------------------------------

/** Install-time status of a catalog entry relative to the manifest + remote. */
export type ArtifactStatus = 'install' | 'update' | 'current';

/**
 * A catalog entry annotated with its install status.
 *
 * - install : not present in the manifest for the target scope.
 * - update  : installed, but the remote has a newer version (installedRef < remoteRef).
 * - current : installed and already at the latest resolved version.
 */
export interface StatusedEntry {
  id: string;
  status: ArtifactStatus;
  /** Installed version (present for update/current). */
  installedRef?: string;
  /** Target/remote version (present for install/update). */
  remoteRef?: string;
  /**
   * Present (`'pack'`) when the entry is a pack (b1b4-R3). A pack has no
   * version of its own — its status is synthesized from its installable
   * members — so its picker labels are member-oriented, not version pairs
   * (which would render `undefined`). Absent for ordinary artifacts.
   */
  kind?: 'pack';
}

/** A single picker option: stable `value` (the artifact id) + display `label`. */
export interface StatusOption {
  value: string;
  label: string;
}

/**
 * Build the grouped option map for the status-aware picker (pure, testable).
 *
 * The version annotation is embedded in the `label` — NOT in clack's `hint`.
 * `groupMultiselect` only renders `hint` for the focused or selected row, so a
 * version placed there vanishes on unchecked rows (the "Up to date" group is
 * unchecked by default). Putting it in the label keeps it visible in every
 * state. Groups are only emitted when non-empty.
 *
 *   - "To install"                     → not installed; label `id (→ target)`.
 *   - "To update"                      → newer available; label `id (old → new)`.
 *   - "Up to date (check to reinstall)" → current; label `id (✓ ref)`.
 */
export function buildStatusOptions(entries: StatusedEntry[]): Record<string, StatusOption[]> {
  const install = entries.filter((e) => e.status === 'install');
  const update = entries.filter((e) => e.status === 'update');
  const current = entries.filter((e) => e.status === 'current');

  const options: Record<string, StatusOption[]> = {};
  if (install.length > 0) {
    options['To install'] = install.map((e) => ({
      value: e.id,
      label: e.remoteRef === undefined ? e.id : `${e.id} (→ ${e.remoteRef})`,
    }));
  }
  if (update.length > 0) {
    options['To update'] = update.map((e) => ({
      value: e.id,
      // b1b4-R3: a pack has no version pair of its own — the synthesized status
      // reflects member state, so the label is member-oriented, not
      // `(installedRef → remoteRef)` (which would render `undefined`).
      label: e.kind === 'pack'
        ? `${e.id} (members outdated)`
        : `${e.id} (${e.installedRef} → ${e.remoteRef})`,
    }));
  }
  if (current.length > 0) {
    options['Up to date (check to reinstall)'] = current.map((e) => ({
      value: e.id,
      // b1b4-R3: same rationale — a pack has no installedRef of its own.
      label: e.kind === 'pack' ? `${e.id} (✓ members current)` : `${e.id} (✓ ${e.installedRef})`,
    }));
  }
  return options;
}

/**
 * Options relaying each catalog's `meta` opinion into the picker's pre-checked
 * set (b1b4-R4). Per-catalog rule: a catalog "declares an opinion" only when
 * its `recommended` list is non-empty (MetaSchema defaults to []), so
 * membership in {@link StatusInitialValuesOpts.optingPrefixes} — not the mere
 * presence of a meta block — is what flips a catalog off the historical "check
 * every install" default. The caller (handleInstall) builds both sets.
 */
export interface StatusInitialValuesOpts {
  /**
   * Qualified install ids to pre-check FOR OPTING CATALOGS (the union of each
   * opting catalog's `required ∪ recommended`, qualified — R4a amendment). An
   * install entry of an opting catalog is pre-checked only if it is in here;
   * a non-opting catalog ignores this set (historical "check all install").
   */
  preChecked: Set<string>;
  /** Source names (id prefixes) whose recommended list is non-empty. */
  optingPrefixes: Set<string>;
}

/**
 * Compute the picker's initially-checked ids (pure, testable) (b1b4-R4).
 *
 * - update  → always checked (updating an artifact the user already installed
 *             never depends on the catalog's opinion).
 * - install → checked when the id's catalog declares no opinion (its prefix is
 *             absent from `optingPrefixes` — historical "check all install"),
 *             otherwise only when the id is in `preChecked` (that catalog's
 *             required ∪ recommended).
 * - current → never checked (no implicit reinstall, even if recommended).
 *
 * Without `opts` the historical default is reproduced exactly: install ∪ update.
 */
export function buildStatusInitialValues(
  entries: StatusedEntry[],
  opts?: StatusInitialValuesOpts,
): string[] {
  return entries
    .filter((e) => {
      if (e.status === 'update') return true;
      if (e.status !== 'install') return false; // current → never pre-checked
      if (opts === undefined) return true; // historical default: every install
      const slash = e.id.indexOf('/');
      const prefix = slash === -1 ? '' : e.id.slice(0, slash);
      // A catalog with no declared opinion keeps its historical pre-check;
      // one that opts in pre-checks only its required/recommended install entries.
      return opts.optingPrefixes.has(prefix) ? opts.preChecked.has(e.id) : true;
    })
    .map((e) => e.id);
}

/**
 * Status-aware grouped picker (groupMultiselect).
 *
 * Three groups, only rendered when non-empty (see {@link buildStatusOptions}).
 * The pre-checked set is {@link buildStatusInitialValues} (install ∪ update by
 * default; narrowed by a catalog's `meta.recommended` opinion when `opts` is
 * given, b1b4-R4). The "current" group lets the user opt into a reinstall by
 * checking an item. Cancellation (isCancel) throws CancelledError (R2) —
 * handleError maps it to exit 130.
 */
export async function selectArtifactsByStatus(
  entries: StatusedEntry[],
  opts?: StatusInitialValuesOpts,
): Promise<string[]> {
  const options = buildStatusOptions(entries);

  const initialValues = buildStatusInitialValues(entries, opts);

  const result = await groupMultiselect<string>({
    message:
      'Select artifacts to install / update (Space on a group header toggles the whole group):',
    options,
    initialValues,
    required: false,
    // Group headers are selectable: Space on "To install" / "To update"
    // toggles every item in that group at once (select-all / deselect-all).
    selectableGroups: true,
    groupSpacing: 1,
  });

  if (isCancel(result)) {
    cancel('Operation cancelled.');
    throw new CancelledError();
  }

  return result;
}

/**
 * Build the scope picker's options (pure, testable) (R5).
 *
 * Labels' root directory is derived from `assistantRoot` — so an opencode
 * transaction reads `~/.config/opencode` / the cwd root, never `.claude`.
 * Placeholder tokens ('~', 'cwd') stand in for the real home/cwd, which the
 * picker has no access to — same convention the previous hardcoded labels
 * used. A fail-soft assistant (copilot) falls back to a bare label, no path.
 */
export function buildScopeOptions(
  assistant: Assistant = 'claude',
): { value: Scope; label: string }[] {
  const userRoot = assistantRoot(assistant, 'user', { home: '~' });
  const projectRoot = assistantRoot(assistant, 'project', { cwd: 'cwd' });

  return [
    { value: 'user', label: userRoot === undefined ? 'user' : `user  (${userRoot}/)` },
    {
      value: 'project',
      label: projectRoot === undefined ? 'project' : `project  (${projectRoot}/)`,
    },
  ];
}

/**
 * Present a select prompt for installation scope.
 * Returns 'user' or 'project'.
 * Throws a CancelledError if the user cancels (R2) — the caller must stop
 * immediately: no fallback scope, no further network call, no picker shown.
 *
 * `assistant` (R5, defaults to 'claude' for backward compatibility) picks the
 * labels via {@link buildScopeOptions}.
 */
export async function selectScope(assistant: Assistant = 'claude'): Promise<Scope> {
  const result = await select<Scope>({
    message: 'Select installation scope:',
    options: buildScopeOptions(assistant),
  });

  if (isCancel(result)) {
    cancel('Operation cancelled.');
    throw new CancelledError();
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
  /**
   * Assistant(s) each installed id is present for (M3, E6) — e.g. an id
   * installed for both claude and opencode maps to `['claude', 'opencode']`.
   * Rendered as a parenthesised suffix on installed rows. Absent id → no suffix.
   */
  installedAssistants?: Map<string, Assistant[]>;
  /** Human label for filtered listing, e.g. "Skills". When absent: "Catalog". */
  label?: string;
  /**
   * Enable ANSI colour codes.
   * Defaults to TTY auto-detection (see {@link shouldColor}).
   * Pass `false` in tests for deterministic plain-text output.
   */
  color?: boolean;
}

/**
 * Render a human-readable catalog listing.
 *
 * For each entry, one aligned line:
 *   <status-tag>  <id>  <nature|pack>  <hint>  <assistants>
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
 * Assistants (installed rows only, when installedAssistants is provided):
 *   "(claude)" / "(claude, opencode)" — which assistant(s) this id is installed for.
 *
 * Header: "Catalog (N entries):" or "<label> (N):" when label is provided.
 */
export function renderCatalogList(
  entries: CatalogEntry[],
  opts: RenderCatalogListOpts = {},
): string {
  const { installedIds, installedAssistants, label } = opts;
  const colorOn = shouldColor(opts.color);

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
    // Pad first, then colour as one unit — ANSI codes are zero-width so column
    // alignment is preserved while `[installed]`/`[available]` stay contiguous.
    const raw = (installed ? INSTALLED : AVAILABLE).padEnd(TAG_WIDTH);
    return paint(raw, installed ? ANSI.green : ANSI.dim, colorOn);
  };

  const assistantsSuffixFor = (id: string): string => {
    const assistants = installedAssistants?.get(id);
    return assistants === undefined || assistants.length === 0 ? '' : `(${assistants.join(', ')})`;
  };

  // Build rows first, then pad the id and nature columns to their max width so
  // every column lines up regardless of id/nature length.
  const rows = entries.map((entry) => {
    const nature = entry.kind === 'pack' ? 'pack' : entry.nature;
    const baseHint = entry.kind === 'pack'
      ? `(${entry.members.length} members)`
      : (entry.level ?? '');
    const hint = [baseHint, assistantsSuffixFor(entry.id)].filter((s) => s !== '').join('  ');
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

// ---------------------------------------------------------------------------
// confirmDoctorRepair — per-item consent for a doctor repair (R8, ADR-0025 §2)
// ---------------------------------------------------------------------------

/**
 * Present a single yes/no confirmation for ONE doctor repair op (the
 * consent-driver's `confirmItem` seam, doctor-consent.ts). Returns `true` to
 * grant, `false` to decline. A Ctrl+C cancellation throws `CancelledError`
 * (mapped to exit 130 by cli.ts's handleError) — distinct from a deliberate
 * "no" (which returns `false` and lets the driver skip + report the op).
 *
 * Only ever called in a TTY: the consent-driver never invokes `confirmItem` in
 * a non-TTY session (it skips item-confirm ops and never prompts), so this
 * clack prompt can never hang on non-TTY stdin (R8 "jamais de hang").
 */
export async function confirmDoctorRepair(message: string): Promise<boolean> {
  const result = await confirm({ message, initialValue: false });
  if (isCancel(result)) {
    cancel('Operation cancelled.');
    throw new CancelledError();
  }
  return result;
}

// ---------------------------------------------------------------------------
// chooseAdoptionCatalog — pick the owning catalog of an ambiguous adopt (D5)
// ---------------------------------------------------------------------------

/**
 * Ask which of several configured catalogs an ambiguous adoption candidate
 * belongs to (D5, doctor --remote). Returns the chosen catalog name; the caller
 * qualifies the id with it (`<name>/<candidateId>`). A Ctrl+C cancellation
 * throws `CancelledError` (mapped to exit 130 by cli.ts's handleError).
 *
 * Only ever called in a TTY with two or more offering catalogs: the adoption
 * resolver falls back to `ambiguous` (skip + report) in a non-TTY session and
 * never invokes this prompt, so this clack select can never hang on non-TTY
 * stdin (same "jamais de hang" bound as `confirmDoctorRepair`).
 */
export async function chooseAdoptionCatalog(
  candidateId: string,
  catalogNames: string[],
): Promise<string> {
  const result = await select<string>({
    message: `"${candidateId}" is offered by more than one catalog — which one adopted it?`,
    options: catalogNames.map((name) => ({ value: name, label: name })),
  });
  if (isCancel(result)) {
    cancel('Operation cancelled.');
    throw new CancelledError();
  }
  return result;
}

// ---------------------------------------------------------------------------
// confirmToolChecks — granular batch consent for tool presence-checks
// ---------------------------------------------------------------------------

/**
 * Present a single batch yes/no confirmation for tool presence-check
 * commands not yet recorded in the consent ledger (@agent-rigger/core/consent).
 *
 * Confirming the install plan is NOT consent to execute a tool's `check`
 * command — that consent is separate and granular. This prompt lists every
 * command awaiting approval (id → command) and asks for one global decision.
 * Denial or cancellation both mean "no consent": the caller must run none of
 * the listed commands and treat them as unverified.
 */
export async function confirmToolChecks(
  commands: { id: string; command: string }[],
): Promise<boolean> {
  // R4 (ADR-0018, fail-closed): a non-TTY session cannot answer this prompt
  // (clack confirm hangs on non-TTY stdin — the prompt reads keypresses from
  // stdin, not stdout). No consent → run none of the listed check commands,
  // exactly as a "no" answer would. Reaching this point non-interactively
  // means --yes was passed to the top-level command but the granular
  // tool-check consent is deliberately never auto-granted.
  if (process.stdin.isTTY !== true) {
    return false;
  }

  const list = commands.map((c) => `  ${c.id}  →  ${c.command}`).join('\n');
  const result = await confirm({
    message: `Run the following tool presence-checks?\n\n${list}`,
    initialValue: false,
  });

  if (isCancel(result)) {
    cancel('Operation cancelled.');
    return false;
  }

  return result;
}
