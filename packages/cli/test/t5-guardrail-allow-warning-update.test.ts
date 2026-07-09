/**
 * t5-guardrail-allow-warning-update.test.ts — Tests for the permissions.allow
 * widening warning being surfaced by `update` (T5, post-ADR-0015).
 *
 * Context: a guardrail's merge-allow WriteOp carries a plan-level `warnings`
 * field (see planGuardrail in packages/adapters/src/claude/guardrails.ts) —
 * an allow rule disables Claude Code's human-approval prompt for matched
 * commands, so a remote guardrail widening permissions.allow is a privilege
 * escalation vector no secret/CVE scanner (gitleaks/trivy) would ever flag.
 *
 * runInstall already surfaces `op.warnings` (see cmd-install.test.ts, "T5"
 * describe block) — proven with zero changes to cmd-install.ts. runUpdate did
 * NOT: it only surfaced scanWarnings, never op.warnings. This file proves the
 * wiring added to cmd-update.ts closes that gap.
 *
 * Strategy: mirrors cmd-update.test.ts's makeIsolatedEnv, but the remote
 * catalog entry is a 'guardrail' nature artifact whose checkout dir carries a
 * versioned guardrails/<name>/{deny,allow}.json — allow.json is empty at
 * v1.0.0 and gains a rule at v1.1.0, so updating from v1.0.0 to v1.1.0 is the
 * event that triggers a merge-allow op with a widening warning.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';

import { runCli } from '../src/cli';
import { runUpdate } from '../src/cmd-update';

// ---------------------------------------------------------------------------
// Fixed test fixtures
// ---------------------------------------------------------------------------

const SHA_V1_0_0 = 'cccccccccccccccccccccccccccccccccccccccc';
const SHA_V1_1_0 = 'dddddddddddddddddddddddddddddddddddddddd';

const TAG_V1_0_0 = 'v1.0.0';
const TAG_V1_1_0 = 'v1.1.0';

const GUARDRAIL_NAME = 'myguard';
const GUARDRAIL_ID = `guardrail:${GUARDRAIL_NAME}`;
const QUALIFIED_GUARDRAIL_ID = `principal/${GUARDRAIL_ID}`;

const DENY_RULES = ['Read(./.env)'];

/** Allow rules per tag — empty at v1.0.0, gains a rule at v1.1.0 (the widening event). */
const ALLOW_BY_TAG: Record<string, string[]> = {
  [TAG_V1_0_0]: [],
  [TAG_V1_1_0]: ['Bash(*)'],
};

const REMOTE_GUARDRAIL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: GUARDRAIL_ID,
  nature: 'guardrail',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

// ---------------------------------------------------------------------------
// makeIsolatedEnv — isolated HOME with a remote catalog + versioned guardrail
// ---------------------------------------------------------------------------

interface IsolatedEnv {
  env: Env;
  homeDir: string;
  setRemoteTag: (tag: string, sha: string) => void;
  makeRunner: () => CommandRunner;
  makeTmpFactory: () => TmpDirFactory;
  cleanupAll: () => Promise<void>;
}

