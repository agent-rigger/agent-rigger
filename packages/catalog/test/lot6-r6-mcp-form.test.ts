/**
 * lot6-r6-mcp-form.test.ts — R5/R6: secrets[] schema + strict mcp form validation (D5, D6).
 *
 * R6 (dense — residual ADR-0018): the catalog parse SHALL refuse a literal
 * (non-ref) value in `config.environment`/`config.headers` of an mcp entry,
 * independently of any scanner — the gate is the VALUE'S SHAPE ("${VAR_NAME}"
 * or nothing), not content-detection heuristics. This closes the "three
 * persistent copies" failure mode (opencode.json, manifest, .bak) at parse
 * time, before any scan or write ever runs.
 *
 * R5 (schema half): `secrets[]` is optional on ArtifactEntrySchema —
 * {ref, prompt, required?, example?, help?} — declaring which env-var refs an
 * mcp entry needs. The CLI collection (--secret-env, prompts) and the render
 * (mcpSource substitution) are separate concerns (T5 CLI / T6 render); this
 * file only covers the schema shape.
 *
 * TDD: written before the superRefine strict-form check and the `secrets`
 * field exist on ArtifactEntrySchema (RED → GREEN).
 */

import { describe, expect, it } from 'bun:test';

import { ArtifactEntrySchema, parseCatalogEntry, safeParseCatalogEntry } from '../src/schema';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mcpEntry(config: Record<string, unknown>): unknown {
  return {
    kind: 'artifact',
    id: 'mcp:github',
    nature: 'mcp',
    targets: ['opencode'],
    scopes: ['user'],
    config,
  };
}

// ---------------------------------------------------------------------------
// R6 — strict form: environment/headers must be refs, scanner-independent
// ---------------------------------------------------------------------------

