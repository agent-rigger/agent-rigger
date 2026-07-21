/**
 * End-to-end lifecycle test for the opencode 'agent' nature (F1).
 *
 * Complements the adapter-level round-trip already in agents.test.ts
 * ("createOpencodeAdapter — agent end-to-end"). This file adds the dimensions
 * that one does NOT cover:
 *
 *   - Full lifecycle driven through the REAL core/engine (apply/check/remove +
 *     readManifest/findEntry), not the bare adapter — proving the manifest
 *     round-trip: the 'context' applied payload is recorded on install, drives
 *     the offline 'present' check, and is dropped on remove.
 *   - End-to-end verification that a `tools: Read, Bash` source is TRANSLATED all
 *     the way to disk into `permission: { "*": deny, read: allow, bash: allow }`
 *     with `"*"` serialized FIRST (F0-agents-2), asserted on the written file —
 *     not just on the pure translator (which agents.test.ts already covers).
 *   - Idempotence at both plan and engine level (second apply is a no-op).
 *   - A pre-existing, user-authored agent file in the same agents/ directory is
 *     left byte-for-byte untouched by both install and remove.
 *   - The same lifecycle for project scope (explicit cwd → <cwd>/.opencode/agents).
 *
 * Uses the real adapter handlers and the real core engine end-to-end — no mocks
 * or stubs. Every assertion is load-bearing: a no-op install, a no-op remove, a
 * broken translation, or a directory-nuking remove would each fail the test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply, check, remove } from '@agent-rigger/core/engine';
import { writeText } from '@agent-rigger/core/fs-json';
import { findEntry, readManifest } from '@agent-rigger/core/manifest';
import {
  resolveOpencodeProjectTargets,
  resolveOpencodeUserTargets,
  resolveUserTargets,
} from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { WriteOpWriteText } from '@agent-rigger/core/types';

import { createOpencodeAdapter } from '../../src/opencode/adapter';
import { auditAgent, planAgent, planRemoveAgent } from '../../src/opencode/agents';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-opencode-e2e-agent-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/**
 * A real Claude-style sub-agent source `.md`. `tools: Read, Bash` is the F0-agents-2
 * exhibit: it must translate to a permission allow-list with `"*": deny` FIRST.
 * `model` is already in `provider/model` form and `name` is dropped silently, so
 * the translation emits ZERO warnings — the lifecycle stays clean.
 */
const REVIEWER_SOURCE = [
  '---',
  'name: reviewer',
  'description: Reviews code changes for correctness.',
  'model: anthropic/claude-opus-4-8',
  'tools: Read, Bash',
  '---',
  '',
  '# Reviewer',
  '',
  'Review the diff.',
  '',
].join('\n');

/** The exact permission block the source above must produce, in insertion order. */
const EXPECTED_PERMISSION_BLOCK = [
  'permission:',
  '  "*": deny',
  '  read: allow',
  '  bash: allow',
].join('\n');

/** Content of a pre-existing, user-authored agent that install/remove must never touch. */
const FOREIGN_AGENT = [
  '---',
  'description: A hand-written agent that agent-rigger does not manage.',
  'mode: primary',
  '---',
  '',
  '# Untracked',
  '',
  'Leave me alone.',
  '',
].join('\n');

