/**
 * Tests for cmd-check.ts — runCheck.
 *
 * Strategy:
 * - Real createClaudeAdapter + real filesystem (isolated RIGGER_HOME via tmp dir).
 * - Fake CommandRunner for tool checks (no real shell invocations).
 * - No process.exit, no while loops.
 *
 * Scenarios:
 * 1. Complete config  → exitCode 0, output contains present indicators.
 * 2. Incomplete config (deny missing) → exitCode 3, output lists missing entries.
 * 3. Invalid JSON in settings.json → exitCode 2, output actionable (mentions file).
 * 4. Advisory tools (required absent) → exitCode unchanged by audit, output signals missing tool.
 * 5. Drift note: M0 audit = present/missing binary for guardrails; drift is not simulated here
 *    because the guardrail handler returns 'present'/'missing' (no sha drift in M0).
 *    The drift path in renderReport is exercised at the unit level in ui.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { writeJson } from '@agent-rigger/core/fs-json';
import { ensureImportBlock } from '@agent-rigger/core/managed-import';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { createClaudeAdapter } from '@agent-rigger/adapters';

import type { CatalogEntry } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';

import { runCheck } from '../src/cmd-check';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-cmd-check-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/**
 * Write a fully-installed config to the tmp home directory:
 * - settings.json with all deny rules
 * - AGENTS.md with the canonical content
 * - CLAUDE.md with the managed import block
 */
