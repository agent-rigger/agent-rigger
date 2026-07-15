/**
 * Tests for docs/tapes/lib/normalize.sh — the single definition of the volatile
 * fields of a recorded session (design D4). Two consumers rely on it: the R6
 * verdict and the T6 freshness workflow. A field left un-normalised produces a
 * false red verdict OR an undetected drift, so both directions are pinned here:
 *
 *   (a) volatile fields differing between two runs → identical after normalise;
 *   (b) a REAL divergence (message, exit code, renamed artefact, bumped semver)
 *       → still visible after normalise (an over-eager filter hides real drift).
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
