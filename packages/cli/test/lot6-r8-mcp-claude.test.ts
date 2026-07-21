/**
 * lot6-r8-mcp-claude.test.ts — R8: the CLI wiring of the claude mcp nature
 * (buildClaudeAdapter.mcpSource + shared renderMcpConfig). TDD — written before
 * adapter-builder.ts wires mcpSource/mcpRunner and before mcp-source.ts exists.
 *
 * Covers the render + fail-closed half at the CLI seam (the adapter/engine
 * lifecycle is lot6-r8-mcp-claude.test.ts under packages/adapters):
 *  - mcpSource renders env-refs VERBATIM (`${VAR}`) for claude — NOT opencode's
 *    `{env:VAR}` form (T0: Claude Code expands `${VAR}` at spawn).
 *  - a required secret whose var is absent fails closed (MissingRequiredSecretError)
 *    at plan time — before any `claude mcp add-json` is delegated.
 *  - a --secret-env-style override substitutes the OVERRIDDEN var (still verbatim)
 *    and records secretRefs GITHUB_TOKEN→MY_PAT.
 *  - secretRefs (names only) lands on the manifest applied 'claude-mcp' payload
 *    after a real apply() through the engine, and the real value never leaks.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry } from '@agent-rigger/catalog';
import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply } from '@agent-rigger/core/engine';
import { readManifest } from '@agent-rigger/core/manifest';
import type { Env } from '@agent-rigger/core/paths';
import { resolveHome } from '@agent-rigger/core/paths';
import type { AppliedClaudeMcp } from '@agent-rigger/core/types';

import type { PluginRunner } from '@agent-rigger/adapters';

import { buildClaudeAdapter } from '../src/adapter-builder';
import { MissingRequiredSecretError } from '../src/secret-collect';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECRET_SENTINEL = 'ghp-cli-real-secret-do-not-persist';

function githubMcpEntry(opts?: { required?: boolean }): CatalogEntry {
  return {
    kind: 'artifact',
    id: 'mcp:github',
    nature: 'mcp',
    targets: ['claude'],
    scopes: ['user'],
    config: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
    },
    secrets: [
      {
        ref: 'GITHUB_TOKEN',
        prompt: 'GitHub personal access token',
        required: opts?.required ?? true,
      },
    ],
  };
}

async function makeTmpHome(): Promise<{ dir: string; env: Env; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-r8-cli-'));
  return {
    dir,
    env: { RIGGER_HOME: dir },
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

/** Fake PluginRunner reused as the mcp runner: simulates add-json into ~/.claude.json. */
function makeFakeRunner(env: Env): PluginRunner {
  return async (_command, args) => {
    if (args[0] === 'mcp' && args[1] === 'add-json') {
      const server = args[2]!;
      const p = path.join(resolveHome(env), '.claude.json');
      let current: Record<string, unknown> = {};
      try {
        current = JSON.parse(await fs.readFile(p, 'utf-8')) as Record<string, unknown>;
      } catch {
        current = {};
      }
      const servers = (current['mcpServers'] as Record<string, unknown>) ?? {};
      servers[server] = JSON.parse(args[3]!);
      current['mcpServers'] = servers;
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, JSON.stringify(current, null, 2), 'utf-8');
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

const ENTRY: AdapterEntry = { id: 'mcp:github', nature: 'mcp', scope: 'user' };

// ---------------------------------------------------------------------------
// verbatim render
// ---------------------------------------------------------------------------

describe('lot6-R8: claude mcpSource renders env-refs verbatim (${VAR})', () => {
  it('renders env.GITHUB_TOKEN to ${GITHUB_TOKEN} — not opencode {env:...} form', async () => {
    const tmp = await makeTmpHome();
    try {
      const env: Env = { ...tmp.env, GITHUB_TOKEN: 'present' };
      const effectiveEntries = new Map([['mcp:github', githubMcpEntry()]]);
      const adapter = await buildClaudeAdapter(env, { effectiveEntries });

      const ops = await adapter.plan(ENTRY, 'user', env);
      const addOp = ops.find((op) => op.kind === 'mcp-add') as
        | { config: { env?: Record<string, string> }; secretRefs?: Record<string, string> }
        | undefined;

      expect(addOp).toBeDefined();
      expect(addOp!.config.env).toEqual({ GITHUB_TOKEN: '${GITHUB_TOKEN}' });
      expect(JSON.stringify(addOp)).not.toContain('{env:');
      expect(addOp!.secretRefs).toEqual({ GITHUB_TOKEN: 'GITHUB_TOKEN' });
    } finally {
      await tmp.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// fail-closed
// ---------------------------------------------------------------------------

describe('lot6-R8: claude mcpSource fails closed before any write on a missing required secret', () => {
  it('adapter.plan rejects with MissingRequiredSecretError', async () => {
    const tmp = await makeTmpHome();
    try {
      const env: Env = { ...tmp.env }; // GITHUB_TOKEN deliberately absent
      const effectiveEntries = new Map([['mcp:github', githubMcpEntry({ required: true })]]);
      const adapter = await buildClaudeAdapter(env, { effectiveEntries });

      await expect(adapter.plan(ENTRY, 'user', env)).rejects.toThrow(MissingRequiredSecretError);
    } finally {
      await tmp.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// override
// ---------------------------------------------------------------------------

describe('lot6-R8: claude mcpSource honours --secret-env-style overrides', () => {
  it('substitutes the OVERRIDDEN var (verbatim) and records secretRefs GITHUB_TOKEN→MY_PAT', async () => {
    const tmp = await makeTmpHome();
    try {
      const env: Env = { ...tmp.env, MY_PAT: 'present' }; // GITHUB_TOKEN itself absent
      const effectiveEntries = new Map([['mcp:github', githubMcpEntry()]]);
      const adapter = await buildClaudeAdapter(env, {
        effectiveEntries,
        secretOverrides: { GITHUB_TOKEN: 'MY_PAT' },
      });

      const ops = await adapter.plan(ENTRY, 'user', env);
      const addOp = ops.find((op) => op.kind === 'mcp-add') as
        | { config: { env?: Record<string, string> }; secretRefs?: Record<string, string> }
        | undefined;

      expect(addOp!.config.env).toEqual({ GITHUB_TOKEN: '${MY_PAT}' });
      expect(addOp!.secretRefs).toEqual({ GITHUB_TOKEN: 'MY_PAT' });
    } finally {
      await tmp.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// manifest secretRefs + zero-value leak
// ---------------------------------------------------------------------------

describe('lot6-R8: secretRefs lands on the manifest applied payload, real value never leaks', () => {
  it('AppliedClaudeMcp.secretRefs == {GITHUB_TOKEN: "MY_PAT"} after a real install', async () => {
    const tmp = await makeTmpHome();
    try {
      const env: Env = { ...tmp.env, MY_PAT: SECRET_SENTINEL };
      const effectiveEntries = new Map([['mcp:github', githubMcpEntry()]]);
      const runner = makeFakeRunner(env);
      const adapter = await buildClaudeAdapter(env, {
        effectiveEntries,
        secretOverrides: { GITHUB_TOKEN: 'MY_PAT' },
        pluginRunner: runner,
      });

      const manifestPath = path.join(tmp.dir, '.config', 'agent-rigger', 'state.json');
      await apply({ adapter, entries: [ENTRY], scope: 'user', env, manifestPath });

      const manifest = await readManifest(manifestPath);
      const stored = manifest.artifacts.find((a) => a.id === 'mcp:github');
      expect(stored!.applied?.kind).toBe('claude-mcp');
      expect((stored!.applied as AppliedClaudeMcp).secretRefs).toEqual({ GITHUB_TOKEN: 'MY_PAT' });

      // Zero-value scan: the real secret value appears in no written file.
      const manifestRaw = await fs.readFile(manifestPath, 'utf-8');
      expect(manifestRaw).not.toContain(SECRET_SENTINEL);
      const claudeJsonRaw = await fs.readFile(
        path.join(resolveHome(env), '.claude.json'),
        'utf-8',
      ).catch(() => '');
      expect(claudeJsonRaw).not.toContain(SECRET_SENTINEL);
    } finally {
      await tmp.cleanup();
    }
  });
});
