---
title: ls
description: Liste l'effective catalog de toutes les sources configurées, marque chaque entrée installée ou disponible, avec une dégradation gracieuse par source et un filtre d'assistant.
---

## Synopsis

```
agent-rigger ls [--scope=<user|project>] [--assistant=<claude|opencode>]
agent-rigger <resource> ls [--scope=<user|project>] [--assistant=<claude|opencode>]
```

Liste l'[effective catalog](/fr/reference/glossary/#effective-catalog) : l'union de toutes les sources
de [catalog](/fr/reference/glossary/#catalog) configurées, chaque entrée marquée installée ou
disponible. Les ids d'entrées sont affichés en [qualified ids](/fr/reference/glossary/#qualified-id)
pour que deux sources réutilisant un id nu restent distinctes.

## Résolution multi-source

ls récupère toutes les sources configurées en parallèle. Une source inatteignable est écartée avec un
avertissement et la liste se poursuit à partir des sources qui ont répondu :

```
[warning] Catalog "<name>" (<url>) unavailable (<reason>). Check the URL or run `agent-rigger init`.
```

Deux sources exposant le même qualified id sont dédupliquées (la première l'emporte), avec un
avertissement nommant les entrées écartées.

## Colonnes

Chaque ligne affiche un tag de statut, le qualified id, la [nature](/fr/reference/glossary/#nature),
et un indice.

- `[installed]` marque un id présent dans le manifest pour le scope.
- `[available]` marque le reste.
- Une ligne installée liste le ou les [assistant](/fr/reference/glossary/#assistant)(s) pour lesquels
  elle est installée, par exemple `(claude, opencode)`.
- Une ligne de [pack](/fr/reference/glossary/#pack) affiche son nombre de membres.

## Flags

| Flag                             | Effet                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--scope=<user\|project>`        | Le scope depuis lequel l'état installé est lu. Par défaut : `user`.                                                                                                                                                                                                                                                                                          |
| `--assistant=<claude\|opencode>` | Filtre ce qui compte comme installé. Avec lui, seules les entrées de manifest de cet assistant sont `[installed]`. Sans lui, un id installé pour n'importe quel assistant est `[installed]`, et chaque ligne installée nomme quand même son ou ses assistant(s). Ce filtre est en lecture seule : il ne se rabat sur rien et ne demande jamais confirmation. |

## Forme resource

`<resource> ls` filtre la liste sur une seule nature (ou les packs) et l'intitule avec le libellé au
singulier, en majuscule initiale, par exemple `Skill (12):`.

## Interactif vs non-interactif

ls est en lecture seule et ne demande jamais confirmation. Sans catalog configuré, il affiche ceci et
s'arrête :

```
no catalog configured — run `agent-rigger init`
```

## Codes de sortie

| Code | Condition                                                                  |
| ---- | -------------------------------------------------------------------------- |
| `0`  | Arguments valides. Un échec de récupération par source ne fait qu'avertir. |
| `2`  | Une valeur `--scope` ou `--assistant` invalide, rejetée avant toute liste. |

## Exemple

```
agent-rigger skills ls --assistant=claude
```

Voir [codes de sortie](/fr/reference/exit-codes) pour le contrat partagé.
