---
title: Schéma de catalog.json
description: "Référence champ par champ de catalog.json : la forme racine, le bloc meta, les entrées artifact et pack, la forme stricte des secrets mcp, et les erreurs qu'un catalog malformé déclenche."
---

Cette page documente la forme exacte de [`catalog.json`](/fr/reference/glossary/#catalogjson), le
fichier unique à la racine d'un [catalog](/fr/reference/glossary/#catalog). C'est la référence de
chaque champ que le parser accepte, de ce qu'il valide et de ce qu'il rejette. Chaque règle
ci-dessous est appliquée par le schéma au parsing ; rien ici n'est purement indicatif.

## Forme racine

La valeur racine est un objet à deux clés requises, `meta` et `entries`. Les clés racine non
reconnues sont ignorées, pas rejetées :

```json
{
  "meta": { "name": "..." },
  "entries": []
}
```

| Clé       | Type   | Règle                                                              |
| --------- | ------ | ------------------------------------------------------------------ |
| `meta`    | object | Requis. L'en-tête du catalog. Voir [meta](#meta).                  |
| `entries` | array  | Requis. La liste des entrées du catalog. Voir [entries](#entries). |

Un tableau nu à la racine est rejeté : l'ancien format de tableau au premier niveau n'est plus pris
en charge. Une valeur racine qui n'est pas un objet est elle aussi rejetée. Les deux déclenchent une
[erreur de parsing](#erreurs-de-parsing).

## meta

Le bloc [`meta`](/fr/reference/glossary/#meta) identifie le catalog et déclare sa sélection par
défaut.

| Champ         | Type     | Requis | Défaut | Règle                                                                                                         |
| ------------- | -------- | ------ | ------ | ------------------------------------------------------------------------------------------------------------- |
| `name`        | string   | oui    | aucun  | Non vide. Identifie le catalog ; sert à construire les [qualified ids](/fr/reference/glossary/#qualified-id). |
| `required`    | string[] | non    | `[]`   | Les ids d'entrées que le catalog place par défaut dans la transaction d'install.                              |
| `recommended` | string[] | non    | `[]`   | Les ids d'entrées proposés pré-cochés mais faciles à décocher.                                                |

Les ids listés dans [`required`](/fr/reference/glossary/#required) et
[`recommended`](/fr/reference/glossary/#recommended) sont des chaînes arbitraires. Aucun contrôle
référentiel n'est effectué : le parser ne vérifie pas qu'un id listé correspond à une entrée de
`entries`. Un id qui ne pointe sur rien est accepté au parsing.

## entries

`entries` est un tableau d'entrées de catalog. Chaque entrée est une union discriminée sur son champ
`kind` : `"artifact"` mène à la forme [artifact](#entrées-artifact), `"pack"` à la forme
[pack](#entrées-pack). Un `kind` absent ou non reconnu est rejeté.

### Champs communs

Les deux kinds partagent ces champs :

| Champ      | Type                     | Requis | Règle                                                                                                                                                                                                                                                                     |
| ---------- | ------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`     | `"artifact"` \| `"pack"` | oui    | Le discriminant. Sélectionne la variante.                                                                                                                                                                                                                                 |
| `id`       | string                   | oui    | Non vide. L'identifiant de l'entrée, par exemple `tool:glab` ou `pack:dev-tools`. Validé ici uniquement comme chaîne non vide ; l'allowlist de sûreté des chemins est appliquée plus tard, au moment de l'install (voir [catalog-layout](/fr/reference/catalog-layout/)). |
| `targets`  | string[]                 | oui    | Non vide. Les [assistants](/fr/reference/glossary/#assistant) que l'entrée supporte. Chaque valeur vaut `claude`, `opencode` ou `copilot`.                                                                                                                                |
| `scopes`   | string[]                 | oui    | Non vide. Les [scopes](/fr/reference/glossary/#scope) que l'entrée supporte. Chaque valeur vaut `user` ou `project`.                                                                                                                                                      |
| `requires` | string[]                 | non    | Les ids d'autres entrées à installer d'abord. Voir [requires](/fr/reference/glossary/#requires).                                                                                                                                                                          |

## Entrées artifact

Une entrée [artifact](/fr/reference/glossary/#artifact) (`kind: "artifact"`) est une chose
installable unique dotée d'une [nature](/fr/reference/glossary/#nature) concrète. En plus des
[champs communs](#champs-communs) :

| Champ     | Type                            | Requis       | Règle                                                                                                                                       |
| --------- | ------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `nature`  | enum                            | oui          | L'une des huit natures : `plugin`, `guardrail`, `context`, `skill`, `agent`, `mcp`, `tool`, `hook`.                                         |
| `level`   | `"required"` \| `"recommended"` | non          | Un indice d'importance pour l'installeur. Surtout pertinent pour les entrées [tool](/fr/reference/glossary/#tool).                          |
| `check`   | string                          | non          | Une commande shell qui détecte si l'artifact est déjà présent. Un exit code `0` signifie présent.                                           |
| `install` | object                          | non          | Des indications d'install par gestionnaire de paquets. Voir [install](#install).                                                            |
| `event`   | enum                            | conditionnel | L'event qui déclenche le [hook](/fr/reference/glossary/#hook). Requis quand `nature` vaut `hook`. Voir [champs hook](#champs-hook).         |
| `matcher` | string                          | conditionnel | Le motif d'action que le hook écoute. Requis quand `nature` vaut `hook`.                                                                    |
| `timeout` | integer                         | non          | Le temps d'exécution maximal du hook en secondes. Entier positif.                                                                           |
| `config`  | object                          | non          | La configuration brute du serveur [mcp](/fr/reference/glossary/#mcp). Contrainte quand `nature` vaut `mcp`. Voir [champs mcp](#champs-mcp). |
| `secrets` | object[]                        | non          | Les déclarations de secrets d'une entrée mcp. Voir [champs mcp](#champs-mcp).                                                               |

Les champs qui ne s'appliquent pas à une nature donnée sont simplement ignorés : une entrée artifact
n'échoue pas au parsing parce qu'elle omet `event`, et une entrée non-hook qui porte un `event`
n'est pas rejetée pour autant. L'unique exception est l'exigence hook ci-dessous.

### install

L'objet `install` optionnel liste comment installer un [tool](/fr/reference/glossary/#tool) par
gestionnaire de paquets. Chaque clé est optionnelle ; une entrée ne liste que les gestionnaires que
l'artifact supporte.

| Clé    | Sens                                                           |
| ------ | -------------------------------------------------------------- |
| `brew` | Le nom de formule ou de cask Homebrew.                         |
| `npm`  | Le nom du paquet npm, installé globalement via `npm i -g`.     |
| `pnpm` | Le nom du paquet pnpm, installé globalement via `pnpm add -g`. |
| `mise` | Le nom de plugin ou d'outil mise.                              |

La vérification de présence via `check` fonctionne aujourd'hui. Réaliser l'install elle-même à
partir de ces indications n'est pas encore livré.

### Champs hook

Quand `nature` vaut `hook`, deux champs deviennent obligatoires. Une entrée hook qui omet l'un ou
l'autre est rejetée, chacun avec sa propre erreur :

| Champ     | Erreur en cas d'absence          |
| --------- | -------------------------------- |
| `event`   | `hook entries require 'event'`   |
| `matcher` | `hook entries require 'matcher'` |

`event` doit valoir l'un des neuf events de hook de Claude Code : `PreToolUse`, `PostToolUse`,
`UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`, `Notification`,
`PreCompact`. `timeout`, s'il est présent, est un nombre entier positif de secondes.

### Champs mcp

Quand `nature` vaut `mcp`, l'entrée porte la configuration du serveur en ligne dans `config` et
déclare ses secrets dans `secrets`. Aucun fichier séparé n'existe sur le disque pour un artifact mcp.

`config` est un objet de forme libre passé tel quel à l'assistant, avec une règle stricte. Chaque
valeur sous les sous-objets `environment`, `headers` et `env` doit être une
[référence d'environnement](/fr/reference/glossary/#secret-by-environment-reference-var) exacte de la
forme `${VAR_NAME}`, où `VAR_NAME` commence par une lettre ou un underscore. Tout le reste sous ces clés
est rejeté au parsing :

- Une valeur littérale, par exemple `"ghp_xxxx"`, est rejetée.
- Une référence partielle, par exemple `"Bearer ${TOKEN}"`, est rejetée : la correspondance est
  exacte, pas « contient une référence ».
- Une valeur non-chaîne sous ces clés est rejetée.

Les trois sous-objets sont contrôlés : `environment` et `headers` sont les champs d'opencode, `env`
est le champ stdio natif de Claude Code. Le rejet est une porte, au parsing, sur la forme de la
valeur, appliquée indépendamment de tout [scan de sécurité](/fr/concepts/trust-and-security/).
L'erreur nomme l'entrée et le chemin fautif, par exemple
`mcp entry "mcp:github" has a non-ref value at config.environment.GITHUB_TOKEN — use a "${VAR_NAME}" reference instead of a literal value`.
Les clés en dehors de ces trois sous-objets ne portent pas cette contrainte. Une entrée mcp sans
aucun `config` est tout de même parsée ; c'est l'adapter, pas le schéma, qui impose qu'une install
réelle en ait un.

`secrets` est un tableau de déclarations. Chacune déclare une référence de variable
d'environnement qui doit être résolue avant que la config du serveur puisse être générée :

| Champ      | Type    | Requis | Règle                                                                                                                     |
| ---------- | ------- | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| `ref`      | string  | oui    | Non vide. Le nom de référence employé dans `config`, par exemple `GITHUB_TOKEN` pour une valeur écrite `${GITHUB_TOKEN}`. |
| `prompt`   | string  | oui    | Non vide. Le libellé affiché quand la CLI demande quelle variable d'environnement porte le secret.                        |
| `required` | boolean | non    | Quand `true`, l'install s'arrête en fail-closed si le secret n'est jamais résolu.                                         |
| `example`  | string  | non    | Un exemple indicatif du format de la valeur. Jamais un vrai secret.                                                       |
| `help`     | string  | non    | Un texte d'aide ou une URL indicative, par exemple où générer le token.                                                   |

Aucune valeur de secret ne vit jamais dans le catalog. `secrets` ne déclare que des références ; la
vraie valeur est fournie au moment de l'install, sur le poste qui installe.

## Entrées pack

Une entrée [pack](/fr/reference/glossary/#pack) (`kind: "pack"`) regroupe d'autres entrées sous un
seul id. En plus des [champs communs](#champs-communs) :

| Champ     | Type     | Requis | Règle                                             |
| --------- | -------- | ------ | ------------------------------------------------- |
| `members` | string[] | oui    | Non vide. Les ids des entrées que ce pack réunit. |

Les entrées pack sont parsées en mode strict : tout champ qui n'est pas `kind`, `id`, `targets`,
`scopes`, `requires` ou `members` est rejeté. En particulier, un champ `nature` sur un pack est une
erreur, puisqu'un pack n'a pas de nature.

## Erreurs de parsing

La lecture d'un catalog déclenche un unique type d'erreur, `CatalogParseError`, portant un message
et une liste de problèmes. Elle est déclenchée quand :

| Condition                                         | Message                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `catalog.json` est absent                         | `catalog.json not found in the content repo`                                     |
| Le fichier n'est pas du JSON valide               | le message d'erreur JSON sous-jacent                                             |
| La racine est un tableau nu                       | `catalog.json must be a wrapped object {meta,entries}, not a bare array`         |
| La racine n'est pas un objet                      | `catalog.json must be a wrapped object {meta,entries}`                           |
| `meta.name` est absent ou vide                    | `catalog.json: invalid meta block — meta.name is required and must not be empty` |
| `entries` n'est pas un tableau                    | `catalog.json: the entries field must be an array`                               |
| Une ou plusieurs entrées échouent à la validation | `catalog.json contains invalid entries: ...`                                     |

Les problèmes au niveau des entrées sont collectés sur l'ensemble des entrées, chacun rapporté comme
`index <n>: <path> <reason>`, si bien qu'un seul parsing rapporte toutes les entrées invalides d'un
coup au lieu de s'arrêter à la première.

## Exemples

Un `catalog.json` complet et valide, avec les deux kinds :

```json
{
  "meta": {
    "name": "agent-rigger-catalog-example",
    "required": [],
    "recommended": ["pack:demo"]
  },
  "entries": [
    {
      "kind": "artifact",
      "id": "skill:hello-rigger",
      "nature": "skill",
      "targets": ["claude"],
      "scopes": ["user", "project"],
      "requires": ["tool:git"]
    },
    {
      "kind": "artifact",
      "id": "hook:demo",
      "nature": "hook",
      "targets": ["claude"],
      "scopes": ["user", "project"],
      "event": "SessionStart",
      "matcher": "startup"
    },
    {
      "kind": "artifact",
      "id": "tool:git",
      "nature": "tool",
      "targets": ["claude"],
      "scopes": ["user", "project"],
      "level": "recommended",
      "check": "command -v git",
      "install": { "brew": "git" }
    },
    {
      "kind": "pack",
      "id": "pack:demo",
      "targets": ["claude"],
      "scopes": ["user", "project"],
      "members": ["skill:hello-rigger", "agent:demo"]
    }
  ]
}
```

Une entrée artifact mcp valide, avec une référence d'environnement stricte et une déclaration de
secret :

```json
{
  "kind": "artifact",
  "id": "mcp:github",
  "nature": "mcp",
  "targets": ["opencode"],
  "scopes": ["user"],
  "config": {
    "type": "local",
    "command": ["bunx", "github-mcp"],
    "environment": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
  },
  "secrets": [
    {
      "ref": "GITHUB_TOKEN",
      "prompt": "GitHub personal access token",
      "required": true,
      "example": "ghp_xxxxxxxxxxxxxxxxxxxx",
      "help": "https://github.com/settings/tokens"
    }
  ]
}
```
