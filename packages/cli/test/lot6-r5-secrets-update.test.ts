/**
 * lot6-r5-secrets-update.test.ts — R5: `update` re-renders mcp secrets from
 * the manifest's secretRefs, WITHOUT any --secret-env/TTY re-prompt (D5 point
 * 4, ADR-0020 §1).
 *
 * Strategy: install an mcp entry with `--secret-env=GITHUB_TOKEN=MY_PAT` (the
 * env only ever exports MY_PAT, never GITHUB_TOKEN itself — the ref's OWN
 * name is deliberately absent). Then re-push the remote tag (same pattern as
 * lot6-r2-update-sha.test.ts) so `runUpdate` classifies the entry as stale,
 * and call `runUpdate` with no secret-related option at all.
 *
 * If cmd-update.ts failed to replay the manifest's secretRefs, the re-render
 * would fall back to the ref's own default name (GITHUB_TOKEN), which is
 * `required` and absent from env — the update would fail closed instead of
 * succeeding. A passing update, still rendering the OVERRIDDEN var, is the
 * proof that the replay happened.
 *
 * TDD: written before cmd-update.ts threads the manifest's secretRefs into
 * buildAdapter's opts (RED → GREEN).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { readJson } from '@agent-rigger/core/fs-json';
import {
  resolveHome,
  resolveOpencodeUserTargets,
  resolveUserTargets,
} from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';
import type {
  AppliedClaudeMcp,
  AppliedOpencodeMcp,
  OpencodeMcpServer,
} from '@agent-rigger/core/types';

import { runCli } from '../src/cli';
import { runUpdate } from '../src/cmd-update';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TAG = 'v1.0.0';
const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MY_PAT_VALUE = 'sekrit-update-value-do-not-persist';

const MCP_GITHUB_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'mcp:github',
  nature: 'mcp',
  targets: ['opencode'],
  scopes: ['user'],
  config: {
    type: 'local',
    command: ['bunx', 'github-mcp'],
    environment: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
  },
  secrets: [
    { ref: 'GITHUB_TOKEN', prompt: 'GitHub personal access token', required: true },
  ],
};

/** R8 analog of MCP_GITHUB_ENTRY, targeting claude's native `env` field. */
const MCP_GITHUB_ENTRY_CLAUDE: CatalogEntry = {
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
    { ref: 'GITHUB_TOKEN', prompt: 'GitHub personal access token', required: true },
  ],
};

interface IsolatedEnv {
  env: Env;
  makeRunner: () => CommandRunner;
  makeTmpFactory: (entry?: CatalogEntry) => TmpDirFactory;
  setRemoteSha: (sha: string) => void;
  cleanupAll: () => Promise<void>;
}

