---
title: catalog
description: "Gère les sources de catalog configurées : liste, ajoute et retire les catalogs distants qu'agent-rigger lit, avec une règle de nom unique et une proposition d'installation après ajout."
---

## Synopsis

```
rigger catalog ls
rigger catalog add <name> <url>
rigger catalog remove <name>
```

Gère les sources de [catalog](/fr/reference/glossary/#catalog) configurées : la liste des catalogs
distants qu'agent-rigger lit. Il ne modifie que la configuration. Il n'installe, ne met à jour ni ne
supprime jamais d'artifacts. Chaque source est un nom associé à une url git.

## Arguments

| Argument | Utilisé par     | Sens                                                                                                                              |
| -------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `<name>` | `add`, `remove` | Le nom unique de la source. Il devient le préfixe de chaque [qualified id](/fr/reference/glossary/#qualified-id) de cette source. |
| `<url>`  | `add`           | L'url git du catalog.                                                                                                             |

## Sous-commandes

### catalog ls

Liste chaque source configurée sous la forme `<name>  <url>`. Sans aucune configurée, il affiche :

```
no catalog configured — run `rigger init` or `catalog add <name> <url>`
```

### catalog add

Ajoute une source. Le nom doit être unique : un nom existant est rejeté avec
`[error] catalog "<name>" already exists (<url>).` En cas de succès, il affiche `catalog "<name>" added
(<url>)`. Sur un [TTY](/fr/reference/glossary/#tty--non-interactive), add récupère ensuite le nouveau
catalog et propose d'installer depuis celui-ci (le même sélecteur qu'`init`). Un échec de récupération
à cette étape n'est pas fatal : la source reste enregistrée et add affiche :

```
Catalog fetch failed. Run `install` later to install artifacts from the catalog.
```

### catalog remove

Retire une source par son nom. Un nom inconnu est rejeté avec `[error] catalog "<name>" not found.` En
cas de succès, il affiche `catalog "<name>" removed.`

## Interactif vs non-interactif

Seul `catalog add` est interactif, et seulement pour la proposition d'installation après ajout. En
session non-interactive, la source est quand même ajoutée ; la proposition d'installation est sautée.

## Codes de sortie

| Code  | Condition                                                                                   |
| ----- | ------------------------------------------------------------------------------------------- |
| `0`   | Succès.                                                                                     |
| `2`   | Argument manquant, nom déjà existant (`add`), nom introuvable (`remove`), ou verbe inconnu. |
| `130` | Interrompu (Ctrl+C dans le sélecteur après ajout).                                          |

Une sous-commande non reconnue sort `2` avec `Unknown verb "<verb>" for resource "catalog".`
suivi de l'usage.

## Exemple

```
rigger catalog add team https://gitlab.com/acme/rig-catalog.git
```

Voir [codes de sortie](/fr/reference/exit-codes) pour le contrat partagé.
