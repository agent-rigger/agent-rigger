/**
 * Tests for engine.ts — check() and reportExitCode().
 *
 * Uses a minimal "deny adapter" implemented inline:
 *   - audit: reads settings.json via readJson, checks permissions.deny against a ref;
 *     returns 'present' if all ref rules are present, 'missing' otherwise.
 *   - plan: returns a merge-deny WriteOp when rules are missing.
 *   - apply: reads, mergeDeny, writeJson.
 *
 * Isolation: each test uses a fresh tmp HOME via makeTmpHome().
 * InvalidJsonError is imported directly to assert the thrown type.
 *
 * TDD: tests written before engine.ts (B7).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Adapter } from '../src/adapter';
import { computeMissingDeny, mergeDeny } from '../src/deny';
import { check, reportExitCode } from '../src/engine';
import { InvalidJsonError, readJson, writeJson } from '../src/fs-json';
import { resolveUserTargets } from '../src/paths';
import type { Env } from '../src/paths';
import type { NatureReport, Scope, WriteOp } from '../src/types';
import { makeTmpHome } from './tmp-home';

// ---------------------------------------------------------------------------
// Ref deny rules used by the test adapter
// ---------------------------------------------------------------------------

const REF_DENY = ['Read(~/.ssh/**)', 'Write(~/.aws/**)'];
const ENTRY_ID = 'guardrails-claude';
const ENTRY_NATURE = 'guardrail' as const;

// ---------------------------------------------------------------------------
// Minimal deny adapter (test double — NOT a mock, exercises real core logic)
// ---------------------------------------------------------------------------

/**
 * A minimal but realistic Adapter that:
 * - audit: reads settings.json and reports 'present'/'missing'/'drift'
 * - plan:  returns a merge-deny op when rules are missing
 * - apply: reads, merges, writes
 *
 * This exercises the engine from the outside without mocking implementation.
 */
function makeDenyAdapter(refDeny: string[] = REF_DENY): Adapter {
  return {
    id: 'claude',

    async audit(entry, _scope, env): Promise<NatureReport> {
      const targets = resolveUserTargets(env);
      const settingsPath = targets.claudeSettings;

      const raw = await readJson(settingsPath);
      const permissions = raw['permissions'];
      const currentDeny: string[] = Array.isArray(
          (permissions as Record<string, unknown> | undefined)?.['deny'],
        )
        ? ((permissions as Record<string, unknown>)['deny'] as string[])
        : [];

      const missing = computeMissingDeny(refDeny, currentDeny);

      if (missing.length === 0) {
        return { id: entry.id, nature: entry.nature, state: 'present' };
      }

      return {
        id: entry.id,
        nature: entry.nature,
        state: 'missing',
        detail: `Missing deny rules: ${missing.join(', ')}`,
      };
    },

    async plan(_entry, _scope, env): Promise<WriteOp[]> {
      const targets = resolveUserTargets(env);
      const settingsPath = targets.claudeSettings;

      const raw = await readJson(settingsPath);
      const permissions = raw['permissions'];
      const currentDeny: string[] = Array.isArray(
          (permissions as Record<string, unknown> | undefined)?.['deny'],
        )
        ? ((permissions as Record<string, unknown>)['deny'] as string[])
        : [];

      const missing = computeMissingDeny(refDeny, currentDeny);
      if (missing.length === 0) {
        return [];
      }

      return [{ kind: 'merge-deny', path: settingsPath, toAdd: missing }];
    },

    async apply(ops, _env): Promise<void> {
      await Promise.all(
        ops.map(async (op) => {
          if (op.kind === 'merge-deny') {
            const raw = await readJson(op.path);
            const permissions = (raw['permissions'] as Record<string, unknown> | undefined) ?? {};
            const currentDeny: string[] = Array.isArray(permissions['deny'])
              ? (permissions['deny'] as string[])
              : [];

            const merged = mergeDeny(currentDeny, refDeny);
            const updated = {
              ...raw,
              permissions: { ...permissions, deny: merged },
            };
            await writeJson(op.path, updated);
          }
        }),
      );
    },
  };
}

