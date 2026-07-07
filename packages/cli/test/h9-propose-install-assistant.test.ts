/**
 * H9 — the post-init proposed install must target the assistant(s) the user chose.
 *
 * runInteractiveProposeInstall (init TTY / catalog add) and the `init --yes`
 * path used to call runRemoteInstall without the `assistant` field, so the
 * proposed install always defaulted to 'claude' even when the user had just
 * picked opencode in the init wizard (config.assistants is persisted BEFORE
 * the proposal step — cmd-init.ts step 4 vs step 6).
 *
 * Strategy (mirrors init-yes-defaults.test.ts): isolated RIGGER_HOME, fake
 * CommandRunner + tmpFactory with a pre-populated catalog checkout. The real
 * `--yes` proposal gate in runCli is exercised (prompts.proposeInstall is NOT
 * injected); prompts.askAssistants IS injected so the wizard persists the
 * chosen assistant(s) before the proposal runs.
 *
 * Scenarios:
 * H9a  init --yes, askAssistants → ['opencode']      → manifest entry assistant='opencode'.
 * H9b  init --yes, askAssistants → ['claude','opencode'] → one manifest entry per assistant.
 * H9c  init --yes, no askAssistants, nothing detected → 'claude' (pre-M3 back-compat).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { findEntry, readManifest } from '@agent-rigger/core/manifest';
import { resolveOpencodeUserTargets, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';

import { runCli } from '../src/cli';
import type { CliDeps, CliPrompts } from '../src/cli';

const TAG_NAME = 'v1.0.0';
const SHA = 'cafebabecafebabecafebabecafebabecafebabe';
const CATALOG_URL = 'https://example.com/catalog.git';
const QUALIFIED_ID = 'principal/context:main';
const AGENTS_CONTENT = '# Proposed Agents\nposed via the post-init proposal.';

const CONTEXT_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'context:main',
  nature: 'context',
  targets: ['claude', 'opencode'],
  scopes: ['user'],
};

// ---------------------------------------------------------------------------
// Fixture — isolated HOME + pre-populated catalog checkout
// ---------------------------------------------------------------------------

interface Fixture {
  env: Env;
  homeDir: string;
  contentDir: string;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  manifestPath: string;
  cleanupAll: () => Promise<void>;
}

async function makeFixture(): Promise<Fixture> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-h9-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-h9-content-'));

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({
      meta: { name: 'h9-test-catalog', required: ['context:main'] },
      entries: [CONTEXT_ENTRY],
    }),
    'utf8',
  );
  const ctxDir = path.join(contentDir, 'contexts', 'main');
  await fs.mkdir(ctxDir, { recursive: true });
  await fs.writeFile(path.join(ctxDir, 'AGENTS.md'), AGENTS_CONTENT, 'utf8');

  const env: Env = { RIGGER_HOME: homeDir };
  const manifestPath = path.join(homeDir, '.config', 'agent-rigger', 'state.json');

  const runner: CommandRunner = (_cmd, args) => {
    const argv = args ?? [];
    if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${SHA}\trefs/tags/${TAG_NAME}\n`,
        stderr: '',
      });
    }
    if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\tHEAD\n`, stderr: '' });
    }
    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };

  const tmpFactory: TmpDirFactory = async () => ({ path: contentDir, cleanup: async () => {} });

  const cleanupAll = async () => {
    await Promise.all([
      fs.rm(homeDir, { recursive: true, force: true }),
      fs.rm(contentDir, { recursive: true, force: true }),
    ]);
  };

  return { env, homeDir, contentDir, runner, tmpFactory, manifestPath, cleanupAll };
}

/** CliDeps for an init --yes run — real --yes proposal gate (no proposeInstall injection). */
function makeDeps(fix: Fixture, prompts?: Partial<CliPrompts>): CliDeps {
  return {
    env: fix.env,
    print: () => {},
    remote: { run: fix.runner, tmpFactory: fix.tmpFactory, scanner: stubScanner },
    prompts: {
      selectArtifacts: async () => [],
      selectScope: async () => 'user',
      confirmApply: async () => true,
      askUrl: async () => CATALOG_URL,
      askMethod: async () => 'https',
      // proposeInstall deliberately absent → exercises the real --yes gate
      ...prompts,
    },
  };
}

/** Pin isTTY so the interactive picker branch is never taken by accident. */
function setStdoutIsTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
}

let fix: Fixture;

beforeEach(async () => {
  setStdoutIsTTY(false);
  fix = await makeFixture();
});

afterEach(async () => {
  setStdoutIsTTY(false);
  await fix.cleanupAll();
});

// ---------------------------------------------------------------------------
// H9a — init --yes selecting opencode installs for opencode, not claude
// ---------------------------------------------------------------------------

describe('H9a — init --yes with askAssistants → [opencode]', () => {
  it('writes the manifest entry with assistant "opencode" (never claude)', async () => {
    const code = await runCli(
      ['init', '--yes'],
      makeDeps(fix, { askAssistants: async () => ['opencode'] }),
    );
    expect(code).toBe(0);

    const manifest = await readManifest(fix.manifestPath);
    expect(findEntry(manifest, QUALIFIED_ID, 'user', 'opencode')).toBeDefined();
    expect(findEntry(manifest, QUALIFIED_ID, 'user', 'claude')).toBeUndefined();
  });

  it('poses the content through the opencode adapter (AGENTS.md under ~/.config/opencode)', async () => {
    await runCli(
      ['init', '--yes'],
      makeDeps(fix, { askAssistants: async () => ['opencode'] }),
    );

    const opencodeAgentsMd = await Bun.file(resolveOpencodeUserTargets(fix.env).agentsMd).text();
    expect(opencodeAgentsMd).toBe(AGENTS_CONTENT);

    // The claude-side AGENTS.md must NOT have been written.
    const claudeAgentsExists = await Bun.file(resolveUserTargets(fix.env).agentsMd).exists();
    expect(claudeAgentsExists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// H9b — init --yes selecting both assistants installs once per assistant
// ---------------------------------------------------------------------------

describe('H9b — init --yes with askAssistants → [claude, opencode]', () => {
  it('writes one manifest entry per configured assistant', async () => {
    const code = await runCli(
      ['init', '--yes'],
      makeDeps(fix, { askAssistants: async () => ['claude', 'opencode'] }),
    );
    expect(code).toBe(0);

    const manifest = await readManifest(fix.manifestPath);
    expect(findEntry(manifest, QUALIFIED_ID, 'user', 'claude')).toBeDefined();
    expect(findEntry(manifest, QUALIFIED_ID, 'user', 'opencode')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// H9c — back-compat: nothing chosen, nothing detected → claude
// ---------------------------------------------------------------------------

describe('H9c — init --yes without askAssistants and nothing detected', () => {
  it('falls back to claude (pre-M3 behaviour)', async () => {
    const code = await runCli(['init', '--yes'], makeDeps(fix));
    expect(code).toBe(0);

    const manifest = await readManifest(fix.manifestPath);
    expect(findEntry(manifest, QUALIFIED_ID, 'user', 'claude')).toBeDefined();
    expect(findEntry(manifest, QUALIFIED_ID, 'user', 'opencode')).toBeUndefined();
  });
});
