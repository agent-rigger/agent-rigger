---
title: Plateformes et prérequis
description: "Le contrat de plateforme d'agent-rigger : les cibles OS/architecture pour lesquelles le build de release produit un binaire, le canal du tap Homebrew, les outils externes que la CLI attend au runtime, et les fichiers qu'elle écrit sur disque sous chaque scope et OS."
---

Cette page est le contrat de plateforme d'agent-rigger. Elle couvre les cibles OS/architecture pour
lesquelles le build de release produit un binaire et les outils externes que la CLI attend au
runtime, plus où elle écrit des fichiers sur disque sous chaque
[scope](/fr/reference/glossary/#scope). Elle consigne ce qui est livré et ce que le code résout, pas
comment l'installer. Pour la procédure d'install, voir [Installation](/fr/start/installation/) ; pour
pourquoi les [scanners](/fr/reference/glossary/#scan--scanner) comptent, voir
[Confiance et sécurité](/fr/concepts/trust-and-security/).

## Binaires de release

Chaque tag poussé sous la forme `v*` déclenche le build de release. Un unique hôte `ubuntu-latest`
cross-compile chaque cible avec `bun build --compile --target=…`, si bien qu'un seul job produit
toute la matrice. Il n'y a pas de runner par OS. Ces cinq cibles sont construites et attachées à la
GitHub Release, et rien d'autre :

| Cible de build     | Asset de release               | OS      | Architecture          |
| ------------------ | ------------------------------ | ------- | --------------------- |
| `bun-linux-x64`    | `agent-rigger-linux-x64`       | Linux   | x64                   |
| `bun-linux-arm64`  | `agent-rigger-linux-arm64`     | Linux   | arm64                 |
| `bun-darwin-x64`   | `agent-rigger-darwin-x64`      | macOS   | x64 (Intel)           |
| `bun-darwin-arm64` | `agent-rigger-darwin-arm64`    | macOS   | arm64 (Apple Silicon) |
| `bun-windows-x64`  | `agent-rigger-windows-x64.exe` | Windows | x64                   |

Un sixième asset, `SHA256SUMS.txt`, porte le `sha256sum` de chaque binaire. L'étape de release fixe
`fail_on_unmatched_files: true`, si bien qu'un binaire manquant fait échouer la release plutôt que de
publier un ensemble partiel.

Chaque binaire est un exécutable autonome avec le runtime Bun compilé dedans ; les utilisateurs
finaux n'ont besoin ni de Bun, ni de node, ni d'aucun gestionnaire de paquets pour l'exécuter. Le
binaire compilé rapporte la version tamponnée depuis le tag git quand il est construit en CI ; un
binaire compilé localement rapporte `0.0.0`.

Avant de construire, le job de release lance le gate complet : `bun run lint`, `bun run format:check`,
`bun run typecheck`, `bun test`. Il abandonne la release si une étape échoue. Sur les cinq binaires,
seul `agent-rigger-linux-x64` est smoke-testé en CI (un appel `--version`) ; les quatre autres, y
compris le binaire Windows, sont publiés sans contrôle d'exécution dans le job de release.

### Windows

Windows a un seul binaire préconstruit, `agent-rigger-windows-x64.exe` (x64 uniquement ; il n'existe
pas de cible Windows-on-arm64). Ce binaire est construit et publié à chaque release, mais il n'est ni
smoke-testé en CI ni distribué via le tap Homebrew ci-dessous. Il n'existe pas de chemin de code
spécifique à Windows pour les emplacements sur disque : les chemins se résolvent via la même logique
que sur tout autre OS (voir
[Résolution des chemins entre plateformes](#résolution-des-chemins-entre-plateformes)).

### Architectures sans binaire préconstruit

Les cinq cibles ci-dessus forment l'ensemble complet construit. Toute autre combinaison OS/architecture
(par exemple Windows sur arm64, ou une libc Linux que la cible compilée ne couvre pas) n'a pas de
binaire préconstruit. agent-rigger peut quand même y tourner en construisant depuis les sources sur
toute plateforme que Bun supporte ; le build depuis les sources a besoin de Bun 1.3 ou plus récent et
produit le binaire à `packages/cli/dist/agent-rigger`.

## Canaux de distribution

Trois canaux livrent le même outil, mais seule la formule Homebrew installe l'alias `rigger`
automatiquement. Le binaire de release et le build depuis les sources n'installent que la commande
canonique `agent-rigger` ; ajouter l'alias `rigger` pour l'un ou l'autre est une étape manuelle que
vous effectuez vous-même.

| Canal              | Plateformes couvertes                       | Notes                                                                                                                                            |
| ------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tap Homebrew       | macOS (arm64, x64), Linux (arm64, x64)      | Recommandé. `brew tap agent-rigger/tap && brew install agent-rigger`. Indisponible sur Windows. Installe l'alias `rigger` automatiquement.       |
| Binaire de release | Les cinq cibles de release, Windows compris | Téléchargez l'asset pour votre plateforme, vérifiez-le contre `SHA256SUMS.txt`. L'alias `rigger` est un symlink manuel que vous créez vous-même. |
| Depuis les sources | Tout OS supporté par Bun                    | Nécessite Bun 1.3+. Le binaire rapporte la version `0.0.0`. L'alias `rigger` est un symlink manuel que vous créez vous-même.                     |

La formule Homebrew se nomme `agent-rigger`. Elle livre les quatre binaires Unix (les deux cibles
macOS et les deux cibles Linux) et installe le binaire téléchargé sous le nom canonique plus un
symlink `rigger`. La formule ne couvre pas Windows ; le binaire de release est le seul canal
préconstruit là-bas. La formule est poussée vers le tap dans le même run de release, conditionnée à
un token de tap ; si le token est absent la mise à jour de la formule est sautée et les binaires sont
publiés quand même.

Pour les commandes exactes par canal, voir [Installation](/fr/start/installation/).

## Prérequis au runtime

agent-rigger fait appel à un petit ensemble d'outils externes qui doivent être présents sur `PATH`.
L'outil n'en installe aucun à votre place : les entrées de catalog peuvent porter des
[indications d'install](/fr/reference/catalog-schema/#install) par gestionnaire de paquets, mais
réaliser l'install à partir de ces indications n'est pas encore livré. Installez ces outils via
votre propre gestionnaire de paquets.

[`doctor`](/fr/reference/glossary/#doctor) rapporte la présence de chaque outil dans cet ordre. Un
outil présent affiche `✓ <name> (<resolved path>)` ; un absent affiche
`✗ <name> — missing  hint: <install hint>` avec l'indication verbatim en dessous :

| Outil      | Rôle                                                                                                                                  | Exigence                                         | Indication absente (verbatim)                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `git`      | Récupère les catalogs. Invoqué comme un binaire externe (`git clone`, `git fetch`, `git ls-remote`, `git checkout`, `git rev-parse`). | Requis. Sans lui, aucun catalog ne peut être lu. | `install git: https://git-scm.com/downloads`                                               |
| `glab`     | CLI GitLab, pour s'authentifier contre des sources de catalog hébergées sur GitLab.                                                   | Recommandé.                                      | `install glab: https://gitlab.com/gitlab-org/cli#installation`                             |
| `gitleaks` | Scanner de secrets lancé sur le contenu de catalog récupéré avant qu'il ne soit écrit.                                                | Optionnel.                                       | `install gitleaks: https://github.com/gitleaks/gitleaks#install`                           |
| `trivy`    | Scanner de vulnérabilités et de misconfigurations lancé sur le contenu récupéré.                                                      | Optionnel.                                       | `install trivy: https://aquasecurity.github.io/trivy/latest/getting-started/installation/` |

Un [assistant](/fr/reference/glossary/#assistant) (Claude Code ou opencode) est requis en pratique :
sans aucun d'installé, agent-rigger n'a rien à configurer.

### Mode scan

Les deux [scanners](/fr/reference/glossary/#scan--scanner) sont détectés sur `PATH` au moment du scan
et tournent en parallèle quand présents. Le mode dépend uniquement du fait qu'au moins un est
installé. `doctor` affiche le mode après la liste d'outils, verbatim :

- Au moins un de `gitleaks`/`trivy` présent — `mode : full scan`
- Aucun présent — `mode : warn-only (external content not scanned — install gitleaks or trivy)`

En mode [warn-only](/fr/reference/glossary/#warn-only) l'install se poursuit avec un avertissement
plutôt qu'un blocage, si bien que du contenu non scanné atteint votre poste. Installer au moins un
scanner est ce qui rend le contrôle de sécurité réel.

## Chemins que l'outil crée

agent-rigger écrit dans des emplacements fixes par assistant et par scope. Les tableaux ci-dessous
listent les chemins logiques ; `<home>` est le répertoire home résolu et `<cwd>` est le répertoire de
travail courant (voir
[Résolution des chemins entre plateformes](#résolution-des-chemins-entre-plateformes) pour la façon
dont chacun est résolu).

### Claude Code — scope user

| Chemin                                     | Contenu                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| `<home>/.claude/settings.json`             | Settings Claude Code que l'outil gère.                                 |
| `<home>/.claude/CLAUDE.md`                 | Fichier de context scope user.                                         |
| `<home>/.claude/harness/AGENTS.md`         | Fichier agents du harness.                                             |
| `<home>/.config/agent-rigger/config.json`  | [Catalog sources](/fr/reference/glossary/#catalog-source) configurées. |
| `<home>/.config/agent-rigger/state.json`   | État d'install enregistré (le manifest qu'agent-rigger lit et écrit).  |
| `<home>/.config/agent-rigger/consent.json` | Octrois de [consent](/fr/reference/glossary/#consent) enregistrés.     |
| `<home>/.config/agent-rigger/skills/`      | Le [store](/fr/reference/glossary/#store) physique des skills.         |

### Claude Code — scope project

| Chemin                        | Contenu                                        |
| ----------------------------- | ---------------------------------------------- |
| `<cwd>/.claude/settings.json` | Settings Claude Code de scope project.         |
| `<cwd>/.claude/CLAUDE.md`     | Fichier de context de scope project.           |
| `<cwd>/AGENTS.md`             | Fichier agents du projet à la racine du dépôt. |

### opencode — scope user

| Chemin                                  | Contenu                                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `<home>/.config/opencode/opencode.json` | Configuration opencode.                                                                                  |
| `<home>/.config/opencode/AGENTS.md`     | Fichier agents de scope user.                                                                            |
| `<home>/.config/opencode/agents/`       | Répertoire des agents.                                                                                   |
| `<home>/.config/opencode/plugin/`       | Répertoire des plugins.                                                                                  |
| `<home>/.config/opencode/skills/`       | Symlink vers le store physique ; les skills eux-mêmes vivent sous `<home>/.config/agent-rigger/skills/`. |

### opencode — scope project

| Chemin                    | Contenu                                      |
| ------------------------- | -------------------------------------------- |
| `<cwd>/opencode.json`     | Configuration opencode à la racine du dépôt. |
| `<cwd>/AGENTS.md`         | Fichier agents du projet.                    |
| `<cwd>/.opencode/agents/` | Répertoire des agents du projet.             |
| `<cwd>/.opencode/plugin/` | Répertoire des plugins du projet.            |
| `<cwd>/.opencode/skills/` | Répertoire des skills du projet.             |

Un troisième id d'assistant, `copilot`, est réservé : il n'a ni adapter ni convention sur disque,
donc l'outil n'écrit aucun chemin pour lui. Le support Copilot n'est pas livré.

## Résolution des chemins entre plateformes

La disposition sur disque ci-dessus est identique entre Linux, macOS et Windows. Seuls le répertoire
racine et le séparateur diffèrent, tous deux résolus par le runtime plutôt que par une branche par OS
dans l'outil.

`<home>` est résolu dans cet ordre, la première valeur non vide gagne :

1. `RIGGER_HOME` — l'[override](/fr/reference/glossary/#rigger_home) utilisé pour l'isolation de test
   et pour rediriger tout chemin de scope user.
2. `HOME`
3. Le répertoire home du runtime (`os.homedir()`) comme dernier recours.

Sur Windows, `HOME` est typiquement non défini, donc `<home>` retombe sur le répertoire home du
runtime (`%USERPROFILE%`). `<cwd>` est le répertoire de travail du processus.

Les noms de répertoires `.claude` et `.config` sont des littéraux fixes. Il n'y a pas de gestion
`XDG_CONFIG_HOME` : même sur Linux la racine de config est toujours `<home>/.config/agent-rigger`,
jamais un chemin dérivé de `$XDG_CONFIG_HOME`. De même il n'y a pas de gestion Windows
`APPDATA`/`LOCALAPPDATA`. Les mêmes noms `.config` et `.claude` s'appliquent, joints avec le
séparateur de chemin de la plateforme sous `%USERPROFILE%`.
