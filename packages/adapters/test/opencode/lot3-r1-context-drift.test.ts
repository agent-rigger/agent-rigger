/**
 * lot3-robustesse-moteur R1 — real-adapter drift→conservation for the opencode
 * context nature (design D1, leave-alone contract).
 *
 * The core lot3-r1-purge.test.ts proves the ENGINE conserves a manifest entry
 * WHEN it is handed a leave-alone op (via an inline adapter). It does NOT prove
 * that each real nature EMITS a leave-alone on drift. This test closes that gap
 * end-to-end for opencode context: install → drift AGENTS.md → remove() → assert
 * the manifest entry SURVIVES (never purged, `check` keeps reporting the drift).
 *
 * Before the fix, planRemoveContext returned [] on drift → the engine's R1 purge
 * branch dropped the entry and left the drifted file untracked and invisible to
 * `check` — the exact regression of the R3/Lot 2 leave-alone contract.
 *
 * Isolation: fresh RIGGER_HOME per test via makeTmpHome().
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply, check, remove, reportExitCode } from '@agent-rigger/core/engine';
import { readText, writeText } from '@agent-rigger/core/fs-json';
import { findEntry, readManifest } from '@agent-rigger/core/manifest';
import { resolveOpencodeUserTargets, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { createOpencodeAdapter } from '../../src/opencode/adapter';

const AGENTS_CONTENT = '# Agent Context\n\nThis is the canonical AGENTS.md content.\n';

async function makeTmpHome(prefix = 'rigger-lot3-r1-opencode-context-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

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

const CONTEXT_ENTRY: AdapterEntry = {
  id: 'context-opencode',
  nature: 'context',
  scope: 'user',
};

describe('opencode context — lot3 R1 real-adapter drift conservation', () => {
  it('lot3-R1: remove() conserves the manifest entry when AGENTS.md has drifted', async () => {
    const adapter = createOpencodeAdapter({ agentsContent: AGENTS_CONTENT });
    const targets = resolveOpencodeUserTargets(env);

    // Install the opencode context (AGENTS.md = canonical, entry recorded).
    await apply({ adapter, entries: [CONTEXT_ENTRY], scope: 'user', env, manifestPath });
    expect(findEntry(await readManifest(manifestPath), 'context-opencode', 'user', 'opencode'))
      .toBeDefined();

    // The user enriches AGENTS.md with their own notes → drift.
    const drifted = `${AGENTS_CONTENT}\n## My own notes\nkeep me\n`;
    await writeText(targets.agentsMd, drifted);

    const result = await remove(adapter, [CONTEXT_ENTRY], 'user', env, manifestPath);

    // Conservation: nothing purged, nothing removed, entry SURVIVES.
    expect(result.purged).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    const entry = findEntry(
      await readManifest(manifestPath),
      'context-opencode',
      'user',
      'opencode',
    );
    expect(entry).toBeDefined();

    // The drifted file is left untouched on disk.
    expect(await readText(targets.agentsMd)).toBe(drifted);

    // `check` still reports the drift (exit non-zero), not exit 0 as it would if
    // the entry had been purged and the file forgotten.
    const report = await check(adapter, [CONTEXT_ENTRY], 'user', env);
    expect(reportExitCode(report)).not.toBe(0);
    expect(report.entries[0]!.state).toBe('drift');
  });
});
