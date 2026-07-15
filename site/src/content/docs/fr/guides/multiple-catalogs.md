---
title: Travailler avec plusieurs catalogs
description: Ajoutez une seconde source de catalog, lisez l'effective catalog combiné, agissez sur des artifacts par qualified id à travers les catalogs, comprenez pourquoi deux entrées de même nom ne se percutent jamais, et retirez une source.
---

Vous installez déjà depuis un catalog et vous voulez en ajouter un second à côté : un catalog
d'équipe partagé plus le vôtre, par exemple. Ce guide ajoute une source, lit la vue combinée, agit
sur des ids qui traversent plusieurs catalogs, puis retire une source. Pour un premier passage de
bout en bout, voyez [prise en main](/fr/start/getting-started/). Pour le contrat complet de la
commande, voyez la [référence `catalog`](/fr/reference/cli/catalog/).

## Ajouter une seconde source

Une source est un nom associé à une url git. Ajoutez-en une avec `catalog add` :

```
agent-rigger catalog add team https://github.com/agent-rigger/agent-rigger-catalog-example.git
```

```
catalog "team" added (https://github.com/agent-rigger/agent-rigger-catalog-example.git)
```

Le nom doit être unique parmi vos sources configurées, car il devient le préfixe de chaque
[qualified id](/fr/reference/glossary/#qualified-id) issu de ce catalog. Un nom déjà pris est
rejeté, et rien n'est écrit :

```
[error] catalog "example" already exists (https://github.com/agent-rigger/agent-rigger-catalog-example.git).
```

`catalog add` ne touche que la configuration. Elle n'installe rien. Dans un vrai terminal, elle
récupère ensuite le nouveau catalog et propose d'installer depuis celui-ci (le même
[sélecteur](/fr/guides/install-from-catalog/) que pour install) ; dans un script ou un job CI, cette
proposition est sautée et la source est simplement enregistrée.

## Voir la vue combinée

`agent-rigger ls` récupère chaque source configurée et les affiche comme un seul
[effective catalog](/fr/reference/glossary/#effective-catalog). La première colonne de chaque ligne
est le qualified id, préfixé par la source dont il vient :

```
Catalog (14 entries):
  [available]  example/skill:hello-rigger  skill
  [available]  example/agent:demo          agent
  [available]  example/pack:demo           pack       (2 members)
  [available]  team/skill:hello-rigger     skill
  [available]  team/agent:demo             agent
  [available]  team/pack:demo              pack       (2 members)
```

Le préfixe est ce qui distingue les entrées de deux catalogs dans une même liste. Pour les flags
que `ls` accepte, voyez la [référence `ls`](/fr/reference/cli/ls/).

## Agir sur des artifacts à travers les catalogs

`install`, `update` et `remove` prennent tous des qualified ids, si bien que le catalog est nommé à
l'intérieur même de l'id. Vous agissez sur plusieurs catalogs par préfixe en une seule commande :

```
agent-rigger install example/skill:hello-rigger team/agent:demo --yes
```

Un id nu, non qualifié, est rejeté avant tout accès réseau, tout comme un préfixe qui ne désigne
aucune source configurée. Les deux cas sont couverts dans
[installer depuis un catalog](/fr/guides/install-from-catalog/) ; `ls` affiche l'id exact à copier.

## Deux catalogs, le même nom

Rien n'empêche deux catalogs de définir chacun `skill:hello-rigger`. Ils ne se percutent pas, parce
que la qualification donne à chacun un id distinct sous son propre préfixe. Ajouter le catalog
example sous deux noms affiche les deux familles côte à côte :

```
[available]  example/skill:hello-rigger  skill
[available]  team/skill:hello-rigger     skill
```

`example/skill:hello-rigger` et `team/skill:hello-rigger` sont deux artifacts différents aux yeux de
l'outil. Vous installez, mettez à jour et supprimez chacun par son qualified id complet, et
installer l'un laisse l'autre intact.

La règle d'unicité de nom sur `catalog add` empêche seulement deux sources configurées de partager
un nom. Elle ne vérifie pas quels ids le catalog d'une source déclare de son côté, donc une source
peut très bien livrer un id d'entrée qui est lui-même préfixé du nom d'une autre source, et les deux
qualified ids entrent alors réellement en collision. Quand cela arrive, `ls` avertit :

```
[warning] 1 catalog entry deduplicated (duplicate qualified ids discarded): cat-b/skill:x
```

et ne garde qu'une des deux entrées. Les sources sont fusionnées dans l'ordre où vous les avez
ajoutées, donc la source ajoutée en premier l'emporte et l'entrée correspondante de la source
suivante est écartée de l'effective catalog.

## Quand une source est injoignable

Les sources sont récupérées indépendamment les unes des autres. Si l'une d'elles est injoignable,
`ls` (et les autres commandes de lecture) avertissent à son sujet et continuent avec les autres, au
lieu d'échouer purement et simplement :

```
[warning] Catalog "broken" (https://github.com/acme/does-not-exist.git) unavailable (remote: Repository not found.
fatal: repository 'https://github.com/acme/does-not-exist.git/' not found
). Check the URL or run `agent-rigger init`.
Catalog (7 entries):
  [available]  example/skill:hello-rigger  skill
```

Corrigez l'url avec `catalog remove` puis `catalog add`, ou laissez tel quel si la panne est
temporaire.

## Retirer une source

Retirez une source par son nom :

```
agent-rigger catalog remove team
```

```
catalog "team" removed.
```

Un nom inconnu est refusé :

```
[error] catalog "team" not found.
```

Comme `add`, cette commande ne touche que la configuration. Les artifacts que vous avez installés
depuis cette source restent sur le disque ; leurs qualified ids ne résolvent simplement plus vers un
catalog configuré. Pour les retirer du poste, désinstallez-les avec
[remove](/fr/guides/remove-artifacts/), qui lit le manifest et fonctionne sans aucun catalog
configuré.
