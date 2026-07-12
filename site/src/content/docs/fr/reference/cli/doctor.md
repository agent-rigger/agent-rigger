---
title: doctor
description: Diagnostique les dépendances de l'environnement et l'état installé, en option par comparaison à un différentiel de catalog distant, et répare les findings sûrs avec consentement.
---

## Synopsis

```
agent-rigger doctor [--remote] [--fix [--yes]]
```

Lance deux diagnostics dans l'ordre. D'abord il rapporte les outils externes dont agent-rigger dépend
et s'il scannera ou tournera en [warn-only](/fr/reference/glossary/#warn-only). Puis il lit l'état
installé et rapporte ce qui a [drifté](/fr/reference/glossary/#drift), regroupé par classe de
[finding](/fr/reference/glossary/#finding). L'opération est en lecture seule tant que `--fix` n'est
pas passé.

## Phase 1 : dépendances de l'environnement

Vérifie quatre binaires dans l'ordre : `git`, `glab`, `gitleaks`, `trivy`.

```
✓ git (/opt/homebrew/bin/git)
✗ trivy — missing  hint: install trivy: ...
```

Une ligne de mode suit. `mode : full scan` quand `gitleaks` ou `trivy` est présent. Sinon
`mode : warn-only (external content not scanned — install gitleaks or trivy)`.

## Phase 2 : état installé

Lit le [manifest](/fr/reference/glossary/#manifest) et la disposition sur disque pour `claude` et
`opencode`, puis rapporte les findings regroupés en six classes :

| Classe      | Sens                                                                                                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `untracked` | Un artifact sur le disque sans entrée de manifest. Un artifact conforme est adoptable ; un qui diverge de son [store](/fr/reference/glossary/#store) est rapporté comme drift et laissé intact. |
| `dangling`  | Un [symlink](/fr/reference/glossary/#symlink) dont la cible a disparu.                                                                                                                          |
| `phantom`   | Un répertoire de store que rien ne référence.                                                                                                                                                   |
| `manifest`  | Une entrée qui ne correspond plus à la réalité (catalog orphelin, sha manquant, fichier manquant, drift d'applied payload), ou un `state.json` dont la forme de premier niveau est invalide.    |
| `lock`      | Un [run-lock](/fr/reference/glossary/#run-lock) résiduel.                                                                                                                                       |
| `hygiene`   | Des fichiers temporaires ou des backups vieillis.                                                                                                                                               |

Un état sain affiche `Installed state is healthy — no findings.` Chaque finding tient sur une ligne :
son résumé et un tag, `[fix]`, `[confirm]`, ou `[report]`. Si une exécution semble en cours (un
run-lock vivant), le scan de l'état installé est sauté, rapporté, et la commande sort `0`.

## --remote (différentiel)

Par défaut, la phase 2 ne touche pas au réseau. Avec `--remote`, doctor récupère aussi le contenu de
chaque [catalog](/fr/reference/glossary/#catalog) configuré, en lecture seule, et le compare à l'hôte
pour faire remonter des findings sans signature sur disque : une règle de
[guardrail](/fr/reference/glossary/#guardrail), un bloc de [context](/fr/reference/glossary/#context),
ou un serveur [mcp](/fr/reference/glossary/#mcp) présent sur l'hôte mais non suivi. La récupération est
[fail-closed](/fr/reference/glossary/#fail-closed--fail-open) : toute erreur de récupération arrête la
commande et nomme la source fautive plutôt que de se dégrader en un scan disque-seul. Combinable avec
`--fix`.

## --fix (réparation consentie)

Applique les réparations que portent les findings. Le [consent](/fr/reference/glossary/#consent) requis
dépend de l'acte réalisé :

| Tag                        | Règle d'octroi                                                                                  | Actes                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `[fix]` (sûr)              | [`--yes`](/fr/reference/glossary/#yes) l'octroie ; sur un TTY sans `--yes` chacun est confirmé. | Adopter une entrée skill, agent ou plugin ; supprimer un débris de staging orphelin ou de lock-break ; sauvegarder un `state.json` malformé. |
| `[confirm]` (item-confirm) | `--yes` n'est jamais suffisant. Confirmé par item sur un TTY ; sauté hors TTY.                  | Retirer un symlink dangling ; supprimer un store phantom ; casser un run-lock ; supprimer un backup vieilli.                                 |
| `[report]` (report-only)   | Pas de réparation.                                                                              | La marche à suivre manuelle figure dans le résumé du finding.                                                                                |

Aucun acte destructeur n'est couvert par un `--yes` global. Casser un run-lock revérifie l'identité
et la vivacité du verrou au moment d'agir. Un `--fix` hors TTY sans `--yes` sort `2` avant toute
réparation, faute de pouvoir obtenir les confirmations par item.

## Interactif vs non-interactif

`doctor` seul et `doctor --remote` ne demandent jamais confirmation. `doctor --fix` demande
confirmation par item sur un [TTY](/fr/reference/glossary/#tty--non-interactive). Hors TTY il exige `--yes` et n'applique alors que
les réparations sûres.

## Codes de sortie

Diagnostic (sans `--fix`) :

| Code  | Condition                                                                                                                     |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- |
| `0`   | Sain, ou le scan a été sauté sous un verrou vivant.                                                                           |
| `3`   | Un ou plusieurs findings.                                                                                                     |
| `2`   | Forme de `state.json` invalide, ou un désaccord de provenance `--remote` (le sha du checkout diffère de celui du ref résolu). |
| `1`   | Une récupération de catalog `--remote` a échoué.                                                                              |
| `130` | Interrompu.                                                                                                                   |

Réparation (`--fix`) :

| Code  | Condition                                                         |
| ----- | ----------------------------------------------------------------- |
| `0`   | Toutes les réparations appliquées.                                |
| `3`   | Des findings subsistent (report-only, refusés, ou sautés).        |
| `2`   | Forme de `state.json` invalide, ou `--fix` hors TTY sans `--yes`. |
| `1`   | Une réparation a échoué.                                          |
| `130` | Interrompu.                                                       |

## Exemple

```
agent-rigger doctor --remote --fix
```

Voir [codes de sortie](/fr/reference/exit-codes) pour le contrat partagé.
