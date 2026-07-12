/**
 * b1b4-r3-pack-status.test.ts — R3: pack status is synthesized from its
 * installable members (finding B3).
 *
 * `computeArtifactStatuses` used to let every pack fall through to 'install'
 * (packs are never manifest-tracked), so a fully-installed pack was reported as
 * "To install" forever and the "everything up-to-date" short-circuit was
 * unreachable for any catalog carrying a pack. R3 derives a pack's status from
 * its members: install if any installable member is 'install'; else update if
 * any is 'update'; else current. Tool members are excluded from the aggregate
 * (they are never manifest-tracked — install is M5), so an all-tool pack keeps
 * the historical 'install' fall-through.
 *
 * One test per scenario in requirements.md (R3), named `b1b4-R3: …` (stock §8
 * traceability). The observed status is captured through an injected picker
 * that records the argument of selectArtifactsByStatus (pattern:
 * status-aware-picker.test.ts / lot6-r2-update-sha.test.ts makePrompts). The
 * "everything up-to-date" scenario is the real user-facing symptom of B3 and is
 * driven end-to-end (the picker must NOT be called).
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

import type { CliPrompts } from '../src/cli';
import { runCli } from '../src/cli';
import type { StatusedEntry } from '../src/ui';
import { pinStdinIsTTY, pinStdoutIsTTY } from './fixtures/tty';

// Injected prompts drive every scenario, so TTY is irrelevant to the flow;
// pin both streams non-TTY per the file-level convention.
pinStdoutIsTTY(false);
pinStdinIsTTY(false);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TAG = 'v1.0.0';
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
/** A distinct, older commit for the "installed at an older ref → update" case. */
const OLD_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function skill(local: string): CatalogEntry {
  return {
    kind: 'artifact',
    id: `skill:${local}`,
    nature: 'skill',
    targets: ['claude'],
    scopes: ['user', 'project'],
  };
}

function tool(local: string): CatalogEntry {
  return {
    kind: 'artifact',
    id: `tool:${local}`,
    nature: 'tool',
    targets: ['claude'],
    scopes: ['user'],
    check: `${local} --version`,
  };
}

function pack(local: string, members: string[]): CatalogEntry {
  // Packs share CommonFieldsSchema with artifacts — targets/scopes are required
  // (schema.ts), or the whole catalog fails to parse and the source degrades.
  return {
    kind: 'pack',
    id: `pack:${local}`,
    members,
    targets: ['claude'],
    scopes: ['user', 'project'],
  };
}

function makeCapture(): { lines: string[]; print: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

/**
 * Prompts with a capturing status picker. `captured.called` records whether the
 * picker was reached (false ⇒ the all-current short-circuit fired). The picker
 * returns [] — the tests inspect classification, not the install that would
 * follow.
 */
function makePrompts(captured: {
  value: StatusedEntry[] | null;
  called: boolean;
}): CliPrompts {
  return {
    selectArtifacts: async () => [],
    selectArtifactsByStatus: async (entries) => {
      captured.value = entries;
      captured.called = true;
      return [];
    },
    selectScope: async () => 'user',
    confirmApply: async () => true,
    askUrl: async () => '',
    askMethod: async () => 'https',
  };
}

interface Iso {
  env: Env;
  targets: ReturnType<typeof resolveUserTargets>;
  makeRunner: () => CommandRunner;
  makeTmpFactory: () => TmpDirFactory;
  seedManifest: (
    artifacts: Array<{ id: string; ref: string; sha?: string; nature?: string }>,
  ) => Promise<void>;
  cleanup: () => Promise<void>;
}

/**
 * Isolated env with one catalog ('principal') whose checkout carries `entries`.
 * Skill entries get a content dir so a real install/checkout would succeed; the
 * status picker only needs the catalog.json to classify.
 */
async function makeIso(entries: CatalogEntry[]): Promise<Iso> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-b1b4-r3-home-'));
  const configDir = path.join(homeDir, '.config', 'agent-rigger');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify({ catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }] }),
    'utf8',
  );

  const env: Env = { RIGGER_HOME: homeDir };
  const targets = resolveUserTargets(env);
  const tmpDirs: string[] = [];

  const makeRunner = (): CommandRunner => (_cmd, args) => {
    const argv = args ?? [];
    if (argv[0] === 'ls-remote' && argv.includes('--tags')) {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\trefs/tags/${TAG}\n`, stderr: '' });
    }
    if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\tHEAD\n`, stderr: '' });
    }
    if (argv[0] === 'clone') {
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }
    if (argv[0] === '-C' && argv[2] === 'rev-parse') {
      return Promise.resolve({ exitCode: 0, stdout: `${SHA}\n`, stderr: '' });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };

  const makeTmpFactory = (): TmpDirFactory => async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-b1b4-r3-checkout-'));
    tmpDirs.push(tmpDir);
    await fs.writeFile(
      path.join(tmpDir, 'catalog.json'),
      JSON.stringify({ meta: { name: 'r3-catalog' }, entries }),
      'utf8',
    );
    for (const e of entries) {
      if (e.kind === 'artifact' && e.nature === 'skill') {
        const localName = e.id.replace(/^skill:/, '');
        await fs.mkdir(path.join(tmpDir, 'skills', localName), { recursive: true });
        await fs.writeFile(
          path.join(tmpDir, 'skills', localName, 'SKILL.md'),
          `# Skill ${localName}\n${TAG}@${SHA} content.`,
          'utf8',
        );
      }
    }
    return {
      path: tmpDir,
      cleanup: async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
      },
    };
  };

  const seedManifest: Iso['seedManifest'] = async (artifacts) => {
    await fs.writeFile(
      targets.stateJson,
      JSON.stringify({
        version: 1,
        artifacts: artifacts.map((a) => ({
          id: a.id,
          nature: a.nature ?? 'skill',
          ref: a.ref,
          sha: a.sha ?? SHA,
          scope: 'user',
        })),
      }),
      'utf8',
    );
  };

  const cleanup = async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  };

  return { env, targets, makeRunner, makeTmpFactory, seedManifest, cleanup };
}

