---
title: Publier une release
description: Taguez une release versionnée de votre catalog avec un tag git semver, comprenez comment ce tag se résout en un commit exact quand un coéquipier installe, voyez ce que les consommateurs obtiennent à la mise à jour, et sachez pourquoi déplacer un tag publié se retourne contre vous.
---

Vous avez un catalog qui fonctionne : contenu committé et installé une fois depuis un chemin local,
prouvé sur votre propre poste. Publier le transforme en quelque chose sur lequel votre équipe peut
s'épingler : une version nommée, pas un commit mouvant. Ce how-to est le contrat de publication.

Construire le dépôt, écrire `catalog.json`, et la boucle éditer-puis-installer sont le travail du
tutoriel : [créer un catalog](/fr/authoring/create-a-catalog/) parcourt tout cela, y compris tagger
votre toute première version en local. Cette page prend le relais une fois que vous avez du contenu
qui mérite d'être publié pour d'autres personnes, et le _pourquoi_ derrière la mécanique vit dans
[versions et provenance](/fr/concepts/versioning-and-provenance/), lié là où c'est pertinent plutôt
que répété ici.

## Taguer une version avec semver

Une release est un seul tag git sur tout le dépôt du catalog. Il n'y a pas de version par entrée : le
tag que vous créez couvre chaque entrée de `catalog.json` à ce commit. Taguez le commit que vous
voulez livrer :

```sh
git tag -a v0.4.0 -m "v0.4.0"
```

Le `-a` crée un tag annoté, le choix conventionnel pour une release ; un tag léger
(`git tag v0.4.0`) se résout de façon identique, parce que l'outil lit le commit vers lequel chaque
tag pointe, pas l'objet tag. Le nom doit se parser comme du [semver](/fr/reference/glossary/#semver) :
`MAJOR.MINOR.PATCH`, avec un `v` optionnel en tête et un suffixe de prerelease optionnel
(`v0.4.0-rc.1`). Un tag qui n'est pas du semver (`release-april`, `latest`) est simplement ignoré au
moment de la résolution, jamais une erreur. Quand plusieurs tags semver existent, l'outil retient le
**plus élevé**, et une prerelease se classe en dessous de la release qu'elle précède
(`v0.4.0-rc.1` < `v0.4.0`).

