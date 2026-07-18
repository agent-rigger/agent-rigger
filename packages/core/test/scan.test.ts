/**
 * Tests for scan.ts — the security-scan seam.
 */

import { describe, expect, it } from 'bun:test';

import { constantScanner, type Scanner, stubScanner } from '../src/scan';
import type { Verdict } from '../src/types';

describe('stubScanner', () => {
  it('passes for any source path', async () => {
    const verdict = await stubScanner.scan('/some/skill/source');
    expect(verdict.ok).toBe(true);
  });

  it('passes for an empty source', async () => {
    const verdict = await stubScanner.scan('');
    expect(verdict.ok).toBe(true);
  });

  it('returns no findings', async () => {
    const verdict = await stubScanner.scan('/x');
    expect(verdict.findings).toBeUndefined();
  });

  it('conforms to the Scanner interface', () => {
    const scanner: Scanner = stubScanner;
    expect(typeof scanner.scan).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// constantScanner
// ---------------------------------------------------------------------------

describe('constantScanner', () => {
  it('resolves the given passing verdict for any source path', async () => {
    const verdict: Verdict = { ok: true };
    const scanner = constantScanner(verdict);

    const result = await scanner.scan('/some/apply-time/source');

    expect(result).toBe(verdict);
    expect(result.ok).toBe(true);
  });

  it('restitutes a blocking verdict findings as-is', async () => {
    const verdict: Verdict = {
      ok: false,
      findings: ['[gitleaks] aws-access-key', '[trivy] CVE-2024-1234'],
    };
    const scanner = constantScanner(verdict);

    const result = await scanner.scan('/some/source');

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(['[gitleaks] aws-access-key', '[trivy] CVE-2024-1234']);
    // Same reference: the union verdict is threaded verbatim, never rebuilt.
    expect(result).toBe(verdict);
  });

  it('restitutes a degraded verdict', async () => {
    const verdict: Verdict = { ok: true, degraded: true };
    const scanner = constantScanner(verdict);

    const result = await scanner.scan('/x');

    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result).toBe(verdict);
  });

  it('ignores its source argument — distinct paths yield the same constant verdict', async () => {
    const verdict: Verdict = { ok: true };
    const scanner = constantScanner(verdict);

    const first = await scanner.scan('/path/one');
    const second = await scanner.scan('/path/two/much/deeper');

    // Identity across distinct arguments proves the argument is ignored AND that
    // no scanner tool ran (a real scanner would mint a fresh verdict per call).
    expect(first).toBe(second);
    expect(first).toBe(verdict);
  });
});
