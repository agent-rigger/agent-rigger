import { describe, expect, it } from 'bun:test';

import { BUILTIN_CATALOG } from '../src/catalog.builtin';
import { DependencyCycleError, resolve, UnknownEntryError } from '../src/resolver';
import type { CatalogEntry } from '../src/schema';

// ---------------------------------------------------------------------------
// Helpers — minimal synthetic catalog builders
// ---------------------------------------------------------------------------

function artifact(id: string, requires?: string[]): CatalogEntry {
  return {
    kind: 'artifact',
    id,
    nature: 'tool',
    source: 'internal',
    targets: ['claude'],
    scopes: ['user'],
    ...(requires ? { requires } : {}),
  };
}

function pack(id: string, members: string[], requires?: string[]): CatalogEntry {
  return {
    kind: 'pack',
    id,
    source: 'internal',
    targets: ['claude'],
    scopes: ['user'],
    members,
    ...(requires ? { requires } : {}),
  };
}

// ---------------------------------------------------------------------------
// Case 1 — single artifact without deps
// ---------------------------------------------------------------------------

describe('resolve — artifact seul sans deps', () => {
  it('retourne uniquement lui-même', () => {
    const catalog: CatalogEntry[] = [artifact('tool:a')];
    const result = resolve(['tool:a'], catalog);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('tool:a');
  });
});

// ---------------------------------------------------------------------------
// Case 2 — artifact avec requires simple (ordre deps-first)
// ---------------------------------------------------------------------------

describe('resolve — artifact avec requires', () => {
  it("place la dépendance avant l'artefact", () => {
    const catalog: CatalogEntry[] = [artifact('tool:b'), artifact('tool:a', ['tool:b'])];
    const result = resolve(['tool:a'], catalog);
    expect(result.map((e) => e.id)).toEqual(['tool:b', 'tool:a']);
  });
});

// ---------------------------------------------------------------------------
// Case 3 — ordre transitif : a requires b requires c → [c, b, a]
// ---------------------------------------------------------------------------

describe('resolve — ordre transitif', () => {
  it('retourne [c, b, a] pour a→b→c', () => {
    const catalog: CatalogEntry[] = [
      artifact('tool:c'),
      artifact('tool:b', ['tool:c']),
      artifact('tool:a', ['tool:b']),
    ];
    const result = resolve(['tool:a'], catalog);
    expect(result.map((e) => e.id)).toEqual(['tool:c', 'tool:b', 'tool:a']);
  });
});

// ---------------------------------------------------------------------------
// Case 4 — pack:spec-workflow (BUILTIN) développé en 4 membres
// ---------------------------------------------------------------------------

describe('resolve — pack:spec-workflow (BUILTIN)', () => {
  it('développe le pack en ses 4 membres, pack absent de la sortie', () => {
    const result = resolve(['pack:spec-workflow'], BUILTIN_CATALOG);

    const ids = result.map((e) => e.id);

    // pack lui-même absent
    expect(ids).not.toContain('pack:spec-workflow');

    // 4 membres couverts
    expect(ids).toContain('skill:spec-workflow');
    expect(ids).toContain('agent:tech-lead');
    expect(ids).toContain('agent:pm');
    expect(ids).toContain('agent:reviewer');

    // skill:spec-workflow requires tool:glab → doit aussi être inclus
    expect(ids).toContain('tool:glab');

    // dépendances avant ceux qui les requirent
    const gIdx = ids.indexOf('tool:glab');
    const sIdx = ids.indexOf('skill:spec-workflow');
    expect(gIdx).toBeLessThan(sIdx);
  });
});

// ---------------------------------------------------------------------------
// Case 5 — skill:spec-workflow (BUILTIN) requiert tool:glab transitivement
// ---------------------------------------------------------------------------

