---
title: update
description: Met à jour les artifacts installés vers leur dernière version distante en les re-récupérant, avec un contrôle d'obsolescence au sha près et une réinstallation transactionnelle et confirmée.
---

## Synopsis

```
rigger update [<id>...] [--yes] [--force] [--scope=<user|project>] [--assistant=<claude|opencode>]
rigger <resource> update <id>... [--yes] [--force]
```

Met à jour les artifacts installés vers leur dernière version distante en les re-récupérant depuis
leur [catalog](/fr/reference/glossary/#catalog). Sans id, tout artifact du
[manifest](/fr/reference/glossary/#manifest) dont le préfixe de catalog correspond à une source
configurée — pour le [scope](/fr/reference/glossary/#scope) et l'[assistant](/fr/reference/glossary/#assistant)
visés — est un candidat. Les entrées d'un catalog qui n'est plus configuré sont écartées (le finding
orphan-catalog de doctor les couvre). Chaque candidat est classé stale, up-to-date ou skipped, et
seuls les stale sont réinstallés.

## Arguments

| Argument  | Requis | Sens                                                                                                                                                                                            |
| --------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<id>...` | non    | [Qualified ids](/fr/reference/glossary/#qualified-id) (`<catalog>/<nature>:<name>`) à mettre à jour. Omis : tout artifact installé dans le scope pour l'assistant, issu d'un catalog configuré. |

## Classification

Chaque candidat tombe dans un seul bucket :

- **stale** (`[updated]`) : le remote détient une version plus récente. La comparaison tient compte du
  [sha](/fr/reference/glossary/#sha). Un [tag](/fr/reference/glossary/#tag) re-poussé sur un
  nouveau commit est détecté comme stale même si son nom n'a pas changé.
- **up-to-date** (`[up-to-date]`) : déjà au dernier [ref](/fr/reference/glossary/#ref).
- **skipped** (`[skipped]`) : non installé, ou installé sans version distante (ref `v0.0.0`).
  Une transaction refusée n'est pas un skip par id : elle rapporte `[aborted] Update cancelled by user.`
  sans tag par id.

## Comportement transactionnel

Pour les entrées stale, update récupère le nouveau contenu dans un checkout temporaire, le scanne, et
affiche le [plan](/fr/reference/glossary/#plan-dry-run) avant de toucher quoi que ce soit. Un échec
réseau, un catalog invalide ou un désaccord de [provenance](/fr/reference/glossary/#provenance)
interrompt avant toute suppression : l'artifact reste à sa version installée. Rien n'est supprimé ni
écrit avant votre confirmation. Un refus laisse chaque artifact à son ancienne version et rapporte
`[aborted] Update cancelled by user.`

Une entrée [mcp](/fr/reference/glossary/#mcp) stale rejoue ses références de secret enregistrées :
update ne redemande donc jamais un secret déjà résolu au moment de l'install.

## Flags

| Flag                             | Effet                                                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--yes`                          | Passe l'invite de confirmation. Requis en session non-interactive.                                                                                                                   |
| `--force`                        | Continue malgré un finding de [scan](/fr/reference/glossary/#scan--scanner) bloquant : avertit et poursuit au lieu de [fail-closed](/fr/reference/glossary/#fail-closed--fail-open). |
| `--scope=<user\|project>`        | Scope visé. Par défaut : `user`.                                                                                                                                                     |
| `--assistant=<claude\|opencode>` | Assistant visé. Par défaut, résolu depuis le manifest, puis la config.                                                                                                               |

## Interactif vs non-interactif

Sur un [TTY](/fr/reference/glossary/#tty--non-interactive), update affiche le plan et demande
confirmation. En session non-interactive sans [`--yes`](/fr/reference/glossary/#yes), il sort `2`
avant toute récupération, faute de pouvoir demander.

## Codes de sortie

| Code  | Condition                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------- |
| `0`   | Mis à jour, up-to-date, rien à mettre à jour, ou refusé.                                                                        |
| `2`   | Id non qualifié, aucun catalog configuré, non-interactif sans `--yes`, ou désaccord de provenance.                              |
| `1`   | Une récupération de catalog a échoué, un scan a bloqué la mise à jour (sans `--force`), ou une autre exécution tient le verrou. |
| `130` | Interrompu.                                                                                                                     |

Sans catalog configuré, update affiche `[error] No catalog URL configured.` et sort `2`.

## Exemple

```
rigger update team/skill:spec-workflow --yes
```

Voir [codes de sortie](/fr/reference/exit-codes) pour le contrat partagé.
