/**
 * Tests for opencode/plugins handler (TDD — written before implementation).
 *
 * Covers:
 * - pluginName: strips 'plugin:' prefix from entry id (shared guard with skill/agent).
 * - auditPlugin: target absent → missing; a file matching the plugin name (any extension)
 *   present in pluginDir → present.
 * - planPlugin: absent → 1 link op (store under ~/.config/agent-rigger/plugins/, target
 *   opencode-owned pluginDir); present → [].
 * - planRemovePlugin: discovers the actual installed file (and its extension) from disk —
 *   offline, no source resolver needed — → 1 unlink op; absent → [].
 * - end-to-end via createOpencodeAdapter: check missing → apply (reuses the 'link'
 *   opKindHandler already wired for skill, scanner runs) → check present → remove →
 *   check missing; blocking scanner prevents installation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import {
  resolveOpencodeProjectTargets,
  resolveOpencodeUserTargets,
  resolveUserTargets,
} from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { Scanner } from '@agent-rigger/core/scan';
import type { Verdict } from '@agent-rigger/core/types';

import { createOpencodeAdapter } from '../../src/opencode/adapter';
import { auditPlugin, planPlugin, planRemovePlugin, pluginName } from '../../src/opencode/plugins';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-opencode-plugins-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** Create a minimal plugin fixture module file. */
async function makePluginFixture(baseDir: string, name: string, ext = '.ts'): Promise<string> {
  const filePath = path.join(baseDir, `${name}${ext}`);
  await fs.writeFile(filePath, `export const plugin = { name: '${name}' };\n`);
  return filePath;
}

const PASSING_VERDICT: Verdict = { ok: true };

