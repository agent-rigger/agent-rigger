/**
 * Tests for the T8 additions to adapters/src/shared/doctor-scan.ts:
 *   - `libs/` joins the R4 phantom scanner's named-store roots.
 *   - `libsDir(env)` joins the R7 hygiene scanner's scan dirs.
 *
 * Named scenarios from requirements.md / tasks.md T8:
 *   - R7.2 "orpheline détectée par doctor" (disk half) — a `libs/<name>` dir
 *     on disk with NO manifest entry designating it is phantom-probable, the
 *     same crash-orphan shape as skill/agent/plugin. The GRAPH half (an
 *     installed lib entry no remaining entry requires) is a DIFFERENT,
 *     distinct finding — see core's lib-nature-t8-edge-integrity.test.ts.
 *   - "container libs/ vide conforme à la convention existante" — an empty
 *     (or absent) libs/ root produces zero phantom findings, same as an
 *     empty skills/agents/plugins root.
 *   - ".bak récent → intouchable par défaut" / "aged past retention" inside
 *     libs/ — same R7 retention policy the other named stores already get.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DoctorContext } from '@agent-rigger/core';
import { apply } from '@agent-rigger/core/engine';
import { libsDir, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { createClaudeAdapter } from '../../src/claude/adapter';
import { createHygieneScanner, createPhantomScanner } from '../../src/shared/doctor-scan';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-doctor-t8-'): Promise<{
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

function toFsSafeIso(date: Date): string {
  return date.toISOString().replace(/:/g, '-');
}

const FAR_FUTURE = () => Date.now() + 30 * 24 * 60 * 60 * 1000; // +30 days: anything real is "aged".

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
// R7.2 (disk half) — libs/<name> orphelin de crash
// ---------------------------------------------------------------------------

describe('doctor-T8: libs/ rejoint les racines du phantom scanner', () => {
  it('doctor-T8: a libs/<name> dir with no manifest entry designating it is phantom-probable', async () => {
    await setup();
    try {
      const orphanLibStore = path.join(libsDir(env), 'orphan-lib');
      await fs.mkdir(orphanLibStore, { recursive: true });
      await fs.writeFile(path.join(orphanLibStore, 'rules.ts'), 'export const rule = 1;\n');

      const findings = await createPhantomScanner()(ctxFor(manifestPath, env));

      const phantomFindings = findings.filter(
        (f) => f.class === 'phantom' && f.evidence.store === orphanLibStore,
      );
      expect(phantomFindings).toHaveLength(1);
      const finding = phantomFindings[0]!;
      if (finding.class !== 'phantom') throw new Error('unreachable');
      expect(finding.repair.kind).toBe('remove-store');
      expect(finding.repair.consent).toBe('item-confirm');
    } finally {
      await teardown();
    }
  });

  it('doctor-T8: a lib installed via the REAL engine (manifest entry designates the store) is never phantom', async () => {
    await setup();
    try {
      const librarySource = path.join(fixturesDir, 'rules-common');
      await fs.mkdir(librarySource, { recursive: true });
      await fs.writeFile(path.join(librarySource, 'rules.ts'), 'export const rule = 1;\n');

      await apply({
        adapter: createClaudeAdapter({ denyRef: [] }),
        entries: [],
        scope: 'user',
        env,
        manifestPath,
        libs: [
          { id: 'jr/lib:rules-common', name: 'rules-common', source: librarySource, requires: [] },
        ],
      });

      const dest = path.join(libsDir(env), 'rules-common');
      expect(await fs.stat(dest).then(() => true).catch(() => false)).toBe(true);

      const findings = await createPhantomScanner()(ctxFor(manifestPath, env));

      expect(findings.filter((f) => f.class === 'phantom' && f.evidence.store === dest))
        .toHaveLength(0);
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// container libs/ vide conforme à la convention existante
// ---------------------------------------------------------------------------

describe('doctor-T8: container libs/ vide conforme à la convention existante', () => {
  it('doctor-T8: an empty libs/ root (post-retrait du dernier lib) produces zero lib phantom findings', async () => {
    await setup();
    try {
      // The root persists (mkdir'd) but is empty — same convention as an
      // empty skills/agents/plugins root: readdir returns [], nothing to flag.
      await fs.mkdir(libsDir(env), { recursive: true });

      const findings = await createPhantomScanner()(ctxFor(manifestPath, env));
      expect(findings.filter((f) => f.class === 'phantom')).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it('doctor-T8: an ABSENT libs/ root (never materialised) never crashes the scanner', async () => {
    await setup();
    try {
      // libsDir(env) never created at all.
      const findings = await createPhantomScanner()(ctxFor(manifestPath, env));
      expect(findings.filter((f) => f.class === 'phantom')).toHaveLength(0);
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// hygiène — .bak-* siblings à l'intérieur de libs/
// ---------------------------------------------------------------------------

describe("doctor-T8: hygiène des .bak-* à l'intérieur de libs/", () => {
  it('doctor-T8: a RECENT .bak-* sibling inside libs/ is never surfaced (intouchable par défaut)', async () => {
    await setup();
    try {
      const libsRoot = libsDir(env);
      await fs.mkdir(libsRoot, { recursive: true });
      const bakPath = path.join(libsRoot, `rules-common.bak-${toFsSafeIso(new Date())}-abcd1234`);
      await fs.writeFile(bakPath, 'stale rule content');

      // Real clock: freshly written, real mtime, real now → never flagged,
      // even though the default hygiene scanner would otherwise consider a
      // far-future clock "aged" — this proves the default posture.
      const findings = await createHygieneScanner()(ctxFor(manifestPath, env));

      expect(findings.filter((f) => f.class === 'hygiene')).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it('doctor-T8: a .bak-* inside libs/ past age + keep-last-N retention is delete-bak, item-confirm', async () => {
    await setup();
    try {
      const libsRoot = libsDir(env);
      await fs.mkdir(libsRoot, { recursive: true });
      // Four generations of the same basename group — keepLastN default (3)
      // always spares the newest 3; only the oldest is even a candidate.
      for (let i = 0; i < 4; i++) {
        const bakPath = path.join(
          libsRoot,
          `rules-common.bak-2020-01-0${i + 1}T00-00-00.000Z-abcd000${i}`,
        );
        await fs.writeFile(bakPath, 'stale rule content');
      }

      const scanner = createHygieneScanner({ now: FAR_FUTURE, keepLastN: 3 });
      const findings = await scanner(ctxFor(manifestPath, env));

      const baks = findings.filter((f) => f.class === 'hygiene' && f.kind === 'bak');
      expect(baks).toHaveLength(1);
      const finding = baks[0]!;
      if (finding.class !== 'hygiene' || finding.kind !== 'bak') throw new Error('unreachable');
      expect(finding.path).toContain('rules-common.bak-2020-01-01');
      expect(finding.repair.kind).toBe('delete-bak');
      expect(finding.repair.consent).toBe('item-confirm');
    } finally {
      await teardown();
    }
  });
});
