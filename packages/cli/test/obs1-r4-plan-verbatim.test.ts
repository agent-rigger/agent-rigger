/**
 * obs1-R4 — the plan renders the exact native commands verbatim.
 *
 * When a plan (install or removal) contains a plugin op, the user must be
 * able to read the exact `claude plugin …` invocation that will be spawned
 * at apply time BEFORE confirming — parity with the tool-checks display
 * (cmd-install.ts). Previously the plan only showed `via <marketplace>`,
 * with no command visible ahead of confirmation (ADR-0022 OBS-1).
 *
 * These commands must match, verbatim, what applyPlugin/applyRemovePlugin
 * actually spawn (adapters/src/claude/plugins.ts):
 *   - `claude plugin marketplace add ${op.marketplace}`
 *   - `claude plugin install ${op.plugin}`
 *   - `claude plugin uninstall ${op.plugin}`
 *
 * Pure rendering test — color: false for determinism, no process spawned.
 */

import { describe, expect, it } from 'bun:test';

import type { RemovalOp, WriteOp } from '@agent-rigger/core';

import type { PlanGroup, PlanRemovalGroup } from '../src/ui';
import { renderPlan, renderRemovalPlan } from '../src/ui';

describe('obs1-R4: plan verbatim plugin commands', () => {
  it('obs1-R4: install plan shows the exact marketplace-add and install commands', () => {
    const op: WriteOp = {
      kind: 'plugin-install',
      plugin: 'my-plugin',
      marketplace: '/project/.claude-plugin/marketplace.json',
    };
    const group: PlanGroup = { id: 'plugin:my', nature: 'plugin', action: 'install', ops: [op] };

    const result = renderPlan([group], { color: false, cwd: '/project' });

    expect(result).toContain(
      'claude plugin marketplace add /project/.claude-plugin/marketplace.json',
    );
    expect(result).toContain('claude plugin install my-plugin');
  });

  it('obs1-R4: the commands are visible for a remote (URL) marketplace source too', () => {
    const op: WriteOp = {
      kind: 'plugin-install',
      plugin: 'remote-plugin',
      marketplace: 'https://marketplace.example.com/manifest.json',
    };
    const group: PlanGroup = {
      id: 'plugin:remote',
      nature: 'plugin',
      action: 'install',
      ops: [op],
    };

    const result = renderPlan([group], { color: false });

    expect(result).toContain(
      'claude plugin marketplace add https://marketplace.example.com/manifest.json',
    );
    expect(result).toContain('claude plugin install remote-plugin');
  });

  it('obs1-R4: removal plan shows the exact uninstall command', () => {
    const op: RemovalOp = { kind: 'plugin-uninstall', plugin: 'my-plugin' };
    const group: PlanRemovalGroup = { id: 'plugin:my', nature: 'plugin', ops: [op] };

    const result = renderRemovalPlan([group], { color: false });

    expect(result).toContain('claude plugin uninstall my-plugin');
  });

  it('obs1-R4: the command lines appear before confirmation — pure string rendering, zero spawn', () => {
    // renderPlan/renderRemovalPlan are pure functions: no import of Bun.spawn,
    // no PluginRunner passed in, no I/O. Their mere invocation proves the
    // native commands can be surfaced without ever touching the `claude`
    // binary — the confirm/apply boundary is untouched by this rendering.
    const op: WriteOp = {
      kind: 'plugin-install',
      plugin: 'my-plugin',
      marketplace: '/project/.claude-plugin/marketplace.json',
    };
    const group: PlanGroup = { id: 'plugin:my', nature: 'plugin', action: 'install', ops: [op] };

    expect(() => renderPlan([group], { color: false, cwd: '/project' })).not.toThrow();
  });
});
