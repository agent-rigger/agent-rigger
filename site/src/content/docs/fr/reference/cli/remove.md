---
title: remove
description: Désinstalle hors ligne les artifacts enregistrés au manifest, en rejouant chaque install à l'envers selon un plan confirmé ; les fichiers driftés sont laissés intacts.
---

## Synopsis

```
rigger remove <id>... [--yes] [--scope=<user|project>] [--assistant=<claude|opencode>]
rigger <resource> remove <id>...
```

Désinstalle les artifacts enregistrés dans le [manifest](/fr/reference/glossary/#manifest). L'opération
est manifest-first et entièrement hors ligne : le [catalog](/fr/reference/glossary/#catalog) n'y joue
aucun rôle. L'[applied payload](/fr/reference/glossary/#applied-payload) de chaque entrée est rejoué à
l'envers pour défaire l'install à l'identique. Chaque suppression est prévisualisée et confirmée avant
que rien ne soit effacé.

## Arguments

| Argument  | Requis | Sens                                                                                                |
| --------- | ------ | --------------------------------------------------------------------------------------------------- |
| `<id>...` | oui    | [Qualified ids](/fr/reference/glossary/#qualified-id) (`<catalog>/<nature>:<name>`) à désinstaller. |

## Plan de suppression

Le [plan](/fr/reference/glossary/#plan-dry-run) liste un groupe par artifact. Chaque op nomme ce
qu'elle défait :

| Op                         | Défait                                                                                                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deny (-N)` / `allow (-N)` | Des règles de [guardrail](/fr/reference/glossary/#guardrail) retirées de `settings.json`.                                                                                                     |
| `unimport`                 | Un bloc de [context](/fr/reference/glossary/#context) managé retiré.                                                                                                                          |
| `restore`                  | Un fichier ramené à son contenu d'avant l'install.                                                                                                                                            |
| `delete`                   | Un fichier supprimé.                                                                                                                                                                          |
| `unlink`                   | Un [symlink](/fr/reference/glossary/#symlink) retiré. Une ligne `store` suit, marquant le [store](/fr/reference/glossary/#store) `(deleted — last reference)` ou `(kept — still referenced)`. |
| `uninstall`                | Un plugin désinstallé via l'assistant (la commande `claude plugin uninstall <name>` est affichée).                                                                                            |
| `un-hook`                  | Un [hook](/fr/reference/glossary/#hook) déréférencé.                                                                                                                                          |

## Cas particuliers

- **Drift laissé intact.** Si une cible sur le disque ne correspond plus à ce qui a été installé,
  remove la laisse en place et avertit. Un fichier édité à la main n'est jamais supprimé.
- **Déjà absent.** Une entrée dont la cible a déjà disparu est purgée du manifest sans toucher au
  disque et sans invite, rapportée comme `purged (already absent)`.
- **Packs.** Un [pack](/fr/reference/glossary/#pack) est déplié au moment de l'install et n'est jamais
  enregistré comme tel. Supprimez plutôt ses artifacts membres. Demander un id de pack signale que les
  packs sont dépliés à l'install et liste ce qui est installé.

## Backups

Avant d'écraser ou de restaurer un fichier, remove écrit une copie
[`.bak-*`](/fr/reference/glossary/#backup-bak) à côté, rapportée comme
`[backup] N file(s) backed up.`

## Interactif vs non-interactif

Sur un [TTY](/fr/reference/glossary/#tty--non-interactive), remove affiche le plan et demande
confirmation. Un refus ne supprime rien et rapporte `[aborted] Removal cancelled by user.` Une purge
pure (uniquement des entrées déjà absentes) ne modifie que le manifest et avance sans invite. Une
session non-interactive sans [`--yes`](/fr/reference/glossary/#yes) sort `2` avant toute mutation.

## Flags

| Flag                             | Effet                                                                   |
| -------------------------------- | ----------------------------------------------------------------------- |
| `--yes`                          | Passe l'invite de confirmation. Requis en session non-interactive.      |
| `--scope=<user\|project>`        | Scope visé. Par défaut : `user`.                                        |
| `--assistant=<claude\|opencode>` | Assistant visé. Par défaut, résolu depuis le manifest des ids demandés. |

## Codes de sortie

| Code  | Condition                                                         |
| ----- | ----------------------------------------------------------------- |
| `0`   | Supprimé, purgé, rien à supprimer, ou refusé.                     |
| `2`   | Id non qualifié, id non installé, ou non-interactif sans `--yes`. |
| `130` | Interrompu.                                                       |

Supprimer un id que le manifest ne connaît pas sort `2` avec `[error] Artifact "<id>" is not
installed.` suivi de l'inventaire installé (`Installed entries: <ids>.`, ou `Nothing is
installed.` quand le manifest est vide).

## Exemple

```
rigger remove team/skill:spec-workflow
```

Voir [codes de sortie](/fr/reference/exit-codes) pour le contrat partagé.
