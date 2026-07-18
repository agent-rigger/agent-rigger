/**
 * scu-r2-staging.test.ts — R2 union staging (scan-par-catalogue, T3).
 *
 * materializeUnion builds the single root the scan gate points at: the exact
 * union of the selection plus catalog.json, mirrored at each artefact's
 * checkout-relative position (R2 "chaque nature conserve sa surface"). These
 * tests exercise the mirror on its own tree, before any apply-time coupling
 * exists — proving the staging root is byte-faithful, scope-tight, symlink-safe
 * (dereference:false), fail-closed on a missing target, and always a sibling of
 * the checkout (never under baseDir).
 *
 * Fixtures are real on-disk checkouts via fs.mkdtemp (the CLI test pattern).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ArtifactEntry } from '@agent-rigger/catalog';

import { materializeUnion } from '../src/scan-staging';

// ---------------------------------------------------------------------------
// Entry fixtures — one per nature. scanPathFor derives the checkout position;
// event/matcher are omitted (optional at the inferred-type level, unread here).
// ---------------------------------------------------------------------------

const SKILL: ArtifactEntry = {
  kind: 'artifact',
  id: 'skill:mon-skill',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user'],
};

const AGENT: ArtifactEntry = {
  kind: 'artifact',
  id: 'agent:mon-agent',
  nature: 'agent',
  targets: ['claude'],
  scopes: ['user'],
};

const GUARDRAIL: ArtifactEntry = {
  kind: 'artifact',
  id: 'guardrail:mon-guard',
  nature: 'guardrail',
  targets: ['claude'],
  scopes: ['user'],
};

const CONTEXT: ArtifactEntry = {
  kind: 'artifact',
  id: 'context:mon-ctx',
  nature: 'context',
  targets: ['claude'],
  scopes: ['user'],
};

const HOOK_A: ArtifactEntry = {
  kind: 'artifact',
  id: 'hook:h1',
  nature: 'hook',
  targets: ['claude'],
  scopes: ['user'],
};

const HOOK_B: ArtifactEntry = {
  kind: 'artifact',
  id: 'hook:h2',
  nature: 'hook',
  targets: ['claude'],
  scopes: ['user'],
};

const PLUGIN_OPENCODE: ArtifactEntry = {
  kind: 'artifact',
  id: 'plugin:mon-plugin',
  nature: 'plugin',
  targets: ['opencode'],
  scopes: ['user'],
};

// ---------------------------------------------------------------------------
// Checkout fixture — every nature present, plus a NON-selected skill and a
// shared hook lib the selected hooks never reference (R2 surface check).
// ---------------------------------------------------------------------------

interface Checkout {
  baseDir: string;
  tmpParent: string;
  cleanup: () => Promise<void>;
}

async function writeFile(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

/**
 * Build a checkout under a dedicated parent dir. `tmpParent` is the sibling
 * location a caller-supplied tmpFactory can stage into (kept distinct from
 * baseDir so the scope tests are unambiguous).
 */
async function makeCheckout(): Promise<Checkout> {
  const tmpParent = await fs.mkdtemp(path.join(os.tmpdir(), 'scu-r2-parent-'));
  const baseDir = path.join(tmpParent, 'checkout');
  await fs.mkdir(baseDir, { recursive: true });

  await writeFile(path.join(baseDir, 'catalog.json'), '{"meta":{"name":"scu"},"entries":[]}\n');
  await writeFile(path.join(baseDir, 'skills', 'mon-skill', 'SKILL.md'), '# mon-skill\n');
  await writeFile(path.join(baseDir, 'skills', 'mon-skill', 'helper.ts'), 'export const x = 1;\n');
  // NON-selected content — must never leak into a staging built without it.
  await writeFile(path.join(baseDir, 'skills', 'autre', 'SKILL.md'), '# autre (secret)\n');
  await writeFile(path.join(baseDir, 'agents', 'mon-agent.md'), '# mon-agent\n');
  await writeFile(path.join(baseDir, 'guardrails', 'mon-guard', 'deny.json'), '{"deny":[]}\n');
  await writeFile(path.join(baseDir, 'contexts', 'mon-ctx', 'AGENTS.md'), '# ctx\n');
  await writeFile(path.join(baseDir, 'hooks', 'guard.ts'), 'export const guard = 1;\n');
  // Shared lib the selected hooks never import — still part of the hooks/ surface.
  await writeFile(path.join(baseDir, 'hooks', '_shared', 'lib.ts'), 'export const lib = 1;\n');
  await writeFile(path.join(baseDir, 'plugins', 'mon-plugin', 'index.ts'), 'export default {};\n');

  const cleanup = async () => {
    await fs.rm(tmpParent, { recursive: true, force: true });
  };
  return { baseDir, tmpParent, cleanup };
}

