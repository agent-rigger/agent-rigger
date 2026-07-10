/**
 * Lot 3 — R3: MalformedManifestError fail-closed (design D3).
 *
 * `readManifest` MUST refuse a state.json that is PRESENT but top-level invalid
 * (non-object, `version !== 1` number-strict, `artifacts` non-array) with a typed
 * `MalformedManifestError` — instead of silently coercing to emptyManifest() and
 * letting a later writeManifest overwrite the cumulated `applied` payloads (Lot 2)
 * and the `previous` baselines (M2 data-loss).
 *
 * The fail-closed frontier is TOP-LEVEL ONLY. Entry-level tolerance (legacy entries
 * with no `assistant`, no `applied`, a stray `source` field) is preserved — see
 * f2-manifest-retrocompat.test.ts, which must pass unchanged.
 *
 * An ABSENT file is NOT malformed: it remains emptyManifest() (fresh install).
 * `readJson` conflates absent and top-level-non-object (both → {}), so readManifest
 * tests existence separately to distinguish them.
 *
 * Syntactically broken JSON keeps its existing typed rejection (InvalidJsonError):
 * MalformedManifestError is strictly for valid-JSON / wrong-shape.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { InvalidJsonError } from '../src/fs-json';
import { emptyManifest, MalformedManifestError, readManifest } from '../src/manifest';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let statePath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-lot3-r3-'));
  statePath = path.join(tmpDir, 'state.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Assert readManifest rejects with a MalformedManifestError carrying the path. */
async function expectMalformed(filePath: string): Promise<MalformedManifestError> {
  try {
    await readManifest(filePath);
  } catch (err) {
    expect(err).toBeInstanceOf(MalformedManifestError);
    const e = err as MalformedManifestError;
    expect(e.path).toBe(filePath);
    expect(e.name).toBe('MalformedManifestError');
    return e;
  }
  throw new Error('expected readManifest to throw MalformedManifestError, but it resolved');
}

// ---------------------------------------------------------------------------
// version in string → fail-closed, file intact
// ---------------------------------------------------------------------------

describe('lot3-R3: version is not a number', () => {
  it('lot3-R3: a string "version" fails closed with MalformedManifestError', async () => {
    const raw = JSON.stringify({
      version: '1',
      artifacts: [
        { id: 'guardrails-claude', nature: 'guardrail', scope: 'user', files: [] },
      ],
    });
    await fs.writeFile(statePath, raw, 'utf-8');

    await expectMalformed(statePath);
  });

  it('lot3-R3: the manifest file is left byte-for-byte intact (no overwrite)', async () => {
    const raw = `${JSON.stringify({ version: '1', artifacts: [{ id: 'x' }] }, null, 2)}\n`;
    await fs.writeFile(statePath, raw, 'utf-8');

    await expectMalformed(statePath);

    const after = await fs.readFile(statePath, 'utf-8');
    expect(after).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// top-level non-object, distinguished from an ABSENT file
// ---------------------------------------------------------------------------

describe('lot3-R3: top-level is not an object', () => {
  it('lot3-R3: a top-level array fails closed', async () => {
    await fs.writeFile(statePath, '[]', 'utf-8');
    await expectMalformed(statePath);
  });

  it('lot3-R3: a top-level null fails closed', async () => {
    await fs.writeFile(statePath, 'null', 'utf-8');
    await expectMalformed(statePath);
  });

  it('lot3-R3: a present {} (no version/artifacts) fails closed', async () => {
    await fs.writeFile(statePath, '{}', 'utf-8');
    await expectMalformed(statePath);
  });

  it('lot3-R3: an ABSENT file stays emptyManifest() — distinguished from non-object', async () => {
    const missing = path.join(tmpDir, 'does-not-exist.json');
    const result = await readManifest(missing);
    expect(result).toEqual(emptyManifest());
  });
});

// ---------------------------------------------------------------------------
// unsupported version (number, but not 1)
// ---------------------------------------------------------------------------

describe('lot3-R3: unsupported manifest version', () => {
  it('lot3-R3: version:2 fails closed with an "unsupported version" reason', async () => {
    await fs.writeFile(statePath, JSON.stringify({ version: 2, artifacts: [] }), 'utf-8');
    const err = await expectMalformed(statePath);
    expect(err.reason.toLowerCase()).toContain('unsupported');
    expect(err.reason).toContain('2');
  });
});

// ---------------------------------------------------------------------------
// artifacts is not an array
// ---------------------------------------------------------------------------

describe('lot3-R3: artifacts is not an array', () => {
  it('lot3-R3: artifacts as a string fails closed', async () => {
    await fs.writeFile(
      statePath,
      JSON.stringify({ version: 1, artifacts: 'not-an-array' }),
      'utf-8',
    );
    await expectMalformed(statePath);
  });

  it('lot3-R3: artifacts as an object fails closed', async () => {
    await fs.writeFile(statePath, JSON.stringify({ version: 1, artifacts: {} }), 'utf-8');
    await expectMalformed(statePath);
  });
});

// ---------------------------------------------------------------------------
// entry-level tolerance preserved (retro-compat frontier is top-level only)
// ---------------------------------------------------------------------------

describe('lot3-R3: entry-level tolerance is preserved', () => {
  it('lot3-R3: a valid top-level manifest with legacy entries reads fine', async () => {
    const legacy = {
      version: 1,
      artifacts: [
        // No `assistant`, no `applied`, stray legacy `source` field.
        {
          id: 'guardrails-claude',
          nature: 'guardrail',
          source: 'internal',
          ref: 'v0.0.0',
          sha: '',
          scope: 'user',
          installedAt: '2026-01-01T00:00:00.000Z',
          files: [],
        },
      ],
    };
    await fs.writeFile(statePath, JSON.stringify(legacy), 'utf-8');

    const result = await readManifest(statePath);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]!.id).toBe('guardrails-claude');
    expect(result.artifacts[0]!.assistant).toBeUndefined();
  });

  it('lot3-R3: a valid empty manifest {version:1,artifacts:[]} reads fine', async () => {
    await fs.writeFile(statePath, JSON.stringify(emptyManifest()), 'utf-8');
    const result = await readManifest(statePath);
    expect(result).toEqual(emptyManifest());
  });
});

// ---------------------------------------------------------------------------
// syntactically broken JSON keeps InvalidJsonError (not MalformedManifestError)
// ---------------------------------------------------------------------------

describe('lot3-R3: syntactically broken JSON is InvalidJsonError, not Malformed', () => {
  it('lot3-R3: truncated JSON throws InvalidJsonError', async () => {
    await fs.writeFile(statePath, '{ "version": 1, "artifacts": [ ', 'utf-8');
    await expect(readManifest(statePath)).rejects.toBeInstanceOf(InvalidJsonError);
  });
});
