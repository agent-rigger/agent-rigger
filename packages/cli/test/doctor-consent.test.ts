/**
 * doctor-consent.test.ts — the consent-driver (R8, ADR-0025 §2).
 *
 * The driver READS `op.consent` and applies the two runtime signals (`--yes`,
 * TTY) against it — it never decides the policy. These tests pin the four
 * decisive rules the design flowchart names, each proven against a `Finding`
 * built by the real T1 constructors (no hand-rolled ops):
 *   - safe under --yes → auto-granted (no prompt).
 *   - item-confirm under --yes alone (non-TTY) → SKIPPED, never auto-run.
 *   - item-confirm in a TTY → prompted; a "no" skips + reports.
 *   - break-lock is routed OUT of stateOps (2-temps, pre-acquire), carrying
 *     the observed {pid, startedAt} from the finding's evidence.
 *
 * The "jamais de hang" bound is proven structurally: a confirmItem that throws
 * if called is injected in every non-TTY case; the tests pass, so it is never
 * called there.
 */

import { describe, expect, it } from 'bun:test';

import {
  hygieneBak,
  hygieneResidue,
  lockCrashProbable,
  type LockEvidence,
  untrackedAdoptable,
  untrackedDrift,
} from '@agent-rigger/core';

import { driveConsent } from '../src/doctor-consent';

const NEVER_PROMPT = (): Promise<boolean> => {
  throw new Error('confirmItem must not be called (would hang / auto-destruct)');
};

const deadLockEvidence: LockEvidence = {
  pid: 4242,
  startedAt: '2026-07-11T00:00:00.000Z',
  ageMs: 999_999,
  liveness: 'dead',
  identity: 'unknown',
};

describe('doctor-R8: consent-driver — safe ops auto-grant under --yes (no prompt)', () => {
  it('a safe residue op is granted under --yes without ever prompting', async () => {
    const finding = hygieneResidue({ path: '/tmp/x.tmp-deadbeef', ageMs: 100_000 });

    const grant = await driveConsent([finding], {
      yes: true,
      isTTY: false,
      confirmItem: NEVER_PROMPT,
    });

    expect(grant.stateOps).toHaveLength(1);
    expect(grant.stateOps[0]?.kind).toBe('delete-residue');
    expect(grant.skipped).toHaveLength(0);
  });

  it('a safe adopt (skill) op is granted under --yes', async () => {
    const finding = untrackedAdoptable({
      nature: 'skill',
      scope: 'user',
      assistant: 'claude',
      path: '/home/u/.claude/skills/foo',
      candidateId: 'skill:foo',
    });

    const grant = await driveConsent([finding], {
      yes: true,
      isTTY: false,
      confirmItem: NEVER_PROMPT,
    });

    expect(grant.stateOps).toHaveLength(1);
    expect(grant.stateOps[0]?.kind).toBe('adopt');
  });
});

describe('doctor-R8: consent-driver — item-confirm is NEVER auto-granted by --yes (non-TTY skips)', () => {
  it('an item-confirm .bak op is skipped + reported under --yes in non-TTY, never prompted', async () => {
    const finding = hygieneBak({
      path: '/home/u/.claude/skills/foo.bak-2026-07-11T00-00-00.000Z-deadbeef',
      ageMs: 999_999,
    });

    const grant = await driveConsent([finding], {
      yes: true,
      isTTY: false,
      confirmItem: NEVER_PROMPT,
    });

    expect(grant.stateOps).toHaveLength(0);
    expect(grant.skipped).toHaveLength(1);
    expect(grant.skipped[0]?.op.kind).toBe('delete-bak');
    expect(grant.skipped[0]?.reason).toContain('per-item confirmation');
  });
});

describe('doctor-R8: consent-driver — item-confirm prompts in a TTY', () => {
  it('a "yes" grants the item-confirm op', async () => {
    const finding = hygieneBak({
      path: '/home/u/.claude/skills/foo.bak-2026-07-11T00-00-00.000Z-deadbeef',
      ageMs: 999_999,
    });

    const grant = await driveConsent([finding], {
      yes: false,
      isTTY: true,
      confirmItem: async () => true,
    });

    expect(grant.stateOps).toHaveLength(1);
    expect(grant.stateOps[0]?.kind).toBe('delete-bak');
    expect(grant.skipped).toHaveLength(0);
  });

  it('a "no" skips + reports the op', async () => {
    const finding = hygieneBak({
      path: '/home/u/.claude/skills/foo.bak-2026-07-11T00-00-00.000Z-deadbeef',
      ageMs: 999_999,
    });

    const grant = await driveConsent([finding], {
      yes: false,
      isTTY: true,
      confirmItem: async () => false,
    });

    expect(grant.stateOps).toHaveLength(0);
    expect(grant.skipped).toHaveLength(1);
    expect(grant.skipped[0]?.reason).toContain('not confirmed');
  });
});

describe('doctor-R8: consent-driver — break-lock is routed pre-acquire, never a state op', () => {
  it('a consented break-lock is surfaced separately with the observed identity, not in stateOps', async () => {
    const finding = lockCrashProbable({
      lockPath: '/home/u/.config/agent-rigger/state.json.lock',
      evidence: deadLockEvidence,
    });

    const grant = await driveConsent([finding], {
      yes: false,
      isTTY: true,
      confirmItem: async () => true,
    });

    expect(grant.stateOps).toHaveLength(0);
    expect(grant.breakLock).toBeDefined();
    expect(grant.breakLock?.lockPath).toBe('/home/u/.config/agent-rigger/state.json.lock');
    expect(grant.breakLock?.observed).toEqual({ pid: 4242, startedAt: '2026-07-11T00:00:00.000Z' });
  });

  it('a declined break-lock is skipped, not broken', async () => {
    const finding = lockCrashProbable({
      lockPath: '/home/u/.config/agent-rigger/state.json.lock',
      evidence: deadLockEvidence,
    });

    const grant = await driveConsent([finding], {
      yes: false,
      isTTY: true,
      confirmItem: async () => false,
    });

    expect(grant.breakLock).toBeUndefined();
    expect(grant.skipped).toHaveLength(1);
  });

  it('break-lock under --yes alone (non-TTY) is skipped — never auto-broken', async () => {
    const finding = lockCrashProbable({
      lockPath: '/home/u/.config/agent-rigger/state.json.lock',
      evidence: deadLockEvidence,
    });

    const grant = await driveConsent([finding], {
      yes: true,
      isTTY: false,
      confirmItem: NEVER_PROMPT,
    });

    expect(grant.breakLock).toBeUndefined();
    expect(grant.stateOps).toHaveLength(0);
    expect(grant.skipped).toHaveLength(1);
  });
});

describe('doctor-R8: consent-driver — report-only findings carry no repair, nothing to consent', () => {
  it('an untracked drift (report-only) contributes neither a state op nor a skip', async () => {
    const drift = untrackedDrift({
      nature: 'skill',
      scope: 'user',
      assistant: 'claude',
      path: '/home/u/.claude/skills/hand-edited',
    });
    const adoptable = untrackedAdoptable({
      nature: 'skill',
      scope: 'user',
      assistant: 'claude',
      path: '/home/u/.claude/skills/keep',
      candidateId: 'skill:keep',
    });

    const grant = await driveConsent([drift, adoptable], {
      yes: true,
      isTTY: false,
      confirmItem: NEVER_PROMPT,
    });

    // Only the adoptable one is a state op; the drift is silently report-only.
    expect(grant.stateOps).toHaveLength(1);
    expect(grant.stateOps[0]?.kind).toBe('adopt');
    expect(grant.skipped).toHaveLength(0);
  });
});
