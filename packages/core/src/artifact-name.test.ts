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

import {
  assertSafeArtifactName,
  isSafeArtifactName,
  sanitizeIdForMessage,
  UnsafeArtifactNameError,
} from './artifact-name';

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

// ---------------------------------------------------------------------------
// isSafeArtifactName — predicate form (single source of truth for the rule)
// ---------------------------------------------------------------------------

describe('isSafeArtifactName — accepts safe segments', () => {
  it('accepts lowercase letters, digits, hyphen, underscore, dot', () => {
    expect(isSafeArtifactName('hello-rigger')).toBe(true);
    expect(isSafeArtifactName('skill_123')).toBe(true);
    expect(isSafeArtifactName('v1.2')).toBe(true);
    expect(isSafeArtifactName('MySkill')).toBe(true);
  });
});

describe('isSafeArtifactName — rejects unsafe segments', () => {
  it('rejects the empty string', () => {
    expect(isSafeArtifactName('')).toBe(false);
  });

  it('rejects "." and ".."', () => {
    expect(isSafeArtifactName('.')).toBe(false);
    expect(isSafeArtifactName('..')).toBe(false);
  });

  it('rejects segments with slash, backslash, colon, space or out-of-charset chars', () => {
    expect(isSafeArtifactName('a/b')).toBe(false);
    expect(isSafeArtifactName('a\\b')).toBe(false);
    expect(isSafeArtifactName('a:b')).toBe(false);
    expect(isSafeArtifactName('my skill')).toBe(false);
    expect(isSafeArtifactName('~x')).toBe(false);
  });
});

describe('isSafeArtifactName — is the rule assertSafeArtifactName enforces', () => {
  // Guards the delegation: the predicate and the assert can never diverge.
  const samples = ['ok-name', 'v1.2', '', '.', '..', 'a/b', 'a\\b', 'a:b', 'x y', '~z'];

  it('predicate false iff assertSafeArtifactName throws, for every sample', () => {
    for (const sample of samples) {
      const throws = (() => {
        try {
          assertSafeArtifactName(sample, `skill:${sample}`);
          return false;
        } catch {
          return true;
        }
      })();
      expect(throws).toBe(!isSafeArtifactName(sample));
    }
  });
});

// ---------------------------------------------------------------------------
// sanitizeIdForMessage — untrusted id is safe to print
// ---------------------------------------------------------------------------

describe('sanitizeIdForMessage — leaves printable ids readable', () => {
  it('passes through safe and printable characters unchanged', () => {
    expect(sanitizeIdForMessage('skill:hello-rigger')).toBe('skill:hello-rigger');
    expect(sanitizeIdForMessage('skill:../../evil')).toBe('skill:../../evil');
    expect(sanitizeIdForMessage('skill:a b~')).toBe('skill:a b~');
    // Non-ASCII printable letters stay readable (not control chars).
    expect(sanitizeIdForMessage('skill:café')).toBe('skill:café');
  });
});

describe('sanitizeIdForMessage — escapes control characters', () => {
  const ESC = String.fromCharCode(0x1b);
  const DEL = String.fromCharCode(0x7f);
  const CSI = String.fromCharCode(0x9b); // C1 CSI introducer

  it('escapes the ANSI escape byte (U+001B) as \\x1b, leaving no raw control', () => {
    const out = sanitizeIdForMessage(`skill:a${ESC}[31mevil`);
    expect(out).toContain('\\x1b');
    expect(out).not.toContain(ESC);
  });

  it('escapes CR and LF', () => {
    const out = sanitizeIdForMessage('a\r\nb');
    expect(out).toBe('a\\x0d\\x0ab');
  });

  it('escapes DEL (U+007F) and the C1 CSI introducer (U+009B)', () => {
    expect(sanitizeIdForMessage(`a${DEL}b`)).toBe('a\\x7fb');
    const out = sanitizeIdForMessage(`a${CSI}b`);
    expect(out).toBe('a\\x9bb');
    expect(out).not.toContain(CSI);
  });
});

describe('sanitizeIdForMessage — bounds the length', () => {
  it('truncates an over-long id and marks the cut', () => {
    const out = sanitizeIdForMessage('x'.repeat(500));
    expect(out.length).toBeLessThanOrEqual(123);
    expect(out.endsWith('...')).toBe(true);
  });

  it('is deterministic (same input → same output)', () => {
    const sample = `a${String.fromCharCode(0x1b)}b`;
    expect(sanitizeIdForMessage(sample)).toBe(sanitizeIdForMessage(sample));
  });
});

describe('UnsafeArtifactNameError — message carries no raw control characters', () => {
  it('sanitises a control-bearing id in the message but keeps id raw', () => {
    const raw = `skill:a${String.fromCharCode(0x1b)}[2Kevil`;
    const err = new UnsafeArtifactNameError(raw);
    expect(err.message).not.toContain(String.fromCharCode(0x1b));
    expect(err.message).toContain('\\x1b');
    // The programmatic id field stays verbatim.
    expect(err.id).toBe(raw);
  });
});
