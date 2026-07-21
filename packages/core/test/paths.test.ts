import { describe, expect, it } from 'bun:test';
import os from 'node:os';
import path from 'node:path';

import {
  assistantRoot,
  libsDir,
  resolveHome,
  resolveProjectTargets,
  resolveUserTargets,
} from '../src/paths';

// ---------------------------------------------------------------------------
// resolveHome
// ---------------------------------------------------------------------------

describe('resolveHome', () => {
  it('returns RIGGER_HOME when defined', () => {
    const env = { RIGGER_HOME: '/tmp/rigger-test-home', HOME: '/real/home' };
    expect(resolveHome(env)).toBe('/tmp/rigger-test-home');
  });

  it('returns HOME when RIGGER_HOME is absent', () => {
    const env = { HOME: '/some/home' };
    expect(resolveHome(env)).toBe('/some/home');
  });

  it('returns os.homedir() fallback when both RIGGER_HOME and HOME are absent', () => {
    const env: Record<string, string | undefined> = {};
    // Must be a non-empty absolute path
    const result = resolveHome(env);
    expect(result).toBeTruthy();
    expect(path.isAbsolute(result)).toBe(true);
  });

  it('ignores empty RIGGER_HOME string and falls back to HOME', () => {
    const env = { RIGGER_HOME: '', HOME: '/fallback/home' };
    expect(resolveHome(env)).toBe('/fallback/home');
  });
});

// ---------------------------------------------------------------------------
// resolveUserTargets — scope 'user'
// ---------------------------------------------------------------------------

