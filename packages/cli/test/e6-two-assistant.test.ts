/**
 * E6 — two-assistant manifest isolation (wiring slice B).
 *
 * Verifies that check/remove act only on the selected assistant's manifest
 * entries when the SAME id is installed for both claude and opencode: neither
 * command ever reads, previews, or mutates the other assistant's state.
 *
 * Strategy: install the same guardrail id under both assistants via runCli
 * (real install pipeline, fake CommandRunner — no real git/network), then
 * exercise check/remove per-assistant and assert isolation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { readJson } from '@agent-rigger/core/fs-json';
import { findEntry, readManifest } from '@agent-rigger/core/manifest';
import { resolveOpencodeUserTargets, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { runCli } from '../src/cli';

const GUARDRAIL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'guardrail:main',
  nature: 'guardrail',
  targets: ['claude', 'opencode'],
  scopes: ['user'],
};

function makeCapture(): { lines: string[]; print: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

/** Fake CommandRunner satisfying resolveVersion/withRemoteCheckout (no real git). */
function makeSuccessRunner(): CommandRunner {
  const sha = 'a'.repeat(40);
  return (_cmd, args) => {
    const argv = args ?? [];
    if (argv.includes('ls-remote') && argv.includes('--tags')) {
      return Promise.resolve({ exitCode: 0, stdout: `${sha}\trefs/tags/v1.0.0\n`, stderr: '' });
    }
    if (argv.includes('ls-remote') && argv.includes('HEAD')) {
      return Promise.resolve({ exitCode: 0, stdout: `${sha}\tHEAD\n`, stderr: '' });
    }
    if (argv.includes('clone')) {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argv.includes('rev-parse')) {
      return Promise.resolve({ exitCode: 0, stdout: `${sha}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };
}

/**
 * Checkout writer shipping BOTH guardrail sources: Claude deny/allow rules (for
 * the claude adapter) and a native opencode permission.json descriptor (for the
 * opencode adapter, ADR-0020 "Option A" — no translation).
 */
function makeGuardrailTmpFactory(dir: string): TmpDirFactory {
  return async () => {
    await Bun.write(
      path.join(dir, 'catalog.json'),
      JSON.stringify({ meta: { name: 'e6-test-catalog' }, entries: [GUARDRAIL_ENTRY] }),
    );
    // Bi-target guardrail: claude deny/allow under claude/, opencode permission
    // under opencode/ (post-cutover, R9 — one dir per assistant).
    const claudeGuardrailDir = path.join(dir, 'claude', 'guardrails', 'main');
    const opencodeGuardrailDir = path.join(dir, 'opencode', 'guardrails', 'main');
    await fs.mkdir(claudeGuardrailDir, { recursive: true });
    await fs.mkdir(opencodeGuardrailDir, { recursive: true });
    await Bun.write(
      path.join(claudeGuardrailDir, 'deny.json'),
      JSON.stringify({ deny: ['Bash(rm -rf *)'] }),
    );
    await Bun.write(path.join(claudeGuardrailDir, 'allow.json'), JSON.stringify({ allow: [] }));
    await Bun.write(
      path.join(opencodeGuardrailDir, 'permission.json'),
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        permission: { bash: { 'rm -rf *': 'deny' } },
      }),
    );
    return { path: dir, cleanup: async () => {} };
  };
}

let tmp: { dir: string; cleanup: () => Promise<void> };
let env: Env;

beforeEach(async () => {
  tmp = {
    dir: await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-e6-')),
    cleanup: () => Promise.resolve(),
  };
  tmp.cleanup = () => fs.rm(tmp.dir, { recursive: true, force: true });
  env = { RIGGER_HOME: tmp.dir };

  const configDir = path.join(tmp.dir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });
  await Bun.write(
    path.join(configDir, 'config.json'),
    JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }] }),
  );
});

afterEach(async () => {
  await tmp.cleanup();
});

/** Install guardrail:main for the given assistant via the real install pipeline. */
async function installFor(assistant: 'claude' | 'opencode'): Promise<void> {
  const cDir = await fs.mkdtemp(path.join(os.tmpdir(), `rigger-e6-install-${assistant}-`));
  try {
    const code = await runCli(
      ['install', 'principal/guardrail:main', '--yes', `--assistant=${assistant}`],
      {
        print: makeCapture().print,
        env,
        remote: { run: makeSuccessRunner(), tmpFactory: makeGuardrailTmpFactory(cDir) },
      },
    );
    expect(code).toBe(0);
  } finally {
    await fs.rm(cDir, { recursive: true, force: true });
  }
}

describe('E6 — two-assistant manifest: install both, check independently', () => {
  it('check --assistant=claude and check --assistant=opencode both report present (exit 0), independently', async () => {
    await installFor('claude');
    await installFor('opencode');

    const manifest = await readManifest(
      path.join(tmp.dir, '.config', 'agent-rigger', 'state.json'),
    );
    expect(findEntry(manifest, 'principal/guardrail:main', 'user', 'claude')).toBeDefined();
    expect(findEntry(manifest, 'principal/guardrail:main', 'user', 'opencode')).toBeDefined();

    const claudeCheck = await runCli(['check', '--assistant=claude'], {
      print: makeCapture().print,
      env,
    });
    expect(claudeCheck).toBe(0);

    const opencodeCheck = await runCli(['check', '--assistant=opencode'], {
      print: makeCapture().print,
      env,
    });
    expect(opencodeCheck).toBe(0);
  });
});

describe('E6 — two-assistant manifest: remove one assistant leaves the other untouched', () => {
  it('remove --assistant=opencode drops only the opencode manifest entry and opencode.json state', async () => {
    await installFor('claude');
    await installFor('opencode');

    const claudeSettingsBefore = await readJson(resolveUserTargets(env).claudeSettings);
    const opencodeJsonBefore = await readJson(resolveOpencodeUserTargets(env).opencodeJson);
    expect(opencodeJsonBefore['permission']).toBeDefined();

    const removeCDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-e6-remove-'));
    const cap = makeCapture();
    const code = await runCli(
      ['remove', 'principal/guardrail:main', '--yes', '--assistant=opencode'],
      {
        print: cap.print,
        env,
        remote: { run: makeSuccessRunner(), tmpFactory: makeGuardrailTmpFactory(removeCDir) },
      },
    );
    await fs.rm(removeCDir, { recursive: true, force: true });
    expect(code).toBe(0);

    // Manifest: opencode entry gone, claude entry untouched.
    const manifest = await readManifest(
      path.join(tmp.dir, '.config', 'agent-rigger', 'state.json'),
    );
    expect(findEntry(manifest, 'principal/guardrail:main', 'user', 'opencode')).toBeUndefined();
    const claudeEntry = findEntry(manifest, 'principal/guardrail:main', 'user', 'claude');
    expect(claudeEntry).toBeDefined();

    // claude's settings.json deny list is byte-for-byte untouched by the opencode removal.
    const claudeSettingsAfter = await readJson(resolveUserTargets(env).claudeSettings);
    expect(claudeSettingsAfter).toEqual(claudeSettingsBefore);

    // opencode.json's permission fragment was actually removed (not a no-op).
    const opencodeJsonAfter = await readJson(resolveOpencodeUserTargets(env).opencodeJson);
    const permAfter = opencodeJsonAfter['permission'] as Record<string, unknown> | undefined;
    expect(permAfter === undefined || Object.keys(permAfter).length === 0).toBe(true);

    // claude is still reported present after the opencode-only removal.
    const claudeCheck = await runCli(['check', '--assistant=claude'], {
      print: makeCapture().print,
      env,
    });
    expect(claudeCheck).toBe(0);
  });
});
