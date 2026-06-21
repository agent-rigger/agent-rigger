/**
 * Tests for ui.ts — pure rendering functions.
 *
 * Only renderPlan, renderReport, and abbreviatePath are exercised here.
 * Interactive functions (selectArtifacts, selectScope, confirmApply) are
 * exported/typed checks only — clack must not be invoked in a non-TTY env.
 */

import { describe, expect, it } from 'bun:test';

import type { Report, WriteOp } from '@agent-rigger/core';
import {
  abbreviatePath,
  confirmApply,
  renderCatalogList,
  renderEntryInfo,
  renderPlan,
  renderReport,
  selectArtifacts,
  selectScope,
} from '../src/ui';

// ---------------------------------------------------------------------------
// abbreviatePath
// ---------------------------------------------------------------------------

describe('abbreviatePath', () => {
  it('abbreviates path under home to ~/<rel>', () => {
    expect(abbreviatePath('/home/me/.claude/settings.json', { home: '/home/me' })).toBe(
      '~/.claude/settings.json',
    );
  });

  it('abbreviates exact home to ~', () => {
    expect(abbreviatePath('/home/me', { home: '/home/me' })).toBe('~');
  });

  it('abbreviates path under cwd to ./<rel>', () => {
    expect(abbreviatePath('/project/.claude/x.md', { cwd: '/project' })).toBe('./.claude/x.md');
  });

  it('abbreviates exact cwd to .', () => {
    expect(abbreviatePath('/project', { cwd: '/project' })).toBe('.');
  });

  it('prefers home over cwd when both match', () => {
    // a path that starts with both home and cwd (contrived but tests priority)
    expect(abbreviatePath('/home/me/sub', { home: '/home/me', cwd: '/home/me' })).toBe('~/sub');
  });

  it('does not abbreviate unrelated path', () => {
    expect(abbreviatePath('/other/path/file', { home: '/home/me', cwd: '/project' })).toBe(
      '/other/path/file',
    );
  });

  it('does not match on partial directory segment', () => {
    // /home/me2 must NOT match home /home/me
    expect(abbreviatePath('/home/me2/file', { home: '/home/me' })).toBe('/home/me2/file');
  });

  it('returns path unchanged when opts is empty', () => {
    expect(abbreviatePath('/any/path')).toBe('/any/path');
  });
});

// ---------------------------------------------------------------------------
// renderPlan — empty list
// ---------------------------------------------------------------------------

describe('renderPlan — empty list', () => {
  it('returns a "nothing to apply" message when ops is empty', () => {
    const result = renderPlan([]);
    expect(result.length).toBeGreaterThan(0);
    expect(result.toLowerCase()).toMatch(/nothing|already up.to.date|no operation/);
  });
});

// ---------------------------------------------------------------------------
// renderPlan — header
// ---------------------------------------------------------------------------

describe('renderPlan — header', () => {
  it('starts with "Plan (1 change):" for a single op', () => {
    const op: WriteOp = {
      kind: 'write-text',
      path: '/tmp/x.md',
      content: '',
      description: 'test',
    };
    const result = renderPlan([op]);
    expect(result).toMatch(/^Plan \(1 change\):/);
  });

  it('starts with "Plan (N changes):" for multiple ops', () => {
    const ops: WriteOp[] = [
      { kind: 'write-text', path: '/a', content: '', description: '' },
      { kind: 'write-json', path: '/b', description: '' },
    ];
    const result = renderPlan(ops);
    expect(result).toMatch(/^Plan \(2 changes\):/);
  });

  it('has a blank line after the header', () => {
    const op: WriteOp = {
      kind: 'write-text',
      path: '/tmp/x.md',
      content: '',
      description: 'test',
    };
    const lines = renderPlan([op]).split('\n');
    expect(lines[1]).toBe('');
  });
});

// ---------------------------------------------------------------------------
// renderPlan — merge-deny
// ---------------------------------------------------------------------------

