/**
 * Tests for catalog/src/tool-check.ts — advisory tool presence checker.
 *
 * TDD: tests written before implementation (RED → GREEN).
 *
 * All tests use a fake CommandRunner injected via the optional `run` parameter.
 * No real child processes are spawned.
 *
 * Coverage:
 *  - checkTool: present when runner exits 0
 *  - checkTool: absent when runner exits non-zero
 *  - checkTool: passes the correct check command to the runner
 *  - checkTool: throws on non-tool entry
 *  - checkTool: throws when entry has no check command
 *  - checkTools: filters to tools-with-check only
 *  - checkTools: runs multiple tools in parallel (order preserved)
 *  - missingRequired: returns only required + absent results
 *  - missingRecommended: returns only recommended + absent results
 */

import { describe, expect, it } from 'bun:test';

import { BUILTIN_CATALOG } from '../src/catalog.builtin';
import type { ArtifactEntry, CatalogEntry } from '../src/schema';
import {
  checkTool,
  checkTools,
  type CommandRunner,
  missingRecommended,
  missingRequired,
  type ToolCheckResult,
} from '../src/tool-check';

// ---------------------------------------------------------------------------
// Fake runner helpers
// ---------------------------------------------------------------------------

/** Always exits 0 — tool is present. */
const runnerPresent: CommandRunner = (_cmd) => Promise.resolve({ exitCode: 0 });

/** Always exits 1 — tool is absent. */
const runnerAbsent: CommandRunner = (_cmd) => Promise.resolve({ exitCode: 1 });

/** Captures the command and exits with a given code. */
function makeCapturingRunner(exitCode: number): { runner: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  const runner: CommandRunner = (cmd) => {
    calls.push(cmd);
    return Promise.resolve({ exitCode });
  };
  return { runner, calls };
}

/**
 * Mixed runner for the synthetic catalog: alpha exits 0 (present),
 * all others exit 1 (absent).
 */
const runnerMixed: CommandRunner = (cmd) =>
  Promise.resolve({ exitCode: cmd.includes('alpha') ? 0 : 1 });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** tool:glab entry lifted directly from BUILTIN_CATALOG. */
const glabEntry = BUILTIN_CATALOG.find((e) => e.id === 'tool:glab') as ArtifactEntry;

/** A non-tool artifact entry (skill). */
const skillEntry = BUILTIN_CATALOG.find(
  (e) => e.kind === 'artifact' && (e as ArtifactEntry).nature === 'skill',
) as ArtifactEntry;

/** A pack entry. */
const packEntry = BUILTIN_CATALOG.find((e) => e.kind === 'pack') as CatalogEntry;

/** A synthetic tool entry without a check command. */
const toolNoCheck: ArtifactEntry = {
  kind: 'artifact',
  id: 'tool:no-check',
  nature: 'tool',
  targets: ['claude'],
  scopes: ['user'],
  level: 'recommended',
};

/** Synthetic catalog for subset tests. */
const syntheticCatalog: CatalogEntry[] = [
  // required, present
  {
    kind: 'artifact',
    id: 'tool:alpha',
    nature: 'tool',
    targets: ['claude'],
    scopes: ['user'],
    level: 'required',
    check: 'command -v alpha',
  },
  // required, absent
  {
    kind: 'artifact',
    id: 'tool:beta',
    nature: 'tool',
    targets: ['claude'],
    scopes: ['user'],
    level: 'required',
    check: 'command -v beta',
  },
  // recommended, absent
  {
    kind: 'artifact',
    id: 'tool:gamma',
    nature: 'tool',
    targets: ['claude'],
    scopes: ['user'],
    level: 'recommended',
    check: 'command -v gamma',
  },
  // non-tool: must be ignored by checkTools
  {
    kind: 'artifact',
    id: 'plugin:delta',
    nature: 'plugin',
    targets: ['claude'],
    scopes: ['user'],
  },
  // pack: must be ignored by checkTools
  {
    kind: 'pack',
    id: 'pack:omega',
    targets: ['claude'],
    scopes: ['user'],
    members: ['tool:alpha'],
  },
];

// ---------------------------------------------------------------------------
// checkTool — present / absent
// ---------------------------------------------------------------------------

describe('checkTool — present when runner exits 0', () => {
  it('returns present: true for tool:glab', async () => {
    const result = await checkTool(glabEntry, runnerPresent);
    expect(result.present).toBe(true);
  });

  it('returns the correct id', async () => {
    const result = await checkTool(glabEntry, runnerPresent);
    expect(result.id).toBe('tool:glab');
  });

  it('returns the correct level (required)', async () => {
    const result = await checkTool(glabEntry, runnerPresent);
    expect(result.level).toBe('required');
  });
});

