---
title: init
description: "Première configuration guidée : sonder l'accès au catalog, enregistrer la configuration, proposer une première install."
---

## Synopsis

```
rigger init [--yes] [--scope=<user|project>]
```

`init` est la commande de premier lancement, interactive : il demande l'URL d'un dépôt de
[catalog](/fr/reference/glossary/#catalog), en vérifie l'accès, enregistre la configuration résolue,
puis propose d'installer un premier ensemble d'artifacts. La configuration n'est écrite qu'une fois
l'accès confirmé : une exécution en échec ne laisse donc rien sur le disque. La relancer repart de
l'état sauvegardé.

## Arguments

`init` ne prend aucun argument positionnel.

## Flags

| Flag      | Effet                                                                                                                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--yes`   | Accepter les valeurs par défaut sans afficher d'invite : sauter le sélecteur d'assistant (repli sur la détection sur disque) et, dans l'install proposée, sélectionner les entrées required et recommended du catalog sans sélecteur. |
| `--scope` | Le [scope](/fr/reference/glossary/#scope) dans lequel écrit l'install proposée (`user` ou `project`, `user` par défaut).                                                                                                              |

## Étapes

1. **URL du catalog.** `init` demande `Enter the catalog repository URL:`.
2. **Sonde d'accès.** Il lance `git ls-remote` sur l'URL avec les identifiants ambiants. Si le
   dépôt est joignable, aucune question d'authentification n'est posée. Sinon, `init` demande
   `Select authentication method:` avec trois options : `Provider CLI (gh / glab)`,
   `HTTPS (credential helper)` et `SSH key`. La méthode choisie est appliquée et la sonde
   recommence. Si la méthode choisie échoue encore, l'exécution s'arrête avec un message qui
   nomme la commande à lancer (`gh auth login` ou `glab auth login` pour la méthode provider-CLI),
   sort en `1` et ne persiste rien.
3. **Assistants.** `init` demande `Which assistant(s) do you want to configure?` sous forme de
   sélection multiple parmi `claude` et `opencode`. N'en sélectionner aucun est permis. `copilot`
   n'est pas proposé : il est réservé et n'a pas encore d'[adapter](/fr/reference/glossary/#adapter).
4. **Persistance.** Ce n'est qu'à ce moment que la configuration est écrite : le catalog est
   enregistré sous le nom `principal`, avec la méthode d'authentification (lorsqu'une a été
   négociée) et les assistants sélectionnés.
5. **Install proposée.** Après une persistance réussie, `init` récupère le catalog et propose un
   sélecteur. Les entrées que le catalog marque [required](/fr/reference/glossary/#required) sont
   pré-cochées et ne peuvent être décochées ; les [recommended](/fr/reference/glossary/#recommended)
   sont pré-cochées et peuvent être désactivées. L'install cible chaque assistant configuré à
   l'étape 3.

Une configuration écrite par une exécution antérieure est lue d'abord et fusionnée : un second
`init` ne met donc à jour que les champs que la nouvelle exécution résout. Relancer avec les mêmes
réponses ne change rien ([idempotence](/fr/reference/glossary/#idempotence)).

## Interactif vs non-interactif

Dans un terminal interactif, toutes les étapes se déroulent comme ci-dessus. Sous `--yes`, le
sélecteur d'assistant et le sélecteur d'install sont sautés : la proposition installe directement
les valeurs par défaut required et recommended.

Dans une session non-interactive sans `--yes`, `init` s'arrête après avoir persisté la configuration
et saute l'install proposée ; les assistants proviennent de la détection sur disque plutôt que d'une
invite. Lancez `install` plus tard pour ajouter des artifacts.

## Sortie

En cas de succès, `init` affiche un récapitulatif :

```
Catalog      : https://github.com/org/repo.git (principal)
Auth method  : ssh
Assistant(s) : claude, opencode
Config saved : /Users/you/.config/agent-rigger/config.json
```

La ligne `Auth method` est omise quand l'accès ambiant a fonctionné. Si la récupération
post-persistance échoue, la configuration reste sauvegardée et la sortie ajoute :

```
Catalog fetch failed. Run `install` later to install artifacts from the catalog.
```

## Codes de sortie

| Code  | Condition                                                                                                                                                                                                                                          |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`   | Configuration persistée (avec ou sans install proposée).                                                                                                                                                                                           |
| `1`   | Échec de l'authentification ; rien n'a été persisté.                                                                                                                                                                                               |
| `2`   | Valeur de flag invalide (par exemple un `--scope` erroné).                                                                                                                                                                                         |
| `130` | Une invite a été annulée par Ctrl+C. Une annulation jusqu'à l'étape de persistance (étape 4) ne laisse rien sur le disque ; une annulation dans le sélecteur de l'install proposée (étape 5) sort en `130` avec la configuration déjà sauvegardée. |

Voir [codes de sortie](/fr/reference/exit-codes) pour le contrat commun.

## Exemple

```
rigger init
```
