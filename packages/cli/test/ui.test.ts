/**
 * Tests for ui.ts — pure rendering functions.
 *
 * Only renderPlan, renderRemovalPlan, renderReport, abbreviatePath,
 * renderCatalogList, renderEntryInfo are exercised here.
 * Interactive functions (selectArtifacts, selectScope, confirmApply) are
 * exported/typed checks only — clack must not be invoked in a non-TTY env.
 *
 * ALL renderPlan / renderRemovalPlan tests pass color: false explicitly so
 * output is deterministic regardless of the terminal environment.
 */

import { describe, expect, it } from 'bun:test';

import type { CatalogEntry } from '@agent-rigger/catalog';
import { manifestAppliedDrift, untrackedHostDiff } from '@agent-rigger/core';
import type { RemovalOp, Report, WriteOp } from '@agent-rigger/core';
import {
  abbreviatePath,
  buildStatusInitialValues,
  buildStatusOptions,
  confirmApply,
  confirmToolChecks,
  renderCatalogList,
  renderDoctorReport,
  renderEntryInfo,
  renderPlan,
  renderRemovalPlan,
  renderReport,
  selectArtifacts,
  selectScope,
} from '../src/ui';
import type { PlanGroup, PlanRemovalGroup, StatusedEntry } from '../src/ui';

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
// renderPlan — empty groups
// ---------------------------------------------------------------------------

describe('renderPlan — empty groups', () => {
  it('returns a "nothing to apply" message when groups is empty', () => {
    const result = renderPlan([]);
    expect(result.length).toBeGreaterThan(0);
    expect(result.toLowerCase()).toMatch(/nothing|already up.to.date|no operation/);
  });
});

// ---------------------------------------------------------------------------
// renderPlan — header
// ---------------------------------------------------------------------------

describe('renderPlan — header', () => {
  it('contains "Plan · N change(s)" for total ops count', () => {
    const group: PlanGroup = {
      id: 'guardrail:claude',
      nature: 'guardrail',
      action: 'install',
      ops: [{ kind: 'write-json', path: '/p', description: '' }],
    };
    const result = renderPlan([group], { color: false });
    expect(result).toContain('Plan · 1 change');
  });

  it('counts total ops across all groups', () => {
    const groups: PlanGroup[] = [
      {
        id: 'a',
        nature: 'guardrail',
        action: 'install',
        ops: [
          { kind: 'write-json', path: '/a', description: '' },
          { kind: 'write-json', path: '/b', description: '' },
        ],
      },
      {
        id: 'b',
        nature: 'skill',
        action: 'install',
        ops: [{ kind: 'write-json', path: '/c', description: '' }],
      },
    ];
    const result = renderPlan(groups, { color: false });
    expect(result).toContain('Plan · 3 changes');
  });

  it('includes "scope: user" and home root when scope user provided', () => {
    const group: PlanGroup = {
      id: 'a',
      nature: 'guardrail',
      action: 'install',
      ops: [{ kind: 'write-json', path: '/p', description: '' }],
    };
    const result = renderPlan([group], { color: false, scope: 'user', home: '/home/me' });
    expect(result).toContain('scope: user');
    expect(result).toContain('~/.claude');
  });

  it('includes "scope: project" and cwd root when scope project provided', () => {
    const group: PlanGroup = {
      id: 'a',
      nature: 'skill',
      action: 'install',
      ops: [{ kind: 'write-json', path: '/p', description: '' }],
    };
    const result = renderPlan([group], { color: false, scope: 'project', cwd: '/workspace' });
    expect(result).toContain('scope: project');
    expect(result).toContain('./.claude');
  });

  it('has a blank line after the header', () => {
    const group: PlanGroup = {
      id: 'a',
      nature: 'guardrail',
      action: 'install',
      ops: [{ kind: 'write-json', path: '/p', description: '' }],
    };
    const lines = renderPlan([group], { color: false }).split('\n');
    expect(lines[1]).toBe('');
  });
});

// ---------------------------------------------------------------------------
// renderPlan — action + vs ~
// ---------------------------------------------------------------------------

describe('renderPlan — action install vs update', () => {
  it('prefixes group line with "+" for install action', () => {
    const group: PlanGroup = {
      id: 'guardrail:claude',
      nature: 'guardrail',
      action: 'install',
      ops: [{ kind: 'write-json', path: '/p', description: '' }],
    };
    const result = renderPlan([group], { color: false });
    const groupLine = result.split('\n').find((l) => l.includes('guardrail:claude'));
    expect(groupLine).toBeDefined();
    expect(groupLine!.trimStart()).toMatch(/^\+/);
  });

  it('prefixes group line with "~" for update action', () => {
    const group: PlanGroup = {
      id: 'guardrail:claude',
      nature: 'guardrail',
      action: 'update',
      ops: [{ kind: 'write-json', path: '/p', description: '' }],
    };
    const result = renderPlan([group], { color: false });
    const groupLine = result.split('\n').find((l) => l.includes('guardrail:claude'));
    expect(groupLine).toBeDefined();
    expect(groupLine!.trimStart()).toMatch(/^~/);
  });
});

// ---------------------------------------------------------------------------
// renderPlan — merge-deny
// ---------------------------------------------------------------------------

