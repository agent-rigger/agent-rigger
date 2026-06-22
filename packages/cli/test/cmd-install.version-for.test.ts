/**
 * Tests for runInstall() — versionFor thread (M1b-3 Part C).
 *
 * Verifies:
 * 1. runInstall with versionFor → manifest entries carry the provided source/ref/sha.
 * 2. runInstall without versionFor → manifest defaults to source:internal/ref:v0.0.0/sha:''.
 *
 * Strategy:
 * - Real createClaudeAdapter + real filesystem (tmp HOME).
 * - versionFor injected via RunInstallOptions.
 * - Only inspects the manifest file — no TTY, no shell.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { createClaudeAdapter } from '@agent-rigger/adapters';

import type { CatalogEntry } from '@agent-rigger/catalog';

import { runInstall } from '../src/cmd-install';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-install-vf-'): Promise<{
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

const REF_DENY = ['Read(~/.ssh/**)', 'Write(~/.aws/**)'];
const AGENTS_CONTENT = '# Agents\nFixture.';

const GUARDRAIL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'guardrails-claude',
  nature: 'guardrail',
  source: 'internal',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

const MINI_CATALOG: CatalogEntry[] = [GUARDRAIL_ENTRY];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let manifestPath: string;

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
  manifestPath = resolveUserTargets(env).stateJson;
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// Part C-1: versionFor provided → manifest reflects custom values
// ---------------------------------------------------------------------------

describe('runInstall — with versionFor', () => {
  it('manifest entry carries source/ref/sha from versionFor', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['guardrails-claude'],
      confirm: true,
      versionFor: () => ({ source: 'external', ref: 'v3.1.0', sha: 'cafecafe' }),
    });

    const raw = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as {
      artifacts: Array<{ id: string; source: string; ref: string; sha: string }>;
    };

    const artifact = manifest.artifacts.find((a) => a.id === 'guardrails-claude');
    expect(artifact).toBeDefined();
    expect(artifact!.source).toBe('external');
    expect(artifact!.ref).toBe('v3.1.0');
    expect(artifact!.sha).toBe('cafecafe');
  });

  it('versionFor is called with the AdapterEntry being installed', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });
    const calledWith: AdapterEntry[] = [];

    await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['guardrails-claude'],
      confirm: true,
      versionFor: (entry) => {
        calledWith.push(entry);
        return { source: 'external', ref: 'v1.0.0', sha: 'aabbcc' };
      },
    });

    expect(calledWith.length).toBeGreaterThan(0);
    expect(calledWith[0]!.id).toBe('guardrails-claude');
  });
});

// ---------------------------------------------------------------------------
// Part C-2: without versionFor → defaults apply
// ---------------------------------------------------------------------------

describe('runInstall — without versionFor', () => {
  it('manifest entry defaults to source:internal, ref:v0.0.0, sha:""', async () => {
    const adapter = createClaudeAdapter({ denyRef: REF_DENY, agentsContent: AGENTS_CONTENT });

    await runInstall({
      catalog: MINI_CATALOG,
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['guardrails-claude'],
      confirm: true,
    });

    const raw = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as {
      artifacts: Array<{ id: string; source: string; ref: string; sha: string }>;
    };

    const artifact = manifest.artifacts.find((a) => a.id === 'guardrails-claude');
    expect(artifact).toBeDefined();
    expect(artifact!.source).toBe('internal');
    expect(artifact!.ref).toBe('v0.0.0');
    expect(artifact!.sha).toBe('');
  });
});
