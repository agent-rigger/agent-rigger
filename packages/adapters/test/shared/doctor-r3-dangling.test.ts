/**
 * Tests for the R3 dangling-symlink scanner (adapters/src/shared/doctor-scan.ts,
 * `createDanglingScanner`, T3).
 *
 * Named scenarios from requirements.md:
 *   - "pendant tracké" — a manifest entry's files[] contains a dead symlink.
 *   - "pendant non tracké" — a dead symlink with no manifest entry.
 *   - "pendant hors racines rigger → intouchable" — never even looked at.
 *
 * Fixtures use the REAL engine (`apply`) to install a skill, then delete only
 * the STORE (leaving the symlink dangling) — reproducing the "store deleted"
 * scenario the requirements describe verbatim.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DoctorContext } from '@agent-rigger/core';
import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply } from '@agent-rigger/core/engine';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { createClaudeAdapter } from '../../src/claude/adapter';
import { createDanglingScanner } from '../../src/shared/doctor-scan';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-doctor-r3-'): Promise<{
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

function ctxFor(manifestPath: string, env: Env): DoctorContext {
  return { env, manifestPath, configuredCatalogIds: [] };
}

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
// pendant tracké
// ---------------------------------------------------------------------------

describe('doctor-R3: pendant tracké', () => {
  it('doctor-R3: a manifest-tracked symlink whose store vanished is reported dangling/tracked', async () => {
    await setup();
    try {
      const src = await makeSkillFixture(fixturesDir, 'foo');
      const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => src });
      const entry: AdapterEntry = { id: 'skill:foo', nature: 'skill', scope: 'user' };

      await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });

      // Delete only the STORE — the symlink remains, now dangling.
      await fs.rm(path.join(resolveUserTargets(env).skillsDir, 'foo'), {
        recursive: true,
        force: true,
      });

      const findings = await createDanglingScanner()(ctxFor(manifestPath, env));

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.class).toBe('dangling');
      if (finding.class !== 'dangling') throw new Error('unreachable');
      expect(finding.tracked).toBe(true);
      if (!finding.tracked) throw new Error('unreachable');
      expect(finding.entryId).toBe('skill:foo');
      expect('repair' in finding).toBe(false);
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// pendant non tracké
// ---------------------------------------------------------------------------

describe('doctor-R3: pendant non tracké', () => {
  it('doctor-R3: an untracked dangling symlink is removable with item-confirm', async () => {
    await setup();
    try {
      const src = await makeSkillFixture(fixturesDir, 'foo');
      const adapter = createClaudeAdapter({ denyRef: [], skillSource: () => src });
      const entry: AdapterEntry = { id: 'skill:foo', nature: 'skill', scope: 'user' };

      await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });
      await fs.rm(path.join(resolveUserTargets(env).skillsDir, 'foo'), {
        recursive: true,
        force: true,
      });
      // Strip the manifest entry too — this dangling link is now untracked.
      const { writeManifest } = await import('@agent-rigger/core/manifest');
      await writeManifest(manifestPath, { version: 1, artifacts: [] });

      const findings = await createDanglingScanner()(ctxFor(manifestPath, env));

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.class).toBe('dangling');
      if (finding.class !== 'dangling') throw new Error('unreachable');
      expect(finding.tracked).toBe(false);
      if (finding.tracked) throw new Error('unreachable');
      expect(finding.repair.kind).toBe('unlink-dangling');
      expect(finding.repair.consent).toBe('item-confirm');
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// pendant hors racines rigger → intouchable
// ---------------------------------------------------------------------------

describe('doctor-R3: pendant hors racines rigger → intouchable', () => {
  it('doctor-R3: a dangling symlink outside every rigger root is never reported', async () => {
    await setup();
    try {
      // A dangling symlink living in a directory the scanner never enumerates
      // (not one of the claude/opencode skill/agent/plugin family roots).
      const outsideDir = path.join(tmp.dir, 'not-a-rigger-root');
      await fs.mkdir(outsideDir, { recursive: true });
      const deadTarget = path.join(outsideDir, 'gone-target');
      await fs.symlink(deadTarget, path.join(outsideDir, 'dangling-link'));

      const findings = await createDanglingScanner()(ctxFor(manifestPath, env));

      expect(findings).toHaveLength(0);
    } finally {
      await teardown();
    }
  });
});
