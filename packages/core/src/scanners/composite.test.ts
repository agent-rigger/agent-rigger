/**
 * Tests for core/src/scanners/composite.ts
 *
 * Strategy: separate mocks for presence (WhichFn) and scanning (ScanRunner).
 * Presence is now checked via Bun.which — no shell spawn for detection.
 *
 * Coverage:
 *  - both present, both clean              → { ok: true }
 *  - both present, gitleaks finds secret   → { ok: false }, finding prefixed [gitleaks]
 *  - both present, trivy finds misconfig   → { ok: false }, finding prefixed [trivy]
 *  - both present, both find issues        → findings from both concatenated
 *  - only gitleaks present, clean          → { ok: true }  (trivy not called)
 *  - only gitleaks present, secret found   → { ok: false } with [gitleaks] prefix
 *  - neither present                       → fail-closed, "no security scanner available"
 */

import { describe, expect, it } from 'bun:test';

import { createCompositeScanner } from './composite';
import type { ScanRunner, WhichFn } from './gitleaks';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

interface DispatchConfig {
  gitleaksPresent: boolean;
  trivyPresent: boolean;
  gitleaksScanExit?: number;
  gitleaksScanStdout?: string;
  trivyScanExit?: number;
  trivyScanStdout?: string;
}

const SECRET_JSON = JSON.stringify([
  {
    Description: 'AWS Access Key detected',
    File: 'config/secrets.env',
    RuleID: 'aws-access-key',
    StartLine: 3,
    EndLine: 3,
  },
]);

const MISCONFIG_JSON = JSON.stringify({
  Results: [
    {
      Target: 'Dockerfile',
      Misconfigurations: [
        {
          ID: 'DS002',
          Title: 'Image user should not be root',
          Severity: 'HIGH',
          Status: 'FAIL',
        },
      ],
    },
  ],
});

const CLEAN_GITLEAKS = '[]';
const CLEAN_TRIVY = JSON.stringify({ Results: [] });

/**
 * Returns a WhichFn mock that simulates tool presence on PATH.
 * Only "gitleaks" and "trivy" are routed; anything else returns null.
 */
function makeWhich(config: Pick<DispatchConfig, 'gitleaksPresent' | 'trivyPresent'>): WhichFn {
  return (cmd: string) => {
    if (cmd === 'gitleaks') return config.gitleaksPresent ? '/usr/local/bin/gitleaks' : null;
    if (cmd === 'trivy') return config.trivyPresent ? '/usr/local/bin/trivy' : null;
    return null;
  };
}

/**
 * Returns a ScanRunner mock that handles only actual scan calls (gitleaks detect / trivy fs).
 * Presence checks are no longer routed through ScanRunner.
 */
function makeRunner(config: Omit<DispatchConfig, 'gitleaksPresent' | 'trivyPresent'>): ScanRunner {
  return (command: string, _args: string[]) => {
    if (command === 'gitleaks') {
      return Promise.resolve({
        exitCode: config.gitleaksScanExit ?? 0,
        stdout: config.gitleaksScanStdout ?? CLEAN_GITLEAKS,
        stderr: '',
      });
    }
    if (command === 'trivy') {
      return Promise.resolve({
        exitCode: config.trivyScanExit ?? 0,
        stdout: config.trivyScanStdout ?? CLEAN_TRIVY,
        stderr: '',
      });
    }
    // Unexpected call — surface it so the test fails clearly
    return Promise.resolve({ exitCode: 127, stdout: '', stderr: `unexpected: ${command}` });
  };
}

/** Convenience: build both mocks from a single DispatchConfig. */
function makeFixtures(config: DispatchConfig): { which: WhichFn; run: ScanRunner } {
  return {
    which: makeWhich(config),
    run: makeRunner(config),
  };
}

// ---------------------------------------------------------------------------
// Both present, both clean
// ---------------------------------------------------------------------------

