/**
 * Tests for the doctor model — core/doctor/finding.ts (T1, ADR-0025).
 *
 * This is the MODEL layer: no scanner, no diagnose(), no applyRepairs() exist
 * yet (T2–T4). What is tested here is the type-level and constructor-level
 * contract T1 promises the rest of the change:
 *
 *   - `Finding` discriminates cleanly by `class` (exhaustive switch).
 *   - A report-only finding has NO `repair` property (structural, not `undefined`).
 *   - `RepairOp` consent is GRAVED per variant: destructive kinds
 *     (remove-store / break-lock / delete-bak / unlink-dangling / adopt-guardrail)
 *     are `'item-confirm'` at the type level — a value with `consent: 'safe'`
 *     for these kinds does not typecheck (`@ts-expect-error`, enforced by the
 *     `bunx tsc --noEmit` gate, not just at runtime).
 *   - R5's load-bearing divergence: two `untracked` findings (skill vs
 *     guardrail adoption) get different consent from the SAME constructor,
 *     proving the class alone cannot answer the consent question.
 *
 * Test names are tagged `doctor-R<n>:` per the change's convention, even
 * though every test here exercises the MODEL rather than a scanner's
 * behaviour — the scanner-level doctor-r<n>-*.test.ts files land in T2/T3.
 */

import { describe, expect, it } from 'bun:test';

import { assertNever } from '../src/assert-never';
import {
  danglingTracked,
  danglingUntracked,
  type Finding,
  hygieneBak,
  hygieneResidue,
  isReportOnly,
  lockCrashProbable,
  lockPidRecycledProbable,
  lockRefused,
  lockStaleDebris,
  manifestMalformed,
  manifestMissingSha,
  manifestOrphanCatalog,
  phantomProbable,
  type RepairOpAdoptGuardrail,
  type RepairOpAdoptSafe,
  type RepairOpBreakLock,
  type RepairOpDeleteBak,
  type RepairOpDeleteResidue,
  type RepairOpRemoveStore,
  type RepairOpUnlinkDangling,
  untrackedAdoptable,
  untrackedDrift,
  untrackedHostDiff,
} from '../src/doctor/finding';

// ---------------------------------------------------------------------------
// R5 — adoption consent diverges within the SAME `untracked` class
// ---------------------------------------------------------------------------

describe('doctor-R5: adoption consent is graved per act, not per class', () => {
  it('doctor-R5: adopting a skill is safe — a state.json-only mutation, reversible by remove', () => {
    const finding = untrackedAdoptable({
      nature: 'skill',
      scope: 'user',
      assistant: 'claude',
      path: '/home/u/.claude/skills/foo',
      candidateId: 'jr/skill:foo',
    });
    expect(finding.class).toBe('untracked');
    expect(finding.verdict).toBe('adoptable');
    expect(finding.repair.consent).toBe('safe');
  });

  it('doctor-R5: adopting a guardrail requires item confirmation — same class, different consent', () => {
    const finding = untrackedAdoptable({
      nature: 'guardrail',
      scope: 'user',
      assistant: 'claude',
      path: '/home/u/.claude/settings.json',
      candidateId: 'jr/guardrail:bash-safety',
    });
    expect(finding.class).toBe('untracked');
    expect(finding.verdict).toBe('adoptable');
    expect(finding.repair.consent).toBe('item-confirm');
  });

  it('doctor-R5: adoption repair defaults files to [path] when not overridden', () => {
    const finding = untrackedAdoptable({
      nature: 'agent',
      scope: 'project',
      assistant: 'opencode',
      path: '/repo/.opencode/agents/bar',
      candidateId: 'jr/agent:bar',
    });
    expect(finding.repair.files).toEqual(['/repo/.opencode/agents/bar']);
  });
});

// ---------------------------------------------------------------------------
// R1 — untracked: adoptable vs drift vs host-diff
// ---------------------------------------------------------------------------

