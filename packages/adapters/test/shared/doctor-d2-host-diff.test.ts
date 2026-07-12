/**
 * Tests for the D2 host-diff scanner (adapters/src/shared/doctor-scan.ts,
 * `createHostDiffScanner`, T3) — the natures without a disk signature
 * (guardrail, context) confronted with a fetched catalog canon under `--remote`.
 *
 * Named scenarios from requirements.md (D2):
 *   - "règle guardrail non tracée, identique au canon → finding host-diff"
 *   - "contenu hôte divergent du canon → silence (guardrail, context)"
 *   - "élément canon déjà tracé au manifest → pas un host-diff"
 *   - (context, byte-identical, untracked → finding — the same shape for the
 *     other signature-less nature)
 *
 * The live host config is produced by the REAL engine (`apply`) so it is exactly
 * what an install would write (settings.json deny rules, AGENTS.md block + the
 * CLAUDE.md import). The manifest is then wiped to model an element that is
 * present at the host but tracked by NO entry — the precise state D2 names. The
 * canon is crafted in-memory (a `CatalogCanon`, no fetch) with the matching
 * rules/block; divergence is induced by hand-editing the live config away from it.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogCanon, CatalogEntry } from '@agent-rigger/catalog';
import type { DoctorContext } from '@agent-rigger/core';
import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply } from '@agent-rigger/core/engine';
import { writeManifest } from '@agent-rigger/core/manifest';
import { resolveOpencodeUserTargets, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import type { OpencodePermission } from '@agent-rigger/core/types';

import { createClaudeAdapter } from '../../src/claude/adapter';
import { createOpencodeAdapter } from '../../src/opencode/adapter';
import { createHostDiffScanner } from '../../src/shared/doctor-scan';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpHome(prefix = 'rigger-doctor-d2-'): Promise<{
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

/** An in-memory canon carrying one guardrail/context/mcp element, no fetch. */
function makeCanon(opts: {
  name?: string;
  entries: CatalogEntry[];
  guardrails?: Array<[string, { deny: string[]; allow: string[] }]>;
  guardrailPermissions?: Array<[string, OpencodePermission]>;
  contexts?: Array<[string, string]>;
}): CatalogCanon {
  const name = opts.name ?? 'testcat';
  return {
    name,
    meta: { name, required: [], recommended: [] },
    version: { ref: 'v1', sha: 'deadbeef', isTag: true },
    entries: opts.entries,
    guardrails: new Map(opts.guardrails ?? []),
    guardrailPermissions: new Map(opts.guardrailPermissions ?? []),
    contexts: new Map(opts.contexts ?? []),
  };
}

function guardrailEntry(id: string): CatalogEntry {
  return { kind: 'artifact', id, nature: 'guardrail', targets: ['claude'], scopes: ['user'] };
}

function opencodeGuardrailEntry(id: string): CatalogEntry {
  return { kind: 'artifact', id, nature: 'guardrail', targets: ['opencode'], scopes: ['user'] };
}

function contextEntry(id: string): CatalogEntry {
  return { kind: 'artifact', id, nature: 'context', targets: ['claude'], scopes: ['user'] };
}

/** Overwrite settings.json's permissions.deny with an exact rule set. */
async function writeDeny(settingsPath: string, deny: string[]): Promise<void> {
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify({ permissions: { deny } }));
}

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

async function wipeManifest(): Promise<void> {
  await writeManifest(manifestPath, { version: 1, artifacts: [] });
}

// ---------------------------------------------------------------------------
// règle guardrail non tracée, identique au canon → finding host-diff
// ---------------------------------------------------------------------------

