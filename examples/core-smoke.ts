/**
 * Runnable smoke demo of @agent-rigger/core.
 *
 * Exercises the engine end-to-end on an isolated temporary HOME (never touches
 * the real ~/). Shows: check -> apply -> re-check -> apply again (idempotent),
 * plus the managed CLAUDE.md import block and deny-merge in action.
 *
 * Run:  bun examples/core-smoke.ts
 *
 * The concrete Claude adapter is not built yet; this file uses a small inline
 * "deny adapter" to drive the engine, so you can see the real behaviour now.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  type Adapter,
  type AdapterEntry,
  apply,
  check,
  computeMissingDeny,
  ensureImportBlock,
  type Env,
  mergeDeny,
  type NatureReport,
  readJson,
  readText,
  reportExitCode,
  resolveUserTargets,
  writeJson,
  type WriteOp,
} from '../packages/core/src/index';

/** Canonical deny rules this demo wants present in settings.json. */
const REF_DENY = ['Read(./.env)', 'Read(~/.ssh/**)', 'Read(./secrets/**)'];

const ENTRY: AdapterEntry = { id: 'guardrails-claude', nature: 'guardrail', scope: 'user' };

/** Read permissions.deny as a string[] from a parsed settings object. */
function extractDeny(settings: Record<string, unknown>): string[] {
  const perms = settings['permissions'];
  if (perms !== null && typeof perms === 'object') {
    const deny = (perms as Record<string, unknown>)['deny'];
    if (Array.isArray(deny)) {
      return deny.filter((x): x is string => typeof x === 'string');
    }
  }
  return [];
}

/**
 * Minimal inline adapter that manages permissions.deny in settings.json.
 * Stand-in for the future adapters/claude/guardrails module.
 */
const denyAdapter: Adapter = {
  id: 'claude',

  audit(_entry: AdapterEntry, _scope, env: Env): Promise<NatureReport> {
    const { claudeSettings } = resolveUserTargets(env);
    return readJson(claudeSettings).then((settings) => {
      const missing = computeMissingDeny(REF_DENY, extractDeny(settings));
      return {
        id: ENTRY.id,
        nature: ENTRY.nature,
        state: missing.length === 0 ? 'present' : 'missing',
      };
    });
  },

  plan(_entry: AdapterEntry, _scope, env: Env): Promise<WriteOp[]> {
    const { claudeSettings } = resolveUserTargets(env);
    return readJson(claudeSettings).then((settings) => {
      const missing = computeMissingDeny(REF_DENY, extractDeny(settings));
      if (missing.length === 0) {
        return [];
      }
      return [{ kind: 'merge-deny', path: claudeSettings, toAdd: missing }];
    });
  },

  async apply(ops: WriteOp[], _env: Env): Promise<void> {
    for (const op of ops) {
      if (op.kind !== 'merge-deny') {
        continue;
      }
      const settings = await readJson(op.path);
      const merged = mergeDeny(extractDeny(settings), op.toAdd);
      const perms = settings['permissions'];
      const basePerms = perms !== null && typeof perms === 'object' ? perms : {};
      await writeJson(op.path, { ...settings, permissions: { ...basePerms, deny: merged } });
    }
  },

  async planRemove() {
    return [];
  },

  async applyRemove(): Promise<void> {},
};

function rule(label: string): void {
  console.info(`\n=== ${label} ===`);
}

async function main(): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'rigger-smoke-'));
  const env: Env = { RIGGER_HOME: home };
  const targets = resolveUserTargets(env);

  try {
    console.info('Isolated HOME:', home);

    // Seed an existing settings.json: an unrelated key + one pre-existing deny rule.
    await writeJson(targets.claudeSettings, {
      model: 'sonnet',
      permissions: { deny: ['Read(./private/**)'] },
    });

    rule('1) check (before install)');
    const before = await check(denyAdapter, [ENTRY], 'user', env);
    console.info('state :', before.entries.map((e) => `${e.id}=${e.state}`).join(', '));
    console.info('exit  :', reportExitCode(before), '(3 = incomplete)');

    rule('2) apply');
    const res1 = await apply({
      adapter: denyAdapter,
      entries: [ENTRY],
      scope: 'user',
      env,
      manifestPath: targets.stateJson,
    });
    console.info('written  :', res1.written);
    console.info('backedUp :', res1.backedUp, '(settings.json existed -> backed up)');
    console.info('settings.json now:\n' + (await readText(targets.claudeSettings)));
    console.info('state.json now:\n' + (await readText(targets.stateJson)));

    rule('3) check (after install)');
    const after = await check(denyAdapter, [ENTRY], 'user', env);
    console.info('exit  :', reportExitCode(after), '(0 = complete)');

    rule('4) apply again (idempotent)');
    const res2 = await apply({
      adapter: denyAdapter,
      entries: [ENTRY],
      scope: 'user',
      env,
      manifestPath: targets.stateJson,
    });
    console.info('written  :', res2.written, '(empty = no-op)');
    console.info('backedUp :', res2.backedUp, '(empty = nothing rewritten)');

    rule('bonus) ensureImportBlock (AGENTS.md -> CLAUDE.md bridge)');
    const claudeMd = '# My CLAUDE.md\n\nPersonal rules here.';
    console.info(ensureImportBlock(claudeMd, '~/.claude/harness/AGENTS.md'));

    rule('bonus) mergeDeny (pure, concat + dedup)');
    console.info(mergeDeny(['Read(./private/**)'], ['Read(./private/**)', 'Read(./.env)']));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

await main();
