---
title: Structure d'un dépôt de catalog
description: "Où vivent les fichiers de chaque artifact dans un dépôt de catalog : la convention de chemin par nature, l'allowlist de nommage, et les natures qui ne portent aucun fichier."
---

Un [catalog](/fr/reference/glossary/#catalog) est un dépôt git ordinaire :
[`catalog.json`](/fr/reference/glossary/#catalogjson) à la racine, plus les fichiers qui portent le
contenu de chaque [artifact](/fr/reference/glossary/#artifact). Chaque
[nature](/fr/reference/glossary/#nature) a une convention de chemin fixe. Quand agent-rigger installe
une entrée, il résout l'id de l'entrée en un chemin sous ces répertoires ; un fichier au mauvais
endroit n'est pas trouvé.

Deux natures ne portent aucun fichier. Un serveur [mcp](/fr/reference/glossary/#mcp) est déclaré en
ligne dans `catalog.json` via son champ `config`, et un [tool](/fr/reference/glossary/#tool) est
déclaré en ligne via ses champs `check` et `install`. Aucun des deux n'a de répertoire dans le dépôt.

## Chemin par nature

Pour une entrée dont l'id est `<nature>:<name>` (par exemple `skill:diagnose`, nom `diagnose`) :

| Nature                                           | Chemin                            | Notes                                                                                                                                                                                                          |
| ------------------------------------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [skill](/fr/reference/glossary/#skill)           | `skills/<name>/SKILL.md`          | Tout le répertoire `skills/<name>/` est le skill. Tout ce qu'il contient, y compris les sous-dossiers comme `scripts/`, est copié dans le [store](/fr/reference/glossary/#store).                              |
| [agent](/fr/reference/glossary/#agent-sub-agent) | `agents/<name>.md`                | Un unique fichier Markdown.                                                                                                                                                                                    |
| [context](/fr/reference/glossary/#context)       | `contexts/<name>/AGENTS.md`       | Le fichier [`AGENTS.md`](/fr/reference/glossary/#agentsmd) dans un répertoire nommé.                                                                                                                           |
| [guardrail](/fr/reference/glossary/#guardrail)   | `guardrails/<name>/`              | Contient les fichiers de descripteur ci-dessous.                                                                                                                                                               |
| [hook](/fr/reference/glossary/#hook)             | `hooks/<name>.ts`                 | Un script dans le répertoire partagé `hooks/`. Voir [hooks](#hooks).                                                                                                                                           |
| [plugin](/fr/reference/glossary/#plugin)         | `plugins/<name>.<ext>` (opencode) | Résolu par basename : l'extension n'est pas fixe. Les plugins Claude Code ne portent aucun fichier ; ils sont installés en déléguant à `claude`, indexés via un `.claude-plugin/marketplace.json` à la racine. |
| [mcp](/fr/reference/glossary/#mcp)               | aucun                             | En ligne dans `catalog.json` (`config`).                                                                                                                                                                       |
| [tool](/fr/reference/glossary/#tool)             | aucun                             | En ligne dans `catalog.json` (`check`, `install`).                                                                                                                                                             |

## Guardrails

Un [guardrail](/fr/reference/glossary/#guardrail) vit sous `guardrails/<name>/`. Les fichiers que
contient le répertoire dépendent des assistants que l'entrée cible :

| Fichier           | Assistant   | Règle                                                                                                                                                                                           |
| ----------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deny.json`       | Claude Code | Requis et non vide. Les règles de blocage. Un guardrail est [fail-closed](/fr/reference/glossary/#fail-closed--fail-open) : une liste deny vide ou absente est une erreur.                      |
| `allow.json`      | Claude Code | Optionnel. Les règles d'autorisation.                                                                                                                                                           |
| `permission.json` | opencode    | Le descripteur `permission` natif d'opencode, chargé tel quel. Un guardrail opencode natif l'exige : absent ou vide est une erreur bloquante. Il n'est jamais traduit depuis les règles Claude. |

Un guardrail qui cible les deux assistants peut porter les trois fichiers dans un seul répertoire. Un
guardrail qui n'en cible qu'un ne peut porter que les fichiers de cet assistant. Scinder les deux en
entrées nommées séparément (par exemple `guardrail:claude` et `guardrail:opencode`) est également
valide, puisque `<name>` est arbitraire.

## Hooks

Tout ce qui se trouve sous `hooks/` est copié dans le store en bloc, pas seulement le `<name>.ts` que
nomme une entrée [hook](/fr/reference/glossary/#hook) donnée. C'est ce qui permet aux scripts de hook
de partager du code : un helper dans `hooks/_shared/hook-lib.ts` est présent à l'exécution pour tout
hook qui l'importe.

L'underscore en tête est la convention qui marque un chemin comme du code partagé plutôt qu'une
entrée. Une entrée `hook:<name>` correspond à `hooks/<name>.ts` ; un fichier ou répertoire dont le
nom commence par `_` n'est jamais une entrée hook, seulement une dépendance de l'une d'elles.

## Allowlist de nommage

Le `<name>` dérivé d'un id d'entrée (la partie après le préfixe `<nature>:`) sert à construire les
chemins du store, les chemins cibles et les symlinks. Il doit correspondre à l'allowlist
`[a-zA-Z0-9._-]+` : lettres, chiffres, underscore, tiret et point uniquement. Un nom vide, `.`, `..`,
ou tout nom contenant `/`, `\` ou tout autre caractère est rejeté avant qu'aucun chemin ne soit
construit. Voir [confiance et sécurité](/fr/concepts/trust-and-security/) pour la menace contre
laquelle cela protège.

## Arborescence d'exemple

```text
my-catalog/
├── catalog.json                      # meta + entries (mcp and tool live here, inline)
├── .claude-plugin/
│   └── marketplace.json              # names the marketplace for Claude Code plugins
├── skills/
│   └── diagnose/
│       ├── SKILL.md                  # skill:diagnose (whole folder is the skill)
│       └── scripts/                  # copied into the store with it
├── agents/
│   └── reviewer.md                   # agent:reviewer (one file)
├── contexts/
│   └── team/
│       └── AGENTS.md                 # context:team
├── guardrails/
│   ├── claude/
│   │   ├── deny.json                 # guardrail:claude (required, non-empty)
│   │   └── allow.json                # optional
│   └── opencode/
│       └── permission.json           # guardrail:opencode (native descriptor)
├── hooks/
│   ├── _shared/
│   │   └── hook-lib.ts               # shared code, not an entry (leading _)
│   └── guard-command.ts              # hook:guard-command
└── plugins/
    └── my-plugin.js                  # plugin:my-plugin (opencode, basename lookup)
```
