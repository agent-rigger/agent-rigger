/**
 * M18 — check/remove/update route the adapter from the manifest entry's
 * `assistant` field instead of re-resolving (up to re-prompting) — ADR-0020 §1
 * and R1.6 ("sans redemander").
 *
 * Failure scenario fixed here: a machine where BOTH `~/.claude` and
 * `~/.config/opencode` exist, no `assistants[]` in config, and an artifact
 * installed for opencode. Before the fix, check/remove/update re-resolved the
 * assistant (non-TTY → silent 'claude' fallback) and operated on the WRONG
 * adapter: remove reported "Nothing to remove", check never audited the entry.
 *
 * Strategy (mirrors e6-two-assistant.test.ts): install a guardrail for
 * opencode via the real install pipeline (fake CommandRunner, no network),
 * then drive check/remove/update through runCli in non-TTY without
 * --assistant and assert the opencode adapter was used.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { findEntry, readManifest } from '@agent-rigger/core/manifest';
import type { Env } from '@agent-rigger/core/paths';

import { runCli } from '../src/cli';
import type { CliDeps } from '../src/cli';

const SHA = 'a'.repeat(40);
const QUALIFIED_ID = 'principal/guardrail:main';

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
  return (_cmd, args) => {
    const argv = args ?? [];
    if (argv.includes('ls-remote') && argv.includes('--tags')) {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\trefs/tags/v1.0.0\n`, stderr: '' });
    }
    if (argv.includes('ls-remote') && argv.includes('HEAD')) {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\tHEAD\n`, stderr: '' });
    }
    if (argv.includes('clone')) {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argv.includes('rev-parse')) {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };
}

/**
 * Checkout writer shipping a native opencode permission.json descriptor for the
 * opencode adapter (ADR-0020 "Option A" — no translation). Claude deny/allow are
 * kept alongside so the same fixture stays usable for the claude adapter.
 */
function makeGuardrailTmpFactory(dir: string): TmpDirFactory {
  return async () => {
    await Bun.write(
      path.join(dir, 'catalog.json'),
      JSON.stringify({ meta: { name: 'm18-test-catalog' }, entries: [GUARDRAIL_ENTRY] }),
    );
    const guardrailDir = path.join(dir, 'guardrails', 'main');
    await fs.mkdir(guardrailDir, { recursive: true });
    await Bun.write(
      path.join(guardrailDir, 'deny.json'),
      JSON.stringify({ deny: ['Bash(rm -rf *)'] }),
    );
    await Bun.write(path.join(guardrailDir, 'allow.json'), JSON.stringify({ allow: [] }));
    await Bun.write(
      path.join(guardrailDir, 'permission.json'),
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        permission: { bash: { 'rm -rf *': 'deny' } },
      }),
    );
    return { path: dir, cleanup: async () => {} };
  };
}

/** Pin isTTY: the whole point of M18 is non-TTY routing without any prompt. */
function setStdoutIsTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
}

let tmp: { dir: string; cleanup: () => Promise<void> };
let contentDir: string;
let env: Env;
let manifestPath: string;

function makeDeps(print?: (msg: string) => void): CliDeps {
  return {
    print: print ?? makeCapture().print,
    env,
    remote: { run: makeSuccessRunner(), tmpFactory: makeGuardrailTmpFactory(contentDir) },
  };
}

beforeEach(async () => {
  setStdoutIsTTY(false);

  tmp = {
    dir: await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-m18-')),
    cleanup: () => Promise.resolve(),
  };
  tmp.cleanup = () => fs.rm(tmp.dir, { recursive: true, force: true });
  contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-m18-content-'));
  env = { RIGGER_HOME: tmp.dir };
  manifestPath = path.join(tmp.dir, '.config', 'agent-rigger', 'state.json');

  // Config: catalogs only — deliberately NO assistants[] (the review scenario).
  const configDir = path.join(tmp.dir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });
  await Bun.write(
    path.join(configDir, 'config.json'),
    JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }] }),
  );

  // BOTH assistant dirs exist on disk → detection alone is ambiguous.
  await fs.mkdir(path.join(tmp.dir, '.claude'), { recursive: true });
  await fs.mkdir(path.join(tmp.dir, '.config', 'opencode'), { recursive: true });

  // Install the guardrail for opencode via the real install pipeline.
  const code = await runCli(
    ['install', QUALIFIED_ID, '--yes', '--assistant=opencode'],
    makeDeps(),
  );
  expect(code).toBe(0);
  const manifest = await readManifest(manifestPath);
  expect(findEntry(manifest, QUALIFIED_ID, 'user', 'opencode')).toBeDefined();
});

