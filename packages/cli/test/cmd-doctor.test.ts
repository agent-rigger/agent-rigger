/**
 * Tests for cmd-doctor.ts — runDoctor.
 *
 * Strategy:
 * - inject a `which` mock so no real binaries are needed.
 * - capture output via a `print` mock.
 * - no I/O, no filesystem, no shell invocations.
 *
 * Scenarios:
 * 1. all deps present — every line shows ✓, mode is "scan complet".
 * 2. gitleaks absent, trivy present — ✗ gitleaks with hint, mode still "scan complet".
 * 3. gitleaks AND trivy absent — mode is "warn-only".
 * 4. git absent — ✗ git with hint.
 * 5. glab absent — ✗ glab with hint.
 * 6. all absent — all ✗ lines + mode "warn-only".
 */

import { describe, expect, it } from 'bun:test';

import type { WhichFn } from '@agent-rigger/core';

import { runDoctor } from '../src/cmd-doctor';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeWhich(present: Record<string, string>): WhichFn {
  return (cmd: string) => present[cmd] ?? null;
}

function captureLines(): { print: (s: string) => void; lines: () => string[] } {
  const collected: string[] = [];
  return {
    print: (s: string) => collected.push(s),
    lines: () => collected,
  };
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('runDoctor', () => {
  it('all deps present — all ✓ lines, mode scan complet', async () => {
    const which = makeWhich({
      gitleaks: '/usr/local/bin/gitleaks',
      trivy: '/usr/bin/trivy',
      glab: '/usr/local/bin/glab',
      git: '/usr/bin/git',
    });
    const { print, lines } = captureLines();

    await runDoctor({ which, print });

    const output = lines().join('\n');
    expect(output).toContain('✓ gitleaks');
    expect(output).toContain('✓ trivy');
    expect(output).toContain('✓ glab');
    expect(output).toContain('✓ git');
    expect(output).toContain('mode : full scan');
    expect(output).not.toContain('warn-only');
    expect(output).not.toContain('✗');
  });

  it('gitleaks absent, trivy present — ✗ gitleaks with hint, mode scan complet', async () => {
    const which = makeWhich({
      trivy: '/usr/bin/trivy',
      glab: '/usr/local/bin/glab',
      git: '/usr/bin/git',
    });
    const { print, lines } = captureLines();

    await runDoctor({ which, print });

    const output = lines().join('\n');
    expect(output).toContain('✗ gitleaks');
    expect(output).toContain('✓ trivy');
    // hint mentions how to install
    expect(output).toContain('gitleaks');
    // trivy present → scan complet
    expect(output).toContain('mode : full scan');
    expect(output).not.toContain('warn-only');
  });

  it('trivy absent, gitleaks present — mode scan complet', async () => {
    const which = makeWhich({
      gitleaks: '/usr/local/bin/gitleaks',
      glab: '/usr/local/bin/glab',
      git: '/usr/bin/git',
    });
    const { print, lines } = captureLines();

    await runDoctor({ which, print });

    const output = lines().join('\n');
    expect(output).toContain('✓ gitleaks');
    expect(output).toContain('✗ trivy');
    expect(output).toContain('mode : full scan');
  });

  it('gitleaks AND trivy absent — mode warn-only', async () => {
    const which = makeWhich({
      glab: '/usr/local/bin/glab',
      git: '/usr/bin/git',
    });
    const { print, lines } = captureLines();

    await runDoctor({ which, print });

    const output = lines().join('\n');
    expect(output).toContain('✗ gitleaks');
    expect(output).toContain('✗ trivy');
    expect(output).toContain('warn-only');
    expect(output).not.toContain('mode : full scan');
  });

  it('git absent — ✗ git with install hint', async () => {
    const which = makeWhich({
      gitleaks: '/usr/local/bin/gitleaks',
      trivy: '/usr/bin/trivy',
      glab: '/usr/local/bin/glab',
    });
    const { print, lines } = captureLines();

    await runDoctor({ which, print });

    const output = lines().join('\n');
    expect(output).toContain('✗ git');
    // should include some hint (not empty)
    expect(output).toMatch(/git.*install|install.*git/is);
  });

  it('glab absent — ✗ glab with install hint', async () => {
    const which = makeWhich({
      gitleaks: '/usr/local/bin/gitleaks',
      trivy: '/usr/bin/trivy',
      git: '/usr/bin/git',
    });
    const { print, lines } = captureLines();

    await runDoctor({ which, print });

    const output = lines().join('\n');
    expect(output).toContain('✗ glab');
    expect(output).toMatch(/glab.*install|install.*glab/is);
  });

  it('all absent — all ✗ lines and mode warn-only', async () => {
    const which = makeWhich({});
    const { print, lines } = captureLines();

    await runDoctor({ which, print });

    const output = lines().join('\n');
    expect(output).toContain('✗ gitleaks');
    expect(output).toContain('✗ trivy');
    expect(output).toContain('✗ glab');
    expect(output).toContain('✗ git');
    expect(output).toContain('warn-only');
  });

  it('path shown for present dep', async () => {
    const which = makeWhich({
      gitleaks: '/custom/path/gitleaks',
      trivy: '/usr/bin/trivy',
      glab: '/usr/local/bin/glab',
      git: '/usr/bin/git',
    });
    const { print, lines } = captureLines();

    await runDoctor({ which, print });

    const output = lines().join('\n');
    expect(output).toContain('/custom/path/gitleaks');
  });

  it('emits ANSI colour codes when color:true', async () => {
    const which = makeWhich({ git: '/usr/bin/git' });
    const { print, lines } = captureLines();

    await runDoctor({ which, print, color: true });

    const output = lines().join('\n');
    expect(output).toContain('\x1b[');
    // status substrings remain contiguous despite colour
    expect(output).toContain('✓ git');
    expect(output).toContain('✗ gitleaks');
  });

  it('emits no ANSI colour codes when color:false', async () => {
    const which = makeWhich({ git: '/usr/bin/git' });
    const { print, lines } = captureLines();

    await runDoctor({ which, print, color: false });

    expect(lines().join('\n')).not.toContain('\x1b[');
  });
});
