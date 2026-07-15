/**
 * Tests for docs/tapes/lib/normalize.sh — the single definition of the volatile
 * fields of a recorded session (design D4). Two consumers rely on it: the R6
 * verdict and the T6 freshness workflow. A field left un-normalised produces a
 * false red verdict OR an undetected drift, so both directions are pinned here:
 *
 *   (a) volatile fields differing between two runs → identical after normalise;
 *   (b) a REAL divergence (message, exit code, renamed artefact, bumped semver)
 *       → still visible after normalise (an over-eager filter hides real drift);
 *   (c) screen GEOMETRY (trailing whitespace, rule width, blank-row padding that
 *       differs macOS↔Linux) erased, while real content (messages, order, values,
 *       content wraps, section separators) survives.
 */

import { expect, test } from 'bun:test';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'normalize.sh');

/** Run normalize.sh as a stdin→stdout filter and return its output. */
async function normalize(input: string): Promise<string> {
  const proc = Bun.spawn(['bash', SCRIPT], {
    stdin: new TextEncoder().encode(input),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`normalize.sh exited ${code}: ${err}`);
  return out;
}

// ---------------------------------------------------------------------------
// (a) volatile fields → stable across two independent runs
// ---------------------------------------------------------------------------

// Same session, two machines/runs: different mktemp suffix, different resolved
// binary paths (macOS vs Linux CI), different catalog checkout, different backup
// timestamp+token, different commit sha. Same normalised text is the invariant.
const runA = [
  'RIGGER_HOME = /tmp/rigger-rec.Ab3xK9',
  '✓ git (/opt/homebrew/bin/git)',
  '✓ gitleaks (/opt/homebrew/bin/gitleaks)',
  'Cloning into /var/folders/xy/9k2l3m4n5p6q0000gn/T/agent-rigger-catalog-Qz7Yh2',
  'Backed up /tmp/rigger-rec.Ab3xK9/.claude/settings.json.bak-2026-07-14T17-55-01.123Z-a1b2c3d4',
  'ref: 3f0a42ab1c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f',
  'jr/pack:baseline v0.4.0 @ 3f0a42ab1c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f',
  '[ok] Applied 3 file(s).',
].join('\n');

const runB = [
  'RIGGER_HOME = /tmp/rigger-rec.Zz9wQ1',
  '✓ git (/usr/bin/git)',
  '✓ gitleaks (/usr/local/bin/gitleaks)',
  'Cloning into /tmp/agent-rigger-catalog-Mn4Bx8',
  'Backed up /tmp/rigger-rec.Zz9wQ1/.claude/settings.json.bak-2026-07-14T18-01-59.999Z-99887766',
  'ref: 0011223344556677889900aabbccddeeff001122',
  'jr/pack:baseline v0.4.0 @ 0011223344556677889900aabbccddeeff001122',
  '[ok] Applied 3 file(s).',
].join('\n');

test('(a) volatile fields normalise to the same text across two runs', async () => {
  const a = await normalize(runA);
  const b = await normalize(runB);
  expect(a).toBe(b);
});

test('(a) each volatile field is replaced by its stable token', async () => {
  const out = await normalize(runA);
  expect(out).toContain('RIGGER_HOME = <RIGGER_HOME>');
  expect(out).toContain('✓ git (<path>)');
  expect(out).toContain('Cloning into <CATALOG_TMP>');
  expect(out).toContain('.claude/settings.json.bak-<TIMESTAMP>');
  expect(out).toContain('ref: <SHA>');
  // No raw volatile value survives.
  expect(out).not.toContain('/tmp/rigger-rec.Ab3xK9');
  expect(out).not.toContain('/opt/homebrew/bin/git');
  expect(out).not.toContain('agent-rigger-catalog-Qz7Yh2');
  expect(out).not.toContain('3f0a42ab1c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f');
  expect(out).not.toContain('a1b2c3d4');
});

// ---------------------------------------------------------------------------
// (b) real divergences must survive normalisation
// ---------------------------------------------------------------------------

test('(b) a changed message stays different', async () => {
  const x = await normalize('[ok] Applied 3 file(s).');
  const y = await normalize('[ok] Applied 4 file(s).');
  expect(x).not.toBe(y);
});

test('(b) a different exit code stays different', async () => {
  const x = await normalize('Exit code: 0');
  const y = await normalize('Exit code: 1');
  expect(x).not.toBe(y);
});

test('(b) a renamed artefact stays different', async () => {
  const x = await normalize('installed skills/hello-rigger');
  const y = await normalize('installed skills/hello-world');
  expect(x).not.toBe(y);
});

test('(b) a bumped semver tag stays different — a version change is real drift', async () => {
  const x = await normalize('jr/pack:baseline v0.4.0 @ 3f0a42ab1c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f');
  const y = await normalize('jr/pack:baseline v0.5.0 @ 3f0a42ab1c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f');
  expect(x).not.toBe(y);
  // The sha is erased (volatile) but the semver tag is preserved (real content).
  expect(x).toContain('v0.4.0');
  expect(x).toContain('<SHA>');
  expect(x).not.toContain('3f0a42ab1c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f');
});

test('(b) order is preserved — swapped lines stay different', async () => {
  const x = await normalize('doctor\nls\ninstall');
  const y = await normalize('doctor\ninstall\nls');
  expect(x).not.toBe(y);
});

// ---------------------------------------------------------------------------
// (c) screen geometry erased, real content preserved
// ---------------------------------------------------------------------------

const RULE40 = '─'.repeat(40);
const RULE50 = '─'.repeat(50);

// Same session captured with different screen geometry: the Linux runner pads
// lines with trailing spaces, emits extra blank rows per snapshot, and draws the
// rule at a different column count. None of that is content.
const geomMac = ['doctor', '', RULE40, '', '$ '].join('\n');
const geomLinux = ['doctor   ', '', '', '', RULE50, '', '', '$    '].join('\n');

test('(c) geometry-only differences normalise to the same text', async () => {
  const a = await normalize(geomMac);
  const b = await normalize(geomLinux);
  expect(a).toBe(b);
});

test('(c) trailing whitespace, rule width and blank runs are all erased', async () => {
  const out = await normalize(geomLinux);
  expect(out).toContain('<RULE>'); // the ─ run, whatever its width
  expect(out).not.toMatch(/[ \t]+\n/); // no trailing whitespace on any line
  expect(out).not.toMatch(/\n\n\n/); // no run of blank lines survives (collapsed)
  expect(out).not.toContain('─'); // no raw rule character left
});

test('(c) a single blank line survives as a section separator (collapse, not delete)', async () => {
  // Many blank rows (snapshot padding) collapse to exactly one — the separator is
  // kept, not deleted, so section breaks stay legible.
  const out = await normalize('deps\n\n\n\n\nmode : full scan\n');
  expect(out).toContain('deps\n\nmode : full scan');
  expect(out).not.toMatch(/\n\n\n/);
});

test('(c) content wraps are preserved verbatim (the wrap is content, not geometry)', async () => {
  // A long finding the terminal wrapped across two physical lines. The split must
  // survive — merging wraps would hide a real change to the message.
  const wrapped = '  - [gitleaks] aws-access-token: … risking unauthorized cloud reso\n'
    + 'urce access and data breaches.';
  const out = await normalize(wrapped);
  expect(out).toContain('cloud reso\nurce access');
});

test('(c) the vertical bar of a content preview is not a rule and is kept', async () => {
  const out = await normalize('  write +338 / -0\n     │ # Agent Context');
  expect(out).toContain('│ # Agent Context');
  expect(out).not.toContain('<RULE>');
});

test('(c) a short ─ run (<4) is content, not a rule, and is left intact', async () => {
  const out = await normalize('─── three dashes');
  expect(out).toContain('─── three dashes');
  expect(out).not.toContain('<RULE>');
});
