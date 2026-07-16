---
title: Changelog
description: "Comment agent-rigger tient son changelog — Keep a Changelog et Semantic Versioning, des entrées écrites à la main sous Unreleased, une rotation scriptée gardée en CI — et où lire la version vivante."
---

Chaque changement qu'un utilisateur remarquerait — une nouvelle commande, un défaut changé, un bug
corrigé — est écrit avant d'être livré, pour que vous puissiez voir ce qui a changé entre la
version que vous avez et celle que vous êtes sur le point d'installer. Cette page explique
comment cet enregistrement est tenu. Elle ne reproduit pas le changelog : le vrai vit dans le
dépôt, et les liens en bas de cette page y pointent.

## Le format qu'il suit

Le changelog est écrit dans le style [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Les changements sont groupés par type — Added, Changed, Fixed, et ainsi de suite — sous un titre
par release, la plus récente en tête. Les numéros de version suivent
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) : `MAJOR.MINOR.PATCH`.

agent-rigger est pré-1.0. Sous Semantic Versioning, une ligne `0.x` ne fait aucune promesse de
stabilité entre versions mineures — le comportement peut changer entre `0.1` et `0.2` — lisez donc
le changelog avant de mettre à jour plutôt que de supposer qu'une montée mineure est sans risque.

## Comment les entrées sont enregistrées

Pendant qu'un travail est en cours, chaque changement ajoute sa propre ligne sous un titre
`## [Unreleased]` dans le changelog, groupée par type. Les entrées sont écrites à la main à
mesure que les pull requests atterrissent — choisies, pas générées depuis les titres de commit —
si bien que l'enregistrement décrit ce qui a changé dans les termes d'un lecteur.

## Ce qu'une release lui fait

Rien dans le changelog n'est décidé par un modèle de langage au moment de la release. Publier une
release lance un unique script déterministe :

```sh
bun scripts/release-changelog.ts X.Y.Z
```

Il déplace les entrées sous `## [Unreleased]` dans une nouvelle section datée,
`## [X.Y.Z] - YYYY-MM-DD`, vide Unreleased, et réécrit les liens de version en bas du fichier. Il
refuse de tourner si une section pour cette version existe déjà, ou si Unreleased n'a rien à
livrer : la rotation produit soit une section correcte, soit s'arrête. Le mainteneur committe
ensuite la rotation, tague la release `vX.Y.Z`, et pousse le tag, ce qui déclenche le build de
release.

## Le garde-fou en CI

Une release taguée n'a pas le droit d'être livrée sans sa section de changelog. Avant d'installer
ou de construire quoi que ce soit, le workflow de release vérifie que le changelog a une section
`## [X.Y.Z]` correspondant au tag. Si la rotation a été sautée, l'exécution s'arrête là —
[fail-closed](/fr/reference/glossary/#fail-closed--fail-open) — et affiche la commande exacte
pour corriger cela. Aucun chemin ne publie de release taguée avec un changelog non documenté. Le
déroulé pour les mainteneurs est dans
[CONTRIBUTING.md, section Releasing](https://github.com/agent-rigger/agent-rigger/blob/main/CONTRIBUTING.md#releasing).

## Où le lire

- [`CHANGELOG.md` sur `main`](https://github.com/agent-rigger/agent-rigger/blob/main/CHANGELOG.md)
  — le changelog vivant, mis à jour en continu. La section `## [Unreleased]` en haut est ce que la
  prochaine release va livrer ; les sections datées en dessous sont des releases passées.
- [La page Releases](https://github.com/agent-rigger/agent-rigger/releases) — chaque release
  taguée, avec ses binaires téléchargeables et ses notes.