/** Catalog-style entry shape used by the engine. */
function makeCatalogEntry(id: string, scope: Scope = 'user') {
  return { id, nature: ENTRY_NATURE, scope };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let settingsPath: string;

beforeEach(async () => {
  tmp = await makeTmpHome('rigger-engine-check-');
  env = tmp.env;
  settingsPath = resolveUserTargets(env).claudeSettings;
});

afterEach(async () => {
  await tmp.cleanup();
});

// ---------------------------------------------------------------------------
// check() — all entries present → reportExitCode = 0
// ---------------------------------------------------------------------------

describe('check: all entries present', () => {
  it('returns a Report with all entries state=present when deny rules are installed', async () => {
    // Pre-install: write settings.json with ALL ref deny rules already present
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await writeJson(settingsPath, {
      permissions: { deny: REF_DENY },
      model: 'claude-sonnet',
    });

    const adapter = makeDenyAdapter();
    const entries = [makeCatalogEntry(ENTRY_ID)];
    const report = await check(adapter, entries, 'user', env);

    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]!.state).toBe('present');
    expect(report.entries[0]!.id).toBe(ENTRY_ID);
  });

  it('reportExitCode returns 0 when all entries are present', async () => {
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await writeJson(settingsPath, { permissions: { deny: REF_DENY } });

    const adapter = makeDenyAdapter();
    const entries = [makeCatalogEntry(ENTRY_ID)];
    const report = await check(adapter, entries, 'user', env);

    expect(reportExitCode(report)).toBe(0);
  });

  it('multiple entries all present → exit code 0', async () => {
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await writeJson(settingsPath, { permissions: { deny: REF_DENY } });

    const adapter = makeDenyAdapter();
    const entries = [makeCatalogEntry('a'), makeCatalogEntry('b')];
    const report = await check(adapter, entries, 'user', env);

    expect(report.entries.every((e) => e.state === 'present')).toBe(true);
    expect(reportExitCode(report)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// check() — missing entry → reportExitCode = 3
// ---------------------------------------------------------------------------

describe('check: missing entry', () => {
  it('returns state=missing when settings.json has no deny rules', async () => {
    // settings.json absent → readJson returns {} → missing
    const adapter = makeDenyAdapter();
    const entries = [makeCatalogEntry(ENTRY_ID)];
    const report = await check(adapter, entries, 'user', env);

    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]!.state).toBe('missing');
  });

  it('reportExitCode returns 3 when any entry is missing', async () => {
    const adapter = makeDenyAdapter();
    const entries = [makeCatalogEntry(ENTRY_ID)];
    const report = await check(adapter, entries, 'user', env);

    expect(reportExitCode(report)).toBe(3);
  });

  it('reportExitCode returns 3 when at least one of many entries is missing', async () => {
    // Pre-install settings with deny rules so ENTRY_ID is present
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await writeJson(settingsPath, { permissions: { deny: REF_DENY } });

    // To produce a mixed report: use an adapter that checks by id
    const mixedAdapter: Adapter = {
      id: 'claude',
      async audit(entry, _scope, _env): Promise<NatureReport> {
        if (entry.id === ENTRY_ID) {
          return { id: entry.id, nature: entry.nature, state: 'present' };
        }
        return { id: entry.id, nature: entry.nature, state: 'missing' };
      },
      async plan() {
        return [];
      },
      async apply() {},
    };

    const entries = [makeCatalogEntry(ENTRY_ID), makeCatalogEntry('other')];
    const report = await check(mixedAdapter, entries, 'user', env);

    expect(report.entries.some((e) => e.state === 'missing')).toBe(true);
    expect(reportExitCode(report)).toBe(3);
  });

  it('reportExitCode returns 3 when an entry is in drift state', async () => {
    const driftAdapter: Adapter = {
      id: 'claude',
      async audit(entry): Promise<NatureReport> {
        return { id: entry.id, nature: entry.nature, state: 'drift', detail: 'file modified' };
      },
      async plan() {
        return [];
      },
      async apply() {},
    };

    const entries = [makeCatalogEntry(ENTRY_ID)];
    const report = await check(driftAdapter, entries, 'user', env);

    expect(report.entries[0]!.state).toBe('drift');
    expect(reportExitCode(report)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// check() — InvalidJsonError propagates (exit 2 territory, handled by CLI)
// ---------------------------------------------------------------------------

describe('check: invalid JSON propagates', () => {
  it('throws InvalidJsonError when settings.json contains malformed JSON', async () => {
    // Write malformed JSON to settings path
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, '{ invalid json }', 'utf-8');

    const adapter = makeDenyAdapter();
    const entries = [makeCatalogEntry(ENTRY_ID)];

    let caught: unknown;
    try {
      await check(adapter, entries, 'user', env);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InvalidJsonError);
  });

  it('InvalidJsonError carries the file path', async () => {
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, 'not-json', 'utf-8');

    const adapter = makeDenyAdapter();
    const entries = [makeCatalogEntry(ENTRY_ID)];

    let caught: unknown;
    try {
      await check(adapter, entries, 'user', env);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InvalidJsonError);
    expect((caught as InvalidJsonError).path).toBe(settingsPath);
  });
});

// ---------------------------------------------------------------------------
// check() — empty entries list
// ---------------------------------------------------------------------------

describe('check: edge cases', () => {
  it('returns an empty report for an empty entries list', async () => {
    const adapter = makeDenyAdapter();
    const report = await check(adapter, [], 'user', env);

    expect(report.entries).toHaveLength(0);
  });

  it('reportExitCode returns 0 for an empty report (vacuously all present)', () => {
    expect(reportExitCode({ entries: [] })).toBe(0);
  });
});
