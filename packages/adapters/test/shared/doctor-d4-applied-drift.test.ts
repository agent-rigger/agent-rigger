/**
 * Tests for the D4 applied-drift scanner (adapters/src/shared/doctor-scan.ts,
 * `createAppliedDriftScanner`, T2).
 *
 * Named scenarios from requirements.md (D4):
 *   - "règles guardrail éditées après install → drift"
 *   - "une règle utilisateur en plus → silence" (subset semantics, D4 design table)
 *   - "bloc context modifié → drift"
 *   - "mcp config modifiée → drift" (deep-compare local, design decision #3)
 *   - "config vivante conforme → aucun finding"
 *   - "natures sans payload applied / link → hors de ce check"
 *
 * The scanner confronts each manifest entry's recorded `applied` payload
 * (ADR-0016) with the live host config — purely OFFLINE, no catalog fetch. The
 * guardrail/context fixtures are built via the REAL engine (`apply`) so the
 * recorded `applied` payload matches production exactly; drift is then induced
 * by hand-editing the live config. The mcp/link fixtures are crafted directly
 * (a manifest entry + a live config file), since installing an mcp server would
 * spawn the `claude mcp add` CLI — out of scope for this offline scanner test.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DoctorContext } from '@agent-rigger/core';
import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply } from '@agent-rigger/core/engine';
import { readManifest, writeManifest } from '@agent-rigger/core/manifest';
import { resolveHome, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { ClaudeMcpServer, ManifestEntry } from '@agent-rigger/core/types';

import { createClaudeAdapter } from '../../src/claude/adapter';
import { createAppliedDriftScanner } from '../../src/shared/doctor-scan';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-doctor-d4-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

function ctxFor(manifestPath: string, env: Env): DoctorContext {
  return { env, manifestPath, configuredCatalogIds: [] };
}

/** Overwrite settings.json's permissions.deny with an exact rule set. */
async function writeDeny(settingsPath: string, deny: string[]): Promise<void> {
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify({ permissions: { deny } }));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let manifestPath: string;

async function setup(): Promise<void> {
  tmp = await makeTmpHome();
  env = tmp.env;
  manifestPath = resolveUserTargets(env).stateJson;
}

async function teardown(): Promise<void> {
  await tmp.cleanup();
}

// ---------------------------------------------------------------------------
// règles guardrail éditées après install → drift
// ---------------------------------------------------------------------------

