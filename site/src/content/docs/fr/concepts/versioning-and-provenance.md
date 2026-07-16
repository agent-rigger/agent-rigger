---
title: Versions et provenance
description: "Comment agent-rigger sait, pour chaque artifact installé, de quelle version il s'agit et d'où il vient : un tag semver résolu en un commit exact, ce commit stocké comme enregistrement, et le contrôle de désaccord qui refuse tout contenu qui n'est pas la version qu'il prétend être."
---

Quand agent-rigger pose un fichier sur votre poste, il enregistre de quelle version de la
configuration partagée de votre équipe ce fichier provient. Le but est de pouvoir répondre plus
tard à une question simple : qu'est-ce qui est exactement installé ici, et d'où cela vient-il ?
Répondre à cette question de façon fiable demande plus que d'enregistrer un numéro de version,
parce qu'un tag de version est un nom que quelqu'un choisit et peut plus tard faire pointer vers
un contenu différent.

## Un tag de version peut se déplacer

Une équipe marque une release de son [catalog](/fr/reference/glossary/#catalog) avec un
[tag](/fr/reference/glossary/#tag), un nom court et lisible par un humain qui suit
[semver](/fr/reference/glossary/#semver), par exemple `v0.1.3`. Un tag est pratique pour les
personnes et peu fiable comme enregistrement à lui seul, parce que git laisse quiconque contrôle
le dépôt re-pointer un tag vers un commit différent quand il le souhaite. Un tag qui peut
silencieusement changer de sens ne peut pas, à lui seul, vous dire des mois plus tard ce que vous
avez installé. Plutôt que de faire confiance au tag tel qu'il est écrit, l'outil le transforme en
quelque chose qui ne bouge pas.

## Résoudre un tag en un commit

Avant de récupérer quoi que ce soit, l'outil demande au remote quels tags existent et vers quoi
chacun pointe, avec `git ls-remote --tags`. Parmi les tags qui se parsent comme du semver, il
retient le plus élevé, et il retient le [sha](/fr/reference/glossary/#sha) du commit de ce tag.
Cette étape produit deux valeurs. Le [ref](/fr/reference/glossary/#ref) est le nom de tag qu'un
humain lit. Le sha est le commit exact vers lequel ce tag pointait au moment où l'outil a
regardé. Le ref reste tourné vers l'humain ; le sha est la partie qui épingle le contenu.

Une release de catalog est un seul tag pour tout le dépôt, pas une version par entrée. Laisser
chaque artifact porter sa propre version serait plus flexible pour publier un artifact sans
toucher au reste, mais cela supprime le tag unique au niveau du dépôt et alourdit la résolution
et la comparaison des versions. Une release reste donc un seul tag couvrant toutes les entrées
qu'elle contient.

Quand un catalog ne porte aucun tag semver, la résolution retombe sur le sha du `HEAD` de la
branche par défaut (`git ls-remote <url> HEAD`), et le ref stocké est ce sha lui-même, si bien
que ref et sha sont identiques. Cela permet de consommer un catalog que personne n'a encore
tagué, à un coût : `HEAD` avance avec la branche, donc une version résolue de cette façon n'est
pas reproductible dans le temps. Un tag est le bon choix dès qu'un catalog est assez stable pour
qu'on en dépende.

## Stocker le commit, pas seulement le tag

Chaque entrée du [manifest](/fr/reference/glossary/#manifest) enregistre les deux valeurs, le ref
et le sha, pour la version à laquelle elle a été installée. C'est le fait de garder le sha, et
pas seulement le tag, qui rend l'enregistrement durable. Le tag dit à une personne de quelle
release il s'agissait. Le sha dit précisément quels octets de quel commit ont atterri,
indépendamment de l'endroit où pointe le tag maintenant. Ici, la
[provenance](/fr/reference/glossary/#provenance) désigne cette paire : le nom du catalog associé au ref et au sha
auxquels un artifact a été récupéré. Chaque artifact installé la porte, parce que chaque
artifact installé est récupéré et qu'aucun n'est gravé dans le binaire.

## Re-vérifier le commit après le clone

La résolution et la récupération sont deux étapes séparées, et c'est dans l'écart entre les deux
qu'un tag peut trahir l'enregistrement. L'outil résout le sha avec `ls-remote`, puis clone le
contenu dans une seconde opération, un
[shallow clone](/fr/reference/glossary/#shallow-clone) qui ne récupère que le commit dont il a
besoin. Rien, dans le fait d'enchaîner ces deux étapes, ne garantit qu'elles s'accordent : le
commit qui atterrit sous le nom du tag dans le clone n'est pas toujours le commit que
`ls-remote` a nommé un instant plus tôt. La page
[confiance et sécurité](/fr/concepts/trust-and-security/) détaille les deux façons concrètes
dont cet écart s'ouvre ; pour cette page, ce qui compte est le simple fait qu'il puisse
s'ouvrir, parce que c'est la raison pour laquelle l'outil ne fait pas simplement confiance au
sha qu'il a résolu.

Plutôt que de supposer que le clone a produit le commit résolu, l'outil le vérifie. Juste après
le checkout, il lance `git rev-parse HEAD` sur le répertoire cloné et compare ce commit au sha
qu'il a résolu plus tôt. Quand ils correspondent, le sha enregistré dans le manifest est bien le
commit réellement sur le disque, pas seulement celui que `ls-remote` a nommé une étape plus tôt.
Quand ils diffèrent, l'install est refusée avant même que le catalog ne soit lu, et l'outil le
dit dans un message construit à partir de cette chaîne exacte :

```
Invalid provenance for ref "${ref}": expected sha ${expectedSha}, found sha ${foundSha} on the checkout. Installation refused — this check cannot be bypassed with --force.
```

`${ref}` est le tag qui a été résolu, `${expectedSha}` le commit que `ls-remote` a retourné pour
lui, et `${foundSha}` le commit réellement sur le disque après le clone.

## Le désaccord est un signal, pas un détail

Un tag qui ne pointe plus où il pointait n'est pas une simple formalité comptable : installer le
contenu quand même et enregistrer un sha en désaccord avec le ref que le manifest prétend
produirait un enregistrement qui se ment à lui-même. L'outil refuse à la place, et un script
voit ce refus comme un [exit code](/fr/reference/exit-codes/) 2.

Ce refus ne passe pas par la porte de scan, et `--force` ne peut pas le lever. Ce que couvre
cette frontière, et ce qu'elle ne couvre pas, relève de la page
[confiance et sécurité](/fr/concepts/trust-and-security/). Ce qui relève de cette page-ci est
plus étroit : sans ce contrôle, le sha que le manifest stocke ne serait qu'une supposition sur
ce que `ls-remote` a rapporté avant le clone, pas un fait sur ce qui est réellement sur le
disque. C'est ce contrôle qui en refait un fait.

## Ce qu'implique un tag déplacé, ensuite

Parce que le sha installé est enregistré, `check` et `update` le comparent au sha fraîchement
résolu depuis le remote. Un tag re-poussé vers un nouveau commit se lit comme une mise à jour
disponible, même si son nom n'a jamais changé, parce que la comparaison se fait entre commits et
non entre noms. L'inverse tient aussi : un contenu identique sous un ref renommé n'est pas
signalé comme une mise à jour. Une comparaison qui ne regarderait que le nom de version
manquerait les deux cas, et c'est le sha stocké qui les rend visibles.

Une exception : une entrée installée par un build plus ancien, antérieur au suivi du sha, n'a
pas de sha stocké. Pour ces entrées, l'outil retombe sur la comparaison des noms de version, si
bien qu'un re-push sous le même nom reste invisible, exactement comme avant que le sha ne soit
enregistré. C'est une limite connue des entrées héritées, pas le comportement retenu pour la
suite.

## Suite

- Voyez comment `install` pointe vers un catalog et une version dans la
  [référence d'install](/fr/reference/cli/install/).
- Lisez la frontière de sécurité autour du contrôle de désaccord dans
  [confiance et sécurité](/fr/concepts/trust-and-security/).
- Cherchez n'importe quel terme dans le [glossaire](/fr/reference/glossary/).
