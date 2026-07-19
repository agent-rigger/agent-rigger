---
title: install
description: Installez des artifacts de façon interactive, par qualified id, ou en ad-hoc depuis une URL ou un chemin, via le pipeline récupération-scan-résolution-confirmation-application.
---

## Synopsis

```
rigger install [--scope=<user|project>] [--assistant=<claude|opencode>]
rigger install <id...> [--yes] [--force] [--secret-env=<ref>=<VAR>]...
rigger install <url|path> [--yes] [--force]
```

`install` ajoute des artifacts au poste courant pour un [assistant](/fr/reference/glossary/#assistant).
Il fonctionne dans l'un de ses trois modes selon ses arguments : un sélecteur interactif quand aucun
n'est fourni, une liste de [qualified ids](/fr/reference/glossary/#qualified-id) pour une install
scriptée, ou une unique URL ou un chemin pour une install ad-hoc. Chaque mode affiche un
[plan](/fr/reference/glossary/#plan-dry-run) et n'écrit rien avant votre confirmation.

## Arguments

| Argument      | Mode                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| _(aucun)_     | Interactif : récupérer l'[effective catalog](/fr/reference/glossary/#effective-catalog), choisir dans une liste groupée. |
| `<id...>`     | Un ou plusieurs qualified ids, `<catalog>/<nature>:<name>`.                                                              |
| `<url\|path>` | Une unique URL git ou un chemin local, installé en ad-hoc.                                                               |

Un id non qualifié, un préfixe non configuré, et l'absence totale de catalog sont chacun rejetés
avant tout accès réseau, tous sortent en `2` :

```
[error] unqualified id "<id>" — use `<catalog>/<id>` (see `rigger ls`)
[error] catalog "<prefix>" not configured — see `rigger catalog ls`
[error] no catalog configured — run `rigger init`
```

## Flags

| Flag                       | Effet                                                                                                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--scope`                  | Installer dans `user` (à l'échelle du poste) ou `project` (dépôt courant) ; `user` par défaut.                                                                                                                        |
| `--assistant`              | Cibler `claude` ou `opencode` ; sinon résolu comme décrit dans la [vue d'ensemble](/fr/reference/cli/overview).                                                                                                       |
| `--yes`                    | Sauter l'invite de confirmation. En mode interactif il n'est pas utilisé ; en modes id et ad-hoc il applique le plan sans demander.                                                                                   |
| `--force`                  | Rétrograder un finding bloquant de [scan](/fr/reference/glossary/#scan--scanner) de sécurité en avertissement et poursuivre.                                                                                          |
| `--secret-env=<ref>=<VAR>` | Faire correspondre une [référence de secret](/fr/reference/glossary/#secret-by-environment-reference-var) du catalog à une variable d'environnement de votre poste. Répétable ; la dernière valeur l'emporte par ref. |

## Les trois modes

**Interactif.** Sans ids, `install` demande le scope (sauf si `--scope` a été fourni), classe chaque
entrée de catalog face au manifest et à la version distante, et affiche un sélecteur regroupé en
_à installer_, _à mettre à jour_ et _à jour_. Quand rien n'est actionnable, il affiche ce qui suit
et sort en `0` :

```
✓ Everything already up-to-date for scope "<scope>" (<n> artifact(s) installed). Use `rigger remove` to uninstall.
```

Ne rien sélectionner affiche `No artifacts selected — nothing to install.` et sort en `0`.

**Par qualified id.** Les ids sont regroupés par préfixe de catalog et installés une source à la
fois. Un [pack](/fr/reference/glossary/#pack) se déploie en ses membres, et la chaîne
[`requires`](/fr/reference/glossary/#requires) de chaque artifact est entraînée.

**Ad-hoc.** Une unique URL ou un chemin installe du contenu extérieur aux catalogs configurés. Il
est traité comme [untrusted](/fr/reference/glossary/#untrusted-content) : chaque fichier récupéré est
scanné avant toute écriture. Le manifest enregistre un préfixe de source dérivé pour conserver la
provenance : `github.com/...` devient `gh-<repo>`, `gitlab.com/...` devient `glab-<repo>`, un autre
hôte devient `<host-without-TLD>-<repo>` (le label de domaine de second niveau ;
`git.company.io/owner/repo` → `company-repo`), et un chemin local devient `local-<name>`. Sous
`--yes`, l'install ad-hoc sélectionne chaque entrée ; sans lui, un sélecteur est affiché.

## Pipeline

Chaque install de source suit les mêmes étapes : résoudre la version distante,
[shallow-cloner](/fr/reference/glossary/#shallow-clone) le contenu, se prémunir contre les ids de
path-traversal, scanner (`catalog.json` et chaque artifact récupéré), fusionner et résoudre la
sélection, construire le plan, confirmer, puis appliquer : [backup](/fr/reference/glossary/#backup-bak),
écriture, enregistrement du [manifest](/fr/reference/glossary/#manifest). Aucun fichier n'est écrit
avant que le scan passe et que le plan soit confirmé.

Quand aucun outil de scan n'est installé, le scan se dégrade en warn-only et l'install se poursuit :

```
[warning] content not scanned — install gitleaks or trivy then re-run for a full scan; see `rigger doctor`
```

Quand un scanner est présent et rapporte un finding bloquant, l'install s'arrête (`ScanBlockedError`)
sauf si `--force` est positionné.

### Ce que `--force` ne contourne pas

`--force` outrepasse un finding de scan et rien d'autre. Il ne contourne pas une incohérence de
provenance ref/sha (`RefShaMismatchError`), un id de path-traversal, ni un `requires` cross-catalog
non satisfait. Chacun de ces cas refuse l'install et sort en `2`, forcé ou non.

## Interactif vs non-interactif

Le mode interactif (sans ids) a besoin d'un TTY : en session non-interactive son sélecteur ne peut
pas s'ouvrir, l'exécution est donc rejetée immédiatement, avant tout accès réseau, même sous
`--yes` :

```
[error] interactive picker requires a TTY — pass explicit ids to install non-interactively
```

Dans une session non-interactive, les installs par id et ad-hoc exigent `--yes` ; sans lui,
l'exécution sort en `2` avant tout accès réseau (`[error] non-interactive session — pass --yes to confirm non-interactively`).
Sous `--yes`, un secret MCP required sans correspondance `--secret-env` ni valeur ambiante est une
erreur fail-closed (sort en `2`), puisqu'aucune invite n'est possible.

## Codes de sortie

| Code  | Condition                                                                                                                                                                                                                                                            |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`   | Installé, ou rien à installer / sélection refusée.                                                                                                                                                                                                                   |
| `2`   | Id erroné ou non qualifié, entrée inconnue, cycle de dépendances, `require` cross-catalog non satisfait, incohérence de provenance, aucun catalog configuré, aucun id en session non-TTY, non-TTY sans `--yes`, `--secret-env` malformé, secret required non résolu. |
| `1`   | Échec de récupération ou de clone, scan bloqué (sans `--force`), une autre exécution détient le verrou, échec d'install de plugin ou de skill.                                                                                                                       |
| `130` | Une invite a été annulée par Ctrl+C.                                                                                                                                                                                                                                 |

Voir [codes de sortie](/fr/reference/exit-codes) pour le contrat commun.

## Exemple

```
rigger install team/skill:spec-workflow --scope=project --yes
```
