/**
 * Tests for the R1 untracked scanner (adapters/src/shared/doctor-scan.ts,
 * `createUntrackedScanner`, T3).
 *
 * Named scenarios from requirements.md:
 *   - "cible conforme non tracée → adoptable"
 *   - "amputation de masse — même route" (no special-casing)
 *   - "cible driftée non tracée → report-only"
 *   - "dossier utilisateur homonyme → jamais flaggé"
 *   - "exclusions absolues du scan" (.bak- and .tmp- siblings)
 *   - "natures sans signature disque — différentiel catalogue offline" (this
 *     catalog-free scanner never reports guardrail/context/mcp/hook natures)
 *
 * Fixtures are built via the REAL engine (`apply`, `@agent-rigger/core/engine`)
 * so store+symlink shape matches production exactly; "untracked" is then
 * reproduced the same way the requirements describe it (a manifest that lost
 * the entry) by overwriting state.json to an empty manifest afterwards.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DoctorContext } from '@agent-rigger/core';
import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply } from '@agent-rigger/core/engine';
import { writeManifest } from '@agent-rigger/core/manifest';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { createClaudeAdapter } from '../../src/claude/adapter';
import { createOpencodeAdapter } from '../../src/opencode/adapter';
import { createUntrackedScanner } from '../../src/shared/doctor-scan';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-doctor-r1-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

async function makeSkillFixture(baseDir: string, name: string): Promise<string> {
  const skillDir = path.join(baseDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `# ${name}\nFixture skill.`);
  return skillDir;
}

/** Wipe the manifest to an empty one — simulates the pre-M2 amputation R1 targets. */
async function wipeManifest(manifestPath: string): Promise<void> {
  await writeManifest(manifestPath, { version: 1, artifacts: [] });
}

