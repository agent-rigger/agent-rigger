/**
 * version.test.ts — pure version resolution/normalisation logic.
 *
 * These tests exercise the resolver WITHOUT a compiled build: the build-time
 * `__AR_VERSION__` define is simulated by passing values directly to
 * `resolveCliVersion`. This is the contract that guarantees a source build
 * reports a version coherent with the git tags, while falling back to the
 * package.json sentinel when git is unavailable.
 */

import { describe, expect, it } from 'bun:test';

import { normalizeVersion, resolveCliVersion } from '../src/version';

describe('normalizeVersion', () => {
  it('strips a single leading "v" from a tag', () => {
    expect(normalizeVersion('v0.1.2')).toBe('0.1.2');
  });

  it('keeps a value that has no leading "v"', () => {
    expect(normalizeVersion('0.1.2')).toBe('0.1.2');
  });

  it('normalises a git describe with commits ahead and sha', () => {
    expect(normalizeVersion('v0.1.2-62-gecbd28e')).toBe('0.1.2-62-gecbd28e');
  });

  it('preserves the -dirty suffix', () => {
    expect(normalizeVersion('v0.1.2-dirty')).toBe('0.1.2-dirty');
  });

  it('trims surrounding whitespace (git output has a trailing newline)', () => {
    expect(normalizeVersion('  v0.1.2\n')).toBe('0.1.2');
  });

  it('only strips the FIRST leading "v", not a "v" inside the string', () => {
    expect(normalizeVersion('version')).toBe('ersion');
  });

  it('returns empty string for undefined', () => {
    expect(normalizeVersion(undefined)).toBe('');
  });

  it('returns empty string for null', () => {
    expect(normalizeVersion(null)).toBe('');
  });

  it('returns empty string for empty / whitespace-only input', () => {
    expect(normalizeVersion('')).toBe('');
    expect(normalizeVersion('   ')).toBe('');
  });
});

describe('resolveCliVersion', () => {
  it('prefers a non-empty injected define over the package sentinel', () => {
    expect(resolveCliVersion('v0.1.2', '0.0.0')).toBe('0.1.2');
  });

  it('on an exact tag yields the format stamped by the release workflow', () => {
    // release.yml stamps `${GITHUB_REF_NAME#v}` → `0.1.2`; a source build of the
    // same commit must resolve identically.
    expect(resolveCliVersion('v0.1.2', '0.0.0')).toBe('0.1.2');
  });

  it('falls back to the package version when the define is undefined (no build inject)', () => {
    expect(resolveCliVersion(undefined, '0.0.0')).toBe('0.0.0');
  });

  it('falls back to the package version when the define is empty (git failed)', () => {
    expect(resolveCliVersion('', '0.0.0')).toBe('0.0.0');
  });

  it('falls back when the define is whitespace-only', () => {
    expect(resolveCliVersion('   ', '0.0.0')).toBe('0.0.0');
  });

  it('fallback uses the stamped sentinel (release path: define absent, pkg = tag)', () => {
    // In the release workflow the define is never injected (its build step does
    // not run scripts/build.ts); package.json has been stamped with the tag.
    expect(resolveCliVersion(undefined, '0.1.2')).toBe('0.1.2');
  });

  it('normalises the injected value defensively even if not pre-stripped', () => {
    expect(resolveCliVersion('  v2.0.0\n', '0.0.0')).toBe('2.0.0');
  });
});
