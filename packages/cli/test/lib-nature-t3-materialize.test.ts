/**
 * lib-nature-t3-materialize.test.ts — R3 (lib-nature T3): the CLI install path
 * partitions libs OUT of the adapter loop (S3), materialises them through the
 * engine's parallel channel (apply({ libs })), surfaces the materialisation in
 * the plan before consent (R3.2), refuses an EXPLICIT lib install (S7), and pins
 * the materialiser source to the scanned path (R2).
 *
 * Level: runInstall + real createClaudeAdapter (consumer content from adapter
 * config) with opts.libs supplied by hand — the same channel runRemoteInstall
 * feeds in production. The cross-assistant single-entry / rollback / idempotence
 * scenarios are pinned at the engine level (engine.lib-materialize.test.ts);
 * here we pin the CLI wiring around them.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createClaudeAdapter } from '@agent-rigger/adapters';
import type { ArtifactEntry, CatalogEntry } from '@agent-rigger/catalog';
import { readManifest } from '@agent-rigger/core/manifest';
import { libsDir, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { LibMaterialization, Scope } from '@agent-rigger/core/types';

import { ExplicitLibInstallError, runInstall } from '../src/cmd-install';
import { buildLibMaterializations } from '../src/remote-install';
import { scanPathFor } from '../src/scan-paths';

const AGENTS_CONTENT = '# Agents\nCanonical AGENTS.md.';
const SCOPE: Scope = 'user';

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

let tmpHome: string;
let env: Env;
let manifestPath: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t3-mat-'));
  env = { RIGGER_HOME: tmpHome };
  manifestPath = resolveUserTargets(env).stateJson;
});

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
});

function claudeAdapter() {
  return createClaudeAdapter({ denyRef: ['Read(./.env)'], agentsContent: AGENTS_CONTENT });
}

/** Create a checkout-side lib source dir; return its path. */
async function makeLibSource(name: string, content: string): Promise<string> {
  const dir = path.join(tmpHome, 'checkout', 'common', 'libs', name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'index.ts'), content);
  return dir;
}

async function dirExists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true).catch(() => false);
}

// ---------------------------------------------------------------------------
// R2 pin — LibMaterialization.source === scanPathFor('lib')[0]
// ---------------------------------------------------------------------------

