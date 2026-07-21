/**
 * lib-nature-t5-refcount-gate.test.ts — R6 (generic refcount gate at remove) +
 * R7.1/S9 (GC of the last dependent) + R6.5 (purge gated).
 *
 * Contract (requirements.md R6, R7 sc.1, design § Surfaces R6/R7):
 * - `remove` REFUSES (exit 2, dependents named) to drop an entry a REMAINING
 *   manifest entry still `requires` — any nature, not lib-only (R6). Evaluated
 *   at RUN level: a coherent run that removes the requirer(s) in the same call is
 *   accepted regardless of order (S5). Manifest-first, offline (R5 of the stock).
 * - The refcount is GLOBAL (S2): a lib required by a claude hook AND an opencode
 *   plugin survives removing only the hook.
 * - `--force` turns the refusal into a loud per-dependent warning (R6.7).
 * - A phantom lib (dir hand-removed) still required is REFUSED, not purged
 *   silently (R6.5); without a dependent it purges normally.
 * - GC (R7.1/S9): removing the SOLE dependent of a lib proposes the orphaned lib
 *   in the SAME run under ONE confirm; refusing removes nothing.
 *
 * Harness: the direct-install channel (runInstall + createClaudeAdapter +
 * hand-supplied `libs`, the same channel runRemoteInstall feeds in production)
 * gives a REAL lib on disk with its (user, shared) manifest entry; extra
 * dependents that only need to exist in the requires graph (a graph the gate
 * reads from state.json, R5) are injected into the manifest directly. Ids are
 * kept unqualified for isolation — the gate is a plain string match over the
 * persisted graph; qualified matching is exercised by the generic tool:git case
 * (example catalogue convention) and the update-exempt e2e.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createClaudeAdapter } from '@agent-rigger/adapters';
import type { CatalogEntry } from '@agent-rigger/catalog';
import type { Adapter } from '@agent-rigger/core/adapter';
import { readManifest, writeManifest } from '@agent-rigger/core/manifest';
import { libsDir, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { ManifestEntry, Nature, Scope } from '@agent-rigger/core/types';

import { runInstall } from '../src/cmd-install';
import { RequiredByError, runRemove } from '../src/cmd-remove';

const SCOPE: Scope = 'user';

let tmpHome: string;
let env: Env;
let manifestPath: string;
let adapter: Adapter;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t5-'));
  env = { RIGGER_HOME: tmpHome };
  manifestPath = resolveUserTargets(env).stateJson;
  // A minimal hookSpec so planRemove can resolve an injected hook's spec: with no
  // settings.json the hook is absent → empty plan → purge (the removal we want).
  adapter = createClaudeAdapter({
    denyRef: [],
    agentsContent: '',
    hookSpec: () => ({ event: 'PreToolUse', matcher: 'Bash', command: 'true' }),
  });
});

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dirExists = (p: string): Promise<boolean> => fs.stat(p).then(() => true).catch(() => false);

/** Materialise a lib dir on disk + inject its (user, shared) manifest entry. */
async function materializeLib(name = 'rules-common'): Promise<string> {
  const dest = path.join(libsDir(env), name);
  await fs.mkdir(dest, { recursive: true });
  await fs.writeFile(path.join(dest, 'index.ts'), 'export const rule = 1;\n');
  await injectEntry({
    id: `lib:${name}`,
    nature: 'lib',
    ref: 'v1.0.0',
    sha: 'deadbeef',
    scope: 'user',
    installedAt: new Date().toISOString(),
    files: [dest],
    assistant: 'shared',
    requires: [],
  });
  return dest;
}

/** Append a manifest entry (a graph-only dependent) to state.json. */
async function injectEntry(entry: ManifestEntry): Promise<void> {
  const m = await readManifest(manifestPath);
  await writeManifest(manifestPath, { ...m, artifacts: [...m.artifacts, entry] });
}

