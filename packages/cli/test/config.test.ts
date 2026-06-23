/**
 * Tests for config.ts — resolveConfig, loadConfigFile, persistConfig, loadConfig.
 *
 * Isolation: each test creates a fresh tmp directory; afterEach cleans up.
 * No I/O outside the tmp dir. resolveConfig is pure and tested without any I/O.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_CONFIG,
  InvalidConfigError,
  loadConfig,
  loadConfigFile,
  persistConfig,
  resolveConfig,
} from '../src/config';
import type { Config } from '../src/config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-cli-config-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// DEFAULT_CONFIG
// ---------------------------------------------------------------------------

describe('DEFAULT_CONFIG', () => {
  it('has defaultScope set to "user"', () => {
    expect(DEFAULT_CONFIG.defaultScope).toBe('user');
  });

  it('does not have catalogUrl set', () => {
    expect(DEFAULT_CONFIG.catalogUrl).toBeUndefined();
  });

  it('does not have authMethod set', () => {
    expect(DEFAULT_CONFIG.authMethod).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveConfig — pure function, no I/O
// ---------------------------------------------------------------------------

describe('resolveConfig', () => {
  it('returns defaults when no layers provided', () => {
    const config = resolveConfig({});
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('preset overrides defaults', () => {
    const config = resolveConfig({ preset: { catalogUrl: 'https://preset.example.com' } });
    expect(config.catalogUrl).toBe('https://preset.example.com');
    expect(config.defaultScope).toBe('user');
  });

  it('user overrides preset', () => {
    const config = resolveConfig({
      preset: { catalogUrl: 'https://preset.example.com' },
      user: { catalogUrl: 'https://user.example.com' },
    });
    expect(config.catalogUrl).toBe('https://user.example.com');
  });

  it('project overrides user', () => {
    const config = resolveConfig({
      user: { defaultScope: 'user' },
      project: { defaultScope: 'project' },
    });
    expect(config.defaultScope).toBe('project');
  });

  it('env overrides project', () => {
    const config = resolveConfig({
      project: { defaultScope: 'project' },
      env: { RIGGER_SCOPE: 'user' },
    });
    expect(config.defaultScope).toBe('user');
  });

  it('flags override env', () => {
    const config = resolveConfig({
      env: { RIGGER_SCOPE: 'project' },
      flags: { defaultScope: 'user' },
    });
    expect(config.defaultScope).toBe('user');
  });

  it('flags have highest priority — override all layers', () => {
    const config = resolveConfig({
      preset: { defaultScope: 'user', catalogUrl: 'https://preset.example.com' },
      user: { defaultScope: 'user', catalogUrl: 'https://user.example.com' },
      project: { defaultScope: 'project', catalogUrl: 'https://project.example.com' },
      env: { RIGGER_CATALOG_URL: 'https://env.example.com', RIGGER_SCOPE: 'project' },
      flags: { defaultScope: 'user', catalogUrl: 'https://flags.example.com' },
    });
    expect(config.defaultScope).toBe('user');
    expect(config.catalogUrl).toBe('https://flags.example.com');
  });

  it('absent field in higher-priority layer does not erase lower-priority value', () => {
    const config = resolveConfig({
      preset: { catalogUrl: 'https://preset.example.com' },
      flags: { defaultScope: 'project' },
    });
    expect(config.catalogUrl).toBe('https://preset.example.com');
    expect(config.defaultScope).toBe('project');
  });

  it('maps RIGGER_CATALOG_URL env var to catalogUrl', () => {
    const config = resolveConfig({ env: { RIGGER_CATALOG_URL: 'https://env.example.com' } });
    expect(config.catalogUrl).toBe('https://env.example.com');
  });

  it('maps RIGGER_SCOPE env var to defaultScope', () => {
    const config = resolveConfig({ env: { RIGGER_SCOPE: 'project' } });
    expect(config.defaultScope).toBe('project');
  });

  it('maps RIGGER_AUTH_METHOD env var to authMethod', () => {
    const config = resolveConfig({ env: { RIGGER_AUTH_METHOD: 'ssh' } });
    expect(config.authMethod).toBe('ssh');
  });

  it('ignores empty env values', () => {
    const config = resolveConfig({
      user: { catalogUrl: 'https://user.example.com' },
      env: { RIGGER_CATALOG_URL: '' },
    });
    expect(config.catalogUrl).toBe('https://user.example.com');
  });

  it('ignores unknown env keys', () => {
    const config = resolveConfig({ env: { RIGGER_UNKNOWN_KEY: 'foo', SOME_OTHER: 'bar' } });
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('ignores invalid RIGGER_SCOPE enum value — does not override lower priority', () => {
    const config = resolveConfig({
      user: { defaultScope: 'project' },
      env: { RIGGER_SCOPE: 'invalid-scope' },
    });
    expect(config.defaultScope).toBe('project');
  });

  it('ignores invalid RIGGER_AUTH_METHOD enum value', () => {
    const config = resolveConfig({
      user: { authMethod: 'ssh' },
      env: { RIGGER_AUTH_METHOD: 'not-a-valid-method' },
    });
    expect(config.authMethod).toBe('ssh');
  });

  it('accepts all valid defaultScope values', () => {
    const user = resolveConfig({ flags: { defaultScope: 'user' } });
    expect(user.defaultScope).toBe('user');

    const project = resolveConfig({ flags: { defaultScope: 'project' } });
    expect(project.defaultScope).toBe('project');
  });

  it('accepts all valid authMethod values', () => {
    for (const method of ['provider-cli', 'https', 'ssh'] as const) {
      const config = resolveConfig({ flags: { authMethod: method } });
      expect(config.authMethod).toBe(method);
    }
  });
});

// ---------------------------------------------------------------------------
// loadConfigFile
// ---------------------------------------------------------------------------

describe('loadConfigFile', () => {
  it('returns {} when the file does not exist', async () => {
    const result = await loadConfigFile(path.join(tmpDir, 'missing.jsonc'));
    expect(result).toEqual({});
  });

  it('parses a plain JSON file', async () => {
    const filePath = path.join(tmpDir, 'config.jsonc');
    const data: Partial<Config> = { defaultScope: 'project', catalogUrl: 'https://example.com' };
    await fs.writeFile(filePath, JSON.stringify(data), 'utf-8');

    const result = await loadConfigFile(filePath);
    expect(result).toEqual(data);
  });

  it('parses JSONC with single-line comments', async () => {
    const filePath = path.join(tmpDir, 'config.jsonc');
    const content = `{
  // The catalog URL
  "catalogUrl": "https://example.com",
  "defaultScope": "user"
}`;
    await fs.writeFile(filePath, content, 'utf-8');

    const result = await loadConfigFile(filePath);
    expect(result.catalogUrl).toBe('https://example.com');
    expect(result.defaultScope).toBe('user');
  });

  it('parses JSONC with block comments', async () => {
    const filePath = path.join(tmpDir, 'config.jsonc');
    const content = `{
  /* block comment */
  "defaultScope": "project"
}`;
    await fs.writeFile(filePath, content, 'utf-8');

    const result = await loadConfigFile(filePath);
    expect(result.defaultScope).toBe('project');
  });

  it('parses JSONC with trailing commas', async () => {
    const filePath = path.join(tmpDir, 'config.jsonc');
    const content = `{
  "defaultScope": "user",
  "catalogUrl": "https://example.com",
}`;
    await fs.writeFile(filePath, content, 'utf-8');

    const result = await loadConfigFile(filePath);
    expect(result.defaultScope).toBe('user');
    expect(result.catalogUrl).toBe('https://example.com');
  });

  it('parses JSONC with both comments and trailing commas', async () => {
    const filePath = path.join(tmpDir, 'config.jsonc');
    const content = `{
  // scope for this project
  "defaultScope": "project", // inline comment
  "authMethod": "ssh",
}`;
    await fs.writeFile(filePath, content, 'utf-8');

    const result = await loadConfigFile(filePath);
    expect(result.defaultScope).toBe('project');
    expect(result.authMethod).toBe('ssh');
  });

  it('throws InvalidConfigError with the file path when the file contains invalid JSONC', async () => {
    const filePath = path.join(tmpDir, 'broken.jsonc');
    await fs.writeFile(filePath, '{ not: valid at all ::::', 'utf-8');

    await expect(loadConfigFile(filePath)).rejects.toThrow(InvalidConfigError);

    let caught: unknown;
    try {
      await loadConfigFile(filePath);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidConfigError);
    expect((caught as InvalidConfigError).path).toBe(filePath);
  });

  it('ignores unknown keys in config file', async () => {
    const filePath = path.join(tmpDir, 'config.jsonc');
    const content = JSON.stringify({ defaultScope: 'user', unknownKey: 'value', another: 42 });
    await fs.writeFile(filePath, content, 'utf-8');

    const result = await loadConfigFile(filePath);
    expect(result.defaultScope).toBe('user');
    // Unknown keys must not appear in the returned Partial<Config>
    expect(Object.keys(result)).not.toContain('unknownKey');
    expect(Object.keys(result)).not.toContain('another');
  });
});

// ---------------------------------------------------------------------------
// persistConfig
// ---------------------------------------------------------------------------

describe('persistConfig', () => {
  it('writes a file readable by loadConfigFile (round-trip)', async () => {
    const filePath = path.join(tmpDir, 'config.jsonc');
    const config: Config = {
      defaultScope: 'project',
      catalogUrl: 'https://example.com',
      catalogs: [],
    };

    await persistConfig(filePath, config);
    const reloaded = await loadConfigFile(filePath);

    expect(reloaded.defaultScope).toBe(config.defaultScope);
    expect(reloaded.catalogUrl).toBe(config.catalogUrl);
  });

  it('creates parent directories if missing', async () => {
    const filePath = path.join(tmpDir, 'nested', 'deep', 'config.jsonc');
    const config: Config = { defaultScope: 'user', catalogs: [] };

    await persistConfig(filePath, config);
    const reloaded = await loadConfigFile(filePath);

    expect(reloaded.defaultScope).toBe('user');
  });

  it('overwrites an existing file', async () => {
    const filePath = path.join(tmpDir, 'config.jsonc');

    await persistConfig(filePath, { defaultScope: 'user' });
    await persistConfig(filePath, { defaultScope: 'project' });

    const reloaded = await loadConfigFile(filePath);
    expect(reloaded.defaultScope).toBe('project');
  });

  it('written file contains a header comment', async () => {
    const filePath = path.join(tmpDir, 'config.jsonc');
    await persistConfig(filePath, { defaultScope: 'user' });

    const raw = await fs.readFile(filePath, 'utf-8');
    expect(raw).toMatch(/\/\//);
  });
});

// ---------------------------------------------------------------------------
// loadConfig — end-to-end (with I/O)
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  it('returns defaults when no config files exist', async () => {
    const config = await loadConfig({
      projectConfigPath: path.join(tmpDir, 'project.jsonc'),
      userConfigPath: path.join(tmpDir, 'user.jsonc'),
    });

    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('user config overrides defaults', async () => {
    const userPath = path.join(tmpDir, 'user.jsonc');
    await persistConfig(userPath, { defaultScope: 'project' });

    const config = await loadConfig({
      projectConfigPath: path.join(tmpDir, 'project.jsonc'),
      userConfigPath: userPath,
    });

    expect(config.defaultScope).toBe('project');
  });

  it('project config overrides user config', async () => {
    const userPath = path.join(tmpDir, 'user.jsonc');
    const projectPath = path.join(tmpDir, 'project.jsonc');

    await persistConfig(userPath, { defaultScope: 'user', catalogUrl: 'https://user.example.com' });
    await persistConfig(projectPath, { catalogUrl: 'https://project.example.com' });

    const config = await loadConfig({
      projectConfigPath: projectPath,
      userConfigPath: userPath,
    });

    expect(config.catalogUrl).toBe('https://project.example.com');
    expect(config.defaultScope).toBe('user');
  });

  it('preset config is overridden by user and project', async () => {
    const presetPath = path.join(tmpDir, 'preset.jsonc');
    const userPath = path.join(tmpDir, 'user.jsonc');

    await persistConfig(presetPath, {
      catalogUrl: 'https://preset.example.com',
      defaultScope: 'user',
    });
    await persistConfig(userPath, { catalogUrl: 'https://user.example.com' });

    const config = await loadConfig({
      projectConfigPath: path.join(tmpDir, 'project.jsonc'),
      userConfigPath: userPath,
      presetConfigPath: presetPath,
    });

    expect(config.catalogUrl).toBe('https://user.example.com');
  });

  it('flags override everything', async () => {
    const userPath = path.join(tmpDir, 'user.jsonc');
    await persistConfig(userPath, {
      defaultScope: 'project',
      catalogUrl: 'https://user.example.com',
    });

    const config = await loadConfig({
      projectConfigPath: path.join(tmpDir, 'project.jsonc'),
      userConfigPath: userPath,
      flags: { defaultScope: 'user', catalogUrl: 'https://flags.example.com' },
    });

    expect(config.defaultScope).toBe('user');
    expect(config.catalogUrl).toBe('https://flags.example.com');
  });

  it('env vars override file-based config', async () => {
    const userPath = path.join(tmpDir, 'user.jsonc');
    await persistConfig(userPath, { defaultScope: 'user' });

    const config = await loadConfig({
      projectConfigPath: path.join(tmpDir, 'project.jsonc'),
      userConfigPath: userPath,
      env: { RIGGER_SCOPE: 'project' },
    });

    expect(config.defaultScope).toBe('project');
  });

  it('full priority chain: flags > env > project > user > preset > defaults', async () => {
    const presetPath = path.join(tmpDir, 'preset.jsonc');
    const userPath = path.join(tmpDir, 'user.jsonc');
    const projectPath = path.join(tmpDir, 'project.jsonc');

    await persistConfig(presetPath, {
      authMethod: 'provider-cli',
      catalogUrl: 'https://preset.example.com',
    });
    await persistConfig(userPath, { authMethod: 'https', catalogUrl: 'https://user.example.com' });
    await persistConfig(projectPath, { authMethod: 'ssh' });

    const config = await loadConfig({
      projectConfigPath: projectPath,
      userConfigPath: userPath,
      presetConfigPath: presetPath,
      env: { RIGGER_CATALOG_URL: 'https://env.example.com' },
      flags: { defaultScope: 'project' },
    });

    expect(config.authMethod).toBe('ssh');
    expect(config.catalogUrl).toBe('https://env.example.com');
    expect(config.defaultScope).toBe('project');
  });
});

// ---------------------------------------------------------------------------
// M1 — catalogs[] (additif)
// ---------------------------------------------------------------------------

describe('DEFAULT_CONFIG — catalogs', () => {
  it('catalogs defaults to empty array', () => {
    expect(DEFAULT_CONFIG.catalogs).toEqual([]);
  });
});

describe('loadConfigFile — catalogs', () => {
  it('maps a valid catalogs array from a config file', async () => {
    const filePath = path.join(tmpDir, 'config.jsonc');
    const content = JSON.stringify({
      catalogs: [
        { name: 'official', url: 'https://catalog.example.com' },
        { name: 'local', url: 'https://local.example.com' },
      ],
    });
    await fs.writeFile(filePath, content, 'utf-8');

    const result = await loadConfigFile(filePath);
    expect(result.catalogs).toEqual([
      { name: 'official', url: 'https://catalog.example.com' },
      { name: 'local', url: 'https://local.example.com' },
    ]);
  });

  it('ignores catalog entries missing url', async () => {
    const filePath = path.join(tmpDir, 'config.jsonc');
    const content = JSON.stringify({
      catalogs: [
        { name: 'valid', url: 'https://valid.example.com' },
        { name: 'no-url' },
        { url: 'https://no-name.example.com' },
        'not-an-object',
        42,
      ],
    });
    await fs.writeFile(filePath, content, 'utf-8');

    const result = await loadConfigFile(filePath);
    expect(result.catalogs).toEqual([
      { name: 'valid', url: 'https://valid.example.com' },
    ]);
  });

  it('ignores catalogs key if value is not an array', async () => {
    const filePath = path.join(tmpDir, 'config.jsonc');
    const content = JSON.stringify({ catalogs: 'not-an-array' });
    await fs.writeFile(filePath, content, 'utf-8');

    const result = await loadConfigFile(filePath);
    expect(result.catalogs).toBeUndefined();
  });

  it('ignores catalog entries with empty url', async () => {
    const filePath = path.join(tmpDir, 'config.jsonc');
    const content = JSON.stringify({
      catalogs: [
        { name: 'valid', url: 'https://valid.example.com' },
        { name: 'empty-url', url: '' },
        { name: 'empty-name', url: 'https://empty-name.example.com' },
      ],
    });
    await fs.writeFile(filePath, content, 'utf-8');

    const result = await loadConfigFile(filePath);
    expect(result.catalogs).toEqual([
      { name: 'valid', url: 'https://valid.example.com' },
      { name: 'empty-name', url: 'https://empty-name.example.com' },
    ]);
  });

  it('catalogUrl continues to load normally (non-regression)', async () => {
    const filePath = path.join(tmpDir, 'config.jsonc');
    const content = JSON.stringify({
      catalogUrl: 'https://legacy.example.com',
      defaultScope: 'project',
    });
    await fs.writeFile(filePath, content, 'utf-8');

    const result = await loadConfigFile(filePath);
    expect(result.catalogUrl).toBe('https://legacy.example.com');
    expect(result.defaultScope).toBe('project');
  });
});

describe('resolveConfig — catalogs layer semantics', () => {
  it('catalogs in project layer replaces catalogs from user layer (no merge)', () => {
    const config = resolveConfig({
      user: {
        catalogs: [{ name: 'user-cat', url: 'https://user.example.com' }],
      },
      project: {
        catalogs: [{ name: 'project-cat', url: 'https://project.example.com' }],
      },
    });
    expect(config.catalogs).toEqual([
      { name: 'project-cat', url: 'https://project.example.com' },
    ]);
  });

  it('user catalogs preserved when project does not define catalogs', () => {
    const config = resolveConfig({
      user: {
        catalogs: [{ name: 'user-cat', url: 'https://user.example.com' }],
      },
      project: { defaultScope: 'project' },
    });
    expect(config.catalogs).toEqual([
      { name: 'user-cat', url: 'https://user.example.com' },
    ]);
  });

  it('flags catalogs replaces all lower-priority catalogs', () => {
    const config = resolveConfig({
      user: { catalogs: [{ name: 'user-cat', url: 'https://user.example.com' }] },
      project: { catalogs: [{ name: 'project-cat', url: 'https://project.example.com' }] },
      flags: { catalogs: [{ name: 'flags-cat', url: 'https://flags.example.com' }] },
    });
    expect(config.catalogs).toEqual([
      { name: 'flags-cat', url: 'https://flags.example.com' },
    ]);
  });

  it('empty catalogs array in higher-priority layer replaces lower-priority catalogs', () => {
    const config = resolveConfig({
      user: { catalogs: [{ name: 'user-cat', url: 'https://user.example.com' }] },
      project: { catalogs: [] },
    });
    expect(config.catalogs).toEqual([]);
  });
});

describe('persistConfig — catalogs round-trip', () => {
  it('persists and reloads catalogs array identically', async () => {
    const filePath = path.join(tmpDir, 'config.jsonc');
    const catalogs = [
      { name: 'primary', url: 'https://primary.example.com' },
      { name: 'secondary', url: 'https://secondary.example.com' },
    ];

    await persistConfig(filePath, { catalogs });
    const reloaded = await loadConfigFile(filePath);

    expect(reloaded.catalogs).toEqual(catalogs);
  });

  it('persists empty catalogs array and reloads it', async () => {
    const filePath = path.join(tmpDir, 'config.jsonc');

    await persistConfig(filePath, { catalogs: [] });
    const reloaded = await loadConfigFile(filePath);

    expect(reloaded.catalogs).toEqual([]);
  });
});
