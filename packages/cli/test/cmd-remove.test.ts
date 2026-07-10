/**
 * Tests for cmd-remove.ts — runRemove.
 *
 * Strategy:
 * - Real createClaudeAdapter + real filesystem (isolated RIGGER_HOME via tmp dir).
 * - confirm injected as boolean or async callback — no TTY required.
 * - No process.exit, no while loops.
 *
 * Scenarios:
 * 1. remove after install (confirm:true)  → deny rules removed, manifest entry deleted,
 *    applied:true, removed non-empty.
 * 2. confirm:false                        → applied:false, nothing removed, manifest intact.
 * 3. id absent from manifest              → throws NotInstalledError (R5: manifest-first).
 * 4. pack id                              → NotInstalledError explaining pack expansion (R5).
 * 5. remove context-claude               → AGENTS.md deleted, manifest entry deleted.
 * 6. check after remove                  → missing state.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { Scope } from '@agent-rigger/core/types';

import { createClaudeAdapter } from '@agent-rigger/adapters';

import type { CatalogEntry } from '@agent-rigger/catalog';

import { runInstall } from '../src/cmd-install';
import { NotInstalledError, runRemove } from '../src/cmd-remove';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-cmd-remove-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REF_DENY = ['Read(./.env)', 'Read(~/.ssh/**)', 'Read(./secrets/**)'];
const AGENTS_CONTENT = '# Agents\nThis is the canonical AGENTS.md.';

const GUARDRAIL_CATALOG_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'guardrails-claude',
  nature: 'guardrail',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

const CONTEXT_CATALOG_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'context-claude',
  nature: 'context',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

const MINI_CATALOG: CatalogEntry[] = [GUARDRAIL_CATALOG_ENTRY, CONTEXT_CATALOG_ENTRY];

// ---------------------------------------------------------------------------
// Shared fixture lifecycle
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let targets: ReturnType<typeof resolveUserTargets>;
let manifestPath: string;

const SCOPE: Scope = 'user';

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
  targets = resolveUserTargets(env);
  manifestPath = targets.stateJson;
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// Helper: install guardrails-claude
// ---------------------------------------------------------------------------

async function installGuardrail(): Promise<void> {
  const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });
  await runInstall({
    catalog: MINI_CATALOG,
    adapter,
    scope: SCOPE,
    env,
    manifestPath,
    selectedIds: ['guardrails-claude'],
    confirm: true,
  });
}

async function installContext(): Promise<void> {
  const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });
  await runInstall({
    catalog: MINI_CATALOG,
    adapter,
    scope: SCOPE,
    env,
    manifestPath,
    selectedIds: ['context-claude'],
    confirm: true,
  });
}

async function installBoth(): Promise<void> {
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
}

// ---------------------------------------------------------------------------
// Scenario 1: remove guardrails-claude after install (confirm:true)
// ---------------------------------------------------------------------------

describe('runRemove — guardrails-claude, confirm:true', () => {
  it('returns applied:true', async () => {
    await installGuardrail();
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    const result = await runRemove({
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude'],
      confirm: true,
    });

    expect(result.applied).toBe(true);
  });

  it('removed list contains guardrails-claude', async () => {
    await installGuardrail();
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    const result = await runRemove({
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude'],
      confirm: true,
    });

    expect(result.removed).toContain('guardrails-claude');
  });

  it('manifest entry is deleted after remove', async () => {
    await installGuardrail();
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    await runRemove({
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude'],
      confirm: true,
    });

    const raw = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as { artifacts: Array<{ id: string }> };
    const ids = manifest.artifacts.map((a) => a.id);
    expect(ids).not.toContain('guardrails-claude');
  });

  it('deny rules are removed from settings.json', async () => {
    await installGuardrail();
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    await runRemove({
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude'],
      confirm: true,
    });

    const raw = await fs.readFile(targets.claudeSettings, 'utf8');
    const parsed = JSON.parse(raw) as { permissions?: { deny?: string[] } };
    const deny = parsed.permissions?.deny ?? [];

    for (const rule of REF_DENY) {
      expect(deny).not.toContain(rule);
    }
  });

  it('output contains removal plan text', async () => {
    await installGuardrail();
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    const result = await runRemove({
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude'],
      confirm: true,
    });

    expect(result.output).toMatch(/removal plan|remove|un-deny|uninstall/i);
  });

  it('confirm callback is called', async () => {
    await installGuardrail();
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });
    let confirmCalled = false;

    await runRemove({
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude'],
      confirm: async (_planText) => {
        confirmCalled = true;
        return true;
      },
    });

    expect(confirmCalled).toBe(true);
  });

  it('confirm callback receives non-empty planText', async () => {
    await installGuardrail();
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });
    let capturedPlanText = '';

    await runRemove({
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

    expect(capturedPlanText.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: confirm:false → nothing removed
// ---------------------------------------------------------------------------

describe('runRemove — confirm:false', () => {
  it('returns applied:false', async () => {
    await installGuardrail();
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    const result = await runRemove({
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude'],
      confirm: false,
    });

    expect(result.applied).toBe(false);
  });

  it('manifest entry remains when confirm:false', async () => {
    await installGuardrail();
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    await runRemove({
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude'],
      confirm: false,
    });

    const raw = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as { artifacts: Array<{ id: string }> };
    const ids = manifest.artifacts.map((a) => a.id);
    expect(ids).toContain('guardrails-claude');
  });

  it('deny rules remain in settings.json when confirm:false', async () => {
    await installGuardrail();
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    await runRemove({
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude'],
      confirm: false,
    });

    const raw = await fs.readFile(targets.claudeSettings, 'utf8');
    const parsed = JSON.parse(raw) as { permissions?: { deny?: string[] } };
    const deny = parsed.permissions?.deny ?? [];
    expect(deny).toContain(REF_DENY[0] as string);
  });

  it('output contains abort message when confirm:false', async () => {
    await installGuardrail();
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    const result = await runRemove({
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude'],
      confirm: false,
    });

    expect(result.output.toLowerCase()).toMatch(/abort|cancel/);
  });

  it('removed list is empty when confirm:false', async () => {
    await installGuardrail();
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    const result = await runRemove({
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude'],
      confirm: false,
    });

    expect(result.removed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: id absent from the manifest → throws NotInstalledError.
// Inverted knowingly for R5 (lot2-remove-reversible): remove validates against
// the manifest, not the catalog — an id the manifest does not know is an error.
// ---------------------------------------------------------------------------

describe('runRemove — id absent from manifest', () => {
  it('R5: throws NotInstalledError when the entry was never installed', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    const fn = () =>
      runRemove({
        adapter,
        scope: SCOPE,
        env,
        manifestPath,
        selectedIds: ['guardrails-claude'],
        confirm: true,
      });

    await expect(fn).toThrow(NotInstalledError);
  });

  it('R5: error names the id and lists the entries installed in the manifest', async () => {
    await installGuardrail();
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    let errorMessage = '';
    try {
      await runRemove({
        adapter,
        scope: SCOPE,
        env,
        manifestPath,
        selectedIds: ['context-claude'],
        confirm: true,
      });
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    expect(errorMessage).toContain('context-claude');
    expect(errorMessage.toLowerCase()).toContain('not installed');
    expect(errorMessage).toContain('guardrails-claude');
    expect(errorMessage).not.toContain('agent-rigger ls');
  });

  it('R5: confirm callback is NOT called when validation fails', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });
    let confirmCallCount = 0;

    try {
      await runRemove({
        adapter,
        scope: SCOPE,
        env,
        manifestPath,
        selectedIds: ['guardrails-claude'],
        confirm: async (_planText) => {
          confirmCallCount++;
          return true;
        },
      });
    } catch {
      // Expected: NotInstalledError.
    }

    expect(confirmCallCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: pack id → NotInstalledError explaining pack expansion.
// Inverted knowingly for R5: the catalog no longer plays any role in remove —
// the former "unknown id (not in catalog)" case IS the manifest-absence case.
// ---------------------------------------------------------------------------

describe('runRemove — pack id', () => {
  it('R5: unknown ids raise NotInstalledError naming the id', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    let errorMessage = '';
    try {
      await runRemove({
        adapter,
        scope: SCOPE,
        env,
        manifestPath,
        selectedIds: ['unknown:artifact'],
        confirm: true,
      });
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    expect(errorMessage).toContain('unknown:artifact');
    expect(errorMessage.toLowerCase()).toContain('not installed');
  });

  it('R5: pack ids raise NotInstalledError explaining packs are expanded at install', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    let errorMessage = '';
    try {
      await runRemove({
        adapter,
        scope: SCOPE,
        env,
        manifestPath,
        selectedIds: ['principal/pack:harness'],
        confirm: true,
      });
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    expect(errorMessage.toLowerCase()).toContain('not installed');
    expect(errorMessage.toLowerCase()).toMatch(/expanded at install/);
    expect(errorMessage.toLowerCase()).toMatch(/member/);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: remove context-claude → AGENTS.md deleted
// ---------------------------------------------------------------------------

describe('runRemove — context-claude, AGENTS.md', () => {
  it('AGENTS.md no longer exists after context remove', async () => {
    await installContext();

    // Verify it was installed first
    const statBefore = await fs.stat(targets.agentsMd).catch(() => null);
    expect(statBefore).not.toBeNull();

    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });
    await runRemove({
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['context-claude'],
      confirm: true,
    });

    const statAfter = await fs.stat(targets.agentsMd).catch(() => null);
    expect(statAfter).toBeNull();
  });

  it('context-claude manifest entry is deleted', async () => {
    await installContext();
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    await runRemove({
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['context-claude'],
      confirm: true,
    });

    const raw = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as { artifacts: Array<{ id: string }> };
    const ids = manifest.artifacts.map((a) => a.id);
    expect(ids).not.toContain('context-claude');
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: remove both, then check → all missing in manifest
// ---------------------------------------------------------------------------

describe('runRemove — remove both guardrails+context', () => {
  it('removes both entries from manifest', async () => {
    await installBoth();
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    const result = await runRemove({
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    expect(result.applied).toBe(true);
    expect(result.removed).toContain('guardrails-claude');
    expect(result.removed).toContain('context-claude');

    const raw = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as { artifacts: Array<{ id: string }> };
    expect(manifest.artifacts).toHaveLength(0);
  });

  it('manifest is empty after removing all entries', async () => {
    await installBoth();
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    await runRemove({
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude', 'context-claude'],
      confirm: true,
    });

    const raw = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as { artifacts: Array<{ id: string }> };
    expect(manifest.artifacts).toHaveLength(0);
  });
});
