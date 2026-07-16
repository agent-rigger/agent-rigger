---
title: Donner son secret à un serveur MCP
description: Faites correspondre la référence de secret ${VAR} d'un catalog à une variable d'environnement sur votre poste avec --secret-env à l'install, et voyez où la valeur n'est jamais écrite.
---

Votre catalog a une entrée [mcp](/fr/reference/glossary/#mcp) dont le serveur a besoin d'un token, et
vous voulez que ce token soit fourni sur ce poste sans jamais le committer. agent-rigger garde la
valeur totalement hors du catalog : l'entrée porte une
[référence `${VAR}`](/fr/reference/glossary/#secret-by-environment-reference-var), et vous décidez à
l'install quelle variable d'environnement la résout. Ce guide couvre cette correspondance et montre
où la valeur atterrit, et où elle n'atterrit jamais. Pour un premier install de bout en bout, voyez
[prise en main](/fr/start/getting-started/) ; pour le schéma complet de l'entrée, voyez
[schéma de catalog](/fr/reference/catalog-schema/#champs-mcp) ; pour tous les flags d'install, voyez
la [référence `install`](/fr/reference/cli/install/).

## Avant de commencer

- Un catalog est configuré (`agent-rigger catalog ls` le liste).
- Ce catalog déclare une entrée mcp avec au moins un secret. Les catalogs de référence et d'exemple
  n'en livrent aucune aujourd'hui, c'est donc une entrée que le catalog de votre équipe définit. Le
  reste de ce guide prend un serveur MCP GitHub comme exemple fil rouge.

## Le catalog porte une référence, jamais la valeur

Une entrée mcp déclare la config de son serveur en ligne, sous `config`. Chaque valeur des
sous-objets porteurs de secrets (`env` pour les serveurs stdio de Claude Code, `environment` et
`headers` pour opencode) doit être une référence `${VAR_NAME}` exacte. Une entrée de serveur GitHub
ressemble à ceci :

```json
{
  "kind": "artifact",
  "id": "mcp:github",
  "nature": "mcp",
  "targets": ["claude"],
  "scopes": ["user"],
  "config": {
    "command": "docker",
    "args": [
      "run",
      "-i",
      "--rm",
      "-e",
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "ghcr.io/github/github-mcp-server"
    ],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}" }
  },
  "secrets": [
    {
      "ref": "GITHUB_PERSONAL_ACCESS_TOKEN",
      "prompt": "GitHub personal access token",
      "required": true,
      "help": "https://github.com/settings/tokens"
    }
  ]
}
```

Écrivez un littéral à cet endroit au lieu d'une référence, et le catalog est rejeté à son parsing,
avant tout début de travail d'install :

```
mcp entry "mcp:github" has a non-ref value at config.env.GITHUB_PERSONAL_ACCESS_TOKEN — use a "${VAR_NAME}" reference instead of a literal value
```

La correspondance est exacte : `"Bearer ${TOKEN}"` est rejeté, car le contrôle exige une forme
littérale `${VAR_NAME}`. La règle complète, les trois sous-objets contrôlés, et les champs de
déclaration `secrets` sont dans le [schéma de catalog](/fr/reference/catalog-schema/#champs-mcp).

## Associer la référence à une variable à l'install

Chaque secret déclaré a un `ref` (le nom à l'intérieur de `${…}`) et un flag `required`. Faites
pointer une référence vers la variable qui la porte avec
[`--secret-env=<ref>=<VAR>`](/fr/reference/glossary/#secret-env) :

```
export MY_GH_PAT=ghp_your_token
agent-rigger install acme/mcp:github --secret-env=GITHUB_PERSONAL_ACCESS_TOKEN=MY_GH_PAT --yes
```

Le flag est répétable, une fois par référence, et la dernière valeur l'emporte pour un `ref` donné.

Pouvoir sauter le flag dépend du secret et de la session. En session interactive, install demande
toujours quelle variable porte chaque secret déclaré, même une déjà exportée sous un nom
correspondant : il n'existe aucun chemin silencieux sans flag. En session non-interactive, un secret
qui n'est pas `required` se rabat par défaut sur une variable de son propre nom, mais un secret
marqué `required`, comme le token GitHub ci-dessus, n'a pas de défaut. Exporter une variable
correctement nommée ne change rien : sans le flag, install sort quand même avec `2` (voir « Quand
install ne peut pas résoudre le secret », plus bas). Passez le flag même quand `<VAR>` correspond à
`<ref>` :

```
export GITHUB_PERSONAL_ACCESS_TOKEN=ghp_your_token
agent-rigger install acme/mcp:github --secret-env=GITHUB_PERSONAL_ACCESS_TOKEN=GITHUB_PERSONAL_ACCESS_TOKEN --yes
```

## Où la valeur atterrit, et où elle n'atterrit jamais

`--secret-env` fait correspondre un nom à un nom. La valeur du secret elle-même n'est lue que depuis
la variable d'environnement, et seulement au moment où le serveur MCP est lancé. Elle ne va nulle
part ailleurs :

- Pas dans **le catalog**. L'entrée porte des références `${VAR}` et les déclarations `secrets`
  (`ref`, `prompt`, `required`, `example`, `help`) : des noms de référence et du texte indicatif
  seulement, aucune valeur.
- Pas dans **le [manifest](/fr/reference/glossary/#manifest)**. agent-rigger enregistre la
  correspondance référence-vers-variable (des noms seulement) pour qu'un `update` ultérieur
  re-génère sans vous redemander. La valeur n'en fait pas partie.
- Pas dans **les fichiers qu'agent-rigger écrit**. Pour Claude Code, install
  [délègue](/fr/reference/glossary/#delegate-first) le serveur à `claude mcp add-json`. La config
  qu'il passe porte toujours une référence `${VAR}`, jamais le token littéral, mais agent-rigger
  réécrit d'abord le nom à l'intérieur de `${…}` : il devient la variable que `--secret-env` a
  fait correspondre au `ref` du catalog, ou le nom du `ref` lui-même quand aucune correspondance
  n'a été donnée. Ce nom réécrit, et non le `ref` du catalog, est ce que Claude Code stocke dans sa propre
  config et étend quand il lance le serveur plus tard : gardez-le exporté dans l'environnement qui
  démarre le serveur, sous peine de casser le serveur sans avertissement.

## Quand install ne peut pas résoudre le secret

Une valeur `--secret-env` malformée est détectée avant toute récupération de catalog, et install
sort avec `2` :

```
[error] Invalid --secret-env value: "notvalid". Expected "<ref>=<VAR>" (e.g. --secret-env=GITHUB_TOKEN=MY_PAT).
```

Un secret marqué `required` qui reste non résolu échoue en fail-closed ; il ne se rabat pas sur une
supposition silencieuse. En [session non-interactive](/fr/reference/glossary/#tty--non-interactive)
sans variable correspondante et sans override, install sort avec `2` et nomme le correctif :

```
[error] missing required secret "GITHUB_PERSONAL_ACCESS_TOKEN" (GitHub personal access token) — pass --secret-env=GITHUB_PERSONAL_ACCESS_TOKEN=<VAR_NAME> or export GITHUB_PERSONAL_ACCESS_TOKEN directly
```

Le même contrôle de présence tourne à nouveau juste avant que la config soit rendue, si bien qu'un
secret `required` dont la variable est absente à ce moment-là arrête l'install avant toute écriture :

```
[error] mcp entry "acme/mcp:github" is missing required secret "GITHUB_PERSONAL_ACCESS_TOKEN" (GitHub personal access token) — env var "GITHUB_PERSONAL_ACCESS_TOKEN" is not set. Export it (export GITHUB_PERSONAL_ACCESS_TOKEN=<value>) or re-run with --secret-env=GITHUB_PERSONAL_ACCESS_TOKEN=<OTHER_VAR>.
```

Un [`update`](/fr/reference/cli/update/) ultérieur réutilise la correspondance enregistrée et ne
redemande pas, mais il exécute le même contrôle de présence : si la variable a disparu de votre
environnement, le re-rendu échoue en fail-closed de la même façon.
