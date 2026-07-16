/**
 * Tests for scripts/release-changelog.ts — the scripted changelog rotation
 * (decision C1). The rotation runs at release time with zero LLM in the loop,
 * so its behaviour is pinned here on fixtures:
 *
 *   - nominal: entries move under `## [X.Y.Z] - date`, the intro paragraph stays
 *     under Unreleased, and the link refs are rewritten (compare + tag);
 *   - fail-closed: the section already exists (idempotence guard), Unreleased is
 *     empty (empty-release guard), or a required anchor is missing.
 */

import { describe, expect, test } from 'bun:test';
import { rotateChangelog, RotationError, today } from './release-changelog';

const BASE = 'https://github.com/agent-rigger/agent-rigger';

/** A CHANGELOG with an intro paragraph plus two entry subsections. */
const WITH_INTRO = `# Changelog

All notable changes to this project are documented here.

## [Unreleased]

agent-rigger is pre-1.0 (milestone M0). Pre-built binaries are published with each
release.

### Added

- **\`check\`** — audit the installed harness.
- **\`install\`** — interactive picker.

### Invariants

Idempotence, backup-before-write, human-in-the-loop hold across all commands.

[Unreleased]: ${BASE}/commits/main
`;

describe('rotateChangelog — nominal', () => {
  const out = rotateChangelog(WITH_INTRO, '0.1.0', { date: '2026-07-16' });

  test('creates a dated version section with the moved entries', () => {
    expect(out).toContain('## [0.1.0] - 2026-07-16');
    // The entries land under the new section.
    expect(out).toContain('### Added');
    expect(out).toContain('### Invariants');
    expect(out).toContain('- **`check`** — audit the installed harness.');
  });

  test('keeps the intro paragraph under Unreleased, not in the release', () => {
    const unreleasedIdx = out.indexOf('## [Unreleased]');
    const versionIdx = out.indexOf('## [0.1.0]');
    const introIdx = out.indexOf('agent-rigger is pre-1.0');
    // Intro sits between the Unreleased heading and the new version section.
    expect(introIdx).toBeGreaterThan(unreleasedIdx);
    expect(introIdx).toBeLessThan(versionIdx);
  });

  test('empties the Unreleased entries (no `###` between Unreleased and the release)', () => {
    const unreleasedBlock = out.slice(
      out.indexOf('## [Unreleased]'),
      out.indexOf('## [0.1.0]'),
    );
    expect(unreleasedBlock).not.toContain('### Added');
    expect(unreleasedBlock).not.toContain('### Invariants');
  });

  test('rewrites the link references (compare + tag)', () => {
    expect(out).toContain(`[Unreleased]: ${BASE}/compare/v0.1.0...main`);
    expect(out).toContain(`[0.1.0]: ${BASE}/releases/tag/v0.1.0`);
    // The old plain `commits/main` ref is gone.
    expect(out).not.toContain(`[Unreleased]: ${BASE}/commits/main`);
  });

  test('the Unreleased ref precedes the version ref', () => {
    expect(out.indexOf('[Unreleased]: ')).toBeLessThan(out.indexOf('[0.1.0]: '));
  });

  test('ends with exactly one trailing newline', () => {
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });
});

describe('rotateChangelog — no intro paragraph', () => {
  const noIntro = `# Changelog

## [Unreleased]

### Added

- A new thing.

[Unreleased]: ${BASE}/commits/main
`;

  test('rotates entries and leaves an empty Unreleased', () => {
    const out = rotateChangelog(noIntro, '1.0.0', { date: '2026-07-16' });
    expect(out).toContain('## [1.0.0] - 2026-07-16');
    expect(out).toContain('- A new thing.');
    const unreleasedBlock = out.slice(
      out.indexOf('## [Unreleased]'),
      out.indexOf('## [1.0.0]'),
    );
    expect(unreleasedBlock.trim()).toBe('## [Unreleased]');
  });
});

describe('rotateChangelog — with a prior release', () => {
  const withPrior = `# Changelog

## [Unreleased]

### Fixed

- A regression.

## [0.1.0] - 2026-01-01

### Added

- The first thing.

[Unreleased]: ${BASE}/compare/v0.1.0...main
[0.1.0]: ${BASE}/releases/tag/v0.1.0
`;

  const out = rotateChangelog(withPrior, '0.2.0', { date: '2026-07-16' });

  test('inserts the new release above the older one', () => {
    expect(out.indexOf('## [0.2.0]')).toBeLessThan(out.indexOf('## [0.1.0]'));
  });

  test('preserves the older release section and its ref', () => {
    expect(out).toContain('## [0.1.0] - 2026-01-01');
    expect(out).toContain('- The first thing.');
    expect(out).toContain(`[0.1.0]: ${BASE}/releases/tag/v0.1.0`);
  });

  test('rewrites the Unreleased compare ref to the new tag', () => {
    expect(out).toContain(`[Unreleased]: ${BASE}/compare/v0.2.0...main`);
  });

  test('emits a compare ref for the new version, spanning from the previous tag', () => {
    // File convention is `compare`; the tag is derived from the most recent
    // existing version ref (0.1.0), not hard-coded to releases/tag.
    expect(out).toContain(`[0.2.0]: ${BASE}/compare/v0.1.0...v0.2.0`);
    expect(out).not.toContain(`[0.2.0]: ${BASE}/releases/tag/v0.2.0`);
  });
});

describe('rotateChangelog — fail-closed guards', () => {
  test('refuses when the version section already exists (idempotence)', () => {
    const alreadyRotated = rotateChangelog(WITH_INTRO, '0.1.0', { date: '2026-07-16' });
    expect(() => rotateChangelog(alreadyRotated, '0.1.0', { date: '2026-07-16' })).toThrow(
      RotationError,
    );
  });

  test('refuses when Unreleased is empty (no entries to release)', () => {
    const empty = `# Changelog

## [Unreleased]

agent-rigger is pre-1.0. Nothing shipped yet.

[Unreleased]: ${BASE}/commits/main
`;
    expect(() => rotateChangelog(empty, '0.1.0', { date: '2026-07-16' })).toThrow(RotationError);
  });

  test('refuses when there is no Unreleased section at all', () => {
    const none = `# Changelog

## [0.1.0] - 2026-01-01

### Added

- Thing.

[0.1.0]: ${BASE}/releases/tag/v0.1.0
`;
    expect(() => rotateChangelog(none, '0.2.0', { date: '2026-07-16' })).toThrow(RotationError);
  });

  test('refuses when the Unreleased link ref is missing', () => {
    const noRef = `# Changelog

## [Unreleased]

### Added

- Thing.
`;
    expect(() => rotateChangelog(noRef, '0.1.0', { date: '2026-07-16' })).toThrow(RotationError);
  });

  test('rejects a non-semver version argument', () => {
    expect(() => rotateChangelog(WITH_INTRO, 'v0.1', { date: '2026-07-16' })).toThrow(
      RotationError,
    );
  });
});

describe('today()', () => {
  test('formats a fixed date as YYYY-MM-DD', () => {
    expect(today(new Date('2026-07-16T18:11:00Z'))).toBe('2026-07-16');
  });
});
