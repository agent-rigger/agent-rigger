/**
 * Tests for cmd-ls.ts and the renderCatalogList pure function in ui.ts.
 *
 * Strategy:
 * - renderCatalogList: pure unit tests on formatting (no I/O).
 * - runLs: real filesystem via tmp HOME; manifest empty → all available;
 *   manifest populated → installed entries marked.
 * - No while loops.
 * - No BUILTIN_CATALOG: tests use local FIXTURE_CATALOG.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry } from '@agent-rigger/catalog';
import { runLs } from '../src/cmd-ls';
import { renderCatalogList, renderEntryInfo } from '../src/ui';

// ---------------------------------------------------------------------------
// Fixture catalog (replaces BUILTIN_CATALOG)
// ---------------------------------------------------------------------------

/** Minimal fixture catalog for testing runLs. */
const FIXTURE_CATALOG: CatalogEntry[] = [
  {
    kind: 'artifact',
    id: 'guardrails-claude',
    nature: 'guardrail',
    targets: ['claude'],
    scopes: ['user', 'project'],
  },
  {
    kind: 'artifact',
    id: 'context-claude',
    nature: 'context',
    targets: ['claude'],
    scopes: ['user', 'project'],
  },
  {
    kind: 'artifact',
    id: 'skill:spec-workflow',
    nature: 'skill',
    targets: ['claude'],
    scopes: ['user', 'project'],
    requires: ['tool:glab'],
  },
  {
    kind: 'artifact',
    id: 'tool:glab',
    nature: 'tool',
    targets: ['claude'],
    scopes: ['user'],
    level: 'required' as const,
    check: 'command -v glab',
  },
  {
    kind: 'pack',
    id: 'pack:dev-setup',
    targets: ['claude'],
    scopes: ['user'],
    members: ['guardrails-claude', 'context-claude'],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-ls-test-'): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** Minimal artifact entry for testing */
function makeArtifact(
  id: string,
  nature: 'skill' | 'agent' | 'guardrail' | 'context' | 'plugin' | 'tool' | 'mcp' = 'skill',
): CatalogEntry {
  return {
    kind: 'artifact',
    id,
    nature,
    targets: ['claude'],
    scopes: ['user'],
  };
}

function makePack(id: string, members: string[]): CatalogEntry {
  return {
    kind: 'pack',
    id,
    targets: ['claude'],
    scopes: ['user'],
    members,
  };
}

// ---------------------------------------------------------------------------
// renderCatalogList — pure rendering
// ---------------------------------------------------------------------------

describe('renderCatalogList — header', () => {
  it('renders "Catalog (N entries):" header for full list', () => {
    const entries: CatalogEntry[] = [
      makeArtifact('skill:foo', 'skill'),
      makeArtifact('skill:bar', 'skill'),
    ];
    const result = renderCatalogList(entries);
    expect(result).toContain('Catalog (2 entries):');
  });

  it('renders "Catalog (1 entry):" for single entry', () => {
    const entries: CatalogEntry[] = [makeArtifact('skill:foo', 'skill')];
    const result = renderCatalogList(entries);
    expect(result).toContain('Catalog (1 entry):');
  });

  it('renders header with label when label provided', () => {
    const entries: CatalogEntry[] = [makeArtifact('skill:foo', 'skill')];
    const result = renderCatalogList(entries, { label: 'Skills' });
    expect(result).toContain('Skills (1):');
  });
});

describe('renderCatalogList — installed vs available status', () => {
  it('marks entry as [installed] when in installedIds', () => {
    const entries: CatalogEntry[] = [makeArtifact('skill:foo', 'skill')];
    const result = renderCatalogList(entries, { installedIds: new Set(['skill:foo']) });
    expect(result).toContain('[installed]');
    expect(result).not.toContain('[available]');
  });

  it('marks entry as [available] when not in installedIds', () => {
    const entries: CatalogEntry[] = [makeArtifact('skill:foo', 'skill')];
    const result = renderCatalogList(entries, { installedIds: new Set() });
    expect(result).toContain('[available]');
    expect(result).not.toContain('[installed]');
  });

  it('marks all entries as available when installedIds is undefined', () => {
    const entries: CatalogEntry[] = [
      makeArtifact('skill:foo', 'skill'),
      makeArtifact('skill:bar', 'skill'),
    ];
    const result = renderCatalogList(entries);
    const lines = result.split('\n').filter((l) => l.includes('skill:'));
    expect(lines.every((l) => l.includes('[available]'))).toBe(true);
  });

  it('status tags are padded to equal width', () => {
    const entries: CatalogEntry[] = [
      makeArtifact('skill:foo', 'skill'),
      makeArtifact('skill:bar', 'skill'),
    ];
    const installedIds = new Set(['skill:foo']);
    const result = renderCatalogList(entries, { installedIds });
    const tagRe = /\[(?:installed|available)\s*\]/;
    const tags = result
      .split('\n')
      .map((l) => tagRe.exec(l)?.[0])
      .filter(Boolean) as string[];
    const lengths = tags.map((t) => t.length);
    expect(lengths.length).toBeGreaterThan(0);
    expect(new Set(lengths).size).toBe(1);
  });

  it('renders id on each entry line', () => {
    const entries: CatalogEntry[] = [makeArtifact('skill:spec-workflow', 'skill')];
    const result = renderCatalogList(entries);
    expect(result).toContain('skill:spec-workflow');
  });

  it('renders nature for artifact entries', () => {
    const entries: CatalogEntry[] = [makeArtifact('agent:pm', 'agent')];
    const result = renderCatalogList(entries);
    expect(result).toContain('agent');
  });
});

describe('renderCatalogList — packs', () => {
  it('renders "(N members)" hint for packs', () => {
    const entries: CatalogEntry[] = [makePack('pack:dev-tools', ['skill:foo', 'tool:glab'])];
    const result = renderCatalogList(entries);
    expect(result).toContain('(2 members)');
  });

  it('renders "pack" as the type for pack entries', () => {
    const entries: CatalogEntry[] = [makePack('pack:dev-tools', ['skill:foo'])];
    const result = renderCatalogList(entries);
    expect(result).toContain('pack');
  });
});

describe('renderCatalogList — artifact hints', () => {
  it('renders level hint for artifact with level', () => {
    const entry: CatalogEntry = {
      kind: 'artifact',
      id: 'tool:glab',
      nature: 'tool',
      targets: ['claude'],
      scopes: ['user'],
      level: 'required',
    };
    const result = renderCatalogList([entry]);
    expect(result).toContain('required');
  });

  it('renders empty hint for artifact without level', () => {
    const entry: CatalogEntry = {
      kind: 'artifact',
      id: 'skill:spec-workflow',
      nature: 'skill',
      targets: ['claude'],
      scopes: ['user'],
    };
    const result = renderCatalogList([entry]);
    // No level → hint is empty; check entry id is still present
    expect(result).toContain('skill:spec-workflow');
  });
});

// ---------------------------------------------------------------------------
// renderEntryInfo — pure single-entry detail rendering
// ---------------------------------------------------------------------------

describe('renderEntryInfo — artifact', () => {
  it('renders id and nature in header', () => {
    const entry: CatalogEntry = {
      kind: 'artifact',
      id: 'guardrails-claude',
      nature: 'guardrail',
      targets: ['claude'],
      scopes: ['user', 'project'],
    };
    const result = renderEntryInfo(entry);
    expect(result).toContain('guardrails-claude');
    expect(result).toContain('guardrail');
  });

  it('renders status available by default', () => {
    const entry: CatalogEntry = {
      kind: 'artifact',
      id: 'skill:spec-workflow',
      nature: 'skill',
      targets: ['claude'],
      scopes: ['user'],
    };
    const result = renderEntryInfo(entry);
    expect(result).toContain('available');
  });

  it('renders status installed when opts.installed is true', () => {
    const entry: CatalogEntry = {
      kind: 'artifact',
      id: 'guardrails-claude',
      nature: 'guardrail',
      targets: ['claude'],
      scopes: ['user'],
    };
    const result = renderEntryInfo(entry, { installed: true });
    expect(result).toContain('installed');
    expect(result).not.toContain('available');
  });

  it('renders level field when present', () => {
    const entry: CatalogEntry = {
      kind: 'artifact',
      id: 'tool:glab',
      nature: 'tool',
      targets: ['claude'],
      scopes: ['user'],
      level: 'required',
    };
    const result = renderEntryInfo(entry);
    expect(result).toContain('required');
  });

  it('renders requires field when present', () => {
    const entry: CatalogEntry = {
      kind: 'artifact',
      id: 'skill:spec-workflow',
      nature: 'skill',
      targets: ['claude'],
      scopes: ['user'],
      requires: ['tool:glab'],
    };
    const result = renderEntryInfo(entry);
    expect(result).toContain('tool:glab');
  });

  it('does not render requires when absent', () => {
    const entry: CatalogEntry = {
      kind: 'artifact',
      id: 'guardrails-claude',
      nature: 'guardrail',
      targets: ['claude'],
      scopes: ['user'],
    };
    const result = renderEntryInfo(entry);
    expect(result).not.toMatch(/requires/);
  });
});

describe('renderEntryInfo — pack', () => {
  it('renders "pack" as type label', () => {
    const entry: CatalogEntry = {
      kind: 'pack',
      id: 'pack:spec-workflow',
      targets: ['claude'],
      scopes: ['user'],
      members: ['skill:spec-workflow', 'agent:pm'],
    };
    const result = renderEntryInfo(entry);
    expect(result).toContain('pack');
  });

  it('renders members list', () => {
    const entry: CatalogEntry = {
      kind: 'pack',
      id: 'pack:spec-workflow',
      targets: ['claude'],
      scopes: ['user'],
      members: ['skill:spec-workflow', 'agent:pm'],
    };
    const result = renderEntryInfo(entry);
    expect(result).toContain('skill:spec-workflow');
    expect(result).toContain('agent:pm');
  });
});

// ---------------------------------------------------------------------------
// runLs — integration with tmp HOME
// ---------------------------------------------------------------------------

describe('runLs — empty manifest (all available)', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('returns output listing all catalog entries', async () => {
    const result = await runLs({
      catalog: FIXTURE_CATALOG,
      env: { RIGGER_HOME: tmp.dir },
      scope: 'user',
    });
    expect(result.output).toContain('Catalog');
    expect(result.count).toBeGreaterThan(0);
  });

  it('marks all entries as available when manifest is empty', async () => {
    const result = await runLs({
      catalog: FIXTURE_CATALOG,
      env: { RIGGER_HOME: tmp.dir },
      scope: 'user',
    });
    expect(result.output).not.toContain('[installed]');
    expect(result.output).toContain('[available]');
  });

  it('count matches number of fixture catalog entries', async () => {
    const result = await runLs({
      catalog: FIXTURE_CATALOG,
      env: { RIGGER_HOME: tmp.dir },
      scope: 'user',
    });
    expect(result.count).toBe(FIXTURE_CATALOG.length);
  });
});

describe('runLs — manifest with installed entries', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('marks installed entries when manifest has artifacts', async () => {
    // Write a manifest with guardrails-claude installed
    const configDir = path.join(tmp.dir, '.config', 'agent-rigger');
    await fs.mkdir(configDir, { recursive: true });
    const stateJson = path.join(configDir, 'state.json');
    await fs.writeFile(
      stateJson,
      JSON.stringify({
        version: 1,
        artifacts: [
          {
            id: 'guardrails-claude',
            nature: 'guardrail',
            scope: 'user',
            files: [],
            installedAt: new Date().toISOString(),
          },
        ],
      }),
    );

    const result = await runLs({
      catalog: FIXTURE_CATALOG,
      env: { RIGGER_HOME: tmp.dir },
      scope: 'user',
    });

    // guardrails-claude should be [installed], others [available]
    expect(result.output).toContain('[installed]');
    expect(result.output).toContain('[available]');
    const lines = result.output.split('\n').filter((l) => l.includes('guardrails-claude'));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('[installed]');
  });
});