/** Assert the translated-on-disk content carries the F0-agents-2 permission shape. */
function expectTranslatedFrontmatter(content: string): void {
  expect(content).toContain('mode: subagent');
  expect(content).toContain('model: anthropic/claude-opus-4-8');
  expect(content).toContain('description: Reviews code changes for correctness.');
  // Body survived the round-trip.
  expect(content).toContain('Review the diff.');
  // 'tools' was consumed, not passed through.
  expect(content).not.toContain('tools:');
  // Whole permission block, in order: this is the load-bearing F0-agents-2 check
  // exercised end-to-end (plan → serialize → write), not on the pure translator.
  expect(content).toContain(EXPECTED_PERMISSION_BLOCK);
  // Defensive: "*" (fail-safe catch-all) is serialized BEFORE any allow entry —
  // opencode resolves rules with findLast over key order, so a trailing "*" would
  // silently override the allows above it.
  expect(content.indexOf('"*": deny')).toBeLessThan(content.indexOf('read: allow'));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let sourcePath: string;

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
  sourcePath = path.join(tmp.dir, 'reviewer.source.md');
  await writeText(sourcePath, REVIEWER_SOURCE);
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// User scope — full lifecycle through the real core engine
// ---------------------------------------------------------------------------

describe('opencode agent E2E — user scope via core engine', () => {
  it('check missing → apply → present with translated frontmatter → idempotent → remove → gone', async () => {
    const adapter = createOpencodeAdapter({ agentSource: () => sourcePath });
    const entry: AdapterEntry = { id: 'agent:reviewer', nature: 'agent', scope: 'user' };
    const manifestPath = resolveUserTargets(env).stateJson;
    const targetPath = path.join(resolveOpencodeUserTargets(env).agentsDir, 'reviewer.md');

    // --- 0. Seed a foreign, user-authored agent in the SAME agents/ directory. ---
    const foreignPath = path.join(resolveOpencodeUserTargets(env).agentsDir, 'untracked.md');
    await writeText(foreignPath, FOREIGN_AGENT);

    // --- 1. check: missing (not installed, not in manifest). ---
    const before = await check(adapter, [entry], 'user', env, manifestPath);
    expect(before.entries).toHaveLength(1);
    expect(before.entries[0]!.state).toBe('missing');
    expect(await Bun.file(targetPath).exists()).toBe(false);

    // --- 2. apply: writes the translated file + records the manifest entry. ---
    const applyResult = await apply({
      adapter,
      entries: [entry],
      scope: 'user',
      env,
      manifestPath,
    });
    expect(applyResult.written).toContain(targetPath);

    // File exists on disk with the TRANSLATED frontmatter (end-to-end F0-agents-2).
    const written = await fs.readFile(targetPath, 'utf-8');
    expectTranslatedFrontmatter(written);

    // Manifest recorded the install with the exact 'context' applied payload.
    const manifest = await readManifest(manifestPath);
    const recorded = findEntry(manifest, 'agent:reviewer', 'user', 'opencode');
    expect(recorded).toBeDefined();
    expect(recorded!.nature).toBe('agent');
    expect(recorded!.files).toContain(targetPath);
    expect(recorded!.applied).toEqual({ kind: 'context', block: written });

    // Foreign agent untouched by install.
    expect(await fs.readFile(foreignPath, 'utf-8')).toBe(FOREIGN_AGENT);

    // --- 3. check: present (offline, resolved against the manifest applied payload). ---
    const present = await check(adapter, [entry], 'user', env, manifestPath);
    expect(present.entries[0]!.state).toBe('present');

    // --- 4. idempotence: plan is [] and a second apply writes nothing. ---
    expect(await adapter.plan(entry, 'user', env)).toHaveLength(0);
    const reapply = await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });
    expect(reapply.written).toEqual([]);
    // Content unchanged by the no-op apply.
    expect(await fs.readFile(targetPath, 'utf-8')).toBe(written);

    // --- 5. remove: file gone, manifest entry dropped, foreign file survives. ---
    const removeResult = await remove(adapter, [entry], 'user', env, manifestPath);
    expect(removeResult.removed).toContain('agent:reviewer');
    expect(await Bun.file(targetPath).exists()).toBe(false);

    const afterManifest = await readManifest(manifestPath);
    expect(findEntry(afterManifest, 'agent:reviewer', 'user', 'opencode')).toBeUndefined();

    // Foreign agent (same directory) untouched by remove — delete-file targets the
    // one file, never the enclosing agents/ directory.
    expect(await Bun.file(foreignPath).exists()).toBe(true);
    expect(await fs.readFile(foreignPath, 'utf-8')).toBe(FOREIGN_AGENT);

    // --- 6. check: missing again. ---
    const after = await check(adapter, [entry], 'user', env, manifestPath);
    expect(after.entries[0]!.state).toBe('missing');
  });
});

// ---------------------------------------------------------------------------
// Project scope — full lifecycle through the real handlers + adapter apply
// ---------------------------------------------------------------------------

describe('opencode agent E2E — project scope', () => {
  it('audit missing → apply → present with translated frontmatter → idempotent → remove → gone', async () => {
    // Project scope keys off an explicit cwd (the adapter dispatch uses
    // process.cwd() for its own project handling, so the lifecycle is driven
    // through the pure handlers with an isolated cwd = tmp.dir to avoid touching
    // the real repo tree). apply/applyRemove operate on absolute op paths and are
    // cwd-agnostic, so the real adapter apply pipeline is still exercised.
    const cwd = tmp.dir;
    const adapter = createOpencodeAdapter({ agentSource: () => sourcePath });
    const entry: AdapterEntry = { id: 'agent:reviewer', nature: 'agent', scope: 'project' };
    const agentsDir = resolveOpencodeProjectTargets(cwd).agentsDir;
    const targetPath = path.join(agentsDir, 'reviewer.md');
    const agentSource = (_e: AdapterEntry) => sourcePath;

    // Seed a foreign, user-authored agent in the project agents/ directory.
    const foreignPath = path.join(agentsDir, 'untracked.md');
    await writeText(foreignPath, FOREIGN_AGENT);

    // --- 1. audit: missing. ---
    const before = await auditAgent(entry, 'project', env, agentSource, cwd);
    expect(before.state).toBe('missing');

    // --- 2. plan → apply: writes the translated file under <cwd>/.opencode/agents. ---
    const ops = await planAgent(entry, 'project', env, agentSource, cwd);
    expect(ops).toHaveLength(1);
    expect((ops[0] as WriteOpWriteText).path).toBe(targetPath);
    await adapter.apply(ops, env);

    const written = await fs.readFile(targetPath, 'utf-8');
    expectTranslatedFrontmatter(written);

    // --- 3. audit: present. ---
    const present = await auditAgent(entry, 'project', env, agentSource, cwd);
    expect(present.state).toBe('present');

    // --- 4. idempotence: re-plan is []. ---
    expect(await planAgent(entry, 'project', env, agentSource, cwd)).toHaveLength(0);

    // Foreign agent untouched by install.
    expect(await fs.readFile(foreignPath, 'utf-8')).toBe(FOREIGN_AGENT);

    // --- 5. remove: file gone, foreign file survives. ---
    const removeOps = await planRemoveAgent(entry, 'project', env, agentSource, cwd);
    expect(removeOps).toEqual([{ kind: 'delete-file', path: targetPath }]);
    await adapter.applyRemove(removeOps, env);
    expect(await Bun.file(targetPath).exists()).toBe(false);
    expect(await fs.readFile(foreignPath, 'utf-8')).toBe(FOREIGN_AGENT);

    // --- 6. audit: missing again. ---
    const after = await auditAgent(entry, 'project', env, agentSource, cwd);
    expect(after.state).toBe('missing');
  });
});