describe('doctor-D2: règle guardrail non tracée identique au canon → finding host-diff', () => {
  it('doctor-D2: a byte-identical, untracked guardrail canon is reported host-diff', async () => {
    await setup();
    try {
      const denyRef = ['Bash(rm -rf /)', 'Bash(curl evil.sh)'];
      const adapter = createClaudeAdapter({ denyRef });
      const entry: AdapterEntry = { id: 'guardrail:secu', nature: 'guardrail', scope: 'user' };
      await apply(adapter, [entry], 'user', env, manifestPath);
      // Present at the host, tracked by nothing.
      await wipeManifest();

      const canon = makeCanon({
        name: 'principal',
        entries: [guardrailEntry('guardrail:secu')],
        guardrails: [['guardrail:secu', { deny: denyRef, allow: [] }]],
      });

      const findings = await createHostDiffScanner(adapter, 'claude', [canon])(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.class).toBe('untracked');
      if (finding.class !== 'untracked') throw new Error('unreachable');
      expect(finding.verdict).toBe('host-diff');
      if (finding.verdict !== 'host-diff') throw new Error('unreachable');
      expect(finding.nature).toBe('guardrail');
      expect(finding.scope).toBe('user');
      expect(finding.assistant).toBe('claude');
      // The detail names the source catalog and the element.
      expect(finding.detail).toContain('principal');
      expect(finding.detail).toContain('secu');
      expect('repair' in finding).toBe(false);
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// contenu hôte divergent du canon → silence (guardrail)
// ---------------------------------------------------------------------------

describe('doctor-D2: guardrail divergent du canon → silence', () => {
  it('doctor-D2: a host deny set missing a canon rule is never a host-diff', async () => {
    await setup();
    try {
      const denyRef = ['Bash(rm -rf /)', 'Bash(curl evil.sh)'];
      const adapter = createClaudeAdapter({ denyRef });
      const entry: AdapterEntry = { id: 'guardrail:secu', nature: 'guardrail', scope: 'user' };
      await apply(adapter, [entry], 'user', env, manifestPath);
      await wipeManifest();

      // The host drifted away from the canon — one canon rule is gone.
      await writeDeny(resolveUserTargets(env).claudeSettings, ['Bash(rm -rf /)']);

      const canon = makeCanon({
        entries: [guardrailEntry('guardrail:secu')],
        guardrails: [['guardrail:secu', { deny: denyRef, allow: [] }]],
      });

      const findings = await createHostDiffScanner(adapter, 'claude', [canon])(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it('doctor-D2: a host deny set that is a superset of the canon is never a host-diff', async () => {
    await setup();
    try {
      const denyRef = ['Bash(rm -rf /)'];
      const adapter = createClaudeAdapter({ denyRef });
      const entry: AdapterEntry = { id: 'guardrail:secu', nature: 'guardrail', scope: 'user' };
      await apply(adapter, [entry], 'user', env, manifestPath);
      await wipeManifest();

      // The host holds the canon rule AND an extra, user-authored rule: the host
      // is a superset, NOT byte-identical. A superset is a content deviation →
      // user territory → silence (D2 "contenu hôte divergent du canon → silence").
      await writeDeny(resolveUserTargets(env).claudeSettings, [
        'Bash(rm -rf /)',
        'Read(./secrets/**)',
      ]);

      const canon = makeCanon({
        entries: [guardrailEntry('guardrail:secu')],
        guardrails: [['guardrail:secu', { deny: denyRef, allow: [] }]],
      });

      const findings = await createHostDiffScanner(adapter, 'claude', [canon])(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it('doctor-D2: a host allow set that is a superset of the canon is never a host-diff', async () => {
    await setup();
    try {
      const denyRef = ['Bash(rm -rf /)'];
      const allowRef = ['Bash(ls:*)'];
      const adapter = createClaudeAdapter({ denyRef, allowRef });
      const entry: AdapterEntry = { id: 'guardrail:secu', nature: 'guardrail', scope: 'user' };
      await apply(adapter, [entry], 'user', env, manifestPath);
      await wipeManifest();

      // Deny coincides exactly, but the host allow set carries an extra rule on
      // top of the canon — still a superset, still user territory → silence.
      await fs.writeFile(
        resolveUserTargets(env).claudeSettings,
        JSON.stringify({
          permissions: { deny: denyRef, allow: ['Bash(ls:*)', 'Bash(cat:*)'] },
        }),
      );

      const canon = makeCanon({
        entries: [guardrailEntry('guardrail:secu')],
        guardrails: [['guardrail:secu', { deny: denyRef, allow: allowRef }]],
      });

      const findings = await createHostDiffScanner(adapter, 'claude', [canon])(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it('doctor-D2: a host deny set byte-identical to the canon (allow included) is a host-diff', async () => {
    await setup();
    try {
      const denyRef = ['Bash(rm -rf /)'];
      const allowRef = ['Bash(ls:*)'];
      const adapter = createClaudeAdapter({ denyRef, allowRef });
      const entry: AdapterEntry = { id: 'guardrail:secu', nature: 'guardrail', scope: 'user' };
      await apply(adapter, [entry], 'user', env, manifestPath);
      await wipeManifest();

      const canon = makeCanon({
        name: 'principal',
        entries: [guardrailEntry('guardrail:secu')],
        guardrails: [['guardrail:secu', { deny: denyRef, allow: allowRef }]],
      });

      const findings = await createHostDiffScanner(adapter, 'claude', [canon])(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.class).toBe('untracked');
      if (finding.class !== 'untracked') throw new Error('unreachable');
      expect(finding.verdict).toBe('host-diff');
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// élément canon déjà tracé au manifest → pas un host-diff
// ---------------------------------------------------------------------------

describe('doctor-D2: guardrail tracé au manifest → pas un host-diff', () => {
  it('doctor-D2: a guardrail identical to the canon but claimed by a manifest entry is silent', async () => {
    await setup();
    try {
      const denyRef = ['Bash(rm -rf /)'];
      const adapter = createClaudeAdapter({ denyRef });
      const entry: AdapterEntry = { id: 'guardrail:secu', nature: 'guardrail', scope: 'user' };
      // apply keeps the manifest entry — the element is tracked.
      await apply(adapter, [entry], 'user', env, manifestPath);

      const canon = makeCanon({
        entries: [guardrailEntry('guardrail:secu')],
        guardrails: [['guardrail:secu', { deny: denyRef, allow: [] }]],
      });

      const findings = await createHostDiffScanner(adapter, 'claude', [canon])(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it('doctor-D2: the manifest match tolerates a catalog-qualified canon id', async () => {
    await setup();
    try {
      const denyRef = ['Bash(rm -rf /)'];
      const adapter = createClaudeAdapter({ denyRef });
      const entry: AdapterEntry = { id: 'guardrail:secu', nature: 'guardrail', scope: 'user' };
      await apply(adapter, [entry], 'user', env, manifestPath);

      // The canon carries the fully-qualified id; the manifest has the local one.
      const canon = makeCanon({
        name: 'principal',
        entries: [guardrailEntry('principal/guardrail:secu')],
        guardrails: [['principal/guardrail:secu', { deny: denyRef, allow: [] }]],
      });

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
// context byte-identique non tracé → finding ; divergent → silence
// ---------------------------------------------------------------------------

describe('doctor-D2: context sans signature disque', () => {
  it('doctor-D2: a byte-identical, untracked context canon is reported host-diff', async () => {
    await setup();
    try {
      const agentsContent = '# Team context\nCanonical block posted by rigger.\n';
      const adapter = createClaudeAdapter({ denyRef: [], agentsContent });
      const entry: AdapterEntry = { id: 'context:team', nature: 'context', scope: 'user' };
      await apply(adapter, [entry], 'user', env, manifestPath);
      await wipeManifest();

      const canon = makeCanon({
        name: 'principal',
        entries: [contextEntry('context:team')],
        contexts: [['context:team', agentsContent]],
      });

      const findings = await createHostDiffScanner(adapter, 'claude', [canon])(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.class).toBe('untracked');
      if (finding.class !== 'untracked') throw new Error('unreachable');
      expect(finding.verdict).toBe('host-diff');
      expect(finding.nature).toBe('context');
    } finally {
      await teardown();
    }
  });

  it('doctor-D2: a context whose AGENTS.md diverges from the canon is silent', async () => {
    await setup();
    try {
      const agentsContent = '# Team context\nCanonical block posted by rigger.\n';
      const adapter = createClaudeAdapter({ denyRef: [], agentsContent });
      const entry: AdapterEntry = { id: 'context:team', nature: 'context', scope: 'user' };
      await apply(adapter, [entry], 'user', env, manifestPath);
      await wipeManifest();

      // Hand-edit the live AGENTS.md away from the canon block.
      await fs.writeFile(
        resolveUserTargets(env).agentsMd,
        '# Team context\nHand-edited, no longer canonical.\n',
      );

      const canon = makeCanon({
        entries: [contextEntry('context:team')],
        contexts: [['context:team', agentsContent]],
      });

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
// opencode guardrail (native permission descriptor) → D2 "les deux assistants"
// ---------------------------------------------------------------------------

/** A realistic native opencode permission descriptor subset. */
const OC_PERMISSION: OpencodePermission = {
  read: { '.env': 'deny' },
  bash: { 'rm -rf *': 'deny' },
};

/** Overwrite opencode.json's `permission` key with an exact descriptor. */
async function writeOpencodePermission(
  opencodeJsonPath: string,
  permission: OpencodePermission,
): Promise<void> {
  await fs.mkdir(path.dirname(opencodeJsonPath), { recursive: true });
  await fs.writeFile(opencodeJsonPath, JSON.stringify({ permission }));
}

describe('doctor-D2: opencode guardrail permission — les deux assistants', () => {
  it('doctor-D2: a byte-identical, untracked opencode permission is reported host-diff', async () => {
    await setup();
    try {
      const adapter = createOpencodeAdapter({ permission: OC_PERMISSION });
      const entry: AdapterEntry = { id: 'guardrail:secu', nature: 'guardrail', scope: 'user' };
      // The real engine writes exactly what an install would into opencode.json.
      await apply(adapter, [entry], 'user', env, manifestPath);
      // Present at the host, tracked by nothing.
      await wipeManifest();

      const canon = makeCanon({
        name: 'principal',
        entries: [opencodeGuardrailEntry('guardrail:secu')],
        guardrailPermissions: [['guardrail:secu', OC_PERMISSION]],
      });

      const findings = await createHostDiffScanner(adapter, 'opencode', [canon])(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.class).toBe('untracked');
      if (finding.class !== 'untracked') throw new Error('unreachable');
      expect(finding.verdict).toBe('host-diff');
      if (finding.verdict !== 'host-diff') throw new Error('unreachable');
      expect(finding.nature).toBe('guardrail');
      expect(finding.scope).toBe('user');
      expect(finding.assistant).toBe('opencode');
      expect(finding.detail).toContain('principal');
      expect(finding.detail).toContain('secu');
      expect('repair' in finding).toBe(false);
    } finally {
      await teardown();
    }
  });

  it('doctor-D2: an opencode permission diverging in a leaf state is never a host-diff', async () => {
    await setup();
    try {
      const adapter = createOpencodeAdapter({ permission: OC_PERMISSION });
      const opencodeJson = resolveOpencodeUserTargets(env).opencodeJson;
      // Same shape, one leaf flipped away from the canon → a content deviation.
      await writeOpencodePermission(opencodeJson, {
        read: { '.env': 'allow' },
        bash: { 'rm -rf *': 'deny' },
      });

      const canon = makeCanon({
        entries: [opencodeGuardrailEntry('guardrail:secu')],
        guardrailPermissions: [['guardrail:secu', OC_PERMISSION]],
      });

      const findings = await createHostDiffScanner(adapter, 'opencode', [canon])(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it('doctor-D2: an opencode permission that is a superset of the canon is never a host-diff', async () => {
    await setup();
    try {
      const adapter = createOpencodeAdapter({ permission: OC_PERMISSION });
      const opencodeJson = resolveOpencodeUserTargets(env).opencodeJson;
      // The host holds every canon leaf AND an extra user-authored leaf → superset.
      await writeOpencodePermission(opencodeJson, {
        read: { '.env': 'deny' },
        bash: { 'rm -rf *': 'deny' },
        webfetch: 'allow',
      });

      const canon = makeCanon({
        entries: [opencodeGuardrailEntry('guardrail:secu')],
        guardrailPermissions: [['guardrail:secu', OC_PERMISSION]],
      });

      const findings = await createHostDiffScanner(adapter, 'opencode', [canon])(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it('doctor-D2: an opencode permission that is a subset of the canon is never a host-diff', async () => {
    await setup();
    try {
      const adapter = createOpencodeAdapter({ permission: OC_PERMISSION });
      const opencodeJson = resolveOpencodeUserTargets(env).opencodeJson;
      // The host holds only part of the canon (one leaf missing) → subset.
      await writeOpencodePermission(opencodeJson, { read: { '.env': 'deny' } });

      const canon = makeCanon({
        entries: [opencodeGuardrailEntry('guardrail:secu')],
        guardrailPermissions: [['guardrail:secu', OC_PERMISSION]],
      });

      const findings = await createHostDiffScanner(adapter, 'opencode', [canon])(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it('doctor-D2: an opencode permission claimed by a manifest entry is silent', async () => {
    await setup();
    try {
      const adapter = createOpencodeAdapter({ permission: OC_PERMISSION });
      const entry: AdapterEntry = { id: 'guardrail:secu', nature: 'guardrail', scope: 'user' };
      // apply keeps the manifest entry (assistant stamped 'opencode') — tracked.
      await apply(adapter, [entry], 'user', env, manifestPath);

      const canon = makeCanon({
        entries: [opencodeGuardrailEntry('guardrail:secu')],
        guardrailPermissions: [['guardrail:secu', OC_PERMISSION]],
      });

      const findings = await createHostDiffScanner(adapter, 'opencode', [canon])(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it('doctor-D2: the opencode scanner skips a guardrail with no opencode canon', async () => {
    await setup();
    try {
      const adapter = createOpencodeAdapter({ permission: OC_PERMISSION });
      const opencodeJson = resolveOpencodeUserTargets(env).opencodeJson;
      await writeOpencodePermission(opencodeJson, OC_PERMISSION);

      // Entry targets opencode, but the canon only carries the claude deny/allow
      // shape (no permission descriptor) → nothing for the opencode scanner to
      // confront, never a false finding.
      const canon = makeCanon({
        entries: [opencodeGuardrailEntry('guardrail:secu')],
        guardrails: [['guardrail:secu', { deny: ['Bash(rm -rf /)'], allow: [] }]],
      });

      const findings = await createHostDiffScanner(adapter, 'opencode', [canon])(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(0);
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// scanner scoping — assistant + target filtering
// ---------------------------------------------------------------------------

describe('doctor-D2: scoping', () => {
  it('doctor-D2: an entry not targeting this scanner assistant is skipped', async () => {
    await setup();
    try {
      const denyRef = ['Bash(rm -rf /)'];
      const adapter = createClaudeAdapter({ denyRef });
      const entry: AdapterEntry = { id: 'guardrail:secu', nature: 'guardrail', scope: 'user' };
      await apply(adapter, [entry], 'user', env, manifestPath);
      await wipeManifest();

      // Canon element targets opencode only — the claude scanner ignores it.
      const opencodeOnly: CatalogEntry = {
        kind: 'artifact',
        id: 'guardrail:secu',
        nature: 'guardrail',
        targets: ['opencode'],
        scopes: ['user'],
      };
      const canon = makeCanon({
        entries: [opencodeOnly],
        guardrails: [['guardrail:secu', { deny: denyRef, allow: [] }]],
      });

      const findings = await createHostDiffScanner(adapter, 'claude', [canon])(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(0);
    } finally {
      await teardown();
    }
  });

  it('doctor-D2: no canons → no findings (parity with the offline default)', async () => {
    await setup();
    try {
      const adapter = createClaudeAdapter({ denyRef: ['Bash(rm -rf /)'] });
      const entry: AdapterEntry = { id: 'guardrail:secu', nature: 'guardrail', scope: 'user' };
      await apply(adapter, [entry], 'user', env, manifestPath);
      await wipeManifest();

      const findings = await createHostDiffScanner(adapter, 'claude', [])(
        ctxFor(manifestPath, env),
      );

      expect(findings).toHaveLength(0);
    } finally {
      await teardown();
    }
  });
});
