/**
 * Real-binary smoke tests for the gitleaks scanner (packages/core).
 *
 * Every other scanner test injects a fake ScanRunner; these drive the REAL
 * gitleaks binary end-to-end, so the attribution and symlink behaviour the mocks
 * only assert in the abstract are proven against gitleaks 8.30.1 itself. The
 * suite self-skips when gitleaks is absent from PATH — CI installs it pinned +
 * checksum-verified (ci.yml) so these run there rather than skipping silently.
 *
 * Three properties:
 *  (a) a planted secret in a fixture yields ok:false with a checkout-relative
 *      attribution (the finding ends with the relative path);
 *  (b) scanning the SAME fixture through a symlinked PARENT directory yields the
 *      identical attribution — gitleaks keeps the symlinked ancestor in its
 *      reported path, so relativising against the scanned root is stable;
 *  (c) CANARY — scanning a directory that is ITSELF a direct symlink returns
 *      exit 0 / zero findings. This is a real gitleaks 8.30.1 bypass (a directly
 *      symlinked source scans 0 bytes). It is frozen here on purpose: a gitleaks
 *      bump that changes this must be SEEN, not silently "fixed" away. The real
 *      pipeline is unaffected — the staging mkdtemp is never a symlink
 *      (invariant asserted in scu-r2-staging.test.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createGitleaksScanner, defaultWhich } from './gitleaks';

const GITLEAKS_ABSENT = defaultWhich('gitleaks') === null;

/**
 * Frozen GitHub PAT fixture: `ghp_` + 36 chars, high-entropy so gitleaks
 * 8.30.1's `github-pat` rule fires. A low-entropy AKIA-style token does NOT trip
 * gitleaks (documented pitfall) — this exact literal was verified to trigger a
 * single finding before being frozen here.
 */
const FROZEN_PAT = 'ghp_016ABCdef0123456789ghIJKLmnop6789zZq';

let root = '';

describe.skipIf(GITLEAKS_ABSENT)('gitleaks real-binary smokes (8.30.1)', () => {
  beforeAll(async () => {
    // Realpath the temp root so gitleaks' realpath-resolved File (macOS
    // /var → /private/var) relativises cleanly against the scanned root.
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rig-real-gl-')));

    // Real fixture with a planted secret, scanned directly (a) and through a
    // symlinked parent (b).
    const fixtureSrc = path.join(root, 'real', 'fixture', 'src');
    await fs.mkdir(fixtureSrc, { recursive: true });
    await fs.writeFile(
      path.join(fixtureSrc, 'leak.ts'),
      `const token = "${FROZEN_PAT}";\n`,
      'utf8',
    );

    // (b) a symlink to the fixture's PARENT dir ('real'), so 'linkparent/fixture'
    // reaches the fixture through a symlinked ancestor.
    await fs.symlink(path.join(root, 'real'), path.join(root, 'linkparent'));

    // (c) a symlink to the fixture dir ITSELF.
    await fs.symlink(path.join(root, 'real', 'fixture'), path.join(root, 'linkdir'));
  });

  afterAll(async () => {
    if (root !== '') await fs.rm(root, { recursive: true, force: true });
  });

  it('(a) plants a secret in a fixture → ok:false with a checkout-relative attribution', async () => {
    const dir = path.join(root, 'real', 'fixture');
    const scanner = createGitleaksScanner();

    const verdict = await scanner.scan(dir);

    expect(verdict.ok).toBe(false);
    expect(verdict.findings).toHaveLength(1);
    const finding = verdict.findings?.[0] ?? '';
    // Ends with the checkout-relative path, and never names the host root.
    expect(finding.endsWith('(src/leak.ts)')).toBe(true);
    expect(finding).not.toContain(root);
  });

  it('(b) scanning through a symlinked parent yields the identical attribution', async () => {
    const directDir = path.join(root, 'real', 'fixture');
    const parentSymlinkedDir = path.join(root, 'linkparent', 'fixture');
    const scanner = createGitleaksScanner();

    const direct = await scanner.scan(directDir);
    const throughParent = await scanner.scan(parentSymlinkedDir);

    expect(throughParent.ok).toBe(false);
    // Same checkout-relative attribution regardless of the symlinked ancestor.
    expect(throughParent.findings?.[0]?.endsWith('(src/leak.ts)')).toBe(true);
    expect(throughParent.findings).toEqual(direct.findings);
  });

  it('(c) CANARY: a directly symlinked source dir scans 0 bytes → exit 0, 0 findings (gitleaks 8.30.1 bypass, do not "fix")', async () => {
    const dir = path.join(root, 'linkdir');
    const scanner = createGitleaksScanner();

    const verdict = await scanner.scan(dir);

    // A gitleaks bump that starts detecting through a directly symlinked source
    // will red this assertion — that change must be reviewed, not silenced. The
    // real pipeline never scans a symlinked root (staging is a real mkdtemp).
    expect(verdict.ok).toBe(true);
    expect(verdict.findings).toBeUndefined();
  });
});
