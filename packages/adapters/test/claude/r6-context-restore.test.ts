/**
 * R6 — the project context returns to its pre-install state on remove
 * (docs/specs/lot2-remove-reversible/requirements.md, R6 / design D5).
 *
 * The claude adapter restores on remove the AGENTS.md content that predated the
 * install (captured as `AppliedContext.previous` in the manifest) and never
 * deletes an AGENTS.md that drifted from the content rigger wrote (M5 fix).
 *
 * Op choice (D5, "restore-file or equivalent — dev's choice, documented"):
 * restoration is a dedicated `restore-file` RemovalOp carrying `path` +
 * `content`, so the engine's any-op-with-path backup (R8/T1) covers the
 * rewrite with a .bak before the pre-install bytes are written back.
 *
 * Coverage mirrors the opencode context suite (context.test.ts +
 * e2e-context.test.ts) on the claude side: handler-level unit tests plus
 * engine round-trips against a real temp HOME (RIGGER_HOME), never mocks.
 *
 * Isolation: fresh RIGGER_HOME per test; project-scope engine tests chdir into
 * a realpath'd tmp dir (the claude adapter resolves project paths from
 * process.cwd()) and restore the original cwd in finally.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply, check, remove, reportExitCode } from '@agent-rigger/core/engine';
import { readText, writeText } from '@agent-rigger/core/fs-json';
import { findEntry, readManifest } from '@agent-rigger/core/manifest';
import { resolveProjectTargets, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { RemovalOpRestoreFile, WriteOpWriteText } from '@agent-rigger/core/types';

import { createClaudeAdapter } from '../../src/claude/adapter';
import {
  applyRemoveContext,
  auditContext,
  planContext,
  planRemoveContext,
} from '../../src/claude/context';
import { createOpencodeAdapter } from '../../src/opencode/adapter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-r6-context-'): Promise<{
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

/** Write a CLAUDE.md that already carries the managed user-scope import block. */
function managedBlock(target: string): string {
  return `<!-- BEGIN agent-rigger (managed — do not edit) -->\n@${target}\n<!-- END agent-rigger -->\n`;
}

/**
 * Rewrite state.json raw so context payloads lose their `previous` field —
 * the exact shape a pre-lot2 manifest has on disk (f2-manifest-retrocompat
 * pattern: operate on the raw JSON an old binary would have serialized).
 */
async function stripPrevious(manifestPath: string): Promise<void> {
  const raw = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as {
    artifacts: Array<{ applied?: { previous?: unknown } }>;
  };
  for (const entry of raw.artifacts) {
    if (entry.applied !== undefined) delete entry.applied.previous;
  }
  await fs.writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
}

/**
 * Rewrite state.json raw so entries lose their WHOLE `applied` field — the
 * exact shape a pre-B-iii manifest has on disk (older than the `previous`
 * capture: no payload at all).
 */
async function stripApplied(manifestPath: string): Promise<void> {
  const raw = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as {
    artifacts: Array<{ applied?: unknown }>;
  };
  for (const entry of raw.artifacts) {
    delete entry.applied;
  }
  await fs.writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
}