describe('resolve — skill:spec-workflow (BUILTIN)', () => {
  it('inclut tool:glab via requires', () => {
    const result = resolve(['skill:spec-workflow'], BUILTIN_CATALOG);
    const ids = result.map((e) => e.id);
    expect(ids).toContain('tool:glab');
    expect(ids).toContain('skill:spec-workflow');
    expect(ids.indexOf('tool:glab')).toBeLessThan(ids.indexOf('skill:spec-workflow'));
  });
});

// ---------------------------------------------------------------------------
// Case 6 — déduplication : deux sélections partageant une dépendance
// ---------------------------------------------------------------------------

describe('resolve — déduplication', () => {
  it('la dépendance partagée apparaît une seule fois', () => {
    const catalog: CatalogEntry[] = [
      artifact('tool:shared'),
      artifact('tool:x', ['tool:shared']),
      artifact('tool:y', ['tool:shared']),
    ];
    const result = resolve(['tool:x', 'tool:y'], catalog);
    const ids = result.map((e) => e.id);
    expect(ids.filter((id) => id === 'tool:shared')).toHaveLength(1);
    expect(ids).toContain('tool:x');
    expect(ids).toContain('tool:y');
  });
});

// ---------------------------------------------------------------------------
// Case 7 — pack imbriqué (synthétique)
// ---------------------------------------------------------------------------

describe('resolve — pack imbriqué', () => {
  it('développe récursivement un pack dont un membre est un pack', () => {
    const catalog: CatalogEntry[] = [
      artifact('tool:leaf'),
      pack('pack:inner', ['tool:leaf']),
      pack('pack:outer', ['pack:inner']),
    ];
    const result = resolve(['pack:outer'], catalog);
    const ids = result.map((e) => e.id);

    // aucun pack dans la sortie
    expect(ids).not.toContain('pack:outer');
    expect(ids).not.toContain('pack:inner');

    // l'artefact feuille présent
    expect(ids).toContain('tool:leaf');
  });
});

// ---------------------------------------------------------------------------
// Case 8 — id inconnu dans la sélection → UnknownEntryError
// ---------------------------------------------------------------------------

describe('resolve — id inconnu (sélection)', () => {
  it("lance UnknownEntryError avec l'id fautif", () => {
    const catalog: CatalogEntry[] = [artifact('tool:a')];
    expect(() => resolve(['tool:ghost'], catalog)).toThrow(UnknownEntryError);
    try {
      resolve(['tool:ghost'], catalog);
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownEntryError);
      expect((e as UnknownEntryError).unknownId).toBe('tool:ghost');
    }
  });
});

// ---------------------------------------------------------------------------
// Case 9 — id inconnu dans requires → UnknownEntryError
// ---------------------------------------------------------------------------

describe('resolve — id inconnu dans requires', () => {
  it('lance UnknownEntryError pour le requires absent', () => {
    const catalog: CatalogEntry[] = [artifact('tool:a', ['tool:missing'])];
    expect(() => resolve(['tool:a'], catalog)).toThrow(UnknownEntryError);
    try {
      resolve(['tool:a'], catalog);
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownEntryError);
      expect((e as UnknownEntryError).unknownId).toBe('tool:missing');
    }
  });
});

// ---------------------------------------------------------------------------
// Case 10 — id inconnu dans members → UnknownEntryError
// ---------------------------------------------------------------------------

describe('resolve — id inconnu dans members', () => {
  it('lance UnknownEntryError pour le membre absent', () => {
    const catalog: CatalogEntry[] = [pack('pack:x', ['tool:absent'])];
    expect(() => resolve(['pack:x'], catalog)).toThrow(UnknownEntryError);
    try {
      resolve(['pack:x'], catalog);
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownEntryError);
      expect((e as UnknownEntryError).unknownId).toBe('tool:absent');
    }
  });
});

// ---------------------------------------------------------------------------
// Case 11 — cycle dans requires → DependencyCycleError
// ---------------------------------------------------------------------------

