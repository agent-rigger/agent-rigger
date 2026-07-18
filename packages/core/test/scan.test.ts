/**
 * Tests for scan.ts — the security-scan seam.
 */

import { describe, expect, it } from 'bun:test';
import path from 'node:path';

import { constantScanner, memoizeScanner, type Scanner, stubScanner } from '../src/scan';
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
// memoizeScanner
// ---------------------------------------------------------------------------

/** Scanner that records every path it was called with and returns a distinct verdict per path. */
function countingScanner(): { scanner: Scanner; calls: string[] } {
  const calls: string[] = [];
  const scanner: Scanner = {
    scan: (source: string) => {
      calls.push(source);
      return Promise.resolve({ ok: true, findings: [`scan#${calls.length}:${source}`] });
    },
  };
  return { scanner, calls };
}

describe('memoizeScanner', () => {
  it('calls inner.scan once when the same absolute path is scanned twice', async () => {
    const { scanner: inner, calls } = countingScanner();
    const memoized = memoizeScanner(inner);

    const abs = path.resolve('/tmp/rigger-memo-test/skills/demo');
    await memoized.scan(abs);
    await memoized.scan(abs);

    expect(calls).toHaveLength(1);
  });

  it('calls inner.scan once per distinct path across N distinct paths', async () => {
    const { scanner: inner, calls } = countingScanner();
    const memoized = memoizeScanner(inner);

    const a = path.resolve('/tmp/rigger-memo-test/skills/a');
    const b = path.resolve('/tmp/rigger-memo-test/skills/b');
    const c = path.resolve('/tmp/rigger-memo-test/skills/c');

    await memoized.scan(a);
    await memoized.scan(b);
    await memoized.scan(c);
    await memoized.scan(a);
    await memoized.scan(b);

    expect(calls).toHaveLength(3);
  });

  it('returns the verdict produced by inner.scan (identity, not a copy-mutation)', async () => {
    const { scanner: inner } = countingScanner();
    const memoized = memoizeScanner(inner);

    const abs = path.resolve('/tmp/rigger-memo-test/skills/demo');
    const first = await memoized.scan(abs);
    const second = await memoized.scan(abs);

    expect(second).toEqual(first);
    expect(first.findings?.[0]).toBe(`scan#1:${abs}`);
  });

  it('normalises non-absolute / non-canonical paths to the same cache entry (path.resolve)', async () => {
    const { scanner: inner, calls } = countingScanner();
    const memoized = memoizeScanner(inner);

    const base = path.resolve('/tmp/rigger-memo-test/skills/demo');
    const withTrailingSegment = path.join(base, '..', 'demo');

    await memoized.scan(base);
    await memoized.scan(withTrailingSegment);

    expect(calls).toHaveLength(1);
  });

  it('propagates a blocking verdict from inner.scan without re-invoking it', async () => {
    let callCount = 0;
    const blocking: Scanner = {
      scan: (_source: string) => {
        callCount += 1;
        return Promise.resolve({ ok: false, findings: ['[gitleaks] aws-access-key'] });
      },
    };
    const memoized = memoizeScanner(blocking);

    const abs = path.resolve('/tmp/rigger-memo-test/skills/blocked');
    const first = await memoized.scan(abs);
    const second = await memoized.scan(abs);

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(second.findings).toEqual(first.findings);
    expect(callCount).toBe(1);
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
