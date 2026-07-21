/**
 * checkout-prefixes.ts — the top-level directories a post-cutover catalogue lays
 * its content under (R9, lib-nature). Three axes:
 *
 *   common/    — assistant-agnostic content (skills, agents, libs).
 *   claude/    — claude-specific content (hooks, guardrails, contexts).
 *   opencode/  — opencode-specific content (plugins, guardrails, contexts).
 *
 * The assistant axes (`claude`, `opencode`) are, by construction, the `Assistant`
 * string values themselves — a multi-target guardrail/context derives its per-
 * assistant dir straight from `entry.targets`, so those readers use the target
 * value directly rather than these constants; the constants name the axis where a
 * nature is pinned to ONE assistant (hook → claude, plugin → opencode) or to
 * `common`.
 *
 * These are prefix CONSTANTS, deliberately NOT a layout function. The four
 * checkout encoders — `scan-paths` (the surface to SCAN), the two adapter
 * builders and `fetch` (precise sub-paths to BUILD ops) — each compose their own
 * `path.join` from these. Unifying them behind one function would force a single
 * abstraction over two genuinely different reads (design §4, an AHA trap); the
 * per-nature `path_match` pins keep the four in lockstep instead (R9).
 *
 * The store-side homonyms (`skills`/`agents`/`hooks` under
 * ~/.config/agent-rigger, the doctor phantom roots) are a DIFFERENT axis and
 * never take these prefixes — the installed stores must stay valid across the
 * cutover (R9, sc. « homonymes store-side intouchés »).
 */

/** Assistant-agnostic checkout content: skills, agents, libs. */
export const CHECKOUT_COMMON = 'common';

/** Claude-specific checkout content: hooks, guardrails, contexts. */
export const CHECKOUT_CLAUDE = 'claude';

/** Opencode-specific checkout content: plugins, guardrails, contexts. */
export const CHECKOUT_OPENCODE = 'opencode';