/** A dependent that exists only in the requires graph (no disk footprint). */
function dependent(
  id: string,
  nature: Nature,
  requires: string[],
  opts: { scope?: Scope; assistant?: 'claude' | 'opencode' } = {},
): ManifestEntry {
  return {
    id,
    nature,
    ref: 'v1.0.0',
    sha: 'cafe',
    scope: opts.scope ?? 'user',
    installedAt: new Date().toISOString(),
    files: [],
    assistant: opts.assistant ?? 'claude',
    requires,
  };
}

/** Install a real guardrail consumer that requires the lib, lib materialised. */
async function installGuardrailWithLib(): Promise<string> {
  const source = path.join(tmpHome, 'checkout', 'common', 'libs', 'rules-common');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'index.ts'), 'export const rule = 1;\n');

  const catalog: CatalogEntry[] = [
    { kind: 'artifact', id: 'lib:rules-common', nature: 'lib', targets: [], scopes: ['user'] },
    {
      kind: 'artifact',
      id: 'guardrails-claude',
      nature: 'guardrail',
      targets: ['claude'],
      scopes: ['user', 'project'],
      requires: ['lib:rules-common'],
    },
  ];

  await runInstall({
    catalog,
    adapter,
    scope: SCOPE,
    env,
    manifestPath,
    selectedIds: ['guardrails-claude'],
    confirm: true,
    libs: [{ id: 'lib:rules-common', name: 'rules-common', source, requires: [] }],
  });

  return path.join(libsDir(env), 'rules-common');
}

// ---------------------------------------------------------------------------
// Scenario 1 — blocked, dependents named, nothing touched
// ---------------------------------------------------------------------------