/** Find the captured status of a qualified id. */
function statusOf(
  captured: { value: StatusedEntry[] | null },
  id: string,
): StatusedEntry | undefined {
  return captured.value?.find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// Scenario 1: pack entièrement installé → "Up to date"
// ---------------------------------------------------------------------------

describe('b1b4-R3: pack entièrement installé', () => {
  it('b1b4-R3: tous les membres installés à jour → pack "current" (Up to date, pas To install)', async () => {
    // pack:demo fully current + one uninstalled skill so the picker still opens.
    const iso = await makeIso([
      skill('member-a'),
      skill('member-b'),
      skill('extra'),
      pack('demo', ['skill:member-a', 'skill:member-b']),
    ]);
    await iso.seedManifest([
      { id: 'principal/skill:member-a', ref: TAG },
      { id: 'principal/skill:member-b', ref: TAG },
    ]);
    const captured = { value: null as StatusedEntry[] | null, called: false };

    try {
      await runCli(['install'], {
        print: () => {},
        env: iso.env,
        prompts: makePrompts(captured),
        remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
      });

      expect(captured.called).toBe(true);
      expect(statusOf(captured, 'principal/pack:demo')?.status).toBe('current');
    } finally {
      await iso.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: l'état "tout à jour" devient atteignable (LE symptôme B3)
// ---------------------------------------------------------------------------

describe('b1b4-R3: raccourci "Everything already up-to-date" atteignable', () => {
  it('b1b4-R3: skills + packs (aucun tool) tout installé à jour → raccourci, exit 0, aucun picker', async () => {
    const iso = await makeIso([
      skill('member-a'),
      skill('member-b'),
      pack('demo', ['skill:member-a', 'skill:member-b']),
    ]);
    await iso.seedManifest([
      { id: 'principal/skill:member-a', ref: TAG },
      { id: 'principal/skill:member-b', ref: TAG },
    ]);
    const captured = { value: null as StatusedEntry[] | null, called: false };
    const cap = makeCapture();

    try {
      const code = await runCli(['install'], {
        print: cap.print,
        env: iso.env,
        prompts: makePrompts(captured),
        remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
      });

      expect(code).toBe(0);
      // The pack synthesized to 'current', so nothing is actionable → the
      // short-circuit fires and the picker is never called (the B3 symptom).
      expect(captured.called).toBe(false);
      expect(cap.lines.join('\n')).toMatch(/up-to-date/i);
    } finally {
      await iso.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: membre manquant → pack à installer
// ---------------------------------------------------------------------------

describe('b1b4-R3: membre manquant', () => {
  it('b1b4-R3: un membre non installé (les autres installés) → pack "install"', async () => {
    const iso = await makeIso([
      skill('member-a'),
      skill('member-b'),
      pack('demo', ['skill:member-a', 'skill:member-b']),
    ]);
    // member-a installed, member-b missing.
    await iso.seedManifest([{ id: 'principal/skill:member-a', ref: TAG }]);
    const captured = { value: null as StatusedEntry[] | null, called: false };

    try {
      await runCli(['install'], {
        print: () => {},
        env: iso.env,
        prompts: makePrompts(captured),
        remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
      });

      expect(captured.called).toBe(true);
      expect(statusOf(captured, 'principal/pack:demo')?.status).toBe('install');
    } finally {
      await iso.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: membre obsolète → pack à mettre à jour
// ---------------------------------------------------------------------------

describe('b1b4-R3: membre obsolète', () => {
  it('b1b4-R3: tous installés, un à un ref distant plus récent → pack "update"', async () => {
    const iso = await makeIso([
      skill('member-a'),
      skill('member-b'),
      pack('demo', ['skill:member-a', 'skill:member-b']),
    ]);
    // member-a current, member-b installed at an OLDER sha → update.
    await iso.seedManifest([
      { id: 'principal/skill:member-a', ref: TAG },
      { id: 'principal/skill:member-b', ref: 'v0.9.0', sha: OLD_SHA },
    ]);
    const captured = { value: null as StatusedEntry[] | null, called: false };

    try {
      await runCli(['install'], {
        print: () => {},
        env: iso.env,
        prompts: makePrompts(captured),
        remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
      });

      expect(captured.called).toBe(true);
      expect(statusOf(captured, 'principal/pack:demo')?.status).toBe('update');
    } finally {
      await iso.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: dégradation gracieuse quand la version distante est irrésolue
// ---------------------------------------------------------------------------

describe('b1b4-R3: version distante irrésolue', () => {
  it('b1b4-R3: résolution de version en échec → membres "current", pack suit sans erreur', async () => {
    const iso = await makeIso([
      skill('member-a'),
      skill('member-b'),
      skill('extra'),
      pack('demo', ['skill:member-a', 'skill:member-b']),
    ]);
    await iso.seedManifest([
      { id: 'principal/skill:member-a', ref: TAG },
      { id: 'principal/skill:member-b', ref: TAG },
    ]);
    const captured = { value: null as StatusedEntry[] | null, called: false };

    // Transient network model: the catalog fetch (first ls-remote --tags)
    // succeeds so the effective catalog loads, but the LATER version
    // resolution in computeArtifactStatuses fails — no tags AND HEAD errors —
    // so resolveVersion throws and the catalog degrades to remote=null. This
    // is the only way remote is null for a catalog that still has entries,
    // since fetchRemoteCatalog and computeArtifactStatuses share resolveVersion
    // (remote.ts). [flagged to lead: fetch/status version-resolution coupling]
    const makeFlakyRunner = (): CommandRunner => {
      let tagsCalls = 0;
      return (_cmd, args) => {
        const argv = args ?? [];
        if (argv[0] === 'ls-remote' && argv.includes('--tags')) {
          tagsCalls++;
          if (tagsCalls === 1) {
            return Promise.resolve({
              exitCode: 0,
              stdout: `${SHA}\trefs/tags/${TAG}\n`,
              stderr: '',
            });
          }
          return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }); // no tags → HEAD fallback
        }
        if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
          return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'network down' }); // → throws
        }
        if (argv[0] === 'clone') {
          return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        }
        if (argv[0] === '-C' && argv[2] === 'rev-parse') {
          return Promise.resolve({ exitCode: 0, stdout: `${SHA}\n`, stderr: '' });
        }
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      };
    };

    try {
      const code = await runCli(['install'], {
        print: () => {},
        env: iso.env,
        prompts: makePrompts(captured),
        remote: { run: makeFlakyRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
      });

      // No crash; picker opened (the uninstalled 'extra' skill is actionable).
      expect(code).toBe(0);
      expect(captured.called).toBe(true);
      // Installed members degraded to 'current' (remote null) → pack 'current'.
      expect(statusOf(captured, 'principal/skill:member-a')?.status).toBe('current');
      expect(statusOf(captured, 'principal/pack:demo')?.status).toBe('current');
    } finally {
      await iso.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: limitation tools documentée, pas corrigée
// ---------------------------------------------------------------------------

describe('b1b4-R3: limitation tools documentée', () => {
  it('b1b4-R3: catalogue avec un tool, le reste à jour → picker s\'ouvre, tool "install"', async () => {
    const iso = await makeIso([skill('member-a'), tool('marker')]);
    await iso.seedManifest([{ id: 'principal/skill:member-a', ref: TAG }]);
    const captured = { value: null as StatusedEntry[] | null, called: false };

    try {
      await runCli(['install'], {
        print: () => {},
        env: iso.env,
        prompts: makePrompts(captured),
        remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
      });

      // The tool is never manifest-tracked (install = M5) → always 'install',
      // so the picker still opens: accepted limitation, unchanged by R3.
      expect(captured.called).toBe(true);
      expect(statusOf(captured, 'principal/tool:marker')?.status).toBe('install');
    } finally {
      await iso.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: pack tout-tools → install (fall-through conservé)
// ---------------------------------------------------------------------------

describe('b1b4-R3: pack tout-tools', () => {
  it('b1b4-R3: pack dont tous les membres sont des tools → "install" (fall-through)', async () => {
    const iso = await makeIso([
      tool('marker-a'),
      tool('marker-b'),
      pack('tools', ['tool:marker-a', 'tool:marker-b']),
    ]);
    // Nothing installed; tools are never trackable anyway.
    await iso.seedManifest([]);
    const captured = { value: null as StatusedEntry[] | null, called: false };

    try {
      await runCli(['install'], {
        print: () => {},
        env: iso.env,
        prompts: makePrompts(captured),
        remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
      });

      expect(captured.called).toBe(true);
      // No installable member → aggregate is empty → historical 'install'
      // fall-through (nothing trackable could ever make it 'current').
      expect(statusOf(captured, 'principal/pack:tools')?.status).toBe('install');
    } finally {
      await iso.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 8: nested pack — the parent reflects the member pack (recursion)
// ---------------------------------------------------------------------------

describe('b1b4-R3: pack imbriqué', () => {
  it('b1b4-R3: pack imbriqué — le statut du parent reflète le pack membre', async () => {
    // pack:outer = [pack:inner, skill:a]; pack:inner = [skill:b]. A standalone
    // uninstalled 'extra' skill keeps the picker open in both phases (so the
    // pack status is observable even when everything is current).
    const iso = await makeIso([
      skill('a'),
      skill('b'),
      skill('extra'),
      pack('inner', ['skill:b']),
      pack('outer', ['pack:inner', 'skill:a']),
    ]);
    const captured = { value: null as StatusedEntry[] | null, called: false };

    try {
      // Phase 1: all installed & current → outer 'current' (reflects inner).
      await iso.seedManifest([
        { id: 'principal/skill:a', ref: TAG },
        { id: 'principal/skill:b', ref: TAG },
      ]);
      await runCli(['install'], {
        print: () => {},
        env: iso.env,
        prompts: makePrompts(captured),
        remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
      });
      expect(captured.called).toBe(true);
      expect(statusOf(captured, 'principal/pack:outer')?.status).toBe('current');

      // Phase 2: inner's member (skill:b) goes stale → outer 'update'. The
      // discriminating case: without recursion the parent only sees skill:a
      // (current) and misses the nested drift.
      await iso.seedManifest([
        { id: 'principal/skill:a', ref: TAG },
        { id: 'principal/skill:b', ref: 'v0.9.0', sha: OLD_SHA },
      ]);
      const captured2 = { value: null as StatusedEntry[] | null, called: false };
      await runCli(['install'], {
        print: () => {},
        env: iso.env,
        prompts: makePrompts(captured2),
        remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
      });
      expect(captured2.called).toBe(true);
      expect(statusOf(captured2, 'principal/pack:inner')?.status).toBe('update');
      expect(statusOf(captured2, 'principal/pack:outer')?.status).toBe('update');
    } finally {
      await iso.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 9: pack cycle — no infinite loop, stable statuses (cycle guard)
// ---------------------------------------------------------------------------

describe('b1b4-R3: cycle de packs', () => {
  it('b1b4-R3: cycle de packs — pas de boucle infinie, statuts stables', async () => {
    // pack:a ↔ pack:b reference each other; each also carries an installed
    // skill. The cycle guard must cut the back-edge so synthesis terminates,
    // deriving each pack's status from its (non-cyclic) artifact member.
    const iso = await makeIso([
      skill('sa'),
      skill('sb'),
      skill('extra'),
      pack('a', ['pack:b', 'skill:sa']),
      pack('b', ['pack:a', 'skill:sb']),
    ]);
    await iso.seedManifest([
      { id: 'principal/skill:sa', ref: TAG },
      { id: 'principal/skill:sb', ref: TAG },
    ]);
    const captured = { value: null as StatusedEntry[] | null, called: false };

    try {
      const code = await runCli(['install'], {
        print: () => {},
        env: iso.env,
        prompts: makePrompts(captured),
        remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
      });

      // Terminated (no hang / no stack overflow) and reached the picker.
      expect(code).toBe(0);
      expect(captured.called).toBe(true);
      // Both packs derive 'current' from their installed artifact members; the
      // cyclic pack member contributes nothing (guarded).
      expect(statusOf(captured, 'principal/pack:a')?.status).toBe('current');
      expect(statusOf(captured, 'principal/pack:b')?.status).toBe('current');
    } finally {
      await iso.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 10: tool member excluded from the aggregate (discriminating)
// ---------------------------------------------------------------------------

describe("b1b4-R3: membre tool exclu de l'agrégat", () => {
  it('b1b4-R3: pack [skill current, tool non installé] → current (tool exclu)', async () => {
    // pack:mixed = [skill:a (installed current), tool:marker (never tracked)].
    // The tool is 'install' in pass 1 (tools always fall through) and IS
    // actionable, so the picker opens. The discriminating assertion: pack:mixed
    // is 'current' because the tool is excluded from its aggregate — if tools
    // counted, the tool's 'install' would drag the pack to 'install'.
    const iso = await makeIso([
      skill('a'),
      tool('marker'),
      pack('mixed', ['skill:a', 'tool:marker']),
    ]);
    await iso.seedManifest([{ id: 'principal/skill:a', ref: TAG }]);
    const captured = { value: null as StatusedEntry[] | null, called: false };

    try {
      await runCli(['install'], {
        print: () => {},
        env: iso.env,
        prompts: makePrompts(captured),
        remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
      });

      expect(captured.called).toBe(true);
      // Load-bearing: removing the `nature !== 'tool'` filter makes this 'install'.
      expect(statusOf(captured, 'principal/pack:mixed')?.status).toBe('current');
      // Sanity: the tool itself is still listed 'install' (M5 limitation).
      expect(statusOf(captured, 'principal/tool:marker')?.status).toBe('install');
    } finally {
      await iso.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 11: diamond — shared sub-pack, coherent statuses (memoization lock)
// ---------------------------------------------------------------------------

describe('b1b4-R3: diamant', () => {
  it('b1b4-R3: diamant — pack:x et pack:y partagent pack:shared → statuts cohérents', async () => {
    // pack:x = [pack:shared, skill:a]; pack:y = [pack:shared, skill:b];
    // pack:shared = [skill:s]. A standalone uninstalled 'extra' keeps the
    // picker open in the all-current phase. Both parents must derive the SAME
    // status from the shared sub-pack (no divergent recompute).
    const iso = await makeIso([
      skill('a'),
      skill('b'),
      skill('s'),
      skill('extra'),
      pack('shared', ['skill:s']),
      pack('x', ['pack:shared', 'skill:a']),
      pack('y', ['pack:shared', 'skill:b']),
    ]);
    const captured = { value: null as StatusedEntry[] | null, called: false };

    try {
      // Phase 1: everything current → x, y, shared all current.
      await iso.seedManifest([
        { id: 'principal/skill:a', ref: TAG },
        { id: 'principal/skill:b', ref: TAG },
        { id: 'principal/skill:s', ref: TAG },
      ]);
      await runCli(['install'], {
        print: () => {},
        env: iso.env,
        prompts: makePrompts(captured),
        remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
      });
      expect(captured.called).toBe(true);
      expect(statusOf(captured, 'principal/pack:shared')?.status).toBe('current');
      expect(statusOf(captured, 'principal/pack:x')?.status).toBe('current');
      expect(statusOf(captured, 'principal/pack:y')?.status).toBe('current');

      // Phase 2: the shared sub-pack's member goes stale → shared, x AND y all
      // update (coherent — the shared status reaches both parents identically).
      await iso.seedManifest([
        { id: 'principal/skill:a', ref: TAG },
        { id: 'principal/skill:b', ref: TAG },
        { id: 'principal/skill:s', ref: 'v0.9.0', sha: OLD_SHA },
      ]);
      const captured2 = { value: null as StatusedEntry[] | null, called: false };
      await runCli(['install'], {
        print: () => {},
        env: iso.env,
        prompts: makePrompts(captured2),
        remote: { run: iso.makeRunner(), tmpFactory: iso.makeTmpFactory(), scanner: stubScanner },
      });
      expect(captured2.called).toBe(true);
      expect(statusOf(captured2, 'principal/pack:shared')?.status).toBe('update');
      expect(statusOf(captured2, 'principal/pack:x')?.status).toBe('update');
      expect(statusOf(captured2, 'principal/pack:y')?.status).toBe('update');
    } finally {
      await iso.cleanup();
    }
  });
});
