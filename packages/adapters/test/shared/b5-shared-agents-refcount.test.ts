/**
 * B5 — refcount AGENTS.md on opencode context removal
 * (docs/specs/fix-bugs-cli-b5-b10, D1).
 *
 * The claude adapter already skips a delete/restore whose path is still
 * referenced by another manifest entry's files (lot2-r6-context-restore.test.ts,
 * "AGENTS.md shared between assistants"). The opencode adapter dropped the same
 * gate at TWO layers: applyRemoveContext had no `manifestFiles` parameter, and
 * the `delete-file` handler registration (opencode/adapter.ts) swallowed the 3rd
 * argument the dispatcher passes. Removing an opencode context entry therefore
 * deleted a project-scope AGENTS.md still referenced by a live claude entry.
 *
 * op-kind parity (verified at the head of T1, D1 gate design): the opencode
 * remove planner (planRemoveContext) only ever emits `delete-file` (installed)
 * or `leave-alone` (drift) — never `restore-file`/`remove-block`. opencode has
 * no restore baseline (no `previous`) and no CLAUDE.md bridge (ADR-0007). The
 * refcount is wired on `delete-file` alone (YAGNI); no other kind to gate.
 *
 * Cross-adapter integration: a real temp HOME (RIGGER_HOME), both adapters, the
 * engine round-trip — never mocks. Mirrors the claude direction, reversed:
 * remove opencode → the shared file survives while the claude entry references
 * it; remove both → it disappears.
 *
 * Isolation: fresh RIGGER_HOME per test; both adapters resolve project-scope
 * AGENTS.md from process.cwd(), so chdir into a realpath'd tmp dir and restore
 * the cwd in finally.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply, check, remove } from '@agent-rigger/core/engine';
import { readText, writeText } from '@agent-rigger/core/fs-json';
import { findEntry, readManifest } from '@agent-rigger/core/manifest';
import { resolveProjectTargets, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { createClaudeAdapter } from '../../src/claude/adapter';
import { createOpencodeAdapter } from '../../src/opencode/adapter';
import { applyRemoveContext } from '../../src/opencode/context';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-b5-refcount-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

async function fileExists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Canonical managed AGENTS.md content, shared by both adapters. */
const CANONICAL = '# Managed AGENTS.md\n\nCanonical agent context shared by claude and opencode.\n';

const SHARED_ENTRY: AdapterEntry = {
  id: 'context-shared',
  nature: 'context',
  scope: 'project',
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// Handler level — the two-layer fix is observable directly on applyRemoveContext
// ---------------------------------------------------------------------------

describe('B5: applyRemoveContext refcount gate (handler level)', () => {
  it('B5: delete-file is skipped when another manifest entry references the path', async () => {
    const agentsMd = path.join(tmp.dir, 'AGENTS.md');
    await writeText(agentsMd, CANONICAL);

    await applyRemoveContext([{ kind: 'delete-file', path: agentsMd }], env, [agentsMd]);

    // Still referenced → the shared file is left in place.
    expect(await readText(agentsMd)).toBe(CANONICAL);
  });

  it('B5: delete-file deletes when no other entry references the path', async () => {
    const agentsMd = path.join(tmp.dir, 'AGENTS.md');
    await writeText(agentsMd, CANONICAL);

    await applyRemoveContext([{ kind: 'delete-file', path: agentsMd }], env, []);

    // Unreferenced → removed (the non-shared path still works as before).
    expect(await fileExists(agentsMd)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Engine round-trip — the cross-adapter scenario (the dense one of the lot)
// ---------------------------------------------------------------------------

describe('B5: AGENTS.md shared between opencode and claude (project scope)', () => {
  it('B5: shared AGENTS.md survives opencode removal while claude entry remains', async () => {
    const projectDir = await fs.realpath(tmp.dir);
    const originalCwd = process.cwd();
    const stateJson = resolveUserTargets(env).stateJson;

    try {
      process.chdir(projectDir);
      const projectTargets = resolveProjectTargets(projectDir);

      const opencode = createOpencodeAdapter({ agentsContent: CANONICAL });
      const claude = createClaudeAdapter({ denyRef: [], agentsContent: CANONICAL });

      // opencode first (writes AGENTS.md), then claude (adds the CLAUDE.md import
      // block over already-matching content — still a non-empty plan).
      await apply(opencode, [SHARED_ENTRY], 'project', env, stateJson);
      await apply(claude, [SHARED_ENTRY], 'project', env, stateJson);

      // Both manifest entries reference the same <cwd>/AGENTS.md.
      const manifest = await readManifest(stateJson);
      expect(findEntry(manifest, 'context-shared', 'project', 'opencode')?.files)
        .toContain(projectTargets.agentsMd);
      expect(findEntry(manifest, 'context-shared', 'project', 'claude')?.files)
        .toContain(projectTargets.agentsMd);

      // Remove the opencode entry — its only op is delete-file; the gate must
      // skip it because the claude entry still references the shared file.
      await remove(opencode, [SHARED_ENTRY], 'project', env, stateJson);

      // The shared AGENTS.md survives for claude, byte for byte.
      expect(await readText(projectTargets.agentsMd)).toBe(CANONICAL);

      // opencode entry dropped, claude entry intact and still auditing present.
      const after = await readManifest(stateJson);
      expect(findEntry(after, 'context-shared', 'project', 'opencode')).toBeUndefined();
      expect(findEntry(after, 'context-shared', 'project', 'claude')).toBeDefined();
      const report = await check(claude, [SHARED_ENTRY], 'project', env, stateJson);
      expect(report.entries[0]!.state).toBe('present');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('B5 non-regression: removing both entries deletes the shared AGENTS.md', async () => {
    const projectDir = await fs.realpath(tmp.dir);
    const originalCwd = process.cwd();
    const stateJson = resolveUserTargets(env).stateJson;

    try {
      process.chdir(projectDir);
      const projectTargets = resolveProjectTargets(projectDir);

      const opencode = createOpencodeAdapter({ agentsContent: CANONICAL });
      const claude = createClaudeAdapter({ denyRef: [], agentsContent: CANONICAL });

      await apply(opencode, [SHARED_ENTRY], 'project', env, stateJson);
      await apply(claude, [SHARED_ENTRY], 'project', env, stateJson);

      // Remove opencode: the shared file is protected by the claude reference.
      await remove(opencode, [SHARED_ENTRY], 'project', env, stateJson);
      expect(await readText(projectTargets.agentsMd)).toBe(CANONICAL);

      // Remove claude: nothing references the file any more → it is deleted.
      await remove(claude, [SHARED_ENTRY], 'project', env, stateJson);
      expect(await fileExists(projectTargets.agentsMd)).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
