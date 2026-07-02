/**
 * Pure translation of Claude-style guardrail rules (`deny.json`/`allow.json`,
 * e.g. `Bash(rm -rf *)`, `Read(./.env)`, bare `WebFetch`) into opencode's
 * `permission` object (design.md §7.1).
 *
 * Mapping table:
 * - `Bash(<pattern>)`            → `{ bash: { <pattern>: state } }` (nested, nvpattern-level).
 * - `Read|Write|Edit(<arg>)`     → `{ <tool>: state }` (opencode read/write/edit is tool-level,
 *                                  not pattern-level); a specific arg (not "" / "*") loses
 *                                  granularity → warning, rule still applied at tool level.
 * - bare tool token (e.g. `WebFetch`) → `{ <tool lowercased>: state }`.
 * - anything else (composite matchers, unsupported syntax) → omitted, warning emitted.
 *
 * Total and side-effect-free: never throws, always returns a result — a rule that
 * cannot be expressed is dropped and reported via `warnings`, never a hard failure
 * (R5.3: "sans échec silencieux").
 */

import { mergePermission } from '@agent-rigger/core';
import type { OpencodePermission, OpencodePermissionState } from '@agent-rigger/core/types';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Result of translating a full deny/allow rule set. */
export interface TranslateRulesResult {
  /** The merged opencode permission fragment translated from all expressible rules. */
  permission: OpencodePermission;
  /** Human-readable, actionable warnings — one per lossy or unparseable rule. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Internal: single-rule translation
// ---------------------------------------------------------------------------

/**
 * `ToolName(arg)` — arg may be empty but must not itself contain parentheses.
 * A rule with embedded/unbalanced parens (composite matchers) simply fails to
 * match here and falls through to the "unparseable" branch below.
 */
const QUALIFIED_RULE_RE = /^([A-Za-z_][A-Za-z0-9_]*)\(([^()]*)\)$/;

/** A bare tool token with no argument, e.g. `WebFetch`. */
const BARE_TOOL_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * opencode tools whose permission is pattern-level (a nested `{ pattern: state }`
 * map, never a flat state). Stored lowercased for case-insensitive lookup.
 *
 * These tools are ALWAYS emitted as nested — even a bare `Bash` becomes
 * `{ bash: { "*": state } }` — so a tool key never mixes flat and nested shapes
 * (which would otherwise let a merge silently narrow/overwrite enforcement).
 */
const PATTERN_LEVEL_TOOLS = new Set(['bash']);

interface RuleTranslation {
  /** Absent when the rule has no expressible opencode equivalent at all. */
  fragment?: OpencodePermission;
  warning?: string;
}

/** Translate a single Claude-style rule string into an opencode permission fragment. */
function translateRule(rule: string, state: OpencodePermissionState): RuleTranslation {
  const qualified = QUALIFIED_RULE_RE.exec(rule);

  if (qualified !== null) {
    const key = (qualified[1] ?? '').toLowerCase();
    const arg = qualified[2] ?? '';

    if (PATTERN_LEVEL_TOOLS.has(key)) {
      // Empty argument means "the whole tool" → the `*` pattern (not an empty key).
      const pattern = arg === '' ? '*' : arg;
      return { fragment: { [key]: { [pattern]: state } } };
    }

    const fragment: OpencodePermission = { [key]: state };
    if (arg !== '' && arg !== '*') {
      return {
        fragment,
        warning: `Path specificity lost for rule "${rule}": opencode's "${key}" permission is `
          + `tool-level, pattern "${arg}" was dropped.`,
      };
    }
    return { fragment };
  }

  if (BARE_TOOL_RE.test(rule)) {
    const key = rule.toLowerCase();
    // A bare pattern-level tool (e.g. `Bash`) means "all of it" → nested `*`,
    // keeping the tool key's shape consistent with its qualified form.
    if (PATTERN_LEVEL_TOOLS.has(key)) {
      return { fragment: { [key]: { '*': state } } };
    }
    return { fragment: { [key]: state } };
  }

  return {
    warning: `Rule "${rule}" has no expressible opencode permission equivalent and was omitted.`,
  };
}

// ---------------------------------------------------------------------------
// translateRules
// ---------------------------------------------------------------------------

/**
 * Translate a full set of canonical Claude deny/allow rules into a single
 * merged opencode `permission` fragment, plus any warnings for lossy or
 * unparseable rules. Deny rules map to state `'deny'`, allow rules to `'allow'`.
 *
 * Pure, total: never throws.
 */
export function translateRules(deny: string[], allow: string[]): TranslateRulesResult {
  let permission: OpencodePermission = {};
  const warnings: string[] = [];

  const applyRule = (rule: string, state: OpencodePermissionState): void => {
    const { fragment, warning } = translateRule(rule, state);
    if (warning !== undefined) {
      warnings.push(warning);
    }
    if (fragment !== undefined) {
      permission = mergePermission(permission, fragment);
    }
  };

  for (const rule of deny) {
    applyRule(rule, 'deny');
  }
  for (const rule of allow) {
    applyRule(rule, 'allow');
  }

  return { permission, warnings };
}
