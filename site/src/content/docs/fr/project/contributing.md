---
title: Contribuer
description: "Mettre en place agent-rigger, lancer les gates de qualité qu'un changement doit passer, et le proposer : prérequis, structure du workspace, commits conventionnels et déroulé de la pull request."
---

Cette page s'adresse aux contributeurs qui travaillent sur le CLI lui-même, pas aux personnes qui
configurent un [catalog](/fr/reference/glossary/#catalog). Elle couvre la mise en place, les gates
de qualité et le déroulé de la pull request.

## Prérequis

- **Bun >= 1.3.0** — le runtime et le gestionnaire de paquets (`bun --version`). agent-rigger
  n'utilise ni node ni pnpm.
- **git** — requis pour les opérations sur les catalogs distants et pour la suite de tests.
- **gitleaks et/ou trivy** — nécessaires pour exercer le chemin de
  [scan](/fr/reference/glossary/#scan--scanner) de bout en bout. Sans l'un des deux sur le `PATH`,
  une install s'exécute quand même mais se dégrade en warn-only : le contenu récupéré n'est
  simplement pas scanné. Les tests unitaires ne les requièrent pas.

## Mise en place

```sh
git clone https://github.com/agent-rigger/agent-rigger.git
cd agent-rigger
bun install          # runs the prepare script, which installs git hooks via lefthook
```

`bun install` lance le script `prepare` (`lefthook install`), donc les hooks de commit sont
branchés dès le premier `bun install`.

## Gates de qualité

Chaque changement doit passer les mêmes gates que ceux que la CI exécute. Lancez-les en local
avant d'ouvrir une pull request :

```sh
bun run test         # bun test --pass-with-no-tests
bun run lint         # oxlint
bun run format:check # dprint check — formatting must be clean
bun run typecheck    # tsc --noEmit
```

Appliquez le formatage avec `bun run format` (`dprint fmt`).

Les hooks git n'en couvrent qu'une partie. Le hook `pre-commit` formate et linte automatiquement
vos fichiers **staged** (`dprint fmt`, `oxlint --fix`) puis re-stage les corrections ; le hook
`commit-msg` valide le message de commit. Les tests et le typecheck ne sont lancés par **aucun**
hook. Ils tournent en CI, donc lancez vous-même les quatre gates ci-dessus avant de pousser.

## Structure du workspace

C'est un workspace Bun. Le source du CLI vit sous `packages/` :

| Package                  | Responsabilité                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `@agent-rigger/core`     | Moteur de plan/apply, [manifest](/fr/reference/glossary/#manifest), backup et rollback, linker. |
| `@agent-rigger/adapters` | Les [adapters](/fr/reference/glossary/#adapter) par assistant (Claude Code, opencode).          |
| `@agent-rigger/catalog`  | Modèle de catalog, merge, schéma, récupération distante.                                        |
| `@agent-rigger/cli`      | L'interface en ligne de commande et les handlers par commande.                                  |

Le CLI n'embarque **aucun contenu propre** : chaque [artifact](/fr/reference/glossary/#artifact)
vient d'un catalog configuré. Gardez cette frontière : la logique moteur dans `core`, les
écritures spécifiques à une cible dans `adapters`, et jamais de contenu de catalog codé en dur
dans l'outil.

## Commits

Les commits suivent [Conventional Commits](https://www.conventionalcommits.org/), imposés par
commitlint (le ruleset `@commitlint/config-conventional`) via le hook `commit-msg`. Par exemple :

```
feat(cli): add `catalog ls --json` output
fix(core): revert symlink on partial apply failure
docs(readme): document the remote install flow
```

Gardez des commits incrémentaux et scopés. Un changement focalisé avec un message clair est plus
facile à passer en review qu'un gros commit qui mélange tout.

## Pull requests

1. Créez une branche depuis `main` (`git checkout -b feat/<short-name>`). Ne travaillez jamais
   directement sur `main`.
2. Faites le changement avec des tests qui couvrent le nouveau comportement.
3. Lancez les quatre gates de qualité ci-dessus ; tous doivent passer.
4. Ouvrez une PR qui décrit **ce qui** a changé et **pourquoi**. Liez toute issue associée.
5. La CI doit être verte avant la review.

## Invariants de design

Quelques invariants valent dans tout l'outil, et les changements sont censés les préserver :

- **[Idempotence](/fr/reference/glossary/#idempotence)** — relancer une opération déjà appliquée
  ne produit aucun nouveau changement.
- **Backup avant écriture** — un fichier existant reçoit un backup avant qu'agent-rigger ne le
  remplace.
- **Humain dans la boucle** — les actions destructives demandent confirmation plutôt que de
  s'exécuter en silence.
- **Pas d'échec silencieux** — les erreurs remontent ; elles ne sont jamais avalées.

Si votre changement touche l'un d'eux, dites-le dans la pull request et expliquez l'impact. Les
reviewers pèsent ces changements différemment, donc l'annoncer d'emblée évite un aller-retour.

## Signaler un bug ou un problème de sécurité

- **Bugs et demandes de fonctionnalité** — ouvrez une issue GitHub avec les étapes pour
  reproduire.
- **Vulnérabilités de sécurité** — n'ouvrez **pas** d'issue publique. Suivez le processus de la
  [politique de sécurité](/fr/project/security-policy/).
