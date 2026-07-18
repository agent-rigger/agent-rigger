/**
 * lot5-r3-flags.test.ts — R3: the syntax the CLI teaches parses, the unknown
 * is rejected (lot5-ux-dx).
 *
 * One test per scenario in requirements.md (R3), named `lot5-R3: …` (stock
 * §8 traceability convention). Parser-shape scenarios (space ≡ `=`, `--scope`
 * no longer leaking to positionals, `--secret-env` space feeding
 * secretEnvFlags, booleans not consuming a value) are proven directly against
 * `parseArgs` — that IS the unit under test for those scenarios. Exit-code
 * scenarios (missing value, invalid value, unknown flag) are proven through
 * `runCli`, since the exit code/message only exist at that level.
 *
 * TDD: written before parseArgs grew VALUE_FLAGS/KNOWN_FLAGS and runCli grew
 * the centralised --assistant check (RED → GREEN).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Env } from '@agent-rigger/core/paths';

import { KNOWN_FLAGS, parseArgs, runCli } from '../src/cli';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCapture(): { lines: string[]; print: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

async function makeTmpHome(): Promise<{ env: Env; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-lot5-r3-'));
  return { env: { RIGGER_HOME: dir }, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Scenario: syntaxe espace équivalente à la syntaxe = (install/check/remove/
// update/ls/info)
// ---------------------------------------------------------------------------

describe('lot5-R3: space syntax is equivalent to "=" syntax', () => {
  it('--assistant opencode (space) parses identically to --assistant=opencode, on every command shape', () => {
    const shapes: string[][] = [
      ['check'],
      ['install', 'jr/skill:foo'],
      ['remove', 'jr/skill:foo'],
      ['update', 'jr/skill:foo'],
      ['ls'],
      ['guardrails', 'info', 'jr/guardrail:foo'],
    ];

    for (const shape of shapes) {
      const spaced = parseArgs([...shape, '--assistant', 'opencode']);
      const equalled = parseArgs([...shape, '--assistant=opencode']);
      expect(spaced.error).toBeUndefined();
      expect(spaced.flags['assistant']).toBe('opencode');
      expect(spaced.flags).toEqual(equalled.flags);
      expect(spaced.resourceIds).toEqual(equalled.resourceIds);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario: --scope espace ne fuit plus en positionnel
// ---------------------------------------------------------------------------

describe('lot5-R3: --scope space does not leak into positionals', () => {
  it('"install jr/skill:foo --scope project" resolves scope=project and resourceIds=[jr/skill:foo] only', () => {
    const result = parseArgs(['install', 'jr/skill:foo', '--scope', 'project']);
    expect(result.flags['scope']).toBe('project');
    expect(result.resourceIds).toEqual(['jr/skill:foo']);
    // Previously: scope=true (boolean) and 'project' became a phantom id.
    expect(result.resourceIds).not.toContain('project');
  });
});

// ---------------------------------------------------------------------------
// Scenario: --secret-env espace alimente secretEnvFlags
// ---------------------------------------------------------------------------

describe('lot5-R3: --secret-env space feeds secretEnvFlags', () => {
  it('"install jr/mcp:x --secret-env ref=VAR" records the override, not a phantom id', () => {
    const result = parseArgs(['install', 'jr/mcp:x', '--secret-env', 'ref=VAR']);
    expect(result.secretEnvFlags).toEqual(['ref=VAR']);
    expect(result.resourceIds).toEqual(['jr/mcp:x']);
  });
});

// ---------------------------------------------------------------------------
// Scenario: flag à valeur en fin d'argv
// ---------------------------------------------------------------------------

describe('lot5-R3: a value-flag at the end of argv exits 2 with an actionable message', () => {
  let tmp: { env: Env; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('"agent-rigger check --assistant" exits 2 with "--assistant requires a value"', async () => {
    const cap = makeCapture();
    const code = await runCli(['check', '--assistant'], { print: cap.print, env: tmp.env });
    expect(code).toBe(2);
    expect(cap.lines.join('\n')).toContain('--assistant requires a value');
  });
});

// ---------------------------------------------------------------------------
// Scenario: valeur invalide — exit uniforme
// ---------------------------------------------------------------------------

describe('lot5-R3: an invalid --assistant value exits 2 uniformly across commands', () => {
  let tmp: { env: Env; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  const cases: Array<{ label: string; argv: string[] }> = [
    { label: 'install (=)', argv: ['install', 'jr/skill:foo', '--yes', '--assistant=bogus'] },
    {
      label: 'install (space)',
      argv: ['install', 'jr/skill:foo', '--yes', '--assistant', 'bogus'],
    },
    { label: 'check', argv: ['check', '--assistant=bogus'] },
    { label: 'remove', argv: ['remove', 'jr/skill:foo', '--yes', '--assistant=bogus'] },
    { label: 'update', argv: ['update', '--assistant=bogus'] },
    { label: 'ls', argv: ['ls', '--assistant=bogus'] },
  ];

  for (const { label, argv } of cases) {
    it(`${label}: exits 2 with the admissible-values message (Previously: 1 on install/check/remove/update, 2 on ls/info — divergent)`, async () => {
      const cap = makeCapture();
      const code = await runCli(argv, { print: cap.print, env: tmp.env });
      expect(code).toBe(2);
      expect(cap.lines.join('\n')).toContain('Invalid --assistant value: "bogus"');
    });
  }
});

// ---------------------------------------------------------------------------
// Scenario: flag inconnu rejeté bruyamment
// ---------------------------------------------------------------------------

describe('lot5-R3: an unknown flag is rejected loudly, not silently ignored', () => {
  let tmp: { env: Env; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('"install jr/skill:foo --sope=project" exits 2 with `unknown flag "--sope"`', async () => {
    const cap = makeCapture();
    const code = await runCli(['install', 'jr/skill:foo', '--sope=project'], {
      print: cap.print,
      env: tmp.env,
    });
    expect(code).toBe(2);
    expect(cap.lines.join('\n')).toContain('unknown flag "--sope"');
  });
});

// ---------------------------------------------------------------------------
// Scenario: les booléens ne consomment pas de valeur
// ---------------------------------------------------------------------------

describe('lot5-R3: boolean flags do not consume a value', () => {
  it('--yes/--force/--help/--version stay booleans; the following tokens stay positional', () => {
    const result = parseArgs(['install', 'jr/skill:foo', '--yes', '--force', 'jr/skill:bar']);
    expect(result.flags['yes']).toBe(true);
    expect(result.flags['force']).toBe(true);
    expect(result.resourceIds).toEqual(['jr/skill:foo', 'jr/skill:bar']);
  });

  it('--help and --version alone stay booleans (no value consumed, no positionals eaten)', () => {
    const result = parseArgs(['install', 'jr/skill:foo', '--help', '--version']);
    expect(result.flags['help']).toBe(true);
    expect(result.flags['version']).toBe(true);
    expect(result.resourceIds).toEqual(['jr/skill:foo']);
  });
});

// ---------------------------------------------------------------------------
// Anti-drift (checklist, T7): USAGE documents exactly KNOWN_FLAGS, and no
// example in USAGE/README teaches an unqualified id.
//
// This is the guardrail against the exact drift that motivated R3/R1: a flag
// added to the parser (or an example rewritten with a bare id) with no
// matching doc update. If it doesn't fail here when someone adds a flag to
// KNOWN_FLAGS without touching USAGE's Options section, the test isn't doing
// its job.
// ---------------------------------------------------------------------------

describe('lot5-R3: anti-drift — USAGE documents exactly KNOWN_FLAGS', () => {
  it('every flag in KNOWN_FLAGS has a "--<flag>" line in USAGE\'s Options section, and vice versa', async () => {
    const cap = makeCapture();
    await runCli(['--help'], { print: cap.print, env: { RIGGER_HOME: '/nonexistent' } });
    const usage = cap.lines.join('\n');

    const optionsSection = usage.slice(usage.indexOf('Options:'), usage.indexOf('Examples:'));
    const documented = new Set(
      [...optionsSection.matchAll(/--([a-z-]+)/g)].map((m) => m[1] as string),
    );

    for (const flag of KNOWN_FLAGS) {
      expect(documented.has(flag)).toBe(true);
    }
    for (const flag of documented) {
      expect(KNOWN_FLAGS.has(flag)).toBe(true);
    }
  });
});

describe('lot5-R3: anti-drift — no unqualified id in USAGE or README examples', () => {
  const naturePattern =
    /\b(skill|agent|guardrail|context|plugin|tool|pack|hook|mcp):[A-Za-z0-9_-]+/g;

  // A command-invocation line: starts (after leading whitespace) with
  // "rigger " (CLI usage) or "agent-rigger " (README keeps the distribution
  // name) — this deliberately excludes prose/concept mentions
  // (e.g. "the built-in guards (`hook:guard-command`, ...)") which are out
  // of scope for this checklist item (only worked examples must be qualified).
  function unqualifiedIdsInInvocations(text: string): string[] {
    const offenders: string[] = [];
    for (const line of text.split('\n')) {
      if (!/^\s*(agent-)?rigger\s/.test(line)) continue;
      for (const match of line.matchAll(naturePattern)) {
        const idx = match.index ?? 0;
        const precedingChar = line[idx - 1];
        if (precedingChar !== '/') {
          offenders.push(match[0]);
        }
      }
    }
    return offenders;
  }

  it('USAGE examples use only qualified <catalog>/<nature>:<name> ids', async () => {
    const cap = makeCapture();
    await runCli(['--help'], { print: cap.print, env: { RIGGER_HOME: '/nonexistent' } });
    const usage = cap.lines.join('\n');
    expect(unqualifiedIdsInInvocations(usage)).toEqual([]);
  });

  it('README.md examples use only qualified <catalog>/<nature>:<name> ids', async () => {
    const readmePath = path.join(import.meta.dir, '../../../README.md');
    const readme = await fs.readFile(readmePath, 'utf8');
    expect(unqualifiedIdsInInvocations(readme)).toEqual([]);
  });
});
