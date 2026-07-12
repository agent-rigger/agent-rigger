/**
 * Qualification des ids de catalogue — M2 multi-catalogues.
 *
 * Tout id et toute référence inter-entrées devient qualifié `<catalog>/<id>`
 * afin de garantir l'unicité globale lors de la fusion de plusieurs catalogues.
 *
 * Règle de préfixage :
 *  - Une ref est "déjà qualifiée" si elle contient un `/`.
 *  - Une ref intra-catalogue (sans `/`) est préfixée par `<name>/`.
 *  - Une ref cross-catalogue (déjà qualifiée) est laissée intacte.
 *
 * La fonction est pure et immutable : l'input n'est jamais muté.
 * Elle est idempotente : appliquer deux fois produit le même résultat qu'une fois.
 *
 * Couture unique (ADR-0017 §1, lot 6 R4/D4) : `qualifyRef` (préfixage) et
 * `localId` (dépréfixage, son inverse) sont les DEUX seules fonctions que
 * tout consommateur (CLI, governance, remote-install…) SHALL utiliser —
 * aucun site ne réimplémente l'heuristique `includes('/') ? … : prefix`
 * inline. Les deux transitent par `export * from './qualify'` (index.ts).
 */

import type { CatalogEntry } from './schema';

// ---------------------------------------------------------------------------
// Public seam — forward (qualifyRef) / inverse (localId)
// ---------------------------------------------------------------------------

/**
 * Préfixe `ref` par `<name>/` si elle n'est pas déjà qualifiée.
 * Une ref est considérée qualifiée si elle contient un `/`.
 */
export function qualifyRef(name: string, ref: string): string {
  return ref.includes('/') ? ref : `${name}/${ref}`;
}

/**
 * Retourne la partie locale (non qualifiée) de `id` — inverse de `qualifyRef`.
 *
 * Un id est "qualifié" s'il contient un `/` ; la partie locale est tout ce
 * qui suit le PREMIER `/`. Un id sans `/` est déjà local et est retourné
 * inchangé.
 *
 * Exemples :
 *   localId('skill:foo')       → 'skill:foo'   (déjà local, inchangé)
 *   localId('mycat/skill:foo') → 'skill:foo'   (préfixe retiré)
 *
 * Pure : ne mute pas `id`.
 */
export function localId(id: string): string {
  const slashIdx = id.indexOf('/');
  return slashIdx === -1 ? id : id.slice(slashIdx + 1);
}

/**
 * Préfixe chaque élément d'un tableau de refs en appliquant `qualifyRef`.
 * Retourne un nouveau tableau ; l'original n'est pas muté.
 */
function qualifyRefs(name: string, refs: string[]): string[] {
  return refs.map((ref) => qualifyRef(name, ref));
}

/** Result of {@link partitionMetaIds}: a source's own ids vs foreign ones. */
export interface OwnMetaIds {
  /** Ids the source may declare — bare or self-qualified — returned qualified. */
  own: string[];
  /** Ids qualified by ANOTHER catalog's prefix — not this source's to declare. */
  foreign: string[];
}

/**
 * Partition a source's `meta.required` / `meta.recommended` ids into those it
 * may legitimately declare (`own`) and those pointing into ANOTHER catalog
 * (`foreign`). A bare id is qualified with `name`; an id already prefixed by
 * `name/` is kept; any other `/`-qualified id is foreign.
 *
 * `qualifyRef` alone leaves a pre-qualified id intact, so a catalog could forge
 * a governance obligation or a pre-check under another catalog's prefix. This
 * is the single seam that distinguishes own from foreign (governance-id-forge).
 * The comparison uses `name + '/'` so a sub-prefix never false-matches — source
 * `cat` does not own `cat2/skill:x`.
 */
export function partitionMetaIds(name: string, ids: readonly string[]): OwnMetaIds {
  const ownPrefix = name + '/';
  const own: string[] = [];
  const foreign: string[] = [];
  for (const id of ids) {
    if (id.includes('/') && !id.startsWith(ownPrefix)) {
      foreign.push(id);
    } else {
      own.push(qualifyRef(name, id));
    }
  }
  return { own, foreign };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retourne une nouvelle liste d'entrées où :
 *  1. Chaque `id` est préfixé par `<name>/` (sauf s'il l'est déjà).
 *  2. Chaque référence dans `requires[]` est préfixée si intra-catalogue.
 *  3. Pour les entrées `pack`, chaque référence dans `members[]` est préfixée
 *     si intra-catalogue.
 *
 * Garanties :
 *  - Pure : ne mute pas `entries`.
 *  - Idempotente : `qualifyEntries(n, qualifyEntries(n, x))` === `qualifyEntries(n, x)`.
 *
 * @param name    Nom du catalogue (ex. "mycat").
 * @param entries Entrées brutes ou déjà qualifiées.
 * @returns       Nouvelles entrées qualifiées.
 */
export function qualifyEntries(name: string, entries: CatalogEntry[]): CatalogEntry[] {
  return entries.map((entry) => {
    const qualifiedId = qualifyRef(name, entry.id);
    const qualifiedRequires = entry.requires?.map((ref) => qualifyRef(name, ref));

    if (entry.kind === 'pack') {
      return {
        ...entry,
        id: qualifiedId,
        members: qualifyRefs(name, entry.members),
        ...(qualifiedRequires === undefined ? {} : { requires: qualifiedRequires }),
      };
    }

    return {
      ...entry,
      id: qualifiedId,
      ...(qualifiedRequires === undefined ? {} : { requires: qualifiedRequires }),
    };
  });
}
