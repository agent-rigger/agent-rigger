/**
 * resolver-edges.test.ts — R5 (lib-nature T2): the resolver surfaces the
 * RESOLVED requires per emitted entry (its own declared requires PLUS every
 * pack-level requires inherited on the membership path to it). Packs are never
 * emitted, so their `requires[]` must land on their members (S4).
 *
 * This is the owner-resolver seam (design §5, GATE DESIGN point 2): the single
 * graph walk that already expands packs and follows requires is extended to
 * surface the edges, so no second graph walk is duplicated CLI-side.
 *
 * `resolve()` (the pre-existing ArtifactEntry[] contract) is re-derived from
 * `resolveWithEdges()` — its behaviour is unchanged and pinned by resolver.test.ts.
 */

import { describe, expect, it } from 'bun:test';

import { DependencyCycleError, resolveWithEdges } from '../src/resolver';
import type { CatalogEntry } from '../src/schema';

// ---------------------------------------------------------------------------
// Helpers — minimal synthetic catalog builders (mirror resolver.test.ts)
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

/** Look up the resolved requires of an emitted entry by id. */
function requiresOf(
  resolved: ReturnType<typeof resolveWithEdges>,
  id: string,
): string[] | undefined {
  return resolved.find((r) => r.entry.id === id)?.requires;
}

// ---------------------------------------------------------------------------
// R5 scénario: edge simple — own requires surfaced verbatim
// ---------------------------------------------------------------------------

describe('resolveWithEdges — own requires surfacés par entrée', () => {
  it("surface les requires propres de l'artefact", () => {
    const catalog: CatalogEntry[] = [
      artifact('lib:rules-common'),
      artifact('hook:guard', ['lib:rules-common']),
    ];
    const resolved = resolveWithEdges(['hook:guard'], catalog);

    expect(requiresOf(resolved, 'hook:guard')).toEqual(['lib:rules-common']);
    // La lib est dépendée, elle ne dépend de rien : requires vide.
    expect(requiresOf(resolved, 'lib:rules-common')).toEqual([]);
  });

  it('un artefact sans requires porte un tableau vide', () => {
    const resolved = resolveWithEdges(['tool:a'], [artifact('tool:a')]);
    expect(requiresOf(resolved, 'tool:a')).toEqual([]);
  });

  it("conserve l'ordre deps-first des entrées émises (parité resolve)", () => {
    const catalog: CatalogEntry[] = [
      artifact('tool:c'),
      artifact('tool:b', ['tool:c']),
      artifact('tool:a', ['tool:b']),
    ];
    const resolved = resolveWithEdges(['tool:a'], catalog);
    expect(resolved.map((r) => r.entry.id)).toEqual(['tool:c', 'tool:b', 'tool:a']);
  });
});

// ---------------------------------------------------------------------------
// R5 scénario: requires de pack propagé aux membres
// ---------------------------------------------------------------------------

describe('resolveWithEdges — requires de pack propagés aux membres (S4)', () => {
  it('chaque membre hérite du requires du pack, la lib ne se référence pas elle-même', () => {
    const catalog: CatalogEntry[] = [
      artifact('lib:rules-common'),
      artifact('hook:a'),
      artifact('hook:b'),
      pack('pack:secu', ['hook:a', 'hook:b'], ['lib:rules-common']),
    ];
    const resolved = resolveWithEdges(['pack:secu'], catalog);

    // Les deux membres portent l'edge du pack.
    expect(requiresOf(resolved, 'hook:a')).toEqual(['lib:rules-common']);
    expect(requiresOf(resolved, 'hook:b')).toEqual(['lib:rules-common']);

    // La lib (dep du pack) est émise sans self-edge.
    expect(requiresOf(resolved, 'lib:rules-common')).toEqual([]);

    // Le pack n'est jamais émis.
    expect(resolved.some((r) => r.entry.id === 'pack:secu')).toBe(false);
  });

  it('combine les requires propres du membre et ceux hérités du pack', () => {
    const catalog: CatalogEntry[] = [
      artifact('lib:pack-dep'),
      artifact('lib:own-dep'),
      artifact('hook:a', ['lib:own-dep']),
      pack('pack:secu', ['hook:a'], ['lib:pack-dep']),
    ];
    const resolved = resolveWithEdges(['pack:secu'], catalog);

    // Own d'abord, puis l'hérité — dédupliqués.
    expect(requiresOf(resolved, 'hook:a')).toEqual(['lib:own-dep', 'lib:pack-dep']);
  });

  it('propage à travers les packs imbriqués (union des requires traversés)', () => {
    const catalog: CatalogEntry[] = [
      artifact('lib:outer'),
      artifact('lib:inner'),
      artifact('hook:leaf'),
      pack('pack:inner', ['hook:leaf'], ['lib:inner']),
      pack('pack:outer', ['pack:inner'], ['lib:outer']),
    ];
    const resolved = resolveWithEdges(['pack:outer'], catalog);

    const leaf = requiresOf(resolved, 'hook:leaf');
    expect(leaf).toContain('lib:outer');
    expect(leaf).toContain('lib:inner');
  });

  it("dédup l'edge de pack quand le membre est atteint par deux packs (même lib, dédup)", () => {
    const catalog: CatalogEntry[] = [
      artifact('lib:shared'),
      artifact('hook:x'),
      pack('pack:a', ['hook:x'], ['lib:shared']),
      pack('pack:b', ['hook:x'], ['lib:shared']),
    ];
    const resolved = resolveWithEdges(['pack:a', 'pack:b'], catalog);
    const req = requiresOf(resolved, 'hook:x');
    expect(req?.filter((r) => r === 'lib:shared')).toHaveLength(1);
  });

  it('membre partagé par deux packs aux requires DIVERGENTS → union des edges', () => {
    // pack:a→lib:x, pack:b→lib:y, hook:m ∈ a∩b : hook:m doit porter les DEUX
    // (sur-rétention sûre ; sous-rétention = perte silencieuse d'un edge).
    const catalog: CatalogEntry[] = [
      artifact('lib:x'),
      artifact('lib:y'),
      artifact('hook:m'),
      pack('pack:a', ['hook:m'], ['lib:x']),
      pack('pack:b', ['hook:m'], ['lib:y']),
    ];

    const ab = requiresOf(resolveWithEdges(['pack:a', 'pack:b'], catalog), 'hook:m') ?? [];
    expect([...ab].sort()).toEqual(['lib:x', 'lib:y']);
  });

  it("union INDÉPENDANTE de l'ordre de sélection ({a,b} et {b,a} → même union)", () => {
    const catalog: CatalogEntry[] = [
      artifact('lib:x'),
      artifact('lib:y'),
      artifact('hook:m'),
      pack('pack:a', ['hook:m'], ['lib:x']),
      pack('pack:b', ['hook:m'], ['lib:y']),
    ];

    const ab = requiresOf(resolveWithEdges(['pack:a', 'pack:b'], catalog), 'hook:m') ?? [];
    const ba = requiresOf(resolveWithEdges(['pack:b', 'pack:a'], catalog), 'hook:m') ?? [];
    // L'ordre du tableau peut différer, mais l'union (set) est identique.
    expect([...ba].sort()).toEqual([...ab].sort());
    expect([...ab].sort()).toEqual(['lib:x', 'lib:y']);
  });
});

