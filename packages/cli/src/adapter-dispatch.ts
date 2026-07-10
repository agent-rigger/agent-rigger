/**
 * adapter-dispatch.ts — routes an Assistant selection to the right adapter builder.
 *
 * Single entry point for the CLI: once assistant-select.ts has resolved an
 * Assistant, buildAdapter constructs the matching Adapter (claude | opencode)
 * through the same opts shape, so callers never need to branch on `assistant`
 * themselves. Wired into the install path via remote-install.ts (slice A);
 * check/remove/update (E6) still call buildClaudeAdapter directly.
 *
 * 'copilot' is a reserved Assistant value (not yet selectable by
 * assistant-select.ts) — buildAdapter throws an actionable error rather than
 * silently falling back to claude, so a future caller that does pass it
 * through fails loudly (R10.4).
 */

import type { Assistant } from '@agent-rigger/core';
import type { Adapter } from '@agent-rigger/core/adapter';
import type { Env } from '@agent-rigger/core/paths';

import { buildClaudeAdapter } from './adapter-builder';
import type { BuildClaudeAdapterOpts } from './adapter-builder';
import { buildOpencodeAdapter } from './opencode-adapter-builder';

/**
 * Options accepted by buildAdapter.
 *
 * Reuses BuildClaudeAdapterOpts as the shared shape: `externalIds`,
 * `externalBaseDir`, `effectiveEntries` and `scanner` are understood by both
 * builders; `catalogUrl` and `pluginRunner` are Claude-only and simply ignored by
 * buildOpencodeAdapter (structurally a subset of this type — extra fields on
 * a passed-through object never trigger excess-property errors).
 */
export type BuildAdapterOpts = BuildClaudeAdapterOpts;

/**
 * Build the Adapter matching `assistant`, forwarding `opts` to whichever
 * builder is selected.
 *
 * @param assistant  Target assistant, already resolved by assistant-select.ts.
 * @param env        Injectable environment for path resolution.
 * @param opts       Optional seam for remote installs, check, and remove.
 * @throws {Error}   When `assistant` is 'copilot' — reserved, not implemented (M4).
 */
export async function buildAdapter(
  assistant: Assistant,
  env: Env,
  opts?: BuildAdapterOpts,
): Promise<Adapter> {
  if (assistant === 'copilot') {
    throw new Error('copilot adapter not implemented (M4)');
  }
  return assistant === 'opencode' ? buildOpencodeAdapter(env, opts) : buildClaudeAdapter(env, opts);
}