afterEach(async () => {
  setStdoutIsTTY(false);
  await tmp.cleanup();
  await fs.rm(contentDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// check — routes from manifest, audits the opencode entry without any prompt
// ---------------------------------------------------------------------------

describe('M18 — check without --assistant (non-TTY)', () => {
  it('routes to the opencode adapter from the manifest and audits the installed entry', async () => {
    const cap = makeCapture();
    const code = await runCli(['check'], makeDeps(cap.print));

    expect(code).toBe(0);
    // The installed guardrail is only audited when the assistant resolved to
    // opencode (installedGovernanceIds is keyed by assistant) — with the old
    // silent 'claude' fallback the report never mentions the entry. The audit
    // line 'guardrails-opencode' is emitted by the opencode adapter only.
    const output = cap.lines.join('\n');
    expect(output).toContain('guardrails-opencode');
    // Catalog status counts the installed opencode entry ([up-to-date], not
    // [available]) — proof the manifest-routed assistant reached the remote
    // sections too.
    expect(output).toContain('[up-to-date]');
  });
});

// ---------------------------------------------------------------------------
// <resource> check — same manifest routing on the sibling check surface
// ---------------------------------------------------------------------------

describe('M18 — guardrails check without --assistant (non-TTY)', () => {
  it('routes to the opencode adapter from the manifest instead of the silent claude fallback', async () => {
    const cap = makeCapture();
    const code = await runCli(['guardrails', 'check'], makeDeps(cap.print));

    const output = cap.lines.join('\n');
    // The audit line 'guardrails-opencode' is emitted by the opencode adapter
    // only — the old resolveCliAssistant path fell back to 'claude' and audited
    // with the wrong adapter (entry then reported missing, exit 3).
    expect(output).toContain('guardrails-opencode');
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// remove — routes from manifest, actually removes the opencode entry
// ---------------------------------------------------------------------------

describe('M18 — remove without --assistant (non-TTY)', () => {
  it('removes the opencode manifest entry instead of "Nothing to remove"', async () => {
    const cap = makeCapture();
    const code = await runCli(['remove', QUALIFIED_ID, '--yes'], makeDeps(cap.print));

    expect(code).toBe(0);
    const output = cap.lines.join('\n');
    expect(output).toContain('Removed 1');
    expect(output).not.toContain('Nothing to remove');

    const manifest = await readManifest(manifestPath);
    expect(findEntry(manifest, QUALIFIED_ID, 'user', 'opencode')).toBeUndefined();
  });

  it('--assistant=claude still wins as an explicit override (no manifest routing)', async () => {
    const cap = makeCapture();
    const code = await runCli(
      ['remove', QUALIFIED_ID, '--yes', '--assistant=claude'],
      makeDeps(cap.print),
    );

    // Updated for R5 (lot2-remove-reversible): the id is not installed for
    // claude (identity triple miss) → "not installed" error, exit 2 — the old
    // catalog-era "Nothing to remove" exit 0 is gone. The override still wins:
    // the removal targeted the claude adapter, not the manifest-routed opencode.
    expect(code).toBe(2);
    expect(cap.lines.join('\n').toLowerCase()).toContain('not installed');

    // The opencode entry is untouched by the claude-targeted removal.
    const manifest = await readManifest(manifestPath);
    expect(findEntry(manifest, QUALIFIED_ID, 'user', 'opencode')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// update — routes from manifest, classifies the opencode entry
// ---------------------------------------------------------------------------

describe('M18 — update without --assistant (non-TTY)', () => {
  it('classifies the opencode entry (up-to-date) instead of skipping the catalog', async () => {
    const cap = makeCapture();
    const code = await runCli(['update', '--yes'], makeDeps(cap.print));

    expect(code).toBe(0);
    const output = cap.lines.join('\n');
    // With the old 'claude' fallback the opencode entry is never a candidate
    // and the catalog loop produces no output at all.
    expect(output).toContain('[up-to-date]');
    expect(output).toContain(QUALIFIED_ID);
  });
});
