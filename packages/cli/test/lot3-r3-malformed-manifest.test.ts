/**
 * Lot 3 — R3: MalformedManifestError maps to exit 2 through the CLI check channel.
 *
 * `readManifest` fails closed on a present-but-top-level-invalid state.json
 * (design D3). This test proves the cmd-check channel maps that typed error to
 * exitCode 2 with an actionable, path-bearing message — the equivalent of
 * buildInvalidJsonOutput for InvalidJsonError.
 *
 * The install/remove/ls channels route the same error through cli.ts handleError
 * (also exit 2); that path is a thin instanceof branch mirrored on the check
 * channel here — the shape parity is what R3 asks for.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import type { Env } from '@agent-rigger/core/paths';
import { resolveUserTargets } from '@agent-rigger/core/paths';

import { createClaudeAdapter } from '@agent-rigger/adapters';

import { runCheck } from '../src/cmd-check';

const REF_DENY = ['Read(./.env)', 'Read(~/.ssh/**)'];
const GUARDRAIL_ENTRY: AdapterEntry = {
  id: 'guardrails-claude',
  nature: 'guardrail',
  scope: 'user',
};

let tmpDir: string;
let env: Env;
let targets: ReturnType<typeof resolveUserTargets>;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-cli-lot3-r3-'));
  env = { RIGGER_HOME: tmpDir };
  targets = resolveUserTargets(env);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('lot3-R3: check channel maps a malformed manifest to exit 2', () => {
  it('lot3-R3: a string-version state.json yields exitCode 2', async () => {
    await fs.mkdir(path.dirname(targets.stateJson), { recursive: true });
    await fs.writeFile(
      targets.stateJson,
      JSON.stringify({ version: '1', artifacts: [] }),
      'utf-8',
    );

    const adapter = createClaudeAdapter({ denyRef: REF_DENY });
    const result = await runCheck({
      adapter,
      entries: [GUARDRAIL_ENTRY],
      scope: 'user',
      env,
      manifestPath: targets.stateJson,
    });

    expect(result.exitCode).toBe(2);
    expect(result.output).toContain(targets.stateJson);
    expect(result.output.toLowerCase()).toMatch(/manifest|malformed/);
  });

  it('lot3-R3: a top-level array state.json yields exitCode 2', async () => {
    await fs.mkdir(path.dirname(targets.stateJson), { recursive: true });
    await fs.writeFile(targets.stateJson, '[]', 'utf-8');

    const adapter = createClaudeAdapter({ denyRef: REF_DENY });
    const result = await runCheck({
      adapter,
      entries: [GUARDRAIL_ENTRY],
      scope: 'user',
      env,
      manifestPath: targets.stateJson,
    });

    expect(result.exitCode).toBe(2);
    expect(result.report.entries).toEqual([]);
  });
});