describe('checkTool — absent when runner exits non-zero', () => {
  it('returns present: false for tool:glab', async () => {
    const result = await checkTool(glabEntry, runnerAbsent);
    expect(result.present).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkTool — runner receives correct command
// ---------------------------------------------------------------------------

describe('checkTool — passes check command to runner', () => {
  it('runner receives entry.check exactly', async () => {
    const { runner, calls } = makeCapturingRunner(0);
    await checkTool(glabEntry, runner);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(glabEntry.check);
  });
});

// ---------------------------------------------------------------------------
// checkTool — guard: non-tool entry
// ---------------------------------------------------------------------------

describe('checkTool — throws on non-tool entry', () => {
  it('throws when entry.nature is not tool (skill)', async () => {
    await expect(checkTool(skillEntry, runnerPresent)).rejects.toThrow();
  });

  it('throws when entry is a pack', async () => {
    await expect(checkTool(packEntry as ArtifactEntry, runnerPresent)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// checkTool — guard: entry without check command
// ---------------------------------------------------------------------------

describe('checkTool — throws when entry has no check command', () => {
  it('throws for a tool entry without check', async () => {
    await expect(checkTool(toolNoCheck, runnerPresent)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// checkTools — filters to tools-with-check only
// ---------------------------------------------------------------------------

describe('checkTools — filters entries', () => {
  it('returns only tool entries that have a check command', async () => {
    const results = await checkTools(BUILTIN_CATALOG, runnerPresent);
    const ids = results.map((r) => r.id);
    expect(ids).toContain('tool:glab');
    for (const result of results) {
      expect(result.id).toMatch(/^tool:/);
    }
  });

  it('ignores pack entries', async () => {
    const results = await checkTools(BUILTIN_CATALOG, runnerPresent);
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain('pack:spec-workflow');
  });

  it('ignores non-tool artifacts', async () => {
    const results = await checkTools(BUILTIN_CATALOG, runnerPresent);
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain('skill:spec-workflow');
    expect(ids).not.toContain('guardrails-claude');
  });

  it('ignores tool entries without a check command', async () => {
    const catalog: CatalogEntry[] = [...BUILTIN_CATALOG, toolNoCheck];
    const results = await checkTools(catalog, runnerPresent);
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain('tool:no-check');
  });
});

// ---------------------------------------------------------------------------
// checkTools — parallel execution and order
// ---------------------------------------------------------------------------

describe('checkTools — parallel execution', () => {
  it('returns one result per eligible tool in the catalog', async () => {
    const results = await checkTools(BUILTIN_CATALOG, runnerPresent);
    const eligible = BUILTIN_CATALOG.filter(
      (e) =>
        e.kind === 'artifact' && (e as ArtifactEntry).nature === 'tool'
        && (e as ArtifactEntry).check,
    );
    expect(results).toHaveLength(eligible.length);
  });

  it('preserves array order matching filtered input order', async () => {
    const results = await checkTools(syntheticCatalog, runnerPresent);
    const ids = results.map((r) => r.id);
    expect(ids).toEqual(['tool:alpha', 'tool:beta', 'tool:gamma']);
  });

  it('all results have a present field (boolean)', async () => {
    const results = await checkTools(BUILTIN_CATALOG, runnerPresent);
    for (const result of results) {
      expect(typeof result.present).toBe('boolean');
    }
  });
});

// ---------------------------------------------------------------------------
// missingRequired / missingRecommended — advisory helpers
// ---------------------------------------------------------------------------

describe('missingRequired', () => {
  it('returns only required + absent results', async () => {
    // tool:alpha exits 0 (present), tool:beta exits 1 (absent), tool:gamma exits 1 (absent)
    const results = await checkTools(syntheticCatalog, runnerMixed);
    const missing = missingRequired(results);

    const ids = missing.map((r) => r.id);
    expect(ids).toContain('tool:beta');
    expect(ids).not.toContain('tool:alpha');
    expect(ids).not.toContain('tool:gamma');
  });

  it('returns empty array when all required tools are present', async () => {
    const results = await checkTools(syntheticCatalog, runnerPresent);
    expect(missingRequired(results)).toHaveLength(0);
  });

  it('every item has level required', () => {
    const results: ToolCheckResult[] = [
      { id: 'tool:a', level: 'required', present: false },
      { id: 'tool:b', level: 'recommended', present: false },
      { id: 'tool:c', level: 'required', present: true },
      { id: 'tool:d', level: undefined, present: false },
    ];
    const missing = missingRequired(results);
    for (const r of missing) {
      expect(r.level).toBe('required');
    }
  });
});

describe('missingRecommended', () => {
  it('returns only recommended + absent results', async () => {
    const results = await checkTools(syntheticCatalog, runnerMixed);
    const missing = missingRecommended(results);

    const ids = missing.map((r) => r.id);
    expect(ids).toContain('tool:gamma');
    expect(ids).not.toContain('tool:alpha');
    expect(ids).not.toContain('tool:beta');
  });

  it('returns empty array when all recommended tools are present', async () => {
    const results = await checkTools(syntheticCatalog, runnerPresent);
    expect(missingRecommended(results)).toHaveLength(0);
  });

  it('every item has level recommended', () => {
    const results: ToolCheckResult[] = [
      { id: 'tool:a', level: 'recommended', present: false },
      { id: 'tool:b', level: 'required', present: false },
      { id: 'tool:c', level: 'recommended', present: true },
    ];
    const missing = missingRecommended(results);
    for (const r of missing) {
      expect(r.level).toBe('recommended');
    }
  });
});
