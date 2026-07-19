---
title: Mettre à jour les artifacts installés
description: Voyez quels artifacts installés sont en retard sur leur catalog, mettez-les tous à jour ou par ids précis, lisez les états de résultat, et fiez-vous à la confirmation transactionnelle.
---

Votre catalog a avancé et vous voulez les versions plus récentes sur ce poste. Ce guide montre
comment voir ce qui est en retard, tout mettre à jour ou un ensemble choisi, et lire le résultat.
Pour la liste complète des flags, voyez la [référence `update`](/fr/reference/cli/update/).

## Voir ce qui est en retard

Deux moyens en lecture seule.

`rigger check` affiche une section indicative `--- Updates ---` qui liste chaque artifact
installé en retard sur la dernière version de son catalog, et une section `--- Catalogs ---` avec le
statut par catalog :

```
--- Catalogs ---
  [up-to-date]   example  (v0.4.0)
```

Ces sections sont informatives : elles ne changent jamais l'exit code de check. Une entrée en retard y
est un signal, pas un échec.

`rigger update` sans id classe chaque artifact installé et affiche un plan avant de toucher
quoi que ce soit. Refusez la confirmation pour tout laisser en l'état.

## Tout mettre à jour ou un ensemble choisi

Tous les artifacts installés :

```
rigger update
```

Des [qualified ids](/fr/reference/glossary/#qualified-id) précis :

```
rigger update example/skill:hello-rigger
```

Un id non qualifié est rejeté avant toute récupération :

```
[error] unqualified id "skill:hello-rigger" — use `<catalog>/skill:hello-rigger` (see `rigger ls`)
```

## Lire le résultat

Chaque candidat finit dans l'un des trois états suivants :

- `[updated]  <id>  → <ref>` : était en retard, maintenant réinstallé à `<ref>`.
- `[up-to-date]  <id>  (<ref>)` : déjà à la dernière version, rien de touché.
- `[skipped]  <id>  <reason>` : pas traité. La raison est `not installed` (aucune entrée de manifest
  pour ce scope et cet assistant) ou `no remote version` (installé sans ref de catalog, il n'y a donc
  rien à comparer).

Une exécution où tout est à jour ressemble à ceci (la CLI affiche chaque ligne de résultat indentée
de deux espaces ; les exemples ici sont alignés à gauche) :

```
[up-to-date]  example/skill:hello-rigger  (v0.4.0)
[up-to-date]  example/agent:demo  (v0.4.0)
```

Quand rien n'est installé, update n'a aucun candidat à classer : il ne change rien, n'affiche rien,
et sort avec `0`.

## La confirmation est transactionnelle

Mettre à jour un artifact en retard retire l'ancienne version et applique la nouvelle sous un seul
verrou. La confirmation vient toujours avant toute suppression :

```
Update N artifact(s):
  <id>  <old-ref> → <new-ref>
```

Refusez-la et rien n'est retiré ni écrit : l'artifact reste à sa version installée. Un échec réseau
ou un catalog récupéré invalide interrompt de la même façon, avant la suppression, si bien qu'une
mise à jour ratée ne laisse jamais un artifact à moitié retiré. Les fichiers remplacés sont
d'abord sauvegardés en copies [`.bak-*`](/fr/reference/glossary/#backup-bak).

## L'automatiser

Dans un script ou un job de CI, passez `--yes` pour accepter la confirmation d'emblée :

```
rigger update --yes
```

Sans TTY et sans `--yes`, update sort avec `2` avant tout accès réseau. Voyez
[CI et scripts](/fr/guides/ci-and-scripts/).