/** Sorted rel-paths of every leaf under `root`; symlinks are leaves (not followed). */
async function walkLeaves(root: string, dir: string = root): Promise<string[]> {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const d of dirents) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) {
      out.push(...(await walkLeaves(root, full)));
    } else {
      out.push(path.relative(root, full));
    }
  }
  return out.sort();
}

/** tmpFactory that stages inside `parent` so a test can locate + assert cleanup. */
function stagingIn(parent: string): () => Promise<string> {
  return () => fs.mkdtemp(path.join(parent, 'staging-'));
}

/**
 * tmpFactory that records every staging dir it hands out, so a test can assert
 * whether one was created at all (guard fired before creation → `created` empty)
 * and whether a partial one was torn down after a failure.
 */
function recordingStagingIn(parent: string): { factory: () => Promise<string>; created: string[] } {
  const created: string[] = [];
  const factory = async (): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(parent, 'staging-'));
    created.push(dir);
    return dir;
  };
  return { factory, created };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const checkouts: Checkout[] = [];

async function newCheckout(): Promise<Checkout> {
  const c = await makeCheckout();
  checkouts.push(c);
  return c;
}

afterEach(async () => {
  while (checkouts.length > 0) {
    const c = checkouts.pop();
    if (c !== undefined) await c.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('R2: materializeUnion — exact multi-nature mirror', () => {
  it('stages catalog.json plus each selected surface at its checkout-relative position, and nothing else', async () => {
    const { baseDir, tmpParent } = await newCheckout();

    const { stagingDir, cleanup } = await materializeUnion({
      entries: [SKILL, AGENT, GUARDRAIL, CONTEXT, HOOK_A, HOOK_B, PLUGIN_OPENCODE],
      baseDir,
      tmpFactory: stagingIn(tmpParent),
    });

    try {
      const leaves = await walkLeaves(stagingDir);
      expect(leaves).toEqual(
        [
          'agents/mon-agent.md',
          'catalog.json',
          'contexts/mon-ctx/AGENTS.md',
          'guardrails/mon-guard/deny.json',
          'hooks/_shared/lib.ts',
          'hooks/guard.ts',
          'plugins/mon-plugin/index.ts',
          'skills/mon-skill/SKILL.md',
          'skills/mon-skill/helper.ts',
        ].sort(),
      );
    } finally {
      await cleanup();
    }
  });
});

describe('R2: materializeUnion — dedup of shared surfaces', () => {
  it('copies hooks/ once for two hook entries (no double-copy error)', async () => {
    const { baseDir, tmpParent } = await newCheckout();

    const { stagingDir, cleanup } = await materializeUnion({
      entries: [HOOK_A, HOOK_B],
      baseDir,
      tmpFactory: stagingIn(tmpParent),
    });

    try {
      const leaves = await walkLeaves(stagingDir);
      expect(leaves).toEqual(['catalog.json', 'hooks/_shared/lib.ts', 'hooks/guard.ts']);
    } finally {
      await cleanup();
    }
  });
});

describe('R2: materializeUnion — non-selected content is absent', () => {
  it('does not stage a skill dir that is present in baseDir but outside the selection', async () => {
    const { baseDir, tmpParent } = await newCheckout();

    const { stagingDir, cleanup } = await materializeUnion({
      entries: [SKILL],
      baseDir,
      tmpFactory: stagingIn(tmpParent),
    });

    try {
      const leaves = await walkLeaves(stagingDir);
      expect(leaves).not.toContain('skills/autre/SKILL.md');
      expect(leaves).toEqual([
        'catalog.json',
        'skills/mon-skill/SKILL.md',
        'skills/mon-skill/helper.ts',
      ].sort());
    } finally {
      await cleanup();
    }
  });
});

describe('R2: materializeUnion — symlink copied verbatim (dereference:false)', () => {
  it('mirrors a symlink inside a selected skill as a symlink, not its target content', async () => {
    const { baseDir, tmpParent } = await newCheckout();
    await fs.symlink('SKILL.md', path.join(baseDir, 'skills', 'mon-skill', 'link.md'));

    const { stagingDir, cleanup } = await materializeUnion({
      entries: [SKILL],
      baseDir,
      tmpFactory: stagingIn(tmpParent),
    });

    try {
      const stat = await fs.lstat(path.join(stagingDir, 'skills', 'mon-skill', 'link.md'));
      expect(stat.isSymbolicLink()).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

describe('R2: materializeUnion — staging root is never a symlink', () => {
  it('the default mkdtemp staging dir is a real directory, not a symlink (canary does not reach the pipeline)', async () => {
    // No tmpFactory: exercise the production default (fs.mkdtemp sibling of the
    // checkout). gitleaks 8.30.1 silently scans 0 bytes through a directly
    // symlinked source (frozen canary in core/real-binaries.test.ts); this
    // invariant proves that bypass can never apply to the real gate — the root
    // the scanner is pointed at is always a genuine directory.
    const { baseDir } = await newCheckout();

    const { stagingDir, cleanup } = await materializeUnion({ entries: [SKILL], baseDir });

    try {
      const stat = await fs.lstat(stagingDir);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.isDirectory()).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

describe('R2: materializeUnion — missing target fails closed', () => {
  it('throws when a selected skill has no directory, and tears down the partial staging', async () => {
    const { baseDir, tmpParent } = await newCheckout();
    const ghost: ArtifactEntry = { ...SKILL, id: 'skill:does-not-exist' };
    const { factory, created } = recordingStagingIn(tmpParent);

    await expect(
      materializeUnion({ entries: [ghost], baseDir, tmpFactory: factory }),
    ).rejects.toThrow();

    // catalog.json copies fine, then the ghost skill fails → staging was created
    // (catalog.json is a valid target) but the partial mirror is removed on throw.
    expect(created).toHaveLength(1);
    await expect(fs.stat(created[0]!)).rejects.toThrow();
  });
});

describe('R2: materializeUnion — anti-traversal guard', () => {
  it('throws before any staging is created when a forged id escapes the checkout (../ traversal)', async () => {
    const { baseDir, tmpParent } = await newCheckout();
    // localId strips up to the first '/', so the surviving name is '../../../evil'
    // → path.join(baseDir, 'skills', '../../../evil') lands above the checkout.
    const evil: ArtifactEntry = { ...SKILL, id: 'skill:x/../../../evil' };
    const { factory, created } = recordingStagingIn(tmpParent);

    await expect(
      materializeUnion({ entries: [evil], baseDir, tmpFactory: factory }),
    ).rejects.toThrow(/escapes the checkout/);

    // The guard fires during target resolution — before mkdtemp, before any fs.cp.
    expect(created).toHaveLength(0);
  });
});

describe('R2: materializeUnion — cleanup removes the staging idempotently', () => {
  it('removes the staging dir and a second cleanup does not throw', async () => {
    const { baseDir, tmpParent } = await newCheckout();

    const { stagingDir, cleanup } = await materializeUnion({
      entries: [SKILL],
      baseDir,
      tmpFactory: stagingIn(tmpParent),
    });

    await expect(fs.stat(stagingDir)).resolves.toBeDefined();
    await cleanup();
    await expect(fs.stat(stagingDir)).rejects.toThrow();
    await expect(cleanup()).resolves.toBeUndefined();
  });
});

describe('R2: materializeUnion — staging is a sibling of the checkout', () => {
  it('creates the default staging outside baseDir (never under it)', async () => {
    const { baseDir } = await newCheckout();

    // No tmpFactory → default mkdtemp sibling of the checkout.
    const { stagingDir, cleanup } = await materializeUnion({ entries: [SKILL], baseDir });

    try {
      expect(stagingDir.startsWith(baseDir)).toBe(false);
      expect(path.dirname(stagingDir)).toBe(path.dirname(baseDir));
    } finally {
      await cleanup();
    }
  });
});

describe('R2: materializeUnion — empty selection stages catalog.json alone', () => {
  it('stages only catalog.json when no entry is selected', async () => {
    const { baseDir, tmpParent } = await newCheckout();

    const { stagingDir, cleanup } = await materializeUnion({
      entries: [],
      baseDir,
      tmpFactory: stagingIn(tmpParent),
    });

    try {
      const leaves = await walkLeaves(stagingDir);
      expect(leaves).toEqual(['catalog.json']);
    } finally {
      await cleanup();
    }
  });
});