describe('R6 sc.1 — a required lib refuses removal, naming every dependent', () => {
  it('refuses `remove lib:x` before any write, exit 2 (RequiredByError), naming hook AND plugin', async () => {
    const dest = await materializeLib();
    await injectEntry(dependent('hook:guard-a', 'hook', ['lib:rules-common']));
    await injectEntry(
      dependent('plugin:guard-b', 'plugin', ['lib:rules-common'], { assistant: 'opencode' }),
    );

    const before = await readManifest(manifestPath);

    let caught: unknown;
    try {
      await runRemove({
        adapter,
        scope: SCOPE,
        env,
        manifestPath,
        selectedIds: ['lib:rules-common'],
        confirm: true,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(RequiredByError);
    const message = (caught as RequiredByError).message;
    expect(message).toContain('hook:guard-a');
    expect(message).toContain('plugin:guard-b');

    // Refused BEFORE any confirm/write: disk + manifest are untouched.
    expect(await dirExists(dest)).toBe(true);
    const after = await readManifest(manifestPath);
    expect(after.artifacts).toEqual(before.artifacts);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — a coherent run is accepted regardless of order
// ---------------------------------------------------------------------------

describe('R6 sc.2 — a run that removes the lib WITH its requirers is accepted', () => {
  async function setup(): Promise<void> {
    await materializeLib();
    await injectEntry(dependent('hook:a', 'hook', ['lib:rules-common']));
    await injectEntry(dependent('hook:b', 'hook', ['lib:rules-common']));
  }

  it('accepts [lib, hook:a, hook:b] in one run (gate evaluated post-run, not per-entry)', async () => {
    await setup();
    const result = await runRemove({
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['lib:rules-common', 'hook:a', 'hook:b'],
      confirm: true,
    });
    expect(result.applied).toBe(true);
    expect(await dirExists(path.join(libsDir(env), 'rules-common'))).toBe(false);
    // The whole run left the manifest: both requirers AND the lib are gone.
    const manifest = await readManifest(manifestPath);
    expect(manifest.artifacts.some((e) => e.id === 'hook:a')).toBe(false);
    expect(manifest.artifacts.some((e) => e.id === 'hook:b')).toBe(false);
    expect(manifest.artifacts.some((e) => e.id === 'lib:rules-common')).toBe(false);
  });

  it('accepts the SAME run in the reverse order [hook:b, hook:a, lib]', async () => {
    await setup();
    const result = await runRemove({
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['hook:b', 'hook:a', 'lib:rules-common'],
      confirm: true,
    });
    expect(result.applied).toBe(true);
    expect(await dirExists(path.join(libsDir(env), 'rules-common'))).toBe(false);
    // Order does not change the outcome: the manifest is emptied of all three.
    const manifest = await readManifest(manifestPath);
    expect(manifest.artifacts.some((e) => e.id === 'hook:a')).toBe(false);
    expect(manifest.artifacts.some((e) => e.id === 'hook:b')).toBe(false);
    expect(manifest.artifacts.some((e) => e.id === 'lib:rules-common')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — global refcount across assistants
// ---------------------------------------------------------------------------

describe('R6 sc.3 — removing one cross-assistant dependent keeps the shared lib', () => {
  it('a lib required by a claude hook (user) AND an opencode plugin (project) survives removing the hook', async () => {
    const dest = await materializeLib();
    await injectEntry(dependent('hook:guard-a', 'hook', ['lib:rules-common']));
    await injectEntry(
      dependent('plugin:guard-b', 'plugin', ['lib:rules-common'], {
        scope: 'project',
        assistant: 'opencode',
      }),
    );

    // Remove ONLY the claude hook (empty plan → purged); the lib is still held
    // by the remaining opencode/project plugin, so it is NOT collected.
    await runRemove({
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['hook:guard-a'],
      confirm: true,
    });

    const manifest = await readManifest(manifestPath);
    const libEntry = manifest.artifacts.filter((e) => e.id === 'lib:rules-common');
    // The single global (user, shared) entry survives, unduplicated.
    expect(libEntry).toHaveLength(1);
    expect(libEntry[0]!.assistant).toBe('shared');
    expect(await dirExists(dest)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — purge is gated too
// ---------------------------------------------------------------------------

describe('R6 sc.5 — a phantom lib is gated, not silently purged', () => {
  it('refuses to purge a vanished lib dir that is still required', async () => {
    const dest = await materializeLib();
    await injectEntry(dependent('hook:guard-a', 'hook', ['lib:rules-common']));
    // The dir vanished from disk (hand-removed) — purge candidate…
    await fs.rm(dest, { recursive: true, force: true });

    await expect(
      runRemove({
        adapter,
        scope: SCOPE,
        env,
        manifestPath,
        selectedIds: ['lib:rules-common'],
        confirm: true,
      }),
    ).rejects.toBeInstanceOf(RequiredByError);

    // …but still required → the manifest entry is preserved, not purged.
    const manifest = await readManifest(manifestPath);
    expect(manifest.artifacts.some((e) => e.id === 'lib:rules-common')).toBe(true);
  });

  it('purges a vanished lib dir with no remaining dependent (manifest-only, no confirm)', async () => {
    const dest = await materializeLib();
    await fs.rm(dest, { recursive: true, force: true });

    const result = await runRemove({
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['lib:rules-common'],
      // A pure purge (no dir on disk) needs no confirmation — false must NOT
      // abort it (it destroys nothing on disk).
      confirm: false,
    });

    expect(result.output).toContain('Purged');
    const manifest = await readManifest(manifestPath);
    expect(manifest.artifacts.some((e) => e.id === 'lib:rules-common')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — generic (not lib-specific): skill requires tool
// ---------------------------------------------------------------------------

describe('R6 sc.6 — the gate is generic: skill:hello-rigger requires tool:git', () => {
  async function setup(): Promise<void> {
    await injectEntry(dependent('example/skill:hello-rigger', 'skill', ['example/tool:git']));
    await injectEntry(dependent('example/tool:git', 'tool', []));
  }

  it('refuses `remove tool:git` alone, naming the skill (exit 2)', async () => {
    await setup();
    let caught: unknown;
    try {
      await runRemove({
        adapter,
        scope: SCOPE,
        env,
        manifestPath,
        selectedIds: ['example/tool:git'],
        confirm: true,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RequiredByError);
    expect((caught as RequiredByError).message).toContain('example/skill:hello-rigger');
  });

  it('accepts removing the skill and the tool in a single run', async () => {
    await setup();
    // No throw — a coherent run.
    await runRemove({
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['example/skill:hello-rigger', 'example/tool:git'],
      confirm: true,
    });
    // The requirer is actually gone from the manifest (purged — no disk footprint).
    const manifest = await readManifest(manifestPath);
    expect(manifest.artifacts.some((e) => e.id === 'example/skill:hello-rigger')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 7 — --force is loud, never silent
// ---------------------------------------------------------------------------

describe('R6 sc.7 — --force removes anyway, warning names the broken dependents', () => {
  it('removes the required lib and surfaces a warning naming hook AND plugin', async () => {
    const dest = await materializeLib();
    await injectEntry(dependent('hook:guard-a', 'hook', ['lib:rules-common']));
    await injectEntry(
      dependent('plugin:guard-b', 'plugin', ['lib:rules-common'], { assistant: 'opencode' }),
    );

    const result = await runRemove({
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['lib:rules-common'],
      confirm: true,
      force: true,
    });

    // The removal proceeded.
    expect(result.applied).toBe(true);
    expect(await dirExists(dest)).toBe(false);
    // …loudly: the warning names the dependents whose imports will break.
    expect(result.output).toContain('hook:guard-a');
    expect(result.output).toContain('plugin:guard-b');
    expect(result.output.toLowerCase()).toContain('break');
  });
});

// ---------------------------------------------------------------------------
// Scenario 8 — GC of the last dependent, same run, one confirm
// ---------------------------------------------------------------------------

describe('R7.1/S9 — removing the sole dependent proposes the orphaned lib in the same run', () => {
  it('one confirm covers both; refusing removes NOTHING', async () => {
    const dest = await installGuardrailWithLib();
    expect(await dirExists(dest)).toBe(true);

    const before = await readManifest(manifestPath);

    const result = await runRemove({
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude'],
      // Refuse the single confirm → nothing removed.
      confirm: false,
    });

    expect(result.applied).toBe(false);
    // The plan proposed the orphaned lib under the SAME confirm.
    expect(result.output).toContain('lib:rules-common');
    // Refusing removes NOTHING — disk and manifest intact.
    expect(await dirExists(dest)).toBe(true);
    const after = await readManifest(manifestPath);
    expect(after.artifacts).toEqual(before.artifacts);
  });

  it('accepting removes the guardrail AND the orphaned lib, backing up the lib dir', async () => {
    const dest = await installGuardrailWithLib();

    const result = await runRemove({
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude'],
      confirm: true,
    });

    expect(result.applied).toBe(true);
    // Both the requirer and the orphaned lib are gone from the manifest.
    const manifest = await readManifest(manifestPath);
    expect(manifest.artifacts.some((e) => e.id === 'guardrails-claude')).toBe(false);
    expect(manifest.artifacts.some((e) => e.id === 'lib:rules-common')).toBe(false);
    // The lib dir left the disk, backed up as a whole (engine lib channel).
    expect(await dirExists(dest)).toBe(false);
    const libBak = result.backedUp.find((b) => path.basename(b).startsWith('rules-common.bak-'));
    expect(libBak).toBeDefined();
    // The REPORTED backup path must actually exist on disk — not a stale path
    // relocated by a redundant second backup of the whole libs/ root (the
    // per-entry lib channel is the sole owner of lib backup+removal).
    expect(await dirExists(libBak!)).toBe(true);
    expect(await dirExists(path.join(libBak!, 'index.ts'))).toBe(true);
  });
});
