/**
 * lot5-r5-paths.test.ts — R5: les en-têtes de plan et le picker de scope
 * disent le vrai répertoire.
 *
 * One `describe` per requirements.md scenario (stock §8 convention), named
 * `lot5-R5: …`. Two layers:
 *
 * - Pure unit tests directly on `ui.ts`'s exported building blocks
 *   (renderPlan / renderRemovalPlan / buildScopeOptions), mirroring
 *   ui.test.ts's own convention of never invoking real clack prompts.
 * - End-to-end wiring tests via `runCli` (real install/remove pipeline, fake
 *   CommandRunner — no real git/network) proving cmd-install.ts/cmd-remove.ts
 *   actually thread `assistant: adapter.id` into the rendered plan, and that
 *   cli.ts threads the resolved assistant into `prompts.selectScope`.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import type { Env } from '@agent-rigger/core/paths';

import { runCli } from '../src/cli';
import type { CliPrompts } from '../src/cli';
import { buildScopeOptions, renderPlan, renderRemovalPlan } from '../src/ui';
import type { PlanGroup, PlanRemovalGroup } from '../src/ui';

// ---------------------------------------------------------------------------
// Scenario: plan d'install opencode (unit level — renderPlan/renderRemovalPlan)
// ---------------------------------------------------------------------------

describe('lot5-R5: plan opencode — scope user shows ~/.config/opencode', () => {
  it('renderPlan header cites ~/.config/opencode for assistant=opencode, scope user', () => {
    const group: PlanGroup = {
      id: 'skill:foo',
      nature: 'skill',
      action: 'install',
      ops: [{ kind: 'write-json', path: '/p', description: '' }],
    };
    const result = renderPlan([group], {
      color: false,
      scope: 'user',
      home: '/home/me',
      assistant: 'opencode',
    });
    expect(result).toContain('scope: user');
    expect(result).toContain('~/.config/opencode');
    expect(result).not.toContain('.claude');
  });
});

describe('lot5-R5: plan opencode — scope project shows the cwd root, not .opencode', () => {
  it('renderPlan header cites the cwd root for assistant=opencode, scope project', () => {
    const group: PlanGroup = {
      id: 'skill:foo',
      nature: 'skill',
      action: 'install',
      ops: [{ kind: 'write-json', path: '/p', description: '' }],
    };
    const result = renderPlan([group], {
      color: false,
      scope: 'project',
      cwd: '/workspace',
      assistant: 'opencode',
    });
    expect(result).toContain('scope: project');
    // assistantRoot(opencode, project) === cwd itself → abbreviated to '.'
    expect(result).toContain('scope: project (.)');
    expect(result).not.toContain('.opencode');
    expect(result).not.toContain('.claude');
  });
});

describe('lot5-R5: plan claude — unchanged (.claude)', () => {
  it('renderPlan header still cites .claude when assistant is claude (default)', () => {
    const group: PlanGroup = {
      id: 'skill:foo',
      nature: 'skill',
      action: 'install',
      ops: [{ kind: 'write-json', path: '/p', description: '' }],
    };
    const resultDefault = renderPlan([group], { color: false, scope: 'user', home: '/home/me' });
    const resultExplicit = renderPlan([group], {
      color: false,
      scope: 'user',
      home: '/home/me',
      assistant: 'claude',
    });
    expect(resultDefault).toContain('~/.claude');
    expect(resultExplicit).toContain('~/.claude');
    expect(resultDefault).toBe(resultExplicit);
  });

  it('renderRemovalPlan follows the same rule as renderPlan', () => {
    const group: PlanRemovalGroup = {
      id: 'skill:foo',
      nature: 'skill',
      ops: [{ kind: 'delete-file', path: '/p' }],
    };
    const claudePlan = renderRemovalPlan([group], {
      color: false,
      scope: 'user',
      home: '/home/me',
      assistant: 'claude',
    });
    const opencodePlan = renderRemovalPlan([group], {
      color: false,
      scope: 'user',
      home: '/home/me',
      assistant: 'opencode',
    });
    expect(claudePlan).toContain('~/.claude');
    expect(opencodePlan).toContain('~/.config/opencode');
    expect(opencodePlan).not.toContain('.claude');
  });
});

describe('lot5-R5: plan copilot — fail-soft, no path suffix', () => {
  it('renderPlan omits the root suffix entirely for the reserved copilot id', () => {
    const group: PlanGroup = {
      id: 'skill:foo',
      nature: 'skill',
      action: 'install',
      ops: [{ kind: 'write-json', path: '/p', description: '' }],
    };
    const result = renderPlan([group], {
      color: false,
      scope: 'user',
      home: '/home/me',
      assistant: 'copilot',
    });
    expect(result).toContain('scope: user');
    expect(result).not.toContain('(');
    expect(result).not.toContain('.claude');
  });

  it('renderRemovalPlan omits the root suffix entirely for the reserved copilot id', () => {
    const group: PlanRemovalGroup = {
      id: 'skill:foo',
      nature: 'skill',
      ops: [{ kind: 'delete-file', path: '/p' }],
    };
    const result = renderRemovalPlan([group], {
      color: false,
      scope: 'project',
      cwd: '/workspace',
      assistant: 'copilot',
    });
    expect(result).toContain('scope: project');
    expect(result).not.toContain('(');
  });
});

// ---------------------------------------------------------------------------
// Scenario: picker de scope par assistant
// ---------------------------------------------------------------------------

describe('lot5-R5: picker de scope par assistant', () => {
  it('buildScopeOptions cites opencode paths, not .claude', () => {
    const options = buildScopeOptions('opencode');
    const user = options.find((o) => o.value === 'user');
    const project = options.find((o) => o.value === 'project');
    expect(user?.label).toContain('~/.config/opencode');
    expect(project?.label).toContain('cwd/');
    expect(user?.label).not.toContain('.claude');
    expect(project?.label).not.toContain('.claude');
  });

  it('buildScopeOptions defaults to claude labels when assistant is omitted', () => {
    const options = buildScopeOptions();
    const user = options.find((o) => o.value === 'user');
    const project = options.find((o) => o.value === 'project');
    expect(user?.label).toContain('~/.claude');
    expect(project?.label).toContain('cwd/.claude');
  });

  it('buildScopeOptions falls back to bare labels (no path) for the reserved copilot id', () => {
    const options = buildScopeOptions('copilot');
    const user = options.find((o) => o.value === 'user');
    const project = options.find((o) => o.value === 'project');
    expect(user?.label).toBe('user');
    expect(project?.label).toBe('project');
  });

  it('runCli threads the resolved assistant into prompts.selectScope (wiring)', async () => {
    const seenAssistants: (string | undefined)[] = [];
    const fixture = await makeIso();
    try {
      await fixture.writeConfig();

      const prompts: CliPrompts = {
        selectArtifacts: async (entries) => entries.map((e) => e.id),
        selectScope: async (assistant) => {
          seenAssistants.push(assistant);
          return 'user';
        },
        confirmApply: async () => true,
        askUrl: async () => '',
        askMethod: async () => 'https',
      };

      await runCli(['install', '--assistant=opencode'], {
        print: () => {},
        env: fixture.env,
        prompts,
        remote: { run: fixture.runner, tmpFactory: fixture.tmpFactory },
      });

      expect(seenAssistants).toEqual(['opencode']);
    } finally {
      await fixture.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end wiring — cmd-install.ts / cmd-remove.ts pass assistant: adapter.id
// ---------------------------------------------------------------------------

const SHA = 'a'.repeat(40);
const TAG_NAME = 'v1.0.0';

const CONTEXT_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'context:main',
  nature: 'context',
  targets: ['claude', 'opencode'],
  scopes: ['user', 'project'],
};

function makeCapture(): { lines: string[]; print: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

function makeSuccessRunner(): CommandRunner {
  return (_cmd, args) => {
    const argv = args ?? [];
    if (argv.includes('ls-remote') && argv.includes('--tags')) {
      return Promise.resolve({
        exitCode: 0,
        stdout: `${SHA}\trefs/tags/${TAG_NAME}\n`,
        stderr: '',
      });
    }
    if (argv.includes('ls-remote') && argv.includes('HEAD')) {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\tHEAD\n`, stderr: '' });
    }
    if (argv.includes('clone')) {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argv.includes('rev-parse')) {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };
}

function makeContextTmpFactory(dir: string): TmpDirFactory {
  return async () => {
    await Bun.write(
      path.join(dir, 'catalog.json'),
      JSON.stringify({ meta: { name: 'r5-test-catalog' }, entries: [CONTEXT_ENTRY] }),
    );
    const ctxDir = path.join(dir, 'contexts', 'main');
    await fs.mkdir(ctxDir, { recursive: true });
    await fs.writeFile(path.join(ctxDir, 'AGENTS.md'), '# R5 test context\n', 'utf8');
    return { path: dir, cleanup: async () => {} };
  };
}

interface Iso {
  env: Env;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  writeConfig: () => Promise<void>;
  cleanup: () => Promise<void>;
}

async function makeIso(): Promise<Iso> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-r5-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-r5-content-'));
  const env: Env = { RIGGER_HOME: homeDir };

  const writeConfig = async () => {
    const configDir = path.join(homeDir, '.config', 'agent-rigger');
    await fs.mkdir(configDir, { recursive: true });
    await Bun.write(
      path.join(configDir, 'config.json'),
      JSON.stringify({
        catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }],
      }),
    );
  };

  const cleanup = async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(contentDir, { recursive: true, force: true });
  };

  return {
    env,
    runner: makeSuccessRunner(),
    tmpFactory: makeContextTmpFactory(contentDir),
    writeConfig,
    cleanup,
  };
}

describe('lot5-R5: cmd-install.ts threads assistant: adapter.id into the rendered plan', () => {
  it('install --assistant=opencode --yes prints a plan header citing ~/.config/opencode', async () => {
    const fixture = await makeIso();
    try {
      await fixture.writeConfig();
      const cap = makeCapture();

      const code = await runCli(
        ['install', 'principal/context:main', '--yes', '--assistant=opencode'],
        {
          print: cap.print,
          env: fixture.env,
          remote: { run: fixture.runner, tmpFactory: fixture.tmpFactory },
        },
      );

      expect(code).toBe(0);
      const output = cap.lines.join('\n');
      expect(output).toContain('.config/opencode');
      expect(output).not.toContain('.claude');
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('lot5-R5: cmd-remove.ts threads assistant: adapter.id into the rendered plan', () => {
  it('remove --assistant=opencode prints a removal plan header citing ~/.config/opencode', async () => {
    const fixture = await makeIso();
    try {
      await fixture.writeConfig();

      const installCode = await runCli(
        ['install', 'principal/context:main', '--yes', '--assistant=opencode'],
        {
          print: makeCapture().print,
          env: fixture.env,
          remote: { run: fixture.runner, tmpFactory: fixture.tmpFactory },
        },
      );
      expect(installCode).toBe(0);

      const cap = makeCapture();
      const removeCode = await runCli(
        ['remove', 'principal/context:main', '--yes', '--assistant=opencode'],
        { print: cap.print, env: fixture.env },
      );

      expect(removeCode).toBe(0);
      const output = cap.lines.join('\n');
      expect(output).toContain('.config/opencode');
      expect(output).not.toContain('.claude');
    } finally {
      await fixture.cleanup();
    }
  });
});