describe('renderPlan — merge-deny', () => {
  it('renders "deny  (+N)" with each rule prefixed "+"', () => {
    const op: WriteOp = {
      kind: 'merge-deny',
      path: '/home/me/.claude/settings.json',
      toAdd: ['Bash(rm:-rf)', 'Read(~/.ssh/**)'],
    };
    const group: PlanGroup = {
      id: 'guardrail:claude',
      nature: 'guardrail',
      action: 'install',
      ops: [op],
    };
    const result = renderPlan([group], { color: false, home: '/home/me' });
    expect(result).toContain('deny  (+2)');
    expect(result).toContain('+ Bash(rm:-rf)');
    expect(result).toContain('+ Read(~/.ssh/**)');
  });

  it('truncates rules beyond maxDetail with "… +K more"', () => {
    const rules = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'];
    const op: WriteOp = { kind: 'merge-deny', path: '/p', toAdd: rules };
    const group: PlanGroup = { id: 'a', nature: 'guardrail', action: 'install', ops: [op] };
    const result = renderPlan([group], { color: false, maxDetail: 3 });
    expect(result).toContain('deny  (+8)');
    expect(result).toContain('+ r1');
    expect(result).toContain('+ r3');
    expect(result).not.toContain('+ r4');
    expect(result).toContain('… +5 more');
  });

  it('shows all rules when count <= maxDetail', () => {
    const op: WriteOp = { kind: 'merge-deny', path: '/p', toAdd: ['r1', 'r2'] };
    const group: PlanGroup = { id: 'a', nature: 'guardrail', action: 'install', ops: [op] };
    const result = renderPlan([group], { color: false, maxDetail: 6 });
    expect(result).toContain('+ r1');
    expect(result).toContain('+ r2');
    expect(result).not.toContain('more');
  });

  it('shows abbreviated path in group header', () => {
    const op: WriteOp = {
      kind: 'merge-deny',
      path: '/home/me/.claude/settings.json',
      toAdd: ['r1'],
    };
    const group: PlanGroup = {
      id: 'guardrail:claude',
      nature: 'guardrail',
      action: 'install',
      ops: [op],
    };
    const result = renderPlan([group], { color: false, home: '/home/me' });
    expect(result).toContain('~/.claude/settings.json');
    expect(result).not.toContain('/home/me/.claude/settings.json');
  });

  it('renders path without abbreviation when no opts provided', () => {
    const op: WriteOp = { kind: 'merge-deny', path: '.claude/settings.json', toAdd: ['r1'] };
    const group: PlanGroup = { id: 'a', nature: 'guardrail', action: 'install', ops: [op] };
    const result = renderPlan([group], { color: false });
    expect(result).toContain('.claude/settings.json');
  });
});

// ---------------------------------------------------------------------------
// renderPlan — merge-allow
// ---------------------------------------------------------------------------

describe('renderPlan — merge-allow', () => {
  it('renders "allow  (+N)" with each rule', () => {
    const op: WriteOp = {
      kind: 'merge-allow',
      path: '/p',
      toAdd: ['Bash(git status)', 'Read(./src/*)'],
    };
    const group: PlanGroup = { id: 'a', nature: 'guardrail', action: 'install', ops: [op] };
    const result = renderPlan([group], { color: false });
    expect(result).toContain('allow  (+2)');
    expect(result).toContain('+ Bash(git status)');
    expect(result).toContain('+ Read(./src/*)');
  });

  it('truncates allow rules beyond maxDetail', () => {
    const op: WriteOp = {
      kind: 'merge-allow',
      path: '/p',
      toAdd: ['r1', 'r2', 'r3', 'r4', 'r5'],
    };
    const group: PlanGroup = { id: 'a', nature: 'guardrail', action: 'install', ops: [op] };
    const result = renderPlan([group], { color: false, maxDetail: 2 });
    expect(result).toContain('… +3 more');
  });
});

// ---------------------------------------------------------------------------
// renderPlan — write-text
// ---------------------------------------------------------------------------

describe('renderPlan — write-text', () => {
  it('renders "write  +L / -0" with the content line count', () => {
    const content = 'line1\nline2\nline3';
    const op: WriteOp = { kind: 'write-text', path: '/p', content, description: '' };
    const group: PlanGroup = { id: 'a', nature: 'context', action: 'install', ops: [op] };
    const result = renderPlan([group], { color: false });
    expect(result).toContain('write  +3 / -0');
  });

  it('shows first N lines with "│" prefix up to maxDetail', () => {
    const content = 'l1\nl2\nl3\nl4\nl5\nl6\nl7';
    const op: WriteOp = { kind: 'write-text', path: '/p', content, description: '' };
    const group: PlanGroup = { id: 'a', nature: 'context', action: 'install', ops: [op] };
    const result = renderPlan([group], { color: false, maxDetail: 3 });
    expect(result).toContain('│ l1');
    expect(result).toContain('│ l3');
    expect(result).not.toContain('│ l4');
    expect(result).toContain('│ …');
  });

  it('shows all lines when count <= maxDetail without truncation marker', () => {
    const content = 'a\nb\nc';
    const op: WriteOp = { kind: 'write-text', path: '/p', content, description: '' };
    const group: PlanGroup = { id: 'a', nature: 'context', action: 'install', ops: [op] };
    const result = renderPlan([group], { color: false, maxDetail: 6 });
    expect(result).toContain('│ a');
    expect(result).toContain('│ c');
    expect(result).not.toContain('│ …');
  });

  it('abbreviates path in abbreviated form', () => {
    const op: WriteOp = {
      kind: 'write-text',
      path: '/home/user/.claude/skills/foo/SKILL.md',
      content: '# skill',
      description: '',
    };
    const group: PlanGroup = { id: 'skill:foo', nature: 'skill', action: 'install', ops: [op] };
    const result = renderPlan([group], { color: false, home: '/home/user' });
    expect(result).toContain('~/.claude/skills/foo/SKILL.md');
  });

  it('reports +0 for empty content', () => {
    const op: WriteOp = { kind: 'write-text', path: '/p', content: '', description: '' };
    const group: PlanGroup = { id: 'a', nature: 'context', action: 'install', ops: [op] };
    const result = renderPlan([group], { color: false });
    expect(result).toContain('write  +0 / -0');
  });

  it('ignores trailing newline in line count', () => {
    // 'a\nb\n' is 2 logical lines, not 3
    const op: WriteOp = { kind: 'write-text', path: '/p', content: 'a\nb\n', description: '' };
    const group: PlanGroup = { id: 'a', nature: 'context', action: 'install', ops: [op] };
    const result = renderPlan([group], { color: false });
    expect(result).toContain('write  +2 / -0');
  });
});

// ---------------------------------------------------------------------------
// renderPlan — write-json
// ---------------------------------------------------------------------------