describe('doctor-R1: untracked findings — adoptable is actionable, drift and host-diff are not', () => {
  it('doctor-R1: a drift finding has NO repair field (report-only by construction)', () => {
    const finding = untrackedDrift({
      nature: 'skill',
      scope: 'user',
      assistant: 'claude',
      path: '/home/u/.claude/skills/foo',
    });
    expect('repair' in finding).toBe(false);
    expect(isReportOnly(finding)).toBe(true);
  });

  it('doctor-R1: a host-diff finding has NO repair field (offline-invisible nature)', () => {
    const finding = untrackedHostDiff({
      nature: 'mcp',
      scope: 'user',
      assistant: 'claude',
      detail: 'mcp server "x" declared at host, diverges from canon',
    });
    expect('repair' in finding).toBe(false);
    expect(isReportOnly(finding)).toBe(true);
  });

  it('doctor-R1: an adoptable finding DOES carry a repair (actionable)', () => {
    const finding = untrackedAdoptable({
      nature: 'context',
      scope: 'user',
      assistant: 'claude',
      path: '/home/u/.claude/harness/AGENTS.md',
      candidateId: 'jr/context:base',
    });
    expect('repair' in finding).toBe(true);
    expect(isReportOnly(finding)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R2 — manifest: always report-only (rapportées, jamais réparées)
// ---------------------------------------------------------------------------

describe('doctor-R2: manifest findings are always report-only', () => {
  it('doctor-R2: an orphan-catalog finding has no repair', () => {
    const finding = manifestOrphanCatalog({
      entryId: 'gone/skill:x',
      nature: 'skill',
      scope: 'user',
    });
    expect('repair' in finding).toBe(false);
  });

  it('doctor-R2: a missing-sha finding has no repair', () => {
    const finding = manifestMissingSha({ entryId: 'jr/skill:foo', nature: 'skill', scope: 'user' });
    expect('repair' in finding).toBe(false);
  });

  it('doctor-R2 (R8 salvage): a malformed-manifest finding carries a safe backup-state repair', () => {
    const finding = manifestMalformed({
      reason: 'artifacts is not an array',
      path: '/home/u/.config/agent-rigger/state.json',
    });
    expect('repair' in finding).toBe(true);
    expect(finding.reason).toBe('artifacts is not an array');
    expect(finding.repair.kind).toBe('backup-state');
    expect(finding.repair.consent).toBe('safe');
    expect(finding.repair.path).toBe('/home/u/.config/agent-rigger/state.json');
  });
});

// ---------------------------------------------------------------------------
// R3 — dangling: tracked suggests (report-only), untracked unlinks (item-confirm)
// ---------------------------------------------------------------------------

describe('doctor-R3: dangling symlinks — suggest for tracked, unlink for untracked', () => {
  it('doctor-R3: a tracked dangling finding has no repair (reinstall is suggested, never executed)', () => {
    const finding = danglingTracked({ entryId: 'jr/skill:foo', readlink: '/gone/store/foo' });
    expect('repair' in finding).toBe(false);
    expect(finding.evidence.readlink).toBe('/gone/store/foo');
  });

  it('doctor-R3: an untracked dangling finding proposes unlink-dangling under item confirmation', () => {
    const finding = danglingUntracked({
      path: '/home/u/.claude/skills/gone',
      readlink: '/home/u/.config/agent-rigger/skills/gone',
    });
    expect(finding.repair.kind).toBe('unlink-dangling');
    expect(finding.repair.consent).toBe('item-confirm');
    expect(finding.repair.target).toBe('/home/u/.claude/skills/gone');
  });
});

// ---------------------------------------------------------------------------
// R4 — phantom: always a probable verdict, always item-confirm
// ---------------------------------------------------------------------------

describe('doctor-R4: phantom store — always probable, never --yes-sufficient', () => {
  it('doctor-R4: a phantom finding proposes remove-store under item confirmation', () => {
    const finding = phantomProbable({
      store: '/home/u/.config/agent-rigger/hooks',
      candidates: [],
    });
    expect(finding.repair.kind).toBe('remove-store');
    expect(finding.repair.consent).toBe('item-confirm');
    expect(finding.evidence.candidates).toEqual([]);
  });

  it('doctor-R4: candidates are carried verbatim as evidence (why the verdict stays "probable")', () => {
    const finding = phantomProbable({
      store: '/home/u/.config/agent-rigger/skills/foo',
      candidates: ['/home/u/.claude/skills/foo'],
    });
    expect(finding.evidence.candidates).toEqual(['/home/u/.claude/skills/foo']);
  });
});

// ---------------------------------------------------------------------------
// R6 — lock: crash/recycled propose break-lock, refusal never does
// ---------------------------------------------------------------------------

describe('doctor-R6: lock findings — break-lock only for crash/recycled, never for a live/EPERM refusal', () => {
  const deadEvidence = {
    pid: 4242,
    startedAt: '2026-01-01T00:00:00.000Z',
    ageMs: 999_999,
    liveness: 'dead' as const,
    identity: 'unknown' as const,
  };

  it('doctor-R6: crash-probable proposes break-lock under item confirmation', () => {
    const finding = lockCrashProbable({
      lockPath: '/home/u/.config/agent-rigger/state.json.lock',
      evidence: deadEvidence,
    });
    expect(finding.repair.kind).toBe('break-lock');
    expect(finding.repair.consent).toBe('item-confirm');
    expect(finding.evidence.pid).toBe(4242);
  });

  it('doctor-R6: crash-probable summary renders the evidence — pid, startedAt, age (R6 "verdict affiché")', () => {
    const finding = lockCrashProbable({
      lockPath: '/home/u/.config/agent-rigger/state.json.lock',
      evidence: deadEvidence,
    });
    expect(finding.summary).toContain(String(deadEvidence.pid));
    expect(finding.summary).toContain(deadEvidence.startedAt);
    // ageMs 999_999 → 16m39s under the lock summary's age formatter.
    expect(finding.summary).toContain('16m39s');
  });

  it('doctor-R6: pid-recycled-probable proposes break-lock under item confirmation', () => {
    const foreignEvidence = {
      ...deadEvidence,
      liveness: 'alive' as const,
      identity: 'foreign' as const,
    };
    const finding = lockPidRecycledProbable({
      lockPath: '/home/u/.config/agent-rigger/state.json.lock',
      evidence: foreignEvidence,
    });
    expect(finding.repair.kind).toBe('break-lock');
    expect(finding.repair.consent).toBe('item-confirm');
  });

  it('doctor-R6: refusal on a live, plausibly-rigger pid has no repair', () => {
    const liveEvidence = {
      ...deadEvidence,
      liveness: 'alive' as const,
      identity: 'rigger' as const,
    };
    const finding = lockRefused({ reason: 'live', evidence: liveEvidence });
    expect('repair' in finding).toBe(false);
  });

  it('doctor-R6: refusal on an indeterminate (EPERM) pid has no repair', () => {
    const epermEvidence = {
      ...deadEvidence,
      liveness: 'unknown' as const,
      identity: 'unknown' as const,
    };
    const finding = lockRefused({ reason: 'eperm', evidence: epermEvidence });
    expect('repair' in finding).toBe(false);
  });

  it('doctor-R6: stale lock-break debris is safe to delete (never re-read)', () => {
    const finding = lockStaleDebris({
      path: '/home/u/.config/agent-rigger/state.json.lock.stale-12345-abcd1234',
    });
    expect(finding.repair.kind).toBe('delete-residue');
    expect(finding.repair.consent).toBe('safe');
  });
});

// ---------------------------------------------------------------------------
// R7 — hygiene: residue is safe, .bak is always item-confirm
// ---------------------------------------------------------------------------

describe('doctor-R7: hygiene — tmp/checkout residue is safe, aged .bak is always item-confirm', () => {
  it('doctor-R7: orphaned tmp/checkout residue is safe under --yes', () => {
    const finding = hygieneResidue({
      path: '/home/u/.config/agent-rigger/settings.json.tmp-abcd',
      ageMs: 999_999,
    });
    expect(finding.repair.kind).toBe('delete-residue');
    expect(finding.repair.consent).toBe('safe');
  });

  it('doctor-R7: an aged .bak past retention always requires item confirmation', () => {
    const finding = hygieneBak({
      path: '/home/u/.config/agent-rigger/state.json.bak-2020-01-01T00-00-00.000Z-abcd1234',
      ageMs: 99_999_999,
    });
    expect(finding.repair.kind).toBe('delete-bak');
    expect(finding.repair.consent).toBe('item-confirm');
  });
});

// ---------------------------------------------------------------------------
// Discrimination — Finding narrows exhaustively by `class`
// ---------------------------------------------------------------------------

describe('doctor-model: Finding discriminates exhaustively by class', () => {
  it('doctor-R8: a switch over every class is exhaustive (assertNever proves no class is missed)', () => {
    const samples: Finding[] = [
      untrackedDrift({ nature: 'skill', scope: 'user', assistant: 'claude', path: '/x' }),
      manifestMissingSha({ entryId: 'jr/skill:x', nature: 'skill', scope: 'user' }),
      danglingTracked({ entryId: 'jr/skill:x', readlink: '/gone' }),
      phantomProbable({ store: '/store', candidates: [] }),
      lockRefused({
        reason: 'live',
        evidence: {
          pid: 1,
          startedAt: undefined,
          ageMs: undefined,
          liveness: 'alive',
          identity: 'rigger',
        },
      }),
      hygieneResidue({ path: '/tmp/x', ageMs: 1 }),
    ];

    for (const finding of samples) {
      switch (finding.class) {
        case 'untracked':
          expect(finding.nature).toBeDefined();
          break;
        case 'manifest':
          expect(finding.issue).toBeDefined();
          break;
        case 'dangling':
          expect(finding.evidence.readlink).toBeDefined();
          break;
        case 'phantom':
          expect(finding.evidence.store).toBeDefined();
          break;
        case 'lock':
          expect(finding.verdict).toBeDefined();
          break;
        case 'hygiene':
          expect(finding.path).toBeDefined();
          break;
        default:
          assertNever(finding);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Type-level guarantee — checked by `bunx tsc --noEmit`, not by bun's runtime
// transpiler: destructive RepairOp variants reject `consent: 'safe'` and the
// two safe kinds reject `consent: 'item-confirm'`. If a future edit widened
// any of these fields to the `RepairConsent` union, the corresponding
// `@ts-expect-error` below would stop suppressing an error and tsc would fail.
// ---------------------------------------------------------------------------

describe('doctor-model: consent is graved as a literal type, not the wide union (tsc-checked)', () => {
  it('doctor-R4: remove-store cannot be constructed with consent "safe"', () => {
    // @ts-expect-error — remove-store is item-confirm by construction (R4).
    const invalid: RepairOpRemoveStore = { kind: 'remove-store', consent: 'safe', store: '/x' };
    expect(invalid.store).toBe('/x');
  });

  it('doctor-R6: break-lock cannot be constructed with consent "safe"', () => {
    // @ts-expect-error — break-lock is item-confirm by construction (R6).
    const invalid: RepairOpBreakLock = { kind: 'break-lock', consent: 'safe', lockPath: '/x.lock' };
    expect(invalid.lockPath).toBe('/x.lock');
  });

  it('doctor-R7: delete-bak cannot be constructed with consent "safe"', () => {
    // @ts-expect-error — delete-bak is item-confirm by construction (R7).
    const invalid: RepairOpDeleteBak = { kind: 'delete-bak', consent: 'safe', path: '/x.bak-1' };
    expect(invalid.path).toBe('/x.bak-1');
  });

  it('doctor-R3: unlink-dangling cannot be constructed with consent "safe"', () => {
    const invalid: RepairOpUnlinkDangling = {
      kind: 'unlink-dangling',
      // @ts-expect-error — unlink-dangling is item-confirm by construction (R3).
      consent: 'safe',
      target: '/x',
    };
    expect(invalid.target).toBe('/x');
  });

  it('doctor-R5: adopt-guardrail cannot be constructed with consent "safe"', () => {
    const invalid: RepairOpAdoptGuardrail = {
      kind: 'adopt',
      // @ts-expect-error — adopting a guardrail is item-confirm by construction (R5).
      consent: 'safe',
      nature: 'guardrail',
      scope: 'user',
      assistant: 'claude',
      files: [],
      candidateId: 'jr/guardrail:x',
    };
    expect(invalid.nature).toBe('guardrail');
  });

  it('doctor-R7: delete-residue cannot be constructed with consent "item-confirm"', () => {
    const invalid: RepairOpDeleteResidue = {
      kind: 'delete-residue',
      // @ts-expect-error — delete-residue is safe by construction (R7).
      consent: 'item-confirm',
      path: '/x',
    };
    expect(invalid.path).toBe('/x');
  });

  it('doctor-R5: adopt-safe cannot be constructed with consent "item-confirm"', () => {
    const invalid: RepairOpAdoptSafe = {
      kind: 'adopt',
      // @ts-expect-error — adopting a skill/context/agent is safe by construction (R5).
      consent: 'item-confirm',
      nature: 'skill',
      scope: 'user',
      assistant: 'claude',
      files: [],
      candidateId: 'jr/skill:x',
    };
    expect(invalid.nature).toBe('skill');
  });
});

// ---------------------------------------------------------------------------
// Determinism — constructors are pure: same inputs, same id
// ---------------------------------------------------------------------------

describe('doctor-model: constructors are pure — deterministic ids, no randomness/clock', () => {
  it('doctor-R1: two calls with identical inputs produce identical ids', () => {
    const params = {
      nature: 'skill' as const,
      scope: 'user' as const,
      assistant: 'claude' as const,
      path: '/home/u/.claude/skills/foo',
      candidateId: 'jr/skill:foo',
    };
    const a = untrackedAdoptable(params);
    const b = untrackedAdoptable(params);
    expect(a.id).toBe(b.id);
    expect(a).toEqual(b);
  });

  it('doctor-R4: two distinct stores produce distinct ids', () => {
    const a = phantomProbable({ store: '/store/a', candidates: [] });
    const b = phantomProbable({ store: '/store/b', candidates: [] });
    expect(a.id).not.toBe(b.id);
  });
});