describe('resolveUserTargets', () => {
  const ISOLATED_HOME = '/tmp/rigger-test-home';
  const env = { RIGGER_HOME: ISOLATED_HOME };

  it('resolves settings.json under ~/.claude/', () => {
    const targets = resolveUserTargets(env);
    expect(targets.claudeSettings).toBe(path.join(ISOLATED_HOME, '.claude', 'settings.json'));
  });

  it('resolves CLAUDE.md under ~/.claude/', () => {
    const targets = resolveUserTargets(env);
    expect(targets.claudeMd).toBe(path.join(ISOLATED_HOME, '.claude', 'CLAUDE.md'));
  });

  it('resolves harness AGENTS.md under ~/.claude/harness/', () => {
    const targets = resolveUserTargets(env);
    expect(targets.agentsMd).toBe(path.join(ISOLATED_HOME, '.claude', 'harness', 'AGENTS.md'));
  });

  it('resolves state.json under ~/.config/agent-rigger/', () => {
    const targets = resolveUserTargets(env);
    expect(targets.stateJson).toBe(
      path.join(ISOLATED_HOME, '.config', 'agent-rigger', 'state.json'),
    );
  });

  it('resolves skills dir under ~/.config/agent-rigger/skills/', () => {
    const targets = resolveUserTargets(env);
    expect(targets.skillsDir).toBe(
      path.join(ISOLATED_HOME, '.config', 'agent-rigger', 'skills'),
    );
  });

  it('returns absolute paths for all targets', () => {
    const targets = resolveUserTargets(env);
    for (const value of Object.values(targets)) {
      expect(path.isAbsolute(value)).toBe(true);
    }
  });

  it('never touches the real home directory (RIGGER_HOME is isolated)', () => {
    const realHome = os.homedir();
    const targets = resolveUserTargets(env);
    for (const value of Object.values(targets)) {
      expect(value.startsWith(realHome)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// libsDir — store-side root for lib materialisations (T1, R3 dest)
// ---------------------------------------------------------------------------

describe('libsDir', () => {
  const ISOLATED_HOME = '/tmp/rigger-test-home';
  const env = { RIGGER_HOME: ISOLATED_HOME };

  it('resolves to ~/.config/agent-rigger/libs (sibling of skillsDir, same store root)', () => {
    const targets = resolveUserTargets(env);
    expect(libsDir(env)).toBe(path.join(path.dirname(targets.skillsDir), 'libs'));
    expect(libsDir(env)).toBe(
      path.join(ISOLATED_HOME, '.config', 'agent-rigger', 'libs'),
    );
  });

  it('returns an absolute path', () => {
    expect(path.isAbsolute(libsDir(env))).toBe(true);
  });

  it('never touches the real home directory (RIGGER_HOME is isolated)', () => {
    const realHome = os.homedir();
    expect(libsDir(env).startsWith(realHome)).toBe(false);
  });

  it('defaults to Bun.env when no env is passed (same resolution seam as resolveHome)', () => {
    // Smoke check only: must not throw and must return an absolute path.
    expect(path.isAbsolute(libsDir())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveProjectTargets — scope 'project'
// ---------------------------------------------------------------------------

describe('resolveProjectTargets', () => {
  const CWD = '/tmp/proj';

  it('resolves settings.json under .claude/', () => {
    const targets = resolveProjectTargets(CWD);
    expect(targets.claudeSettings).toBe(path.join(CWD, '.claude', 'settings.json'));
  });

  it('resolves CLAUDE.md under .claude/', () => {
    const targets = resolveProjectTargets(CWD);
    expect(targets.claudeMd).toBe(path.join(CWD, '.claude', 'CLAUDE.md'));
  });

  it('resolves AGENTS.md at project root', () => {
    const targets = resolveProjectTargets(CWD);
    expect(targets.agentsMd).toBe(path.join(CWD, 'AGENTS.md'));
  });

  it('uses process.cwd() when cwd is omitted', () => {
    const targets = resolveProjectTargets();
    expect(targets.claudeSettings).toBe(
      path.join(process.cwd(), '.claude', 'settings.json'),
    );
  });
});

// ---------------------------------------------------------------------------
// assistantRoot — per-assistant root directory (R5, lot5-ux-dx)
// ---------------------------------------------------------------------------

describe('assistantRoot', () => {
  const HOME = '/tmp/rigger-test-home';
  const CWD = '/tmp/proj';

  it('resolves claude/user to <home>/.claude', () => {
    expect(assistantRoot('claude', 'user', { home: HOME })).toBe(path.join(HOME, '.claude'));
  });

  it('resolves claude/project to <cwd>/.claude', () => {
    expect(assistantRoot('claude', 'project', { cwd: CWD })).toBe(path.join(CWD, '.claude'));
  });

  it('resolves opencode/user to <home>/.config/opencode', () => {
    expect(assistantRoot('opencode', 'user', { home: HOME })).toBe(
      path.join(HOME, '.config', 'opencode'),
    );
  });

  it('resolves opencode/project to the cwd root (not .opencode/)', () => {
    expect(assistantRoot('opencode', 'project', { cwd: CWD })).toBe(CWD);
  });

  it('returns undefined for copilot regardless of scope (fail-soft, no adapter)', () => {
    expect(assistantRoot('copilot', 'user', { home: HOME })).toBeUndefined();
    expect(assistantRoot('copilot', 'project', { cwd: CWD })).toBeUndefined();
  });

  it('returns undefined when home is missing for a user-scope lookup', () => {
    expect(assistantRoot('claude', 'user', {})).toBeUndefined();
    expect(assistantRoot('opencode', 'user', {})).toBeUndefined();
  });

  it('returns undefined when home is an empty string for a user-scope lookup', () => {
    expect(assistantRoot('claude', 'user', { home: '' })).toBeUndefined();
  });

  it('returns undefined when cwd is missing for a project-scope lookup', () => {
    expect(assistantRoot('claude', 'project', {})).toBeUndefined();
    expect(assistantRoot('opencode', 'project', {})).toBeUndefined();
  });

  it('returns undefined when cwd is an empty string for a project-scope lookup', () => {
    expect(assistantRoot('opencode', 'project', { cwd: '' })).toBeUndefined();
  });

  it('is derived from resolveUserTargets/resolveOpencodeUserTargets (single source of truth)', () => {
    const env = { HOME };
    expect(assistantRoot('claude', 'user', { home: HOME })).toBe(
      path.dirname(resolveUserTargets(env).claudeSettings),
    );
  });
});