describe('R2 pin — materialiser source is the scanned path', () => {
  it('buildLibMaterializations source equals scanPathFor(lib)[0]', () => {
    const baseDir = '/checkout';
    const libEntry: ArtifactEntry = {
      kind: 'artifact',
      id: 'jr/lib:rules-common',
      nature: 'lib',
      targets: [],
      scopes: ['user'],
    };
    const requiresById = new Map<string, string[]>([['jr/lib:rules-common', []]]);

    const mats = buildLibMaterializations([libEntry], baseDir, requiresById);
    const gate = scanPathFor(libEntry, baseDir);

    expect(mats).toHaveLength(1);
    expect(gate).toHaveLength(1);
    // The octet materialised IS the octet scanned (R2) — this equality is the
    // pin: a drift here would run unscanned bytes by import.
    expect(mats[0]!.source).toBe(gate[0]!);
    expect(path.resolve(mats[0]!.source)).toBe(path.resolve(gate[0]!));
    expect(mats[0]!.name).toBe('rules-common');
    expect(mats[0]!.requires).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// S7 — install lib:<name> explicite refusé
// ---------------------------------------------------------------------------

describe('S7 install-explicite-refusé — a lib is never installed directly', () => {
  it('rejects a bare lib id with an actionable error', async () => {
    await expect(
      runInstall({
        catalog: [lib('lib:rules-common')],
        adapter: claudeAdapter(),
        scope: SCOPE,
        env,
        manifestPath,
        selectedIds: ['lib:rules-common'],
        confirm: true,
      }),
    ).rejects.toBeInstanceOf(ExplicitLibInstallError);
  });

  it('rejects a qualified lib id too, and materialises nothing', async () => {
    await expect(
      runInstall({
        catalog: [lib('lib:rules-common')],
        adapter: claudeAdapter(),
        scope: SCOPE,
        env,
        manifestPath,
        selectedIds: ['jr/lib:rules-common'],
        confirm: true,
      }),
    ).rejects.toThrow(/installed through the artifacts that require it/);

    // Fail-closed before any resolution/materialisation.
    expect(await dirExists(libsDir(env))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// S3 jamais-adapter — no parasitic [skipped] line for a lib
// ---------------------------------------------------------------------------

describe('S3 jamais-adapter — a lib never reaches step 1b', () => {
  it('a lib pulled by a consumer is not reported [skipped]', async () => {
    const result = await runInstall({
      catalog: [lib('lib:rules-common'), GUARDRAIL(['lib:rules-common'])],
      adapter: claudeAdapter(),
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude'],
      confirm: true,
    });

    // The lib is partitioned out of target routing — never a skipped entry.
    expect(result.skipped).toEqual([]);
    expect(result.output).not.toContain('[skipped]');
    // The consumer installed and carries its edge.
    const manifest = await readManifest(manifestPath);
    expect(manifest.artifacts.find((a) => a.id === 'guardrails-claude')?.requires).toEqual([
      'lib:rules-common',
    ]);
  });
});

// ---------------------------------------------------------------------------
// R3.2 plan-avant-consentement — the materialisation is in the plan
// ---------------------------------------------------------------------------

describe('R3.2 plan-avant-consentement — lib line shown before consent', () => {
  it('the confirm plan names the lib materialisation', async () => {
    let captured = '';
    const source = await makeLibSource('rules-common', 'export const x = 1;\n');
    const libMat: LibMaterialization = {
      id: 'jr/lib:rules-common',
      name: 'rules-common',
      source,
      requires: [],
    };

    await runInstall({
      catalog: [lib('lib:rules-common'), GUARDRAIL(['lib:rules-common'])],
      adapter: claudeAdapter(),
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude'],
      // Capture the plan then decline — the lib line must be visible ahead of
      // any write.
      confirm: async (planText) => {
        captured = planText;
        return false;
      },
      libs: [libMat],
    });

    expect(captured).toContain('lib rules-common →');
    expect(captured).toContain(path.join(libsDir(env), 'rules-common'));
    // Declined → nothing materialised.
    expect(await dirExists(path.join(libsDir(env), 'rules-common'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CLI wiring — materialisation lands on disk with the 'shared' singleton entry
// ---------------------------------------------------------------------------

describe('R3 CLI wiring — runInstall materialises the lib via the engine channel', () => {
  it('poses the lib under libsDir with a (user, shared) manifest entry', async () => {
    const source = await makeLibSource('rules-common', 'export const rule = 1;\n');
    const libMat: LibMaterialization = {
      id: 'jr/lib:rules-common',
      name: 'rules-common',
      source,
      requires: [],
    };

    const result = await runInstall({
      catalog: [lib('lib:rules-common'), GUARDRAIL(['lib:rules-common'])],
      adapter: claudeAdapter(),
      scope: SCOPE,
      env,
      manifestPath,
      selectedIds: ['guardrails-claude'],
      confirm: true,
      libs: [libMat],
    });

    // The lib landed on disk.
    const dest = path.join(libsDir(env), 'rules-common');
    expect(await dirExists(dest)).toBe(true);
    expect(await fs.readFile(path.join(dest, 'index.ts'), 'utf8')).toBe('export const rule = 1;\n');

    // Its manifest entry is the global singleton (id, 'user', 'shared').
    const manifest = await readManifest(manifestPath);
    const libEntry = manifest.artifacts.find((a) => a.id === 'jr/lib:rules-common');
    expect(libEntry).toBeDefined();
    expect(libEntry!.nature).toBe('lib');
    expect(libEntry!.scope).toBe('user');
    expect(libEntry!.assistant).toBe('shared');
    expect(libEntry!.files).toEqual([dest]);
    expect(libEntry!.requires).toEqual([]);

    // The consumer installed alongside, and the plan named the materialisation.
    expect(result.applied).toBe(true);
    expect(result.output).toContain('lib rules-common →');
  });
});
