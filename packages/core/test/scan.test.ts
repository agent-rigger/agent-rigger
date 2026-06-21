/**
 * Tests for scan.ts — the security-scan seam (R10).
 */

import { describe, expect, it } from 'bun:test';

import { type Scanner, stubScanner } from '../src/scan';

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
