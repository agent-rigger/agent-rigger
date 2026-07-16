---
title: Natures × assistants × scopes
description: "La carte exacte de ce qu'agent-rigger écrit pour chacune des huit natures, par assistant (claude, opencode) et par scope (user, project) : le chemin qu'il touche et le mécanisme qu'il utilise."
---

Cette page est le contrat sur disque de chaque [nature](/fr/reference/glossary/#nature). Pour
chacune des huit natures, elle indique, par [assistant](/fr/reference/glossary/#assistant) et par
[scope](/fr/reference/glossary/#scope), le chemin exact qu'agent-rigger touche et le mécanisme
qu'il utilise pour y déposer l'artifact. Chaque cellule vient du code des adapters, et chaque cas
géré par le code apparaît ici. Le raisonnement derrière une source unique qui alimente plusieurs
assistants vit dans [une source, plusieurs assistants](/fr/concepts/one-source-many-assistants/) ;
ce qu'est chaque nature vit dans [natures d'artifact](/fr/concepts/artifact-natures/).

`<name>` ci-dessous est l'id local de l'artifact, préfixe `nature:` retiré (`skill:spec-workflow`
→ `spec-workflow`). `<cwd>` est le répertoire de travail du projet ; `~` est le home effectif.

## Mécanismes

| Mécanisme         | Ce qui se passe                                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| store + symlink   | La source est copiée dans un [store](/fr/reference/glossary/#store) managé sous `~/.config/agent-rigger/`, puis un [symlink](/fr/reference/glossary/#symlink) à la cible pointe vers elle (une copie simple est le fallback quand un symlink ne peut pas être créé). Un store, plusieurs cibles — la même copie physique est partagée entre assistants et scopes. |
| merge             | Les clés de l'artifact sont fusionnées dans un fichier de settings existant. Toute autre clé de ce fichier est préservée.                                                                                                                                                                                                                                         |
| file written      | Le contenu canonique est écrit verbatim dans le fichier cible.                                                                                                                                                                                                                                                                                                    |
| translate + write | Le `.md` source est lu, son frontmatter traduit vers le schéma cible, et le résultat écrit.                                                                                                                                                                                                                                                                       |
| native delegation | agent-rigger n'édite jamais le fichier lui-même ; il pilote le CLI natif de l'assistant pour muter sa config, et relève les erreurs du CLI verbatim.                                                                                                                                                                                                              |
| advisory check    | Rien n'est écrit. Une commande shell rapporte uniquement la présence.                                                                                                                                                                                                                                                                                             |

## Vue d'ensemble du support

| Nature      | claude               | opencode            |
| ----------- | -------------------- | ------------------- |
| `skill`     | store + symlink      | store + symlink     |
| `agent`     | store + symlink      | translate + write   |
| `guardrail` | merge                | merge               |
| `context`   | file written + merge | file written        |
| `plugin`    | native delegation    | store + symlink     |
| `mcp`       | native delegation    | merge               |
| `hook`      | merge                | **non livré**       |
| `tool`      | advisory check only  | advisory check only |

`copilot` est un id d'assistant réservé dans le domaine mais sans adapter : toute commande le
ciblant échoue avant qu'aucun handler ne s'exécute (voir [copilot](#copilot--réservé)). `tool`
n'est jamais installé par aucun adapter (voir [tool](#tool--advisory-uniquement)). Les deux
s'appliquent à tout scope.

## skill

Copié dans le store de skills partagé et symlinké. Le store est toujours user-scope et partagé
entre les deux assistants. Retirer un symlink ne supprime jamais le store tant qu'une autre cible
le référence encore. Le [scan de sécurité](/fr/concepts/trust-and-security/) tourne sur la source
avant que quoi que ce soit ne soit écrit.

| Assistant · Scope  | Store (physique)                       | Cible (symlink)                    | Mécanisme       |
| ------------------ | -------------------------------------- | ---------------------------------- | --------------- |
| claude · user      | `~/.config/agent-rigger/skills/<name>` | `~/.claude/skills/<name>`          | store + symlink |
| claude · project   | `~/.config/agent-rigger/skills/<name>` | `<cwd>/.claude/skills/<name>`      | store + symlink |
| opencode · user    | `~/.config/agent-rigger/skills/<name>` | `~/.config/opencode/skills/<name>` | store + symlink |
| opencode · project | `~/.config/agent-rigger/skills/<name>` | `<cwd>/.opencode/skills/<name>`    | store + symlink |

## agent

Les deux assistants divergent. Claude lie le `.md` du sub-agent de manière opaque, exactement
comme un skill. opencode lit un schéma traduit à la place : le frontmatter source (`description`,
`model`, `tools` → une allow-list `permission`, `mode: subagent`) est traduit et le résultat écrit
comme fichier (un `write-text`, pas un symlink), il n'y a donc pas de store pour un agent opencode.

| Assistant · Scope  | Écrit où                                                                                   | Mécanisme         |
| ------------------ | ------------------------------------------------------------------------------------------ | ----------------- |
| claude · user      | store `~/.config/agent-rigger/agents/<name>.md` → symlink `~/.claude/agents/<name>.md`     | store + symlink   |
| claude · project   | store `~/.config/agent-rigger/agents/<name>.md` → symlink `<cwd>/.claude/agents/<name>.md` | store + symlink   |
| opencode · user    | `~/.config/opencode/agents/<name>.md`                                                      | translate + write |
| opencode · project | `<cwd>/.opencode/agents/<name>.md`                                                         | translate + write |

## guardrail

Fusionné dans le fichier de settings de l'assistant. Claude reçoit des règles deny (et des règles
allow optionnelles) dans `permissions` ; opencode reçoit un descripteur `permission` natif rédigé
dans le catalog. Il n'y a pas de traduction de règle vers Claude. L'écriture opencode préserve le
JSONC et est granulaire au niveau des feuilles : les commentaires utilisateur et les autres clés
survivent. Un `merge-allow` sur Claude émet toujours un avertissement de plan, car élargir
`permissions.allow` désactive le prompt d'approbation humaine de Claude Code pour les commandes
concernées.

| Assistant · Scope  | Fichier · clé                                                              | Mécanisme |
| ------------------ | -------------------------------------------------------------------------- | --------- |
| claude · user      | `~/.claude/settings.json` · `permissions.deny` (+ `permissions.allow`)     | merge     |
| claude · project   | `<cwd>/.claude/settings.json` · `permissions.deny` (+ `permissions.allow`) | merge     |
| opencode · user    | `~/.config/opencode/opencode.json` · `permission`                          | merge     |
| opencode · project | `<cwd>/opencode.json` · `permission`                                       | merge     |

## context

Claude écrit un `AGENTS.md` et ajoute un bloc d'import managé (le
[bridge AGENTS.md](/fr/reference/glossary/#agentsmd-bridge)) à `CLAUDE.md` pour que Claude Code le
lise automatiquement ; le bloc est délimité par `<!-- BEGIN agent-rigger (managed — do not edit) -->`
et `<!-- END agent-rigger -->`. opencode lit `AGENTS.md` nativement, donc il n'a besoin d'aucun
bloc d'import. En scope project, les deux assistants écrivent le **même** `<cwd>/AGENTS.md`. Cette
protection de fichier partagé est asymétrique : retirer le côté claude alors que le context
opencode est encore installé pour le même fichier laisse le fichier partagé en place et retire
uniquement le bloc d'import CLAUDE.md de claude ; retirer le côté opencode supprime
inconditionnellement le `AGENTS.md` partagé, même si l'install context de claude le référence
encore.

| Assistant · Scope  | AGENTS.md écrit vers           | Bloc d'import                                               | Mécanisme            |
| ------------------ | ------------------------------ | ----------------------------------------------------------- | -------------------- |
| claude · user      | `~/.claude/harness/AGENTS.md`  | `~/.claude/CLAUDE.md`, ligne `@~/.claude/harness/AGENTS.md` | file written + merge |
| claude · project   | `<cwd>/AGENTS.md`              | `<cwd>/.claude/CLAUDE.md`, ligne `@../AGENTS.md`            | file written + merge |
| opencode · user    | `~/.config/opencode/AGENTS.md` | aucun (opencode lit AGENTS.md nativement)                   | file written         |
| opencode · project | `<cwd>/AGENTS.md`              | aucun (opencode lit AGENTS.md nativement)                   | file written         |

## plugin

Les deux assistants utilisent des mécanismes sans rapport. Claude délègue à son CLI natif et
n'édite jamais de fichier : l'install lance `claude plugin marketplace add <marketplace>` puis
`claude plugin install <plugin>` ; le remove lance `claude plugin uninstall <plugin>`. La présence
est lue depuis le ledger sur disque de Claude `installed_plugins.json`, jamais en lançant le
binaire. opencode n'a pas d'install de plugin native, donc un plugin est un module JS/TS copié dans
le store partagé et symlinké, le même mécanisme qu'un skill.

| Assistant · Scope  | Écrit où                                                                                               | Mécanisme         |
| ------------------ | ------------------------------------------------------------------------------------------------------ | ----------------- |
| claude · user      | CLI natif ; ledger `<config>/plugins/installed_plugins.json` (`CLAUDE_CONFIG_DIR`, sinon `~/.claude`)  | native delegation |
| claude · project   | CLI natif ; même ledger que le scope user                                                              | native delegation |
| opencode · user    | store `~/.config/agent-rigger/plugins/<name>.<ext>` → symlink `~/.config/opencode/plugin/<name>.<ext>` | store + symlink   |
| opencode · project | store `~/.config/agent-rigger/plugins/<name>.<ext>` → symlink `<cwd>/.opencode/plugin/<name>.<ext>`    | store + symlink   |

Le handler de plugin Claude n'utilise pas le scope : le CLI natif et le ledger vivent sous le
config dir quel que soit le scope demandé. Le store de plugins opencode est toujours user-scope et
partagé entre scopes, comme le store de skills.

## mcp

Claude délègue : l'install lance `claude mcp add-json <server> <json> -s <scope>` et le remove
lance `claude mcp remove <server> -s <scope>` ; la présence est lue directement depuis le fichier
de config de Claude. opencode fusionne la déclaration de serveur dans la clé `mcp` de
`opencode.json` à la granularité du serveur : un serveur du même id déjà présent est préservé. Le
`config` du serveur est passé verbatim, avec ses références secrètes `${VAR}` intactes ; aucun
adapter ne substitue jamais une valeur de secret.

| Assistant · Scope  | Écrit où                                            | Présence lue depuis              | Mécanisme         |
| ------------------ | --------------------------------------------------- | -------------------------------- | ----------------- |
| claude · user      | `claude mcp add-json <server> <json> -s user`       | `~/.claude.json` · `mcpServers`  | native delegation |
| claude · project   | `claude mcp add-json <server> <json> -s project`    | `<cwd>/.mcp.json` · `mcpServers` | native delegation |
| opencode · user    | `~/.config/opencode/opencode.json` · `mcp.<server>` | même fichier                     | merge             |
| opencode · project | `<cwd>/opencode.json` · `mcp.<server>`              | même fichier                     | merge             |

## hook

Seul Claude supporte les hooks. Le hook est fusionné dans la clé `hooks` du `settings.json` de
Claude ; les scripts de garde, quand présents, sont synchronisés vers un store d'abord.
**opencode ne supporte pas la nature `hook`** : router l'une d'elles vers l'adapter opencode lève
`OpencodeAdapter: unsupported nature "hook"`.

| Assistant · Scope | Fichier · clé                           | Mécanisme                                                   |
| ----------------- | --------------------------------------- | ----------------------------------------------------------- |
| claude · user     | `~/.claude/settings.json` · `hooks`     | merge                                                       |
| claude · project  | `<cwd>/.claude/settings.json` · `hooks` | merge                                                       |
| opencode · any    | —                                       | non supporté (`OpencodeAdapter: unsupported nature "hook"`) |

`event` doit valoir l'un des neuf events de hook de Claude Code (`PreToolUse`, `PostToolUse`,
`UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`, `Notification`,
`PreCompact`) ; voir [schéma catalog.json](/fr/reference/catalog-schema/#champs-hook).

## tool — advisory uniquement

Aucun adapter n'installe la nature `tool`, pour aucun assistant ni aucun scope. Seule la
vérification de présence advisory est livrée : la commande shell `check` de l'entrée est lancée, et
un exit code de `0` signifie présent, non-zéro signifie absent. Le check ne bloque jamais une
install et n'écrit jamais rien. Réaliser l'install elle-même à partir des indications `install`
(`brew` / `npm` / `pnpm` / `mise`) n'est **pas encore livré**. L'aide du CLI le dit sans détour :
`tool | tools             Host system tools (advisory check only).`

| Assistant · Scope | Comportement                                            |
| ----------------- | ------------------------------------------------------- |
| claude · any      | advisory `check` uniquement — pas d'install, rien écrit |
| opencode · any    | advisory `check` uniquement — pas d'install, rien écrit |

## copilot — réservé

`copilot` est un id d'assistant valide dans le domaine mais sans adapter. Sur la surface publique
du CLI, il n'atteint jamais un handler de nature, pour toute nature et tout scope : `--assistant
copilot` est rejeté par le parser de flags, et une entrée `copilot` dans `config.assistants[]` est
silencieusement supprimée au chargement de la config. Le rejet de flag est ce qu'un utilisateur
voit réellement :

```
[error] Invalid --assistant value: "copilot". Must be "claude" or "opencode".
```

avec l'[exit code](/fr/reference/exit-codes/) `2`. Rien n'est récupéré et rien n'est écrit. Voir
[choisir un assistant](/fr/guides/choose-assistant/).