describe('doctor-D4: règles guardrail éditées après install → drift', () => {
  it('doctor-D4: an applied deny rule removed from the live settings.json is applied-drift', async () => {
    await setup();
    try {
      const denyRef = ['Bash(rm -rf /)', 'Bash(curl evil.sh)'];
      const adapter = createClaudeAdapter({ denyRef });
      const entry: AdapterEntry = { id: 'guardrail:secu', nature: 'guardrail', scope: 'user' };

      await apply(adapter, [entry], 'user', env, manifestPath);

      // A user drops one of the applied deny rules by hand — the payload no
      // longer matches the live config.
      const settingsPath = resolveUserTargets(env).claudeSettings;
      await writeDeny(settingsPath, ['Bash(rm -rf /)']);

      const findings = await createAppliedDriftScanner(adapter, 'claude')(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.class).toBe('manifest');
      if (finding.class !== 'manifest') throw new Error('unreachable');
      expect(finding.issue).toBe('applied-drift');
      if (finding.issue !== 'applied-drift') throw new Error('unreachable');
      expect(finding.entryId).toBe('guardrail:secu');
      expect(finding.nature).toBe('guardrail');
      expect(finding.scope).toBe('user');
      expect('repair' in finding).toBe(false);
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// une règle utilisateur en plus → silence
// ---------------------------------------------------------------------------

describe('doctor-D4: une règle utilisateur en plus → silence', () => {
  it('doctor-D4: an extra hand-added deny rule (applied still a subset) never drifts', async () => {
    await setup();
    try {
      const denyRef = ['Bash(rm -rf /)'];
      const adapter = createClaudeAdapter({ denyRef });
      const entry: AdapterEntry = { id: 'guardrail:secu', nature: 'guardrail', scope: 'user' };

      await apply(adapter, [entry], 'user', env, manifestPath);

      // Every applied rule is still present; the user simply added more — their
      // territory, silence (D4 design table "sous-ensemble voulu").
      const settingsPath = resolveUserTargets(env).claudeSettings;
      await writeDeny(settingsPath, ['Bash(rm -rf /)', 'Bash(sudo su)']);

      const findings = await createAppliedDriftScanner(adapter, 'claude')(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(0);
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// bloc context modifié → drift
// ---------------------------------------------------------------------------

describe('doctor-D4: bloc context modifié → drift', () => {
  it('doctor-D4: an AGENTS.md edited away from the applied block is applied-drift', async () => {
    await setup();
    try {
      const agentsContent = '# Team context\nCanonical block posted by rigger.\n';
      const adapter = createClaudeAdapter({ denyRef: [], agentsContent });
      const entry: AdapterEntry = { id: 'context:team', nature: 'context', scope: 'user' };

      await apply(adapter, [entry], 'user', env, manifestPath);

      // The live AGENTS.md diverges from the applied block.
      const agentsMdPath = resolveUserTargets(env).agentsMd;
      await fs.writeFile(agentsMdPath, '# Team context\nHand-edited, no longer canonical.\n');

      const findings = await createAppliedDriftScanner(adapter, 'claude')(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.class).toBe('manifest');
      if (finding.class !== 'manifest') throw new Error('unreachable');
      expect(finding.issue).toBe('applied-drift');
      if (finding.issue !== 'applied-drift') throw new Error('unreachable');
      expect(finding.entryId).toBe('context:team');
      expect(finding.nature).toBe('context');
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// mcp config modifiée → drift (deep-compare local)
// ---------------------------------------------------------------------------

const GITHUB_CONFIG: ClaudeMcpServer = {
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
};

/** Craft a manifest carrying a single claude-mcp applied payload for `server`. */
async function seedMcpManifest(server: string, config: ClaudeMcpServer): Promise<void> {
  const mcpEntry: ManifestEntry = {
    id: `mcp:${server}`,
    nature: 'mcp',
    ref: 'v1',
    sha: 'deadbeef',
    scope: 'user',
    installedAt: new Date().toISOString(),
    files: [],
    assistant: 'claude',
    applied: { kind: 'claude-mcp', server, config, scope: 'user' },
  };
  await writeManifest(manifestPath, { version: 1, artifacts: [mcpEntry] });
}

/** Write the live `.claude.json` `mcpServers` map (user scope). */
async function writeClaudeMcp(servers: Record<string, ClaudeMcpServer>): Promise<void> {
  const configPath = path.join(resolveHome(env), '.claude.json');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: servers }));
}

describe('doctor-D4: mcp config modifiée → drift', () => {
  it('doctor-D4: a live mcp descriptor diverging from the applied config is applied-drift', async () => {
    await setup();
    try {
      const adapter = createClaudeAdapter({ denyRef: [] });
      await seedMcpManifest('github', GITHUB_CONFIG);
      // Same server id, divergent descriptor (an env var was added by hand).
      await writeClaudeMcp({
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { X: '1' },
        },
      });

      const findings = await createAppliedDriftScanner(adapter, 'claude')(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.class).toBe('manifest');
      if (finding.class !== 'manifest') throw new Error('unreachable');
      expect(finding.issue).toBe('applied-drift');
      if (finding.issue !== 'applied-drift') throw new Error('unreachable');
      expect(finding.entryId).toBe('mcp:github');
      expect(finding.nature).toBe('mcp');
    } finally {
      await teardown();
    }
  });

  it('doctor-D4: an applied mcp server absent from the live config is applied-drift', async () => {
    await setup();
    try {
      const adapter = createClaudeAdapter({ denyRef: [] });
      await seedMcpManifest('github', GITHUB_CONFIG);
      // The server was removed from the live config out of band.
      await writeClaudeMcp({});

      const findings = await createAppliedDriftScanner(adapter, 'claude')(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(1);
      expect(findings[0]!.class).toBe('manifest');
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// config vivante conforme → aucun finding
// ---------------------------------------------------------------------------

describe('doctor-D4: config vivante conforme → aucun finding', () => {
  it('doctor-D4: an intact guardrail install produces no applied-drift', async () => {
    await setup();
    try {
      const adapter = createClaudeAdapter({ denyRef: ['Bash(rm -rf /)'] });
      const entry: AdapterEntry = { id: 'guardrail:secu', nature: 'guardrail', scope: 'user' };

      await apply(adapter, [entry], 'user', env, manifestPath);

      const findings = await createAppliedDriftScanner(adapter, 'claude')(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it('doctor-D4: a live mcp descriptor deep-equal to the applied config produces no finding', async () => {
    await setup();
    try {
      const adapter = createClaudeAdapter({ denyRef: [] });
      await seedMcpManifest('github', GITHUB_CONFIG);
      await writeClaudeMcp({ github: { ...GITHUB_CONFIG } });

      const findings = await createAppliedDriftScanner(adapter, 'claude')(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(0);
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// natures sans payload applied / link → hors de ce check
// ---------------------------------------------------------------------------

describe('doctor-D4: natures sans payload applied → hors de ce check', () => {
  it('doctor-D4: a link-payload entry (skill) is never confronted here, even if its file is gone', async () => {
    await setup();
    try {
      const adapter = createClaudeAdapter({ denyRef: [] });
      const linkEntry: ManifestEntry = {
        id: 'skill:foo',
        nature: 'skill',
        ref: 'v1',
        sha: 'deadbeef',
        scope: 'user',
        installedAt: new Date().toISOString(),
        files: [path.join(tmp.dir, 'gone', 'foo')],
        assistant: 'claude',
        applied: { kind: 'link', files: [path.join(tmp.dir, 'gone', 'foo')] },
      };
      await writeManifest(manifestPath, { version: 1, artifacts: [linkEntry] });

      const findings = await createAppliedDriftScanner(adapter, 'claude')(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it('doctor-D4: an entry with no applied payload at all is skipped', async () => {
    await setup();
    try {
      const adapter = createClaudeAdapter({ denyRef: [] });
      const legacyEntry: ManifestEntry = {
        id: 'skill:legacy',
        nature: 'skill',
        ref: 'v1',
        sha: 'deadbeef',
        scope: 'user',
        installedAt: new Date().toISOString(),
        files: [path.join(tmp.dir, 'gone', 'legacy')],
        assistant: 'claude',
      };
      await writeManifest(manifestPath, { version: 1, artifacts: [legacyEntry] });

      const findings = await createAppliedDriftScanner(adapter, 'claude')(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it('doctor-D4: entries for another assistant are not scanned by this instance', async () => {
    await setup();
    try {
      const adapter = createClaudeAdapter({ denyRef: [] });
      // An opencode-mcp entry: the claude scanner instance must ignore it.
      const opencodeEntry: ManifestEntry = {
        id: 'mcp:other',
        nature: 'mcp',
        ref: 'v1',
        sha: 'deadbeef',
        scope: 'user',
        installedAt: new Date().toISOString(),
        files: [],
        assistant: 'opencode',
        applied: {
          kind: 'opencode-mcp',
          server: 'other',
          config: { type: 'local', command: ['x'] },
        },
      };
      await writeManifest(manifestPath, { version: 1, artifacts: [opencodeEntry] });

      const findings = await createAppliedDriftScanner(adapter, 'claude')(
        ctxFor(manifestPath, env),
      );

      // readManifest exists; the claude instance skips the opencode entry.
      const manifest = await readManifest(manifestPath);
      expect(manifest.artifacts).toHaveLength(1);
      expect(findings).toHaveLength(0);
    } finally {
      await teardown();
    }
  });
});
