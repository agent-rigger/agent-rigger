/**
 * Pure translation of Claude-style guardrail rules (`deny.json`/`allow.json`,
 * e.g. `Bash(rm -rf *)`, `Read(./.env)`, bare `WebFetch`) into opencode's
 * `permission` object (design.md §7.1).
 *
 * Mapping table:
 * - `Bash(<pattern>)`            → `{ bash: { <pattern>: state } }` (nested, nvpattern-level).
 * - `Bash(<prefix>:*)`           → `{ bash: { <prefix>: state, "<prefix> *": state } }` —
 *                                  Claude's `:*` prefix syntax matches `<prefix>` exactly AND
 *                                  `<prefix> <anything>`; opencode globs treat `:` literally,
 *                                  so a verbatim pass-through would never match (inert rule).
 *                                  A `:*` anywhere but at the end is not faithfully
 *                                  expressible → omitted, warning emitted.
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

/**
 * Translate one pattern of a pattern-level tool (e.g. bash), converting Claude's
 * `:*` prefix syntax into equivalent opencode globs (review H8).
 *
 * Claude semantics of `<prefix>:*`: matches `<prefix>` exactly AND
 * `<prefix> <anything>`. opencode glob matching treats `:` literally (it is not
 * a separator or wildcard), so a verbatim `<prefix>:*` would only ever match
 * commands containing a literal `<prefix>:` — i.e. the rule would be silently
 * inert. The faithful mapping is two glob leaves: `<prefix>` and `<prefix> *`.
 *
 * A `:*` marker anywhere but at the very end (mid-pattern, or repeated) has no
 * faithful glob equivalent → the rule is omitted with an actionable warning,
 * never emitted as an inoperative glob.
 */
function translatePatternLevel(
  key: string,
  pattern: string,
  state: OpencodePermissionState,
  rule: string,
): RuleTranslation {
  const marker = pattern.indexOf(':*');

  if (marker === -1) {
    // No Claude prefix syntax involved: the pattern is already a plain opencode
    // glob (a lone `:` stays literal on both sides).
    return { fragment: { [key]: { [pattern]: state } } };
  }

  if (marker !== pattern.length - 2) {
    return {
      warning: `Rule "${rule}" uses Claude's ":*" prefix syntax somewhere other than the end `
        + `of the pattern; it has no faithful opencode glob equivalent and was omitted `
        + `(a verbatim copy would never match). Rewrite it as "<prefix>:*" or as an `
        + `explicit opencode glob.`,
    };
  }

  const prefix = pattern.slice(0, -2);
  if (prefix === '') {
    // A bare ":*" (empty prefix) means "everything" → the `*` glob.
    return { fragment: { [key]: { '*': state } } };
  }
  return { fragment: { [key]: { [prefix]: state, [`${prefix} *`]: state } } };
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
      return translatePatternLevel(key, pattern, state, rule);
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

  // SECURITY INVARIANT (review M15): deny rules MUST be applied before allow
  // rules. mergePermission is first-writer-wins per leaf, so this ordering is
  // what makes deny take precedence when the same leaf appears in both lists.
  // Swapping these loops silently turns conflicts fail-open (allow over deny);
  // the invariant is locked by the "deny-over-allow precedence" test suite.
  for (const rule of deny) {
    applyRule(rule, 'deny');
  }
  for (const rule of allow) {
    applyRule(rule, 'allow');
  }

  return { permission, warnings };
}