function ctxFor(manifestPath: string, env: Env): DoctorContext {
  return { env, manifestPath, configuredCatalogIds: [] };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
// cible conforme non tracée → adoptable
// ---------------------------------------------------------------------------

describe('doctor-R1: cible conforme non tracée → adoptable', () => {
  it('doctor-R1: an installed-but-unmanifested skill is reported untracked/adoptable', async () => {
    await setup();
    try {
      const src = await makeSkillFixture(fixturesDir, 'foo');
      const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => src });
      const entry: AdapterEntry = { id: 'skill:foo', nature: 'skill', scope: 'user' };

      await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });
      await wipeManifest(manifestPath);

      const scanner = createUntrackedScanner(adapter, 'claude');
      const findings = await scanner(ctxFor(manifestPath, env));

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.class).toBe('untracked');
      if (finding.class !== 'untracked') throw new Error('unreachable');
      expect(finding.verdict).toBe('adoptable');
      if (finding.verdict !== 'adoptable') throw new Error('unreachable');
      expect(finding.nature).toBe('skill');
      expect(finding.assistant).toBe('claude');
      expect(finding.scope).toBe('user');
      expect(finding.repair.kind).toBe('adopt');
      expect(finding.repair.consent).toBe('safe');
    } finally {
      await teardown();
    }
  });

  it('doctor-R1: an installed-but-unmanifested claude agent is reported untracked/adoptable', async () => {
    await setup();
    try {
      const agentFile = path.join(fixturesDir, 'reviewer.md');
      await fs.writeFile(agentFile, '# Agent: reviewer\nFixture agent.');
      const adapter = createClaudeAdapter({ denyRef: [], agentSource: () => agentFile });
      const entry: AdapterEntry = { id: 'agent:reviewer', nature: 'agent', scope: 'user' };

      await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });
      await wipeManifest(manifestPath);

      const findings = await createUntrackedScanner(adapter, 'claude')(ctxFor(manifestPath, env));

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.class).toBe('untracked');
      if (finding.class !== 'untracked') throw new Error('unreachable');
      expect(finding.nature).toBe('agent');
      expect(finding.verdict).toBe('adoptable');
    } finally {
      await teardown();
    }
  });

  it('doctor-R1: an installed-but-unmanifested opencode plugin is reported untracked/adoptable', async () => {
    await setup();
    try {
      const pluginFile = path.join(fixturesDir, 'myplugin.ts');
      await fs.writeFile(pluginFile, 'export default {};');
      const adapter = createOpencodeAdapter({ pluginSource: () => pluginFile });
      const entry: AdapterEntry = { id: 'plugin:myplugin', nature: 'plugin', scope: 'user' };

      await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });
      await wipeManifest(manifestPath);

      const findings = await createUntrackedScanner(adapter, 'opencode')(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.class).toBe('untracked');
      if (finding.class !== 'untracked') throw new Error('unreachable');
      expect(finding.nature).toBe('plugin');
      expect(finding.assistant).toBe('opencode');
      expect(finding.verdict).toBe('adoptable');
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// amputation de masse — même route
// ---------------------------------------------------------------------------

describe('doctor-R1: amputation de masse — même route', () => {
  it('doctor-R1: several untracked-but-conforming skills all route to the same finding shape', async () => {
    await setup();
    try {
      const srcFoo = await makeSkillFixture(fixturesDir, 'foo');
      const srcBar = await makeSkillFixture(fixturesDir, 'bar');
      const adapter = createClaudeAdapter({
        denyRef: [],
        skillSource: (entry) => (entry.id.includes('foo') ? srcFoo : srcBar),
      });
      const fooEntry: AdapterEntry = { id: 'skill:foo', nature: 'skill', scope: 'user' };
      const barEntry: AdapterEntry = { id: 'skill:bar', nature: 'skill', scope: 'user' };

      await apply({ adapter, entries: [fooEntry, barEntry], scope: 'user', env, manifestPath });
      await wipeManifest(manifestPath);

      const findings = await createUntrackedScanner(adapter, 'claude')(ctxFor(manifestPath, env));

      expect(findings).toHaveLength(2);
      for (const finding of findings) {
        expect(finding.class).toBe('untracked');
        if (finding.class !== 'untracked') throw new Error('unreachable');
        expect(finding.verdict).toBe('adoptable');
      }
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// cible driftée non tracée → report-only
// ---------------------------------------------------------------------------

describe('doctor-R1: cible driftée non tracée → report-only', () => {
  it('doctor-R1: an untracked target diverging from its store is drift, never adoptable, no repair', async () => {
    await setup();
    try {
      const src = await makeSkillFixture(fixturesDir, 'foo');
      const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => src });
      const entry: AdapterEntry = { id: 'skill:foo', nature: 'skill', scope: 'user' };

      await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });
      await wipeManifest(manifestPath);

      // Replace the symlink with a REAL directory of foreign content — the
      // store still exists (signature present) but the target no longer
      // resolves to / match it.
      const targetPath = path.join(
        path.dirname(resolveUserTargets(env).claudeSettings),
        'skills',
        'foo',
      );
      await fs.rm(targetPath, { recursive: true, force: true });
      await fs.mkdir(targetPath, { recursive: true });
      await fs.writeFile(path.join(targetPath, 'SKILL.md'), 'hand-edited, foreign content');

      const findings = await createUntrackedScanner(adapter, 'claude')(ctxFor(manifestPath, env));

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.class).toBe('untracked');
      if (finding.class !== 'untracked') throw new Error('unreachable');
      expect(finding.verdict).toBe('drift');
      expect('repair' in finding).toBe(false);
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// dossier utilisateur homonyme → jamais flaggé
// ---------------------------------------------------------------------------

describe('doctor-R1: dossier utilisateur homonyme → jamais flaggé', () => {
  it('doctor-R1: a hand-made directory with no store never produces a finding', async () => {
    await setup();
    try {
      const adapter = createClaudeAdapter({ denyRef: [] });
      const skillsDir = path.join(
        path.dirname(resolveUserTargets(env).claudeSettings),
        'skills',
      );
      await fs.mkdir(path.join(skillsDir, 'my-notes'), { recursive: true });
      await fs.writeFile(path.join(skillsDir, 'my-notes', 'README.md'), 'personal notes');

      const findings = await createUntrackedScanner(adapter, 'claude')(ctxFor(manifestPath, env));

      expect(findings).toHaveLength(0);
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// exclusions absolues du scan
// ---------------------------------------------------------------------------

describe('doctor-R1: exclusions absolues du scan', () => {
  it('doctor-R1: .bak-* and .tmp-* siblings are never classified as untracked artifacts', async () => {
    await setup();
    try {
      const src = await makeSkillFixture(fixturesDir, 'foo');
      const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => src });
      const entry: AdapterEntry = { id: 'skill:foo', nature: 'skill', scope: 'user' };

      await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });
      await wipeManifest(manifestPath);

      const skillsDir = path.join(
        path.dirname(resolveUserTargets(env).claudeSettings),
        'skills',
      );
      // A .bak-* sibling that even carries a MATCHING store — still excluded.
      const bakName = 'foo.bak-2026-01-01T00-00-00.000Z-abcd1234';
      await fs.mkdir(path.join(skillsDir, bakName), { recursive: true });
      await fs.cp(
        path.join(resolveUserTargets(env).skillsDir, 'foo'),
        path.join(skillsDir, bakName),
        {
          recursive: true,
        },
      );
      const tmpName = 'foo.tmp-deadbeef';
      await fs.mkdir(path.join(skillsDir, tmpName), { recursive: true });

      const findings = await createUntrackedScanner(adapter, 'claude')(ctxFor(manifestPath, env));

      // Only the real, legitimate "foo" entry is reported — never the bak/tmp siblings.
      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.class).toBe('untracked');
      if (finding.class !== 'untracked') throw new Error('unreachable');
      expect(finding.verdict).toBe('adoptable');
      if (finding.verdict !== 'adoptable') throw new Error('unreachable');
      expect(finding.path).toBe(path.join(skillsDir, 'foo'));
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// natures sans signature disque — différentiel catalogue offline
// ---------------------------------------------------------------------------

describe('doctor-R1: natures sans signature disque — différentiel catalogue offline', () => {
  it('doctor-R1: a catalog-free scan never reports guardrail or context natures', async () => {
    await setup();
    try {
      const adapter = createClaudeAdapter({ denyRef: [] });
      const settingsPath = resolveUserTargets(env).claudeSettings;
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(
        settingsPath,
        JSON.stringify({ permissions: { deny: ['Bash(rm -rf /)'] } }),
      );
      const claudeMdPath = resolveUserTargets(env).claudeMd;
      await fs.writeFile(
        claudeMdPath,
        '<!-- BEGIN agent-rigger (managed — do not edit) -->\n'
          + '@~/.claude/harness/AGENTS.md\n'
          + '<!-- END agent-rigger -->\n',
      );

      const findings = await createUntrackedScanner(adapter, 'claude')(ctxFor(manifestPath, env));

      expect(findings.some((f) => f.class === 'untracked' && f.nature === 'guardrail')).toBe(
        false,
      );
      expect(findings.some((f) => f.class === 'untracked' && f.nature === 'context')).toBe(false);
    } finally {
      await teardown();
    }
  });
});
