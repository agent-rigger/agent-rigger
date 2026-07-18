/**
 * Tests for core/src/scanners/finding-path.ts
 *
 * relativiseFindingPath: 5 cases — absolute-in-root → rel, clean-relative →
 * passthrough, absolute-outside → clamp, relative-`../` → clamp, and the clamp
 * literal pinned byte-exact.
 *
 * sanitizeToolStderr: the scanned dir (and a `<scan-root>`-free identity on a
 * path-less stderr) — the `<scan-root>` sentinel pinned byte-exact.
 */

import { describe, expect, it } from 'bun:test';
import path from 'node:path';

import { relativiseFindingPath, sanitizeToolStderr } from './finding-path';

describe('relativiseFindingPath', () => {
  it('absolute path under the scan root → checkout-relative attribution', () => {
    const root = '/tmp/rig-scan-staging-abc';
    const raw = path.join(root, 'skills', 'api-helper', 'SKILL.md');
    expect(relativiseFindingPath(raw, root)).toBe('skills/api-helper/SKILL.md');
  });

  it('clean relative path → passed through unchanged', () => {
    expect(relativiseFindingPath('config/secrets.env', '/tmp/rig-scan-staging-abc')).toBe(
      'config/secrets.env',
    );
  });

  it('absolute path outside the scan root → clamped to the basename sentinel', () => {
    const clamped = relativiseFindingPath('/etc/passwd', '/tmp/rig-scan-staging-abc');
    expect(clamped).toBe('<outside-scan-root>/passwd');
    expect(clamped).not.toContain('/etc');
  });

  it('already-relative `../` escape → clamped just like an absolute escape', () => {
    expect(relativiseFindingPath('../secrets/key.pem', '/tmp/rig-scan-staging-abc')).toBe(
      '<outside-scan-root>/key.pem',
    );
  });

  it('emits the `<outside-scan-root>/` literal byte-exact', () => {
    // Byte-exact pin (adversarial M2): the runtime sentinel must not drift.
    expect(relativiseFindingPath('/var/lib/host-secret.txt', '/tmp/scan')).toBe(
      '<outside-scan-root>/host-secret.txt',
    );
  });
});

describe('sanitizeToolStderr', () => {
  it('substitutes the scanned dir with the `<scan-root>` sentinel byte-exact', () => {
    const root = '/tmp/rig-scan-staging-abc';
    const raw = `fatal: could not read ${root}/skills/x: permission denied\n`;
    const sanitized = sanitizeToolStderr(raw, root);
    expect(sanitized).toBe('fatal: could not read <scan-root>/skills/x: permission denied');
    expect(sanitized).not.toContain(root);
  });

  it('is the identity (modulo trim) on a stderr that names no path', () => {
    expect(sanitizeToolStderr('boom', '/tmp/rig-scan-staging-abc')).toBe('boom');
    expect(sanitizeToolStderr('  boom  \n', '/tmp/rig-scan-staging-abc')).toBe('boom');
  });
});
