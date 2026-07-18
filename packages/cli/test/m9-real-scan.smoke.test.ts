/**
 * m9-real-scan.smoke.test.ts — the m9 out-of-selection property, proven against
 * the REAL gitleaks binary (scan-hardening T5, optional real-binary smoke).
 *
 * m9-out-of-selection-scan.test.ts drives the same property with a
 * content-sensitive gitleaks MOCK (fast, deterministic, always runs). This file
 * closes the loop with gitleaks 8.30.1 itself over `scanEntries` →
 * `materializeUnion` → real `createCompositeScanner`: a planted PAT in a
 * NON-selected skill never blocks a clean selection, and blocks when its own
 * skill is selected. Self-skips when gitleaks is absent from PATH — CI installs
 * it pinned + checksum-verified (ci.yml), so it runs there rather than skipping
 * silently.
 *
 * The fixture is realpath'd so the staging mkdtemp sibling (created inside
 * materializeUnion, un-realpath'd) and gitleaks' realpath-resolved File
 * (/var → /private/var on macOS) rebase cleanly to the checkout-relative path.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ArtifactEntry } from '@agent-rigger/catalog';
import { createCompositeScanner, defaultWhich } from '@agent-rigger/core';

import { ScanBlockedError, scanEntries } from '../src/remote-install';

const GITLEAKS_ABSENT = defaultWhich('gitleaks') === null;

/**
 * Frozen GitHub PAT fixture: `ghp_` + 36 high-entropy chars — the exact literal
 * frozen in core/real-binaries.test.ts, verified to trip gitleaks 8.30.1's
 * `github-pat` rule (a low-entropy AKIA token does not — documented pitfall).
 */
const FROZEN_PAT = 'ghp_016ABCdef0123456789ghIJKLmnop6789zZq';

const SKILL_A: ArtifactEntry = {
  kind: 'artifact',
  id: 'skill:a',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user'],
};

const SKILL_AUTRE: ArtifactEntry = {
  kind: 'artifact',
  id: 'skill:autre',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user'],
};

let baseDir = '';
let tmpParent = '';

describe.skipIf(GITLEAKS_ABSENT)('m9 real gitleaks: out-of-selection secret never blocks', () => {
  beforeAll(async () => {
    // Realpath the parent so the internal staging mkdtemp (sibling of baseDir)
    // and gitleaks' realpath-resolved File relativise cleanly.
    tmpParent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rig-m9-real-')));
    baseDir = path.join(tmpParent, 'checkout');
    await fs.mkdir(path.join(baseDir, 'skills', 'a'), { recursive: true });
    await fs.mkdir(path.join(baseDir, 'skills', 'autre'), { recursive: true });

    await fs.writeFile(
      path.join(baseDir, 'catalog.json'),
      JSON.stringify({ meta: { name: 'm9-real' }, entries: [SKILL_A, SKILL_AUTRE] }),
      'utf8',
    );
    await fs.writeFile(
      path.join(baseDir, 'skills', 'a', 'SKILL.md'),
      '# skill a\nnothing to see here\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(baseDir, 'skills', 'autre', 'SKILL.md'),
      `# skill autre\nconst token = "${FROZEN_PAT}";\n`,
      'utf8',
    );
  });

  afterAll(async () => {
    if (tmpParent !== '') await fs.rm(tmpParent, { recursive: true, force: true });
  });

  it('scanEntries([skill:a]) resolves — skills/autre is never staged nor scanned', async () => {
    const { verdict } = await scanEntries({
      entries: [SKILL_A],
      baseDir,
      scanner: createCompositeScanner(),
      force: false,
    });
    expect(verdict.ok).toBe(true);
  });

  it('scanEntries([skill:autre]) blocks with a finding naming skills/autre/SKILL.md', async () => {
    let caught: unknown;
    try {
      await scanEntries({
        entries: [SKILL_AUTRE],
        baseDir,
        scanner: createCompositeScanner(),
        force: false,
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ScanBlockedError);
    const err = caught as ScanBlockedError;
    expect(err.findings.some((f) => f.includes('skills/autre/SKILL.md'))).toBe(true);
  });
});
