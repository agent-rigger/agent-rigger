---
title: Vue d'ensemble de la CLI
description: La grammaire des commandes, les flags globaux, les conventions de sortie et la résolution de l'assistant partagés par chaque commande d'agent-rigger.
---

Chaque commande suit l'une des deux grammaires et partage le même parser de flags, le même
garde-fou non-interactif et la même résolution de l'assistant. Cette page fixe ces règles communes.
Le détail propre à chaque commande vit sur sa propre page.

## Deux binaires

L'outil se distribue en deux binaires au comportement identique : `agent-rigger` et le plus court
`rigger`. Tous les exemples ici emploient `agent-rigger` ; remplacez librement par `rigger`.

## Grammaire

```
agent-rigger <command> [options]
agent-rigger <resource> <verb> [args] [options]
```

Le premier token qui n'est pas un flag est la commande. Quand ce token est une ressource connue, le
deuxième token hors flag est un verbe et le reste constitue ses arguments.

Ressources : `skill` `agent` `guardrail` `context` `plugin` `hook` `tool` `pack` (chacune accepte
aussi son pluriel), plus `catalog`. Verbes : `ls` `add` `info` `check` `remove` `update`. Par
exemple, `agent-rigger guardrails add jr/guardrail:claude` est la forme ressource d'une install
restreinte à la [nature](/fr/reference/glossary/#nature) `guardrail`.

## Flags globaux

Le parser reconnaît exactement cet ensemble. Tout autre `--key`, sous l'une ou l'autre forme, est
traité comme une faute de frappe de l'opérateur : la commande affiche `[error] unknown flag "--<key>"`
et sort en `2` avant le moindre travail. Il n'y a pas de `-h`, pas de `--json`, pas de `--verbose`.

| Flag           | Valeur                    | Utilisé par                                                        |
| -------------- | ------------------------- | ------------------------------------------------------------------ |
| `--scope`      | `user` \| `project`       | install, check, remove, update, ls, et l'install proposée par init |
| `--assistant`  | `claude` \| `opencode`    | install, check, remove, update, ls                                 |
| `--secret-env` | `<ref>=<VAR>` (répétable) | install                                                            |
| `--yes`        | —                         | install, remove, update, init, doctor                              |
| `--force`      | —                         | install, update                                                    |
| `--fix`        | —                         | doctor                                                             |
| `--remote`     | —                         | doctor                                                             |
| `--help`       | —                         | n'importe laquelle (affiche l'usage, sort en `0`)                  |
| `--version`    | —                         | n'importe laquelle (affiche la version, sort en `0`)               |

`--scope`, `--assistant` et `--secret-env` prennent une valeur et acceptent les deux formes
`--flag=value` et `--flag value` (espace). Un flag à valeur laissé sans valeur en fin de liste
d'arguments est une erreur : `[error] --<flag> requires a value`, sort en `2`. Les flags restants
sont des booléens, écrits nus (`--yes`).

`--assistant` n'accepte que `claude` ou `opencode`. `copilot` est réservé et n'a pas encore
d'[adapter](/fr/reference/glossary/#adapter), il n'est donc pas accepté. Une valeur hors plage est
rejetée de façon centrale, avant l'exécution de toute commande :
`[error] Invalid --assistant value: "<x>". Must be "claude" or "opencode".`, sort en `2`. `--scope`
est validé de la même manière : `[error] Invalid --scope value: "<x>". Must be "user" or "project".`

Une commande inconnue affiche `Unknown command: "<x>"` suivi du texte d'usage et sort en `2`.

## Sortie et couleur

La couleur ANSI n'est émise que sur un vrai terminal avec la variable d'environnement
[`NO_COLOR`](/fr/reference/glossary/#no_color) non définie. Une sortie redirigée vers un fichier ou
un autre processus, ou lancée avec `NO_COLOR` défini, est en texte brut. Aucun flag ne bascule la
couleur.

## Le garde-fou pour session non-interactive

install, remove et update demandent confirmation avant de rien changer. Dans une session
[non-interactive](/fr/reference/glossary/#tty--non-interactive), l'invite ne peut recevoir de
réponse : une exécution qui l'atteindrait échoue en fail-closed plutôt que de rester bloquée :

```
[error] non-interactive session — pass --yes to confirm non-interactively
```

Ce contrôle s'exécute en tête de commande, avant toute récupération de catalog ou accès réseau, et
sort en `2`. Passez [`--yes`](/fr/reference/glossary/#--yes) pour pré-approuver les confirmations
sûres. `--yes` ne couvre jamais un acte destructeur (voir [consent](/fr/reference/glossary/#consent)).
Le garde-fou se fonde sur `stdin` : rediriger `stdin`, même seul, suffit à le déclencher.

## Résolution de l'assistant

Les commandes qui écrivent ou auditent résolvent exactement un assistant par exécution, dans cet
ordre de priorité :

1. Le flag `--assistant`, lorsqu'il est fourni (une faute de frappe est une erreur dure, jamais
   outrepassée par ce qui suit).
2. `assistants[]` dans la configuration, lorsqu'il contient exactement une entrée.
3. La détection sur disque, lorsqu'un seul des deux, `~/.claude` ou `~/.config/opencode`, est
   présent.
4. Dans un terminal interactif, une invite sur les candidats restants.
5. Sinon, `claude` (une valeur par défaut rétrocompatible) pour install, check, remove et update.

check, remove et update lisent en plus le [manifest](/fr/reference/glossary/#manifest) d'abord :
quand chaque entrée qu'elles touchent a été installée pour un seul assistant, cet assistant est
utilisé sans invite.

## Commandes

| Commande            | Page                                                    |
| ------------------- | ------------------------------------------------------- |
| `check`             | [check](/fr/reference/cli/check)                        |
| `doctor`            | [doctor](/fr/reference/cli/doctor)                      |
| `install`           | [install](/fr/reference/cli/install)                    |
| `init`              | [init](/fr/reference/cli/init)                          |
| `update`            | [update](/fr/reference/cli/update)                      |
| `remove`            | [remove](/fr/reference/cli/remove)                      |
| `ls`                | [ls](/fr/reference/cli/ls)                              |
| `catalog <verb>`    | [catalog](/fr/reference/cli/catalog)                    |
| `<resource> <verb>` | [verbes de ressource](/fr/reference/cli/resource-verbs) |

Pour le statut numérique que renvoie chaque commande, voir [codes de sortie](/fr/reference/exit-codes).
