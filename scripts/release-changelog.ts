#!/usr/bin/env bun
/**
 * release-changelog — rotate the CHANGELOG for a release (decision C1).
 *
 * Zero-LLM, zero external dependency. Moves the ENTRIES under `## [Unreleased]`
 * (the `###` subsections — never the intro paragraph, if any) into a fresh
 * `## [X.Y.Z] - YYYY-MM-DD` section, empties Unreleased, and rewrites the link
 * reference block at the foot of the file:
 *
 *     [Unreleased]: <base>/compare/vX.Y.Z...main
 *     [X.Y.Z]:      <base>/compare/v<prev>...vX.Y.Z   (<prev> = the most recent
 *                   existing version ref; the very first release, which has no
 *                   prior tag, keeps <base>/releases/tag/vX.Y.Z instead)
 *
 * The repository base URL is derived from the existing `[Unreleased]:` ref, so
 * the script carries no hard-coded remote.
 *
 * Fail-closed by design:
 *   - the `## [X.Y.Z]` section already exists  → refuse (idempotent no-op guard);
 *   - Unreleased has no entries to release     → refuse (empty release guard);
 *   - `## [Unreleased]` or its link ref missing → refuse.
 *
 * Usage:  bun scripts/release-changelog.ts <version>
 *   e.g.  bun scripts/release-changelog.ts 0.1.0
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Raised for every expected refusal; the CLI maps it to exit code 1. */
export class RotationError extends Error {
  override name = 'RotationError';
}

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** `## [Unreleased]` (exact label, start of line). */
const UNRELEASED_HEADING = /^## \[Unreleased\]\s*$/;
/** Any versioned section heading: `## [x.y.z] - ...` or `## [Unreleased]`. */
const SECTION_HEADING = /^## \[/;
/** An entry subsection: `### Added`, `### Fixed`, … */
const SUBSECTION_HEADING = /^### /;
/** A link reference definition: `[label]: url`. */
const REF_DEFINITION = /^\[[^\]]+\]:\s+\S/;

export interface RotateOptions {
  /** Release date, `YYYY-MM-DD`. Injected so the transform stays deterministic. */
  date: string;
}

/**
 * Pure transform: takes the CHANGELOG text and returns the rotated text.
 * Never touches the filesystem. Throws {@link RotationError} on any refusal.
 */
