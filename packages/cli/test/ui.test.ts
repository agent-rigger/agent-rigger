/**
 * Tests for ui.ts — pure rendering functions.
 *
 * Only renderPlan and renderReport are exercised here.
 * Interactive functions (selectArtifacts, selectScope, confirmApply) are
 * exported/typed checks only — clack must not be invoked in a non-TTY env.
 */

import { describe, expect, it } from 'bun:test';

import type { Report, WriteOp } from '@agent-rigger/core';
import { confirmApply, renderPlan, renderReport, selectArtifacts, selectScope } from '../src/ui';

// ---------------------------------------------------------------------------
// renderPlan — empty list
// ---------------------------------------------------------------------------

describe('renderPlan — empty list', () => {
  it('returns a "nothing to apply" message when ops is empty', () => {
    const result = renderPlan([]);
    expect(result.length).toBeGreaterThan(0);
    // Must convey "nothing" / "already up to date"
    expect(result.toLowerCase()).toMatch(/nothing|already up.to.date|no operation/);
  });
});

// ---------------------------------------------------------------------------
// renderPlan — merge-deny
// ---------------------------------------------------------------------------

describe('renderPlan — merge-deny', () => {
  it('renders path and deny rules', () => {
    const op: WriteOp = {
      kind: 'merge-deny',
      path: '.claude/settings.json',
      toAdd: ['Bash(rm:-rf)', 'Bash(curl:*)'],
    };
    const result = renderPlan([op]);
    expect(result).toContain('.claude/settings.json');
    expect(result).toContain('Bash(rm:-rf)');
    expect(result).toContain('Bash(curl:*)');
    // Must use + prefix for deny additions
    expect(result).toMatch(/\+/);
  });

  it('renders each rule on a separate line', () => {
    const op: WriteOp = {
      kind: 'merge-deny',
      path: 'settings.json',
      toAdd: ['rule-a', 'rule-b'],
    };
    const result = renderPlan([op]);
    const lines = result.split('\n');
    const ruleALine = lines.some((l) => l.includes('rule-a'));
    const ruleBLine = lines.some((l) => l.includes('rule-b'));
    expect(ruleALine).toBe(true);
    expect(ruleBLine).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderPlan — ensure-import
// ---------------------------------------------------------------------------

describe('renderPlan — ensure-import', () => {
  it('renders path and importLine with ~ prefix', () => {
    const op: WriteOp = {
      kind: 'ensure-import',
      path: 'CLAUDE.md',
      importLine: '@~/.claude/skills/my-skill/SKILL.md',
    };
    const result = renderPlan([op]);
    expect(result).toContain('CLAUDE.md');
    expect(result).toContain('@~/.claude/skills/my-skill/SKILL.md');
    expect(result).toMatch(/~/);
  });
});

// ---------------------------------------------------------------------------
// renderPlan — write-text
// ---------------------------------------------------------------------------

describe('renderPlan — write-text', () => {
  it('renders path with +/- prefix', () => {
    const op: WriteOp = {
      kind: 'write-text',
      path: '/home/user/.claude/skills/foo/SKILL.md',
      content: '# skill content',
      description: 'Write skill file',
    };
    const result = renderPlan([op]);
    expect(result).toContain('/home/user/.claude/skills/foo/SKILL.md');
    // Must contain the +/- (±) write marker
    expect(result).toMatch(/[+±]/);
  });
});

// ---------------------------------------------------------------------------
// renderPlan — write-json
// ---------------------------------------------------------------------------

describe('renderPlan — write-json', () => {
  it('renders path with write marker', () => {
    const op: WriteOp = {
      kind: 'write-json',
      path: '.agent-rigger/state.json',
      description: 'Update manifest',
    };
    const result = renderPlan([op]);
    expect(result).toContain('.agent-rigger/state.json');
    expect(result).toMatch(/[+±]/);
  });
});

// ---------------------------------------------------------------------------
// renderPlan — link
// ---------------------------------------------------------------------------

describe('renderPlan — link', () => {
  it('renders source, store, and target', () => {
    const op: WriteOp = {
      kind: 'link',
      source: '/repo/skills/foo',
      store: '/home/user/.agent-rigger/store/foo',
      target: '/home/user/.claude/skills/foo',
    };
    const result = renderPlan([op]);
    expect(result).toContain('/repo/skills/foo');
    expect(result).toContain('/home/user/.agent-rigger/store/foo');
    expect(result).toContain('/home/user/.claude/skills/foo');
    // Must use -> or arrow
    expect(result).toMatch(/->/);
  });
});

// ---------------------------------------------------------------------------
// renderPlan — plugin-install
// ---------------------------------------------------------------------------

describe('renderPlan — plugin-install', () => {
  it('renders plugin and marketplace', () => {
    const op: WriteOp = {
      kind: 'plugin-install',
      plugin: 'my-plugin',
      marketplace: 'https://marketplace.example.com/manifest.json',
    };
    const result = renderPlan([op]);
    expect(result).toContain('my-plugin');
    expect(result).toContain('https://marketplace.example.com/manifest.json');
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
});

// ---------------------------------------------------------------------------
// renderReport — entries
// ---------------------------------------------------------------------------

describe('renderReport', () => {
  it('labels present entries', () => {
    const report: Report = {
      entries: [
        { id: 'skill:foo', nature: 'skill', state: 'present' },
      ],
    };
    const result = renderReport(report);
    expect(result).toContain('skill:foo');
    expect(result.toLowerCase()).toMatch(/present|ok/);
  });

  it('labels missing entries', () => {
    const report: Report = {
      entries: [
        { id: 'plugin:bar', nature: 'plugin', state: 'missing' },
      ],
    };
    const result = renderReport(report);
    expect(result).toContain('plugin:bar');
    expect(result.toLowerCase()).toMatch(/missing/);
  });

  it('labels drift entries and includes detail when present', () => {
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
    expect(result.toLowerCase()).toMatch(/drift/);
    expect(result).toContain('sha mismatch');
  });

  it('renders all three states together', () => {
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
