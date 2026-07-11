/**
 * obs1-R2 — renderReport displays the 'unknown' ArtifactState distinctly
 * (design.md decision 3: "rendus check/ls affichent l'état distinctement").
 *
 * Scope: the renderReport switch in cli/src/ui.ts gained a case 'unknown'
 * when core/src/types.ts's ArtifactState union grew that member (T1 of
 * obs1-plugin-reads). Pure rendering test — color: false for determinism,
 * matching the existing ui.test.ts convention.
 *
 * TDD: written before the ui.ts switch case landed.
 */

import { describe, expect, it } from 'bun:test';

import type { Report } from '@agent-rigger/core';

import { renderReport } from '../src/ui';

describe('obs1-R2: renderReport renders unknown distinctly', () => {
  it('obs1-R2: labels an unknown entry with its own tag, distinct from present/missing/drift', () => {
    const report: Report = {
      entries: [{ id: 'plugin:foo', nature: 'plugin', state: 'unknown' }],
    };

    const result = renderReport(report, { color: false });

    expect(result).toContain('plugin:foo');
    expect(result).not.toContain('[ ok  ]');
    expect(result).not.toContain('[miss ]');
    expect(result).not.toContain('[drift]');
  });

  it('obs1-R2: appends the detail message for an unknown entry when provided', () => {
    const report: Report = {
      entries: [
        {
          id: 'plugin:foo',
          nature: 'plugin',
          state: 'unknown',
          detail: 'ledger version 3 unsupported',
        },
      ],
    };

    const result = renderReport(report, { color: false });

    expect(result).toContain('ledger version 3 unsupported');
  });

  it('obs1-R2: renders present/missing/drift/unknown together, one line per entry', () => {
    const report: Report = {
      entries: [
        { id: 'a', nature: 'skill', state: 'present' },
        { id: 'b', nature: 'mcp', state: 'missing' },
        { id: 'c', nature: 'agent', state: 'drift', detail: 'file removed' },
        { id: 'd', nature: 'plugin', state: 'unknown', detail: 'unparsable ledger' },
      ],
    };

    const result = renderReport(report, { color: false });
    const lines = result.split('\n');

    expect(lines).toHaveLength(4);
    expect(result).toContain('[ ok  ]');
    expect(result).toContain('[miss ]');
    expect(result).toContain('[drift]');
    expect(result).toContain('unparsable ledger');
  });
});
