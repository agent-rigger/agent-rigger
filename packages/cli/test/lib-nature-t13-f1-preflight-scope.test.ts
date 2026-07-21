/**
 * lib-nature-t13-f1-preflight-scope.test.ts — Finding 1 (adversarial-close, R4):
 * the pre-flight probe must run on the SAME filesystem as the REAL symlink
 * target of the requested scope, not the rigger home.
 *
 * The old probe scratched under `dirname(libsDir(env))` (~/.config/agent-rigger)
 * regardless of scope. In project scope the real symlink target is
 * `<cwd>/.opencode/plugin/<name>` — a potentially DIFFERENT filesystem (WSL: an
 * ext4 HOME vs a /mnt/c project). A host that can symlink under HOME but not
 * under the project mount would pass the old probe and then silently copy-fall
 * back at the real pose. The fix threads scope + cwd and probes the parent of
 * the REAL scope pluginDir, walking up to the nearest existing ancestor when
 * `.opencode/` does not exist yet (the T4 tmpdir-fallback lesson: never step
 * onto a different filesystem to probe).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ArtifactEntry } from '@agent-rigger/catalog';
import { libsDir, resolveOpencodeProjectTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';

import { assertSymlinkCapable, SymlinkUnavailableError } from '../src/remote-install';

const PLUGIN_ID = 'principal/plugin:guard';
const LIB_ID = 'principal/lib:rules-common';

function pluginEntry(scope: 'user' | 'project'): ArtifactEntry {
  return {
    kind: 'artifact',
    id: PLUGIN_ID,
    nature: 'plugin',
    targets: ['opencode'],
    scopes: [scope],
  } as ArtifactEntry;
}

const requiresById = new Map<string, string[]>([[PLUGIN_ID, [LIB_ID]]]);
const libIds = new Set<string>([LIB_ID]);

/** A symlink seam that succeeds everywhere — the host CAN symlink. */
const okSymlink = (_t: string, _d: string) => Promise.resolve();

let homeDir: string;
let projectDir: string;
let env: Env;

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t13-f1-home-'));
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t13-f1-proj-'));
  env = { RIGGER_HOME: homeDir };
});

afterEach(async () => {
  await fs.rm(homeDir, { recursive: true, force: true });
  await fs.rm(projectDir, { recursive: true, force: true });
});

/**
 * A symlink seam that RECORDS every `dest` it is asked to create, and rejects
 * when that path is under the project directory — i.e. the project filesystem
 * cannot symlink, while HOME can. Proves BOTH that the probe ran on the project
 * FS (recorded path) and that a project-only failure is caught (refusal).
 */
function projectHostileSymlink(projectRoot: string): {
  symlink: (target: string, dest: string) => Promise<void>;
  destPaths: string[];
} {
  const destPaths: string[] = [];
  return {
    symlink: (_target: string, dest: string) => {
      destPaths.push(dest);
      if (dest.startsWith(projectRoot)) {
        return Promise.reject(new Error('EPERM: symlink not supported on the project mount'));
      }
      return Promise.resolve();
    },
    destPaths,
  };
}

describe('F1 — the pre-flight probes the real project pluginDir filesystem', () => {
  it('refuses when the project mount cannot symlink (even though HOME can)', async () => {
    const seam = projectHostileSymlink(projectDir);

    await expect(
      assertSymlinkCapable(
        [pluginEntry('project')],
        requiresById,
        libIds,
        'opencode',
        'project',
        env,
        projectDir,
        seam.symlink,
      ),
    ).rejects.toBeInstanceOf(SymlinkUnavailableError);
  });

  it('scratched under the project pluginDir ancestor, never the rigger home', async () => {
    const seam = projectHostileSymlink(projectDir);

    await assertSymlinkCapable(
      [pluginEntry('project')],
      requiresById,
      libIds,
      'opencode',
      'project',
      env,
      projectDir,
      seam.symlink,
    ).catch(() => {});

    // The probe touched the project filesystem (the real symlink target's FS).
    expect(seam.destPaths.length).toBeGreaterThan(0);
    expect(seam.destPaths.every((p) => p.startsWith(projectDir))).toBe(true);

    // It never scratched under the old home location — the exact Finding 1 bug.
    const oldProbeRoot = path.dirname(libsDir(env));
    expect(seam.destPaths.some((p) => p.startsWith(oldProbeRoot))).toBe(false);

    // Sanity: the real target's parent chain is the project's .opencode tree.
    expect(resolveOpencodeProjectTargets(projectDir).pluginDir.startsWith(projectDir)).toBe(true);
  });

  it('a host that CAN symlink under the project mount is accepted', async () => {
    // Seam succeeds everywhere → the probe passes → no refusal.
    await expect(
      assertSymlinkCapable(
        [pluginEntry('project')],
        requiresById,
        libIds,
        'opencode',
        'project',
        env,
        projectDir,
        okSymlink,
      ),
    ).resolves.toBeUndefined();
  });
});
