/**
 * Tests for the doctor repair interpreter (core/doctor/repair.ts, T4).
 *
 * `applyRepairs` runs under the HELD run-lock, non-interactively, over the
 * subset the CLI's consent-driver already granted. It `switch`es on `op.kind`
 * and RE-VERIFIES at the moment of acting. These tests drive each kind with
 * real filesystem state (tmp dirs, real symlinks) and inject the deps seam
 * (id resolver, store-referent enumerator, clock), asserting the observable
 * result — the manifest, the disk, the `.bak` siblings, the outcome.
 *
 * Named scenarios (requirements.md):
 *   R5 — adoption nominale / context-dégradation / guardrail-item /
 *        requalification-ambiguë / divergent-jamais-adopté
 *   R4 — TOCTOU: référent apparu → refus
 * plus the acts of R3 (unlink-dangling), R4 (phantom removal), R7
 * (delete-residue / delete-bak), R8 (backup-state), the firstStateWrite
 * backup guard, and the break-lock routing guard.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { lstat, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Adapter, AdapterEntry, AdoptionResult } from '../src/adapter';
import {
  danglingUntracked,
  hygieneBak,
  hygieneResidue,
  lockCrashProbable,
  lockStaleDebris,
  manifestMalformed,
  phantomProbable,
  untrackedAdoptable,
} from '../src/doctor/finding';
import type { LockEvidence } from '../src/doctor/finding';
import { applyRepairs } from '../src/doctor/repair';
import type { AdoptionIdResolution, ApplyRepairsDeps } from '../src/doctor/repair';
import { readManifest, writeManifest } from '../src/manifest';
import type { Env } from '../src/paths';
import type { RunLock } from '../src/run-lock';
import type { ManifestEntry, NatureReport, RemovalOp, WriteOp } from '../src/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let dir: string;
let manifestPath: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'rigger-doctor-r5-repair-'));
  manifestPath = path.join(dir, 'state.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A held run-lock whose path matches `manifestPath` (proof-of-hold marker). */
function heldLock(lockManifestPath: string = manifestPath): RunLock {
  return {
    path: `${lockManifestPath}.lock`,
    async release(): Promise<void> {},
  };
}

/** Default deps; every field overridable per test. */
function makeDeps(overrides: Partial<ApplyRepairsDeps> = {}): ApplyRepairsDeps {
  const env: Env = { RIGGER_HOME: dir };
  return {
    env,
    manifestPath,
    resolveAdoptionId: async (): Promise<AdoptionIdResolution> => ({ kind: 'none' }),
    enumerateStoreReferents: async (): Promise<string[]> => [],
    ...overrides,
  };
}

/** Adapter whose `adopt` returns the supplied result (or refuses with undefined). */
function makeAdoptingAdapter(adoption: AdoptionResult | undefined): Adapter {
  return {
    id: 'claude',
    async audit(entry): Promise<NatureReport> {
      return { id: entry.id, nature: entry.nature, state: 'present' };
    },
    async plan(): Promise<WriteOp[]> {
      return [];
    },
    async apply(): Promise<void> {},
    async planRemove(): Promise<RemovalOp[]> {
      return [];
    },
    async applyRemove(): Promise<void> {},
    async adopt(_entry: AdapterEntry): Promise<AdoptionResult | undefined> {
      return adoption;
    },
  };
}

/** Adapter with no `adopt` and no state (only its shape matters for non-adopt ops). */
function inertAdapter(): Adapter {
  return {
    id: 'claude',
    async audit(entry): Promise<NatureReport> {
      return { id: entry.id, nature: entry.nature, state: 'missing' };
    },
    async plan(): Promise<WriteOp[]> {
      return [];
    },
    async apply(): Promise<void> {},
    async planRemove(): Promise<RemovalOp[]> {
      return [];
    },
    async applyRemove(): Promise<void> {},
  };
}

async function stateBakSiblings(): Promise<string[]> {
  const names = await readdir(dir);
  return names.filter((n) => n.startsWith('state.json.bak-'));
}

function lockEvidence(pid: number): LockEvidence {
  return { pid, startedAt: undefined, ageMs: 0, liveness: 'dead', identity: 'unknown' };
}

// ---------------------------------------------------------------------------
// R5 — adoption nominale
// ---------------------------------------------------------------------------

