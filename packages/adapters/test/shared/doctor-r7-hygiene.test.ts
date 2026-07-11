/**
 * Tests for the R7 hygiene scanner (adapters/src/shared/doctor-scan.ts,
 * `createHygieneScanner`, T3).
 *
 * Named scenarios from requirements.md:
 *   - ".tmp orphelin de crash" — an aged `.tmp-*` staging sibling is
 *     removable under --yes (safe).
 *   - ".bak récent → intouchable par défaut" — a recent `.bak-*` is never
 *     even surfaced as a finding.
 *
 * Plus the SHALL-clause behaviours cheap to prove alongside the two named
 * scenarios: an aged temporary catalog checkout under the tmpdir is safe
 * residue too, and a `.bak-*` past BOTH the age threshold and the
 * keep-last-N retention is `delete-bak` (item-confirm, never safe).
 *
 * Age is controlled via the scanner's injectable clock (`now`), never by
 * backdating real file mtimes — simpler and exact.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DoctorContext } from '@agent-rigger/core';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { createHygieneScanner } from '../../src/shared/doctor-scan';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-doctor-r7-'): Promise<{
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

const FAR_FUTURE = () => Date.now() + 30 * 24 * 60 * 60 * 1000; // +30 days: anything real is "aged".

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let manifestPath: string;

async function setup(): Promise<void> {
  tmp = await makeTmpHome();
  env = tmp.env;
  manifestPath = resolveUserTargets(env).stateJson;
}

async function teardown(): Promise<void> {
  await tmp.cleanup();
}

// ---------------------------------------------------------------------------
// .tmp orphelin de crash
// ---------------------------------------------------------------------------

describe('doctor-R7: .tmp orphelin de crash', () => {
  it('doctor-R7: an aged settings.json.tmp-* staging sibling is safe residue', async () => {
    await setup();
    try {
      const settingsPath = resolveUserTargets(env).claudeSettings;
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      const tmpPath = `${settingsPath}.tmp-deadbeef`;
      await fs.writeFile(tmpPath, '{"partial":');

      const scanner = createHygieneScanner({ now: FAR_FUTURE });
      const findings = await scanner(ctxFor(manifestPath, env));

      const residue = findings.filter((f) => f.class === 'hygiene' && f.kind === 'residue');
      expect(residue).toHaveLength(1);
      const finding = residue[0]!;
      if (finding.class !== 'hygiene' || finding.kind !== 'residue') throw new Error('unreachable');
      expect(finding.path).toBe(tmpPath);
      expect(finding.repair.kind).toBe('delete-residue');
      expect(finding.repair.consent).toBe('safe');
    } finally {
      await teardown();
    }
  });

  it('doctor-R7: a FRESH .tmp-* sibling is never proposed (not yet aged)', async () => {
    await setup();
    try {
      const settingsPath = resolveUserTargets(env).claudeSettings;
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(`${settingsPath}.tmp-deadbeef`, '{"partial":');

      // Default (real) clock — the file is milliseconds old, well under 24h.
      const findings = await createHygieneScanner()(ctxFor(manifestPath, env));

      expect(findings.filter((f) => f.class === 'hygiene')).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it('doctor-R7: an aged temporary catalog checkout under the tmpdir is safe residue', async () => {
    await setup();
    const checkoutDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-rigger-catalog-'));
    try {
      const scanner = createHygieneScanner({ now: FAR_FUTURE });
      const findings = await scanner(ctxFor(manifestPath, env));

      const residue = findings.filter(
        (f) => f.class === 'hygiene' && f.kind === 'residue' && f.path === checkoutDir,
      );
      expect(residue).toHaveLength(1);
      const finding = residue[0]!;
      if (finding.class !== 'hygiene' || finding.kind !== 'residue') throw new Error('unreachable');
      expect(finding.repair.consent).toBe('safe');
    } finally {
      await fs.rm(checkoutDir, { recursive: true, force: true });
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// .bak récent → intouchable par défaut
// ---------------------------------------------------------------------------

describe('doctor-R7: .bak récent → intouchable par défaut', () => {
  it('doctor-R7: a recent .bak-* sibling is never proposed for deletion', async () => {
    await setup();
    try {
      const stateDir = path.dirname(resolveUserTargets(env).stateJson);
      await fs.mkdir(stateDir, { recursive: true });
      const bakPath = path.join(stateDir, `state.json.bak-${toFsSafeIso(new Date())}-abcd1234`);
      await fs.writeFile(bakPath, '{"version":1,"artifacts":[]}');

      // Even with a far-future clock (would otherwise look "aged"), a recent
      // .bak must be evaluated as recent relative to ITS OWN mtime — this
      // test uses the real clock to prove the default posture: freshly
      // written, real mtime, real now → never flagged.
      const findings = await createHygieneScanner()(ctxFor(manifestPath, env));

      expect(findings.filter((f) => f.class === 'hygiene')).toHaveLength(0);
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// .bak aged past retention (age + keep-last-N — SHALL clause, not a
// separately GIVEN/WHEN/THEN scenario, cheap to prove alongside the above)
// ---------------------------------------------------------------------------

describe('doctor-R7: .bak aged past age + keep-last-N retention', () => {
  it('doctor-R7: a .bak-* both aged AND beyond keep-last-N is delete-bak, item-confirm', async () => {
    await setup();
    try {
      const stateDir = path.dirname(resolveUserTargets(env).stateJson);
      await fs.mkdir(stateDir, { recursive: true });
      // Four generations of the same basename group — keepLastN default (3)
      // always spares the newest 3; only the oldest is even a candidate.
      const bakPaths: string[] = [];
      for (let i = 0; i < 4; i++) {
        const bakPath = path.join(
          stateDir,
          `state.json.bak-2020-01-0${i + 1}T00-00-00.000Z-abcd000${i}`,
        );
        await fs.writeFile(bakPath, '{}');
        bakPaths.push(bakPath);
      }

      const scanner = createHygieneScanner({ now: FAR_FUTURE, keepLastN: 3 });
      const findings = await scanner(ctxFor(manifestPath, env));

      const baks = findings.filter((f) => f.class === 'hygiene' && f.kind === 'bak');
      expect(baks).toHaveLength(1);
      const finding = baks[0]!;
      if (finding.class !== 'hygiene' || finding.kind !== 'bak') throw new Error('unreachable');
      expect(finding.repair.kind).toBe('delete-bak');
      expect(finding.repair.consent).toBe('item-confirm');
    } finally {
      await teardown();
    }
  });
});

function toFsSafeIso(date: Date): string {
  return date.toISOString().replace(/:/g, '-');
}
