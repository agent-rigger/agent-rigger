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
 */

import type { CatalogEntry } from './schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Préfixe `ref` par `<name>/` si elle n'est pas déjà qualifiée.
 * Une ref est considérée qualifiée si elle contient un `/`.
 */
function qualifyRef(name: string, ref: string): string {
  return ref.includes('/') ? ref : `${name}/${ref}`;
}

/**
 * Préfixe chaque élément d'un tableau de refs en appliquant `qualifyRef`.
 * Retourne un nouveau tableau ; l'original n'est pas muté.
 */
function qualifyRefs(name: string, refs: string[]): string[] {
  return refs.map((ref) => qualifyRef(name, ref));
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
