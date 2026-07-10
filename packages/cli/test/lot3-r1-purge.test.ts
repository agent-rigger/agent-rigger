/**
 * Tests for lot3-robustesse-moteur R1 at the CLI seam (runRemove + runCheck):
 * a hook whose registration the user removed or edited by hand is PURGED from
 * the manifest — listed in the recap, no confirmation prompt (no disk
 * mutation), and `check` converges to exit 0 afterwards (design D1).
 *
 * Before Lot 3, remove said "Nothing to remove — not installed" and left the
 * phantom manifest entry forever (M1a); check kept flagging it (exit 3).
 *
 * Isolation: fresh RIGGER_HOME tmp dir per test — never touches the real ~/.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply } from '@agent-rigger/core/engine';
import { readJson, writeJson } from '@agent-rigger/core/fs-json';
import { readManifest } from '@agent-rigger/core/manifest';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { createClaudeAdapter } from '@agent-rigger/adapters';
import type { ResolvedHook } from '@agent-rigger/adapters';

import { runCheck } from '../src/cmd-check';
import { runRemove } from '../src/cmd-remove';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-lot3-r1-cli-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

const HOOK_SPEC: ResolvedHook = {
  event: 'PreToolUse',
  matcher: 'Bash',
  command: '/usr/local/bin/rigger-hook.sh',
};

const HOOK_ENTRY: AdapterEntry = { id: 'hook:guard', nature: 'hook', scope: 'user' };

/** Confirm callback that fails the test if invoked. */
const rejectConfirm = async (): Promise<boolean> => {
  throw new Error('confirm must not be called for a pure purge (no disk mutation)');
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let targets: ReturnType<typeof resolveUserTargets>;
let manifestPath: string;

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
  targets = resolveUserTargets(env);
  manifestPath = targets.stateJson;
});

afterEach(async () => {
  await tmp.cleanup();
});

function makeHookAdapter() {
  return createClaudeAdapter({ denyRef: [], hookSpec: () => HOOK_SPEC });
}

// ---------------------------------------------------------------------------
// Hook removed by hand → purged, listed, no confirm, check exit 0
// ---------------------------------------------------------------------------

describe('runRemove — lot3 R1 purge of a hand-removed hook', () => {
  it('lot3-R1: a hook removed from settings.json is purged, listed, without confirmation; check exits 0', async () => {
    const adapter = makeHookAdapter();
    await apply(adapter, [HOOK_ENTRY], 'user', env, manifestPath);

    // The user deletes the hook from settings.json by hand.
    const settings = await readJson(targets.claudeSettings);
    await writeJson(targets.claudeSettings, { ...settings, hooks: {} });

    const result = await runRemove({
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['hook:guard'],
      confirm: rejectConfirm, // proves no prompt is raised for a pure purge
    });

    // The phantom entry is purged and surfaced in the recap.
    expect(result.output.toLowerCase()).toContain('purged');
    const manifest = await readManifest(manifestPath);
    expect(manifest.artifacts.find((a) => a.id === 'hook:guard')).toBeUndefined();

    // check over the installed set (now clean) converges to exit 0.
    const entries: AdapterEntry[] = manifest.artifacts.map((a) => ({
      id: a.id,
      nature: a.nature,
      scope: a.scope,
    }));
    const checkResult = await runCheck({ adapter, entries, scope: 'user', env, manifestPath });
    expect(checkResult.exitCode).toBe(0);
  });

  it('lot3-R1: a hook edited by hand is purged with the edited-or-removed warning', async () => {
    const adapter = makeHookAdapter();
    await apply(adapter, [HOOK_ENTRY], 'user', env, manifestPath);

    // The user edits the hook command in settings.json — the canonical spec no
    // longer matches anything (hasHook is command-strict), yet a mutant hook
    // keeps executing. Ratified: purge + warning.
    await writeJson(targets.claudeSettings, {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/MY-EDITED.sh' }] },
        ],
      },
    });

    const result = await runRemove({
      adapter,
      scope: 'user',
      env,
      manifestPath,
      selectedIds: ['hook:guard'],
      confirm: rejectConfirm,
    });

    expect(result.output).toContain(
      'managed hook no longer present (edited or removed) — the current hook in settings.json is yours now',
    );

    const manifest = await readManifest(manifestPath);
    expect(manifest.artifacts.find((a) => a.id === 'hook:guard')).toBeUndefined();
  });
});