/** Spy scanner that records calls. */
function makeSpyScanner(verdict: Verdict = PASSING_VERDICT): Scanner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    scan(source: string): Promise<Verdict> {
      calls.push(source);
      return Promise.resolve(verdict);
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let fixturesDir: string;

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
  fixturesDir = path.join(tmp.dir, 'fixtures');
  await fs.mkdir(fixturesDir, { recursive: true });
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// pluginName
// ---------------------------------------------------------------------------

describe('pluginName', () => {
  it("strips 'plugin:' prefix from entry id", () => {
    const entry: AdapterEntry = { id: 'plugin:enforce-tests', nature: 'plugin', scope: 'user' };
    expect(pluginName(entry)).toBe('enforce-tests');
  });

  it('returns the id unchanged when no prefix', () => {
    const entry: AdapterEntry = { id: 'my-plugin', nature: 'plugin', scope: 'user' };
    expect(pluginName(entry)).toBe('my-plugin');
  });

  it('throws for ids with multiple colons (path traversal guard)', () => {
    const entry: AdapterEntry = { id: 'plugin:a:b', nature: 'plugin', scope: 'user' };
    expect(() => pluginName(entry)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// auditPlugin
// ---------------------------------------------------------------------------

describe('auditPlugin', () => {
  it('returns missing when target does not exist', async () => {
    const entry: AdapterEntry = { id: 'plugin:enforce-tests', nature: 'plugin', scope: 'user' };

    const report = await auditPlugin(entry, 'user', env);

    expect(report.state).toBe('missing');
    expect(report.nature).toBe('plugin');
    expect(report.id).toBe('plugin:enforce-tests');
  });

  it('returns present when the opencode user pluginDir has a matching file (any extension)', async () => {
    const entry: AdapterEntry = { id: 'plugin:enforce-tests', nature: 'plugin', scope: 'user' };
    const targets = resolveOpencodeUserTargets(env);
    await fs.mkdir(targets.pluginDir, { recursive: true });
    await fs.writeFile(path.join(targets.pluginDir, 'enforce-tests.ts'), 'export {};');

    const report = await auditPlugin(entry, 'user', env);

    expect(report.state).toBe('present');
  });

  it('uses the opencode project target path for scope project', async () => {
    const cwd = tmp.dir;
    const entry: AdapterEntry = { id: 'plugin:enforce-tests', nature: 'plugin', scope: 'project' };
    const targets = resolveOpencodeProjectTargets(cwd);
    await fs.mkdir(targets.pluginDir, { recursive: true });
    await fs.writeFile(path.join(targets.pluginDir, 'enforce-tests.js'), 'export {};');

    const report = await auditPlugin(entry, 'project', env, cwd);

    expect(report.state).toBe('present');
  });
});

// ---------------------------------------------------------------------------
// planPlugin
// ---------------------------------------------------------------------------

describe('planPlugin', () => {
  it('returns one link op when plugin is absent', async () => {
    const entry: AdapterEntry = { id: 'plugin:enforce-tests', nature: 'plugin', scope: 'user' };
    const srcFile = await makePluginFixture(fixturesDir, 'enforce-tests');
    const pluginSource = (_e: AdapterEntry) => srcFile;

    const ops = await planPlugin(entry, 'user', env, pluginSource);

    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('link');
  });

  it('link op has correct source, store (under agent-rigger/plugins), and opencode target paths', async () => {
    const entry: AdapterEntry = { id: 'plugin:enforce-tests', nature: 'plugin', scope: 'user' };
    const srcFile = await makePluginFixture(fixturesDir, 'enforce-tests');
    const pluginSource = (_e: AdapterEntry) => srcFile;
    const sharedTargets = resolveUserTargets(env);
    const opencodeTargets = resolveOpencodeUserTargets(env);

    const ops = await planPlugin(entry, 'user', env, pluginSource);
    const op = ops[0] as { kind: string; source: string; store: string; target: string };

    expect(op.source).toBe(srcFile);
    expect(op.store).toBe(
      path.join(path.dirname(sharedTargets.skillsDir), 'plugins', 'enforce-tests.ts'),
    );
    expect(op.target).toBe(path.join(opencodeTargets.pluginDir, 'enforce-tests.ts'));
  });

  it('returns empty array when plugin is already present', async () => {
    const entry: AdapterEntry = { id: 'plugin:enforce-tests', nature: 'plugin', scope: 'user' };
    const srcFile = await makePluginFixture(fixturesDir, 'enforce-tests');
    const pluginSource = (_e: AdapterEntry) => srcFile;

    const targets = resolveOpencodeUserTargets(env);
    await fs.mkdir(targets.pluginDir, { recursive: true });
    await fs.writeFile(path.join(targets.pluginDir, 'enforce-tests.ts'), 'export {};');

    const ops = await planPlugin(entry, 'user', env, pluginSource);

    expect(ops).toHaveLength(0);
  });

  it('uses opencode project target path for scope project, store stays user-scope', async () => {
    const cwd = tmp.dir;
    const entry: AdapterEntry = { id: 'plugin:enforce-tests', nature: 'plugin', scope: 'project' };
    const srcFile = await makePluginFixture(fixturesDir, 'enforce-tests');
    const pluginSource = (_e: AdapterEntry) => srcFile;
    const sharedTargets = resolveUserTargets(env);

    const ops = await planPlugin(entry, 'project', env, pluginSource, cwd);
    const op = ops[0] as { kind: string; source: string; store: string; target: string };

    expect(op.store).toBe(
      path.join(path.dirname(sharedTargets.skillsDir), 'plugins', 'enforce-tests.ts'),
    );
    expect(op.target).toBe(
      path.join(resolveOpencodeProjectTargets(cwd).pluginDir, 'enforce-tests.ts'),
    );
  });
});

// ---------------------------------------------------------------------------
// planRemovePlugin
// ---------------------------------------------------------------------------

describe('planRemovePlugin', () => {
  it('returns [] when not installed', async () => {
    const entry: AdapterEntry = { id: 'plugin:enforce-tests', nature: 'plugin', scope: 'user' };

    const ops = await planRemovePlugin(entry, 'user', env);

    expect(ops).toHaveLength(0);
  });

  it('discovers the actual installed extension and returns one unlink op', async () => {
    const entry: AdapterEntry = { id: 'plugin:enforce-tests', nature: 'plugin', scope: 'user' };
    const targets = resolveOpencodeUserTargets(env);
    await fs.mkdir(targets.pluginDir, { recursive: true });
    await fs.writeFile(path.join(targets.pluginDir, 'enforce-tests.ts'), 'export {};');
    const sharedTargets = resolveUserTargets(env);

    const ops = await planRemovePlugin(entry, 'user', env);

    expect(ops).toEqual([{
      kind: 'unlink',
      target: path.join(targets.pluginDir, 'enforce-tests.ts'),
      store: path.join(path.dirname(sharedTargets.skillsDir), 'plugins', 'enforce-tests.ts'),
    }]);
  });

  it('uses the opencode project target path for scope project', async () => {
    const cwd = tmp.dir;
    const entry: AdapterEntry = { id: 'plugin:enforce-tests', nature: 'plugin', scope: 'project' };
    const targets = resolveOpencodeProjectTargets(cwd);
    await fs.mkdir(targets.pluginDir, { recursive: true });
    await fs.writeFile(path.join(targets.pluginDir, 'enforce-tests.js'), 'export {};');

    const ops = await planRemovePlugin(entry, 'project', env, cwd);

    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('unlink');
  });
});

// ---------------------------------------------------------------------------
// end-to-end via createOpencodeAdapter
// ---------------------------------------------------------------------------

describe('createOpencodeAdapter — plugin end-to-end', () => {
  it('check missing → apply (link reused) → check present → remove → check missing', async () => {
    const srcFile = await makePluginFixture(fixturesDir, 'enforce-tests');
    const pluginSource = (_e: AdapterEntry) => srcFile;
    const scanner = makeSpyScanner();

    const adapter = createOpencodeAdapter({ pluginSource, scanner });
    const entry: AdapterEntry = { id: 'plugin:enforce-tests', nature: 'plugin', scope: 'user' };

    const report1 = await adapter.audit(entry, 'user', env);
    expect(report1.state).toBe('missing');

    const ops = await adapter.plan(entry, 'user', env);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe('link');
    await adapter.apply(ops, env);

    expect(scanner.calls).toEqual([srcFile]);

    const report2 = await adapter.audit(entry, 'user', env);
    expect(report2.state).toBe('present');

    const opencodeTargets = resolveOpencodeUserTargets(env);
    const content = await fs.readFile(
      path.join(opencodeTargets.pluginDir, 'enforce-tests.ts'),
      'utf-8',
    );
    expect(content).toContain('enforce-tests');

    // 2nd plan is a no-op (idempotent)
    const ops2 = await adapter.plan(entry, 'user', env);
    expect(ops2).toHaveLength(0);

    const removeOps = await adapter.planRemove(entry, 'user', env);
    expect(removeOps).toHaveLength(1);
    expect(removeOps[0]!.kind).toBe('unlink');
    await adapter.applyRemove(removeOps, env);

    const report3 = await adapter.audit(entry, 'user', env);
    expect(report3.state).toBe('missing');
  });

  it('blocking scanner prevents installation entirely (store+target untouched)', async () => {
    const srcFile = await makePluginFixture(fixturesDir, 'dangerous');
    const pluginSource = (_e: AdapterEntry) => srcFile;
    const blockingScanner = makeSpyScanner({ ok: false, findings: ['malicious pattern'] });

    const adapter = createOpencodeAdapter({ pluginSource, scanner: blockingScanner });
    const entry: AdapterEntry = { id: 'plugin:dangerous', nature: 'plugin', scope: 'user' };

    const ops = await adapter.plan(entry, 'user', env);
    await expect(adapter.apply(ops, env)).rejects.toThrow();

    const report = await adapter.audit(entry, 'user', env);
    expect(report.state).toBe('missing');
  });

  it('throws an actionable error when pluginSource is not configured', async () => {
    const adapter = createOpencodeAdapter({});
    const entry: AdapterEntry = { id: 'plugin:enforce-tests', nature: 'plugin', scope: 'user' };

    await expect(adapter.plan(entry, 'user', env)).rejects.toThrow(/pluginSource/);
  });
});