async function makeIsolatedEnv(): Promise<IsolatedEnv> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-lot6-r5-update-home-'));
  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }] }),
    'utf8',
  );

  // MY_PAT is the ONLY secret-bearing var ever exported — GITHUB_TOKEN itself
  // (the ref's own default name) is deliberately never set, so a fallback to
  // the default would fail closed instead of succeeding.
  const env: Env = { RIGGER_HOME: homeDir, MY_PAT: MY_PAT_VALUE };

  let currentSha = SHA_A;
  const setRemoteSha = (sha: string) => {
    currentSha = sha;
  };

  const tmpDirsCreated: string[] = [];

  // Faithful fake of `claude mcp add-json`/`remove` (mirrors
  // adapters/test/claude/lot6-r8-mcp-claude.test.ts's makeFakeClaudeMcpRunner):
  // a leaf-merge into ~/.claude.json's mcpServers / an exact-name delete.
  // Reused by both the opencode git-only runner path (never matches `claude`)
  // and the R8 claude-mcp update test below — the SAME runner now backs
  // cmd-update.ts's pluginRunner (derived from `runner`, see cmd-update.ts).
  const readClaudeJson = async (): Promise<Record<string, unknown>> => {
    try {
      const raw = await fs.readFile(path.join(resolveHome(env), '.claude.json'), 'utf-8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const writeClaudeJson = async (obj: Record<string, unknown>): Promise<void> => {
    const p = path.join(resolveHome(env), '.claude.json');
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(obj, null, 2), 'utf-8');
  };

  const makeRunner = (): CommandRunner => (cmd, args) => {
    const argv = args ?? [];
    if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${currentSha}\trefs/tags/${TAG}\n`,
        stderr: '',
      });
    }
    if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
      return Promise.resolve({ exitCode: 0, stdout: `${currentSha}\tHEAD\n`, stderr: '' });
    }
    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${currentSha}\n`, stderr: '' });
    }
    if (cmd === 'claude' && argv[0] === 'mcp' && argv[1] === 'add-json') {
      const server = argv[2] as string;
      const json = argv[3] as string;
      return readClaudeJson().then(async (current) => {
        const servers = (current['mcpServers'] as Record<string, unknown>) ?? {};
        servers[server] = JSON.parse(json);
        current['mcpServers'] = servers;
        await writeClaudeJson(current);
        return { exitCode: 0, stdout: `Added ${server}`, stderr: '' };
      });
    }
    if (cmd === 'claude' && argv[0] === 'mcp' && argv[1] === 'remove') {
      const server = argv[2] as string;
      return readClaudeJson().then(async (current) => {
        const servers = (current['mcpServers'] as Record<string, unknown>) ?? {};
        delete servers[server];
        current['mcpServers'] = servers;
        await writeClaudeJson(current);
        return { exitCode: 0, stdout: `Removed ${server}`, stderr: '' };
      });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };

  const makeTmpFactory = (entry: CatalogEntry = MCP_GITHUB_ENTRY): TmpDirFactory => async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-lot6-r5-update-checkout-'));
    tmpDirsCreated.push(tmpDir);
    await fs.writeFile(
      path.join(tmpDir, 'catalog.json'),
      JSON.stringify({ meta: { name: 'lot6-r5-catalog' }, entries: [entry] }),
      'utf8',
    );
    return {
      path: tmpDir,
      cleanup: async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
      },
    };
  };

  const cleanupAll = async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    for (const d of tmpDirsCreated) {
      await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    }
  };

  return { env, makeRunner, makeTmpFactory, setRemoteSha, cleanupAll };
}

