---
title: Glossaire
description: Le vocabulaire partagé d'agent-rigger — chaque terme produit défini pour les lecteurs techniques comme non techniques.
---

Cette page fixe le sens de chaque terme employé dans le reste de la documentation. Elle est
organisée par thème plutôt qu'alphabétiquement, pour qu'un lecteur qui découvre l'outil suive le
modèle depuis le début ; un [index alphabétique](#index-alphabétique) en fin de page renvoie
directement à un terme précis.

Une définition ne s'appuie jamais sur un jargon qu'elle n'a pas elle-même défini. Quand un mot a
plusieurs sens courants, les deux sont énoncés et celui retenu ici est signalé. Les termes produit
restent en anglais — ce sont ceux que la ligne de commande et l'interface emploient — et sont
définis en français.

## Produit et modèle mental

#### harness

Tout ce qui façonne le comportement d'un assistant de code IA sur un dépôt — ses skills, sous-agents,
guardrails, fichiers de contexte, plugins, et les outils externes qu'il suppose présents. Laissé à
chaque
développeur, le harness d'une équipe dérive : deux postes ne finissent jamais configurés pareil.
agent-rigger existe pour rendre le harness partagé, versionné et reproductible.

#### agent-rigger

L'outil en ligne de commande décrit par cette documentation — un « harness package manager » pour
les équipes. Il partage, installe et met à jour le harness d'une équipe sur le poste de chacun à
partir d'une source unique de vérité. Il se distribue en deux binaires, `agent-rigger` et le plus
court `rigger`.

#### rig

Le harness choisi par une équipe — la sélection standardisée d'artifacts qu'elle convient de
partager. En pratique un rig s'exprime via un [catalog](#catalog) : les packs, entrées et scopes
qu'il déclare. Lancer `rigger` applique cette sélection, si bien que chaque membre obtient le même
harness.

#### assistant

Un assistant de code IA visé par agent-rigger. Trois sont reconnus : `claude` (Claude Code),
`opencode`, et `copilot` (réservé — aucun adapter pour l'instant, donc le sélectionner échoue avec
une erreur explicite). Le même artifact source est traduit vers le format natif de chacun par un
[adapter](#adapter).

#### adapter

Le module qui traduit un artifact canonique vers la forme exacte attendue par un assistant donné —
où va le fichier, quel format il prend. Ajouter la prise en charge d'un nouvel assistant, c'est
ajouter un adapter, pas réécrire les artifacts.

#### delegate-first

Le principe selon lequel, si un assistant sait installer un artifact par son propre mécanisme natif,
agent-rigger lui délègue plutôt que de recopier des fichiers à la main. L'outil ne fait à la main
que ce qu'aucun assistant ne gère nativement.

#### preset

Un rig de départ qu'une organisation embarque, pour qu'un poste neuf parte des valeurs par défaut de
l'équipe au lieu d'une configuration vide. Un preset peut aussi encoder des contraintes — par
exemple que l'accès git doive passer par HTTPS plutôt que SSH.

## Artifacts et natures

#### artifact

L'unité qu'installe agent-rigger — une pièce distribuable de configuration de harness. Chaque
artifact a exactement une [nature](#nature). Les dépendances entre artifacts sont déclarées dans le
[catalog](#catalog), jamais dans les fichiers de l'artifact eux-mêmes.

#### nature

Le genre d'un artifact. Il existe **huit** natures, chacune installée différemment : [skill](#skill),
[agent](#agent-sub-agent), [guardrail](#guardrail), [context](#context), [plugin](#plugin),
[mcp](#mcp), [tool](#tool), et [hook](#hook).

#### skill

Une capacité réutilisable empaquetée au format cross-vendor `SKILL.md` (voir
[agentskills.io](#agentskillsio)). Installée une fois dans le [store](#store) managé et exposée à
chaque assistant via un [symlink](#symlink).

#### agent (sub-agent)

Une définition de **sous-agent** Claude Code — un assistant spécialisé auquel l'assistant principal
peut confier une tâche, stocké dans un fichier Markdown. Distribué comme un [skill](#skill) : un
store managé plus un symlink.

**Ne pas confondre `agent` et `AGENTS.md`.** La nature `agent` est un sous-agent ; `AGENTS.md` est
un simple fichier d'instructions qui relève de la nature [context](#context). Mot d'apparence
identique, choses sans rapport.

#### guardrail

Une règle _d'enforcement_ qui bloque durement une action. Sur Claude Code c'est une entrée
`permissions.deny` dans `settings.json` ; sur opencode une clé `permission` dans `opencode.json`.
Les guardrails sont la seule chose qu'aucun plugin d'assistant ne peut porter seul, d'où leur
gestion directe par l'outil.

#### context

Des instructions ou règles _advisory_ qui orientent l'assistant sans rien contraindre. Sa forme
canonique est le fichier `AGENTS.md` (voir [agents.md](#agentsmd)). Comme Claude Code lit `CLAUDE.md`
et non `AGENTS.md`, l'outil relie les deux — voir [AGENTS.md bridge](#agentsmd-bridge).

#### plugin

Un plugin d'assistant regroupant hooks et commandes. agent-rigger installe un plugin en déléguant au
mécanisme de plugin propre à l'assistant ([delegate-first](#delegate-first)).

#### mcp

Un serveur MCP déclaré pour un assistant — voir [MCP](#mcp-model-context-protocol). La config du
serveur est stockée telle quelle ; tout secret qu'elle contient est écrit comme une
[référence d'environnement](#secret-by-environment-reference-var), jamais une valeur littérale.

#### tool

Un programme en ligne de commande tiers que le harness suppose présent (par exemple `gh`, `glab`,
`terraform`). Une entrée tool liste comment l'installer par gestionnaire de paquets et une commande `check` pour
le détecter. La détection de présence fonctionne aujourd'hui ; réaliser l'installation elle-même
n'est pas encore livré.

#### hook

Une commande qu'un assistant lance automatiquement à un moment de son cycle de vie — avant un appel
d'outil, à la soumission d'un prompt, etc. Une entrée hook nomme l'**event** qui la déclenche et un
**matcher** pour l'action concernée. Claude Code définit neuf events de hook : `PreToolUse`,
`PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`,
`Notification`, `PreCompact`.

#### AGENTS.md bridge

Le bloc managé qu'agent-rigger écrit dans `CLAUDE.md` pour qu'il importe `@AGENTS.md`. Claude Code ne
lit pas `AGENTS.md` directement ; le bridge permet à une seule source de contexte d'atteindre Claude,
opencode et Copilot pareillement.

#### requires

Le champ d'une entrée de catalog qui liste les autres entrées à installer d'abord. Installer un
artifact entraîne toute la chaîne de ce qu'il requiert.

## Catalog

#### catalog

La couche de données qui décrit quels artifacts existent, ce qu'ils requièrent et comment ils se
regroupent en packs. Il vit dans son propre dépôt git et constitue l'unique source de contenu des
artifacts — le binaire de l'outil n'en porte aucun. Il est récupéré à distance à un [ref](#ref)
donné.

#### catalog.json

Le fichier unique à la racine d'un catalog, de forme `{ meta, entries }`. **Note de vocabulaire :**
dans l'écosystème au sens large, « manifest » désigne parfois ce fichier de catalog. Dans ce projet,
« manifest » désigne autre chose (voir [manifest](#manifest)) — le fichier de catalog s'appelle
toujours `catalog.json`.

#### catalog entry

Un enregistrement de `catalog.json`. C'est soit un `artifact` (une chose installable unique dotée
d'une nature), soit un `pack` (un ensemble d'autres entrées). Les deux partagent un id, les
assistants qu'ils ciblent (`targets`) et les scopes qu'ils supportent (`scopes`).

#### pack

Une entrée de catalog nommée qui regroupe plusieurs artifacts sous un seul id, pour qu'une équipe
installe un ensemble cohérent en une étape (par exemple un pack spec-workflow réunissant ses
sous-agents et son skill).

#### meta

L'en-tête d'un catalog : `{ name, required, recommended }`. `name` identifie le catalog ; `required`
et `recommended` sont des listes d'ids d'entrées — voir [required](#required) et
[recommended](#recommended).

#### catalog source

Un couple nom-URL configuré dans la config de l'outil — ce que `catalog add` enregistre et que
`catalog remove` supprime. Une source pointe vers un [catalog](#catalog) (la couche de données
qu'elle va chercher) ; plusieurs sources ensemble produisent l'[effective catalog](#effective-catalog).

#### effective catalog

L'union des entrées de tous les catalogs configurés, vue comme un tout. Comme deux catalogs peuvent
réutiliser le même id, les entrées de l'effective catalog sont nommées par un
[qualified id](#qualified-id).

#### qualified id

Un id d'artifact préfixé du nom de son catalog pour rester non ambigu d'un catalog à l'autre :
`<catalog>/<nature>:<name>` (par exemple `team/skill:spec-workflow`). L'id nu, seul, est
`<nature>:<name>` (par exemple `tool:glab`).

#### required

Le mot porte **trois sens distincts** — à ne pas mélanger.

1. `meta.required` — le plancher voulu par l'auteur du catalog : les ids d'entrées que le catalog
   place par défaut dans la transaction d'install.
2. `level: "required"` sur une entrée — un indice d'importance (par opposition à `"recommended"`),
   utilisé surtout pour les tools.
3. `secrets[].required` sur un secret mcp — une porte fail-closed : si le secret n'est jamais
   résolu, l'install s'arrête au lieu de continuer.

#### recommended

`meta.recommended` liste des ids d'entrées proposés pré-cochés mais faciles à décocher, par
opposition au plancher imposé de [required](#required). En tant que `level` d'entrée, `"recommended"`
marque un artifact comme utile plutôt que strictement nécessaire.

## Installation et état local

#### ad-hoc install

Installer directement depuis une URL git ou un chemin local, sans étape `catalog add` — un
prélèvement ponctuel depuis une source que la config ne suit pas. L'install est consignée dans le
[manifest](#manifest) sous un [derived prefix](#derived-prefix-provenance-prefix), mais sans
catalog source enregistrée, `update` n'a rien pour la résoudre. Voir
[installer depuis une URL ou un chemin local](/fr/guides/ad-hoc-install/).

#### derived prefix (provenance prefix)

Le substitut de nom de catalog qu'une [ad-hoc install](#ad-hoc-install) synthétise depuis sa source
(`gh-…` pour GitHub, `glab-…` pour GitLab, `<host>-…` sinon, `local-…` pour un chemin) et stocke
dans le manifest comme provenance. Il joue le rôle du nom de catalog dans un
[qualified id](#qualified-id) pour que `remove` et `check` puissent nommer l'artifact, sans être
une [catalog source](#catalog-source) configurée.

#### manifest

Le registre local de ce qui est installé sur ce poste — le fichier `state.json` sous
`~/.config/agent-rigger/`. Chaque entrée conserve l'id de l'artifact, sa nature, son [ref et son sha](#ref), son scope, l'heure d'install, les fichiers qu'il a écrits et son
[applied payload](#applied-payload). C'est la source de vérité de _ce qui est posé ici_. (C'est le
sens de « manifest » dans ce projet ; le fichier de catalog est `catalog.json`.)

#### applied payload

Le relevé exact et réversible de ce qu'une install a changé — les règles deny ajoutées, le contenu
`AGENTS.md` écrit, le hook enregistré. `remove` le rejoue à l'envers pour défaire l'install hors
ligne, à l'identique ; `check` vérifie qu'il est toujours en place.

#### store

La copie locale managée d'un skill ou d'un agent installé — l'unique copie physique que chaque
assistant voit via un [symlink](#symlink). Le store d'un skill est un répertoire sous
`~/.config/agent-rigger/skills/<name>/` ; celui d'un agent est un unique fichier Markdown sous
`~/.config/agent-rigger/agents/<name>.md`.

#### symlink

Un lien de système de fichiers qui laisse le répertoire propre à un assistant pointer vers l'unique
copie du [store](#store) au lieu de la dupliquer. Pour un skill, `~/.claude/skills/<name>` (Claude,
scope user), `<cwd>/.claude/skills/<name>` (scope project), ou `~/.config/opencode/skills/<name>`
(opencode) renvoie vers le store. Si un symlink ne peut être créé, une simple copie est faite à la
place.

#### scope

L'endroit où un artifact est installé. Le scope `user` est à l'échelle du poste (sous votre
répertoire home, p. ex. `~/.claude/`) ; le scope `project` est limité au dépôt courant (p. ex.
`.claude/`, et `AGENTS.md` à la racine du dépôt). Chaque artifact déclare les scopes qu'il supporte ;
`install` en choisit un avec `--scope user` ou `--scope project`.

#### plan (dry-run)

L'aperçu de ce qu'une install ou une suppression changerait exactement avant toute écriture — les
fichiers touchés, les règles fusionnées, les blocs ajoutés. Rien n'est appliqué avant confirmation :
vous voyez donc toujours le changement d'abord, dans l'esprit d'un plan Terraform.

#### backup (.bak)

Une copie octet pour octet d'un fichier prise avant que l'outil ne l'écrase, sauvegardée à côté avec
un suffixe `.bak-<horodatage>-<token>` (la famille `.bak-*`, jamais un simple `.bak`). C'est le
filet de sécurité qui rend un changement réversible ; l'outil n'en supprime donc jamais un récent.

#### idempotence

Lancer deux fois la même install laisse le même résultat que la lancer une fois — ré-appliquer un
artifact déjà présent ne change rien plutôt que de le dupliquer.

#### adoption

Enregistrer dans le [manifest](#manifest) un artifact déjà correctement en place, pour que l'outil se
mette à le suivre, sans le réinstaller ni rien écraser. Utilisé par [doctor](#doctor) quand il trouve
un artifact conforme que le manifest ne connaît pas encore.

#### run-lock

Un verrou que l'outil tient pendant qu'il écrit, pour que deux exécutions ne modifient pas le même
fichier de configuration en même temps. Un verrou laissé par une exécution qui a planté peut être
inspecté et, sur confirmation, cassé par [doctor](#doctor).

## Confiance et sécurité

#### untrusted content

Tout ce qu'un catalog distant transporte — fichiers d'artifact, `catalog.json`, et les chaînes de
commande `check`. Traité comme hostile par défaut : scanné avant de toucher le disque, jamais exécuté
avant votre confirmation, et tout symlink qu'il contient est rejeté.

#### scan / scanner

Le contrôle de sécurité passé sur le contenu récupéré avant sa copie dans le store, délégué à des
outils externes (gitleaks pour les secrets, trivy pour les misconfigurations). Un finding critique
bloque l'install. La limite honnête : il détecte secrets et misconfigurations, **pas** un script
malveillant délibérément obfusqué.

#### finding

Un problème unique rapporté par un scan ou par [doctor](#doctor). Un finding de sécurité peut bloquer
une install ; un finding doctor décrit quelque chose d'anormal dans l'état local et peut porter ou
non une réparation.

#### fail-closed / fail-open

Deux postures opposées dans le doute. _Fail-closed_ refuse — bloque l'install sur un finding, rejette
un symlink suspect. _Fail-open_ laisse passer avec un avertissement. Par défaut : fail-closed sur les
findings ; l'unique exception délibérée est l'absence de scanner (voir [warn-only](#warn-only)).

#### warn-only

Le mode dégradé employé quand aucun outil de scan n'est installé sur le poste. Le contenu ne peut être
scanné, donc plutôt que de bloquer chaque install l'outil continue et avertit — un fail-open
délibéré, car les scanners sont des dépendances optionnelles.

#### consent

L'autorisation explicite, item par item, que l'outil demande avant un acte pouvant détruire des
données ou élargir ce que l'assistant a le droit de faire. Deux mécanismes distincts portent ce nom. L'exécution d'une commande `check`
du catalog est mémoïsée : le consentement d'exécution accordé est consigné dans un ledger
(`~/.config/agent-rigger/consent.json`), indexé par le couple de l'id d'entrée et de la commande
exacte, si bien qu'une commande inchangée sous le même id n'est jamais redemandée (modifier l'un ou
l'autre la redemande toujours). Les réparations
destructrices de [doctor](#doctor) (supprimer un `.bak`, retirer un store, casser un verrou) font
l'inverse : confirmées item par item à chaque exécution, jamais mémoïsées, jamais couvertes par un
`--yes` global.

#### --force

Le flag qui outrepasse un finding de sécurité bloquant et installe quand même. Il contourne une porte
[fail-closed](#fail-closed--fail-open) : c'est donc un choix délibéré et explicite.

## Versions et provenance

#### provenance

D'où vient un artifact installé — le `name` du catalog plus le [ref et le sha](#ref) auxquels il a été
récupéré. Tout artifact installé est récupéré ; aucun n'est gravé dans le binaire.

#### ref

La version à laquelle un artifact est récupéré — un [tag](#tag) git, résolu en un commit [sha](#sha)
exact. Le manifest stocke les deux.

#### tag

Une étiquette de version git lisible par un humain, suivant [semver](#semver) (par exemple `v0.1.3`).
Un `ref` est normalement un tag.

#### sha

Le commit git exact d'où un artifact a été récupéré, résolu depuis son [ref](#ref). Il épingle le
contenu précisément et permet à l'outil de détecter le [drift](#drift) même si un tag est déplacé
plus tard.

#### semver

Le versionnage sémantique — le schéma `MAJOR.MINOR.PATCH` que suivent les releases de catalog, pour
qu'un numéro de version signale le type de changement depuis le précédent.

#### shallow clone

Récupérer seulement le commit nécessaire plutôt que tout l'historique d'un dépôt, pour garder les
récupérations de catalog rapides.

#### drift

Un écart entre ce que le manifest enregistre, ce qui est réellement sur le disque et ce que détient le
remote — le harness ayant discrètement divergé de son état déclaré. `check` et [doctor](#doctor) le
font remonter.

## Secrets et MCP

#### MCP (Model Context Protocol)

Un protocole pour relier un assistant à des serveurs externes qui lui donnent des capacités
supplémentaires. Un artifact [mcp](#mcp) déclare un tel serveur pour un assistant.

#### secret by environment reference (${VAR})

La règle voulant qu'un catalog ne stocke jamais une valeur de secret. Là où un secret est nécessaire,
la config porte une référence de variable d'environnement à la forme exacte `${VAR_NAME}` — une
valeur littérale est rejetée au parsing du catalog. La référence n'est résolue en valeur réelle qu'au
moment de l'install, sur votre poste.

#### --secret-env

Le flag d'install qui indique à l'outil quelle variable d'environnement porte réellement un secret
déclaré, faisant correspondre la référence du catalog à une variable réelle de votre poste — pour que
la valeur du secret reste hors du catalog et hors de tout fichier écrit par l'outil.

## Standards et formats

#### agentskills.io

Le standard cross-vendor (Agentic AI Foundation / Linux Foundation) du format `SKILL.md` : un
[frontmatter](#frontmatter) `name`, une `description` requise, et des champs optionnels. C'est le
format natif de skill d'opencode et de Copilot ; Claude Code repère un skill par le nom de son
dossier.

#### agents.md

La convention cross-agent (Linux Foundation) du fichier d'instructions `AGENTS.md` — Markdown libre,
sans frontmatter requis. La forme canonique de la nature [context](#context).

#### frontmatter

Le petit bloc de métadonnées en tête d'un fichier Markdown, entre des barrières `---`. Dans un
`SKILL.md`, il porte le `name`, la `description` et les autres champs déclarés du skill.

## CLI et environnement

#### RIGGER_HOME

Une variable d'environnement qui remplace le répertoire home utilisé par l'outil pour tous les chemins
de scope user. Elle est prioritaire sur `HOME`, et constitue l'unique levier pour exécuter l'outil
contre un répertoire isolé (par exemple pour l'essayer dans un [sandbox](#sandbox)).

#### sandbox

L'environnement jetable que met en place `scripts/sandbox` (livré dans le dépôt) pour exécuter de
vraies commandes rigger sans toucher ni votre configuration réelle ni vos vrais projets : un
[`RIGGER_HOME`](#rigger_home) jetable plus un répertoire de projet jetable, tous deux sous `/tmp`,
remis à zéro par `rigger_reset` et démontés par `rigger_exit`. Voir
[l'essayer dans un sandbox](/fr/start/sandbox/).

#### TTY / non-interactive

Un TTY est un terminal interactif où l'outil peut vous solliciter. _Non-interactive_ signifie qu'il
n'y en a pas — un job de CI ou un script — où l'outil ne peut poser de questions et s'appuie plutôt
sur des flags comme `--yes`, et saute (en le rapportant) tout acte qui exigerait une confirmation
qu'il ne peut obtenir.

#### --yes

Le flag qui pré-approuve les confirmations sûres d'une exécution pour qu'elle avance sans invite, à
usage de scripts et de CI. Il ne couvre jamais un acte destructeur (voir [consent](#consent)).

#### exit code

Le statut numérique qu'une commande renvoie pour qu'un script puisse réagir. Valeurs vérifiées : `0`
(succès — pour `check`, tout présent et conforme), `3` (`check` a trouvé quelque chose de manquant ou
de drifté), et `2` (la commande a échoué).

#### NO_COLOR

La variable d'environnement standard qui désactive la sortie en couleur. L'outil ne colore sa sortie
que sur un vrai terminal avec `NO_COLOR` non défini.

#### doctor

La commande de diagnostic. Elle lit l'état local et rapporte ce qui cloche, regroupé en six **classes
de finding** : `untracked` (un artifact sur le disque que le manifest ne suit pas), `manifest` (une
entrée de manifest qui ne correspond plus à la réalité), `dangling` (un lien dont la cible a disparu),
`phantom` (un répertoire de store que rien ne référence), `lock` (un [run-lock](#run-lock)
résiduel), et `hygiene` (fichiers temporaires ou backups vieillis). Avec `--fix` elle répare les cas
sûrs ; tout ce qui est destructeur demande d'abord le [consent](#consent).

## Index alphabétique

- [adapter](#adapter)
- [ad-hoc install](#ad-hoc-install)
- [adoption](#adoption)
- [agent (sub-agent)](#agent-sub-agent)
- [agent-rigger](#agent-rigger)
- [agents.md](#agentsmd)
- [agentskills.io](#agentskillsio)
- [AGENTS.md bridge](#agentsmd-bridge)
- [applied payload](#applied-payload)
- [artifact](#artifact)
- [assistant](#assistant)
- [backup (.bak)](#backup-bak)
- [catalog](#catalog)
- [catalog entry](#catalog-entry)
- [catalog source](#catalog-source)
- [catalog.json](#catalogjson)
- [consent](#consent)
- [context](#context)
- [delegate-first](#delegate-first)
- [derived prefix (provenance prefix)](#derived-prefix-provenance-prefix)
- [doctor](#doctor)
- [drift](#drift)
- [effective catalog](#effective-catalog)
- [exit code](#exit-code)
- [fail-closed / fail-open](#fail-closed--fail-open)
- [finding](#finding)
- [--force](#force)
- [frontmatter](#frontmatter)
- [guardrail](#guardrail)
- [harness](#harness)
- [hook](#hook)
- [idempotence](#idempotence)
- [manifest](#manifest)
- [MCP (Model Context Protocol)](#mcp-model-context-protocol)
- [mcp (nature)](#mcp)
- [meta](#meta)
- [nature](#nature)
- [NO_COLOR](#no_color)
- [pack](#pack)
- [plan (dry-run)](#plan-dry-run)
- [plugin](#plugin)
- [preset](#preset)
- [provenance](#provenance)
- [qualified id](#qualified-id)
- [recommended](#recommended)
- [ref](#ref)
- [required](#required)
- [requires](#requires)
- [rig](#rig)
- [RIGGER_HOME](#rigger_home)
- [run-lock](#run-lock)
- [sandbox](#sandbox)
- [scan / scanner](#scan--scanner)
- [scope](#scope)
- [secret by environment reference](#secret-by-environment-reference-var)
- [--secret-env](#secret-env)
- [semver](#semver)
- [sha](#sha)
- [shallow clone](#shallow-clone)
- [skill](#skill)
- [store](#store)
- [symlink](#symlink)
- [tag](#tag)
- [tool](#tool)
- [TTY / non-interactive](#tty--non-interactive)
- [untrusted content](#untrusted-content)
- [warn-only](#warn-only)
- [--yes](#yes)