describe('renderPlan — merge-deny', () => {
  it('renders verb "deny" and abbreviated path', () => {
    const op: WriteOp = {
      kind: 'merge-deny',
      path: '/home/me/.claude/settings.json',
      toAdd: ['Bash(rm:-rf)', 'Bash(curl:*)'],
    };
    const result = renderPlan([op], { home: '/home/me' });
    expect(result).toContain('deny');
    expect(result).toContain('~/.claude/settings.json');
    expect(result).not.toContain('/home/me/.claude/settings.json');
  });

  it('renders each rule on its own indented line with + prefix', () => {
    const op: WriteOp = {
      kind: 'merge-deny',
      path: 'settings.json',
      toAdd: ['rule-a', 'rule-b'],
    };
    const result = renderPlan([op]);
    const lines = result.split('\n');
    expect(lines.some((l) => l.includes('rule-a') && l.includes('+'))).toBe(true);
    expect(lines.some((l) => l.includes('rule-b') && l.includes('+'))).toBe(true);
  });

  it('renders path without abbreviation when no opts provided', () => {
    const op: WriteOp = {
      kind: 'merge-deny',
      path: '.claude/settings.json',
      toAdd: ['Bash(rm:-rf)'],
    };
    const result = renderPlan([op]);
    expect(result).toContain('.claude/settings.json');
    expect(result).toContain('Bash(rm:-rf)');
  });
});

// ---------------------------------------------------------------------------
// renderPlan — ensure-import
// ---------------------------------------------------------------------------

describe('renderPlan — ensure-import', () => {
  it('renders verb "import" and abbreviated path with importLine as detail', () => {
    const op: WriteOp = {
      kind: 'ensure-import',
      path: '/home/me/.claude/CLAUDE.md',
      importLine: '@~/.claude/skills/my-skill/SKILL.md',
    };
    const result = renderPlan([op], { home: '/home/me' });
    expect(result).toContain('import');
    expect(result).toContain('~/.claude/CLAUDE.md');
    expect(result).toContain('@~/.claude/skills/my-skill/SKILL.md');
  });

  it('renders importLine indented below the verb line', () => {
    const op: WriteOp = {
      kind: 'ensure-import',
      path: 'CLAUDE.md',
      importLine: '@skill.md',
    };
    const lines = renderPlan([op]).split('\n');
    const verbLineIdx = lines.findIndex((l) => l.includes('import') && l.includes('CLAUDE.md'));
    expect(verbLineIdx).toBeGreaterThanOrEqual(0);
    const detailLine = lines[verbLineIdx + 1];
    expect(detailLine).toBeDefined();
    expect(detailLine).toContain('@skill.md');
    // Detail must be indented (starts with spaces)
    expect(detailLine).toMatch(/^\s+/);
  });
});

// ---------------------------------------------------------------------------
// renderPlan — write-text
// ---------------------------------------------------------------------------

describe('renderPlan — write-text', () => {
  it('renders verb "write" and abbreviated path', () => {
    const op: WriteOp = {
      kind: 'write-text',
      path: '/home/user/.claude/skills/foo/SKILL.md',
      content: '# skill content',
      description: 'Write skill file',
    };
    const result = renderPlan([op], { home: '/home/user' });
    expect(result).toContain('write');
    expect(result).toContain('~/.claude/skills/foo/SKILL.md');
  });

  it('renders absolute path when no abbreviation applies', () => {
    const op: WriteOp = {
      kind: 'write-text',
      path: '/home/user/.claude/skills/foo/SKILL.md',
      content: '# skill content',
      description: 'Write skill file',
    };
    const result = renderPlan([op]);
    expect(result).toContain('/home/user/.claude/skills/foo/SKILL.md');
  });
});

// ---------------------------------------------------------------------------
// renderPlan — write-json
// ---------------------------------------------------------------------------

describe('renderPlan — write-json', () => {
  it('renders verb "write" and path', () => {
    const op: WriteOp = {
      kind: 'write-json',
      path: '.agent-rigger/state.json',
      description: 'Update manifest',
    };
    const result = renderPlan([op]);
    expect(result).toContain('write');
    expect(result).toContain('.agent-rigger/state.json');
  });
});

// ---------------------------------------------------------------------------
// renderPlan — link
// ---------------------------------------------------------------------------

