/**
 * Tests for the D3 mcp-divergent case of the host-diff scanner
 * (adapters/src/shared/doctor-scan.ts, `createHostDiffScanner`, T3).
 *
 * Named scenarios from requirements.md (D3):
 *   - "serveur homonyme divergent → finding report-only « divergent du canon,
 *      jamais adopté » + les deux sorties (reinstall consenti / suppression)"
 *   - "serveur hôte sans homonyme au canon → silence"
 *   - (a homonym byte-identical to the canon → the D2 coincidence finding, the
 *     same server nameable once the canon is reachable)
 *   - (a homonym already tracked by the manifest → silence)
 *
 * mcp fixtures are crafted directly (a live `.claude.json` mcpServers map + a
 * canon with the inline `config`), never via `apply`: installing a real mcp
 * server would spawn `claude mcp add`, out of scope for this read-only scanner.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogCanon, CatalogEntry } from '@agent-rigger/catalog';
import type { DoctorContext } from '@agent-rigger/core';
import { writeManifest } from '@agent-rigger/core/manifest';
import { resolveHome, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { ClaudeMcpServer, ManifestEntry } from '@agent-rigger/core/types';

import { createClaudeAdapter } from '../../src/claude/adapter';
import { createHostDiffScanner } from '../../src/shared/doctor-scan';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-doctor-d3-'): Promise<{
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

const GITHUB_CONFIG: ClaudeMcpServer = {
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
};

function mcpEntry(id: string, config: ClaudeMcpServer): CatalogEntry {
  return {
    kind: 'artifact',
    id,
    nature: 'mcp',
    targets: ['claude'],
    scopes: ['user'],
    config: config as unknown as Record<string, unknown>,
  };
}

function makeCanon(entries: CatalogEntry[], name = 'principal'): CatalogCanon {
  return {
    name,
    meta: { name, required: [], recommended: [] },
    version: { ref: 'v1', sha: 'deadbeef', isTag: true },
    entries,
    guardrails: new Map(),
    guardrailPermissions: new Map(),
    contexts: new Map(),
  };
}

/** Write the live `.claude.json` `mcpServers` map (user scope). */
async function writeClaudeMcp(env: Env, servers: Record<string, ClaudeMcpServer>): Promise<void> {
  const configPath = path.join(resolveHome(env), '.claude.json');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: servers }));
}

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;
let manifestPath: string;

async function setup(): Promise<void> {
  tmp = await makeTmpHome();
  env = tmp.env;
  manifestPath = resolveUserTargets(env).stateJson;
  await writeManifest(manifestPath, { version: 1, artifacts: [] });
}

async function teardown(): Promise<void> {
  await tmp.cleanup();
}

const adapter = createClaudeAdapter({ denyRef: [] });

// ---------------------------------------------------------------------------
// serveur homonyme divergent → finding D3
// ---------------------------------------------------------------------------

describe('doctor-D3: serveur homonyme divergent → finding', () => {
  it('doctor-D3: a same-name, divergent, untracked mcp server is host-diff with the divergent detail', async () => {
    await setup();
    try {
      // Live server under the same name, divergent descriptor (an env was added).
      await writeClaudeMcp(env, {
        github: { ...GITHUB_CONFIG, env: { X: '1' } },
      });

      const canon = makeCanon([mcpEntry('mcp:github', GITHUB_CONFIG)]);

      const findings = await createHostDiffScanner(adapter, 'claude', [canon])(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.class).toBe('untracked');
      if (finding.class !== 'untracked') throw new Error('unreachable');
      expect(finding.verdict).toBe('host-diff');
      if (finding.verdict !== 'host-diff') throw new Error('unreachable');
      expect(finding.nature).toBe('mcp');
      expect(finding.scope).toBe('user');
      // The detail explains the divergent state and the two manual ways out.
      expect(finding.detail).toContain('github');
      expect(finding.detail).toContain('principal');
      expect(finding.detail.toLowerCase()).toContain('diverge');
      expect(finding.detail.toLowerCase()).toContain('reinstall');
      expect(finding.detail.toLowerCase()).toContain('remove');
      expect('repair' in finding).toBe(false);
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// serveur homonyme byte-identique → finding D2 (coincidence)
// ---------------------------------------------------------------------------

describe('doctor-D3: serveur homonyme byte-identique → finding host-diff', () => {
  it('doctor-D3: a same-name mcp server deep-equal to the canon is reported host-diff', async () => {
    await setup();
    try {
      await writeClaudeMcp(env, { github: { ...GITHUB_CONFIG } });

      const canon = makeCanon([mcpEntry('mcp:github', GITHUB_CONFIG)]);

      const findings = await createHostDiffScanner(adapter, 'claude', [canon])(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.class).toBe('untracked');
      if (finding.class !== 'untracked') throw new Error('unreachable');
      expect(finding.verdict).toBe('host-diff');
      expect(finding.nature).toBe('mcp');
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// serveur hôte sans homonyme au canon → silence
// ---------------------------------------------------------------------------

describe('doctor-D3: serveur sans homonyme au canon → silence', () => {
  it('doctor-D3: a host mcp server with no canon homonym is never a finding', async () => {
    await setup();
    try {
      // The live server name exists in no fetched catalog.
      await writeClaudeMcp(env, {
        'some-user-server': { command: 'node', args: ['server.js'] },
      });

      const canon = makeCanon([mcpEntry('mcp:github', GITHUB_CONFIG)]);

      const findings = await createHostDiffScanner(adapter, 'claude', [canon])(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(0);
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// serveur homonyme déjà tracé au manifest → silence
// ---------------------------------------------------------------------------

describe('doctor-D3: serveur homonyme tracé au manifest → silence', () => {
  it('doctor-D3: a divergent homonym claimed by a manifest entry is not a host-diff (D4 territory)', async () => {
    await setup();
    try {
      await writeClaudeMcp(env, { github: { ...GITHUB_CONFIG, env: { X: '1' } } });

      const trackedEntry: ManifestEntry = {
        id: 'mcp:github',
        nature: 'mcp',
        ref: 'v1',
        sha: 'deadbeef',
        scope: 'user',
        installedAt: new Date().toISOString(),
        files: [],
        assistant: 'claude',
        applied: { kind: 'claude-mcp', server: 'github', config: GITHUB_CONFIG, scope: 'user' },
      };
      await writeManifest(manifestPath, { version: 1, artifacts: [trackedEntry] });

      const canon = makeCanon([mcpEntry('mcp:github', GITHUB_CONFIG)]);

      const findings = await createHostDiffScanner(adapter, 'claude', [canon])(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(0);
    } finally {
      await teardown();
    }
  });
});
