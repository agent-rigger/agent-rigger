/**
 * lot6-r5-secrets-render.test.ts — R5: mcp secret RENDER at the opencode seam
 * (D5, mcpSource) + manifest secretRefs + update/adoption coherence.
 *
 * Covers the render half of R5 (the CLI collection half — --secret-env,
 * decideSecretOverride, resolveSecretOverrides — is lot6-r5-secrets-cli.test.ts,
 * which explicitly still asserts VERBATIM passthrough as "T6 does the render"):
 *  - renderSecretRefs / substituteSecretRefs — pure unit tests.
 *  - buildOpencodeAdapter's mcpSource: a declared secret present in env renders
 *    to opencode's native `{env:VAR}` form; a required secret whose resolved
 *    var is absent fails closed (MissingRequiredSecretError) BEFORE any write;
 *    a --secret-env-style override substitutes the OVERRIDDEN var, not the ref.
 *  - Manifest: `secretRefs` (names only, never a value) lands on the applied
 *    'opencode-mcp' payload after a real apply() through the engine.
 *  - Adoption: a pre-existing on-disk config in the RENDERED form is adopted
 *    (no false drift) — comparison is against the rendered canonical config.
 *  - Update (runUpdate): re-renders from the manifest's secretRefs, without
 *    any --secret-env/TTY involvement — proven by using an env where ONLY the
 *    overridden var is set (the ref's own name is deliberately absent), so a
 *    failure to replay secretRefs would fail-closed instead of updating.
 *  - Zero-value scan: the real secret VALUE never appears in state.json or in
 *    opencode.json, anywhere on disk.
 *
 * TDD: written before opencode-adapter-builder.ts's mcpSource renders,
 * before core/types.ts's secretRefs field, before mcp.ts threads it through
 * planMcp/adoptMcp, and before cmd-update.ts replays it (RED → GREEN).
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, TmpDirFactory } from '@agent-rigger/catalog';
import type { CommandRunner } from '@agent-rigger/catalog/tool-check';
import type { AdapterEntry } from '@agent-rigger/core/adapter';
import { apply } from '@agent-rigger/core/engine';
import { readJson } from '@agent-rigger/core/fs-json';
import { readManifest } from '@agent-rigger/core/manifest';
import { resolveOpencodeUserTargets, resolveUserTargets } from '@agent-rigger/core/paths';
import type { Env } from '@agent-rigger/core/paths';
import { stubScanner } from '@agent-rigger/core/scan';
import type { AppliedOpencodeMcp, OpencodeMcpServer } from '@agent-rigger/core/types';

import { runCli } from '../src/cli';
import { buildOpencodeAdapter } from '../src/opencode-adapter-builder';
import { MissingRequiredSecretError } from '../src/secret-collect';
import { renderSecretRefs, substituteSecretRefs } from '../src/secret-render';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECRET_TOKEN_SENTINEL = 'sekrit-value-do-not-persist-xyz789';

function githubMcpEntry(opts?: { required?: boolean }): CatalogEntry {
  return {
    kind: 'artifact',
    id: 'mcp:github',
    nature: 'mcp',
    targets: ['opencode'],
    scopes: ['user'],
    config: {
      type: 'local',
      command: ['bunx', 'github-mcp'],
      environment: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
    },
    secrets: [
      {
        ref: 'GITHUB_TOKEN',
        prompt: 'GitHub personal access token (repo scope)',
        required: opts?.required ?? true,
      },
    ],
  };
}

async function makeTmpHome(): Promise<{ dir: string; env: Env; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-lot6-r5-render-'));
  return {
    dir,
    env: { RIGGER_HOME: dir },
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

/** Recursively list every file under `dir` (used by the zero-value scan below). */
async function collectFiles(dir: string): Promise<string[]> {
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    dirents.map((d) => {
      const p = path.join(dir, d.name);
      return d.isDirectory() ? collectFiles(p) : Promise.resolve([p]);
    }),
  );
  return nested.flat();
}

// ---------------------------------------------------------------------------
// renderSecretRefs — pure unit tests
// ---------------------------------------------------------------------------

