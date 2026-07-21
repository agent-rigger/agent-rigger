/**
 * lib-nature-t2-edges-persist.test.ts — R5 (lib-nature T2): the install path
 * persists the resolved `requires` edges onto each ManifestEntry, verbatim and
 * opaque, threaded resolver → AdapterEntry → buildManifestEntry.
 *
 * Level: runInstall + real createClaudeAdapter, no remote checkout (guardrail /
 * context content comes from adapter config, not the checkout) — so these tests
 * pin the EDGE-PERSISTENCE mechanism (local resolveWithEdges fallback, pack
 * propagation, replace-not-merge) without a scan/materialise round-trip. The
 * qualified-format + cross-catalogue prune paths live in the e2e sibling file.
 *
 * A lib entry (no targets, S3) is resolved as a dependency but skipped at step
 * 1b (targetsAssistant is false for an empty targets list), so it never reaches
 * the adapter here — its own materialisation is T3. Only the CONSUMER edges are
 * asserted.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readManifest } from '@agent-rigger/core/manifest';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { Scope } from '@agent-rigger/core/types';

import { createClaudeAdapter } from '@agent-rigger/adapters';

import type { CatalogEntry } from '@agent-rigger/catalog';

import { runInstall } from '../src/cmd-install';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENTS_CONTENT = '# Agents\nCanonical AGENTS.md.';
const SCOPE: Scope = 'user';

/** A lib entry: nature 'lib', no targets (S3). Referenced via requires[]. */
function lib(id: string): CatalogEntry {
  return { kind: 'artifact', id, nature: 'lib', targets: [], scopes: ['user'] };
}

const GUARDRAIL = (requires?: string[]): CatalogEntry => ({
  kind: 'artifact',
  id: 'guardrails-claude',
  nature: 'guardrail',
  targets: ['claude'],
  scopes: ['user', 'project'],
  ...(requires ? { requires } : {}),
});

const CONTEXT = (requires?: string[]): CatalogEntry => ({
  kind: 'artifact',
  id: 'context-claude',
  nature: 'context',
  targets: ['claude'],
  scopes: ['user', 'project'],
  ...(requires ? { requires } : {}),
});

let tmpHome: string;
let env: Env;
let manifestPath: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t2-persist-'));
  env = { RIGGER_HOME: tmpHome };
  manifestPath = resolveUserTargets(env).stateJson;
});

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
});

/** Read a manifest entry by id (any scope/assistant). */
async function entryById(id: string): Promise<{ requires?: string[] } | undefined> {
  const manifest = await readManifest(manifestPath);
  return manifest.artifacts.find((e) => e.id === id);
}

// ---------------------------------------------------------------------------
// R5.1 — edge simple persisté (own requires, local resolveWithEdges fallback)
// ---------------------------------------------------------------------------

describe('R5.1 — edge simple persisté sur le consommateur', () => {
  it('le guardrail persiste ses requires propres depuis la résolution locale', async () => {
    const adapter = createClaudeAdapter({
      denyRef: ['Read(./.env)'],
      agentsContent: AGENTS_CONTENT,
    });
    await runInstall({
      catalog: [lib('lib:rules-common'), GUARDRAIL(['lib:rules-common'])],
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude'],
      confirm: true,
    });

    expect((await entryById('guardrails-claude'))?.requires).toEqual(['lib:rules-common']);
  });

  it('un consommateur sans requires persiste un tableau requires vide (convention T8 : undefined = legacy uniquement)', async () => {
    // Convention amendée en review T8 (tech-lead option A): un `requires`
    // ABSENT au manifest doit signifier UNIQUEMENT "jamais résolu depuis ce
    // change" (S6 legacy) — jamais "résolu, zéro dépendance". L'omission
    // d'origine (T2) cassait le backfill S6 pour toute entrée zéro-dép :
    // l'update la re-résolvait mais réécrivait encore `undefined`, donc le
    // finding doctor "entrée sans edges" ne se serait jamais résorbé.
    const adapter = createClaudeAdapter({
      denyRef: ['Read(./.env)'],
      agentsContent: AGENTS_CONTENT,
    });
    await runInstall({
      catalog: [GUARDRAIL()],
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude'],
      confirm: true,
    });

    expect((await entryById('guardrails-claude'))?.requires).toEqual([]);
  });

  it('requiresById (capture pré-prune) prime la résolution locale', async () => {
    const adapter = createClaudeAdapter({
      denyRef: ['Read(./.env)'],
      agentsContent: AGENTS_CONTENT,
    });
    await runInstall({
      catalog: [lib('lib:rules-common'), GUARDRAIL(['lib:rules-common'])],
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude'],
      confirm: true,
      // Simulates remote-install's pre-prune, qualified capture overriding the
      // (post-prune) local resolution.
      requiresById: new Map([['guardrails-claude', ['othercat/lib:pruned']]]),
    });

    expect((await entryById('guardrails-claude'))?.requires).toEqual(['othercat/lib:pruned']);
  });
});

// ---------------------------------------------------------------------------
// R5.3 — requires de pack propagés aux membres, persistés (S4)
// ---------------------------------------------------------------------------