async function writeCompleteConfig(
  targets: ReturnType<typeof resolveUserTargets>,
  denyRef: string[],
  agentsContent: string,
): Promise<void> {
  // settings.json with deny rules
  await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
  await writeJson(targets.claudeSettings, {
    permissions: { deny: denyRef },
  });

  // AGENTS.md
  await fs.mkdir(path.dirname(targets.agentsMd), { recursive: true });
  await Bun.write(targets.agentsMd, agentsContent);

  // CLAUDE.md with managed import block targeting ~/.claude/harness/AGENTS.md
  const claudeMdContent = ensureImportBlock('', '~/.claude/harness/AGENTS.md');
  await Bun.write(targets.claudeMd, claudeMdContent);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REF_DENY = ['Read(./.env)', 'Read(~/.ssh/**)', 'Read(./secrets/**)'];

/** Canonical AGENTS.md content used in all tests. */
const AGENTS_CONTENT = '# Agents\nThis is the canonical AGENTS.md.';

/** Guardrail entry — the only mandatory nature for M0 check tests. */
const GUARDRAIL_ENTRY: AdapterEntry = {
  id: 'guardrails-claude',
  nature: 'guardrail',
  scope: 'user',
};

/** Context entry (AGENTS.md). */
const CONTEXT_ENTRY: AdapterEntry = {
  id: 'context-claude',
  nature: 'context',
  scope: 'user',
};

/** All entries for a complete config test. */
const ALL_ENTRIES: AdapterEntry[] = [GUARDRAIL_ENTRY, CONTEXT_ENTRY];

// ---------------------------------------------------------------------------
// Shared fake CommandRunners (module-level to avoid recreating in every test)
// ---------------------------------------------------------------------------

/** Fake runner where all tools are absent (exit 1). */
const allToolsAbsentRunner: CommandRunner = async () => ({ exitCode: 1 });

/** Fake runner where all tools are present (exit 0). */
const allToolsPresentRunner: CommandRunner = async () => ({ exitCode: 0 });

/** Fake runner where 'which glab' fails but everything else passes. */
const glabAbsentRunner: CommandRunner = async (command) => {
  if (command === 'which glab') return { exitCode: 1 };
  return { exitCode: 0 };
};

/** Fake runner where 'which glab' passes and everything else fails. */
const glabPresentRunner: CommandRunner = async (command) => {
  if (command === 'which glab') return { exitCode: 0 };
  return { exitCode: 1 };
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

/** A fake tool catalog entry with a recommended level. */
const RECOMMENDED_TOOL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'tool:gh',
  nature: 'tool',
  targets: ['claude'],
  scopes: ['user'],
  level: 'recommended',
  check: 'which gh',
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let targets: ReturnType<typeof resolveUserTargets>;

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
  targets = resolveUserTargets(env);
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// Scenario 1: complete config → exitCode 0
// ---------------------------------------------------------------------------

describe('runCheck — complete config', () => {
  it('returns exitCode 0 when all entries are present', async () => {
    await writeCompleteConfig(targets, REF_DENY, AGENTS_CONTENT);

    const adapter = createClaudeAdapter({
      denyRef: REF_DENY,
      agentsContent: AGENTS_CONTENT,
    });

    const result = await runCheck({
      adapter,
      entries: ALL_ENTRIES,
      scope: 'user',
      env,
    });

    expect(result.exitCode).toBe(0);
    expect(result.report.entries.every((e) => e.state === 'present')).toBe(true);
  });

  it('output indicates all entries are present', async () => {
    await writeCompleteConfig(targets, REF_DENY, AGENTS_CONTENT);

    const adapter = createClaudeAdapter({
      denyRef: REF_DENY,
      agentsContent: AGENTS_CONTENT,
    });

    const result = await runCheck({
      adapter,
      entries: ALL_ENTRIES,
      scope: 'user',
      env,
    });

    // output must mention present/ok states
    expect(result.output.toLowerCase()).toMatch(/ok|present/);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: incomplete config → exitCode 3
// ---------------------------------------------------------------------------

describe('runCheck — incomplete config', () => {
  it('returns exitCode 3 when deny rules are missing', async () => {
    // No settings.json at all → guardrail will be 'missing'
    const adapter = createClaudeAdapter({
      denyRef: REF_DENY,
      agentsContent: AGENTS_CONTENT,
    });

    const result = await runCheck({
      adapter,
      entries: [GUARDRAIL_ENTRY],
      scope: 'user',
      env,
    });

    expect(result.exitCode).toBe(3);
  });

  it('output lists the missing entry', async () => {
    const adapter = createClaudeAdapter({
      denyRef: REF_DENY,
      agentsContent: AGENTS_CONTENT,
    });

    const result = await runCheck({
      adapter,
      entries: [GUARDRAIL_ENTRY],
      scope: 'user',
      env,
    });

    expect(result.output).toMatch(/\[miss\s*\]/);
    expect(result.output).toContain('guardrails-claude');
  });

  it('report has at least one missing entry', async () => {
    const adapter = createClaudeAdapter({
      denyRef: REF_DENY,
      agentsContent: AGENTS_CONTENT,
    });

    const result = await runCheck({
      adapter,
      entries: [GUARDRAIL_ENTRY],
      scope: 'user',
      env,
    });

    const hasMissing = result.report.entries.some((e) => e.state === 'missing');
    expect(hasMissing).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: invalid JSON → exitCode 2
// ---------------------------------------------------------------------------

describe('runCheck — invalid JSON', () => {
  it('returns exitCode 2 when settings.json is malformed', async () => {
    // Write a broken JSON file
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await Bun.write(targets.claudeSettings, '{ "permissions": { "deny": [ INVALID JSON ');

    const adapter = createClaudeAdapter({
      denyRef: REF_DENY,
      agentsContent: AGENTS_CONTENT,
    });

    const result = await runCheck({
      adapter,
      entries: [GUARDRAIL_ENTRY],
      scope: 'user',
      env,
    });

    expect(result.exitCode).toBe(2);
  });

  it('output mentions the invalid file path', async () => {
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await Bun.write(targets.claudeSettings, '{ BROKEN JSON }');

    const adapter = createClaudeAdapter({
      denyRef: REF_DENY,
      agentsContent: AGENTS_CONTENT,
    });

    const result = await runCheck({
      adapter,
      entries: [GUARDRAIL_ENTRY],
      scope: 'user',
      env,
    });

    // Must be actionable — should mention the file
    expect(result.output.toLowerCase()).toMatch(/invalid|json|settings/);
    // Must include the filename or path component
    expect(result.output).toContain('settings.json');
  });

  it('returns an empty report entries array on invalid JSON', async () => {
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await Bun.write(targets.claudeSettings, '>>> not json at all <<<');

    const adapter = createClaudeAdapter({
      denyRef: REF_DENY,
      agentsContent: AGENTS_CONTENT,
    });

    const result = await runCheck({
      adapter,
      entries: [GUARDRAIL_ENTRY],
      scope: 'user',
      env,
    });

    expect(result.report.entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: advisory tools — required absent → output signals it, exitCode unchanged
// ---------------------------------------------------------------------------

describe('runCheck — advisory tools', () => {
  it('signals a missing required tool in the output without affecting exitCode', async () => {
    // Complete config so the audit passes with exitCode 0
    await writeCompleteConfig(targets, REF_DENY, AGENTS_CONTENT);

    const adapter = createClaudeAdapter({
      denyRef: REF_DENY,
      agentsContent: AGENTS_CONTENT,
    });

    const result = await runCheck({
      adapter,
      entries: ALL_ENTRIES,
      scope: 'user',
      env,
      toolEntries: [REQUIRED_TOOL_ENTRY],
      // glab absent (exit 1), advisory should report it
      toolRunner: glabAbsentRunner,
    });

    // exitCode must still reflect the audit (0 = all present)
    expect(result.exitCode).toBe(0);
    // output must report the missing required tool
    expect(result.output).toContain('tool:glab');
    expect(result.output.toLowerCase()).toMatch(/missing|absent|required/);
  });

  it('signals missing recommended tool separately from required', async () => {
    await writeCompleteConfig(targets, REF_DENY, AGENTS_CONTENT);

    const adapter = createClaudeAdapter({
      denyRef: REF_DENY,
      agentsContent: AGENTS_CONTENT,
    });

    const result = await runCheck({
      adapter,
      entries: ALL_ENTRIES,
      scope: 'user',
      env,
      toolEntries: [REQUIRED_TOOL_ENTRY, RECOMMENDED_TOOL_ENTRY],
      // Both tools absent
      toolRunner: allToolsAbsentRunner,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('tool:glab');
    expect(result.output).toContain('tool:gh');
  });

  it('outputs "all tools present" when all tool checks pass', async () => {
    await writeCompleteConfig(targets, REF_DENY, AGENTS_CONTENT);

    const adapter = createClaudeAdapter({
      denyRef: REF_DENY,
      agentsContent: AGENTS_CONTENT,
    });

    const result = await runCheck({
      adapter,
      entries: ALL_ENTRIES,
      scope: 'user',
      env,
      toolEntries: [REQUIRED_TOOL_ENTRY, RECOMMENDED_TOOL_ENTRY],
      // All tools present
      toolRunner: allToolsPresentRunner,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output.toLowerCase()).toMatch(/all tools present|tools ok/);
  });

  it('advisory tools do not raise exitCode when audit already has missing entries', async () => {
    // No settings.json → guardrail missing → audit exitCode 3
    const adapter = createClaudeAdapter({
      denyRef: REF_DENY,
      agentsContent: AGENTS_CONTENT,
    });

    const result = await runCheck({
      adapter,
      entries: [GUARDRAIL_ENTRY],
      scope: 'user',
      env,
      toolEntries: [REQUIRED_TOOL_ENTRY],
      toolRunner: allToolsAbsentRunner,
    });

    // exitCode comes from audit (3), not from tool advisory
    expect(result.exitCode).toBe(3);
    // But tool warning is still present in output
    expect(result.output).toContain('tool:glab');
  });

  it('toolResults is populated with check outcomes', async () => {
    await fs.mkdir(path.dirname(targets.claudeSettings), { recursive: true });
    await writeJson(targets.claudeSettings, {
      permissions: { deny: REF_DENY },
    });

    const adapter = createClaudeAdapter({ denyRef: REF_DENY });

    const result = await runCheck({
      adapter,
      entries: [GUARDRAIL_ENTRY],
      scope: 'user',
      env,
      toolEntries: [REQUIRED_TOOL_ENTRY],
      // glab is present (exit 0)
      toolRunner: glabPresentRunner,
    });

    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]!.id).toBe('tool:glab');
    expect(result.toolResults[0]!.present).toBe(true);
  });
});
