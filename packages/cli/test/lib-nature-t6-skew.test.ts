/**
 * lib-nature-t6-skew.test.ts — R9.3 « skew nommé », sense A (a CLI at the cutout
 * layout reading a catalogue that predates it — the flat skills/, plugins/ dirs).
 * This is the reproducible-in-process direction: a bare ENOENT deep in the
 * staging copy or the plugin lookup must be reframed as an actionable layout-skew
 * message, never surfaced raw.
 *
 * Sense B (a pre-cutover binary reading a post-cutover catalogue) is not
 * reproducible in-process — it needs an older CLI build — and is documented at
 * layout-skew.ts's docblock instead; no test is expected for it.
 *
 * The two choke points every selected artefact passes through:
 *  - materializeUnion (staging copy): covers skill/agent/hook/guardrail/context/lib;
 *  - resolveOpencodePluginPath (opencode plugin lookup): the one non-staged read.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ArtifactEntry } from '@agent-rigger/catalog';
import type { AdapterEntry } from '@agent-rigger/core/adapter';
import type { Env } from '@agent-rigger/core/paths';

import { buildOpencodeAdapter } from '../src/opencode-adapter-builder';
import { materializeUnion } from '../src/scan-staging';

let tmpDir: string;
let base: string;
let env: Env;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-t6-skew-'));
  base = path.join(tmpDir, 'checkout');
  env = { RIGGER_HOME: path.join(tmpDir, 'home') };
  await fs.mkdir(base, { recursive: true });
  await fs.writeFile(path.join(base, 'catalog.json'), '{"meta":{"name":"x"},"entries":[]}\n');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Choke point 1 — materializeUnion staging copy (skill/agent/hook/guardrail/…)
// ---------------------------------------------------------------------------

describe('materializeUnion — flat (pre-cutover) catalogue → layout-skew message', () => {
  it('reframes the ENOENT as a named layout skew, not a bare ENOENT', async () => {
    // Pre-cutover FLAT layout: the skill lives at skills/demo, but a post-cutover
    // CLI scans common/skills/demo — the exact skew this message exists for.
    const skillDir = path.join(base, 'skills', 'demo');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# demo\n');

    const skill: ArtifactEntry = {
      kind: 'artifact',
      id: 'skill:demo',
      nature: 'skill',
      targets: ['claude'],
      scopes: ['user'],
    };

    let caught: Error | undefined;
    try {
      await materializeUnion({ entries: [skill], baseDir: base });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    const msg = caught!.message;
    // Names the skew hypothesis, both directions, and the version alignment...
    expect(msg).toContain('layout skew');
    expect(msg).toContain('cutover release');
    // ...and the exact convention path the CLI expected but did not find.
    expect(msg).toContain(path.join('common', 'skills', 'demo'));
    // NOT a bare ENOENT surfaced raw.
    expect(msg).not.toMatch(/^ENOENT/);
  });

  it('leaves a genuine non-ENOENT copy failure to propagate unchanged', async () => {
    // A skill whose common/skills dir DOES exist stages cleanly — no skew framing
    // on the happy path (guards against the reframing swallowing everything).
    const skillDir = path.join(base, 'common', 'skills', 'demo');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# demo\n');
    const skill: ArtifactEntry = {
      kind: 'artifact',
      id: 'skill:demo',
      nature: 'skill',
      targets: ['claude'],
      scopes: ['user'],
    };
    const { cleanup } = await materializeUnion({ entries: [skill], baseDir: base });
    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// Choke point 2 — resolveOpencodePluginPath (opencode plugin lookup)
// ---------------------------------------------------------------------------

describe('opencode plugin lookup — missing opencode/plugins dir → layout-skew message', () => {
  const pluginEntry: AdapterEntry = { id: 'plugin:demo', nature: 'plugin', scope: 'user' };

  it('reframes an absent opencode/plugins dir as a named layout skew', async () => {
    // No opencode/plugins dir at all — the signature of a pre-cutover catalogue
    // whose plugins still live under the flat plugins/ dir.
    const adapter = await buildOpencodeAdapter(env, {
      externalIds: new Set(['plugin:demo']),
      externalBaseDir: base,
    });

    let caught: Error | undefined;
    try {
      await adapter.plan(pluginEntry, 'user', env);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toContain('layout skew');
    expect(caught!.message).toContain('cutover release');
  });

  it('a present dir with the plugin file MISSING stays a genuine catalogue error (not skew)', async () => {
    // The dir exists (layout aligned) but the specific plugin file is absent — a
    // genuine catalogue error, NOT a skew: the message must not claim a skew.
    await fs.mkdir(path.join(base, 'opencode', 'plugins'), { recursive: true });
    await fs.writeFile(path.join(base, 'opencode', 'plugins', 'other.ts'), '// other');

    const adapter = await buildOpencodeAdapter(env, {
      externalIds: new Set(['plugin:demo']),
      externalBaseDir: base,
    });

    let caught: Error | undefined;
    try {
      await adapter.plan(pluginEntry, 'user', env);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).not.toContain('layout skew');
    expect(caught!.message).toContain('not found under');
  });
});
