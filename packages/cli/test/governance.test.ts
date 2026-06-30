/**
 * governance.test.ts — auditableGovernanceIds (pure).
 *
 * Models the real demo data: a `jr` catalog that requires pack:secu (→ guardrail)
 * and recommends pack:baseline (→ context), plus an `example` catalog whose
 * guardrail/context live only in an undeclared pack:full.
 */

import { describe, expect, it } from 'bun:test';

import type { CatalogEntry } from '@agent-rigger/catalog';

import { auditableGovernanceIds } from '../src/governance';
import type { CatalogGovernanceMeta } from '../src/governance';

const art = (id: string, nature: string): CatalogEntry =>
  ({
    kind: 'artifact',
    id,
    nature,
    targets: ['claude'],
    scopes: ['user', 'project'],
  }) as CatalogEntry;
const pack = (id: string, members: string[]): CatalogEntry =>
  ({ kind: 'pack', id, members, targets: ['claude'], scopes: ['user', 'project'] }) as CatalogEntry;

// jr: required pack:secu (guardrail), recommended pack:baseline (context).
// example: required [], recommended pack:demo (skill+agent only); guardrail/
// context live only in the undeclared pack:full.
const EFFECTIVE: CatalogEntry[] = [
  art('jr/guardrail:claude', 'guardrail'),
  art('jr/context:claude', 'context'),
  art('jr/hook:guard-command', 'hook'),
  pack('jr/pack:secu', ['jr/hook:guard-command', 'jr/guardrail:claude']),
  pack('jr/pack:baseline', ['jr/context:claude', 'jr/skill:testing']),
  art('jr/skill:testing', 'skill'),
  art('example/guardrail:demo', 'guardrail'),
  art('example/context:demo', 'context'),
  art('example/skill:hello-rigger', 'skill'),
  art('example/agent:demo', 'agent'),
  pack('example/pack:demo', ['example/skill:hello-rigger', 'example/agent:demo']),
  pack('example/pack:full', [
    'example/skill:hello-rigger',
    'example/agent:demo',
    'example/guardrail:demo',
    'example/context:demo',
  ]),
];

const META: Map<string, CatalogGovernanceMeta> = new Map([
  ['jr', { required: ['pack:secu'], recommended: ['pack:baseline'] }],
  ['example', { required: [], recommended: ['pack:demo'] }],
]);

describe('auditableGovernanceIds', () => {
  it('audits declared governance (required ∪ recommended, packs expanded)', () => {
    const ids = auditableGovernanceIds(EFFECTIVE, META);
    expect(ids.has('jr/guardrail:claude')).toBe(true); // required via pack:secu
    expect(ids.has('jr/context:claude')).toBe(true); // recommended via pack:baseline
  });

  it('does NOT audit available-but-undeclared guardrail/context', () => {
    const ids = auditableGovernanceIds(EFFECTIVE, META);
    // example's guardrail/context are only in the undeclared pack:full.
    expect(ids.has('example/guardrail:demo')).toBe(false);
    expect(ids.has('example/context:demo')).toBe(false);
  });

  it('ignores non-governance natures inside declared packs', () => {
    const ids = auditableGovernanceIds(EFFECTIVE, META);
    expect(ids.has('jr/hook:guard-command')).toBe(false); // hook, via pack:secu
    expect(ids.has('jr/skill:testing')).toBe(false); // skill, via pack:baseline
  });

  it('still audits installed guardrail/context even when undeclared (drift)', () => {
    const ids = auditableGovernanceIds(EFFECTIVE, META, ['example/guardrail:demo']);
    expect(ids.has('example/guardrail:demo')).toBe(true);
  });

  it('returns an empty set when nothing is declared or installed', () => {
    const ids = auditableGovernanceIds(EFFECTIVE, new Map(), []);
    expect(ids.size).toBe(0);
  });
});
