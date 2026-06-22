/**
 * Tests for core/src/scanners/trivy.ts
 *
 * Strategy: inject a mock ScanRunner — no real trivy process is spawned.
 *
 * Coverage:
 *  - exit 0 / 1 secret               → { ok: false }, finding mentions RuleID
 *  - exit 0 / misconfig HIGH + FAIL   → { ok: false }
 *  - exit 0 / misconfig LOW + FAIL    → { ok: true }  (severity not blocking)
 *  - exit 0 / misconfig HIGH + PASS   → { ok: true }  (status not FAIL)
 *  - exit 0 / { Results: [] }         → { ok: true }
 *  - exit 0 / stdout empty            → { ok: true }
 *  - exit 2 / stderr "fatal"          → { ok: false }, finding mentions "trivy error"
 *  - exit 0 / non-JSON stdout         → { ok: false }, finding mentions "unparseable"
 *  - isTrivyAvailable: exit 0 → true ; non-0 → false
 */

import { describe, expect, it } from 'bun:test';

import type { ScanRunner } from './gitleaks';
import { createTrivyScanner, isTrivyAvailable } from './trivy';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function mockRunner(exitCode: number, stdout: string, stderr = ''): ScanRunner {
  return (_command: string, _args: string[]) => Promise.resolve({ exitCode, stdout, stderr });
}

const oneSecretJson = JSON.stringify({
  Results: [
    {
      Target: 'src/config.ts',
      Secrets: [
        {
          RuleID: 'aws-access-key-id',
          Title: 'AWS Access Key ID',
          Severity: 'CRITICAL',
        },
      ],
    },
  ],
});

const misconfigHighFailJson = JSON.stringify({
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

const misconfigLowFailJson = JSON.stringify({
  Results: [
    {
      Target: 'Dockerfile',
      Misconfigurations: [
        {
          ID: 'DS026',
          Title: 'No healthcheck defined',
          Severity: 'LOW',
          Status: 'FAIL',
        },
      ],
    },
  ],
});

const misconfigHighPassJson = JSON.stringify({
  Results: [
    {
      Target: 'Dockerfile',
      Misconfigurations: [
        {
          ID: 'DS002',
          Title: 'Image user should not be root',
          Severity: 'HIGH',
          Status: 'PASS',
        },
      ],
    },
  ],
});

const emptyResultsJson = JSON.stringify({ Results: [] });

// ---------------------------------------------------------------------------
// createTrivyScanner — 1 secret
// ---------------------------------------------------------------------------

describe('createTrivyScanner — exit 0, one secret', () => {
  it('returns { ok: false }', async () => {
    const scanner = createTrivyScanner({ run: mockRunner(0, oneSecretJson) });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.ok).toBe(false);
  });

  it('finding mentions the RuleID', async () => {
    const scanner = createTrivyScanner({ run: mockRunner(0, oneSecretJson) });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.findings?.[0]).toContain('aws-access-key-id');
  });

  it('finding mentions the Target', async () => {
    const scanner = createTrivyScanner({ run: mockRunner(0, oneSecretJson) });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.findings?.[0]).toContain('src/config.ts');
  });
});

// ---------------------------------------------------------------------------
// createTrivyScanner — misconfig HIGH + FAIL (blocking)
// ---------------------------------------------------------------------------

describe('createTrivyScanner — exit 0, misconfig HIGH FAIL', () => {
  it('returns { ok: false }', async () => {
    const scanner = createTrivyScanner({ run: mockRunner(0, misconfigHighFailJson) });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.ok).toBe(false);
  });

  it('finding mentions the misconfig ID and severity', async () => {
    const scanner = createTrivyScanner({ run: mockRunner(0, misconfigHighFailJson) });
    const verdict = await scanner.scan('/tmp/project');
    const finding = verdict.findings?.[0] ?? '';
    expect(finding).toContain('DS002');
    expect(finding).toContain('HIGH');
  });
});

// ---------------------------------------------------------------------------
// createTrivyScanner — misconfig LOW + FAIL (ignored)
// ---------------------------------------------------------------------------

describe('createTrivyScanner — exit 0, misconfig LOW FAIL', () => {
  it('returns { ok: true } (LOW severity does not block)', async () => {
    const scanner = createTrivyScanner({ run: mockRunner(0, misconfigLowFailJson) });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.ok).toBe(true);
    expect(verdict.findings).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createTrivyScanner — misconfig HIGH + PASS (ignored)
// ---------------------------------------------------------------------------

describe('createTrivyScanner — exit 0, misconfig HIGH PASS', () => {
  it('returns { ok: true } (PASS status does not block)', async () => {
    const scanner = createTrivyScanner({ run: mockRunner(0, misconfigHighPassJson) });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.ok).toBe(true);
    expect(verdict.findings).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createTrivyScanner — empty Results / empty stdout
// ---------------------------------------------------------------------------

describe('createTrivyScanner — exit 0, empty Results', () => {
  it('returns { ok: true } for { Results: [] }', async () => {
    const scanner = createTrivyScanner({ run: mockRunner(0, emptyResultsJson) });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.ok).toBe(true);
  });
});

describe('createTrivyScanner — exit 0, empty stdout', () => {
  it('returns { ok: true } without crashing', async () => {
    const scanner = createTrivyScanner({ run: mockRunner(0, '') });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createTrivyScanner — exit != 0 / tool error
// ---------------------------------------------------------------------------

describe('createTrivyScanner — exit 2, tool error', () => {
  it('returns { ok: false } (fail-closed)', async () => {
    const scanner = createTrivyScanner({
      run: mockRunner(2, '', 'fatal: unable to initialize scanner'),
    });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.ok).toBe(false);
  });

  it('finding mentions "trivy error" and includes stderr', async () => {
    const scanner = createTrivyScanner({
      run: mockRunner(2, '', 'fatal: unable to initialize scanner'),
    });
    const verdict = await scanner.scan('/tmp/project');
    const finding = verdict.findings?.[0] ?? '';
    expect(finding).toContain('trivy error');
    expect(finding).toContain('fatal: unable to initialize scanner');
  });
});

// ---------------------------------------------------------------------------
// createTrivyScanner — non-JSON stdout on exit 0
// ---------------------------------------------------------------------------

describe('createTrivyScanner — exit 0, non-JSON stdout', () => {
  it('returns { ok: false } with "unparseable" finding (no throw)', async () => {
    const scanner = createTrivyScanner({ run: mockRunner(0, 'not valid json {{{') });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.ok).toBe(false);
    expect(verdict.findings?.[0]).toContain('unparseable');
  });
});

// ---------------------------------------------------------------------------
// isTrivyAvailable
// ---------------------------------------------------------------------------

describe('isTrivyAvailable', () => {
  it('returns true when "command -v trivy" exits 0', async () => {
    const available = await isTrivyAvailable(mockRunner(0, '/usr/local/bin/trivy'));
    expect(available).toBe(true);
  });

  it('returns false when "command -v trivy" exits non-zero', async () => {
    const available = await isTrivyAvailable(mockRunner(1, ''));
    expect(available).toBe(false);
  });
});