function makeCapture(): { lines: string[]; print: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

let iso: IsolatedEnv;
beforeEach(async () => {
  iso = await makeIsolatedEnv();
});
afterEach(async () => {
  await iso.cleanupAll();
});

// ---------------------------------------------------------------------------
// Update re-renders from manifest secretRefs, no re-prompt
// ---------------------------------------------------------------------------

describe('lot6-R5: update re-renders mcp secrets from manifest, without re-prompting', () => {
  it('installs with --secret-env, then update succeeds and keeps rendering the OVERRIDDEN var', async () => {
    const opencodeTargets = resolveOpencodeUserTargets(iso.env);
    const stateJson = resolveUserTargets(iso.env).stateJson;

    // 1. Install with the override — GITHUB_TOKEN's own name is never in env.
    const installCode = await runCli(
      [
        'install',
        'principal/mcp:github',
        '--yes',
        '--assistant=opencode',
        '--secret-env=GITHUB_TOKEN=MY_PAT',
      ],
      {
        print: makeCapture().print,
        env: iso.env,
        remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
      },
    );
    expect(installCode).toBe(0);

    const afterInstall = await readJson(opencodeTargets.opencodeJson);
    const mcpAfterInstall = afterInstall['mcp'] as Record<string, OpencodeMcpServer>;
    expect(
      (mcpAfterInstall['github'] as { environment?: Record<string, string> }).environment,
    ).toEqual({ GITHUB_TOKEN: '{env:MY_PAT}' });

    // 2. Remote re-pushes the tag on a new commit → runUpdate classifies stale.
    iso.setRemoteSha(SHA_B);

    const result = await runUpdate({
      ids: ['principal/mcp:github'],
      scope: 'user',
      env: iso.env,
      manifestPath: stateJson,
      catalogUrl: 'https://example.com/catalog.git',
      runner: iso.makeRunner(),
      tmpFactory: iso.makeTmpFactory(),
      scanner: stubScanner,
      confirm: true,
      assistant: 'opencode',
    });

    // No secret-related option was passed to runUpdate at all — a fallback to
    // the ref's default name would have thrown (required, absent from env).
    expect(result.updated).toContain('principal/mcp:github');

    const afterUpdate = await readJson(opencodeTargets.opencodeJson);
    const mcpAfterUpdate = afterUpdate['mcp'] as Record<string, OpencodeMcpServer>;
    expect(
      (mcpAfterUpdate['github'] as { environment?: Record<string, string> }).environment,
    ).toEqual({ GITHUB_TOKEN: '{env:MY_PAT}' });

    const raw = await fs.readFile(stateJson, 'utf8');
    const manifest = JSON.parse(raw) as {
      artifacts: Array<{ id: string; sha?: string; applied?: AppliedOpencodeMcp }>;
    };
    const entry = manifest.artifacts.find((a) => a.id === 'principal/mcp:github');
    expect(entry?.sha).toBe(SHA_B);
    expect(entry?.applied?.secretRefs).toEqual({ GITHUB_TOKEN: 'MY_PAT' });

    // The real secret value is never persisted anywhere.
    expect(raw).not.toContain(MY_PAT_VALUE);
    const opencodeRaw = await fs.readFile(opencodeTargets.opencodeJson, 'utf8');
    expect(opencodeRaw).not.toContain(MY_PAT_VALUE);
  });
});

// ---------------------------------------------------------------------------
// R8: same replay guarantee for the claude-mcp applied payload
//
// Bug this guards: cmd-update.ts's secretRefs replay loop gated on
// `applied.kind === 'opencode-mcp'` only — an installed 'claude-mcp' entry
// (AppliedClaudeMcp also carries secretRefs, core/types.ts) was silently
// skipped, so update fell back to the ref's own default name. Same probe as
// the opencode case above: only the OVERRIDDEN var (MY_PAT) is ever in env,
// GITHUB_TOKEN's own name is deliberately absent — a failure to replay
// secretRefs fails closed (MissingRequiredSecretError) instead of updating.
// ---------------------------------------------------------------------------

describe('lot6-R8: update re-renders claude mcp secrets from manifest, without re-prompting', () => {
  it('installs with --secret-env, then update succeeds and keeps rendering the OVERRIDDEN var', async () => {
    const claudeJsonPath = path.join(resolveHome(iso.env), '.claude.json');
    const stateJson = resolveUserTargets(iso.env).stateJson;

    // 1. Install with the override — GITHUB_TOKEN's own name is never in env.
    const installCode = await runCli(
      [
        'install',
        'principal/mcp:github',
        '--yes',
        '--assistant=claude',
        '--secret-env=GITHUB_TOKEN=MY_PAT',
      ],
      {
        print: makeCapture().print,
        env: iso.env,
        remote: {
          run: iso.makeRunner(),
          tmpFactory: iso.makeTmpFactory(MCP_GITHUB_ENTRY_CLAUDE),
          scanner: stubScanner,
        },
      },
    );
    expect(installCode).toBe(0);

    const afterInstall = JSON.parse(await fs.readFile(claudeJsonPath, 'utf-8')) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    expect(afterInstall.mcpServers['github']?.env).toEqual({ GITHUB_TOKEN: '${MY_PAT}' });

    // 2. Remote re-pushes the tag on a new commit → runUpdate classifies stale.
    iso.setRemoteSha(SHA_B);

    const result = await runUpdate({
      ids: ['principal/mcp:github'],
      scope: 'user',
      env: iso.env,
      manifestPath: stateJson,
      catalogUrl: 'https://example.com/catalog.git',
      runner: iso.makeRunner(),
      tmpFactory: iso.makeTmpFactory(MCP_GITHUB_ENTRY_CLAUDE),
      scanner: stubScanner,
      confirm: true,
      assistant: 'claude',
    });

    // No secret-related option was passed to runUpdate at all — a fallback to
    // the ref's default name would have thrown (required, absent from env).
    expect(result.updated).toContain('principal/mcp:github');

    const afterUpdate = JSON.parse(await fs.readFile(claudeJsonPath, 'utf-8')) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    expect(afterUpdate.mcpServers['github']?.env).toEqual({ GITHUB_TOKEN: '${MY_PAT}' });

    const raw = await fs.readFile(stateJson, 'utf8');
    const manifest = JSON.parse(raw) as {
      artifacts: Array<{ id: string; sha?: string; applied?: AppliedClaudeMcp }>;
    };
    const entry = manifest.artifacts.find((a) => a.id === 'principal/mcp:github');
    expect(entry?.sha).toBe(SHA_B);
    expect(entry?.applied?.secretRefs).toEqual({ GITHUB_TOKEN: 'MY_PAT' });

    // The real secret value is never persisted anywhere.
    expect(raw).not.toContain(MY_PAT_VALUE);
    const claudeJsonRaw = await fs.readFile(claudeJsonPath, 'utf-8');
    expect(claudeJsonRaw).not.toContain(MY_PAT_VALUE);
  });
});
