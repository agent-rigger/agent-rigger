/**
 * govid-r1-own-ids-only.test.ts — a catalog's meta may only reference its OWN
 * ids (governance-id-forge). `qualifyRef` leaves a pre-qualified id intact, so a
 * catalog could declare `catB/…` in its meta and have it treated as its own.
 * b1b4-R4b closed this at the install picker; this suite proves the shared
 * helper `partitionMetaIds` now closes it at the two remaining sites that still
 * trusted meta ids — the `check` governance audit and the init proposal (picker
 * + `--yes`). The install picker's non-regression stays covered by
 * b1b4-r4-recommended-precheck.test.ts (site 4).
 *
 * One test per site, named `govid: …`. Foreign ids are silently discarded
 * everywhere EXCEPT init `--yes` meta.required, where an unhonorable floor is a
 * fail-closed actionable error (same class as a phantom required, caught
 * non-fatally by runInit — config stays saved, exit 0).
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import { resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';
import type { CatalogGovernanceMeta } from '../src/governance';
import { auditableGovernanceIds } from '../src/governance';

import { runCli } from '../src/cli';
import type { CliDeps } from '../src/cli';
import { loadConfigFile } from '../src/config';
import { pinStdoutIsTTY, setStdoutIsTTY } from './fixtures/tty';

pinStdoutIsTTY(false);

const guardrail = (id: string): CatalogEntry => ({
  kind: 'artifact',
  id,
  nature: 'guardrail',
  targets: ['claude'],
  scopes: ['user'],
});

// ---------------------------------------------------------------------------
// Site 1 — auditableGovernanceIds (check's governance audit), pure
// ---------------------------------------------------------------------------

describe('govid: audit check — foreign meta id not audited', () => {
  it('govid: catA declaring catB/guardrail:x → own audited, foreign excluded', () => {
    // Effective (qualified) catalog carries both catalogs' guardrails.
    const effective: CatalogEntry[] = [
      guardrail('catA/guardrail:own'),
      guardrail('catB/guardrail:x'),
    ];
    // Only catA declares governance, and it forges catB/guardrail:x into required.
    const metaBySource = new Map<string, CatalogGovernanceMeta>([
      ['catA', { required: ['catB/guardrail:x'], recommended: ['guardrail:own'] }],
    ]);

    const auditable = auditableGovernanceIds(effective, metaBySource);

    // catA's own recommended is audited; the forged foreign required is not.
    expect(auditable.has('catA/guardrail:own')).toBe(true);
    expect(auditable.has('catB/guardrail:x')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Init harness (mirrors init-yes-defaults.test.ts) for sites 2 and 3
// ---------------------------------------------------------------------------

const TAG = 'v1.0.0';
const SHA = 'cafebabecafebabecafebabecafebabecafebabe';
const CATALOG_URL = 'https://example.com/catalog.git';

function skill(local: string): CatalogEntry {
  return {
    kind: 'artifact',
    id: `skill:${local}`,
    nature: 'skill',
    targets: ['claude'],
    scopes: ['user'],
  };
}

interface InitFix {
  env: Env;
  configDir: string;
  runner: CommandRunner;
  tmpFactory: TmpDirFactory;
  cleanupAll: () => Promise<void>;
}

async function makeInitEnv(
  meta: { required?: string[]; recommended?: string[] },
  entries: CatalogEntry[],
): Promise<InitFix> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-govid-home-'));
  const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-govid-content-'));

  await fs.writeFile(
    path.join(contentDir, 'catalog.json'),
    JSON.stringify({ meta: { name: 'test-catalog', ...meta }, entries }),
    'utf8',
  );
  for (const e of entries) {
    if (e.kind === 'artifact' && e.nature === 'skill') {
      const name = e.id.replace(/^skill:/, '');
      await fs.mkdir(path.join(contentDir, 'skills', name), { recursive: true });
      await fs.writeFile(path.join(contentDir, 'skills', name, 'SKILL.md'), `# ${name}\n`, 'utf8');
    }
  }

  const runner: CommandRunner = (_cmd, args) => {
    const argv = args ?? [];
    if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\trefs/tags/${TAG}\n`, stderr: '' });
    }
    if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\tHEAD\n`, stderr: '' });
    }
    if (argv[0] === 'clone') return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };

  const tmpFactory: TmpDirFactory = async () => ({ path: contentDir, cleanup: async () => {} });

  return {
    env: { RIGGER_HOME: homeDir },
    configDir: path.join(homeDir, '.config', 'agent-rigger'),
    runner,
    tmpFactory,
    cleanupAll: async () => {
      await fs.rm(homeDir, { recursive: true, force: true });
      await fs.rm(contentDir, { recursive: true, force: true });
    },
  };
}

function makeCapture(): { lines: string[]; print: (m: string) => void } {
  const lines: string[] = [];
  return { lines, print: (m) => lines.push(m) };
}

async function readManifestIds(env: Env): Promise<string[]> {
  const targets = resolveUserTargets(env);
  const { readManifest } = await import('@agent-rigger/core/manifest');
  const m = await readManifest(targets.stateJson);
  return m.artifacts.map((a) => a.id);
}

// ---------------------------------------------------------------------------
// Site 2 — runInteractiveProposeInstall (init picker), via injected picker seam
// ---------------------------------------------------------------------------

describe('govid: init picker — foreign meta id not pre-checked', () => {
  it('govid: foreign required/recommended excluded from the init picker defaults', async () => {
    const fix = await makeInitEnv(
      { required: ['evilcat/skill:x'], recommended: ['other/skill:y', 'skill:own'] },
      [skill('own')],
    );
    const captured: { required: Set<string> | null; recommended: Set<string> | null } = {
      required: null,
      recommended: null,
    };

    // Real TTY so the interactive proposeInstall branch runs; inject the
    // defaults picker to observe the sets it receives (returns [] → no install).
    setStdoutIsTTY(true);
    try {
      const deps: CliDeps = {
        env: fix.env,
        print: () => {},
        remote: { run: fix.runner, tmpFactory: fix.tmpFactory, scanner: stubScanner },
        prompts: {
          selectArtifacts: async () => [],
          selectScope: async () => 'user',
          confirmApply: async () => true,
          askUrl: async () => CATALOG_URL,
          askMethod: async () => 'https',
          askAssistants: async () => ['claude'],
          selectArtifactsWithDefaults: async (_entries, defaults) => {
            captured.required = defaults.required;
            captured.recommended = defaults.recommended;
            return [];
          },
        },
      };

      const code = await runCli(['init'], deps);
      expect(code).toBe(0);
      // sourceName is 'principal' (init's default catalog name); foreign ids are
      // dropped, own bare id qualified.
      expect(captured.required).toEqual(new Set());
      expect(captured.recommended).toEqual(new Set(['principal/skill:own']));
    } finally {
      await fix.cleanupAll();
    }
  });
});

// ---------------------------------------------------------------------------
// Site 3 — init --yes defaults: foreign required fail-closed, recommended silent
// ---------------------------------------------------------------------------

describe('govid: init --yes — foreign required fail-closed, recommended silent', () => {
  it('govid: foreign required → actionable error, config saved, nothing installed', async () => {
    const fix = await makeInitEnv({ required: ['evilcat/skill:x'] }, [skill('own')]);
    const cap = makeCapture();
    try {
      const code = await runCli(['init', '--yes'], {
        env: fix.env,
        print: cap.print,
        remote: { run: fix.runner, tmpFactory: fix.tmpFactory, scanner: stubScanner },
        prompts: {
          selectArtifacts: async () => [],
          selectScope: async () => 'user',
          confirmApply: async () => true,
          askUrl: async () => CATALOG_URL,
          askMethod: async () => 'https',
        },
      });

      // Same class as a phantom required: runInit catches it non-fatally →
      // config saved, exit 0 — but the message names the forge (actionable).
      expect(code).toBe(0);
      const out = cap.lines.join('\n');
      expect(out).toContain('foreign id(s) in meta.required');
      expect(out).toContain('evilcat/skill:x');
      const config = await loadConfigFile(path.join(fix.configDir, 'config.json'));
      expect(config.catalogs?.[0]?.url).toBe(CATALOG_URL);
      // The forged id is never installed.
      expect(await readManifestIds(fix.env)).not.toContain('evilcat/skill:x');
    } finally {
      await fix.cleanupAll();
    }
  });

  it('govid: foreign recommended dropped silently, own required still installed', async () => {
    const fix = await makeInitEnv(
      { required: ['skill:own'], recommended: ['evilcat/skill:x'] },
      [skill('own')],
    );
    const cap = makeCapture();
    try {
      const code = await runCli(['init', '--yes'], {
        env: fix.env,
        print: cap.print,
        remote: { run: fix.runner, tmpFactory: fix.tmpFactory, scanner: stubScanner },
        prompts: {
          selectArtifacts: async () => [],
          selectScope: async () => 'user',
          confirmApply: async () => true,
          askUrl: async () => CATALOG_URL,
          askMethod: async () => 'https',
        },
      });

      expect(code).toBe(0);
      // No fail-closed error for a foreign RECOMMENDED (advisory → silent).
      expect(cap.lines.join('\n')).not.toContain('foreign id(s) in meta.required');
      const ids = await readManifestIds(fix.env);
      expect(ids.some((id) => id.includes('skill:own'))).toBe(true);
      expect(ids).not.toContain('evilcat/skill:x');
    } finally {
      await fix.cleanupAll();
    }
  });
});
