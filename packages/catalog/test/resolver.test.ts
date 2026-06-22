import { describe, expect, it } from 'bun:test';

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
    targets: ['claude'],
    scopes: ['user'],
    ...(requires ? { requires } : {}),
  };
}

function pack(id: string, members: string[], requires?: string[]): CatalogEntry {
  return {
    kind: 'pack',
    id,
    targets: ['claude'],
    scopes: ['user'],
    members,
    ...(requires ? { requires } : {}),
  };
}

// ---------------------------------------------------------------------------
// Fixture catalog (replaces BUILTIN_CATALOG for resolver tests)
// ---------------------------------------------------------------------------

const TOOL_A: CatalogEntry = artifact('tool:a');
const TOOL_B: CatalogEntry = artifact('tool:b');
const SKILL_X: CatalogEntry = {
  kind: 'artifact',
  id: 'skill:x',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user'],
  requires: ['tool:a'],
};
const AGENT_Y: CatalogEntry = {
  kind: 'artifact',
  id: 'agent:y',
  nature: 'agent',
  targets: ['claude'],
  scopes: ['user'],
};
const PACK_SIMPLE: CatalogEntry = {
  kind: 'pack',
  id: 'pack:simple',
  targets: ['claude'],
  scopes: ['user'],
  members: ['skill:x', 'agent:y'],
};

const HOOK_GUARD: CatalogEntry = {
  kind: 'artifact',
  id: 'hook:guard-cmd',
  nature: 'hook',
  targets: ['claude'],
  scopes: ['user'],
  event: 'PreToolUse',
  matcher: 'Bash',
  timeout: 5,
};
const HOOK_GUARD2: CatalogEntry = {
  kind: 'artifact',
  id: 'hook:guard-read',
  nature: 'hook',
  targets: ['claude'],
  scopes: ['user'],
  event: 'PreToolUse',
  matcher: 'Read|Edit',
  timeout: 5,
};
const GUARDRAIL_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'guardrails-main',
  nature: 'guardrail',
  targets: ['claude'],
  scopes: ['user', 'project'],
};
const CONTEXT_ENTRY: CatalogEntry = {
  kind: 'artifact',
  id: 'context-main',
  nature: 'context',
  targets: ['claude'],
  scopes: ['user', 'project'],
};
const PACK_HARNESS: CatalogEntry = {
  kind: 'pack',
  id: 'pack:harness',
  targets: ['claude'],
  scopes: ['user'],
  members: ['hook:guard-cmd', 'hook:guard-read'],
};
const PACK_BASELINE: CatalogEntry = {
  kind: 'pack',
  id: 'pack:baseline',
  targets: ['claude'],
  scopes: ['user'],
  members: ['pack:harness', 'guardrails-main', 'context-main'],
};

/** Local fixture catalog replacing BUILTIN_CATALOG. */
const FIXTURE_CATALOG: CatalogEntry[] = [
  TOOL_A,
  TOOL_B,
  SKILL_X,
  AGENT_Y,
  PACK_SIMPLE,
  HOOK_GUARD,
  HOOK_GUARD2,
  GUARDRAIL_ENTRY,
  CONTEXT_ENTRY,
  PACK_HARNESS,
  PACK_BASELINE,
];

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
// Case 4 — pack:simple (fixture) développé en ses membres
// ---------------------------------------------------------------------------

describe('resolve — pack:simple (fixture) développé en ses membres', () => {
  it('développe le pack en ses membres, pack absent de la sortie', () => {
    const result = resolve(['pack:simple'], FIXTURE_CATALOG);
    const ids = result.map((e) => e.id);

    // pack lui-même absent
    expect(ids).not.toContain('pack:simple');

    // membres présents
    expect(ids).toContain('skill:x');
    expect(ids).toContain('agent:y');

    // skill:x requires tool:a → doit aussi être inclus
    expect(ids).toContain('tool:a');

    // dépendances avant ceux qui les requirent
    const aIdx = ids.indexOf('tool:a');
    const xIdx = ids.indexOf('skill:x');
    expect(aIdx).toBeLessThan(xIdx);
  });
});

// ---------------------------------------------------------------------------
// Case 5 — skill:x (fixture) requiert tool:a transitivement
// ---------------------------------------------------------------------------

describe('resolve — skill:x (fixture) avec requires', () => {
  it('inclut tool:a via requires', () => {
    const result = resolve(['skill:x'], FIXTURE_CATALOG);
    const ids = result.map((e) => e.id);
    expect(ids).toContain('tool:a');
    expect(ids).toContain('skill:x');
    expect(ids.indexOf('tool:a')).toBeLessThan(ids.indexOf('skill:x'));
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
    expect(resolve([], FIXTURE_CATALOG)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Case 15 — pack:baseline (fixture) expansion récursive
// ---------------------------------------------------------------------------

describe('resolve — pack:baseline (fixture)', () => {
  it('développe pack:baseline en 4 artefacts (2 guards + guardrail + context), aucun pack en sortie', () => {
    const result = resolve(['pack:baseline'], FIXTURE_CATALOG);
    const ids = result.map((e) => e.id);

    // Aucun pack dans la sortie
    expect(ids).not.toContain('pack:baseline');
    expect(ids).not.toContain('pack:harness');

    // 2 hook guards (via pack:harness expansé récursivement)
    expect(ids).toContain('hook:guard-cmd');
    expect(ids).toContain('hook:guard-read');

    // guardrail et context
    expect(ids).toContain('guardrails-main');
    expect(ids).toContain('context-main');
  });

  it('retourne exactement 4 artefacts (dédupliqués)', () => {
    const result = resolve(['pack:baseline'], FIXTURE_CATALOG);
    expect(result).toHaveLength(4);
  });

  it('tous les éléments de la sortie sont des ArtifactEntry (kind artifact)', () => {
    const result = resolve(['pack:baseline'], FIXTURE_CATALOG);
    expect(result.every((e) => e.kind === 'artifact')).toBe(true);
  });

  it('pack:baseline + pack:harness déduplique les guards (pas de doublon)', () => {
    const result = resolve(['pack:baseline', 'pack:harness'], FIXTURE_CATALOG);
    const ids = result.map((e) => e.id);
    const guardIds = ['hook:guard-cmd', 'hook:guard-read'];
    for (const id of guardIds) {
      expect(ids.filter((x) => x === id)).toHaveLength(1);
    }
  });
});
