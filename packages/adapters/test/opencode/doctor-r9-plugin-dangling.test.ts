/**
 * doctor-R9 — opencode/plugins.ts fix: auditPlugin must report `missing` on a
 * dangling symlink instead of `present` (ADR-0025/R9).
 *
 * Before this fix, auditPlugin located the installed file via a bare
 * `readdir` name-match: it only asked "does a directory entry with this
 * basename exist in pluginDir?", never whether the entry actually resolves.
 * A symlink whose store target has been deleted (R9's "lien pendant") still
 * shows up in a `readdir` listing, so the old audit reported `present` on a
 * dead link — the exact same class of bug R4/R9 fixed for skill/agent audits
 * via lstat+stat. This test locks the parity: opencode plugin audits now use
 * the same truthful lstat+stat contract.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { resolveOpencodeUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { auditPlugin } from '../../src/opencode/plugins';

async function makeTmpHome(prefix = 'rigger-doctor-r9-opencode-'): Promise<{
  dir: string;
  env: Env;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env: Env = { RIGGER_HOME: dir };
  return { dir, env, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

let tmp: Awaited<ReturnType<typeof makeTmpHome>>;
let env: Env;

beforeEach(async () => {
  tmp = await makeTmpHome();
  env = tmp.env;
});

afterEach(async () => {
  await tmp.cleanup();
});

describe('doctor-R9: auditPlugin opencode on a dangling symlink', () => {
  it('doctor-R9: a plugin symlink whose store target vanished audits as missing (not present)', async () => {
    const entry: AdapterEntry = { id: 'plugin:enforce-tests', nature: 'plugin', scope: 'user' };
    const targets = resolveOpencodeUserTargets(env);
    await fs.mkdir(targets.pluginDir, { recursive: true });

    // A store that exists just long enough to create the symlink, then is
    // deleted — the classic "hooks lot2/lot3" dangling-link shape (store
    // removed out from under a live install symlink).
    const storeFile = path.join(tmp.dir, 'ephemeral-store', 'enforce-tests.ts');
    await fs.mkdir(path.dirname(storeFile), { recursive: true });
    await fs.writeFile(storeFile, 'export {};');
    const linkPath = path.join(targets.pluginDir, 'enforce-tests.ts');
    await fs.symlink(storeFile, linkPath);
    await fs.rm(storeFile);

    const report = await auditPlugin(entry, 'user', env);

    expect(report.state).toBe('missing');
    expect(report.detail).toContain('dangling symlink');
  });

  it('doctor-R9: a live symlink resolving to real content still audits as present (non-regression)', async () => {
    const entry: AdapterEntry = { id: 'plugin:enforce-tests', nature: 'plugin', scope: 'user' };
    const targets = resolveOpencodeUserTargets(env);
    await fs.mkdir(targets.pluginDir, { recursive: true });

    const storeFile = path.join(tmp.dir, 'live-store', 'enforce-tests.ts');
    await fs.mkdir(path.dirname(storeFile), { recursive: true });
    await fs.writeFile(storeFile, 'export {};');
    const linkPath = path.join(targets.pluginDir, 'enforce-tests.ts');
    await fs.symlink(storeFile, linkPath);

    const report = await auditPlugin(entry, 'user', env);

    expect(report.state).toBe('present');
  });

  it('doctor-R9: a plain (non-symlink) file still audits as present (copy-fallback parity)', async () => {
    const entry: AdapterEntry = { id: 'plugin:enforce-tests', nature: 'plugin', scope: 'user' };
    const targets = resolveOpencodeUserTargets(env);
    await fs.mkdir(targets.pluginDir, { recursive: true });
    await fs.writeFile(path.join(targets.pluginDir, 'enforce-tests.ts'), 'export {};');

    const report = await auditPlugin(entry, 'user', env);

    expect(report.state).toBe('present');
  });
});