export function rotateChangelog(content: string, version: string, options: RotateOptions): string {
  if (!SEMVER.test(version)) {
    throw new RotationError(`Invalid version "${version}" — expected X.Y.Z (semver).`);
  }

  const alreadyReleased = new RegExp(`^## \\[${escapeRegExp(version)}\\]`, 'm');
  if (alreadyReleased.test(content)) {
    throw new RotationError(
      `CHANGELOG already has a "## [${version}]" section — nothing to rotate.`,
    );
  }

  const lines = content.split('\n');

  // Split off the trailing link-reference block (contiguous run of ref
  // definitions and blank lines at the foot of the file).
  const refBlockStart = findRefBlockStart(lines);
  const bodyLines = lines.slice(0, refBlockStart);
  const refLines = lines.slice(refBlockStart).filter((l) => REF_DEFINITION.test(l));

  // Locate the Unreleased section within the body.
  const urIdx = bodyLines.findIndex((l) => UNRELEASED_HEADING.test(l));
  if (urIdx === -1) {
    throw new RotationError('CHANGELOG has no "## [Unreleased]" section.');
  }

  // Body of Unreleased = everything up to the next `## [` heading (older release).
  let urBodyEnd = bodyLines.length;
  for (let i = urIdx + 1; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    if (line !== undefined && SECTION_HEADING.test(line)) {
      urBodyEnd = i;
      break;
    }
  }
  const unreleasedBody = bodyLines.slice(urIdx + 1, urBodyEnd);

  // Intro = leading prose before the first `###`; entries = the rest.
  const firstSub = unreleasedBody.findIndex((l) => SUBSECTION_HEADING.test(l));
  const intro = trimBlank(firstSub === -1 ? unreleasedBody : unreleasedBody.slice(0, firstSub));
  const entries = trimBlank(firstSub === -1 ? [] : unreleasedBody.slice(firstSub));

  if (entries.length === 0) {
    throw new RotationError(
      'Nothing under "## [Unreleased]" to release — add changelog entries first.',
    );
  }

  // Rebuild the link references: derive the repo base from the Unreleased ref.
  const unreleasedRef = refLines.find((l) => l.startsWith('[Unreleased]:'));
  if (unreleasedRef === undefined) {
    throw new RotationError('CHANGELOG has no "[Unreleased]:" link reference to rewrite.');
  }
  const base = repoBaseFrom(unreleasedRef);
  const priorRefs = refLines.filter((l) => !l.startsWith('[Unreleased]:'));
  // Derive the previous tag from the most recent existing version ref (refs are
  // ordered newest-first). With a prior release, follow the file's `compare`
  // convention; the very first release has nothing to compare against, so it
  // keeps `releases/tag`.
  const mostRecentPrior = priorRefs[0];
  const prevVersion = mostRecentPrior === undefined ? undefined : refLabel(mostRecentPrior);
  const versionRef = prevVersion === undefined
    ? `[${version}]: ${base}/releases/tag/v${version}`
    : `[${version}]: ${base}/compare/v${prevVersion}...v${version}`;
  const newRefs = [
    `[Unreleased]: ${base}/compare/v${version}...main`,
    versionRef,
    ...priorRefs,
  ];

  // Reassemble.
  const header = trimBlank(bodyLines.slice(0, urIdx)).join('\n');
  const olderReleases = trimBlank(bodyLines.slice(urBodyEnd)).join('\n');

  const unreleasedSection = intro.length > 0
    ? `## [Unreleased]\n\n${intro.join('\n')}`
    : '## [Unreleased]';
  const newSection = `## [${version}] - ${options.date}\n\n${entries.join('\n')}`;

  const blocks = [header, unreleasedSection, newSection, olderReleases, newRefs.join('\n')].filter(
    (b) => b.length > 0,
  );

  return `${blocks.join('\n\n')}\n`;
}

/** Index of the first line of the trailing link-reference block (ref defs + blanks). */
function findRefBlockStart(lines: readonly string[]): number {
  let start = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line !== undefined && (line.trim() === '' || REF_DEFINITION.test(line))) {
      start = i;
      continue;
    }
    break;
  }
  return start;
}

/** The label of a `[label]: url` line, e.g. `[0.1.0]: …` → `0.1.0`. */
function refLabel(refLine: string): string | undefined {
  return refLine.match(/^\[([^\]]+)\]:/)?.[1];
}

/** `https://host/owner/repo` extracted from a `[label]: url` line. */
function repoBaseFrom(refLine: string): string {
  const url = refLine.replace(/^\[[^\]]+\]:\s+/, '').trim();
  const match = url.match(/^(https?:\/\/[^/]+\/[^/]+\/[^/]+)/);
  if (match === null || match[1] === undefined) {
    throw new RotationError(`Cannot derive repository base URL from ref: "${refLine}".`);
  }
  return match[1];
}

/** Drop leading and trailing blank lines. */
function trimBlank(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? '').trim() === '') start++;
  while (end > start && (lines[end - 1] ?? '').trim() === '') end--;
  return lines.slice(start, end);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Today in `YYYY-MM-DD` (UTC), for the release-date stamp. */
export function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

if (import.meta.main) {
  const version = process.argv[2];
  if (version === undefined || version.length === 0) {
    console.error('usage: bun scripts/release-changelog.ts <version>');
    process.exit(1);
  }
  const changelogPath = join(import.meta.dir, '..', 'CHANGELOG.md');
  try {
    const content = readFileSync(changelogPath, 'utf8');
    const rotated = rotateChangelog(content, version, { date: today() });
    writeFileSync(changelogPath, rotated);
    console.error(`CHANGELOG rotated: [Unreleased] → [${version}] - ${today()}`);
  } catch (err) {
    if (err instanceof RotationError) {
      console.error(`release-changelog: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
