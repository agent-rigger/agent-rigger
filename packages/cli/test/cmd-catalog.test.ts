/**
 * M5 — tests for cmd-catalog.ts (catalog ls|add|remove).
 *
 * Isolation: tmp dir per test via RIGGER_HOME env injection.
 * No real network, no real git, no process.exit.
 *
 * Scenarios:
 *  ls  — 0 sources → actionable message
 *  ls  — N sources → all listed
 *  add — nominal → persists, ls shows it
 *  add — duplicate name → exit 2, config unchanged
 *  add — missing args → exit 2
 *  remove — present → removed
 *  remove — absent → exit 2 message
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runCatalog } from '../src/cmd-catalog';
import { loadConfigFile } from '../src/config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCapture(): { lines: string[]; print: (msg: string) => void } {
  const lines: string[] = [];
  return { lines, print: (msg: string) => lines.push(msg) };
}

let tmpDir: string;
let configPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-cmd-catalog-'));
  configPath = path.join(tmpDir, 'config.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// catalog ls
// ---------------------------------------------------------------------------

describe('catalog ls — empty config', () => {
  it('returns exit code 0', async () => {
    const cap = makeCapture();
    const code = await runCatalog({ verb: 'ls', args: [], configPath, print: cap.print });
    expect(code).toBe(0);
  });

  it('prints an actionable message when no catalogs configured', async () => {
    const cap = makeCapture();
    await runCatalog({ verb: 'ls', args: [], configPath, print: cap.print });
    const out = cap.lines.join('\n');
    expect(out).toMatch(/aucun catalog|init|catalog add/i);
  });
});

describe('catalog ls — with sources', () => {
  beforeEach(async () => {
    await Bun.write(
      configPath,
      JSON.stringify({
        catalogs: [
          { name: 'principal', url: 'https://example.com/a.git' },
          { name: 'secondary', url: 'https://example.com/b.git' },
        ],
      }),
    );
  });

  it('returns exit code 0', async () => {
    const cap = makeCapture();
    const code = await runCatalog({ verb: 'ls', args: [], configPath, print: cap.print });
    expect(code).toBe(0);
  });

  it('lists all configured catalogs with name and url', async () => {
    const cap = makeCapture();
    await runCatalog({ verb: 'ls', args: [], configPath, print: cap.print });
    const out = cap.lines.join('\n');
    expect(out).toContain('principal');
    expect(out).toContain('https://example.com/a.git');
    expect(out).toContain('secondary');
    expect(out).toContain('https://example.com/b.git');
  });
});

// ---------------------------------------------------------------------------
// catalog add — nominal
// ---------------------------------------------------------------------------

describe('catalog add — nominal', () => {
  it('returns exit code 0', async () => {
    const cap = makeCapture();
    const code = await runCatalog({
      verb: 'add',
      args: ['principal', 'https://example.com/a.git'],
      configPath,
      print: cap.print,
    });
    expect(code).toBe(0);
  });

  it('persists the new catalog source to config', async () => {
    const cap = makeCapture();
    await runCatalog({
      verb: 'add',
      args: ['principal', 'https://example.com/a.git'],
      configPath,
      print: cap.print,
    });

    const cfg = await loadConfigFile(configPath);
    expect(cfg.catalogs).toHaveLength(1);
    expect(cfg.catalogs?.[0]).toEqual({ name: 'principal', url: 'https://example.com/a.git' });
  });

  it('prints a confirmation message', async () => {
    const cap = makeCapture();
    await runCatalog({
      verb: 'add',
      args: ['principal', 'https://example.com/a.git'],
      configPath,
      print: cap.print,
    });
    const out = cap.lines.join('\n');
    expect(out).toContain('principal');
  });

  it('ls shows the added catalog after add', async () => {
    const addCap = makeCapture();
    await runCatalog({
      verb: 'add',
      args: ['principal', 'https://example.com/a.git'],
      configPath,
      print: addCap.print,
    });

    const lsCap = makeCapture();
    await runCatalog({ verb: 'ls', args: [], configPath, print: lsCap.print });
    const out = lsCap.lines.join('\n');
    expect(out).toContain('principal');
    expect(out).toContain('https://example.com/a.git');
  });

  it('appends a second catalog without overwriting the first', async () => {
    await runCatalog({
      verb: 'add',
      args: ['a', 'https://example.com/a.git'],
      configPath,
      print: () => {},
    });
    await runCatalog({
      verb: 'add',
      args: ['b', 'https://example.com/b.git'],
      configPath,
      print: () => {},
    });

    const cfg = await loadConfigFile(configPath);
    expect(cfg.catalogs).toHaveLength(2);
    const names = (cfg.catalogs ?? []).map((c) => c.name);
    expect(names).toContain('a');
    expect(names).toContain('b');
  });
});

// ---------------------------------------------------------------------------
// catalog add — duplicate name
// ---------------------------------------------------------------------------

describe('catalog add — duplicate name', () => {
  beforeEach(async () => {
    await Bun.write(
      configPath,
      JSON.stringify({
        catalogs: [{ name: 'principal', url: 'https://example.com/a.git' }],
      }),
    );
  });

  it('returns exit code 2 when name already exists', async () => {
    const cap = makeCapture();
    const code = await runCatalog({
      verb: 'add',
      args: ['principal', 'https://example.com/other.git'],
      configPath,
      print: cap.print,
    });
    expect(code).toBe(2);
  });

  it('prints rejection message with the duplicate name', async () => {
    const cap = makeCapture();
    await runCatalog({
      verb: 'add',
      args: ['principal', 'https://example.com/other.git'],
      configPath,
      print: cap.print,
    });
    const out = cap.lines.join('\n');
    expect(out).toContain('principal');
    expect(out).toMatch(/existe déjà|already exists/i);
  });

  it('does not modify config when name already exists', async () => {
    await runCatalog({
      verb: 'add',
      args: ['principal', 'https://example.com/other.git'],
      configPath,
      print: () => {},
    });

    const cfg = await loadConfigFile(configPath);
    expect(cfg.catalogs).toHaveLength(1);
    expect(cfg.catalogs?.[0]?.url).toBe('https://example.com/a.git');
  });
});

// ---------------------------------------------------------------------------
// catalog add — missing args
// ---------------------------------------------------------------------------

describe('catalog add — missing args', () => {
  it('returns exit code 2 when name is missing', async () => {
    const cap = makeCapture();
    const code = await runCatalog({ verb: 'add', args: [], configPath, print: cap.print });
    expect(code).toBe(2);
  });

  it('returns exit code 2 when url is missing (only name provided)', async () => {
    const cap = makeCapture();
    const code = await runCatalog({
      verb: 'add',
      args: ['principal'],
      configPath,
      print: cap.print,
    });
    expect(code).toBe(2);
  });

  it('returns exit code 2 when name is empty string', async () => {
    const cap = makeCapture();
    const code = await runCatalog({
      verb: 'add',
      args: ['', 'https://example.com/a.git'],
      configPath,
      print: cap.print,
    });
    expect(code).toBe(2);
  });

  it('returns exit code 2 when url is empty string', async () => {
    const cap = makeCapture();
    const code = await runCatalog({
      verb: 'add',
      args: ['principal', ''],
      configPath,
      print: cap.print,
    });
    expect(code).toBe(2);
  });

  it('prints an error message mentioning the required args', async () => {
    const cap = makeCapture();
    await runCatalog({ verb: 'add', args: [], configPath, print: cap.print });
    const out = cap.lines.join('\n');
    expect(out).toMatch(/name|url|argument/i);
  });
});

// ---------------------------------------------------------------------------
// catalog remove — present
// ---------------------------------------------------------------------------

describe('catalog remove — present', () => {
  beforeEach(async () => {
    await Bun.write(
      configPath,
      JSON.stringify({
        catalogs: [
          { name: 'principal', url: 'https://example.com/a.git' },
          { name: 'secondary', url: 'https://example.com/b.git' },
        ],
      }),
    );
  });

  it('returns exit code 0', async () => {
    const cap = makeCapture();
    const code = await runCatalog({
      verb: 'remove',
      args: ['principal'],
      configPath,
      print: cap.print,
    });
    expect(code).toBe(0);
  });

  it('removes the catalog from the config', async () => {
    await runCatalog({
      verb: 'remove',
      args: ['principal'],
      configPath,
      print: () => {},
    });

    const cfg = await loadConfigFile(configPath);
    expect(cfg.catalogs).toHaveLength(1);
    expect(cfg.catalogs?.[0]?.name).toBe('secondary');
  });

  it('persists remaining catalogs correctly', async () => {
    await runCatalog({
      verb: 'remove',
      args: ['secondary'],
      configPath,
      print: () => {},
    });

    const cfg = await loadConfigFile(configPath);
    expect(cfg.catalogs).toHaveLength(1);
    expect(cfg.catalogs?.[0]?.name).toBe('principal');
  });

  it('ls no longer shows the removed catalog', async () => {
    await runCatalog({
      verb: 'remove',
      args: ['principal'],
      configPath,
      print: () => {},
    });

    const lsCap = makeCapture();
    await runCatalog({ verb: 'ls', args: [], configPath, print: lsCap.print });
    const out = lsCap.lines.join('\n');
    expect(out).not.toContain('principal');
  });
});

// ---------------------------------------------------------------------------
// catalog remove — absent
// ---------------------------------------------------------------------------

describe('catalog remove — absent name', () => {
  beforeEach(async () => {
    await Bun.write(
      configPath,
      JSON.stringify({
        catalogs: [{ name: 'principal', url: 'https://example.com/a.git' }],
      }),
    );
  });

  it('returns exit code 2 when name not found', async () => {
    const cap = makeCapture();
    const code = await runCatalog({
      verb: 'remove',
      args: ['nonexistent'],
      configPath,
      print: cap.print,
    });
    expect(code).toBe(2);
  });

  it('prints an introuvable message', async () => {
    const cap = makeCapture();
    await runCatalog({
      verb: 'remove',
      args: ['nonexistent'],
      configPath,
      print: cap.print,
    });
    const out = cap.lines.join('\n');
    expect(out).toContain('nonexistent');
    expect(out).toMatch(/introuvable|not found/i);
  });

  it('does not modify config when name not found', async () => {
    await runCatalog({
      verb: 'remove',
      args: ['nonexistent'],
      configPath,
      print: () => {},
    });

    const cfg = await loadConfigFile(configPath);
    expect(cfg.catalogs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// catalog remove — missing arg
// ---------------------------------------------------------------------------

describe('catalog remove — missing arg', () => {
  it('returns exit code 2 when no name provided', async () => {
    const cap = makeCapture();
    const code = await runCatalog({
      verb: 'remove',
      args: [],
      configPath,
      print: cap.print,
    });
    expect(code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// catalog — unknown verb
// ---------------------------------------------------------------------------

describe('catalog — unknown verb', () => {
  it('returns exit code 2 for unknown verb', async () => {
    const cap = makeCapture();
    const code = await runCatalog({
      verb: 'unknown',
      args: [],
      configPath,
      print: cap.print,
    });
    expect(code).toBe(2);
  });
});