describe('composite — both present, both clean', () => {
  it('returns { ok: true }', async () => {
    const { which, run } = makeFixtures({ gitleaksPresent: true, trivyPresent: true });
    const scanner = createCompositeScanner({ run, which });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.ok).toBe(true);
    expect(verdict.findings).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Both present, gitleaks finds a secret
// ---------------------------------------------------------------------------

describe('composite — both present, gitleaks finds secret', () => {
  it('returns { ok: false }', async () => {
    const { which, run } = makeFixtures({
      gitleaksPresent: true,
      trivyPresent: true,
      gitleaksScanExit: 1,
      gitleaksScanStdout: SECRET_JSON,
    });
    const scanner = createCompositeScanner({ run, which });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.ok).toBe(false);
  });

  it('finding is prefixed with [gitleaks]', async () => {
    const { which, run } = makeFixtures({
      gitleaksPresent: true,
      trivyPresent: true,
      gitleaksScanExit: 1,
      gitleaksScanStdout: SECRET_JSON,
    });
    const scanner = createCompositeScanner({ run, which });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.findings?.some((f: string) => f.startsWith('[gitleaks]'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Both present, trivy finds misconfig HIGH FAIL
// ---------------------------------------------------------------------------

describe('composite — both present, trivy finds misconfig', () => {
  it('returns { ok: false }', async () => {
    const { which, run } = makeFixtures({
      gitleaksPresent: true,
      trivyPresent: true,
      trivyScanStdout: MISCONFIG_JSON,
    });
    const scanner = createCompositeScanner({ run, which });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.ok).toBe(false);
  });

  it('finding is prefixed with [trivy]', async () => {
    const { which, run } = makeFixtures({
      gitleaksPresent: true,
      trivyPresent: true,
      trivyScanStdout: MISCONFIG_JSON,
    });
    const scanner = createCompositeScanner({ run, which });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.findings?.some((f: string) => f.startsWith('[trivy]'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Both present, both find issues → findings concatenated
// ---------------------------------------------------------------------------

describe('composite — both present, both find issues', () => {
  it('findings contain entries from both scanners', async () => {
    const { which, run } = makeFixtures({
      gitleaksPresent: true,
      trivyPresent: true,
      gitleaksScanExit: 1,
      gitleaksScanStdout: SECRET_JSON,
      trivyScanStdout: MISCONFIG_JSON,
    });
    const scanner = createCompositeScanner({ run, which });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.ok).toBe(false);
    const hasGitleaks = verdict.findings?.some((f: string) => f.startsWith('[gitleaks]'));
    const hasTrivy = verdict.findings?.some((f: string) => f.startsWith('[trivy]'));
    expect(hasGitleaks).toBe(true);
    expect(hasTrivy).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Only gitleaks present (trivy absent)
// ---------------------------------------------------------------------------

describe('composite — only gitleaks present', () => {
  it('returns { ok: true } when gitleaks is clean', async () => {
    const { which, run } = makeFixtures({ gitleaksPresent: true, trivyPresent: false });
    const scanner = createCompositeScanner({ run, which });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.ok).toBe(true);
  });

  it('returns { ok: false } with [gitleaks] prefix when secret found', async () => {
    const { which, run } = makeFixtures({
      gitleaksPresent: true,
      trivyPresent: false,
      gitleaksScanExit: 1,
      gitleaksScanStdout: SECRET_JSON,
    });
    const scanner = createCompositeScanner({ run, which });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.ok).toBe(false);
    expect(verdict.findings?.some((f: string) => f.startsWith('[gitleaks]'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Neither present → warn-only (degraded mode, ADR-0018)
// ---------------------------------------------------------------------------

describe('composite — neither present', () => {
  it('returns { ok: true } (warn-only, no fail-closed on missing scanner)', async () => {
    const { which, run } = makeFixtures({ gitleaksPresent: false, trivyPresent: false });
    const scanner = createCompositeScanner({ run, which });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.ok).toBe(true);
  });

  it('sets degraded: true when no scanner is available', async () => {
    const { which, run } = makeFixtures({ gitleaksPresent: false, trivyPresent: false });
    const scanner = createCompositeScanner({ run, which });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.degraded).toBe(true);
  });

  it('does not set degraded when at least one scanner is available and clean', async () => {
    const { which, run } = makeFixtures({ gitleaksPresent: true, trivyPresent: false });
    const scanner = createCompositeScanner({ run, which });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.degraded).toBeUndefined();
  });
});
