---
title: resource verbs
description: La grammaire <resource> <verb>, un front-end typé par nature au-dessus d'install, ls, info, check, remove et update, avec une validation d'id par nature.
---

## Synopsis

```
agent-rigger <resource> <verb> [<id>...] [options]
```

Une seconde grammaire cible une seule [nature](/fr/reference/glossary/#nature) à la fois. Le
token resource nomme une nature (ou les packs) ; le verbe est l'action. C'est un front-end typé
au-dessus des mêmes commandes : `skills add` installe, en validant que chaque id est un skill.

## Tokens resource

Les formes au singulier et au pluriel sont équivalentes :

| Token                      | Correspond à                                                    |
| -------------------------- | --------------------------------------------------------------- |
| `skill` / `skills`         | skill                                                           |
| `agent` / `agents`         | agent                                                           |
| `guardrail` / `guardrails` | guardrail                                                       |
| `context` / `contexts`     | context                                                         |
| `plugin` / `plugins`       | plugin                                                          |
| `hook` / `hooks`           | hook                                                            |
| `tool` / `tools`           | tool                                                            |
| `pack` / `packs`           | pack                                                            |
| `catalog`                  | sources de catalog (voir [catalog](/fr/reference/cli/catalog/)) |

## Verbes

| Verbe            | Action                                                               |
| ---------------- | -------------------------------------------------------------------- |
| `ls`             | Liste les entrées de cette nature. Voir [ls](/fr/reference/cli/ls/). |
| `add <id>...`    | Installe les ids, chacun validé contre la nature.                    |
| `info <id>`      | Affiche les détails d'une entrée et si elle est installée.           |
| `check`          | Audite les entrées installées de cette nature.                       |
| `remove <id>...` | Désinstalle les ids. Voir [remove](/fr/reference/cli/remove/).       |
| `update <id>...` | Met à jour les ids. Voir [update](/fr/reference/cli/update/).        |

## Validation de nature

`add`, `update` et `remove` exigent des [qualified ids](/fr/reference/glossary/#qualified-id). Un id
non qualifié est rejeté :

```
[error] unqualified id "<id>" — use `<catalog>/<id>` (see `agent-rigger ls`)
```

Un id dont la nature ne correspond pas à la resource est rejeté avec `[error] id "<id>" is not a
<singular>`. `add` et `update` valident contre le [catalog](/fr/reference/glossary/#catalog) ;
`remove` valide contre le [manifest](/fr/reference/glossary/#manifest), ce qui le garde hors ligne.

## Packs check

`packs check` n'est pas pris en charge. Un pack est un bundle, pas une cible installable : `check` n'a
donc rien à auditer pour lui :

```
[error] "packs check" is not supported — packs are bundles, not installable directly.
```

## Codes de sortie

Les codes de sortie de la commande déléguée s'appliquent (`ls` renvoie `0` dès que ses arguments sont
valides ; `add`, `remove`, `update` et `check` tels que documentés sur leurs propres pages), plus `2`
pour une erreur de validation : un id non qualifié, un décalage de nature, `packs check`, ou un verbe
inconnu. Un verbe inconnu affiche `Unknown verb "<verb>" for resource "<resource>".` suivi de
l'usage.

Voir [codes de sortie](/fr/reference/exit-codes) pour le contrat partagé.

## Exemple

```
agent-rigger guardrails add team/guardrail:no-force-push --yes
```
