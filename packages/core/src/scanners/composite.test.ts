/**
 * Tests for core/src/scanners/composite.ts
 *
 * Strategy: a dispatching mock ScanRunner routes by command+args to simulate
 * tool presence checks and scan results — no real processes spawned.
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
import type { ScanRunner } from './gitleaks';

// ---------------------------------------------------------------------------
// Dispatcher mock builder
// ---------------------------------------------------------------------------

/**
 * Builds a ScanRunner that routes calls by (command, args[0]).
 * - command -v gitleaks  → gitleaksPresent exit code
 * - command -v trivy     → trivyPresent exit code
 * - gitleaks detect ...  → gitleaksScanResult
 * - trivy fs ...         → trivyScanResult
 */
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

function makeRunner(config: DispatchConfig): ScanRunner {
  return (command: string, args: string[]) => {
    // Presence checks
    if (command === 'command' && args[1] === 'gitleaks') {
      return Promise.resolve({
        exitCode: config.gitleaksPresent ? 0 : 1,
        stdout: '',
        stderr: '',
      });
    }
    if (command === 'command' && args[1] === 'trivy') {
      return Promise.resolve({
        exitCode: config.trivyPresent ? 0 : 1,
        stdout: '',
        stderr: '',
      });
    }
    // Scan calls
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
    // Unexpected call — surface it
    return Promise.resolve({ exitCode: 127, stdout: '', stderr: `unexpected: ${command}` });
  };
}

// ---------------------------------------------------------------------------
// Both present, both clean
// ---------------------------------------------------------------------------

describe('composite — both present, both clean', () => {
  it('returns { ok: true }', async () => {
    const scanner = createCompositeScanner({
      run: makeRunner({ gitleaksPresent: true, trivyPresent: true }),
    });
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
    const scanner = createCompositeScanner({
      run: makeRunner({
        gitleaksPresent: true,
        trivyPresent: true,
        gitleaksScanExit: 1,
        gitleaksScanStdout: SECRET_JSON,
      }),
    });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.ok).toBe(false);
  });

  it('finding is prefixed with [gitleaks]', async () => {
    const scanner = createCompositeScanner({
      run: makeRunner({
        gitleaksPresent: true,
        trivyPresent: true,
        gitleaksScanExit: 1,
        gitleaksScanStdout: SECRET_JSON,
      }),
    });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.findings?.some((f: string) => f.startsWith('[gitleaks]'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Both present, trivy finds misconfig HIGH FAIL
// ---------------------------------------------------------------------------

describe('composite — both present, trivy finds misconfig', () => {
  it('returns { ok: false }', async () => {
    const scanner = createCompositeScanner({
      run: makeRunner({
        gitleaksPresent: true,
        trivyPresent: true,
        trivyScanStdout: MISCONFIG_JSON,
      }),
    });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.ok).toBe(false);
  });

  it('finding is prefixed with [trivy]', async () => {
    const scanner = createCompositeScanner({
      run: makeRunner({
        gitleaksPresent: true,
        trivyPresent: true,
        trivyScanStdout: MISCONFIG_JSON,
      }),
    });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.findings?.some((f: string) => f.startsWith('[trivy]'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Both present, both find issues → findings concatenated
// ---------------------------------------------------------------------------

describe('composite — both present, both find issues', () => {
  it('findings contain entries from both scanners', async () => {
    const scanner = createCompositeScanner({
      run: makeRunner({
        gitleaksPresent: true,
        trivyPresent: true,
        gitleaksScanExit: 1,
        gitleaksScanStdout: SECRET_JSON,
        trivyScanStdout: MISCONFIG_JSON,
      }),
    });
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
    const scanner = createCompositeScanner({
      run: makeRunner({ gitleaksPresent: true, trivyPresent: false }),
    });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.ok).toBe(true);
  });

  it('returns { ok: false } with [gitleaks] prefix when secret found', async () => {
    const scanner = createCompositeScanner({
      run: makeRunner({
        gitleaksPresent: true,
        trivyPresent: false,
        gitleaksScanExit: 1,
        gitleaksScanStdout: SECRET_JSON,
      }),
    });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.ok).toBe(false);
    expect(verdict.findings?.some((f: string) => f.startsWith('[gitleaks]'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Neither present → fail-closed
// ---------------------------------------------------------------------------

describe('composite — neither present', () => {
  it('returns { ok: false }', async () => {
    const scanner = createCompositeScanner({
      run: makeRunner({ gitleaksPresent: false, trivyPresent: false }),
    });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.ok).toBe(false);
  });

  it('finding mentions "no security scanner available"', async () => {
    const scanner = createCompositeScanner({
      run: makeRunner({ gitleaksPresent: false, trivyPresent: false }),
    });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.findings?.[0]).toContain('no security scanner available');
  });
});
