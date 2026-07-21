/**
 * lib-nature-t13-messages.test.ts — adversarial-close findings 5 & 12: the two
 * user-facing message improvements.
 *
 * Finding 5 — the "cannot symlink" remediation is platform-conditional: the
 * Developer Mode / W1 hint is Windows-only; macOS/Linux get a generic cause plus
 * `rigger doctor` (Developer Mode is never the fix there).
 *
 * Finding 12 — ExplicitLibInstallError names REAL consumers the catalogue
 * reveals, capped at three plus an ellipsis, instead of an abstract "install a
 * consumer".
 */

import { describe, expect, it } from 'bun:test';

import { symlinkRemediationHint } from '@agent-rigger/core/linker';

import { ExplicitLibInstallError } from '../src/cmd-install';

describe('finding 5 — symlinkRemediationHint is platform-conditional', () => {
  it('shows the Developer Mode / W1 hint on win32', () => {
    const hint = symlinkRemediationHint('win32');
    expect(hint).toMatch(/Developer Mode/);
    expect(hint).toMatch(/W1/);
  });

  it('shows a generic cause + rigger doctor on non-win32, never Developer Mode', () => {
    for (const platform of ['linux', 'darwin']) {
      const hint = symlinkRemediationHint(platform);
      expect(hint).toMatch(/rigger doctor/);
      expect(hint).not.toMatch(/Developer Mode/);
      expect(hint).not.toMatch(/W1/);
    }
  });
});

describe('finding 12 — ExplicitLibInstallError names real consumers', () => {
  it('names the consumers (capped at three) when the catalogue reveals them', () => {
    const err = new ExplicitLibInstallError('jr/lib:rules-common', [
      'jr/hook:guard-command',
      'jr/plugin:guard',
      'jr/skill:helper',
      'jr/agent:reviewer',
    ]);
    expect(err.message).toContain('"jr/hook:guard-command"');
    expect(err.message).toContain('"jr/plugin:guard"');
    expect(err.message).toContain('"jr/skill:helper"');
    // Capped at three → the fourth is not listed, an ellipsis stands in.
    expect(err.message).not.toContain('jr/agent:reviewer');
    expect(err.message).toContain('…');
  });

  it('falls back to the generic hint when no consumer is known', () => {
    const err = new ExplicitLibInstallError('jr/lib:rules-common', []);
    expect(err.message).toContain('Install a consumer instead.');
    expect(err.message).not.toContain('e.g.');
  });
});