describe('resolve — cycle dans requires', () => {
  it('lance DependencyCycleError pour a→b→a', () => {
    const catalog: CatalogEntry[] = [
      artifact('tool:a', ['tool:b']),
      artifact('tool:b', ['tool:a']),
    ];
    expect(() => resolve(['tool:a'], catalog)).toThrow(DependencyCycleError);
    try {
      resolve(['tool:a'], catalog);
    } catch (e) {
      expect(e).toBeInstanceOf(DependencyCycleError);
      expect((e as DependencyCycleError).cyclePath).toContain('tool:a');
      expect((e as DependencyCycleError).cyclePath).toContain('tool:b');
    }
  });
});

// ---------------------------------------------------------------------------
// Case 12 — cycle dans members → DependencyCycleError
// ---------------------------------------------------------------------------

describe('resolve — cycle dans members (packs)', () => {
  it('lance DependencyCycleError pour pack:a membre de pack:b membre de pack:a', () => {
    const catalog: CatalogEntry[] = [
      pack('pack:a', ['pack:b']),
      pack('pack:b', ['pack:a']),
    ];
    expect(() => resolve(['pack:a'], catalog)).toThrow(DependencyCycleError);
  });
});

// ---------------------------------------------------------------------------
// Case 13 — sortie uniquement des ArtifactEntry (pas de packs)
// ---------------------------------------------------------------------------

describe('resolve — sortie uniquement ArtifactEntry', () => {
  it('aucun pack ne figure dans la sortie quelle que soit la sélection', () => {
    const catalog: CatalogEntry[] = [
      artifact('tool:leaf'),
      pack('pack:wrapper', ['tool:leaf']),
    ];
    const result = resolve(['pack:wrapper'], catalog);
    expect(result.every((e) => e.kind === 'artifact')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case 14 — sélection vide → tableau vide
// ---------------------------------------------------------------------------

describe('resolve — sélection vide', () => {
  it('retourne un tableau vide', () => {
    expect(resolve([], BUILTIN_CATALOG)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Case 15 — pack:baseline (BUILTIN) expansion récursive
// ---------------------------------------------------------------------------

describe('resolve — pack:baseline (BUILTIN)', () => {
  it('développe pack:baseline en 6 artefacts (4 guards + guardrails + context), aucun pack en sortie', () => {
    const result = resolve(['pack:baseline'], BUILTIN_CATALOG);
    const ids = result.map((e) => e.id);

    // Aucun pack dans la sortie
    expect(ids).not.toContain('pack:baseline');
    expect(ids).not.toContain('pack:harness');

    // 4 hook guards (via pack:harness expansé récursivement)
    expect(ids).toContain('hook:guard-command');
    expect(ids).toContain('hook:guard-secret');
    expect(ids).toContain('hook:guard-write-secret');
    expect(ids).toContain('hook:guard-prompt');

    // guardrails et context
    expect(ids).toContain('guardrails-claude');
    expect(ids).toContain('context-claude');
  });

  it('retourne exactement 6 artefacts (dédupliqués)', () => {
    const result = resolve(['pack:baseline'], BUILTIN_CATALOG);
    expect(result).toHaveLength(6);
  });

  it('tous les éléments de la sortie sont des ArtifactEntry (kind artifact)', () => {
    const result = resolve(['pack:baseline'], BUILTIN_CATALOG);
    expect(result.every((e) => e.kind === 'artifact')).toBe(true);
  });

  it('pack:baseline + pack:harness déduplique les guards (pas de doublon)', () => {
    const result = resolve(['pack:baseline', 'pack:harness'], BUILTIN_CATALOG);
    const ids = result.map((e) => e.id);
    const guardIds = [
      'hook:guard-command',
      'hook:guard-secret',
      'hook:guard-write-secret',
      'hook:guard-prompt',
    ];
    for (const id of guardIds) {
      expect(ids.filter((x) => x === id)).toHaveLength(1);
    }
  });
});
