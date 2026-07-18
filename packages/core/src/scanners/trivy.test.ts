/**
 * Tests for core/src/scanners/trivy.ts
 *
 * Strategy: inject a mock ScanRunner for scan calls, and a mock WhichFn for
 * presence checks — no real trivy process is spawned.
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
 *  - isTrivyAvailable: which returns path → true ; returns null → false
 */

import { describe, expect, it } from 'bun:test';
import path from 'node:path';

import type { ScanRunner, WhichFn } from './gitleaks';
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

const misconfigCriticalFailJson = JSON.stringify({
  Results: [
    {
      Target: 'Dockerfile',
      Misconfigurations: [
        {
          ID: 'DS001',
          Title: 'Use of latest tag',
          Severity: 'CRITICAL',
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
// R3 — misconfig CRITICAL + FAIL (blocking): today only HIGH+FAIL is pinned,
// but BLOCKING_SEVERITIES (trivy.ts) also contains CRITICAL — lock that too.
// ---------------------------------------------------------------------------

describe('R3: createTrivyScanner — misconfig CRITICAL FAIL blocks', () => {
  it('R3: returns { ok: false } for a CRITICAL severity FAIL misconfig', async () => {
    const scanner = createTrivyScanner({ run: mockRunner(0, misconfigCriticalFailJson) });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.ok).toBe(false);
  });

  it('R3: finding mentions the misconfig ID and CRITICAL severity', async () => {
    const scanner = createTrivyScanner({ run: mockRunner(0, misconfigCriticalFailJson) });
    const verdict = await scanner.scan('/tmp/project');
    const finding = verdict.findings?.[0] ?? '';
    expect(finding).toContain('DS001');
    expect(finding).toContain('CRITICAL');
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
// R7 — Target rebased defensively (trivy 0.72.0 already emits a relative Target,
// but the isAbsolute guard hardens attribution against a version drift that
// starts reporting an absolute path under the scanned staging dir).
// ---------------------------------------------------------------------------

describe('createTrivyScanner — R7 Target rebasing', () => {
  it('R7: rebases an absolute Target under the scanned dir to a checkout-relative path', async () => {
    const dir = '/tmp/rig-scan-staging-xyz';
    const absTarget = path.join(dir, 'skills', 'api-helper', 'SKILL.md');
    const json = JSON.stringify({
      Results: [
        {
          Target: absTarget,
          Secrets: [{
            RuleID: 'aws-access-key-id',
            Title: 'AWS Access Key ID',
            Severity: 'CRITICAL',
          }],
        },
      ],
    });
    const scanner = createTrivyScanner({ run: mockRunner(0, json) });

    const verdict = await scanner.scan(dir);

    const finding = verdict.findings?.[0] ?? '';
    expect(finding).toContain('skills/api-helper/SKILL.md');
    expect(finding).not.toContain(dir);
  });

  it('R7: leaves an already-relative Target unchanged', async () => {
    const scanner = createTrivyScanner({ run: mockRunner(0, oneSecretJson) });

    const verdict = await scanner.scan('/tmp/rig-scan-staging-xyz');

    expect(verdict.findings?.[0]).toContain('src/config.ts');
  });
});

// ---------------------------------------------------------------------------
// isTrivyAvailable — WhichFn-based (portable, no shell spawn)
// ---------------------------------------------------------------------------

const trivyWhichFound: WhichFn = () => '/usr/local/bin/trivy';
const trivyWhichNotFound: WhichFn = () => null;

describe('isTrivyAvailable', () => {
  it('returns true when which returns a non-null path', async () => {
    const available = await isTrivyAvailable(trivyWhichFound);
    expect(available).toBe(true);
  });

  it('returns false when which returns null', async () => {
    const available = await isTrivyAvailable(trivyWhichNotFound);
    expect(available).toBe(false);
  });

  it('passes "trivy" as the command to which', async () => {
    let received: string | undefined;
    await isTrivyAvailable((cmd) => {
      received = cmd;
      return '/usr/bin/trivy';
    });
    expect(received).toBe('trivy');
  });
});
