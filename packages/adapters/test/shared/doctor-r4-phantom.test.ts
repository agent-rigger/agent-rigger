/**
 * Tests for the R4 phantom-store scanner (adapters/src/shared/doctor-scan.ts,
 * `createPhantomScanner`, T3).
 *
 * Named scenarios from requirements.md:
 *   - "fantôme de crash (writeManifest→removeDir)" — the hook scriptStore
 *     survives a crash with zero hook manifest entries and no settings.json
 *     command pointing into it.
 *   - "store sans référent connu — cause indéterminable" — a store with no
 *     manifest entry and no enumerable live symlink.
 *   - "référent vif non tracé → pas un fantôme" — a live, untracked symlink
 *     resolving to the store keeps it out of R4 entirely (it is R1's territory).
 *   - "TOCTOU de la destruction" — the CORE primitive the repair interpreter
 *     (T4) will call against `evidence.store` re-verifies at the moment of
 *     acting and refuses once a referent has appeared, independent of the
 *     "probable" verdict this scanner produced.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DoctorContext } from '@agent-rigger/core';
import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply } from '@agent-rigger/core/engine';
import { removeStoreIfUnreferenced } from '@agent-rigger/core/linker';
import { writeManifest } from '@agent-rigger/core/manifest';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { createClaudeAdapter } from '../../src/claude/adapter';
import { createPhantomScanner } from '../../src/shared/doctor-scan';
import { storeReferenceCandidates } from '../../src/shared/store-refs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-doctor-r4-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

function ctxFor(manifestPath: string, env: Env): DoctorContext {
  return { env, manifestPath, configuredCatalogIds: [] };
}

const exists = (p: string): Promise<boolean> => fs.lstat(p).then(() => true).catch(() => false);

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let manifestPath: string;
let fixturesDir: string;

async function setup(): Promise<void> {
  tmp = await makeTmpHome();
  env = tmp.env;
  manifestPath = resolveUserTargets(env).stateJson;
  fixturesDir = path.join(tmp.dir, 'fixtures');
  await fs.mkdir(fixturesDir, { recursive: true });
}

async function teardown(): Promise<void> {
  await tmp.cleanup();
}

// ---------------------------------------------------------------------------
// fantôme de crash (writeManifest→removeDir) — scriptStore hooks
// ---------------------------------------------------------------------------

describe('doctor-R4: fantôme de crash (scriptStore hooks)', () => {
  it('doctor-R4: a scriptStore with no hook entries and no settings.json reference is phantom', async () => {
    await setup();
    try {
      const scriptSourceDir = path.join(fixturesDir, 'scripts');
      await fs.mkdir(scriptSourceDir, { recursive: true });
      await fs.writeFile(path.join(scriptSourceDir, 'guard.ts'), 'export {};');

      const hooksStore = path.join(path.dirname(resolveUserTargets(env).skillsDir), 'hooks');
      const adapter = createClaudeAdapter({
        denyRef: [],
        hookSpec: () => ({
          event: 'PreToolUse',
          matcher: 'Bash',
          command: `bun run ${hooksStore}/guard.ts`,
          scriptSource: scriptSourceDir,
          scriptStore: hooksStore,
        }),
      });
      const entry: AdapterEntry = { id: 'hook:guard', nature: 'hook', scope: 'user' };
      await apply(adapter, [entry], 'user', env, manifestPath);

      // Simulate the crash: the hook entry is purged from the manifest and its
      // settings.json registration is gone too — only the shared scriptStore
      // directory survives on disk (S1/D2's "orphelin permanent").
      await writeManifest(manifestPath, { version: 1, artifacts: [] });
      await fs.writeFile(resolveUserTargets(env).claudeSettings, JSON.stringify({}));

      const findings = await createPhantomScanner()(ctxFor(manifestPath, env));

      const phantomFindings = findings.filter((f) => f.class === 'phantom');
      expect(phantomFindings).toHaveLength(1);
      const finding = phantomFindings[0]!;
      if (finding.class !== 'phantom') throw new Error('unreachable');
      expect(finding.evidence.store).toBe(hooksStore);
      expect(finding.repair.kind).toBe('remove-store');
      expect(finding.repair.consent).toBe('item-confirm');
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// store sans référent connu — cause indéterminable
// ---------------------------------------------------------------------------

describe('doctor-R4: store sans référent connu — cause indéterminable', () => {
  it('doctor-R4: a skill store with no manifest entry and no live symlink is phantom probable', async () => {
    await setup();
    try {
      const orphanStore = path.join(resolveUserTargets(env).skillsDir, 'orphan');
      await fs.mkdir(orphanStore, { recursive: true });
      await fs.writeFile(path.join(orphanStore, 'SKILL.md'), '# orphan');

      const findings = await createPhantomScanner()(ctxFor(manifestPath, env));

      const phantomFindings = findings.filter((f) => f.class === 'phantom');
      expect(phantomFindings).toHaveLength(1);
      const finding = phantomFindings[0]!;
      if (finding.class !== 'phantom') throw new Error('unreachable');
      expect(finding.evidence.store).toBe(orphanStore);
      expect(finding.summary).toContain('probable ghost');
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// référent vif non tracé → pas un fantôme
// ---------------------------------------------------------------------------

describe('doctor-R4: référent vif non tracé → pas un fantôme', () => {
  it('doctor-R4: a store with a live untracked symlink is never reported phantom', async () => {
    await setup();
    try {
      const store = path.join(resolveUserTargets(env).skillsDir, 'foo');
      await fs.mkdir(store, { recursive: true });
      await fs.writeFile(path.join(store, 'SKILL.md'), '# foo');

      const skillsTargetDir = path.join(
        path.dirname(resolveUserTargets(env).claudeSettings),
        'skills',
      );
      await fs.mkdir(skillsTargetDir, { recursive: true });
      await fs.symlink(store, path.join(skillsTargetDir, 'foo'));
      // No manifest entry — this store's only referent is untracked.

      const findings = await createPhantomScanner()(ctxFor(manifestPath, env));

      expect(findings.filter((f) => f.class === 'phantom')).toHaveLength(0);
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// store désigné par une entrée manifest vive dont le symlink a été supprimé
// (post-review fix: referent (1) — "ni entrée manifest dont le store dérivé
// le désigne" — was never checked for named stores; only the symlink-based
// referent (2) was. A store whose live entry's target symlink is removed out
// of band was wrongly flagged phantom AND removed under --fix consent.)
// ---------------------------------------------------------------------------

describe('doctor-R4: store désigné par une entrée manifest vive → jamais fantôme, même symlink supprimé', () => {
  it('doctor-R4: a normally-installed skill whose target symlink is removed out-of-band keeps its store non-phantom', async () => {
    await setup();
    try {
      const skillSource = path.join(fixturesDir, 'foo');
      await fs.mkdir(skillSource, { recursive: true });
      await fs.writeFile(path.join(skillSource, 'SKILL.md'), '# foo');

      const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => skillSource });
      const entry: AdapterEntry = { id: 'skill:foo', nature: 'skill', scope: 'user' };
      await apply(adapter, [entry], 'user', env, manifestPath);

      const store = path.join(resolveUserTargets(env).skillsDir, 'foo');
      const target = path.join(
        path.dirname(resolveUserTargets(env).claudeSettings),
        'skills',
        'foo',
      );
      expect(await exists(store)).toBe(true);
      expect(await exists(target)).toBe(true);

      // Out-of-band: the user deletes the SYMLINK only — the store (and the
      // manifest entry that still designates it) survive untouched.
      await fs.rm(target, { recursive: true, force: true });
      expect(await exists(target)).toBe(false);
      expect(await exists(store)).toBe(true);

      const findings = await createPhantomScanner()(ctxFor(manifestPath, env));

      const phantomOnStore = findings.filter(
        (f) => f.class === 'phantom' && f.evidence.store === store,
      );
      expect(phantomOnStore).toHaveLength(0);
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// refcount élargi R4 — référent visible UNIQUEMENT via files[] d'une autre
// entrée manifest (Low3 falsifying test: mutating storeReferenceCandidates'
// call to drop `manifestFiles` turns this test red)
// ---------------------------------------------------------------------------

describe("doctor-R4: store référencé UNIQUEMENT via files[] d'une autre entrée manifest (widening)", () => {
  it("doctor-R4: no live symlink in this cwd's own families, but a live symlink recorded by an UNRELATED-nature manifest entry keeps the store non-phantom", async () => {
    await setup();
    try {
      const store = path.join(resolveUserTargets(env).skillsDir, 'foo');
      await fs.mkdir(store, { recursive: true });
      await fs.writeFile(path.join(store, 'SKILL.md'), '# foo');

      // A live symlink at ANOTHER project's skills dir — NOT process.cwd()'s own
      // project scope, so it is invisible to `linkFamiliesFor`/`allLinkFamilies`
      // (they only enumerate the CURRENT cwd's project targetDir).
      const otherProjectSkills = path.join(fixturesDir, 'other-project', '.claude', 'skills');
      await fs.mkdir(otherProjectSkills, { recursive: true });
      const otherProjectTarget = path.join(otherProjectSkills, 'foo');
      await fs.symlink(store, otherProjectTarget);

      // A manifest entry of a DIFFERENT nature ('agent', not 'skill') records
      // that exact path. `isDesignatedByManifestEntry` (referent 1) filters by
      // `entry.nature === nature` — it does NOT see this entry for the 'skill'
      // store under test. Only `allManifestFiles` unioned into
      // `storeReferenceCandidates` (referent 2's widening, regardless of
      // nature) can save this store from being flagged phantom.
      await writeManifest(manifestPath, {
        version: 1,
        artifacts: [{
          id: 'other/agent:unrelated',
          nature: 'agent',
          ref: 'v1.0.0',
          sha: 'deadbeef',
          scope: 'project',
          installedAt: new Date(0).toISOString(),
          files: [otherProjectTarget],
          assistant: 'claude',
        }],
      });

      const findings = await createPhantomScanner()(ctxFor(manifestPath, env));

      const phantomOnStore = findings.filter(
        (f) => f.class === 'phantom' && f.evidence.store === store,
      );
      expect(phantomOnStore).toHaveLength(0);
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// TOCTOU de la destruction
// ---------------------------------------------------------------------------

describe('doctor-R4: TOCTOU de la destruction', () => {
  it('doctor-R4: a referent appearing after diagnosis makes the act-time re-check refuse', async () => {
    await setup();
    try {
      const orphanStore = path.join(resolveUserTargets(env).skillsDir, 'orphan');
      await fs.mkdir(orphanStore, { recursive: true });
      await fs.writeFile(path.join(orphanStore, 'SKILL.md'), '# orphan');

      const findings = await createPhantomScanner()(ctxFor(manifestPath, env));
      const phantomFindings = findings.filter((f) => f.class === 'phantom');
      expect(phantomFindings).toHaveLength(1);
      const finding = phantomFindings[0]!;
      if (finding.class !== 'phantom') throw new Error('unreachable');

      // A referent appears BETWEEN diagnosis and the (not-yet-run) fix.
      const skillsTargetDir = path.join(
        path.dirname(resolveUserTargets(env).claudeSettings),
        'skills',
      );
      await fs.mkdir(skillsTargetDir, { recursive: true });
      await fs.symlink(finding.evidence.store, path.join(skillsTargetDir, 'orphan'));

      // The repair interpreter (T4) will recompute candidates and call this
      // SAME core primitive at the moment of acting — it must refuse now.
      const actTimeCandidates = storeReferenceCandidates(
        finding.evidence.store,
        env,
        process.cwd(),
      );
      const removed = await removeStoreIfUnreferenced(finding.evidence.store, actTimeCandidates);

      expect(removed).toBe(false);
      expect(await fs.lstat(finding.evidence.store).then(() => true).catch(() => false)).toBe(
        true,
      );
    } finally {
      await teardown();
    }
  });
});
