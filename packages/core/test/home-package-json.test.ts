/**
 * Tests for home-package-json.ts (U1, lib-imports-alias) — the pure merge
 * logic behind the home rigger's managed `package.json` `#libs/*` mapping.
 *
 * Contract (brief.md U1):
 *   (a) absent  → created: `{ name: 'agent-rigger-home', imports: { '#libs/*': './libs/*' } }`.
 *   (b) present, mapping absent/different → leaf-granularity merge: ONLY the
 *       `imports['#libs/*']` leaf is touched, every other top-level key AND
 *       every other `imports` leaf survives verbatim.
 *   (c) present, mapping already correct → no-op (`changed: false`), so the
 *       engine performs zero I/O (idempotent).
 */

import { describe, expect, it } from 'bun:test';

import {
  hasLibsImportMapping,
  LIBS_IMPORT_SPECIFIER,
  LIBS_IMPORT_TARGET,
  mergeLibsImportMapping,
} from '../src/home-package-json';

describe('home-package-json: constants', () => {
  it('the managed specifier/target pair matches the ratified convention', () => {
    expect(LIBS_IMPORT_SPECIFIER).toBe('#libs/*');
    expect(LIBS_IMPORT_TARGET).toBe('./libs/*');
  });
});

describe('home-package-json: hasLibsImportMapping', () => {
  it('false when imports is absent', () => {
    expect(hasLibsImportMapping({})).toBe(false);
  });

  it('false when imports is present but lacks the #libs/* leaf', () => {
    expect(hasLibsImportMapping({ imports: { '#other/*': './other/*' } })).toBe(false);
  });

  it('false when the #libs/* leaf points to a DIFFERENT target', () => {
    expect(hasLibsImportMapping({ imports: { '#libs/*': './elsewhere/*' } })).toBe(false);
  });

  it('true when the #libs/* leaf matches exactly', () => {
    expect(hasLibsImportMapping({ imports: { '#libs/*': './libs/*' } })).toBe(true);
  });

  it('false when imports is a non-object (malformed)', () => {
    expect(hasLibsImportMapping({ imports: 'not-an-object' })).toBe(false);
    expect(hasLibsImportMapping({ imports: ['#libs/*'] })).toBe(false);
  });
});

describe('home-package-json: mergeLibsImportMapping — case (a) absent → fresh stub', () => {
  it('undefined current produces the sober fresh stub, changed=true', () => {
    const { result, changed } = mergeLibsImportMapping(undefined);
    expect(changed).toBe(true);
    expect(result).toEqual({
      name: 'agent-rigger-home',
      imports: { '#libs/*': './libs/*' },
    });
  });
});

describe('home-package-json: mergeLibsImportMapping — case (b) present, leaf-granularity merge', () => {
  it('mapping absent from an existing file: other top-level keys survive verbatim', () => {
    const current = {
      name: 'someone-elses-name',
      version: '1.0.0',
      dependencies: { zod: '^3.0.0' },
    };
    const { result, changed } = mergeLibsImportMapping(current);
    expect(changed).toBe(true);
    expect(result).toEqual({
      name: 'someone-elses-name',
      version: '1.0.0',
      dependencies: { zod: '^3.0.0' },
      imports: { '#libs/*': './libs/*' },
    });
  });

  it('other imports leaves survive untouched — only #libs/* is added', () => {
    const current = { imports: { '#other/*': './other/*' } };
    const { result, changed } = mergeLibsImportMapping(current);
    expect(changed).toBe(true);
    expect(result).toEqual({
      imports: { '#other/*': './other/*', '#libs/*': './libs/*' },
    });
  });

  it('a DIVERGENT #libs/* leaf (drifted or hand-edited) is corrected to the canonical target', () => {
    const current = { imports: { '#libs/*': './some/stale/path/*', '#other/*': './other/*' } };
    const { result, changed } = mergeLibsImportMapping(current);
    expect(changed).toBe(true);
    expect(result).toEqual({
      imports: { '#libs/*': './libs/*', '#other/*': './other/*' },
    });
  });

  it('a malformed (non-object) imports value is replaced by a proper object carrying only the managed leaf', () => {
    const current = { name: 'x', imports: 'not-an-object' as unknown };
    const { result, changed } = mergeLibsImportMapping(current as Record<string, unknown>);
    expect(changed).toBe(true);
    expect(result).toEqual({ name: 'x', imports: { '#libs/*': './libs/*' } });
  });

  it('never adds a "name" field to an existing file that never had one', () => {
    const current = { dependencies: {} };
    const { result } = mergeLibsImportMapping(current);
    expect(result['name']).toBeUndefined();
  });

  it('a PRESENT-but-EMPTY file ({}) is case (b), not case (a): no "name" stub added', () => {
    // The crux of the absent/present distinction: `undefined` (genuinely no
    // file on disk) gets the sober stub; `{}` (a file that EXISTS and parses
    // to an empty object) never does, even though both "have no keys".
    const { result, changed } = mergeLibsImportMapping({});
    expect(changed).toBe(true);
    expect(result).toEqual({ imports: { '#libs/*': './libs/*' } });
    expect(result['name']).toBeUndefined();
  });
});

describe('home-package-json: mergeLibsImportMapping — case (c) already correct → no-op', () => {
  it('changed=false and the SAME object shape when the mapping is already exact', () => {
    const current = { name: 'agent-rigger-home', imports: { '#libs/*': './libs/*' } };
    const { result, changed } = mergeLibsImportMapping(current);
    expect(changed).toBe(false);
    expect(result).toEqual(current);
  });

  it('idempotent: merging twice yields the identical result', () => {
    const first = mergeLibsImportMapping(undefined);
    const second = mergeLibsImportMapping(first.result);
    expect(second.changed).toBe(false);
    expect(second.result).toEqual(first.result);
  });
});
