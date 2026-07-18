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
import path from 'node:path';

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
// R7 — File rebased to checkout-relative when gitleaks reports an absolute path
// (gitleaks 8.30.1 emits an ABSOLUTE File for `detect --source <dir>`; the dir
// scanned is the union staging mirror, so relativising it yields the exact
// checkout-relative path the attribution must carry).
// ---------------------------------------------------------------------------

describe('createGitleaksScanner — R7 File rebasing', () => {
  it('R7: rebases an absolute File under the scanned dir to a checkout-relative path', async () => {
    const dir = '/tmp/rig-scan-staging-abc';
    const absFile = path.join(dir, 'skills', 'api-helper', 'SKILL.md');
    const json = JSON.stringify([
      { Description: 'AWS key', File: absFile, RuleID: 'aws-access-key' },
    ]);
    const scanner = createGitleaksScanner({ run: mockRunner(1, json) });

    const verdict = await scanner.scan(dir);

    const finding = verdict.findings?.[0] ?? '';
    expect(finding).toContain('skills/api-helper/SKILL.md');
    expect(finding).not.toContain(dir);
  });

  it('R7: leaves an already-relative File unchanged', async () => {
    const scanner = createGitleaksScanner({ run: mockRunner(1, twoFindingsJson) });

    const verdict = await scanner.scan('/tmp/rig-scan-staging-abc');

    expect(verdict.findings?.[0]).toContain('config/secrets.env');
    expect(verdict.findings?.[1]).toContain('src/client.ts');
  });
});

// ---------------------------------------------------------------------------
// Clamp — a File escaping the scanned dir is reduced to the basename sentinel,
// never leaking the host path (D1 / m1, shared helper).
// ---------------------------------------------------------------------------

describe('createGitleaksScanner — File outside the scanned dir is clamped', () => {
  it('clamps an absolute File outside the staging dir to <outside-scan-root>, host path absent', async () => {
    const dir = '/tmp/rig-scan-staging-abc';
    const json = JSON.stringify([
      { Description: 'leaked host secret', File: '/etc/passwd', RuleID: 'generic-api-key' },
    ]);
    const scanner = createGitleaksScanner({ run: mockRunner(1, json) });

    const verdict = await scanner.scan(dir);

    const finding = verdict.findings?.[0] ?? '';
    expect(finding).toContain('<outside-scan-root>/passwd');
    expect(finding).not.toContain('/etc');
  });
});

// ---------------------------------------------------------------------------
// Tool-error stderr sanitisation — the scanned dir is scrubbed to <scan-root>
// so a tool-level error (exit > 1) never leaks the mkdtemp staging path (m2).
// ---------------------------------------------------------------------------

describe('createGitleaksScanner — exit 2 stderr sanitisation', () => {
  it('substitutes the scanned dir in the error finding with <scan-root>', async () => {
    const dir = '/tmp/rig-scan-staging-abc';
    const stderr = `fatal: could not open ${dir}/skills/x/SKILL.md: permission denied`;
    const scanner = createGitleaksScanner({ run: mockRunner(2, '', stderr) });

    const verdict = await scanner.scan(dir);

    const finding = verdict.findings?.[0] ?? '';
    expect(finding).toContain('<scan-root>');
    expect(finding).not.toContain(dir);
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