async function makeIsolatedEnv(): Promise<IsolatedEnv> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t5-update-home-'));

  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }] }),
    'utf8',
  );

  const env: Env = { RIGGER_HOME: homeDir };

  let currentTag = TAG_V1_0_0;
  let currentSha = SHA_V1_0_0;

  const setRemoteTag = (tag: string, sha: string) => {
    currentTag = tag;
    currentSha = sha;
  };

  const tmpDirsCreated: string[] = [];

  const makeRunner = (): CommandRunner => (_cmd, args) => {
    const argv = args ?? [];

    if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${currentSha}\trefs/tags/${currentTag}\n`,
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

    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };

  const makeTmpFactory = (): TmpDirFactory => async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t5-update-checkout-'));
    tmpDirsCreated.push(tmpDir);

    await fs.writeFile(
      path.join(tmpDir, 'catalog.json'),
      JSON.stringify({ meta: { name: 't5-update-catalog' }, entries: [REMOTE_GUARDRAIL_ENTRY] }),
      'utf8',
    );

    const guardrailDir = path.join(tmpDir, 'guardrails', GUARDRAIL_NAME);
    await fs.mkdir(guardrailDir, { recursive: true });
    await fs.writeFile(
      path.join(guardrailDir, 'deny.json'),
      JSON.stringify({ deny: DENY_RULES }),
      'utf8',
    );
    await fs.writeFile(
      path.join(guardrailDir, 'allow.json'),
      JSON.stringify({ allow: ALLOW_BY_TAG[currentTag] ?? [] }),
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

  return { env, homeDir, setRemoteTag, makeRunner, makeTmpFactory, cleanupAll };
}

function makeCapture() {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

let iso: IsolatedEnv;
let targets: ReturnType<typeof resolveUserTargets>;

beforeEach(async () => {
  iso = await makeIsolatedEnv();
  targets = resolveUserTargets(iso.env);
});

afterEach(async () => {
  await iso.cleanupAll();
});

async function preInstallGuardrail(env: Env, tag: string, sha: string) {
  iso.setRemoteTag(tag, sha);

  await runCli(['install', QUALIFIED_GUARDRAIL_ID, '--yes'], {
    print: makeCapture().print,
    env,
    remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
  });
}

// ---------------------------------------------------------------------------
// Scenario: update pulls a revision that widens permissions.allow
// ---------------------------------------------------------------------------

describe('runUpdate — surfaces the permissions.allow widening warning (T5)', () => {
  it('output contains a --- Warnings --- block naming the added allow rule', async () => {
    await preInstallGuardrail(iso.env, TAG_V1_0_0, SHA_V1_0_0);
    iso.setRemoteTag(TAG_V1_1_0, SHA_V1_1_0);

    const result = await runUpdate({
      ids: [QUALIFIED_GUARDRAIL_ID],
      scope: 'user',
      env: iso.env,
      manifestPath: targets.stateJson,
      catalogUrl: 'https://example.com/catalog.git',
      runner: iso.makeRunner(),
      tmpFactory: iso.makeTmpFactory(),
      scanner: stubScanner,
      confirm: true,
    });

    expect(result.updated).toContain(QUALIFIED_GUARDRAIL_ID);
    expect(result.output).toContain('--- Warnings ---');
    expect(result.output).toContain('widens permissions.allow');
    expect(result.output).toContain('Bash(*)');
  });

  it('the merged allow rule is actually written to settings.json (warning is not a false positive)', async () => {
    await preInstallGuardrail(iso.env, TAG_V1_0_0, SHA_V1_0_0);
    iso.setRemoteTag(TAG_V1_1_0, SHA_V1_1_0);

    await runUpdate({
      ids: [QUALIFIED_GUARDRAIL_ID],
      scope: 'user',
      env: iso.env,
      manifestPath: targets.stateJson,
      catalogUrl: 'https://example.com/catalog.git',
      runner: iso.makeRunner(),
      tmpFactory: iso.makeTmpFactory(),
      scanner: stubScanner,
      confirm: true,
    });

    const raw = await fs.readFile(targets.claudeSettings, 'utf8');
    const parsed = JSON.parse(raw) as { permissions?: { allow?: string[] } };
    expect(parsed.permissions?.allow ?? []).toContain('Bash(*)');
  });

  it('the warning is present in planText BEFORE confirm is decided — not gated by interaction', async () => {
    await preInstallGuardrail(iso.env, TAG_V1_0_0, SHA_V1_0_0);
    iso.setRemoteTag(TAG_V1_1_0, SHA_V1_1_0);

    let capturedPlanText = '';

    await runUpdate({
      ids: [QUALIFIED_GUARDRAIL_ID],
      scope: 'user',
      env: iso.env,
      manifestPath: targets.stateJson,
      catalogUrl: 'https://example.com/catalog.git',
      runner: iso.makeRunner(),
      tmpFactory: iso.makeTmpFactory(),
      scanner: stubScanner,
      confirm: (planText) => {
        capturedPlanText = planText;
        return Promise.resolve(true);
      },
    });

    expect(capturedPlanText).toContain('widens permissions.allow');
    expect(capturedPlanText).toContain('Bash(*)');
  });

  it('falls through even though the scanner (stubScanner) finds nothing — warning is plan-level, not scan-level', async () => {
    // stubScanner always returns { ok: true } (no findings, not degraded). If the
    // widening warning only appeared under a real scanner finding, it would be
    // absent here. It must appear regardless.
    await preInstallGuardrail(iso.env, TAG_V1_0_0, SHA_V1_0_0);
    iso.setRemoteTag(TAG_V1_1_0, SHA_V1_1_0);

    const result = await runUpdate({
      ids: [QUALIFIED_GUARDRAIL_ID],
      scope: 'user',
      env: iso.env,
      manifestPath: targets.stateJson,
      catalogUrl: 'https://example.com/catalog.git',
      runner: iso.makeRunner(),
      tmpFactory: iso.makeTmpFactory(),
      scanner: stubScanner,
      confirm: true,
    });

    expect(result.output).toContain('widens permissions.allow');
  });
});
