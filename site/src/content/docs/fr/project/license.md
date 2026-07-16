---
title: Licence
description: "agent-rigger est sous Apache-2.0 : ce que cela vous permet, les conditions attachées, et l'avertissement qui l'accompagne. Le fichier LICENSE du dépôt, en anglais, est la version qui fait foi."
---

agent-rigger est publié sous l'Apache License, Version 2.0. En clair, vous pouvez l'utiliser,
lire son source, le modifier et le transmettre — pour un usage personnel, commercial ou
interne — à condition de conserver les mentions que la licence vous demande de conserver.

Ceci est un résumé, pas la licence elle-même, et cette page n'est pas non plus une traduction
officielle : les fichiers [`LICENSE`](https://github.com/agent-rigger/agent-rigger/blob/main/LICENSE)
et [`DISCLAIMER.md`](https://github.com/agent-rigger/agent-rigger/blob/main/DISCLAIMER.md) du
dépôt, rédigés en anglais, sont les seuls textes qui font foi. La formulation de cette page n'a
aucune valeur juridique ; là où quoi que ce soit ici diffère de ces fichiers, les fichiers
l'emportent. Cette page ne constitue pas un avis juridique. S'il vous faut une réponse pour
votre propre situation, lisez le texte de la licence et consultez une personne qualifiée.

La mention de copyright est `Copyright 2026 Jonathan Robic`.

## Ce que la licence vous permet

| Vous pouvez                          | Sous Apache-2.0                                                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Utiliser le logiciel                 | Pour tout usage, y compris commercial et interne, sans frais.                                                               |
| Lire et modifier le source           | La configuration du [harness](/fr/reference/glossary/#harness) et le source du CLI sont ouverts ; vous pouvez les modifier. |
| Le redistribuer                      | Avec ou sans vos modifications, sous forme source ou compilée.                                                              |
| Sous-licencier et combiner           | L'intégrer dans une œuvre plus large et distribuer cette œuvre sous vos propres conditions.                                 |
| Compter sur une concession de brevet | Chaque contributeur concède une licence de brevet libre de redevances couvrant ses contributions.                           |

La concession de brevet porte une condition posée par la licence elle-même : si vous engagez un
contentieux de brevet en soutenant que le logiciel contrefait un brevet, la licence de brevet
qui vous avait été concédée pour lui prend fin. C'est un terme d'Apache-2.0, rappelé ici
seulement pour que le résumé ne soit pas trompeur.

## Les conditions attachées

Les permissions viennent avec un petit ensemble d'obligations qui s'appliquent quand vous
redistribuez le logiciel ou une œuvre qui en dérive :

- **Incluez la licence.** Remettez une copie de la licence Apache-2.0 à toute personne à qui
  vous distribuez.
- **Conservez les mentions.** Gardez les mentions existantes de copyright, de brevet, de marque
  et d'attribution présentes dans le source.
- **Préservez `NOTICE`.** Si une distribution inclut un fichier `NOTICE`, reportez son texte
  d'attribution dans votre distribution.
- **Signalez vos changements.** Marquez comme modifiés les fichiers que vous avez modifiés.

Vous pouvez ajouter votre propre mention de copyright à vos modifications et les proposer sous
des conditions supplémentaires ou différentes, tant que votre usage de l'œuvre d'origine reste
conforme à Apache-2.0.

La licence n'accorde pas la permission d'utiliser les noms commerciaux, marques ou noms de
produits du concédant, au-delà de l'usage habituel nécessaire pour indiquer d'où vient le
logiciel.

## Avertissement

Le logiciel est distribué avec l'avertissement ci-dessous. Il porte les réserves propres au
projet aux côtés des termes « AS IS » (en l'état) de la licence ; ce qui engage vit dans les fichiers
`LICENSE` et `DISCLAIMER.md` du dépôt, pas sur cette page.

### Absence de garantie

Le logiciel est fourni « AS IS », sans garantie d'aucune sorte, expresse ou
implicite, y compris la qualité marchande, l'adéquation à un usage particulier et l'absence de
contrefaçon. Le risque quant à la qualité et aux performances du logiciel repose entièrement
sur vous.

### Limitation de responsabilité

En aucun cas les auteurs ou détenteurs du copyright ne répondent d'une réclamation, de dommages
ou d'une autre responsabilité, sur le terrain contractuel, délictuel ou autre, découlant du
logiciel ou de son usage. Cela couvre les dommages directs, indirects, accessoires, spéciaux,
exemplaires et consécutifs, y compris la perte de données, la perte de profits et
l'interruption d'activité.

### Binaires précompilés

Les binaires de release et les distributions en bundle sont fournis par commodité et couverts
par la même licence Apache-2.0 que le source. Ils viennent sans garanties ni conditions
d'aucune sorte. Vérifier l'intégrité et l'adéquation d'un binaire avant usage relève de votre
responsabilité ; vérifiez les sommes de contrôle quand elles sont disponibles. (La formule
Homebrew, par exemple, fige une somme de contrôle SHA-256 par plateforme.)

### Dépendances tierces

Le logiciel incorpore des composants open source tiers, chacun régi par sa propre licence. Les
auteurs ne font aucune déclaration ni garantie au sujet de ces dépendances et n'acceptent
aucune responsabilité pour les problèmes qui en découlent.

### Utilisation à vos risques

agent-rigger lit et écrit la configuration de harness de votre
[assistant de code IA](/fr/reference/glossary/#assistant) (par exemple `~/.claude`) et votre
système de fichiers, et peut lancer des commandes externes pour votre compte. Vous assurer que
son usage convient à votre environnement — et respecte les politiques, réglementations ou
accords qui s'appliquent à vous — relève de votre responsabilité. Les auteurs ne répondent pas
des effets de bord involontaires de son usage. Relisez ce qui sera installé ou supprimé avant
de confirmer toute opération.

## Où vit le texte qui fait foi

Deux fichiers du dépôt, rédigés en anglais, portent le texte qui engage :

- [`LICENSE`](https://github.com/agent-rigger/agent-rigger/blob/main/LICENSE) — le texte
  intégral de l'Apache License 2.0 sous laquelle le logiciel est distribué.
- [`DISCLAIMER.md`](https://github.com/agent-rigger/agent-rigger/blob/main/DISCLAIMER.md) —
  l'avertissement résumé ci-dessus.

Si cette page et l'un de ces fichiers divergent, c'est le fichier qui a raison.