describe('renderPlan — link', () => {
  it('renders verb "link", abbreviated target and source as detail', () => {
    const op: WriteOp = {
      kind: 'link',
      source: '/project/skills/foo',
      store: '/home/user/.agent-rigger/store/foo',
      target: '/home/user/.claude/skills/foo',
    };
    const result = renderPlan([op], { home: '/home/user', cwd: '/project' });
    expect(result).toContain('link');
    expect(result).toContain('~/.claude/skills/foo');
    expect(result).toContain('./skills/foo');
    // store path shown as detail via "from" keyword
    expect(result).toContain('from');
  });

  it('renders "from <source>" indented as detail when no abbreviation', () => {
    const op: WriteOp = {
      kind: 'link',
      source: '/repo/skills/foo',
      store: '/home/user/.agent-rigger/store/foo',
      target: '/home/user/.claude/skills/foo',
    };
    const lines = renderPlan([op]).split('\n');
    const verbLineIdx = lines.findIndex((l) => l.includes('link'));
    expect(verbLineIdx).toBeGreaterThanOrEqual(0);
    const detailLine = lines[verbLineIdx + 1];
    expect(detailLine).toContain('from');
    expect(detailLine).toContain('/repo/skills/foo');
  });
});

// ---------------------------------------------------------------------------
// renderPlan — plugin-install
// ---------------------------------------------------------------------------

describe('renderPlan — plugin-install', () => {
  it('renders verb "plugin", plugin name and marketplace as detail', () => {
    const op: WriteOp = {
      kind: 'plugin-install',
      plugin: 'my-plugin',
      marketplace: 'https://marketplace.example.com/manifest.json',
    };
    const result = renderPlan([op]);
    expect(result).toContain('plugin');
    expect(result).toContain('my-plugin');
    expect(result).toContain('https://marketplace.example.com/manifest.json');
    expect(result).toContain('via');
  });

  it('abbreviates marketplace path when cwd matches', () => {
    const op: WriteOp = {
      kind: 'plugin-install',
      plugin: 'local-plugin',
      marketplace: '/project/.claude-plugin/marketplace.json',
    };
    const result = renderPlan([op], { cwd: '/project' });
    expect(result).toContain('./.claude-plugin/marketplace.json');
  });
});

// ---------------------------------------------------------------------------
// renderPlan — path abbreviation with home and cwd
// ---------------------------------------------------------------------------

describe('renderPlan — path abbreviation', () => {
  it('abbreviates home paths to ~ in merge-deny', () => {
    const op: WriteOp = {
      kind: 'merge-deny',
      path: '/home/me/.claude/settings.json',
      toAdd: ['Read(./.env)'],
    };
    const result = renderPlan([op], { home: '/home/me' });
    expect(result).toContain('~/.claude/settings.json');
    expect(result).not.toContain('/home/me/.claude/settings.json');
  });

  it('abbreviates cwd paths to ./ in write-text', () => {
    const op: WriteOp = {
      kind: 'write-text',
      path: '/workspace/project/.claude/CLAUDE.md',
      content: '',
      description: '',
    };
    const result = renderPlan([op], { cwd: '/workspace/project' });
    expect(result).toContain('./.claude/CLAUDE.md');
    expect(result).not.toContain('/workspace/project/.claude/CLAUDE.md');
  });

  it('leaves absolute path unchanged when no opts match', () => {
    const op: WriteOp = {
      kind: 'write-text',
      path: '/other/place/file.md',
      content: '',
      description: '',
    };
    const result = renderPlan([op], { home: '/home/me', cwd: '/project' });
    expect(result).toContain('/other/place/file.md');
  });
});

// ---------------------------------------------------------------------------
// renderPlan — multiple ops
// ---------------------------------------------------------------------------