describe('runLs — resourceFilter', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await makeTmpHome();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('filters to only skill entries when resourceFilter is "skill"', async () => {
    const result = await runLs({
      catalog: FIXTURE_CATALOG,
      env: { RIGGER_HOME: tmp.dir },
      scope: 'user',
      resourceFilter: 'skill',
    });
    const skillEntries = FIXTURE_CATALOG.filter(
      (e) => e.kind === 'artifact' && e.nature === 'skill',
    );
    expect(result.count).toBe(skillEntries.length);
    // Should not contain non-skill entry ids
    expect(result.output).not.toContain('guardrails-claude');
  });

  it('filters to only pack entries when resourceFilter is "pack"', async () => {
    const result = await runLs({
      catalog: FIXTURE_CATALOG,
      env: { RIGGER_HOME: tmp.dir },
      scope: 'user',
      resourceFilter: 'pack',
    });
    const packEntries = FIXTURE_CATALOG.filter((e) => e.kind === 'pack');
    expect(result.count).toBe(packEntries.length);
    expect(result.output).not.toContain('guardrails-claude');
  });

  it('returns all entries when resourceFilter is undefined', async () => {
    const result = await runLs({
      catalog: FIXTURE_CATALOG,
      env: { RIGGER_HOME: tmp.dir },
      scope: 'user',
    });
    expect(result.count).toBe(FIXTURE_CATALOG.length);
  });
});
