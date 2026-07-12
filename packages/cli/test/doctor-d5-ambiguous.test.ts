/**
 * doctor-d5-ambiguous.test.ts — D5: adoption id resolution reads catalog content.
 *
 * One test per D5 scenario in requirements.md, named `doctor-D5: …` (stock §8
 * traceability convention). Driven through `runDoctorState` directly with an
 * injected `catalogCanons` (the `--remote` canon the CLI would fetch) and an
 * injected `chooseAdoptionCatalog` prompt — the same injection seam as
 * `confirmItem`, so the resolver's content search + prompt wiring is exercised
 * without the git-fetch machinery.
 *
 * The invariant this pins: an UNQUALIFIED adopt candidate (`<nature>:<name>`)
 * that two configured catalogs both offer is ambiguous — prompted in a TTY
 * (adopted under the chosen catalog's qualified id), skipped + reported in a
 * non-TTY (never guessed, exit 3). Without canons the v1 prefix resolution
 * (`unique`/`none`) is byte-identical.
 *
 * TDD: written before `resolveAdoptionId` grew its canon-aware branch and
 * `RunDoctorStateOpts` grew `chooseAdoptionCatalog` (RED → GREEN).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { type Nature, untrackedAdoptable } from '@agent-rigger/core';
import type { Adapter } from '@agent-rigger/core/adapter';
import { findEntry, readManifest, writeManifest } from '@agent-rigger/core/manifest';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { RunLock } from '@agent-rigger/core/run-lock';

import type { CatalogCanon, CatalogEntry } from '@agent-rigger/catalog';

import { runDoctorState } from '../src/cmd-doctor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function capture(): { lines: string[]; print: (s: string) => void; text: () => string } {
  const lines: string[] = [];
  return { lines, print: (s: string) => lines.push(s), text: () => lines.join('\n') };
}

async function makeTmpHome(): Promise<{ env: Env; home: string; cleanup: () => Promise<void> }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-doctor-d5-'));
  return {
    env: { RIGGER_HOME: home },
    home,
    cleanup: () => fs.rm(home, { recursive: true, force: true }),
  };
}

function scanner(finding: ReturnType<typeof untrackedAdoptable>): () => Promise<[typeof finding]> {
  return async () => [finding];
}

/** A minimal adapter whose `adopt` always succeeds — drives a real manifest write. */
function fakeAdoptingAdapter(id: 'claude' | 'opencode'): Adapter {
  return {
    id,
    audit: async (entry) => ({ id: entry.id, nature: entry.nature, state: 'present' }),
    plan: async () => [],
    apply: async () => {},
    planRemove: async () => [],
    applyRemove: async () => {},
    adopt: async (entry) => ({ files: [entry.id] }),
  };
}

/** A fresh, no-op run-lock whose path matches applyRepairs' wrong-lock guard. */
const fakeLock = async (mp: string): Promise<RunLock> => ({
  path: `${mp}.lock`,
  release: async () => {},
});

/** A single artifact entry whose id is `<nature>:<name>` (canon-raw, unqualified). */
function artifactEntry(id: string): CatalogEntry {
  const nature = id.slice(0, id.indexOf(':')) as Nature;
  return { kind: 'artifact', id, nature, targets: ['claude'], scopes: ['user'] };
}

/** An in-memory canon (as `--remote` would produce) offering `ids`, no content files. */
function makeCanon(name: string, ids: string[]): CatalogCanon {
  return {
    name,
    meta: { name, required: [], recommended: [] },
    version: { ref: 'v1.0.0', sha: 'a'.repeat(40), isTag: true },
    entries: ids.map(artifactEntry),
    guardrails: new Map(),
    guardrailPermissions: new Map(),
    contexts: new Map(),
  };
}

async function seedEmptyManifest(env: Env): Promise<string> {
  const manifestPath = resolveUserTargets(env).stateJson;
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await writeManifest(manifestPath, { version: 1, artifacts: [] });
  return manifestPath;
}

// ---------------------------------------------------------------------------
// 1. two catalogs offer the same short name → prompt in TTY, adopt under choice
// ---------------------------------------------------------------------------

