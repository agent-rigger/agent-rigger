/**
 * lib-nature-t6-store-homonyms.test.ts — negative pin for R9 sc. « homonymes
 * store-side intouchés ». The checkout-side natures (skills/agents/guardrails/
 * contexts/plugins/hooks) share their WORDS with the installed store dirs under
 * ~/.config/agent-rigger. The cutover (R9) inserted a `common/` + per-assistant
 * prefix on the CHECKOUT side ONLY; a find/replace wide enough to also rewrite a
 * store path would silently break every already-installed rig (its store dir
 * would no longer be found). This freezes the store family so that regression
 * reds instead of shipping.
 *
 * The invariant: every agent-rigger-managed store leaf (skills, agents, hooks,
 * plugins, libs) sits DIRECTLY under the `agent-rigger` config dir — its parent
 * is never a checkout prefix.
 *
 * Two layers:
 *  1. Structural — the real prod path functions (skillsDir, libsDir,
 *     hookScriptStorePath) resolve to unprefixed store leaves.
 *  2. Behavioural — the REAL doctor phantom scanner (createPhantomScanner,
 *     adapters) is run against planted orphans: it must FIND them at the
 *     unprefixed roots it derives itself. If a future edit over-prefixes
 *     doctor-scan's `path.dirname(skillsStore)/{agents,plugins}` derivation, the
 *     scanner reads the wrong dir, the planted orphan is not found, and this
 *     reds — catching the regression at its real source, not a reconstruction.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createPhantomScanner } from '@agent-rigger/adapters';
import { CHECKOUT_CLAUDE, CHECKOUT_COMMON, CHECKOUT_OPENCODE } from '@agent-rigger/catalog';
import type { DoctorContext } from '@agent-rigger/core';
import { libsDir, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { hookScriptStorePath } from '../src/adapter-builder';

const CHECKOUT_PREFIXES = new Set([CHECKOUT_COMMON, CHECKOUT_CLAUDE, CHECKOUT_OPENCODE]);

/**
 * A managed store leaf must be a DIRECT child of the config dir — so its parent
 * basename is `agent-rigger`, never `common`/`claude`/`opencode`. Inserting a
 * checkout prefix (e.g. `.../agent-rigger/common/skills`) moves the parent to a
 * prefix and trips this.
 */
function assertNoCheckoutPrefix(storePath: string, configDir: string): void {
  const parent = path.dirname(storePath);
  expect(CHECKOUT_PREFIXES.has(path.basename(parent))).toBe(false);
  expect(parent).toBe(configDir);
}

// ---------------------------------------------------------------------------
// Layer 1 — structural: the prod path functions resolve to unprefixed leaves
// ---------------------------------------------------------------------------

describe('store-side homonyms carry no checkout prefix (R9 sc.2)', () => {
  const env: Env = { RIGGER_HOME: '/tmp/rigger-store-homonyms' };
  const configDir = path.dirname(resolveUserTargets(env).stateJson);

  it('the config dir is agent-rigger, not a checkout prefix', () => {
    expect(path.basename(configDir)).toBe('agent-rigger');
  });

  it('skillsDir → <config>/skills, no common/ prefix', () => {
    const skillsDir = resolveUserTargets(env).skillsDir;
    expect(path.basename(skillsDir)).toBe('skills');
    assertNoCheckoutPrefix(skillsDir, configDir);
  });

  it('libsDir → <config>/libs, sibling of skills, no common/ prefix', () => {
    const libs = libsDir(env);
    expect(path.basename(libs)).toBe('libs');
    assertNoCheckoutPrefix(libs, configDir);
    // R7 correction: libs/ subsists beside the skill/agent stores under the same
    // config dir — not under a checkout prefix of its own.
    expect(path.dirname(libs)).toBe(path.dirname(resolveUserTargets(env).skillsDir));
  });

  it('hookScriptStorePath → <config>/hooks, no claude/ prefix', () => {
    const hooks = hookScriptStorePath(env);
    expect(path.basename(hooks)).toBe('hooks');
    assertNoCheckoutPrefix(hooks, configDir);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — behavioural: the REAL doctor phantom scanner derives its store roots
// unprefixed. Plant orphans at the unprefixed skill/agent/plugin roots and prove
// the scanner finds them there. An over-prefixed doctor-scan derivation would
// scan the wrong dir and miss them → red.
// ---------------------------------------------------------------------------

describe('doctor phantom scanner derives store roots without a checkout prefix', () => {
  let tmpHome: string;
  let env: Env;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-store-phantom-'));
    env = { RIGGER_HOME: tmpHome };
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('finds orphans planted at the unprefixed skill/agent/plugin store roots', async () => {
    const skillsDir = resolveUserTargets(env).skillsDir;
    const configDir = path.dirname(skillsDir);
    const manifestPath = resolveUserTargets(env).stateJson;

    // Plant one unreferenced orphan at each named store root, at the UNPREFIXED
    // config-dir position (skill: <config>/skills, agent: <config>/agents,
    // plugin: <config>/plugins).
    const skillOrphan = path.join(skillsDir, 'orphan-skill');
    const agentOrphan = path.join(configDir, 'agents', 'orphan-agent.md');
    const pluginOrphan = path.join(configDir, 'plugins', 'orphan-plugin.js');
    await fs.mkdir(skillOrphan, { recursive: true });
    await fs.writeFile(path.join(skillOrphan, 'SKILL.md'), '# orphan');
    await fs.mkdir(path.dirname(agentOrphan), { recursive: true });
    await fs.writeFile(agentOrphan, '# orphan agent');
    await fs.mkdir(path.dirname(pluginOrphan), { recursive: true });
    await fs.writeFile(pluginOrphan, '// orphan plugin');

    const ctx: DoctorContext = { env, manifestPath, configuredCatalogIds: [] };
    const findings = await createPhantomScanner()(ctx);
    const phantomStores = findings
      .filter((f) => f.class === 'phantom')
      .map((f) => (f.class === 'phantom' ? f.evidence.store : ''));

    // The scanner found each orphan at the UNPREFIXED root it derived itself.
    expect(phantomStores).toContain(skillOrphan);
    expect(phantomStores).toContain(agentOrphan);
    expect(phantomStores).toContain(pluginOrphan);

    // No phantom store path carries a checkout prefix as the parent of its leaf.
    for (const store of phantomStores) {
      expect(CHECKOUT_PREFIXES.has(path.basename(path.dirname(store)))).toBe(false);
    }
  });
});