// ---------------------------------------------------------------------------
// Union mémoïsée À TRAVERS LES PACKS (nested packs = schéma légal, review T2 r2)
// ---------------------------------------------------------------------------

describe('resolveWithEdges — union propagée à travers un pack partagé (nested)', () => {
  it('membre sous un pack partagé par deux parents divergents → union (deux ordres)', () => {
    // hook:m ∈ pack:p ; pack:p ∈ pack:a ET pack:b ; a→lib:x, b→lib:y.
    // L'edge divergent doit traverser le pack intermédiaire partagé.
    const catalog: CatalogEntry[] = [
      artifact('lib:x'),
      artifact('lib:y'),
      artifact('hook:m'),
      pack('pack:p', ['hook:m']),
      pack('pack:a', ['pack:p'], ['lib:x']),
      pack('pack:b', ['pack:p'], ['lib:y']),
    ];

    const ab = requiresOf(resolveWithEdges(['pack:a', 'pack:b'], catalog), 'hook:m') ?? [];
    const ba = requiresOf(resolveWithEdges(['pack:b', 'pack:a'], catalog), 'hook:m') ?? [];
    expect([...ab].sort()).toEqual(['lib:x', 'lib:y']);
    // Indépendance à l'ordre de sélection.
    expect([...ba].sort()).toEqual([...ab].sort());
  });

  it('propagation transitive sur 2+ niveaux de packs (chaîne profonde)', () => {
    // pack:l1→lib:a ⊃ pack:l2→lib:b ⊃ pack:l3→lib:c ⊃ hook:m.
    // hook:m doit accumuler les requires de chaque niveau traversé.
    const catalog: CatalogEntry[] = [
      artifact('lib:a'),
      artifact('lib:b'),
      artifact('lib:c'),
      artifact('hook:m'),
      pack('pack:l3', ['hook:m'], ['lib:c']),
      pack('pack:l2', ['pack:l3'], ['lib:b']),
      pack('pack:l1', ['pack:l2'], ['lib:a']),
    ];

    const req = requiresOf(resolveWithEdges(['pack:l1'], catalog), 'hook:m') ?? [];
    expect([...req].sort()).toEqual(['lib:a', 'lib:b', 'lib:c']);
  });

  it('cycle de packs avec requires → DependencyCycleError, pas de boucle infinie', () => {
    // pack:a ⊃ pack:b ⊃ pack:a, chacun avec un requires : le re-walk mémoïsé
    // ne doit jamais boucler — la détection de cycle (stack) prime.
    const catalog: CatalogEntry[] = [
      artifact('lib:x'),
      artifact('lib:y'),
      pack('pack:a', ['pack:b'], ['lib:x']),
      pack('pack:b', ['pack:a'], ['lib:y']),
    ];
    expect(() => resolveWithEdges(['pack:a'], catalog)).toThrow(DependencyCycleError);
  });
});

// ---------------------------------------------------------------------------
// R5 scénario: cross-catalogue — la ref satisfaite reste sur le consommateur
// ---------------------------------------------------------------------------

describe('resolveWithEdges — ref externallySatisfied surfacée sur le consommateur (pré-prune)', () => {
  it("le consommateur porte la ref étrangère même si elle n'est pas émise", () => {
    // hook:x requires une lib d'un AUTRE catalogue, déjà satisfaite ailleurs.
    const catalog: CatalogEntry[] = [artifact('hook:x', ['othercat/lib:y'])];
    const externallySatisfied = new Set(['othercat/lib:y']);

    const resolved = resolveWithEdges(['hook:x'], catalog, externallySatisfied);

    // La ref étrangère n'est jamais émise (skippée)...
    expect(resolved.some((r) => r.entry.id === 'othercat/lib:y')).toBe(false);
    // ...mais reste capturée sur les requires du consommateur (pré-prune).
    expect(requiresOf(resolved, 'hook:x')).toEqual(['othercat/lib:y']);
  });
});