describe('doctor-D5: two catalogs offering the same nature+name prompt in a TTY', () => {
  let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
  beforeEach(async () => (tmp = await makeTmpHome()));
  afterEach(() => tmp.cleanup());

  it('prompts for the catalog and adopts under the chosen qualified id', async () => {
    const manifestPath = await seedEmptyManifest(tmp.env);
    const canons = [makeCanon('alpha', ['skill:foo']), makeCanon('beta', ['skill:foo'])];

    const chooseCalls: { candidateId: string; names: string[] }[] = [];
    const cap = capture();
    const code = await runDoctorState({
      env: tmp.env,
      print: cap.print,
      fix: true,
      yes: false,
      isTTY: true,
      configuredCatalogIds: ['alpha', 'beta'],
      catalogCanons: canons,
      color: false,
      scanners: [scanner(
        untrackedAdoptable({
          nature: 'skill',
          scope: 'user',
          assistant: 'claude',
          path: '/h/.claude/skills/foo',
          candidateId: 'skill:foo',
        }),
      )],
      adapters: new Map([['claude', fakeAdoptingAdapter('claude')]]),
      confirmItem: async () => true,
      chooseAdoptionCatalog: async (candidateId, names) => {
        chooseCalls.push({ candidateId, names });
        return 'alpha';
      },
      acquireLock: fakeLock,
    });

    expect(code).toBe(0);
    // The prompt was reached exactly once, with both offering catalogs.
    expect(chooseCalls).toHaveLength(1);
    expect(chooseCalls[0]?.candidateId).toBe('skill:foo');
    expect(chooseCalls[0]?.names).toEqual(['alpha', 'beta']);

    // Adopted under the CHOSEN catalog's qualified id, not the raw candidate.
    const persisted = await readManifest(manifestPath);
    expect(findEntry(persisted, 'alpha/skill:foo', 'user', 'claude')).toBeDefined();
    expect(findEntry(persisted, 'skill:foo', 'user', 'claude')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. same ambiguity in a non-TTY --yes → skip + report, exit 3
// ---------------------------------------------------------------------------

describe('doctor-D5: the same ambiguity in a non-TTY session is skipped + reported', () => {
  let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
  beforeEach(async () => (tmp = await makeTmpHome()));
  afterEach(() => tmp.cleanup());

  it('never prompts, never adopts, exits 3', async () => {
    const manifestPath = await seedEmptyManifest(tmp.env);
    const canons = [makeCanon('alpha', ['skill:foo']), makeCanon('beta', ['skill:foo'])];

    let chooseCalled = false;
    const cap = capture();
    const code = await runDoctorState({
      env: tmp.env,
      print: cap.print,
      fix: true,
      yes: true,
      isTTY: false,
      configuredCatalogIds: ['alpha', 'beta'],
      catalogCanons: canons,
      color: false,
      scanners: [scanner(
        untrackedAdoptable({
          nature: 'skill',
          scope: 'user',
          assistant: 'claude',
          path: '/h/.claude/skills/foo',
          candidateId: 'skill:foo',
        }),
      )],
      adapters: new Map([['claude', fakeAdoptingAdapter('claude')]]),
      chooseAdoptionCatalog: async () => {
        chooseCalled = true;
        return 'alpha';
      },
      acquireLock: fakeLock,
    });

    expect(code).toBe(3);
    expect(chooseCalled).toBe(false);
    expect(cap.text()).toContain('more than one');

    // Nothing adopted — neither the raw id nor any qualified id.
    const persisted = await readManifest(manifestPath);
    expect(findEntry(persisted, 'skill:foo', 'user', 'claude')).toBeUndefined();
    expect(findEntry(persisted, 'alpha/skill:foo', 'user', 'claude')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. without --remote (no canons) → v1 prefix resolution, byte-identical
// ---------------------------------------------------------------------------

describe('doctor-D5: without --remote the v1 unique/none resolution is unchanged', () => {
  let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
  beforeEach(async () => (tmp = await makeTmpHome()));
  afterEach(() => tmp.cleanup());

  it('a qualified candidate with a configured prefix resolves unique (no prompt)', async () => {
    const manifestPath = await seedEmptyManifest(tmp.env);

    let chooseCalled = false;
    const cap = capture();
    const code = await runDoctorState({
      env: tmp.env,
      print: cap.print,
      fix: true,
      yes: true,
      isTTY: false,
      configuredCatalogIds: ['alpha'],
      color: false, // no catalogCanons → no --remote
      scanners: [scanner(
        untrackedAdoptable({
          nature: 'skill',
          scope: 'user',
          assistant: 'claude',
          path: '/h/.claude/skills/foo',
          candidateId: 'alpha/skill:foo',
        }),
      )],
      adapters: new Map([['claude', fakeAdoptingAdapter('claude')]]),
      chooseAdoptionCatalog: async () => {
        chooseCalled = true;
        return 'alpha';
      },
      acquireLock: fakeLock,
    });

    expect(code).toBe(0);
    expect(chooseCalled).toBe(false);
    const persisted = await readManifest(manifestPath);
    expect(findEntry(persisted, 'alpha/skill:foo', 'user', 'claude')).toBeDefined();
  });

  it('an unqualified candidate resolves none → adopted under the raw defaults id', async () => {
    const manifestPath = await seedEmptyManifest(tmp.env);

    let chooseCalled = false;
    const cap = capture();
    const code = await runDoctorState({
      env: tmp.env,
      print: cap.print,
      fix: true,
      yes: true,
      isTTY: false,
      configuredCatalogIds: [],
      color: false, // no catalogCanons → no --remote
      scanners: [scanner(
        untrackedAdoptable({
          nature: 'skill',
          scope: 'user',
          assistant: 'claude',
          path: '/h/.claude/skills/foo',
          candidateId: 'skill:foo',
        }),
      )],
      adapters: new Map([['claude', fakeAdoptingAdapter('claude')]]),
      chooseAdoptionCatalog: async () => {
        chooseCalled = true;
        return 'alpha';
      },
      acquireLock: fakeLock,
    });

    expect(code).toBe(0);
    expect(chooseCalled).toBe(false);
    const persisted = await readManifest(manifestPath);
    expect(findEntry(persisted, 'skill:foo', 'user', 'claude')).toBeDefined();
  });
});