describe('lot6-R6: mcp config.environment/headers strict ref form', () => {
  it('rejects a literal secret value in config.environment, naming the entry and field', () => {
    const result = safeParseCatalogEntry(
      mcpEntry({
        type: 'local',
        command: ['bunx', 'github-mcp'],
        environment: { GITHUB_TOKEN: 'ghp_xxxxxxxxxxxxxxxxxxxx' },
      }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) =>
      i.path.join('.') === 'config.environment.GITHUB_TOKEN'
    );
    expect(issue).toBeDefined();
    expect(issue?.message).toContain('mcp:github');
    expect(issue?.message).toMatch(/\$\{VAR_NAME\}|reference/i);
  });

  it('rejects a literal secret value in config.headers, naming the entry and field', () => {
    const result = safeParseCatalogEntry(
      mcpEntry({
        type: 'remote',
        url: 'https://api.example.com/mcp',
        headers: { Authorization: 'Bearer sk-live-abc123' },
      }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) =>
      i.path.join('.') === 'config.headers.Authorization'
    );
    expect(issue).toBeDefined();
    expect(issue?.message).toContain('mcp:github');
  });

  it('accepts a legitimate "${VAR_NAME}" ref in environment', () => {
    const result = safeParseCatalogEntry(
      mcpEntry({
        type: 'local',
        command: ['bunx', 'github-mcp'],
        environment: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
      }),
    );

    expect(result.success).toBe(true);
  });

  it('accepts a legitimate "${VAR_NAME}" ref in headers', () => {
    const result = safeParseCatalogEntry(
      mcpEntry({
        type: 'remote',
        url: 'https://api.example.com/mcp',
        headers: { Authorization: '${GITHUB_AUTH_HEADER}' },
      }),
    );

    expect(result.success).toBe(true);
  });

  it('rejects a literal secret value in config.env (Claude Code native stdio field), naming the entry and field', () => {
    // R6/R8 gap: mcp-source.ts's render step substitutes refs across
    // ['environment', 'headers', 'env'] (env is Claude Code's native stdio
    // field) — the parse-time gate must cover the exact same set, or a
    // literal in `env` for a claude-targeted entry parses clean and reaches
    // ~/.claude.json + state.json + .bak verbatim (the three-copies leak
    // R6/ADR-0018 was created to close).
    const result = safeParseCatalogEntry(
      mcpEntry({
        type: 'stdio',
        command: 'npx',
        env: { GITHUB_TOKEN: 'ghp_realsecretliteral' },
      }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path.join('.') === 'config.env.GITHUB_TOKEN');
    expect(issue).toBeDefined();
    expect(issue?.message).toContain('mcp:github');
    expect(issue?.message).toMatch(/\$\{VAR_NAME\}|reference/i);
  });

  it('accepts a legitimate "${VAR_NAME}" ref in config.env', () => {
    const result = safeParseCatalogEntry(
      mcpEntry({
        type: 'stdio',
        command: 'npx',
        env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
      }),
    );

    expect(result.success).toBe(true);
  });

  it('rejects when only PART of the value is a ref (embedded, not exact-match)', () => {
    const result = safeParseCatalogEntry(
      mcpEntry({
        type: 'remote',
        url: 'https://api.example.com/mcp',
        headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' },
      }),
    );

    expect(result.success).toBe(false);
  });

  it('is independent of any scanner — pure parse-time rejection, no scan involved', () => {
    // No scanner is constructed or imported anywhere in this test: the
    // rejection above comes from safeParseCatalogEntry alone. This test
    // documents that invariant explicitly (ADR-0018's residual: the gate is
    // the schema's superRefine, not a content-detection heuristic).
    expect(() =>
      parseCatalogEntry(
        mcpEntry({
          type: 'local',
          command: ['bunx', 'github-mcp'],
          environment: { GITHUB_TOKEN: 'ghp_literal' },
        }),
      )
    ).toThrow();
  });

  it('is a no-op for non-mcp natures even with an environment-shaped field', () => {
    // The strict check only applies to nature === 'mcp'; other natures never
    // have a `config` field at all in practice, but the guard must not
    // misfire if one were present.
    const result = safeParseCatalogEntry({
      kind: 'artifact',
      id: 'tool:glab',
      nature: 'tool',
      targets: ['claude'],
      scopes: ['user'],
    });
    expect(result.success).toBe(true);
  });

  it('mcp entry with no config at all is still valid (builder enforces presence, not schema)', () => {
    const result = safeParseCatalogEntry({
      kind: 'artifact',
      id: 'mcp:github',
      nature: 'mcp',
      targets: ['opencode'],
      scopes: ['user'],
    });
    expect(result.success).toBe(true);
  });

  it('mcp entry with config but no environment/headers sub-fields is still valid', () => {
    const result = safeParseCatalogEntry(
      mcpEntry({ type: 'local', command: ['bunx', 'github-mcp'] }),
    );
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R5 — secrets[] schema shape
// ---------------------------------------------------------------------------

describe('lot6-R5: secrets[] schema shape on ArtifactEntrySchema', () => {
  it('parses an mcp entry declaring secrets[] with the full shape', () => {
    const result = ArtifactEntrySchema.safeParse(
      mcpEntry({
        type: 'local',
        command: ['bunx', 'github-mcp'],
        environment: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts secrets[] with ref + prompt only (required/example/help all optional)', () => {
    const result = safeParseCatalogEntry({
      ...(mcpEntry({
        type: 'local',
        command: ['bunx', 'github-mcp'],
        environment: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
      }) as Record<string, unknown>),
      secrets: [{ ref: 'GITHUB_TOKEN', prompt: 'GitHub personal access token (repo scope)' }],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.kind).toBe('artifact');
    if (result.data.kind !== 'artifact') return;
    expect(result.data.secrets).toEqual([
      { ref: 'GITHUB_TOKEN', prompt: 'GitHub personal access token (repo scope)' },
    ]);
  });

  it('accepts secrets[] with every optional field populated', () => {
    const result = safeParseCatalogEntry({
      ...(mcpEntry({
        type: 'local',
        command: ['bunx', 'github-mcp'],
        environment: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
      }) as Record<string, unknown>),
      secrets: [
        {
          ref: 'GITHUB_TOKEN',
          prompt: 'GitHub personal access token',
          required: true,
          example: 'ghp_xxxxxxxxxxxxxxxxxxxx',
          help: 'https://github.com/settings/tokens',
        },
      ],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    if (result.data.kind !== 'artifact') return;
    expect(result.data.secrets?.[0]?.required).toBe(true);
  });

  it('rejects a secrets[] entry missing "ref"', () => {
    const result = safeParseCatalogEntry({
      ...(mcpEntry({ type: 'local', command: ['bunx', 'github-mcp'] }) as Record<string, unknown>),
      secrets: [{ prompt: 'missing ref' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a secrets[] entry missing "prompt"', () => {
    const result = safeParseCatalogEntry({
      ...(mcpEntry({ type: 'local', command: ['bunx', 'github-mcp'] }) as Record<string, unknown>),
      secrets: [{ ref: 'GITHUB_TOKEN' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-boolean "required" field', () => {
    const result = safeParseCatalogEntry({
      ...(mcpEntry({ type: 'local', command: ['bunx', 'github-mcp'] }) as Record<string, unknown>),
      secrets: [{ ref: 'GITHUB_TOKEN', prompt: 'token', required: 'yes' }],
    });
    expect(result.success).toBe(false);
  });

  it('secrets is undefined when not provided (back-compat, additive field)', () => {
    const result = safeParseCatalogEntry({
      kind: 'artifact',
      id: 'tool:glab',
      nature: 'tool',
      targets: ['claude'],
      scopes: ['user'],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    if (result.data.kind !== 'artifact') return;
    expect(result.data.secrets).toBeUndefined();
  });
});
