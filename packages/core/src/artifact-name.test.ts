/**
 * Tests for core/src/artifact-name.ts — assertSafeArtifactName + UnsafeArtifactNameError.
 *
 * TDD: tests written to drive the security implementation.
 *
 * Coverage:
 *  - accepted names: letters, digits, hyphen, underscore, dot
 *  - rejected: empty string, '.', '..', path traversal segments, slashes, colons
 *  - UnsafeArtifactNameError carries the original id
 */

import { describe, expect, it } from 'bun:test';

import { assertSafeArtifactName, UnsafeArtifactNameError } from './artifact-name';

// ---------------------------------------------------------------------------
// Accepted names
// ---------------------------------------------------------------------------

describe('assertSafeArtifactName — accepted names', () => {
  it('accepts lowercase letters', () => {
    expect(() => assertSafeArtifactName('my-skill', 'skill:my-skill')).not.toThrow();
  });

  it('accepts uppercase letters', () => {
    expect(() => assertSafeArtifactName('MySkill', 'skill:MySkill')).not.toThrow();
  });

  it('accepts digits', () => {
    expect(() => assertSafeArtifactName('skill123', 'skill:skill123')).not.toThrow();
  });

  it('accepts hyphens', () => {
    expect(() => assertSafeArtifactName('spec-workflow', 'skill:spec-workflow')).not.toThrow();
  });

  it('accepts underscores', () => {
    expect(() => assertSafeArtifactName('my_skill', 'skill:my_skill')).not.toThrow();
  });

  it('accepts dots (e.g. version components)', () => {
    expect(() => assertSafeArtifactName('skill.v2', 'skill:skill.v2')).not.toThrow();
  });

  it('accepts mixed alphanumeric + hyphen + dot', () => {
    expect(() => assertSafeArtifactName('react-coding-standards', 'skill:react-coding-standards'))
      .not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Rejected names — path traversal
// ---------------------------------------------------------------------------

describe('assertSafeArtifactName — rejects path traversal segments', () => {
  it('rejects ".."', () => {
    expect(() => assertSafeArtifactName('..', 'skill:..')).toThrow(UnsafeArtifactNameError);
  });

  it('rejects "."', () => {
    expect(() => assertSafeArtifactName('.', 'skill:.')).toThrow(UnsafeArtifactNameError);
  });

  it('rejects name containing forward slash', () => {
    expect(() => assertSafeArtifactName('../../etc/evil', 'skill:../../etc/evil')).toThrow(
      UnsafeArtifactNameError,
    );
  });

  it('rejects name starting with ../', () => {
    expect(() => assertSafeArtifactName('../evil', 'skill:../evil')).toThrow(
      UnsafeArtifactNameError,
    );
  });

  it('rejects name containing backslash', () => {
    expect(() => assertSafeArtifactName('..\\evil', 'skill:..\\evil')).toThrow(
      UnsafeArtifactNameError,
    );
  });
});

// ---------------------------------------------------------------------------
// Rejected names — other unsafe characters
// ---------------------------------------------------------------------------

describe('assertSafeArtifactName — rejects other unsafe characters', () => {
  it('rejects empty string', () => {
    // empty string from id "skill:" (prefix only)
    expect(() => assertSafeArtifactName('', 'skill:')).toThrow(UnsafeArtifactNameError);
  });

  it('rejects colon (second colon in id like "skill:a:b")', () => {
    expect(() => assertSafeArtifactName('a:b', 'skill:a:b')).toThrow(UnsafeArtifactNameError);
  });

  it('rejects space', () => {
    expect(() => assertSafeArtifactName('my skill', 'skill:my skill')).toThrow(
      UnsafeArtifactNameError,
    );
  });

  it('rejects null byte', () => {
    expect(() => assertSafeArtifactName('evil\0name', 'skill:evil\0name')).toThrow(
      UnsafeArtifactNameError,
    );
  });

  it('rejects semicolon', () => {
    expect(() => assertSafeArtifactName('evil;rm', 'skill:evil;rm')).toThrow(
      UnsafeArtifactNameError,
    );
  });
});

// ---------------------------------------------------------------------------
// UnsafeArtifactNameError — carries the original id
// ---------------------------------------------------------------------------

describe('UnsafeArtifactNameError — carries original id property', () => {
  it('error.id matches the original catalog id', () => {
    try {
      assertSafeArtifactName('../evil', 'skill:../evil');
      expect(true).toBe(false); // should not reach
    } catch (e) {
      expect(e).toBeInstanceOf(UnsafeArtifactNameError);
      expect((e as UnsafeArtifactNameError).id).toBe('skill:../evil');
    }
  });

  it('error.name is UnsafeArtifactNameError', () => {
    try {
      assertSafeArtifactName('..', 'skill:..');
    } catch (e) {
      expect((e as UnsafeArtifactNameError).name).toBe('UnsafeArtifactNameError');
    }
  });

  it('error message mentions the id', () => {
    try {
      assertSafeArtifactName('../../../../etc/evil', 'skill:../../../../etc/evil');
    } catch (e) {
      expect((e as UnsafeArtifactNameError).message).toMatch(
        /skill:\.\.\/\.\.\/\.\.\/\.\.\/etc\/evil/,
      );
    }
  });
});