describe('R5.3 — requires de pack propagés aux membres et persistés', () => {
  it("chaque membre du pack persiste l'edge du pack", async () => {
    const packSecu: CatalogEntry = {
      kind: 'pack',
      id: 'pack:secu',
      targets: ['claude'],
      scopes: ['user'],
      members: ['guardrails-claude', 'context-claude'],
      requires: ['lib:rules-common'],
    };
    const adapter = createClaudeAdapter({
      denyRef: ['Read(./.env)'],
      agentsContent: AGENTS_CONTENT,
    });
    await runInstall({
      catalog: [lib('lib:rules-common'), GUARDRAIL(), CONTEXT(), packSecu],
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['pack:secu'],
      confirm: true,
    });

    expect((await entryById('guardrails-claude'))?.requires).toEqual(['lib:rules-common']);
    expect((await entryById('context-claude'))?.requires).toEqual(['lib:rules-common']);
  });

  it("un membre partagé par deux packs aux requires divergents persiste l'union", async () => {
    // pack:a→lib:x, pack:b→lib:y, guardrails-claude ∈ a∩b : l'entrée manifest
    // unique doit porter les DEUX edges (union, pas figée au premier émetteur).
    const packA: CatalogEntry = {
      kind: 'pack',
      id: 'pack:a',
      targets: ['claude'],
      scopes: ['user'],
      members: ['guardrails-claude'],
      requires: ['lib:x'],
    };
    const packB: CatalogEntry = {
      kind: 'pack',
      id: 'pack:b',
      targets: ['claude'],
      scopes: ['user'],
      members: ['guardrails-claude'],
      requires: ['lib:y'],
    };
    const adapter = createClaudeAdapter({
      denyRef: ['Read(./.env)'],
      agentsContent: AGENTS_CONTENT,
    });
    await runInstall({
      catalog: [lib('lib:x'), lib('lib:y'), GUARDRAIL(), packA, packB],
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['pack:a', 'pack:b'],
      confirm: true,
    });

    const req = (await entryById('guardrails-claude'))?.requires ?? [];
    expect([...req].sort()).toEqual(['lib:x', 'lib:y']);
  });

  it("un membre sous un pack partagé par deux parents divergents persiste l'union (nested)", async () => {
    // guardrails-claude ∈ pack:p ; pack:p ∈ pack:a ET pack:b ; a→lib:x, b→lib:y.
    // L'edge divergent doit traverser le pack intermédiaire partagé (round 2).
    const packP: CatalogEntry = {
      kind: 'pack',
      id: 'pack:p',
      targets: ['claude'],
      scopes: ['user'],
      members: ['guardrails-claude'],
    };
    const packA: CatalogEntry = {
      kind: 'pack',
      id: 'pack:a',
      targets: ['claude'],
      scopes: ['user'],
      members: ['pack:p'],
      requires: ['lib:x'],
    };
    const packB: CatalogEntry = {
      kind: 'pack',
      id: 'pack:b',
      targets: ['claude'],
      scopes: ['user'],
      members: ['pack:p'],
      requires: ['lib:y'],
    };
    const adapter = createClaudeAdapter({
      denyRef: ['Read(./.env)'],
      agentsContent: AGENTS_CONTENT,
    });
    await runInstall({
      catalog: [lib('lib:x'), lib('lib:y'), GUARDRAIL(), packP, packA, packB],
      adapter,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['pack:a', 'pack:b'],
      confirm: true,
    });

    const req = (await entryById('guardrails-claude'))?.requires ?? [];
    expect([...req].sort()).toEqual(['lib:x', 'lib:y']);
  });
});

// ---------------------------------------------------------------------------
// R5.5 — ré-install = replace des edges (pas merge)
// ---------------------------------------------------------------------------

describe('R5.5 — ré-install remplace les edges (pas de merge)', () => {
  it('les edges persistés sont ceux de la nouvelle résolution', async () => {
    // Install 1: guardrail requires [lib:a, lib:b].
    const adapter1 = createClaudeAdapter({
      denyRef: ['Read(./.env)'],
      agentsContent: AGENTS_CONTENT,
    });
    await runInstall({
      catalog: [lib('lib:a'), lib('lib:b'), GUARDRAIL(['lib:a', 'lib:b'])],
      adapter: adapter1,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude'],
      confirm: true,
    });
    expect((await entryById('guardrails-claude'))?.requires).toEqual(['lib:a', 'lib:b']);

    // Install 2: denyRef changes (forces a non-empty plan → apply reached) AND
    // the catalog now declares requires [lib:a] only.
    const adapter2 = createClaudeAdapter({
      denyRef: ['Read(./.env)', 'Read(~/.ssh/**)'],
      agentsContent: AGENTS_CONTENT,
    });
    await runInstall({
      catalog: [lib('lib:a'), lib('lib:b'), GUARDRAIL(['lib:a'])],
      adapter: adapter2,
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude'],
      confirm: true,
    });

    // Replace, not merge: lib:b is dropped.
    expect((await entryById('guardrails-claude'))?.requires).toEqual(['lib:a']);
  });
});