describe('renderPlan — write-json', () => {
  it('renders "write  <abbr path>" without content dump', () => {
    const op: WriteOp = {
      kind: 'write-json',
      path: '/home/me/.claude/settings.json',
      description: '',
    };
    const group: PlanGroup = { id: 'a', nature: 'guardrail', action: 'install', ops: [op] };
    const result = renderPlan([group], { color: false, home: '/home/me' });
    expect(result).toContain('write  ~/.claude/settings.json');
  });

  it('renders absolute path when no abbreviation applies', () => {
    const op: WriteOp = { kind: 'write-json', path: '/state.json', description: '' };
    const group: PlanGroup = { id: 'a', nature: 'guardrail', action: 'install', ops: [op] };
    const result = renderPlan([group], { color: false });
    expect(result).toContain('write  /state.json');
  });

  it('counts write-json in Σ write total', () => {
    const ops: WriteOp[] = [
      { kind: 'write-json', path: '/a.json', description: '' },
      { kind: 'write-json', path: '/b.json', description: '' },
    ];
    const group: PlanGroup = { id: 'a', nature: 'guardrail', action: 'install', ops };
    const result = renderPlan([group], { color: false });
    expect(result).toContain('2 writes');
  });
});

// ---------------------------------------------------------------------------
// renderPlan — ensure-import
// ---------------------------------------------------------------------------

describe('renderPlan — ensure-import', () => {
  it('renders "import  <importLine>"', () => {
    const op: WriteOp = {
      kind: 'ensure-import',
      path: '/home/me/.claude/CLAUDE.md',
      importLine: '@~/.claude/skills/foo/SKILL.md',
    };
    const group: PlanGroup = { id: 'skill:foo', nature: 'skill', action: 'install', ops: [op] };
    const result = renderPlan([group], { color: false });
    expect(result).toContain('import  @~/.claude/skills/foo/SKILL.md');
  });
});

// ---------------------------------------------------------------------------
// renderPlan — link
// ---------------------------------------------------------------------------

