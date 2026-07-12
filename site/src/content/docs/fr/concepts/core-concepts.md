---
title: Concepts fondamentaux
description: "Le modèle mental d'agent-rigger : le catalog de ce qui est disponible, le manifest de ce qui est installé, le store de ce qui est sur le disque, et pourquoi l'outil garde ces trois choses séparées."
---

Trois questions simples traversent tout ce que fait agent-rigger : quelle configuration cette
équipe pourrait-elle adopter, qu'a-t-on réellement posé sur ce poste, et qu'y a-t-il
physiquement sur le disque à cet instant. L'outil garde ces trois réponses dans trois
endroits distincts, et presque tout son comportement découle de leur séparation. Ce qui suit
construit ce modèle à partir de ces trois endroits, avant toute commande ou fichier de
configuration, et ne suppose aucune connaissance préalable de l'outil.

## Ce qui est disponible : le catalog

Une équipe consigne la configuration qu'elle veut partager dans un
[catalog](/fr/reference/glossary/#catalog) : un dépôt git ordinaire dont le fichier racine,
[`catalog.json`](/fr/reference/glossary/#catalogjson), liste les pièces sur lesquelles
l'équipe s'accorde et la façon dont elles se regroupent. Rien de cette configuration ne vit à
l'intérieur du programme agent-rigger. L'outil lit le catalog à distance à une version choisie,
un [tag](/fr/reference/glossary/#tag) git résolu en un [sha](/fr/reference/glossary/#sha) de
commit exact, si bien que le catalog se relit, se tague et se restaure
comme n'importe quel autre code.

Pourquoi un dépôt git séparé plutôt qu'une configuration gravée dans l'outil ? Parce que
l'opinion d'une équipe sur sa propre configuration change bien plus souvent que la mécanique
qui l'installe. Un design antérieur embarquait un catalog dans le binaire, et chaque
changement de la configuration partagée imposait alors de sortir une nouvelle release de
l'outil, puis d'attendre que tout le monde se mette à jour. Séparer le moteur du contenu
supprime ce couplage : une équipe change ce qu'elle installe en ouvrant une merge request sur
son catalog, et personne n'attend une release d'agent-rigger. Le jugement sur ce qu'est une
bonne configuration reste à l'équipe, versionné, là où il peut être débattu.

Cette configuration choisie, la sélection standardisée qu'une équipe applique, c'est le
[rig](/fr/reference/glossary/#rig) de l'équipe. Un rig s'exprime à travers le catalog : les
entrées qu'il déclare, et les [packs](/fr/reference/glossary/#pack) qui regroupent plusieurs
entrées sous un seul id pour qu'un ensemble cohérent s'installe en une étape.

## Ce qui est installé : le manifest

Le catalog dit ce qu'un poste _pourrait_ installer. Il ne dit pas ce qu'un poste donné _a_
installé. C'est le rôle du [manifest](/fr/reference/glossary/#manifest) : un fichier local,
`state.json` sous `~/.config/agent-rigger/`, qui enregistre chaque
[artifact](/fr/reference/glossary/#artifact) installé sur ce poste. Chaque enregistrement
conserve l'id de l'artifact et sa [nature](/fr/reference/glossary/#nature), le
[ref et le sha](/fr/reference/glossary/#ref) auxquels il a été récupéré, son scope, l'heure de
son install, les fichiers qu'il a écrits et un
[applied payload](/fr/reference/glossary/#applied-payload) : le relevé exact et réversible de
ce que l'install a changé.

Le manifest existe comme son propre registre, plutôt que comme quelque chose de re-dérivé du
catalog à chaque exécution, parce que lui seul connaît les choix réels de ce poste : quelles
entrées ont été prises, à quelle version, et précisément ce que chacune a écrit. Ce dernier
point est ce qui permet à un `remove` ultérieur de défaire une install hors ligne et à
l'identique, en rejouant l'applied payload à l'envers plutôt qu'en devinant ce qui avait été
fait.

## Ce qui est sur le disque : le store et les symlinks

Pour un [skill](/fr/reference/glossary/#skill) — et pour un
[agent](/fr/reference/glossary/#agent-sub-agent) Claude Code — l'outil garde une seule copie
physique dans un [store](/fr/reference/glossary/#store) managé sous `~/.config/agent-rigger/`,
et fait pointer le répertoire propre à chaque assistant vers cette copie par un
[symlink](/fr/reference/glossary/#symlink). Une copie, plusieurs liens. (Un agent opencode fait
exception : sa définition est traduite dans le schéma d'opencode et écrite comme un simple
fichier, si bien qu'il n'est ni stocké ni lié.)

Un skill partagé par Claude Code et opencode devrait être une seule chose à mettre à jour, pas
plusieurs à garder synchronisées. Conserver une copie stockée derrière des liens, plutôt que
de déposer une copie dans le dossier de chaque assistant, fait qu'une mise à jour touche un
seul endroit et que chaque assistant la voit. Quand un système de fichiers ne peut pas créer
de symlink, l'outil bascule sur une simple copie pour que l'install fonctionne quand même ;
une copie ainsi faite reste reconnue plus tard en comparant son contenu à l'original stocké.
Les autres natures atterrissent ailleurs. Un [guardrail](/fr/reference/glossary/#guardrail)
fusionne dans un fichier de settings, un artifact [context](/fr/reference/glossary/#context)
écrit `AGENTS.md`. Le principe tient pour toutes : le manifest enregistre exactement ce qui a
atterri et où, pour que rien de ce que l'outil a posé ne soit un mystère plus tard.

## Où ça atterrit : scope user ou project

Chaque install atterrit dans un [scope](/fr/reference/glossary/#scope). Le scope `user` est à
l'échelle du poste, sous votre répertoire home (par exemple `~/.claude/`). Le scope `project`
est limité au dépôt courant (par exemple `.claude/`, et `AGENTS.md` à la racine du dépôt). Un
artifact déclare les scopes qu'il supporte, et `install` en choisit un avec `--scope user` ou
`--scope project`. La distinction laisse une équipe standardiser une règle pour chaque dépôt
d'un poste, ou la restreindre au seul projet qui en a besoin, sans que les deux interfèrent.

## Pourquoi l'outil ne porte aucun contenu

Le binaire agent-rigger n'embarque aucun contenu propre : il est le moteur, tandis que les
skills, règles et contextes vivent tous dans votre catalog. Cette séparation façonne l'usage
de tout le système. Chaque artifact installé est
[récupéré](/fr/reference/glossary/#provenance) ; aucun n'est gravé dans le binaire. Une
conséquence en est que l'outil ne peut pas vous imposer une configuration. Ce qui s'installe
est ce que votre catalog déclare et que vous confirmez, et l'outil ne fait rien qu'on ne lui
ait demandé.

## Le drift, et pourquoi `check` compare trois niveaux

Comme les trois réponses vivent dans trois endroits, elles peuvent diverger indépendamment.
Quelqu'un édite à la main un fichier installé. Un répertoire de store est supprimé. Un tag de
catalog est déplacé vers un nouveau commit. Chacun de ces cas laisse le
[harness](/fr/reference/glossary/#harness) en décalage avec son état déclaré sans que rien
d'autre ne paraisse visiblement anormal. Cet écart, c'est le
[drift](/fr/reference/glossary/#drift) : le harness qui diverge discrètement de ce que le
manifest affirme.

Un contrôle qui ne regarderait qu'un seul niveau raterait les divergences des autres, donc
`check` compare ce que le manifest enregistre à ce qui est sur le disque. Il renvoie `0`
quand tout ce que le manifest affirme est présent et concordant, et `3` quand quelque chose
manque ou a drifté par rapport à cet état enregistré, ce qui est le signal auquel réagit un
script ou un job de CI. Un tag de catalog déplacé est un autre genre d'écart et se rapporte
différemment : `check` le fait remonter comme une annotation `[update available]` à côté de
l'exit code plutôt que de le fondre dans ce code, parce qu'une version plus récente existant
en amont n'est pas la même chose qu'un poste cassé. La commande
[doctor](/fr/reference/glossary/#doctor) va plus loin : elle classe ce qu'elle trouve et, avec
`--fix`, répare les cas sûrs tout en demandant confirmation sur tout ce qui est destructeur.

## Suite

- Découvrez les [huit natures d'artifact](/fr/concepts/artifact-natures/) et ce que chacune
  configure.
- Lisez le [modèle de confiance et de sécurité](/fr/concepts/trust-and-security/) derrière le
  contenu récupéré.
- Cherchez n'importe quel terme dans le [glossaire](/fr/reference/glossary/).
