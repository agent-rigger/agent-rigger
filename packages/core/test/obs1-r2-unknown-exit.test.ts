/**
 * obs1-R2 — ArtifactState gains 'unknown'; reportExitCode treats it as
 * advisory (never exit 3), and pre-existing state derivations are unchanged.
 *
 * Scope: core/src/types.ts (ArtifactState union) + core/src/engine.ts
 * (reportExitCode). This is a pure derivation over Report objects built by
 * hand — no adapter, no filesystem, no process spawn (T1 of obs1-plugin-reads
 * is the core-only slice; the on-disk probe that actually produces 'unknown'
 * ships in T2).
 *
 * TDD: written before the engine.ts/types.ts edits landed.
 */

import { describe, expect, it } from 'bun:test';

import { reportExitCode } from '../src/engine';
import type { NatureReport, Report } from '../src/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function entry(id: string, state: NatureReport['state'], detail?: string): NatureReport {
  return { id, nature: 'plugin', state, ...(detail === undefined ? {} : { detail }) };
}

function report(entries: NatureReport[]): Report {
  return { entries };
}

// ---------------------------------------------------------------------------
// obs1-R2 — unknown is advisory, never exit 3
// ---------------------------------------------------------------------------

describe('obs1-R2: unknown is advisory in reportExitCode', () => {
  it('obs1-R2: a single unknown entry alone exits 0', () => {
    const r = report([entry('plugin:foo', 'unknown', 'ledger unparsable')]);

    expect(reportExitCode(r)).toBe(0);
  });

  it('obs1-R2: present + unknown mix exits 0 (unknown does not force drift)', () => {
    const r = report([
      entry('plugin:foo', 'present'),
      entry('plugin:bar', 'unknown', 'version 3 ledger, unsupported'),
    ]);

    expect(reportExitCode(r)).toBe(0);
  });

  it('obs1-R2: unknown alongside a real missing entry still exits 3', () => {
    const r = report([
      entry('plugin:foo', 'unknown'),
      entry('plugin:bar', 'missing'),
    ]);

    expect(reportExitCode(r)).toBe(3);
  });

  it('obs1-R2: unknown alongside a real drift entry still exits 3', () => {
    const r = report([
      entry('plugin:foo', 'unknown'),
      entry('plugin:bar', 'drift', 'sha mismatch'),
    ]);

    expect(reportExitCode(r)).toBe(3);
  });

  it('obs1-R2: all entries unknown exits 0', () => {
    const r = report([
      entry('plugin:foo', 'unknown'),
      entry('plugin:bar', 'unknown'),
    ]);

    expect(reportExitCode(r)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// obs1-R2 — pre-existing derivations unchanged (regression guard)
// ---------------------------------------------------------------------------

describe('obs1-R2: pre-existing state derivations are unchanged', () => {
  it('obs1-R2: all present still exits 0', () => {
    const r = report([entry('a', 'present'), entry('b', 'present')]);

    expect(reportExitCode(r)).toBe(0);
  });

  it('obs1-R2: a single missing entry still exits 3', () => {
    const r = report([entry('a', 'present'), entry('b', 'missing')]);

    expect(reportExitCode(r)).toBe(3);
  });

  it('obs1-R2: a single drift entry still exits 3', () => {
    const r = report([entry('a', 'present'), entry('b', 'drift')]);

    expect(reportExitCode(r)).toBe(3);
  });

  it('obs1-R2: empty report still exits 0 (vacuously no drift)', () => {
    expect(reportExitCode(report([]))).toBe(0);
  });
});