describe('renderPlan — multiple ops', () => {
  it('renders all ops in the output', () => {
    const ops: WriteOp[] = [
      {
        kind: 'write-text',
        path: '/path/to/file.md',
        content: 'content',
        description: 'desc',
      },
      {
        kind: 'ensure-import',
        path: 'CLAUDE.md',
        importLine: '@skill.md',
      },
      {
        kind: 'plugin-install',
        plugin: 'plugin-x',
        marketplace: 'https://mkt.example.com',
      },
    ];
    const result = renderPlan(ops);
    expect(result).toContain('/path/to/file.md');
    expect(result).toContain('CLAUDE.md');
    expect(result).toContain('@skill.md');
    expect(result).toContain('plugin-x');
    expect(result).toContain('https://mkt.example.com');
  });

  it('counts ops correctly in the header', () => {
    const ops: WriteOp[] = [
      { kind: 'write-text', path: '/a', content: '', description: '' },
      { kind: 'write-json', path: '/b', description: '' },
      { kind: 'write-json', path: '/c', description: '' },
    ];
    const result = renderPlan(ops);
    expect(result).toMatch(/Plan \(3 changes\):/);
  });
});

// ---------------------------------------------------------------------------
// renderReport — entries
// ---------------------------------------------------------------------------

describe('renderReport', () => {
  it('labels present entries with [ ok  ]', () => {
    const report: Report = {
      entries: [{ id: 'skill:foo', nature: 'skill', state: 'present' }],
    };
    const result = renderReport(report);
    expect(result).toContain('skill:foo');
    expect(result).toContain('[ ok  ]');
  });

  it('labels missing entries with [miss ]', () => {
    const report: Report = {
      entries: [{ id: 'plugin:bar', nature: 'plugin', state: 'missing' }],
    };
    const result = renderReport(report);
    expect(result).toContain('plugin:bar');
    expect(result).toContain('[miss ]');
  });

  it('labels drift entries with [drift] and includes detail when present', () => {
    const report: Report = {
      entries: [
        {
          id: 'guardrail:baz',
          nature: 'guardrail',
          state: 'drift',
          detail: 'sha mismatch',
        },
      ],
    };
    const result = renderReport(report);
    expect(result).toContain('guardrail:baz');
    expect(result).toContain('[drift]');
    expect(result).toContain('sha mismatch');
  });

  it('renders all three states together with aligned tags', () => {
    const report: Report = {
      entries: [
        { id: 'a', nature: 'skill', state: 'present' },
        { id: 'b', nature: 'mcp', state: 'missing' },
        { id: 'c', nature: 'agent', state: 'drift', detail: 'file removed' },
      ],
    };
    const result = renderReport(report);
    expect(result).toContain('a');
    expect(result).toContain('b');
    expect(result).toContain('c');
    expect(result).toContain('file removed');
    // All three tags must be present
    expect(result).toContain('[ ok  ]');
    expect(result).toContain('[miss ]');
    expect(result).toContain('[drift]');
  });

  it('all state tags have the same width', () => {
    const report: Report = {
      entries: [
        { id: 'a', nature: 'skill', state: 'present' },
        { id: 'b', nature: 'mcp', state: 'missing' },
        { id: 'c', nature: 'agent', state: 'drift' },
      ],
    };
    const result = renderReport(report);
    // Extract tag strings from each line
    const tagRe = /\[.+?\]/;
    const tags = result
      .split('\n')
      .map((l) => tagRe.exec(l)?.[0])
      .filter(Boolean) as string[];
    const lengths = tags.map((t) => t.length);
    expect(lengths.length).toBe(3);
    // All tags must be the same length
    expect(new Set(lengths).size).toBe(1);
  });

  it('returns a coherent message when entries is empty', () => {
    const report: Report = { entries: [] };
    const result = renderReport(report);
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Interactive exports — type-level checks (no invocation)
// ---------------------------------------------------------------------------

describe('interactive exports', () => {
  it('selectArtifacts is a function', () => {
    expect(typeof selectArtifacts).toBe('function');
  });

  it('selectScope is a function', () => {
    expect(typeof selectScope).toBe('function');
  });

  it('confirmApply is a function', () => {
    expect(typeof confirmApply).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// New pure rendering exports — type-level checks
// ---------------------------------------------------------------------------

describe('new pure rendering exports', () => {
  it('renderCatalogList is a function', () => {
    expect(typeof renderCatalogList).toBe('function');
  });

  it('renderEntryInfo is a function', () => {
    expect(typeof renderEntryInfo).toBe('function');
  });
});