Ce que vous publiez en release, c'est le fichier de catalog et ses artifacts. L'entrée exacte — un
[skill](/fr/reference/glossary/#skill), le même `hello-rigger` que livre le
[catalog d'exemple](/fr/authoring/create-a-catalog/) — ressemble à ceci dans `catalog.json` :

```json title="entrée dans catalog.json"
{
  "kind": "artifact",
  "id": "skill:hello-rigger",
  "nature": "skill",
  "targets": ["claude"],
  "scopes": ["user", "project"],
  "requires": ["tool:git"]
}
```

Chaque champ qu'une entrée peut porter, pour chacune des huit natures, est dans le
[schéma de catalog.json](/fr/reference/catalog-schema/) ; ce que chaque nature écrit sur la machine
qui installe, par [assistant](/fr/reference/glossary/#assistant) et par
[scope](/fr/reference/glossary/#scope), c'est la matrice
[natures × assistants × scopes](/fr/reference/natures-matrix/). Rien dans une release ne change selon
la nature : le tag couvre tout ce que contient le catalog.

## Pousser le tag

Un tag reste invisible pour votre équipe tant qu'il n'a pas atteint le remote. `git push` seul ne
transporte pas les tags, poussez-le donc par son nom :

```sh
git push origin v0.4.0
```

Tant que cette commande n'a pas tourné, `git ls-remote` contre l'URL de votre catalog ne retourne
rien pour `v0.4.0`, aucun coéquipier ne peut donc le résoudre. Poussez le tag et la release existe
pour quiconque pointe vers cette URL.

## Comment un tag se résout en un commit

Un consommateur n'installe jamais « le tag » tel qu'écrit. Avant de récupérer quoi que ce soit,
l'outil demande au remote quels tags existent avec `git ls-remote --tags -- <url>`, retient le tag
semver le plus élevé, et en lit le [sha](/fr/reference/glossary/#sha) du commit exact vers lequel ce
tag pointe. Deux valeurs en ressortent : le [ref](/fr/reference/glossary/#ref) — le nom de tag qu'un
humain lit — et le sha, le commit qui épingle le contenu. Les deux sont enregistrés dans le
[manifest](/fr/reference/glossary/#manifest) du consommateur.

Stocker le commit et pas seulement le nom, c'est ce qui rend l'enregistrement durable, et le
raisonnement complet — y compris le contrôle qui refuse un contenu qui n'est pas la version qu'il
prétend être — est dans [versions et provenance](/fr/concepts/versioning-and-provenance/). Pour la
publication, une seule conséquence suffit : **le commit est l'enregistrement, le nom du tag n'en est
qu'une étiquette.**

Si votre catalog ne porte aucun tag semver du tout, la résolution retombe sur le sha du `HEAD` de la
branche par défaut. Cela permet à quelqu'un de consommer un catalog non taggé, mais `HEAD` avance
avec la branche, la version n'est donc pas reproductible dans le temps. Taguez dès que le catalog est
assez stable pour qu'on en dépende.

## Ce que voit votre équipe à la mise à jour

Une fois le tag poussé, un coéquipier qui a votre catalog configuré s'y résout automatiquement. Un
[`check`](/fr/guides/update-artifacts/) en lecture seule rapporte le catalog à votre version :

```
--- Catalogs ---
  [up-to-date]   example  (v0.4.0)
```

`(v0.4.0)` est le ref que l'outil a résolu : votre tag semver le plus élevé. Quand vous publiez plus
tard un tag supérieur, ce même `check` fait basculer le catalog dans une section `--- Updates ---`,
et [`rigger update`](/fr/guides/update-artifacts/) réinstalle chaque artifact en retard, en
affichant `[updated]  <id>  → <ref>` par artifact. Taguer et pousser un nouveau tag, plus élevé,
c'est tout l'acte de livrer un changement à l'équipe.

## Ne déplacez pas un tag publié

Une fois un tag poussé, traitez-le comme immuable. Publiez un correctif sous un nouveau tag, plus
élevé. Ne re-pointez jamais un tag existant. Deux choses se produisent si vous le faites.

Premièrement, déplacer un tag vers un commit différent n'est pas silencieux pour les consommateurs,
précisément parce que l'enregistrement est le commit et non le nom. `check` compare le sha installé
au sha fraîchement résolu, si bien qu'un tag re-poussé vers un nouveau commit se lit comme une mise à
jour disponible même si son nom n'a jamais changé :

```
--- Catalogs ---
  [update]       demo  → v1.0.0  (1 artifact(s) behind)

--- Updates ---
  [update available]  demo/skill:greet  v1.0.0 → v1.0.0
```

Les deux côtés affichent `v1.0.0`, pourtant l'artifact est signalé en retard. La comparaison se fait
commit contre commit, pas nom contre nom. Lancer `update` le réinstalle sous le même nom :

```
--- Update ---
  [updated]     demo/skill:greet  → v1.0.0
```

C'est un remplacement de contenu silencieux sous un nom que les gens croyaient stable, exactement
pourquoi vous taguez `v1.0.1` à la place.

Deuxièmement, il existe un garde-fou plus dur que vous pouvez déclencher. Quand le commit qui
atterrit réellement dans le checkout est en désaccord avec le sha que l'outil a résolu depuis le
tag — une branche qui partage le nom du tag, ou le tag qui se déplace dans la fenêtre entre la
résolution et le clone — l'install est purement et simplement refusée, avant même que le catalog ne
soit lu :

```
[error] Invalid provenance for ref "v1.2.0": expected sha 9f2c1ab8e7d4c05b3a61f8e29d7c4b0a5e13f6d2, found sha 4b17de0c9a2f8e1d6b30a5c74e9f21038d6ac5b1 on the checkout. Installation refused — this check cannot be bypassed with --force.
```

Le ref est le tag qui a été résolu. Le sha attendu est le commit que `ls-remote` a retourné pour lui,
et le sha trouvé est le commit réellement sur le disque après le clone. Un script voit cela comme un
[exit code](/fr/reference/exit-codes/) `2`, et [`--force`](/fr/reference/glossary/#force) ne le lève
pas. La provenance n'est pas une politique de scan. Pourquoi l'outil ne peut pas simplement faire
confiance au sha qu'il a résolu, et les deux façons concrètes dont l'écart s'ouvre, sont couverts
dans [versions et provenance](/fr/concepts/versioning-and-provenance/).

## Testez une release avant de la publier

Vous n'avez pas besoin d'un remote pour répéter une release. Comme l'outil résout les versions
par-dessus git, la même règle `ls-remote --tags` / semver le plus élevé s'applique à un chemin local,
vous pouvez donc taguer en local et installer depuis le dossier, puis relire le tag résolu avant que
quoi que ce soit ne soit poussé.

Travaillez contre une cible d'installation jetable, exactement comme le met en place le
[tutoriel](/fr/authoring/create-a-catalog/) (`export RIGGER_HOME="$(mktemp -d)"`), pour que rien ne
touche votre vrai `~/.claude`. Enregistrez le catalog par chemin local, installez une entrée, et
laissez `check` confirmer le tag :

```sh
rigger catalog add example "$(pwd)"
rigger install example/skill:hello-rigger --yes
rigger check
```

```
--- Catalogs ---
  [up-to-date]   example  (v0.4.0)
```

`check` qui affiche votre tag contre un chemin local, c'est la preuve que la release se résout avant
même de quitter votre machine. Pour une install ponctuelle directement depuis une URL ou un chemin
sans enregistrer de catalog, voyez
[installer depuis une URL ou un chemin local](/fr/guides/ad-hoc-install/). Ce n'est qu'une fois que
`check` lit le tag que vous attendez que vous le poussez.

## Pour aller plus loin

- Le raisonnement derrière le stockage du commit et le contrôle de refus :
  [versions et provenance](/fr/concepts/versioning-and-provenance/).
- Chaque champ qu'une entrée de catalog peut porter : le
  [schéma de catalog.json](/fr/reference/catalog-schema/).
- Ce que chaque nature écrit par assistant et par scope : la matrice
  [natures × assistants × scopes](/fr/reference/natures-matrix/).
- Comment les consommateurs récupèrent vos releases au quotidien :
  [mettre à jour les artifacts installés](/fr/guides/update-artifacts/).
