---
title: Publier un guardrail
description: "Rédigez une entrée guardrail dans votre catalog : les fichiers deny/allow qu'elle référence, ce qu'agent-rigger fusionne dans les settings de chaque assistant, ce qui arrive à une règle déjà existante, et comment remove l'annule."
---

Un [guardrail](/fr/reference/glossary/#guardrail) est une règle de permission qui bloque durement une
action : `Read(./.env)`, un force-push, un `curl` vers un hôte inconnu. C'est l'unique
[nature](/fr/reference/glossary/#nature) qu'aucun système de plugin propre à un assistant ne peut
donner à votre équipe, ce qui explique pourquoi agent-rigger écrit les règles directement dans le
fichier de settings de chaque assistant plutôt que de livrer un plugin (voir
[natures d'artifact](/fr/concepts/artifact-natures/)). Cela suppose que vous disposiez déjà d'un
dépôt de catalog ; si ce n'est pas le cas, construisez-en un d'abord avec
[créer un catalog](/fr/authoring/create-a-catalog/).

## L'entrée du catalog

Un guardrail est une entrée [artifact](/fr/reference/glossary/#artifact) dans `catalog.json`. Elle
ne porte que les [champs communs](/fr/reference/catalog-schema/#champs-communs) ; il n'y a aucune
clé spécifique au guardrail dans l'entrée, car les règles vivent dans des fichiers, pas dans
l'entrée elle-même :

```json title="entrée dans catalog.json"
{
  "kind": "artifact",
  "id": "guardrail:no-force-push",
  "nature": "guardrail",
  "targets": ["claude"],
  "scopes": ["user", "project"]
}
```

`id` suit la forme `<nature>:<name>` ; le `no-force-push` après les deux-points est le `<name>` qui
nomme le répertoire à l'étape suivante. `targets` liste les
[assistants](/fr/reference/glossary/#assistant) que ce guardrail supporte, et `scopes` les
[scopes](/fr/reference/glossary/#scope) où il s'installe. Chaque champ, ainsi que chaque champ
optionnel qu'un guardrail omet (`level`, `check`, `install`, `config`), est dans la
[référence du schéma de catalog](/fr/reference/catalog-schema/#entrées-artifact).

Pour aussi protéger [opencode](/fr/guides/choose-assistant/), nommez-le dans `targets`. Les deux
assistants lisent des fichiers différents (ci-dessous), si bien qu'un guardrail qui cible les deux
porte les deux jeux de fichiers dans un seul répertoire :

```json title="entrée dans catalog.json"
{
  "kind": "artifact",
  "id": "guardrail:baseline",
  "nature": "guardrail",
  "targets": ["claude", "opencode"],
  "scopes": ["user", "project"]
}
```

## Les fichiers dans le catalog

Les règles d'un guardrail vivent sous `guardrails/<name>/`, où `<name>` est le suffixe de l'id. Les
fichiers que contient le répertoire dépendent des assistants que l'entrée cible :

```
guardrails/
└── no-force-push/
    ├── deny.json        # Claude Code — required, non-empty
    └── allow.json       # Claude Code — optional
```

`deny.json` est la liste de blocage que Claude Code applique. Un guardrail est
[fail-closed](/fr/reference/glossary/#fail-closed--fail-open) : un `deny.json` absent ou vide pour
un guardrail ciblant claude est une erreur bloquante, jamais un no-op silencieux. Un guardrail qui
s'installe mais ne protège rien serait une fausse confiance de sécurité.

```json title="guardrails/no-force-push/deny.json"
{
  "deny": [
    "Bash(git push --force:*)",
    "Bash(curl:*)",
    "WebFetch(domain:paste.example)"
  ]
}
```

`allow.json` est optionnel. Il liste les dérogations qui élargissent `permissions.allow` : une
échappatoire à une règle deny plus large.

```json title="guardrails/no-force-push/allow.json"
{
  "allow": [
    "Bash(git push --force-with-lease:*)"
  ]
}
```

Un guardrail ciblant opencode porte un troisième fichier, `permission.json`, qui contient le
descripteur `permission` **natif** d'opencode, chargé tel quel. Il n'est jamais traduit depuis les
règles Claude. Il est de même requis et non vide pour un guardrail opencode. Les clés sont des tools
opencode ; chaque valeur est un état (`allow`, `ask`, `deny`) ou une map de patterns vers des états :

```json title="guardrails/env-lock/permission.json"
{
  "permission": {
    "bash": {
      "terraform destroy*": "deny",
      "git push --force*": "ask"
    },
    "webfetch": "ask"
  }
}
```

Le tableau complet fichier par fichier, ainsi que la disposition d'un guardrail qui livre les trois
fichiers à la fois, sont dans la
[référence de disposition du catalog](/fr/reference/catalog-layout/#guardrails). Pour une entrée
vivante à laquelle vous comparer, le
[catalog d'exemple](https://github.com/agent-rigger/agent-rigger-catalog-example) livre
`guardrail:demo` : il refuse la famille `Read(./.env)` et autorise `Read(./.env.example)`.

## Ce qu'install écrit, par assistant

Les deux assistants reçoivent un guardrail par **merge** : les règles sont repliées dans un fichier
de settings existant, et toute autre clé de ce fichier est préservée. Seuls le fichier cible et la
clé diffèrent. Le tableau exact chemin-et-mécanisme pour chaque scope est dans
[la matrice des natures](/fr/reference/natures-matrix/#guardrail) ; ce qu'un auteur doit voir, c'est
le résultat sur disque.

Sur **Claude Code**, les règles atterrissent dans `permissions.deny` (et `permissions.allow`) de
`settings.json`. Un `merge-allow` affiche toujours un avertissement de plan, car élargir
`permissions.allow` désactive le prompt d'approbation humaine de Claude Code pour les commandes
concernées :

```
--- Plan ---
Plan · 2 changes · scope: user (~/.claude)

+ cltest/guardrail:no-force-push   ~/.claude/settings.json
  deny  (+3)
     + Bash(git push --force:*)
     + Bash(curl:*)
     + WebFetch(domain:paste.example)
  allow  (+1)
     + Bash(git push --force-with-lease:*)

Σ  deny +3 · allow +1
--- Warnings ---
  [warning] this remote guardrail widens permissions.allow: Bash(git push --force-with-lease:*)


--- Result ---
  [ok] Applied 2 file(s).
```

Le `~/.claude/settings.json` résultant :

```json
{
  "permissions": {
    "deny": [
      "Bash(git push --force:*)",
      "Bash(curl:*)",
      "WebFetch(domain:paste.example)"
    ],
    "allow": [
      "Bash(git push --force-with-lease:*)"
    ]
  }
}
```

Sur **opencode**, le descripteur `permission.json` est fusionné dans la clé `permission` de
`opencode.json`, au niveau des feuilles : les commentaires utilisateur et toute autre clé
(`$schema`, `mcp`, `agent`) survivent.

```
--- Plan ---
Plan · 1 change · scope: user (~/.config/opencode)

+ octest/guardrail:env-lock


--- Result ---
  [ok] Applied 1 file(s).
```

```json title="~/.config/opencode/opencode.json"
{
  "permission": {
    "bash": {
      "terraform destroy*": "deny",
      "git push --force*": "ask"
    },
    "webfetch": "ask"
  }
}
```

## Ce qui arrive à une règle déjà existante

Le merge est additif et n'écrase jamais rien. Sur Claude Code vos règles sont ajoutées à la fin du
`permissions.deny` existant ; une règle déjà présente n'est pas ajoutée deux fois. Installer
`no-force-push` dans un `settings.json` qui refuse déjà `Bash(sudo:*)` et `Bash(curl:*)` n'ajoute
que les deux nouvelles règles : `Bash(curl:*)` est dédupliquée, et le `Bash(sudo:*)` propre à
l'utilisateur reste intact.

```
+ cltest/guardrail:no-force-push   ~/.claude/settings.json
  deny  (+2)
     + Bash(git push --force:*)
     + WebFetch(domain:paste.example)
  allow  (+1)
     + Bash(git push --force-with-lease:*)

Σ  deny +2 · allow +1
```

Comme le merge est idempotent, réinstaller un guardrail déjà entièrement présent est un no-op :

```
--- Plan ---
Nothing to apply — already up to date.

--- Result ---
  [ok] Already up to date — nothing to install.
```

Sur opencode le merge se fait feuille par feuille. Une feuille que votre descripteur veut, mais que
le `opencode.json` de l'utilisateur revendique déjà avec une valeur **différente**, n'est pas
écrasée : agent-rigger abandonne cette feuille et le plan porte un avertissement nommant la règle et
la valeur utilisateur en conflit. Il avertit aussi quand un glob de guardrail recouvre un pattern
utilisateur à l'orthographe différente que la précédence du dernier match d'opencode laisserait
votre règle gagner. Dans tous les cas la configuration existante est préservée et le conflit est
signalé, pas résolu à votre place.

## Remove annule exactement ce qui a été installé

Au moment de l'install, agent-rigger enregistre le jeu de règles canonique complet du guardrail dans
le [applied payload](/fr/reference/glossary/#applied-payload) : pour Claude les règles deny et allow
qu'il a ajoutées, pour opencode le fragment `permission` entier. `remove` rejoue ce payload à
l'envers : il retire exactement les règles enregistrées et laisse toute règle utilisateur en place.
La suppression côté Claude, et le `settings.json` qu'elle laisse derrière elle :

```
--- Removal Plan ---
Removal plan · 2 changes · scope: user (~/.claude)

- cltest/guardrail:no-force-push   ~/.claude/settings.json
  deny  (-3)
     - Bash(git push --force:*)
     - Bash(curl:*)
     - WebFetch(domain:paste.example)
  allow  (-1)
     - Bash(git push --force-with-lease:*)

Σ  deny -3 · allow -1

--- Result ---
  [ok] Removed 1 entry(s).
    - cltest/guardrail:no-force-push
  [backup] 1 file(s) backed up.
```

```json title="~/.claude/settings.json après remove"
{
  "permissions": {
    "deny": [],
    "allow": []
  }
}
```

Un backup (`.bak`) est écrit avant que le fichier ne change. Sur Claude Code, `remove` fait
correspondre les règles par chaîne exacte avec ce qui a été enregistré : une règle éditée à la main
sur disque depuis l'install ne correspond plus, donc elle est laissée en place sans avertissement.
La suppression côté opencode est décidée feuille par feuille et est robuste aux éditions à la main :
une règle modifiée sur disque depuis l'install ne correspond plus à ce qui a été enregistré, donc
`remove` la laisse en place et avertit plutôt que de supprimer une règle éditée. Le fragment
`permission` enregistré est retiré de `opencode.json`, qui se retrouve avec un objet `permission`
vide.

## Testez-le en local avant de publier

Vous n'avez besoin de rien pousser pour itérer. Pointez l'outil vers un
[`RIGGER_HOME`](/fr/reference/glossary/#rigger_home) jetable pour que les installs n'écrivent que
sous un répertoire jetable, puis installez votre guardrail directement depuis son dossier de catalog
local, la même boucle que [créer un catalog](/fr/authoring/create-a-catalog/) :

```sh
export RIGGER_HOME="$(mktemp -d)"
export NO_COLOR=1
```

Enregistrez le catalog local par chemin et installez le guardrail par son
[qualified id](/fr/reference/glossary/#qualified-id), en acceptant le plan avec `--yes` :

```sh
agent-rigger catalog add cltest /path/to/your-catalog
agent-rigger install cltest/guardrail:no-force-push --yes
```

Confirmez qu'il est bien appliqué :

```sh
agent-rigger check
```

```
  [ ok  ]  guardrails-claude  (guardrail)

--- Catalogs ---
  [up-to-date]   cltest  (v0.1.0)
```

Pour exercer un guardrail opencode, pilotez l'install pour cet assistant avec
`--assistant opencode` ; son check rapporte sous `guardrails-opencode`. Dans toute session
non-interactive (CI, la boucle sandbox ci-dessus), nommez toujours l'id et passez `--yes` : un
`agent-rigger install` nu, sans id et sans TTY, n'a rien à sélectionner et ne peut pas continuer
(voir [CI et scripts](/fr/guides/ci-and-scripts/)).

Effacez le sandbox une fois terminé ; votre dépôt de catalog reste en place :

```sh
rm -rf "$RIGGER_HOME"
unset RIGGER_HOME
```

## Les autres natures

Le guardrail est l'une des huit natures. L'ensemble complet, et le mécanisme sur disque que chacune
utilise par assistant et par scope, est dans
[la matrice des natures](/fr/reference/natures-matrix/). Deux de ces natures portent leurs règles
différemment d'un guardrail et ont leur propre contrat : `mcp` déclare son `config` et ses `secrets`
de serveur à même `catalog.json` (voir
[publier un serveur MCP](/fr/authoring/mcp-servers/)), et `tool` n'est qu'une vérification de
présence advisory (l'installer n'est pas encore livré). Voir la
[référence du schéma de catalog](/fr/reference/catalog-schema/) pour ces champs.