describe('renderPlan — link', () => {
  it('renders "link  <abbr target> → store"', () => {
    const op: WriteOp = {
      kind: 'link',
      source: '/src/foo',
      store: '/store/foo',
      target: '/home/me/.claude/skills/foo',
    };
    const group: PlanGroup = { id: 'skill:foo', nature: 'skill', action: 'install', ops: [op] };
    const result = renderPlan([group], { color: false, home: '/home/me' });
    expect(result).toContain('link  ~/.claude/skills/foo → store');
  });

  it('renders unabbreviated link when no opts match', () => {
    const op: WriteOp = {
      kind: 'link',
      source: '/src/foo',
      store: '/store/foo',
      target: '/other/path/foo',
    };
    const group: PlanGroup = { id: 'skill:foo', nature: 'skill', action: 'install', ops: [op] };
    const result = renderPlan([group], { color: false });
    expect(result).toContain('link  /other/path/foo → store');
  });

  it('group header shows target without redundant → store', () => {
    const op: WriteOp = {
      kind: 'link',
      source: '/src/foo',
      store: '/store/foo',
      target: '/home/me/.claude/skills/foo',
    };
    const group: PlanGroup = { id: 'skill:foo', nature: 'skill', action: 'install', ops: [op] };
    const result = renderPlan([group], { color: false, home: '/home/me' });
    const headerLine = result.split('\n').find((l) => l.startsWith('+ '));
    expect(headerLine).toBe('+ skill:foo   ~/.claude/skills/foo');
    // → store appears exactly once (body only, not header)
    expect(result.split('→ store').length - 1).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// renderPlan — plugin-install
// ---------------------------------------------------------------------------

describe('renderPlan — plugin-install', () => {
  it('renders "plugin  <name>" and "via <abbr marketplace>"', () => {
    const op: WriteOp = {
      kind: 'plugin-install',
      plugin: 'my-plugin',
      marketplace: '/project/.claude-plugin/marketplace.json',
    };
    const group: PlanGroup = { id: 'plugin:my', nature: 'plugin', action: 'install', ops: [op] };
    const result = renderPlan([group], { color: false, cwd: '/project' });
    expect(result).toContain('plugin  my-plugin');
    expect(result).toContain('via ./.claude-plugin/marketplace.json');
  });

  it('shows full marketplace URL when it cannot be abbreviated', () => {
    const op: WriteOp = {
      kind: 'plugin-install',
      plugin: 'remote-plugin',
      marketplace: 'https://marketplace.example.com/manifest.json',
    };
    const group: PlanGroup = {
      id: 'plugin:remote',
      nature: 'plugin',
      action: 'install',
      ops: [op],
    };
    const result = renderPlan([group], { color: false });
    expect(result).toContain('via https://marketplace.example.com/manifest.json');
  });
});

// ---------------------------------------------------------------------------
// renderPlan — merge-hooks
// ---------------------------------------------------------------------------

describe('renderPlan — merge-hooks', () => {
  it('renders "hook  event/matcher → scriptname"', () => {
    const op: WriteOp = {
      kind: 'merge-hooks',
      path: '/home/me/.claude/settings.json',
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'bun run /store/hooks/guard-bash.ts',
    };
    const group: PlanGroup = {
      id: 'hook:guard-bash',
      nature: 'hook',
      action: 'install',
      ops: [op],
    };
    const result = renderPlan([group], { color: false, home: '/home/me' });
    expect(result).toContain('hook  PreToolUse/Bash → guard-bash.ts');
  });

  it('shows group header with abbreviated settings path', () => {
    const op: WriteOp = {
      kind: 'merge-hooks',
      path: '/home/me/.claude/settings.json',
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'bun run x',
    };
    const group: PlanGroup = {
      id: 'hook:guard-bash',
      nature: 'hook',
      action: 'install',
      ops: [op],
    };
    const result = renderPlan([group], { color: false, home: '/home/me' });
    expect(result).toContain('~/.claude/settings.json');
    expect(result).not.toContain('/home/me/.claude/settings.json');
  });

  it('adds "link  <abbr scriptStore>" when scriptStore is defined', () => {
    const op: WriteOp = {
      kind: 'merge-hooks',
      path: '/home/me/.claude/settings.json',
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'bun run /store/hooks/guard-bash.ts',
      scriptStore: '/home/me/.config/agent-rigger/hooks',
    };
    const group: PlanGroup = {
      id: 'hook:guard-bash',
      nature: 'hook',
      action: 'install',
      ops: [op],
    };
    const result = renderPlan([group], { color: false, home: '/home/me' });
    expect(result).toContain('link  ~/.config/agent-rigger/hooks');
  });

  it('extracts script name from scriptStore basename when provided', () => {
    const op: WriteOp = {
      kind: 'merge-hooks',
      path: '/h/.claude/settings.json',
      event: 'PreToolUse',
      matcher: '*',
      command: 'bun run x',
      scriptStore: '/h/.config/agent-rigger/hooks',
    };
    const group: PlanGroup = { id: 'a', nature: 'hook', action: 'install', ops: [op] };
    const result = renderPlan([group], { color: false });
    // scriptStore basename is 'hooks' → shown after →
    expect(result).toContain('hooks');
  });

  it('counts the op in the plan header', () => {
    const op: WriteOp = {
      kind: 'merge-hooks',
      path: '/h/.claude/settings.json',
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'bun run x',
    };
    const group: PlanGroup = { id: 'a', nature: 'hook', action: 'install', ops: [op] };
    const result = renderPlan([group], { color: false });
    expect(result).toContain('Plan · 1 change');
  });
});

// ---------------------------------------------------------------------------
// renderPlan — Σ line
// ---------------------------------------------------------------------------

describe('renderPlan — Σ line', () => {
  it('shows deny +N in Σ line (total rule count)', () => {
    const op: WriteOp = { kind: 'merge-deny', path: '/p', toAdd: ['r1', 'r2', 'r3'] };
    const group: PlanGroup = { id: 'a', nature: 'guardrail', action: 'install', ops: [op] };
    const result = renderPlan([group], { color: false });
    expect(result).toContain('deny +3');
  });

  it('omits zero-count categories from Σ line', () => {
    const op: WriteOp = { kind: 'merge-deny', path: '/p', toAdd: ['r1'] };
    const group: PlanGroup = { id: 'a', nature: 'guardrail', action: 'install', ops: [op] };
    const result = renderPlan([group], { color: false });
    const sigmaLine = result.split('\n').find((l) => l.includes('Σ'));
    expect(sigmaLine).toBeDefined();
    expect(sigmaLine).not.toContain('write');
    expect(sigmaLine).not.toContain('link');
    expect(sigmaLine).not.toContain('plugin');
  });

  it('aggregates deny+write across multiple groups', () => {
    const groups: PlanGroup[] = [
      {
        id: 'guardrail:claude',
        nature: 'guardrail',
        action: 'install',
        ops: [{ kind: 'merge-deny', path: '/p', toAdd: ['r1', 'r2'] }],
      },
      {
        id: 'context:agents',
        nature: 'context',
        action: 'install',
        ops: [{ kind: 'write-text', path: '/q', content: 'hello\nworld', description: '' }],
      },
    ];
    const result = renderPlan(groups, { color: false });
    expect(result).toContain('deny +2');
    expect(result).toContain('1 write');
  });

  it('shows link count in Σ', () => {
    const groups: PlanGroup[] = [
      {
        id: 'skill:foo',
        nature: 'skill',
        action: 'install',
        ops: [{ kind: 'link', source: '/s', store: '/st', target: '/t1' }],
      },
      {
        id: 'agent:bar',
        nature: 'agent',
        action: 'install',
        ops: [{ kind: 'link', source: '/s2', store: '/st2', target: '/t2' }],
      },
    ];
    const result = renderPlan(groups, { color: false });
    expect(result).toContain('2 links');
  });

  it('shows hook count in Σ', () => {
    const op: WriteOp = {
      kind: 'merge-hooks',
      path: '/p',
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'x',
    };
    const group: PlanGroup = { id: 'a', nature: 'hook', action: 'install', ops: [op] };
    const result = renderPlan([group], { color: false });
    expect(result).toContain('1 hook');
  });
});

// ---------------------------------------------------------------------------
// renderPlan — color
// ---------------------------------------------------------------------------

describe('renderPlan — color', () => {
  it('contains ANSI escape codes when color:true', () => {
    const group: PlanGroup = {
      id: 'guardrail:claude',
      nature: 'guardrail',
      action: 'install',
      ops: [{ kind: 'merge-deny', path: '/p', toAdd: ['r1'] }],
    };
    const result = renderPlan([group], { color: true });
    expect(result).toContain('\x1b[');
  });

  it('contains no ANSI escape codes when color:false', () => {
    const group: PlanGroup = {
      id: 'guardrail:claude',
      nature: 'guardrail',
      action: 'install',
      ops: [{ kind: 'merge-deny', path: '/p', toAdd: ['r1'] }],
    };
    const result = renderPlan([group], { color: false });
    expect(result).not.toContain('\x1b[');
  });
});

// ---------------------------------------------------------------------------
// renderPlan — multi-group
// ---------------------------------------------------------------------------

describe('renderPlan — multi-group', () => {
  it('renders all groups in output', () => {
    const groups: PlanGroup[] = [
      {
        id: 'guardrail:claude',
        nature: 'guardrail',
        action: 'install',
        ops: [{ kind: 'merge-deny', path: '/p', toAdd: ['r1'] }],
      },
      {
        id: 'skill:foo',
        nature: 'skill',
        action: 'update',
        ops: [{ kind: 'link', source: '/s', store: '/st', target: '/t' }],
      },
    ];
    const result = renderPlan(groups, { color: false });
    expect(result).toContain('guardrail:claude');
    expect(result).toContain('skill:foo');
    expect(result).toContain('deny  (+1)');
    expect(result).toContain('link  /t → store');
  });

  it('path abbreviation works for home in merge-deny', () => {
    const op: WriteOp = {
      kind: 'merge-deny',
      path: '/home/me/.claude/settings.json',
      toAdd: ['Read(./.env)'],
    };
    const group: PlanGroup = {
      id: 'guardrail:claude',
      nature: 'guardrail',
      action: 'install',
      ops: [op],
    };
    const result = renderPlan([group], { color: false, home: '/home/me' });
    expect(result).toContain('~/.claude/settings.json');
    expect(result).not.toContain('/home/me/.claude/settings.json');
  });

  it('path abbreviation works for cwd in write-text', () => {
    const op: WriteOp = {
      kind: 'write-text',
      path: '/workspace/project/.claude/CLAUDE.md',
      content: '',
      description: '',
    };
    const group: PlanGroup = {
      id: 'context:agents',
      nature: 'context',
      action: 'install',
      ops: [op],
    };
    const result = renderPlan([group], { color: false, cwd: '/workspace/project' });
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
    const group: PlanGroup = { id: 'a', nature: 'context', action: 'install', ops: [op] };
    const result = renderPlan([group], { color: false, home: '/home/me', cwd: '/project' });
    expect(result).toContain('/other/place/file.md');
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

  it('emits ANSI escape codes when color:true, keeping tags contiguous', () => {
    const report: Report = {
      entries: [
        { id: 'a', nature: 'skill', state: 'present' },
        { id: 'b', nature: 'mcp', state: 'missing' },
        { id: 'c', nature: 'agent', state: 'drift' },
      ],
    };
    const result = renderReport(report, { color: true });
    expect(result).toContain('\x1b[');
    expect(result).toContain('[ ok  ]');
    expect(result).toContain('[miss ]');
    expect(result).toContain('[drift]');
  });

  it('emits no ANSI escape codes when color:false', () => {
    const report: Report = {
      entries: [{ id: 'a', nature: 'skill', state: 'present' }],
    };
    expect(renderReport(report, { color: false })).not.toContain('\x1b[');
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

  it('confirmToolChecks is a function', () => {
    expect(typeof confirmToolChecks).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// New pure rendering exports — type-level checks
// ---------------------------------------------------------------------------

describe('new pure rendering exports', () => {
  it('renderCatalogList is a function', () => {
    expect(typeof renderCatalogList).toBe('function');
  });

  it('renderCatalogList emits ANSI codes when color:true, tag contiguous', () => {
    const entries: CatalogEntry[] = [
      { kind: 'artifact', id: 'skill:foo', nature: 'skill', targets: ['claude'], scopes: ['user'] },
    ];
    const result = renderCatalogList(entries, {
      installedIds: new Set(['skill:foo']),
      color: true,
    });
    expect(result).toContain('\x1b[');
    expect(result).toContain('[installed]');
  });

  it('renderCatalogList emits no ANSI codes when color:false', () => {
    const entries: CatalogEntry[] = [
      { kind: 'artifact', id: 'skill:foo', nature: 'skill', targets: ['claude'], scopes: ['user'] },
    ];
    expect(renderCatalogList(entries, { color: false })).not.toContain('\x1b[');
  });

  it('renderEntryInfo is a function', () => {
    expect(typeof renderEntryInfo).toBe('function');
  });

  it('renderRemovalPlan is a function', () => {
    expect(typeof renderRemovalPlan).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// renderRemovalPlan — empty groups
// ---------------------------------------------------------------------------

describe('renderRemovalPlan — empty groups', () => {
  it('returns "Nothing to remove — not installed." when groups is empty', () => {
    const result = renderRemovalPlan([]);
    expect(result).toBe('Nothing to remove — not installed.');
  });
});

// ---------------------------------------------------------------------------
// renderRemovalPlan — header
// ---------------------------------------------------------------------------

describe('renderRemovalPlan — header', () => {
  it('starts with "Removal plan · N change(s)"', () => {
    const op: RemovalOp = { kind: 'remove-deny', path: '/p', rules: ['r1'] };
    const group: PlanRemovalGroup = { id: 'a', nature: 'guardrail', ops: [op] };
    const result = renderRemovalPlan([group], { color: false });
    expect(result).toContain('Removal plan · 1 change');
  });

  it('counts total ops across multiple groups', () => {
    const groups: PlanRemovalGroup[] = [
      { id: 'a', nature: 'guardrail', ops: [{ kind: 'remove-deny', path: '/p', rules: ['r1'] }] },
      { id: 'b', nature: 'context', ops: [{ kind: 'delete-file', path: '/q' }] },
    ];
    const result = renderRemovalPlan(groups, { color: false });
    expect(result).toContain('Removal plan · 2 changes');
  });

  it('includes scope in header when provided', () => {
    const op: RemovalOp = { kind: 'remove-deny', path: '/p', rules: ['r1'] };
    const group: PlanRemovalGroup = { id: 'a', nature: 'guardrail', ops: [op] };
    const result = renderRemovalPlan([group], { color: false, scope: 'user', home: '/home/me' });
    expect(result).toContain('scope: user');
    expect(result).toContain('~/.claude');
  });

  it('has a blank line after the header', () => {
    const op: RemovalOp = { kind: 'remove-deny', path: '/p', rules: ['r1'] };
    const group: PlanRemovalGroup = { id: 'a', nature: 'guardrail', ops: [op] };
    const lines = renderRemovalPlan([group], { color: false }).split('\n');
    expect(lines[1]).toBe('');
  });
});

// ---------------------------------------------------------------------------
// renderRemovalPlan — remove-deny
// ---------------------------------------------------------------------------

describe('renderRemovalPlan — remove-deny', () => {
  it('renders "deny  (-N)" with rules prefixed "-"', () => {
    const op: RemovalOp = {
      kind: 'remove-deny',
      path: '/home/me/.claude/settings.json',
      rules: ['r1', 'r2'],
    };
    const group: PlanRemovalGroup = { id: 'a', nature: 'guardrail', ops: [op] };
    const result = renderRemovalPlan([group], { color: false, home: '/home/me' });
    expect(result).toContain('deny  (-2)');
    expect(result).toContain('- r1');
    expect(result).toContain('- r2');
  });

  it('abbreviates path in group header', () => {
    const op: RemovalOp = {
      kind: 'remove-deny',
      path: '/home/me/.claude/settings.json',
      rules: ['r1'],
    };
    const group: PlanRemovalGroup = { id: 'a', nature: 'guardrail', ops: [op] };
    const result = renderRemovalPlan([group], { color: false, home: '/home/me' });
    expect(result).toContain('~/.claude/settings.json');
    expect(result).not.toContain('/home/me/.claude/settings.json');
  });

  it('truncates rules beyond maxDetail with "… -K more"', () => {
    const rules = ['r1', 'r2', 'r3', 'r4', 'r5'];
    const op: RemovalOp = { kind: 'remove-deny', path: '/p', rules };
    const group: PlanRemovalGroup = { id: 'a', nature: 'guardrail', ops: [op] };
    const result = renderRemovalPlan([group], { color: false, maxDetail: 2 });
    expect(result).toContain('deny  (-5)');
    expect(result).toContain('- r1');
    expect(result).toContain('- r2');
    expect(result).not.toContain('- r3');
    expect(result).toContain('… -3 more');
  });

  it('renders path without abbreviation when no opts provided', () => {
    const op: RemovalOp = { kind: 'remove-deny', path: '.claude/settings.json', rules: ['r'] };
    const group: PlanRemovalGroup = { id: 'a', nature: 'guardrail', ops: [op] };
    const result = renderRemovalPlan([group], { color: false });
    expect(result).toContain('.claude/settings.json');
    expect(result).toContain('- r');
  });
});

// ---------------------------------------------------------------------------
// renderRemovalPlan — remove-allow
// ---------------------------------------------------------------------------

describe('renderRemovalPlan — remove-allow', () => {
  it('renders "allow  (-N)" with rules prefixed "-"', () => {
    const op: RemovalOp = { kind: 'remove-allow', path: '/p', rules: ['r1', 'r2'] };
    const group: PlanRemovalGroup = { id: 'a', nature: 'guardrail', ops: [op] };
    const result = renderRemovalPlan([group], { color: false });
    expect(result).toContain('allow  (-2)');
    expect(result).toContain('- r1');
  });
});

// ---------------------------------------------------------------------------
// renderRemovalPlan — remove-block
// ---------------------------------------------------------------------------

describe('renderRemovalPlan — remove-block', () => {
  it('renders "unimport  <abbr path>"', () => {
    const op: RemovalOp = { kind: 'remove-block', path: '/home/me/.claude/CLAUDE.md' };
    const group: PlanRemovalGroup = { id: 'a', nature: 'context', ops: [op] };
    const result = renderRemovalPlan([group], { color: false, home: '/home/me' });
    expect(result).toContain('unimport  ~/.claude/CLAUDE.md');
    expect(result).not.toContain('/home/me/.claude/CLAUDE.md');
  });
});

// ---------------------------------------------------------------------------
// renderRemovalPlan — delete-file
// ---------------------------------------------------------------------------

describe('renderRemovalPlan — delete-file', () => {
  it('renders "delete  <abbr path>"', () => {
    const op: RemovalOp = { kind: 'delete-file', path: '/home/me/.claude/harness/AGENTS.md' };
    const group: PlanRemovalGroup = { id: 'a', nature: 'context', ops: [op] };
    const result = renderRemovalPlan([group], { color: false, home: '/home/me' });
    expect(result).toContain('delete  ~/.claude/harness/AGENTS.md');
    expect(result).not.toContain('/home/me/.claude/harness/AGENTS.md');
  });

  it('renders absolute path when no abbreviation applies', () => {
    const op: RemovalOp = { kind: 'delete-file', path: '/other/path/AGENTS.md' };
    const group: PlanRemovalGroup = { id: 'a', nature: 'context', ops: [op] };
    const result = renderRemovalPlan([group], { color: false });
    expect(result).toContain('delete  /other/path/AGENTS.md');
  });

  it('abbreviates cwd paths in delete-file', () => {
    const op: RemovalOp = { kind: 'delete-file', path: '/workspace/project/.claude/AGENTS.md' };
    const group: PlanRemovalGroup = { id: 'a', nature: 'context', ops: [op] };
    const result = renderRemovalPlan([group], { color: false, cwd: '/workspace/project' });
    expect(result).toContain('./.claude/AGENTS.md');
    expect(result).not.toContain('/workspace/project/.claude/AGENTS.md');
  });
});

// ---------------------------------------------------------------------------
// renderRemovalPlan — restore-file (R6)
// ---------------------------------------------------------------------------

describe('renderRemovalPlan — restore-file', () => {
  it('lot2-R6: renders "restore  <abbr path>" so the preview states the file comes back, not that it is deleted', () => {
    const op: RemovalOp = {
      kind: 'restore-file',
      path: '/home/me/.claude/harness/AGENTS.md',
      content: '# original user content\n',
    };
    const group: PlanRemovalGroup = { id: 'context-claude', nature: 'context', ops: [op] };
    const result = renderRemovalPlan([group], { color: false, home: '/home/me' });
    expect(result).toContain('restore  ~/.claude/harness/AGENTS.md');
    expect(result).not.toContain('delete  ~/.claude/harness/AGENTS.md');
  });

  it('lot2-R6: counts restores in the Σ summary line', () => {
    const op: RemovalOp = {
      kind: 'restore-file',
      path: '/home/me/AGENTS.md',
      content: 'x\n',
    };
    const group: PlanRemovalGroup = { id: 'context-claude', nature: 'context', ops: [op] };
    const result = renderRemovalPlan([group], { color: false, home: '/home/me' });
    expect(result).toContain('Σ  1 restore');
  });
});

// ---------------------------------------------------------------------------
// renderRemovalPlan — unlink
// ---------------------------------------------------------------------------

describe('renderRemovalPlan — unlink', () => {
  it('renders "unlink  <abbr target>"', () => {
    const op: RemovalOp = {
      kind: 'unlink',
      target: '/home/me/.claude/skills/spec-workflow',
      store: '/home/me/.config/agent-rigger/skills/spec-workflow',
    };
    const group: PlanRemovalGroup = { id: 'skill:spec-workflow', nature: 'skill', ops: [op] };
    const result = renderRemovalPlan([group], { color: false, home: '/home/me' });
    expect(result).toContain('unlink  ~/.claude/skills/spec-workflow');
    expect(result).not.toContain('/home/me/.claude/skills/spec-workflow');
  });
});

// ---------------------------------------------------------------------------
// renderRemovalPlan — plugin-uninstall
// ---------------------------------------------------------------------------

describe('renderRemovalPlan — plugin-uninstall', () => {
  it('renders "uninstall  <plugin>"', () => {
    const op: RemovalOp = { kind: 'plugin-uninstall', plugin: 'my-plugin' };
    const group: PlanRemovalGroup = { id: 'plugin:my', nature: 'plugin', ops: [op] };
    const result = renderRemovalPlan([group], { color: false });
    expect(result).toContain('uninstall  my-plugin');
  });
});

// ---------------------------------------------------------------------------
// renderRemovalPlan — remove-hooks
// ---------------------------------------------------------------------------

describe('renderRemovalPlan — remove-hooks', () => {
  it('renders "un-hook  event/matcher"', () => {
    const op: RemovalOp = {
      kind: 'remove-hooks',
      path: '/home/me/.claude/settings.json',
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'bun run x',
    };
    const group: PlanRemovalGroup = { id: 'hook:guard-bash', nature: 'hook', ops: [op] };
    const result = renderRemovalPlan([group], { color: false, home: '/home/me' });
    expect(result).toContain('un-hook  PreToolUse/Bash');
  });

  it('shows abbreviated settings path in group header', () => {
    const op: RemovalOp = {
      kind: 'remove-hooks',
      path: '/home/me/.claude/settings.json',
      event: 'UserPromptSubmit',
      matcher: '*',
      command: 'x',
    };
    const group: PlanRemovalGroup = { id: 'a', nature: 'hook', ops: [op] };
    const result = renderRemovalPlan([group], { color: false, home: '/home/me' });
    expect(result).toContain('~/.claude/settings.json');
    expect(result).not.toContain('/home/me/.claude/settings.json');
  });

  it('counts the op in the removal plan header', () => {
    const op: RemovalOp = {
      kind: 'remove-hooks',
      path: '/h/.claude/settings.json',
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'x',
    };
    const group: PlanRemovalGroup = { id: 'a', nature: 'hook', ops: [op] };
    const result = renderRemovalPlan([group], { color: false });
    expect(result).toContain('Removal plan · 1 change');
  });
});

// ---------------------------------------------------------------------------
// renderRemovalPlan — Σ line
// ---------------------------------------------------------------------------

describe('renderRemovalPlan — Σ line', () => {
  it('shows deny -N in Σ line', () => {
    const op: RemovalOp = { kind: 'remove-deny', path: '/p', rules: ['r1', 'r2'] };
    const group: PlanRemovalGroup = { id: 'a', nature: 'guardrail', ops: [op] };
    const result = renderRemovalPlan([group], { color: false });
    expect(result).toContain('deny -2');
  });

  it('shows delete count in Σ line', () => {
    const op: RemovalOp = { kind: 'delete-file', path: '/p' };
    const group: PlanRemovalGroup = { id: 'a', nature: 'context', ops: [op] };
    const result = renderRemovalPlan([group], { color: false });
    expect(result).toContain('1 delete');
  });

  it('omits zero-count categories', () => {
    const op: RemovalOp = { kind: 'remove-deny', path: '/p', rules: ['r1'] };
    const group: PlanRemovalGroup = { id: 'a', nature: 'guardrail', ops: [op] };
    const result = renderRemovalPlan([group], { color: false });
    const sigmaLine = result.split('\n').find((l) => l.includes('Σ'));
    expect(sigmaLine).toBeDefined();
    expect(sigmaLine).not.toContain('delete');
    expect(sigmaLine).not.toContain('unlink');
    expect(sigmaLine).not.toContain('plugin');
  });
});

// ---------------------------------------------------------------------------
// renderRemovalPlan — multi-group
// ---------------------------------------------------------------------------

describe('renderRemovalPlan — multi-group', () => {
  it('renders all removal groups', () => {
    const groups: PlanRemovalGroup[] = [
      {
        id: 'guardrail:claude',
        nature: 'guardrail',
        ops: [{ kind: 'remove-deny', path: '/p', rules: ['r1'] }],
      },
      {
        id: 'skill:foo',
        nature: 'skill',
        ops: [
          {
            kind: 'unlink',
            target: '/home/me/.claude/skills/foo',
            store: '/store/foo',
          },
        ],
      },
    ];
    const result = renderRemovalPlan(groups, { color: false, home: '/home/me' });
    expect(result).toContain('guardrail:claude');
    expect(result).toContain('skill:foo');
    expect(result).toContain('deny  (-1)');
    expect(result).toContain('unlink  ~/.claude/skills/foo');
  });
});

// ---------------------------------------------------------------------------
// renderRemovalPlan — color
// ---------------------------------------------------------------------------

describe('renderRemovalPlan — color', () => {
  it('contains ANSI escape codes when color:true', () => {
    const op: RemovalOp = { kind: 'remove-deny', path: '/p', rules: ['r1'] };
    const group: PlanRemovalGroup = { id: 'a', nature: 'guardrail', ops: [op] };
    const result = renderRemovalPlan([group], { color: true });
    expect(result).toContain('\x1b[');
  });

  it('contains no ANSI codes when color:false', () => {
    const op: RemovalOp = { kind: 'remove-deny', path: '/p', rules: ['r1'] };
    const group: PlanRemovalGroup = { id: 'a', nature: 'guardrail', ops: [op] };
    const result = renderRemovalPlan([group], { color: false });
    expect(result).not.toContain('\x1b[');
  });
});

// ---------------------------------------------------------------------------
// buildStatusOptions — version is embedded in the label (always visible)
// ---------------------------------------------------------------------------

describe('buildStatusOptions', () => {
  it('embeds the installed version in the "Up to date" label, not a hint', () => {
    const entries: StatusedEntry[] = [
      { id: 'jr/hook:guard-command', status: 'current', installedRef: 'v0.2.1' },
    ];
    const opts = buildStatusOptions(entries);
    const current = opts['Up to date (check to reinstall)'];
    expect(current).toEqual([
      { value: 'jr/hook:guard-command', label: 'jr/hook:guard-command (✓ v0.2.1)' },
    ]);
    // No `hint` key — clack would hide it on unchecked rows.
    expect(current?.[0]).not.toHaveProperty('hint');
  });

  it('embeds old → new in the "To update" label', () => {
    const entries: StatusedEntry[] = [
      { id: 'jr/agent:pm', status: 'update', installedRef: 'v0.1.0', remoteRef: 'v0.2.1' },
    ];
    const opts = buildStatusOptions(entries);
    expect(opts['To update']).toEqual([
      { value: 'jr/agent:pm', label: 'jr/agent:pm (v0.1.0 → v0.2.1)' },
    ]);
  });

  it('shows the target version on "To install" rows when remoteRef is known', () => {
    const entries: StatusedEntry[] = [
      { id: 'jr/skill:react-testing', status: 'install', remoteRef: 'v0.2.1' },
    ];
    const opts = buildStatusOptions(entries);
    expect(opts['To install']).toEqual([
      { value: 'jr/skill:react-testing', label: 'jr/skill:react-testing (→ v0.2.1)' },
    ]);
  });

  it('falls back to the bare id on "To install" when remoteRef is unavailable', () => {
    const entries: StatusedEntry[] = [{ id: 'jr/skill:react-testing', status: 'install' }];
    const opts = buildStatusOptions(entries);
    expect(opts['To install']).toEqual([
      { value: 'jr/skill:react-testing', label: 'jr/skill:react-testing' },
    ]);
  });

  it('omits empty groups', () => {
    const opts = buildStatusOptions([{ id: 'a', status: 'install', remoteRef: 'v1' }]);
    expect(Object.keys(opts)).toEqual(['To install']);
  });

  // b1b4-R3: a pack has no version of its own, so update/current labels are
  // member-oriented — the (installedRef → remoteRef) / (✓ installedRef)
  // templates would render `undefined`.
  it('b1b4-R3: pack "To update" label is member-oriented, not a version pair', () => {
    const entries: StatusedEntry[] = [{ id: 'jr/pack:demo', status: 'update', kind: 'pack' }];
    const opts = buildStatusOptions(entries);
    expect(opts['To update']).toEqual([
      { value: 'jr/pack:demo', label: 'jr/pack:demo (members outdated)' },
    ]);
  });

  it('b1b4-R3: pack "Up to date" label is member-oriented, not a version', () => {
    const entries: StatusedEntry[] = [{ id: 'jr/pack:demo', status: 'current', kind: 'pack' }];
    const opts = buildStatusOptions(entries);
    expect(opts['Up to date (check to reinstall)']).toEqual([
      { value: 'jr/pack:demo', label: 'jr/pack:demo (✓ members current)' },
    ]);
  });

  it('b1b4-R3: pack "To install" label keeps the target version when remoteRef is known', () => {
    const entries: StatusedEntry[] = [
      { id: 'jr/pack:demo', status: 'install', kind: 'pack', remoteRef: 'v1.0.0' },
    ];
    const opts = buildStatusOptions(entries);
    expect(opts['To install']).toEqual([
      { value: 'jr/pack:demo', label: 'jr/pack:demo (→ v1.0.0)' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildStatusInitialValues — pre-checked set, with optional recommended opinion
// ---------------------------------------------------------------------------

const optsFor = (recommended: string[], opting: string[]) => ({
  recommended: new Set(recommended),
  optingPrefixes: new Set(opting),
});

describe('buildStatusInitialValues (b1b4-R4)', () => {
  it('b1b4-R4: sans opts → install ∪ update pré-cochés, current jamais (défaut historique)', () => {
    const entries: StatusedEntry[] = [
      { id: 'cat/skill:a', status: 'install' },
      { id: 'cat/skill:c', status: 'update', installedRef: 'v1', remoteRef: 'v2' },
      { id: 'cat/skill:d', status: 'current', installedRef: 'v1' },
    ];
    expect(buildStatusInitialValues(entries)).toEqual(['cat/skill:a', 'cat/skill:c']);
  });

  it('b1b4-R4: catalogue qui opte → install recommandé coché, non-recommandé décoché', () => {
    const entries: StatusedEntry[] = [
      { id: 'cat/skill:a', status: 'install' },
      { id: 'cat/skill:b', status: 'install' },
    ];
    expect(buildStatusInitialValues(entries, optsFor(['cat/skill:a'], ['cat']))).toEqual([
      'cat/skill:a',
    ]);
  });

  it('b1b4-R4: update toujours coché, même quand son catalogue opte et ne le recommande pas', () => {
    const entries: StatusedEntry[] = [
      { id: 'cat/skill:c', status: 'update', installedRef: 'v1', remoteRef: 'v2' },
    ];
    expect(buildStatusInitialValues(entries, optsFor([], ['cat']))).toEqual(['cat/skill:c']);
  });

  it('b1b4-R4: current jamais coché, même recommandé (pas de réinstallation implicite)', () => {
    const entries: StatusedEntry[] = [
      { id: 'cat/skill:a', status: 'current', installedRef: 'v1' },
    ];
    // Load-bearing: naively unioning `recommended` into the checked set would
    // pre-check this recommended-but-current entry.
    expect(buildStatusInitialValues(entries, optsFor(['cat/skill:a'], ['cat']))).toEqual([]);
  });

  it('b1b4-R4: multi-préfixe — catB sans opinion garde tout son install coché', () => {
    const entries: StatusedEntry[] = [
      { id: 'catA/skill:a', status: 'install' },
      { id: 'catA/skill:b', status: 'install' },
      { id: 'catB/skill:a', status: 'install' },
      { id: 'catB/skill:b', status: 'install' },
    ];
    // Only catA declares an opinion → catB keeps the historical "all install".
    expect(buildStatusInitialValues(entries, optsFor(['catA/skill:a'], ['catA']))).toEqual([
      'catA/skill:a',
      'catB/skill:a',
      'catB/skill:b',
    ]);
  });
});

// ---------------------------------------------------------------------------
// renderDoctorReport — detail line (host-diff findings name their element,
// catalog and manual ways out in `detail`; the report must surface it)
// ---------------------------------------------------------------------------

describe('renderDoctorReport — detail line', () => {
  it('renders a finding detail as an indented line under its summary', () => {
    const finding = untrackedHostDiff({
      nature: 'guardrail',
      scope: 'user',
      assistant: 'claude',
      detail: 'guardrail "secu" from catalog "principal" is present at the host '
        + 'byte-identical to the canon but tracked by no manifest entry — adopt it '
        + '(reinstall to record it) or remove it by hand.',
    });
    const out = renderDoctorReport([finding], { color: false });
    expect(out).toContain('guardrail present at the host, not tracked by the manifest.');
    expect(out).toContain('guardrail "secu" from catalog "principal"');
    expect(out).toContain('or remove it by hand.');
  });

  it('renders findings without a detail unchanged — one line per finding', () => {
    const finding = manifestAppliedDrift({
      entryId: 'principal/guardrail:secu',
      nature: 'guardrail',
      scope: 'user',
    });
    const out = renderDoctorReport([finding], { color: false });
    const findingLines = out.split('\n').filter((l) =>
      l.trim() !== '' && !l.startsWith('Installed')
    );
    expect(findingLines).toHaveLength(2); // group label + the single finding line
  });
});
