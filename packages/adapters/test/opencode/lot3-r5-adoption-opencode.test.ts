/**
 * Tests for lot3-robustesse-moteur R5 — the opencode adapter's `adopt` gates
 * (design D5, task T7).
 *
 * Scenario shape (the M4 trap and its cure): an artifact is installed normally,
 * then the manifest is LOST (M2 — state.json reset). A second install finds the
 * plan empty (artifact still conforming on disk) but no manifest record: without
 * adoption it stays inconvergeable (check exit 3 / install no-op forever). The
 * adopt gate records the canonical payload from disk, WITHOUT any new write, so
 * check returns to 0 and remove can uninstall.
 *
 * Gates proved here (per opencode nature, STRICT):
 *  - permission → adopted only when the canonical fragment is fully present
 *    (missing + conflicts + overlaps all empty); payload carries the canonical
 *    fragment; a partial/conflicting install is NEVER adopted.
 *  - mcp        → FM5: adopted ONLY when the on-disk server config DEEP-EQUALS
 *    the canonical; a personal divergent config is NEVER adopted (adopting the
 *    canonical would let remove destroy the user's config).
 *  - skill      → adopted only when audit is exactly `present`; a `drift` target
 *    is NEVER adopted.
 *  - agent      → adopted only when the translated content is exactly present.
 *  - plugin     → adopted with files=[target] (mirror of adoptSkill): an
 *    opencode plugin is a store+symlink artifact sharing ONE user-level store
 *    across scopes/cwds, so the adopted target MUST participate in the store's
 *    cross-cwd refcount (R4/D4) — recording files=[] would let a sibling removal
 *    from another cwd delete the still-shared store.
 *  - context    → FM6: adopted with the canonical block but NO `previous`.
 *
 * Isolation: fresh RIGGER_HOME tmp dir per test — never touches the real ~/.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply, check, remove, reportExitCode } from '@agent-rigger/core/engine';
import { writeJson } from '@agent-rigger/core/fs-json';
import { findEntry, writeManifest } from '@agent-rigger/core/manifest';
import {
  resolveOpencodeProjectTargets,
  resolveOpencodeUserTargets,
} from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { OpencodeMcpServer, OpencodePermission } from '@agent-rigger/core/types';

import { createOpencodeAdapter } from '../../src/opencode/adapter';
import { adoptMcp } from '../../src/opencode/mcp';
import { adoptPlugin } from '../../src/opencode/plugins';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-lot3-r5-opencode-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

async function makeSkillFixture(baseDir: string, name: string): Promise<string> {
  const skillDir = path.join(baseDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `# ${name}\nFixture skill.`);
  return skillDir;
}

async function makeAgentFixture(baseDir: string, name: string): Promise<string> {
  const file = path.join(baseDir, `${name}.md`);
  await fs.writeFile(
    file,
    `---\ndescription: A reviewer\nmodel: anthropic/claude-opus\n---\nBody of ${name}.\n`,
  );
  return file;
}

async function makePluginFixture(baseDir: string, name: string): Promise<string> {
  const file = path.join(baseDir, `${name}.ts`);
  await fs.writeFile(file, `export const ${name} = () => {};\n`);
  return file;
}

/** Empty the manifest — simulates the M2 state.json reset. */
async function wipeManifest(manifestPath: string): Promise<void> {
  await writeManifest(manifestPath, { version: 1, artifacts: [] });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REF_PERMISSION: OpencodePermission = {
  read: { '.env.local': 'deny', '.env.example': 'allow' },
  edit: { '.env.local': 'deny', '.env.example': 'allow' },
};

const CANONICAL_MCP: OpencodeMcpServer = {
  type: 'remote',
  url: 'https://mcp.context7.com/mcp',
};

const DIVERGENT_MCP: OpencodeMcpServer = {
  type: 'remote',
  url: 'https://mcp.context7.com/mcp',
  headers: { Authorization: 'Bearer personal-token' },
};

const CANONICAL_AGENTS = '# Managed AGENTS.md\n\nCanonical opencode agent context.\n';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let targets: ReturnType<typeof resolveOpencodeUserTargets>;
let manifestPath: string;
let fixturesDir: string;

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
  targets = resolveOpencodeUserTargets(env);
  // state.json lives under the shared rigger config dir, resolved by the engine
  // through resolveUserTargets — but the opencode adapter only cares about its
  // own paths. Use the opencode.json's grand-parent config dir for state.json.
  manifestPath = path.join(tmp.dir, '.config', 'agent-rigger', 'state.json');
  fixturesDir = path.join(tmp.dir, 'fixtures');
  await fs.mkdir(fixturesDir, { recursive: true });
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// Permission (guardrail) — adopt on fully present, converge, remove retires
// ---------------------------------------------------------------------------

describe('lot3 R5 — opencode permission adoption', () => {
  it('lot3-R5: a permission present on disk but absent from the manifest is adopted with the canonical fragment', async () => {
    const adapter = createOpencodeAdapter({ permission: REF_PERMISSION });
    const entry: AdapterEntry = { id: 'guardrails-opencode', nature: 'guardrail', scope: 'user' };

    // Install normally, then lose the manifest (M2 reset).
    await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });
    await wipeManifest(manifestPath);

    // Re-install: plan is empty (rules present) → adoption records the entry.
    const result = await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });

    expect(result.adopted).toContain('guardrails-opencode');
    expect(result.written).toHaveLength(0);

    const recorded = findEntry(result.manifest, 'guardrails-opencode', 'user', 'opencode');
    expect(recorded).toBeDefined();
    expect(recorded?.applied).toEqual({ kind: 'opencode-permission', permission: REF_PERMISSION });
    expect(recorded?.files).toEqual([targets.opencodeJson]);
  });

  it('lot3-R5: check exits 0 after permission adoption, and remove retires the rules', async () => {
    const adapter = createOpencodeAdapter({ permission: REF_PERMISSION });
    const entry: AdapterEntry = { id: 'guardrails-opencode', nature: 'guardrail', scope: 'user' };

    await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });
    await wipeManifest(manifestPath);
    await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });

    const report = await check(adapter, [entry], 'user', env, manifestPath);
    expect(reportExitCode(report)).toBe(0);

    const removeResult = await remove(adapter, [entry], 'user', env, manifestPath);
    expect(removeResult.removed).toContain('guardrails-opencode');
  });

  it('lot3-R5: a permission only PARTIALLY present is not adopted', async () => {
    const adapter = createOpencodeAdapter({ permission: REF_PERMISSION });
    const entry: AdapterEntry = { id: 'guardrails-opencode', nature: 'guardrail', scope: 'user' };

    // Seed opencode.json with only the `read` leaves — plan is non-empty (edit
    // missing), so this never reaches the adoption branch, but asserting no
    // adoption keeps the strict gate honest.
    await writeJson(targets.opencodeJson, {
      permission: { read: { '.env.local': 'deny', '.env.example': 'allow' } },
    });

    const result = await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });
    expect(result.adopted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// MCP — FM5 deep-equality gate
// ---------------------------------------------------------------------------

describe('lot3 R5 — opencode mcp adoption (FM5 deep-equal)', () => {
  const entry: AdapterEntry = { id: 'mcp:context7', nature: 'mcp', scope: 'user' };
  const mcpSource = () => ({ server: 'context7', config: CANONICAL_MCP });

  it('lot3-R5: an mcp server whose disk config DEEP-EQUALS the canonical is adopted', async () => {
    const adapter = createOpencodeAdapter({ mcpSource });

    // Seed opencode.json with the server config == canonical.
    await writeJson(targets.opencodeJson, { mcp: { context7: CANONICAL_MCP } });

    const result = await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });

    expect(result.adopted).toContain('mcp:context7');
    const recorded = findEntry(result.manifest, 'mcp:context7', 'user', 'opencode');
    expect(recorded?.applied).toEqual({
      kind: 'opencode-mcp',
      server: 'context7',
      config: CANONICAL_MCP,
    });
    expect(recorded?.files).toEqual([targets.opencodeJson]);
  });

  it('lot3-R5: an mcp server whose disk config DIVERGES from the canonical is NEVER adopted (FM5)', async () => {
    const adapter = createOpencodeAdapter({ mcpSource });

    // Seed opencode.json with the SAME server id but a PERSONAL divergent config.
    await writeJson(targets.opencodeJson, { mcp: { context7: DIVERGENT_MCP } });

    const result = await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });

    // The server key is present → plan is empty; but the deep-equal gate fails,
    // so nothing is adopted — the manifest must never claim the user's config.
    expect(result.adopted).toHaveLength(0);
    expect(findEntry(result.manifest, 'mcp:context7', 'user', 'opencode')).toBeUndefined();
  });

  it('lot3-R5: adoptMcp returns undefined when the server key is absent', async () => {
    // Direct gate unit: an absent server never reaches the adoption branch via
    // apply (its plan is non-empty → install path), so the refusal is proved on
    // the gate itself.
    await writeJson(targets.opencodeJson, { mcp: {} });
    const adoption = await adoptMcp('user', env, 'context7', CANONICAL_MCP);
    expect(adoption).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Skill — adopt on present, never on drift
// ---------------------------------------------------------------------------

describe('lot3 R5 — opencode skill adoption', () => {
  it('lot3-R5: a present opencode skill absent from the manifest is adopted with files=[target]', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'foo');
    const adapter = createOpencodeAdapter({ skillSource: () => srcDir });
    const entry: AdapterEntry = { id: 'skill:foo', nature: 'skill', scope: 'user' };

    await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });
    await wipeManifest(manifestPath);

    const result = await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });

    expect(result.adopted).toContain('skill:foo');
    const target = path.join(targets.skillsDir, 'foo');
    const recorded = findEntry(result.manifest, 'skill:foo', 'user', 'opencode');
    expect(recorded?.applied).toEqual({ kind: 'link', files: [target] });
    expect(recorded?.files).toEqual([target]);
  });

  it('lot3-R5: a drifted opencode skill (foreign directory) is NEVER adopted', async () => {
    const srcDir = await makeSkillFixture(fixturesDir, 'bar');
    const adapter = createOpencodeAdapter({ skillSource: () => srcDir });
    const entry: AdapterEntry = { id: 'skill:bar', nature: 'skill', scope: 'user' };

    const target = path.join(targets.skillsDir, 'bar');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'SKILL.md'), '# not rigger content\n');

    const result = await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });

    expect(result.adopted).toHaveLength(0);
    expect(findEntry(result.manifest, 'skill:bar', 'user', 'opencode')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Agent — adopt only when the translated content is present
// ---------------------------------------------------------------------------

describe('lot3 R5 — opencode agent adoption', () => {
  it('lot3-R5: a present translated opencode agent absent from the manifest is adopted', async () => {
    const src = await makeAgentFixture(fixturesDir, 'reviewer');
    const adapter = createOpencodeAdapter({ agentSource: () => src });
    const entry: AdapterEntry = { id: 'agent:reviewer', nature: 'agent', scope: 'user' };

    await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });
    await wipeManifest(manifestPath);

    const result = await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });

    expect(result.adopted).toContain('agent:reviewer');
    const target = path.join(targets.agentsDir, 'reviewer.md');
    const recorded = findEntry(result.manifest, 'agent:reviewer', 'user', 'opencode');
    expect(recorded?.files).toEqual([target]);
    const applied = recorded?.applied as { kind?: string; block?: string } | undefined;
    expect(applied?.kind).toBe('context');
    expect(typeof applied?.block).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Plugin — adopt with files=[] when present on disk
// ---------------------------------------------------------------------------

describe('lot3 R5 — opencode plugin adoption', () => {
  it('lot3-R5: a present opencode plugin absent from the manifest is adopted with files=[target]', async () => {
    const src = await makePluginFixture(fixturesDir, 'enforce-tests');
    const adapter = createOpencodeAdapter({ pluginSource: () => src });
    const entry: AdapterEntry = { id: 'plugin:enforce-tests', nature: 'plugin', scope: 'user' };

    await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });
    await wipeManifest(manifestPath);

    const result = await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });

    expect(result.adopted).toContain('plugin:enforce-tests');
    // The installed file carries the source module's extension (.ts).
    const target = path.join(targets.pluginDir, 'enforce-tests.ts');
    const recorded = findEntry(result.manifest, 'plugin:enforce-tests', 'user', 'opencode');
    expect(recorded).toBeDefined();
    // files/applied mirror a normal install (extractApplied → AppliedLink) so the
    // adopted target participates in the shared-store refcount (R4/D4).
    expect(recorded?.applied).toEqual({ kind: 'link', files: [target] });
    expect(recorded?.files).toEqual([target]);
  });

  it('lot3-R5: adoptPlugin records the cwd-specific target for a project-scope plugin (cross-cwd refcount seam)', async () => {
    // A project-scope reference installed from cwd A: adoptPlugin must record
    // THAT cwd's pluginDir/<name>.<ext>, the only path through which a removal
    // running in another cwd can discover the still-live reference (R4/D4).
    const cwdA = path.join(tmp.dir, 'projectA');
    const projectTargets = resolveOpencodeProjectTargets(cwdA);
    await fs.mkdir(projectTargets.pluginDir, { recursive: true });
    const installed = path.join(projectTargets.pluginDir, 'enforce-tests.ts');
    await fs.writeFile(installed, 'export const enforceTests = () => {};\n');

    const entry: AdapterEntry = { id: 'plugin:enforce-tests', nature: 'plugin', scope: 'project' };
    const adoption = await adoptPlugin(entry, 'project', env, cwdA);

    expect(adoption).toBeDefined();
    expect(adoption?.files).toEqual([installed]);
    expect(adoption?.applied).toEqual({ kind: 'link', files: [installed] });
  });

  it('lot3-R5: adoptPlugin refuses an absent plugin (undefined)', async () => {
    const entry: AdapterEntry = { id: 'plugin:absent', nature: 'plugin', scope: 'user' };
    const adoption = await adoptPlugin(entry, 'user', env);
    expect(adoption).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Context — FM6 baseline guard + fully-present adoption
// ---------------------------------------------------------------------------

describe('lot3 R5 — opencode context adoption (FM6)', () => {
  it('lot3-R5: a fully-present opencode context absent from the manifest is adopted without previous', async () => {
    const adapter = createOpencodeAdapter({ agentsContent: CANONICAL_AGENTS });
    const entry: AdapterEntry = { id: 'context-opencode', nature: 'context', scope: 'user' };

    await fs.mkdir(path.dirname(targets.agentsMd), { recursive: true });
    await fs.writeFile(targets.agentsMd, CANONICAL_AGENTS);

    const result = await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });

    expect(result.adopted).toContain('context-opencode');
    const recorded = findEntry(result.manifest, 'context-opencode', 'user', 'opencode');
    const applied = recorded?.applied as
      | { kind?: string; block?: string; previous?: unknown }
      | undefined;
    expect(applied?.kind).toBe('context');
    expect(applied?.block).toBe(CANONICAL_AGENTS);
    expect(applied?.previous).toBeUndefined();
  });
});