describe('lot6-R5: renderSecretRefs', () => {
  it('returns ref→ref-name when no override and the var is present', () => {
    const result = renderSecretRefs({
      entryId: 'mcp:github',
      secrets: [{ ref: 'GITHUB_TOKEN', prompt: 'token', required: true }],
      env: { GITHUB_TOKEN: 'present' },
    });
    expect(result).toEqual({ GITHUB_TOKEN: 'GITHUB_TOKEN' });
  });

  it('uses the override var name when provided', () => {
    const result = renderSecretRefs({
      entryId: 'mcp:github',
      secrets: [{ ref: 'GITHUB_TOKEN', prompt: 'token', required: true }],
      overrides: { GITHUB_TOKEN: 'MY_PAT' },
      env: { MY_PAT: 'present' },
    });
    expect(result).toEqual({ GITHUB_TOKEN: 'MY_PAT' });
  });

  it('throws MissingRequiredSecretError when a required secret resolves to an absent var', () => {
    expect(() =>
      renderSecretRefs({
        entryId: 'mcp:github',
        secrets: [{ ref: 'GITHUB_TOKEN', prompt: 'token', required: true }],
        env: {},
      })
    ).toThrow(MissingRequiredSecretError);
  });

  it('the thrown error names the entry, the ref, and suggests an export line', () => {
    try {
      renderSecretRefs({
        entryId: 'mcp:github',
        secrets: [{ ref: 'GITHUB_TOKEN', prompt: 'token', required: true }],
        env: {},
      });
      throw new Error('expected renderSecretRefs to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingRequiredSecretError);
      expect((err as Error).message).toContain('mcp:github');
      expect((err as Error).message).toContain('export GITHUB_TOKEN=');
    }
  });

  it('does NOT throw when an optional (not required) secret resolves to an absent var', () => {
    const result = renderSecretRefs({
      entryId: 'mcp:github',
      secrets: [{ ref: 'OPTIONAL_VAR', prompt: 'flag' }],
      env: {},
    });
    expect(result).toEqual({ OPTIONAL_VAR: 'OPTIONAL_VAR' });
  });

  it('an overridden var that is STILL absent from env fails closed too (required)', () => {
    expect(() =>
      renderSecretRefs({
        entryId: 'mcp:github',
        secrets: [{ ref: 'GITHUB_TOKEN', prompt: 'token', required: true }],
        overrides: { GITHUB_TOKEN: 'MY_PAT' },
        env: {}, // MY_PAT not set either
      })
    ).toThrow(MissingRequiredSecretError);
  });

  it('returns the full map across multiple secrets, mixing default and override', () => {
    const result = renderSecretRefs({
      entryId: 'mcp:multi',
      secrets: [
        { ref: 'TOKEN_A', prompt: 'a', required: true },
        { ref: 'TOKEN_B', prompt: 'b' },
      ],
      overrides: { TOKEN_A: 'REAL_A' },
      env: { REAL_A: 'x' },
    });
    expect(result).toEqual({ TOKEN_A: 'REAL_A', TOKEN_B: 'TOKEN_B' });
  });
});

// ---------------------------------------------------------------------------
// substituteSecretRefs — pure unit tests
// ---------------------------------------------------------------------------

describe('lot6-R5: substituteSecretRefs', () => {
  it('returns undefined when record is undefined', () => {
    expect(substituteSecretRefs(undefined, {}, (v) => v)).toBeUndefined();
  });

  it('substitutes a ref using the render function and the resolved var', () => {
    const result = substituteSecretRefs(
      { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
      { GITHUB_TOKEN: 'MY_PAT' },
      (v) => `{env:${v}}`,
    );
    expect(result).toEqual({ GITHUB_TOKEN: '{env:MY_PAT}' });
  });

  it('falls back to the ref name itself when the ref has no entry in secretRefs', () => {
    const result = substituteSecretRefs(
      { SOME_VAR: '${SOME_VAR}' },
      {},
      (v) => `{env:${v}}`,
    );
    expect(result).toEqual({ SOME_VAR: '{env:SOME_VAR}' });
  });

  it('leaves a non-ref-shaped value untouched (defensive; R6 already blocks this at parse)', () => {
    const result = substituteSecretRefs(
      { PLAIN: 'not-a-ref' },
      {},
      (v) => `{env:${v}}`,
    );
    expect(result).toEqual({ PLAIN: 'not-a-ref' });
  });

  it('renders every key independently', () => {
    const result = substituteSecretRefs(
      { A: '${A}', B: '${B}' },
      { A: 'REAL_A', B: 'REAL_B' },
      (v) => `{env:${v}}`,
    );
    expect(result).toEqual({ A: '{env:REAL_A}', B: '{env:REAL_B}' });
  });
});

// ---------------------------------------------------------------------------
// buildOpencodeAdapter — mcpSource renders (var present, no override)
// ---------------------------------------------------------------------------

describe('lot6-R5: mcpSource renders a present secret to opencode native form', () => {
  it('renders environment.GITHUB_TOKEN to {env:GITHUB_TOKEN} and returns secretRefs', async () => {
    const tmp = await makeTmpHome();
    try {
      const env: Env = { ...tmp.env, GITHUB_TOKEN: 'present-value' };
      const effectiveEntries = new Map([['mcp:github', githubMcpEntry()]]);
      const adapter = await buildOpencodeAdapter(env, { effectiveEntries });

      const entry: AdapterEntry = { id: 'mcp:github', nature: 'mcp', scope: 'user' };
      const ops = await adapter.plan(entry, 'user', env);
      const mcpOp = ops.find((op) => op.kind === 'merge-mcp') as
        | { config: OpencodeMcpServer; secretRefs?: Record<string, string> }
        | undefined;

      expect(mcpOp).toBeDefined();
      expect((mcpOp!.config as { environment?: Record<string, string> }).environment).toEqual({
        GITHUB_TOKEN: '{env:GITHUB_TOKEN}',
      });
      expect(mcpOp!.secretRefs).toEqual({ GITHUB_TOKEN: 'GITHUB_TOKEN' });
    } finally {
      await tmp.cleanup();
    }
  });

  it('never leaks the actual secret VALUE into the rendered config or op', async () => {
    const tmp = await makeTmpHome();
    try {
      const env: Env = { ...tmp.env, GITHUB_TOKEN: SECRET_TOKEN_SENTINEL };
      const effectiveEntries = new Map([['mcp:github', githubMcpEntry()]]);
      const adapter = await buildOpencodeAdapter(env, { effectiveEntries });

      const entry: AdapterEntry = { id: 'mcp:github', nature: 'mcp', scope: 'user' };
      const ops = await adapter.plan(entry, 'user', env);

      expect(JSON.stringify(ops)).not.toContain(SECRET_TOKEN_SENTINEL);
    } finally {
      await tmp.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// buildOpencodeAdapter — mcpSource fails closed on a required, unresolved secret
// ---------------------------------------------------------------------------

describe('lot6-R5: mcpSource fails closed before any write when required secret is absent', () => {
  it('adapter.plan rejects with MissingRequiredSecretError', async () => {
    const tmp = await makeTmpHome();
    try {
      const env: Env = { ...tmp.env }; // GITHUB_TOKEN deliberately absent
      const effectiveEntries = new Map([['mcp:github', githubMcpEntry({ required: true })]]);
      const adapter = await buildOpencodeAdapter(env, { effectiveEntries });

      const entry: AdapterEntry = { id: 'mcp:github', nature: 'mcp', scope: 'user' };
      await expect(adapter.plan(entry, 'user', env)).rejects.toThrow(MissingRequiredSecretError);
    } finally {
      await tmp.cleanup();
    }
  });

  it('nothing is written: opencode.json is never created', async () => {
    const tmp = await makeTmpHome();
    try {
      const env: Env = { ...tmp.env };
      const effectiveEntries = new Map([['mcp:github', githubMcpEntry({ required: true })]]);
      const adapter = await buildOpencodeAdapter(env, { effectiveEntries });

      const entry: AdapterEntry = { id: 'mcp:github', nature: 'mcp', scope: 'user' };
      await expect(adapter.plan(entry, 'user', env)).rejects.toThrow();

      const targets = resolveOpencodeUserTargets(env);
      const exists = await fs.stat(targets.opencodeJson).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    } finally {
      await tmp.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// buildOpencodeAdapter — mcpSource honours --secret-env-style overrides
// ---------------------------------------------------------------------------

describe('lot6-R5: mcpSource substitutes the OVERRIDDEN var, not the ref', () => {
  it('renders {env:MY_PAT} and secretRefs GITHUB_TOKEN→MY_PAT when overridden', async () => {
    const tmp = await makeTmpHome();
    try {
      const env: Env = { ...tmp.env, MY_PAT: 'present-value' }; // GITHUB_TOKEN itself absent
      const effectiveEntries = new Map([['mcp:github', githubMcpEntry()]]);
      const adapter = await buildOpencodeAdapter(env, {
        effectiveEntries,
        secretOverrides: { GITHUB_TOKEN: 'MY_PAT' },
      });

      const entry: AdapterEntry = { id: 'mcp:github', nature: 'mcp', scope: 'user' };
      const ops = await adapter.plan(entry, 'user', env);
      const mcpOp = ops.find((op) => op.kind === 'merge-mcp') as
        | { config: OpencodeMcpServer; secretRefs?: Record<string, string> }
        | undefined;

      expect((mcpOp!.config as { environment?: Record<string, string> }).environment).toEqual({
        GITHUB_TOKEN: '{env:MY_PAT}',
      });
      expect(mcpOp!.secretRefs).toEqual({ GITHUB_TOKEN: 'MY_PAT' });
    } finally {
      await tmp.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Manifest: secretRefs (names only) lands on the applied payload after apply()
// ---------------------------------------------------------------------------

describe('lot6-R5: secretRefs lands on the manifest applied payload, names only', () => {
  it('AppliedOpencodeMcp.secretRefs == {GITHUB_TOKEN: "MY_PAT"} after a real install', async () => {
    const tmp = await makeTmpHome();
    try {
      const env: Env = { ...tmp.env, MY_PAT: SECRET_TOKEN_SENTINEL };
      const effectiveEntries = new Map([['mcp:github', githubMcpEntry()]]);
      const adapter = await buildOpencodeAdapter(env, {
        effectiveEntries,
        secretOverrides: { GITHUB_TOKEN: 'MY_PAT' },
      });

      const entry: AdapterEntry = { id: 'mcp:github', nature: 'mcp', scope: 'user' };
      const manifestPath = path.join(tmp.dir, '.config', 'agent-rigger', 'state.json');

      await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });

      const manifest = await readManifest(manifestPath);
      const stored = manifest.artifacts.find((a) => a.id === 'mcp:github');
      expect(stored).toBeDefined();
      expect(stored!.applied?.kind).toBe('opencode-mcp');
      const applied = stored!.applied as AppliedOpencodeMcp;
      expect(applied.secretRefs).toEqual({ GITHUB_TOKEN: 'MY_PAT' });
    } finally {
      await tmp.cleanup();
    }
  });

  it('zero-value scan: the real secret value never appears anywhere under RIGGER_HOME', async () => {
    const tmp = await makeTmpHome();
    try {
      const env: Env = { ...tmp.env, MY_PAT: SECRET_TOKEN_SENTINEL };
      const effectiveEntries = new Map([['mcp:github', githubMcpEntry()]]);
      const adapter = await buildOpencodeAdapter(env, {
        effectiveEntries,
        secretOverrides: { GITHUB_TOKEN: 'MY_PAT' },
      });

      const entry: AdapterEntry = { id: 'mcp:github', nature: 'mcp', scope: 'user' };
      const manifestPath = path.join(tmp.dir, '.config', 'agent-rigger', 'state.json');
      await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });

      // Recursively read every file under HOME and confirm the sentinel value
      // never appears — covers state.json, opencode.json, and any .bak file.
      const files = await collectFiles(tmp.dir);
      for (const f of files) {
        const content = await fs.readFile(f, 'utf-8').catch(() => '');
        expect(content).not.toContain(SECRET_TOKEN_SENTINEL);
      }
    } finally {
      await tmp.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Adoption: rendered config compared against disk — no false drift
// ---------------------------------------------------------------------------

describe('lot6-R5: adoption compares the RENDERED config — no false drift', () => {
  it('adopts an on-disk server already in the rendered form, with no manifest record', async () => {
    const tmp = await makeTmpHome();
    try {
      const env: Env = { ...tmp.env, GITHUB_TOKEN: 'present-value' };
      const effectiveEntries = new Map([['mcp:github', githubMcpEntry()]]);
      const adapter = await buildOpencodeAdapter(env, { effectiveEntries });

      // Pre-populate opencode.json with EXACTLY the rendered form (as if a
      // human — or a pre-E-secrets rigger run — had already written it).
      const targets = resolveOpencodeUserTargets(env);
      await fs.mkdir(path.dirname(targets.opencodeJson), { recursive: true });
      await fs.writeFile(
        targets.opencodeJson,
        JSON.stringify({
          mcp: {
            github: {
              type: 'local',
              command: ['bunx', 'github-mcp'],
              environment: { GITHUB_TOKEN: '{env:GITHUB_TOKEN}' },
            },
          },
        }),
        'utf-8',
      );

      const entry: AdapterEntry = { id: 'mcp:github', nature: 'mcp', scope: 'user' };
      const manifestPath = path.join(tmp.dir, '.config', 'agent-rigger', 'state.json');

      const result = await apply({ adapter, entries: [entry], scope: 'user', env, manifestPath });
      expect(result.adopted).toContain('mcp:github');

      // The on-disk config must be untouched (adoption never writes config).
      const onDisk = await readJson(targets.opencodeJson);
      const mcp = onDisk['mcp'] as Record<string, OpencodeMcpServer>;
      expect((mcp['github'] as { environment?: Record<string, string> }).environment).toEqual({
        GITHUB_TOKEN: '{env:GITHUB_TOKEN}',
      });
    } finally {
      await tmp.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end via runCli: required secret absent → exit 2, nothing written
// ---------------------------------------------------------------------------

describe('lot6-R5: runCli install exits 2 when a required mcp secret is absent, nothing written', () => {
  it('exit 2, no opencode.json, no state.json entry for the mcp id', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-lot6-r5-e2e-home-'));
    const contentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-lot6-r5-e2e-content-'));
    try {
      const configDir = path.join(homeDir, '.config', 'agent-rigger');
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, 'config.json'),
        JSON.stringify({
          catalogs: [{ name: 'principal', url: 'https://example.com/catalog.git' }],
        }),
        'utf8',
      );

      const mcpEntry: CatalogEntry = {
        kind: 'artifact',
        id: 'mcp:github',
        nature: 'mcp',
        targets: ['opencode'],
        scopes: ['user'],
        config: {
          type: 'local',
          command: ['bunx', 'github-mcp'],
          environment: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
        },
        secrets: [
          { ref: 'GITHUB_TOKEN', prompt: 'GitHub personal access token', required: true },
        ],
      };
      await fs.writeFile(
        path.join(contentDir, 'catalog.json'),
        JSON.stringify({ meta: { name: 'e2e-secrets-catalog' }, entries: [mcpEntry] }),
        'utf8',
      );

      const sha = 'cccccccccccccccccccccccccccccccccccccccc';
      const runner: CommandRunner = (_cmd, args) => {
        const argv = args ?? [];
        if (argv[0] === 'ls-remote' && argv[1] === '--tags') {
          return Promise.resolve({ exitCode: 0, stdout: `${sha}\trefs/tags/v1.0.0\n`, stderr: '' });
        }
        if (argv[0] === 'ls-remote' && argv.includes('HEAD')) {
          return Promise.resolve({ exitCode: 0, stdout: `${sha}\tHEAD\n`, stderr: '' });
        }
        if (argv[0] === 'clone') {
          return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        }
        if (argv[0] === '-C' && argv[2] === 'rev-parse') {
          return Promise.resolve({ exitCode: 0, stdout: `${sha}\n`, stderr: '' });
        }
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
      };
      const tmpFactory: TmpDirFactory = async () => ({
        path: contentDir,
        cleanup: async () => {},
      });

      // No GITHUB_TOKEN in env, no --secret-env flag: the render fails closed.
      const env: Env = { RIGGER_HOME: homeDir };
      const lines: string[] = [];
      const code = await runCli(
        ['install', 'principal/mcp:github', '--yes', '--assistant=opencode'],
        {
          print: (m) => lines.push(m),
          env,
          remote: { run: runner, tmpFactory, scanner: stubScanner },
        },
      );

      expect(code).toBe(2);
      expect(lines.join('\n')).toContain('GITHUB_TOKEN');

      const opencodeTargets = resolveOpencodeUserTargets(env);
      const opencodeJsonExists = await fs.stat(opencodeTargets.opencodeJson)
        .then(() => true)
        .catch(() => false);
      expect(opencodeJsonExists).toBe(false);

      const stateJsonExists = await fs.stat(resolveUserTargets(env).stateJson)
        .then(() => true)
        .catch(() => false);
      expect(stateJsonExists).toBe(false);
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
      await fs.rm(contentDir, { recursive: true, force: true });
    }
  });
});