describe('doctor-R5: adoption nominale', () => {
  it('doctor-R5: unique id, upsert recorded, state.json backed up before the first write', async () => {
    // A pre-existing (amputated) manifest so backup() has bytes to preserve.
    const pre: ManifestEntry = {
      id: 'other/skill:bar',
      nature: 'skill',
      ref: 'v1.0.0',
      sha: 'deadbeef',
      scope: 'user',
      installedAt: new Date(0).toISOString(),
      files: [path.join(dir, 'bar')],
      assistant: 'claude',
    };
    await writeManifest(manifestPath, { version: 1, artifacts: [pre] });

    const fooPath = path.join(dir, 'skills', 'foo');
    const op = untrackedAdoptable({
      nature: 'skill',
      scope: 'user',
      assistant: 'claude',
      path: fooPath,
      candidateId: 'skill:foo',
    }).repair;

    const adapter = makeAdoptingAdapter({
      files: [fooPath],
      applied: { kind: 'link', files: [fooPath] },
    });
    const deps = makeDeps({
      resolveAdoptionId: async () => ({ kind: 'unique', id: 'mycat/skill:foo' }),
    });

    const outcomes = await applyRepairs([op], adapter, heldLock(), deps);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe('repaired');

    const manifest = await readManifest(manifestPath);
    const adopted = manifest.artifacts.find((e) => e.id === 'mycat/skill:foo');
    expect(adopted).toBeDefined();
    expect(adopted!.nature).toBe('skill');
    expect(adopted!.scope).toBe('user');
    expect(adopted!.assistant).toBe('claude');
    expect(adopted!.files).toEqual([fooPath]);
    // Defaults recorded (doctor knows no catalog version → R2 flags next run).
    expect(adopted!.ref).toBe('v0.0.0');
    expect(adopted!.sha).toBe('');
    // The pre-existing entry is preserved (upsert, not overwrite).
    expect(manifest.artifacts.find((e) => e.id === 'other/skill:bar')).toBeDefined();

    // Backup-first: exactly one state.json.bak-* created before the write.
    expect(await stateBakSiblings()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// R5 — context degradation
// ---------------------------------------------------------------------------

describe('doctor-R5: adoption context — dégradation affichée', () => {
  it('doctor-R5: context adoption surfaces the "no restore baseline" warning', async () => {
    const ctxPath = path.join(dir, '.claude', 'harness', 'AGENTS.md');
    const op = untrackedAdoptable({
      nature: 'context',
      scope: 'user',
      assistant: 'claude',
      path: ctxPath,
      candidateId: 'context:harness',
    }).repair;

    const adapter = makeAdoptingAdapter({
      files: [ctxPath],
      applied: { kind: 'context', block: 'hello' },
    });

    const outcomes = await applyRepairs([op], adapter, heldLock(), makeDeps());

    expect(outcomes[0]!.status).toBe('repaired');
    const outcome = outcomes[0]!;
    if (outcome.status !== 'repaired') throw new Error('unreachable');
    expect(outcome.detail).toContain('no restore baseline');
  });
});

// ---------------------------------------------------------------------------
// R5 — guardrail item-confirm (already consented → adopted)
// ---------------------------------------------------------------------------

describe('doctor-R5: adoption guardrail — consentement item déjà donné', () => {
  it('doctor-R5: a granted item-confirm guardrail op is adopted (applyRepairs never re-gates)', async () => {
    const op = untrackedAdoptable({
      nature: 'guardrail',
      scope: 'user',
      assistant: 'claude',
      path: path.join(dir, 'settings.json'),
      candidateId: 'guardrail:deny-net',
    }).repair;
    // The op is item-confirm by construction — its mere presence in `granted`
    // means the CLI already obtained the per-item confirmation.
    expect(op.consent).toBe('item-confirm');

    const adapter = makeAdoptingAdapter({
      files: [path.join(dir, 'settings.json')],
      applied: { kind: 'guardrail', denyRules: ['Net'], allowRules: [] },
    });

    const outcomes = await applyRepairs([op], adapter, heldLock(), makeDeps());

    expect(outcomes[0]!.status).toBe('repaired');
    const manifest = await readManifest(manifestPath);
    expect(manifest.artifacts.find((e) => e.id === 'guardrail:deny-net')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// R5 — requalification ambiguë
// ---------------------------------------------------------------------------

describe('doctor-R5: requalification ambiguë', () => {
  it('doctor-R5: an ambiguous id is skipped + reported, manifest untouched, no backup', async () => {
    const op = untrackedAdoptable({
      nature: 'skill',
      scope: 'user',
      assistant: 'claude',
      path: path.join(dir, 'skills', 'foo'),
      candidateId: 'skill:foo',
    }).repair;

    const adapter = makeAdoptingAdapter({ files: [] });
    const deps = makeDeps({ resolveAdoptionId: async () => ({ kind: 'ambiguous' }) });

    const outcomes = await applyRepairs([op], adapter, heldLock(), deps);

    expect(outcomes[0]!.status).toBe('skipped');
    const outcome = outcomes[0]!;
    if (outcome.status !== 'skipped') throw new Error('unreachable');
    expect(outcome.reason).toContain('more than one configured catalog');

    // No adoption, no manifest write, no state.json backup.
    expect(await readManifest(manifestPath)).toEqual({ version: 1, artifacts: [] });
    expect(await stateBakSiblings()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// R5 — divergent artifact never adopted (present-strict refusal)
// ---------------------------------------------------------------------------

describe('doctor-R5: divergent — jamais adopté (present-strict refuses at act time)', () => {
  it('doctor-R5: adapter.adopt returning undefined skips + reports, never records an entry', async () => {
    const op = untrackedAdoptable({
      nature: 'mcp',
      scope: 'user',
      assistant: 'claude',
      path: path.join(dir, 'mcp'),
      candidateId: 'mcp:ctx7',
    }).repair;

    // adopt returns undefined — the audit is no longer strictly `present`.
    const adapter = makeAdoptingAdapter(undefined);

    const outcomes = await applyRepairs([op], adapter, heldLock(), makeDeps());

    expect(outcomes[0]!.status).toBe('skipped');
    const outcome = outcomes[0]!;
    if (outcome.status !== 'skipped') throw new Error('unreachable');
    expect(outcome.reason).toContain('present-strict');
    expect(await readManifest(manifestPath)).toEqual({ version: 1, artifacts: [] });
  });
});

// ---------------------------------------------------------------------------
// R5 — firstStateWrite: exactly one backup across multiple adopt ops
// ---------------------------------------------------------------------------

describe('doctor-R5: firstStateWrite', () => {
  it('doctor-R5: state.json is backed up exactly once before the first of several adoptions', async () => {
    await writeManifest(manifestPath, { version: 1, artifacts: [] });

    const mkOp = (name: string) =>
      untrackedAdoptable({
        nature: 'skill',
        scope: 'user',
        assistant: 'claude',
        path: path.join(dir, 'skills', name),
        candidateId: `skill:${name}`,
      }).repair;

    const adapter = makeAdoptingAdapter({ files: [], applied: { kind: 'link', files: [] } });

    const outcomes = await applyRepairs([mkOp('a'), mkOp('b')], adapter, heldLock(), makeDeps());

    expect(outcomes.every((o) => o.status === 'repaired')).toBe(true);
    // Two mutations, ONE state.json.bak-* (firstStateWrite guard).
    expect(await stateBakSiblings()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// R4 — phantom removal + TOCTOU
// ---------------------------------------------------------------------------

describe('doctor-R4: phantom store removal', () => {
  it('doctor-R4: no referent → backupDir then remove', async () => {
    const store = path.join(dir, 'skills', 'ghost');
    await mkdir(store, { recursive: true });
    await writeFile(path.join(store, 'SKILL.md'), 'ghost');

    const op = phantomProbable({ store, candidates: [] }).repair;
    const outcomes = await applyRepairs([op], inertAdapter(), heldLock(), makeDeps());

    expect(outcomes[0]!.status).toBe('repaired');
    // Store gone, a .bak-* sibling copy preserved next to it.
    await expect(lstat(store)).rejects.toThrow();
    const siblings = await readdir(path.join(dir, 'skills'));
    expect(siblings.some((n) => n.startsWith('ghost.bak-'))).toBe(true);
  });

  it('doctor-R4: TOCTOU — a referent appeared between diagnosis and action → refused, store kept', async () => {
    const store = path.join(dir, 'skills', 'live');
    await mkdir(store, { recursive: true });
    await writeFile(path.join(store, 'SKILL.md'), 'live');

    // A real live symlink resolving to the store, enumerated fresh at act time.
    const linkPath = path.join(dir, 'link-to-live');
    await symlink(store, linkPath);

    const op = phantomProbable({ store, candidates: [] }).repair;
    const deps = makeDeps({ enumerateStoreReferents: async () => [linkPath] });

    const outcomes = await applyRepairs([op], inertAdapter(), heldLock(), deps);

    expect(outcomes[0]!.status).toBe('skipped');
    const outcome = outcomes[0]!;
    if (outcome.status !== 'skipped') throw new Error('unreachable');
    expect(outcome.reason).toContain('referent appeared');
    // The store survived the refusal.
    expect((await stat(store)).isDirectory()).toBe(true);
    // Low1 fix: a refused removal must NEVER leave an orphaned .bak-* next to
    // the still-live store (the re-check now runs BEFORE backupDir, not after).
    const siblings = await readdir(path.join(dir, 'skills'));
    expect(siblings.some((n) => n.startsWith('live.bak-'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R3 — unlink-dangling micro-re-check
// ---------------------------------------------------------------------------

describe('doctor-R3: unlink-dangling', () => {
  it('doctor-R3: still dangling → the bare symlink is removed', async () => {
    const linkPath = path.join(dir, 'dead-link');
    await symlink(path.join(dir, 'vanished'), linkPath);

    const op = danglingUntracked({ path: linkPath, readlink: path.join(dir, 'vanished') }).repair;
    const outcomes = await applyRepairs([op], inertAdapter(), heldLock(), makeDeps());

    expect(outcomes[0]!.status).toBe('repaired');
    await expect(lstat(linkPath)).rejects.toThrow();
  });

  it('doctor-R3: TOCTOU — the symlink now resolves → refused, left in place', async () => {
    const realTarget = path.join(dir, 'now-here');
    await writeFile(realTarget, 'content');
    const linkPath = path.join(dir, 'revived-link');
    await symlink(realTarget, linkPath);

    const op = danglingUntracked({ path: linkPath, readlink: realTarget }).repair;
    const outcomes = await applyRepairs([op], inertAdapter(), heldLock(), makeDeps());

    expect(outcomes[0]!.status).toBe('skipped');
    const outcome = outcomes[0]!;
    if (outcome.status !== 'skipped') throw new Error('unreachable');
    expect(outcome.reason).toContain('no longer dangling');
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R7 — delete-residue micro-re-check (pattern + age) and .stale bypass
// ---------------------------------------------------------------------------

describe('doctor-R7: delete-residue', () => {
  it('doctor-R7: an aged .tmp residue past the threshold is deleted', async () => {
    const residue = path.join(dir, 'settings.json.tmp-0011aabb');
    await writeFile(residue, 'staging');

    const op = hygieneResidue({ path: residue, ageMs: 999 }).repair;
    // now far in the future → age > threshold.
    const deps = makeDeps({ now: () => Date.now() + 100 * 24 * 60 * 60 * 1000 });

    const outcomes = await applyRepairs([op], inertAdapter(), heldLock(), deps);

    expect(outcomes[0]!.status).toBe('repaired');
    await expect(lstat(residue)).rejects.toThrow();
  });

  it('doctor-R7: TOCTOU — a .tmp residue now younger than the threshold is refused', async () => {
    const residue = path.join(dir, 'settings.json.tmp-0011aabb');
    await writeFile(residue, 'fresh staging of an in-flight write');

    const op = hygieneResidue({ path: residue, ageMs: 999 }).repair;
    // now == real time → age ~0 < threshold.
    const deps = makeDeps({ now: () => Date.now(), maxAgeMs: 24 * 60 * 60 * 1000 });

    const outcomes = await applyRepairs([op], inertAdapter(), heldLock(), deps);

    expect(outcomes[0]!.status).toBe('skipped');
    // The possibly in-flight residue is untouched.
    expect((await lstat(residue)).isFile()).toBe(true);
  });

  it('doctor-R7: .stale lock-break debris carries no age gate — deleted even when fresh', async () => {
    const debris = path.join(dir, 'state.json.lock.stale-1234-aabbccdd');
    await writeFile(debris, '{}');

    const op = lockStaleDebris({ path: debris }).repair;
    // now == real time (fresh), yet .stale is never re-read by construction.
    const deps = makeDeps({ now: () => Date.now() });

    const outcomes = await applyRepairs([op], inertAdapter(), heldLock(), deps);

    expect(outcomes[0]!.status).toBe('repaired');
    await expect(lstat(debris)).rejects.toThrow();
  });

  it('doctor-R7: a path that no longer matches a residue pattern is refused', async () => {
    const notResidue = path.join(dir, 'important.txt');
    await writeFile(notResidue, 'user data');

    // Hand-craft a delete-residue op pointing at a non-residue name.
    const op = { kind: 'delete-residue' as const, consent: 'safe' as const, path: notResidue };
    const outcomes = await applyRepairs([op], inertAdapter(), heldLock(), makeDeps());

    expect(outcomes[0]!.status).toBe('skipped');
    expect((await lstat(notResidue)).isFile()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R7 — delete-bak
// ---------------------------------------------------------------------------

describe('doctor-R7: delete-bak', () => {
  it('doctor-R7: an aged .bak past retention is deleted (already item-confirmed)', async () => {
    const bak = path.join(dir, 'settings.json.bak-2026-07-11T10-00-00.000Z-aabbccdd');
    await writeFile(bak, 'old backup');

    const op = hygieneBak({ path: bak, ageMs: 999 }).repair;
    const outcomes = await applyRepairs([op], inertAdapter(), heldLock(), makeDeps());

    expect(outcomes[0]!.status).toBe('repaired');
    await expect(lstat(bak)).rejects.toThrow();
  });

  it('doctor-R7: a delete-bak op whose path is no longer a .bak sibling is refused', async () => {
    const notBak = path.join(dir, 'settings.json');
    await writeFile(notBak, '{}');

    const op = { kind: 'delete-bak' as const, consent: 'item-confirm' as const, path: notBak };
    const outcomes = await applyRepairs([op], inertAdapter(), heldLock(), makeDeps());

    expect(outcomes[0]!.status).toBe('skipped');
    expect((await lstat(notBak)).isFile()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R8 — backup-state salvage
// ---------------------------------------------------------------------------

describe('doctor-R8: backup-state salvage', () => {
  it('doctor-R8: a malformed state.json is byte-copied to a .bak, original untouched', async () => {
    await writeFile(manifestPath, 'this is not valid manifest json {{{');

    const op = manifestMalformed({ reason: 'not an object', path: manifestPath }).repair;
    const outcomes = await applyRepairs([op], inertAdapter(), heldLock(), makeDeps());

    expect(outcomes[0]!.status).toBe('repaired');
    expect(await stateBakSiblings()).toHaveLength(1);
    // Original left in place for the human to inspect (never deleted).
    expect((await lstat(manifestPath)).isFile()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// break-lock routing guard
// ---------------------------------------------------------------------------

describe('doctor-R6: break-lock is never executed by applyRepairs', () => {
  it('doctor-R6: a break-lock op reaching the interpreter is skipped (handled pre-acquire)', async () => {
    const op = lockCrashProbable({
      lockPath: `${manifestPath}.lock`,
      evidence: lockEvidence(4242),
    }).repair;

    const outcomes = await applyRepairs([op], inertAdapter(), heldLock(), makeDeps());

    expect(outcomes[0]!.status).toBe('skipped');
    const outcome = outcomes[0]!;
    if (outcome.status !== 'skipped') throw new Error('unreachable');
    expect(outcome.reason).toContain('pre-acquire');
  });
});

// ---------------------------------------------------------------------------
// Held-lock invariant
// ---------------------------------------------------------------------------

describe('doctor: held-lock invariant', () => {
  it("applyRepairs throws when the held lock is not this manifest's lock", async () => {
    const op = manifestMalformed({ reason: 'x', path: manifestPath }).repair;
    const wrongLock: RunLock = {
      path: '/some/other/state.json.lock',
      async release(): Promise<void> {},
    };

    await expect(applyRepairs([op], inertAdapter(), wrongLock, makeDeps())).rejects.toThrow(
      'wrong run-lock',
    );
  });
});
