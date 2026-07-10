/**
 * lot6-r5-secrets-cli.test.ts — R5: secret collection at the CLI seam (D5).
 *
 * Covers the CLI-side half of R5 (the schema half — secrets[], strict mcp
 * form — is lot6-r6-mcp-form.test.ts, packages/catalog):
 *  - parseArgs collects every `--secret-env=<ref>=<VAR>` occurrence (repeatable).
 *  - parseSecretEnvFlag(s) — pure format validation, actionable on malformed input.
 *  - decideSecretOverride — pure decision (flag > TTY prompt > non-TTY actionable
 *    error for `required` > default-to-ref-name for optional secrets).
 *  - resolveSecretOverrides — IO wrapper: injectable picker for the TTY branch,
 *    MissingRequiredSecretError for the non-TTY/required/unresolved branch.
 *  - runCli end-to-end: a malformed --secret-env value on `install` exits 2
 *    with an actionable message, BEFORE any catalog is even resolved.
 *  - Threading: buildOpencodeAdapter / buildClaudeAdapter accept
 *    `secretOverrides` in opts. The full render (declared-secret substitution,
 *    fail-closed, manifest secretRefs) is covered end-to-end in
 *    lot6-r5-secrets-render.test.ts (T6) — this file only proves an override
 *    for an UNDECLARED ref (no matching `secrets[]` entry) is inert.
 *
 * TDD: written before secret-collect.ts and the parseArgs/cli.ts wiring exist
 * (RED → GREEN).
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CatalogEntry, SecretDecl } from '@agent-rigger/catalog';
import type { AdapterEntry } from '@agent-rigger/core/adapter';
import type { Env } from '@agent-rigger/core/paths';

import { buildClaudeAdapter } from '../src/adapter-builder';
import { parseArgs, runCli } from '../src/cli';
import { buildOpencodeAdapter } from '../src/opencode-adapter-builder';
import {
  decideSecretOverride,
  InvalidSecretEnvFlagError,
  MissingRequiredSecretError,
  parseSecretEnvFlag,
  parseSecretEnvFlags,
  resolveSecretOverrides,
} from '../src/secret-collect';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GITHUB_TOKEN_SECRET: SecretDecl = {
  ref: 'GITHUB_TOKEN',
  prompt: 'GitHub personal access token (repo scope)',
  required: true,
};

const OPTIONAL_SECRET: SecretDecl = {
  ref: 'OPTIONAL_VAR',
  prompt: 'Optional feature flag token',
};

// ---------------------------------------------------------------------------
// parseArgs — collects repeated --secret-env occurrences
// ---------------------------------------------------------------------------

describe('lot6-R5: parseArgs collects --secret-env occurrences', () => {
  it('collects a single --secret-env occurrence', () => {
    const result = parseArgs(['install', 'mycat/mcp:github', '--secret-env=GITHUB_TOKEN=MY_PAT']);
    expect(result.secretEnvFlags).toEqual(['GITHUB_TOKEN=MY_PAT']);
  });

  it('collects MULTIPLE --secret-env occurrences, in argv order', () => {
    const result = parseArgs([
      'install',
      'mycat/mcp:github',
      '--secret-env=GITHUB_TOKEN=MY_PAT',
      '--secret-env=API_KEY=MY_API_KEY',
    ]);
    expect(result.secretEnvFlags).toEqual(['GITHUB_TOKEN=MY_PAT', 'API_KEY=MY_API_KEY']);
  });

  it('is empty when no --secret-env flag is present', () => {
    const result = parseArgs(['install', 'mycat/mcp:github']);
    expect(result.secretEnvFlags).toEqual([]);
  });

  it('does not disturb other flags (flags dict still holds every other key)', () => {
    const result = parseArgs([
      'install',
      'mycat/mcp:github',
      '--secret-env=GITHUB_TOKEN=MY_PAT',
      '--yes',
      '--scope=project',
    ]);
    expect(result.flags['yes']).toBe(true);
    expect(result.flags['scope']).toBe('project');
    expect(result.secretEnvFlags).toEqual(['GITHUB_TOKEN=MY_PAT']);
  });
});

// ---------------------------------------------------------------------------
// parseSecretEnvFlag / parseSecretEnvFlags — pure format validation
// ---------------------------------------------------------------------------

describe('lot6-R5: parseSecretEnvFlag(s) format validation', () => {
  it('parses a valid "<ref>=<VAR>" value', () => {
    expect(parseSecretEnvFlag('GITHUB_TOKEN=MY_PAT')).toEqual({
      ref: 'GITHUB_TOKEN',
      envVar: 'MY_PAT',
    });
  });

  it('parses multiple valid values into a ref→VAR map', () => {
    const overrides = parseSecretEnvFlags(['GITHUB_TOKEN=MY_PAT', 'API_KEY=MY_API_KEY']);
    expect(overrides).toEqual({ GITHUB_TOKEN: 'MY_PAT', API_KEY: 'MY_API_KEY' });
  });

  it('throws InvalidSecretEnvFlagError when there is no "="', () => {
    expect(() => parseSecretEnvFlag('GITHUB_TOKEN')).toThrow(InvalidSecretEnvFlagError);
  });

  it('throws InvalidSecretEnvFlagError when the ref side is empty', () => {
    expect(() => parseSecretEnvFlag('=MY_PAT')).toThrow(InvalidSecretEnvFlagError);
  });

  it('throws InvalidSecretEnvFlagError when the VAR side is empty', () => {
    expect(() => parseSecretEnvFlag('GITHUB_TOKEN=')).toThrow(InvalidSecretEnvFlagError);
  });

  it('names the offending raw value in the error message', () => {
    try {
      parseSecretEnvFlag('bad-value');
      throw new Error('expected parseSecretEnvFlag to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidSecretEnvFlagError);
      expect((err as InvalidSecretEnvFlagError).raw).toBe('bad-value');
      expect((err as Error).message).toContain('bad-value');
    }
  });

  it('parseSecretEnvFlags throws on the first invalid entry, multiple valid ones parsed fine before it', () => {
    expect(() => parseSecretEnvFlags(['GITHUB_TOKEN=MY_PAT', 'MALFORMED'])).toThrow(
      InvalidSecretEnvFlagError,
    );
  });

  it('parseSecretEnvFlags returns an empty map for an empty list', () => {
    expect(parseSecretEnvFlags([])).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// decideSecretOverride — pure decision, exhaustive branches
// ---------------------------------------------------------------------------

describe('lot6-R5: decideSecretOverride', () => {
  it('a flag override wins outright, even in a TTY', () => {
    const result = decideSecretOverride({
      secret: GITHUB_TOKEN_SECRET,
      override: 'MY_PAT',
      isTTY: true,
    });
    expect(result).toEqual({ envVar: 'MY_PAT' });
  });

  it('a flag override wins outright, even non-TTY', () => {
    const result = decideSecretOverride({
      secret: GITHUB_TOKEN_SECRET,
      override: 'MY_PAT',
      isTTY: false,
    });
    expect(result).toEqual({ envVar: 'MY_PAT' });
  });

  it('no override + TTY → needs a prompt', () => {
    const result = decideSecretOverride({ secret: GITHUB_TOKEN_SECRET, isTTY: true });
    expect(result).toEqual({ needsPrompt: GITHUB_TOKEN_SECRET });
  });

  it('no override + non-TTY + required → actionable error, names the ref and the fix', () => {
    const result = decideSecretOverride({ secret: GITHUB_TOKEN_SECRET, isTTY: false });
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toContain('GITHUB_TOKEN');
    expect(result.error).toContain('--secret-env=GITHUB_TOKEN=');
  });

  it('no override + non-TTY + NOT required → defaults to the ref name itself', () => {
    const result = decideSecretOverride({ secret: OPTIONAL_SECRET, isTTY: false });
    expect(result).toEqual({ envVar: 'OPTIONAL_VAR' });
  });
});

// ---------------------------------------------------------------------------
// resolveSecretOverrides — IO wrapper
// ---------------------------------------------------------------------------

describe('lot6-R5: resolveSecretOverrides', () => {
  it('resolves every secret from flag overrides alone, no picker invoked', async () => {
    let pickerCalled = false;
    const resolved = await resolveSecretOverrides({
      secrets: [GITHUB_TOKEN_SECRET, OPTIONAL_SECRET],
      overrides: { GITHUB_TOKEN: 'MY_PAT', OPTIONAL_VAR: 'MY_FLAG' },
      isTTY: false,
      picker: async () => {
        pickerCalled = true;
        return 'unused';
      },
    });

    expect(resolved).toEqual({ GITHUB_TOKEN: 'MY_PAT', OPTIONAL_VAR: 'MY_FLAG' });
    expect(pickerCalled).toBe(false);
  });

  it('invokes the injected picker for a secret with no override in a TTY', async () => {
    const resolved = await resolveSecretOverrides({
      secrets: [GITHUB_TOKEN_SECRET],
      overrides: {},
      isTTY: true,
      picker: async (secret) => {
        expect(secret.ref).toBe('GITHUB_TOKEN');
        return 'PROMPTED_VAR';
      },
    });

    expect(resolved).toEqual({ GITHUB_TOKEN: 'PROMPTED_VAR' });
  });

  it('non-TTY + required + unresolved → throws MissingRequiredSecretError, actionable', async () => {
    await expect(
      resolveSecretOverrides({
        secrets: [GITHUB_TOKEN_SECRET],
        overrides: {},
        isTTY: false,
      }),
    ).rejects.toThrow(MissingRequiredSecretError);

    try {
      await resolveSecretOverrides({ secrets: [GITHUB_TOKEN_SECRET], overrides: {}, isTTY: false });
      throw new Error('expected resolveSecretOverrides to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingRequiredSecretError);
      expect((err as MissingRequiredSecretError).ref).toBe('GITHUB_TOKEN');
      expect((err as Error).message).toContain('GITHUB_TOKEN');
    }
  });

  it('non-TTY + NOT required + unresolved → defaults to the ref name, no throw', async () => {
    const resolved = await resolveSecretOverrides({
      secrets: [OPTIONAL_SECRET],
      overrides: {},
      isTTY: false,
    });
    expect(resolved).toEqual({ OPTIONAL_VAR: 'OPTIONAL_VAR' });
  });

  it('mixes flag-resolved and prompt-resolved secrets in one call', async () => {
    const resolved = await resolveSecretOverrides({
      secrets: [GITHUB_TOKEN_SECRET, OPTIONAL_SECRET],
      overrides: { GITHUB_TOKEN: 'MY_PAT' },
      isTTY: true,
      picker: async (secret) => `PROMPTED_${secret.ref}`,
    });
    expect(resolved).toEqual({ GITHUB_TOKEN: 'MY_PAT', OPTIONAL_VAR: 'PROMPTED_OPTIONAL_VAR' });
  });
});

// ---------------------------------------------------------------------------
// runCli end-to-end — invalid --secret-env exits 2, actionable, before any catalog fetch
// ---------------------------------------------------------------------------

describe('lot6-R5: runCli surfaces a malformed --secret-env as an actionable exit 2', () => {
  it('exits 2 with a message naming the offending value, on a plain install command', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-lot6-r5-home-'));
    try {
      const env: Env = { RIGGER_HOME: homeDir };
      const messages: string[] = [];
      const code = await runCli(
        ['install', 'mycat/mcp:github', '--secret-env=MALFORMED'],
        { env, print: (m) => messages.push(m) },
      );

      expect(code).toBe(2);
      expect(messages.join('\n')).toContain('MALFORMED');
      expect(messages.join('\n')).toContain('--secret-env');
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it('exits 2 the same way on `<resource> add` (shares handleInstall)', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-lot6-r5-home2-'));
    try {
      const env: Env = { RIGGER_HOME: homeDir };
      const messages: string[] = [];
      const code = await runCli(
        ['tool', 'add', 'mycat/tool:glab', '--secret-env=BAD'],
        { env, print: (m) => messages.push(m) },
      );

      expect(code).toBe(2);
      expect(messages.join('\n')).toContain('BAD');
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Threading — secretOverrides reaches the builder opts
//
// The catalog entry below declares NO `secrets[]` (a plumbing-era fixture) —
// its render (T6, lot6-r5-secrets-render.test.ts covers the declared-secret
// case in full) still translates the ref to opencode's native form (T0: a
// ref must never be left as an untranslatable bash-style literal), but an
// override for an UNDECLARED ref is inert: `secrets[]` is the catalog's only
// source of truth for which refs are overridable (R5 — declarative only).
// ---------------------------------------------------------------------------

describe('lot6-R5: secretOverrides is threaded into builder opts', () => {
  it('buildOpencodeAdapter renders the ref, ignoring an override with no matching secrets[] decl', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-lot6-r5-oc-'));
    try {
      const env: Env = { RIGGER_HOME: path.join(tmp, 'home') };
      const effectiveEntries: Map<string, CatalogEntry> = new Map([
        [
          'mcp:github',
          {
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
          },
        ],
      ]);

      const adapter = await buildOpencodeAdapter(env, {
        effectiveEntries,
        secretOverrides: { GITHUB_TOKEN: 'MY_PAT' },
      });

      const entry: AdapterEntry = { id: 'mcp:github', nature: 'mcp', scope: 'user' };
      const ops = await adapter.plan(entry, 'user', env);
      const mcpOp = ops.find((op) => op.kind === 'merge-mcp') as
        | { kind: string; config: Record<string, unknown> }
        | undefined;

      expect(mcpOp).toBeDefined();
      // No secrets[] declared → the override is inert; the ref is still
      // translated to opencode's native form, using its own name (T6).
      expect(mcpOp!.config).toEqual({
        type: 'local',
        command: ['bunx', 'github-mcp'],
        environment: { GITHUB_TOKEN: '{env:GITHUB_TOKEN}' },
      });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('buildClaudeAdapter accepts secretOverrides without throwing (no mcp nature yet, R8/T7)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-lot6-r5-claude-'));
    try {
      const env: Env = { RIGGER_HOME: path.join(tmp, 'home') };
      const adapter = await buildClaudeAdapter(env, {
        secretOverrides: { GITHUB_TOKEN: 'MY_PAT' },
      });
      expect(adapter).toBeDefined();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
