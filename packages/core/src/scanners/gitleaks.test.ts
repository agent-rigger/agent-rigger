/**
 * Tests for core/src/scanners/gitleaks.ts
 *
 * Strategy: inject a mock ScanRunner for scan calls, and a mock WhichFn for
 * presence checks — no real gitleaks process is spawned.
 *
 * Coverage:
 *  - exit 0 / stdout `[]`     → { ok: true }
 *  - exit 0 / stdout empty    → { ok: true } (no JSON.parse crash)
 *  - exit 1 / 2 findings      → { ok: false }, findings.length === 2, each mentions RuleID + File
 *  - exit 2 / stderr "fatal"  → { ok: false }, finding mentions "gitleaks error"
 *  - isGitleaksAvailable: which returns path → true ; returns null → false
 */

import { describe, expect, it } from 'bun:test';

import { createGitleaksScanner, isGitleaksAvailable } from './gitleaks';
import type { ScanRunner, WhichFn } from './gitleaks';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Builds a mock ScanRunner that always returns the given result. */
function mockRunner(exitCode: number, stdout: string, stderr = ''): ScanRunner {
  return (_command: string, _args: string[]) => Promise.resolve({ exitCode, stdout, stderr });
}

/** Two-finding JSON payload that gitleaks emits on exit 1. */
const twoFindingsJson = JSON.stringify([
  {
    Description: 'AWS Access Key detected',
    File: 'config/secrets.env',
    RuleID: 'aws-access-key',
    StartLine: 3,
    EndLine: 3,
  },
  {
    Description: 'Generic API Key',
    File: 'src/client.ts',
    RuleID: 'generic-api-key',
    StartLine: 12,
    EndLine: 12,
  },
]);

// ---------------------------------------------------------------------------
// createGitleaksScanner — exit 0 / no findings
// ---------------------------------------------------------------------------

describe('createGitleaksScanner — exit 0, stdout []', () => {
  it('returns { ok: true } when gitleaks exits 0 and stdout is "[]"', async () => {
    const scanner = createGitleaksScanner({ run: mockRunner(0, '[]') });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.ok).toBe(true);
    expect(verdict.findings).toBeUndefined();
  });
});

describe('createGitleaksScanner — exit 0, stdout empty', () => {
  it('returns { ok: true } and does not crash when stdout is empty string', async () => {
    const scanner = createGitleaksScanner({ run: mockRunner(0, '') });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.ok).toBe(true);
    expect(verdict.findings).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createGitleaksScanner — exit 1 / findings found
// ---------------------------------------------------------------------------

describe('createGitleaksScanner — exit 1, two findings', () => {
  it('returns { ok: false } with findings array of length 2', async () => {
    const scanner = createGitleaksScanner({ run: mockRunner(1, twoFindingsJson) });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.ok).toBe(false);
    expect(verdict.findings).toHaveLength(2);
  });

  it('first finding mentions RuleID and File', async () => {
    const scanner = createGitleaksScanner({ run: mockRunner(1, twoFindingsJson) });
    const verdict = await scanner.scan('/tmp/project');
    const first = verdict.findings?.[0] ?? '';
    expect(first).toContain('aws-access-key');
    expect(first).toContain('config/secrets.env');
  });

  it('second finding mentions RuleID and File', async () => {
    const scanner = createGitleaksScanner({ run: mockRunner(1, twoFindingsJson) });
    const verdict = await scanner.scan('/tmp/project');
    const second = verdict.findings?.[1] ?? '';
    expect(second).toContain('generic-api-key');
    expect(second).toContain('src/client.ts');
  });
});

// ---------------------------------------------------------------------------
// createGitleaksScanner — exit > 1 / tool error
// ---------------------------------------------------------------------------

describe('createGitleaksScanner — exit 2, tool error', () => {
  it('returns { ok: false } on tool error (fail-closed)', async () => {
    const scanner = createGitleaksScanner({
      run: mockRunner(2, '', 'fatal: not a git repository'),
    });
    const verdict = await scanner.scan('/tmp/project');
    expect(verdict.ok).toBe(false);
  });

  it('finding mentions "gitleaks error" and includes stderr', async () => {
    const scanner = createGitleaksScanner({
      run: mockRunner(2, '', 'fatal: not a git repository'),
    });
    const verdict = await scanner.scan('/tmp/project');
    const finding = verdict.findings?.[0] ?? '';
    expect(finding).toContain('gitleaks error');
    expect(finding).toContain('fatal: not a git repository');
  });
});

// ---------------------------------------------------------------------------
// exit 1 but empty findings → fail-closed (anomalous report)
// ---------------------------------------------------------------------------

describe('createGitleaksScanner — exit 1 but empty findings (fail-closed)', () => {
  it('returns { ok: false } when exit 1 and stdout is empty', async () => {
    const scanner = createGitleaksScanner({ run: mockRunner(1, '') });
    const verdict = await scanner.scan('/tmp/x');
    expect(verdict.ok).toBe(false);
    expect(verdict.findings?.length).toBeGreaterThan(0);
  });

  it('returns { ok: false } when exit 1 and stdout is "[]"', async () => {
    const scanner = createGitleaksScanner({ run: mockRunner(1, '[]') });
    const verdict = await scanner.scan('/tmp/x');
    expect(verdict.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// exit 1 with unparseable or non-array output → clean fail-closed verdict (R4)
// ---------------------------------------------------------------------------

describe('createGitleaksScanner — exit 1 with unparseable or non-array output (R4, fail-closed)', () => {
  it('R4: exit 1 with malformed JSON resolves to a clean fail-closed verdict, not a crash', async () => {
    const scanner = createGitleaksScanner({ run: mockRunner(1, '[{"RuleID": "aws') });
    const verdict = await scanner.scan('/tmp/x');
    expect(verdict.ok).toBe(false);
    const finding = verdict.findings?.[0] ?? '';
    expect(finding).toContain('unparseable');
  });

  it('R4: exit 1 with a non-array JSON value ("{}") resolves to { ok: false }', async () => {
    const scanner = createGitleaksScanner({ run: mockRunner(1, '{}') });
    const verdict = await scanner.scan('/tmp/x');
    expect(verdict.ok).toBe(false);
    expect(verdict.findings?.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// isGitleaksAvailable — WhichFn-based (portable, no shell spawn)
// ---------------------------------------------------------------------------

const whichFound: WhichFn = () => '/usr/local/bin/gitleaks';
const whichNotFound: WhichFn = () => null;

describe('isGitleaksAvailable', () => {
  it('returns true when which returns a non-null path', async () => {
    const available = await isGitleaksAvailable(whichFound);
    expect(available).toBe(true);
  });

  it('returns false when which returns null', async () => {
    const available = await isGitleaksAvailable(whichNotFound);
    expect(available).toBe(false);
  });

  it('passes "gitleaks" as the command to which', async () => {
    let received: string | undefined;
    await isGitleaksAvailable((cmd) => {
      received = cmd;
      return '/usr/bin/gitleaks';
    });
    expect(received).toBe('gitleaks');
  });
});