/** Set the claude context entry's applied.previous in state.json raw. */
async function setClaudePrevious(manifestPath: string, value: string | null): Promise<void> {
  const raw = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as {
    artifacts: Array<{ assistant?: string; applied?: { kind?: string; previous?: unknown } }>;
  };
  for (const entry of raw.artifacts) {
    if (entry.assistant === 'claude' && entry.applied?.kind === 'context') {
      entry.applied.previous = value;
    }
  }
  await fs.writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Canonical managed AGENTS.md content. */
const CANONICAL = '# Managed AGENTS.md\n\nCanonical claude agent context.\n';

/** Content the user authored BEFORE rigger ever installed — must survive a cycle. */
const USER_CONTENT = '# My project\n\nHand-written context the user owns.\nDo not lose.\n';

const CONTEXT_ENTRY: AdapterEntry = {
  id: 'context-claude',
  nature: 'context',
  scope: 'user',
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let targets: ReturnType<typeof resolveUserTargets>;

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
  targets = resolveUserTargets(env);
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// R6 scenario 1 — install→remove cycle over a pre-existing AGENTS.md
// ---------------------------------------------------------------------------

describe('R6: cycle over a pre-existing AGENTS.md', () => {
  it('R6: the install plan captures the pre-install content and signals the overwrite', async () => {
    await writeText(targets.agentsMd, USER_CONTENT);

    const ops = await planContext('user', env, CANONICAL);

    const writeOp = ops.find((op) => op.kind === 'write-text') as WriteOpWriteText | undefined;
    expect(writeOp).toBeDefined();
    // The restore baseline rides on the op so extractApplied can persist it.
    expect(writeOp!.previous).toBe(USER_CONTENT);
    // The plan signals the overwrite of existing content before confirm.
    expect(writeOp!.warnings).toBeDefined();
    expect(writeOp!.warnings!.join(' ')).toContain(targets.agentsMd);
  });

  it('R6: install records previous in the manifest; remove restores it byte-for-byte and drops the CLAUDE.md block', async () => {
    await writeText(targets.agentsMd, USER_CONTENT);
    const adapter = createClaudeAdapter({ denyRef: [], agentsContent: CANONICAL });

    // --- install ------------------------------------------------------------
    await apply(adapter, [CONTEXT_ENTRY], 'user', env, targets.stateJson);
    expect(await readText(targets.agentsMd)).toBe(CANONICAL);

    const manifest = await readManifest(targets.stateJson);
    const entry = findEntry(manifest, 'context-claude', 'user', 'claude');
    expect(entry?.applied).toEqual({
      kind: 'context',
      block: CANONICAL,
      previous: USER_CONTENT,
    });

    // --- remove -------------------------------------------------------------
    const result = await remove(adapter, [CONTEXT_ENTRY], 'user', env, targets.stateJson);
    expect(result.removed).toContain('context-claude');

    // The user's pre-install content is back, byte for byte.
    expect(await readText(targets.agentsMd)).toBe(USER_CONTENT);

    // The managed import block is gone from CLAUDE.md.
    const claudeMd = await readText(targets.claudeMd);
    expect(claudeMd).not.toContain('<!-- BEGIN agent-rigger (managed — do not edit) -->');

    // The restore rewrite was backed up first (restore-file carries `path`,
    // so the R8 any-op-with-path backup covers it).
    expect(result.backedUp.some((p) => p.startsWith(`${targets.agentsMd}.bak-`))).toBe(true);

    // Manifest entry dropped.
    const after = await readManifest(targets.stateJson);
    expect(findEntry(after, 'context-claude', 'user', 'claude')).toBeUndefined();
  });

  it('R6: planRemoveContext emits restore-file with the previous content on exact match', async () => {
    await writeText(targets.agentsMd, CANONICAL);
    await writeText(targets.claudeMd, managedBlock('~/.claude/harness/AGENTS.md'));

    const ops = await planRemoveContext('user', env, CANONICAL, undefined, USER_CONTENT);

    const restoreOp = ops.find((op) => op.kind === 'restore-file') as
      | RemovalOpRestoreFile
      | undefined;
    expect(restoreOp).toBeDefined();
    expect(restoreOp!.path).toBe(targets.agentsMd);
    expect(restoreOp!.content).toBe(USER_CONTENT);
    // No delete op — the file is restored, not removed.
    expect(ops.some((op) => op.kind === 'delete-file')).toBe(false);
    expect(ops.some((op) => op.kind === 'remove-block')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R6 scenario 2 — AGENTS.md absent before install
// ---------------------------------------------------------------------------

describe('R6: AGENTS.md absent before install', () => {
  it('R6: install records previous=null; remove deletes the file (prior state was absence)', async () => {
    const adapter = createClaudeAdapter({ denyRef: [], agentsContent: CANONICAL });

    await apply(adapter, [CONTEXT_ENTRY], 'user', env, targets.stateJson);

    const manifest = await readManifest(targets.stateJson);
    const entry = findEntry(manifest, 'context-claude', 'user', 'claude');
    expect(entry?.applied).toEqual({ kind: 'context', block: CANONICAL, previous: null });

    await remove(adapter, [CONTEXT_ENTRY], 'user', env, targets.stateJson);

    expect(await fileExists(targets.agentsMd)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R6 scenario 3 — remove over a drifted AGENTS.md
// ---------------------------------------------------------------------------

describe('R6: remove over a drifted AGENTS.md', () => {
  const DRIFTED = `${CANONICAL}\n## User additions\n\nKeep this.\n`;

  it('R6: the plan leaves the drifted file alone (warning-only op) and still removes the block', async () => {
    await writeText(targets.agentsMd, DRIFTED);
    await writeText(targets.claudeMd, managedBlock('~/.claude/harness/AGENTS.md'));

    const ops = await planRemoveContext('user', env, CANONICAL, undefined, USER_CONTENT);

    // No destructive op targets AGENTS.md.
    expect(ops.some((op) => op.kind === 'delete-file')).toBe(false);
    expect(ops.some((op) => op.kind === 'restore-file')).toBe(false);
    // The warning-only leave-alone op names the file and carries the notice.
    const leaveOp = ops.find((op) => op.kind === 'leave-alone') as
      | { kind: 'leave-alone'; target: string; warnings: string[] }
      | undefined;
    expect(leaveOp).toBeDefined();
    expect(leaveOp!.target).toBe(targets.agentsMd);
    expect(leaveOp!.warnings.join(' ')).toContain('left in place');
    // The CLAUDE.md block is removed in all cases (decoupled).
    expect(ops.some((op) => op.kind === 'remove-block')).toBe(true);
  });

  it('R6: remove leaves the drifted bytes untouched, removes the block, drops the entry', async () => {
    await writeText(targets.agentsMd, USER_CONTENT);
    const adapter = createClaudeAdapter({ denyRef: [], agentsContent: CANONICAL });
    await apply(adapter, [CONTEXT_ENTRY], 'user', env, targets.stateJson);

    // The user enriches the managed file after install.
    await writeText(targets.agentsMd, DRIFTED);

    const result = await remove(adapter, [CONTEXT_ENTRY], 'user', env, targets.stateJson);

    // git-visible state of AGENTS.md is unchanged: exact drifted bytes remain.
    expect(await readText(targets.agentsMd)).toBe(DRIFTED);
    // The block is gone and the entry is dropped (the remove itself succeeded).
    expect(await readText(targets.claudeMd)).not.toContain(
      '<!-- BEGIN agent-rigger (managed — do not edit) -->',
    );
    expect(result.removed).toContain('context-claude');
    const after = await readManifest(targets.stateJson);
    expect(findEntry(after, 'context-claude', 'user', 'claude')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// R6 scenario 5 — re-install after drift: the restore baseline never moves
// ---------------------------------------------------------------------------

describe('R6: re-install after drift keeps the first install baseline (R1 interaction)', () => {
  it('R6: previous survives the upsert; remove restores the original content, not the drifted one', async () => {
    const DRIFTED = `${CANONICAL}\nuser drift\n`;
    await writeText(targets.agentsMd, USER_CONTENT);
    const adapter = createClaudeAdapter({ denyRef: [], agentsContent: CANONICAL });

    // Install #1 over the user's file, then user drift, then repair install.
    await apply(adapter, [CONTEXT_ENTRY], 'user', env, targets.stateJson);
    await writeText(targets.agentsMd, DRIFTED);
    await apply(adapter, [CONTEXT_ENTRY], 'user', env, targets.stateJson);

    // The repair overwrote the drift with canonical content…
    expect(await readText(targets.agentsMd)).toBe(CANONICAL);
    // …but the manifest baseline is still the FIRST install's previous.
    const manifest = await readManifest(targets.stateJson);
    const entry = findEntry(manifest, 'context-claude', 'user', 'claude');
    expect(entry?.applied).toEqual({
      kind: 'context',
      block: CANONICAL,
      previous: USER_CONTENT,
    });

    // Remove restores the pre-FIRST-install content, not an intermediate state.
    await remove(adapter, [CONTEXT_ENTRY], 'user', env, targets.stateJson);
    expect(await readText(targets.agentsMd)).toBe(USER_CONTENT);
  });
});

// ---------------------------------------------------------------------------
// R6 scenario 6 — AGENTS.md shared between assistants (project scope)
// ---------------------------------------------------------------------------

describe('R6: AGENTS.md shared between assistants', () => {
  it('R6: removing the claude context keeps the shared file while opencode references it; only the block goes', async () => {
    // Project scope: claude and opencode both target <cwd>/AGENTS.md. The
    // claude adapter resolves project paths from process.cwd(), so chdir into
    // a realpath'd tmp dir (T7 pattern) and restore the cwd in finally.
    const projectDir = await fs.realpath(tmp.dir);
    const originalCwd = process.cwd();
    const entry: AdapterEntry = { id: 'context-shared', nature: 'context', scope: 'project' };

    try {
      process.chdir(projectDir);
      const projectTargets = resolveProjectTargets(projectDir);

      const opencode = createOpencodeAdapter({ agentsContent: CANONICAL });
      const claude = createClaudeAdapter({ denyRef: [], agentsContent: CANONICAL });

      // opencode first (a second install over matching content would plan
      // nothing), then claude (non-empty plan: the CLAUDE.md block is missing).
      await apply(opencode, [entry], 'project', env, targets.stateJson);
      await apply(claude, [entry], 'project', env, targets.stateJson);

      // Both manifest entries reference the same <cwd>/AGENTS.md.
      const manifest = await readManifest(targets.stateJson);
      expect(findEntry(manifest, 'context-shared', 'project', 'opencode')?.files)
        .toContain(projectTargets.agentsMd);
      expect(findEntry(manifest, 'context-shared', 'project', 'claude')?.files)
        .toContain(projectTargets.agentsMd);

      // Make the gate observable: force the claude baseline to null so an
      // ungated remove would DELETE the shared file (raw-JSON surgery).
      await setClaudePrevious(targets.stateJson, null);

      await remove(claude, [entry], 'project', env, targets.stateJson);

      // The shared AGENTS.md survives for opencode, byte for byte.
      expect(await readText(projectTargets.agentsMd)).toBe(CANONICAL);
      // The claude-specific CLAUDE.md block is gone.
      expect(await readText(projectTargets.claudeMd)).not.toContain(
        '<!-- BEGIN agent-rigger (managed — do not edit) -->',
      );
      // claude entry dropped, opencode entry intact and still auditing present.
      const after = await readManifest(targets.stateJson);
      expect(findEntry(after, 'context-shared', 'project', 'claude')).toBeUndefined();
      expect(findEntry(after, 'context-shared', 'project', 'opencode')).toBeDefined();
      const report = await check(opencode, [entry], 'project', env, targets.stateJson);
      expect(report.entries[0]!.state).toBe('present');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('R6: delete-file is skipped when another manifest entry references the path (handler level)', async () => {
    await writeText(targets.agentsMd, CANONICAL);

    await applyRemoveContext(
      [{ kind: 'delete-file', path: targets.agentsMd }],
      env,
      [targets.agentsMd],
    );

    expect(await readText(targets.agentsMd)).toBe(CANONICAL);
  });

  it('R6: restore-file is skipped when another manifest entry references the path (handler level)', async () => {
    await writeText(targets.agentsMd, CANONICAL);

    await applyRemoveContext(
      [{ kind: 'restore-file', path: targets.agentsMd, content: USER_CONTENT }],
      env,
      [targets.agentsMd],
    );

    expect(await readText(targets.agentsMd)).toBe(CANONICAL);
  });
});

// ---------------------------------------------------------------------------
// R6 scenario 7 — retro-compat: legacy entry without `previous`
// ---------------------------------------------------------------------------

describe('R6: retro-compat — legacy entry without previous', () => {
  it('R6: the plan warns "no restore baseline" and deletes on exact match only', async () => {
    await writeText(targets.agentsMd, CANONICAL);
    await writeText(targets.claudeMd, managedBlock('~/.claude/harness/AGENTS.md'));
    const adapter = createClaudeAdapter({ denyRef: [] });
    const legacyEntry: AdapterEntry = {
      ...CONTEXT_ENTRY,
      applied: { kind: 'context', block: CANONICAL },
    };

    const ops = await adapter.planRemove(legacyEntry, 'user', env);

    const deleteOp = ops.find((op) => op.kind === 'delete-file') as
      | { kind: 'delete-file'; path: string; warnings?: string[] }
      | undefined;
    expect(deleteOp).toBeDefined();
    expect(deleteOp!.warnings).toBeDefined();
    expect(deleteOp!.warnings!.join(' ')).toContain('restore baseline');
    expect(ops.some((op) => op.kind === 'restore-file')).toBe(false);
  });

  it('R6: engine remove of a legacy entry deletes the exactly-matching file (degraded but safe)', async () => {
    await writeText(targets.agentsMd, USER_CONTENT);
    const adapter = createClaudeAdapter({ denyRef: [], agentsContent: CANONICAL });
    await apply(adapter, [CONTEXT_ENTRY], 'user', env, targets.stateJson);
    await stripPrevious(targets.stateJson);

    await remove(adapter, [CONTEXT_ENTRY], 'user', env, targets.stateJson);

    // Degraded mode: no baseline to restore — the managed file is deleted.
    expect(await fileExists(targets.agentsMd)).toBe(false);
  });

  it('R6: a pre-B-iii entry (no applied at all) never adopts the repair capture as restore baseline', async () => {
    // Legacy manifest older than B-iii: the entry exists WITHOUT any `applied`
    // payload. A repair install (user deleted the CLAUDE.md block; AGENTS.md
    // still canonical) plans a write-text whose plan-time `previous` capture
    // reads the POST-install disk — the canonical block itself. Adopting it as
    // baseline would make remove "restore" the managed content and exit 0
    // while dropping the entry: orphaned managed content the tool can no
    // longer uninstall (the exact class R6/ADR-0016 forbids).
    const adapter = createClaudeAdapter({ denyRef: [], agentsContent: CANONICAL });
    await apply(adapter, [CONTEXT_ENTRY], 'user', env, targets.stateJson);
    await stripApplied(targets.stateJson);

    // User deletes the CLAUDE.md managed block; AGENTS.md stays canonical.
    await writeText(targets.claudeMd, '# my own claude config\n');

    // Repair install re-adds the block.
    await apply(adapter, [CONTEXT_ENTRY], 'user', env, targets.stateJson);
    expect(await readText(targets.claudeMd)).toContain(
      '<!-- BEGIN agent-rigger (managed — do not edit) -->',
    );

    // The manifest carries NO restore baseline — the absence is carried
    // forward, the post-install capture is never adopted.
    const manifest = await readManifest(targets.stateJson);
    const entry = findEntry(manifest, 'context-claude', 'user', 'claude');
    expect(entry?.applied).toEqual({ kind: 'context', block: CANONICAL });

    // Remove degrades to delete-on-exact-match: the managed file is GONE, not
    // "restored" to its own canonical content, and the plan carried the
    // "no restore baseline" notice.
    const removeOps = await adapter.planRemove(
      { ...CONTEXT_ENTRY, applied: entry!.applied! },
      'user',
      env,
    );
    const deleteOp = removeOps.find((op) => op.kind === 'delete-file') as
      | { kind: 'delete-file'; warnings?: string[] }
      | undefined;
    expect(deleteOp).toBeDefined();
    expect(deleteOp!.warnings!.join(' ')).toContain('restore baseline');

    await remove(adapter, [CONTEXT_ENTRY], 'user', env, targets.stateJson);
    expect(await fileExists(targets.agentsMd)).toBe(false);
    const after = await readManifest(targets.stateJson);
    expect(findEntry(after, 'context-claude', 'user', 'claude')).toBeUndefined();
  });

  it('R6: a legacy entry NEVER deletes a drifted file', async () => {
    const DRIFTED = `${CANONICAL}\nuser work\n`;
    const adapter = createClaudeAdapter({ denyRef: [], agentsContent: CANONICAL });
    await apply(adapter, [CONTEXT_ENTRY], 'user', env, targets.stateJson);
    await stripPrevious(targets.stateJson);
    await writeText(targets.agentsMd, DRIFTED);

    const result = await remove(adapter, [CONTEXT_ENTRY], 'user', env, targets.stateJson);

    expect(await readText(targets.agentsMd)).toBe(DRIFTED);
    // The block removal still went through, so the entry is dropped.
    expect(result.removed).toContain('context-claude');
  });
});

// ---------------------------------------------------------------------------
// R6 scenario 4 — the audit distinguishes drift from absence
// ---------------------------------------------------------------------------

describe('R6: audit distinguishes drift from absence', () => {
  it('R6: a diverged AGENTS.md audits as drift with a detail naming the path — never missing', async () => {
    await writeText(targets.agentsMd, 'enriched by the user\n');
    await writeText(targets.claudeMd, managedBlock('~/.claude/harness/AGENTS.md'));

    const report = await auditContext('user', env, CANONICAL);

    expect(report.state).toBe('drift');
    expect(report.detail).toContain(targets.agentsMd);
  });

  it('R6: an absent AGENTS.md still audits as missing', async () => {
    const report = await auditContext('user', env, CANONICAL);

    expect(report.state).toBe('missing');
  });

  it('R6: check exits 3 on a drifted context (engine round-trip)', async () => {
    const adapter = createClaudeAdapter({ denyRef: [], agentsContent: CANONICAL });
    await apply(adapter, [CONTEXT_ENTRY], 'user', env, targets.stateJson);
    await writeText(targets.agentsMd, `${CANONICAL}\nuser addition\n`);

    const report = await check(adapter, [CONTEXT_ENTRY], 'user', env, targets.stateJson);

    expect(report.entries[0]!.state).toBe('drift');
    expect(reportExitCode(report)).toBe(3);
  });
});
