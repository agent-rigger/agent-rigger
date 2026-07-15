---
title: Cibler Claude Code ou opencode
description: Épinglez l'assistant visé par une commande avec --assistant, persistez ce choix, et sachez ce qui change quand vous installez pour opencode plutôt que pour Claude Code.
---

Vous faites tourner plus d'un assistant, ou vous voulez être sûr qu'une commande agit sur celui que
vous visez. Ce guide montre comment épingler l'[assistant](/fr/reference/glossary/#assistant) qu'une
commande cible, persister ce choix pour arrêter de répéter le flag, et ce qui change concrètement
quand vous installez pour opencode plutôt que pour Claude Code. [Prise en main](/fr/start/getting-started/)
parcourt un premier passage de bout en bout. Pour l'ordre de résolution complet et le tableau des
flags, voyez la [vue d'ensemble](/fr/reference/cli/overview/#résolution-de-lassistant) ; pour
comprendre pourquoi le même artifact source prend une forme différente sur chaque assistant, voyez
[natures d'artifact](/fr/concepts/artifact-natures/).

## Épingler l'assistant pour une commande

Passez `--assistant` sur toute commande qui écrit ou audite (`install`, `check`, `remove`, `update`) :

```
agent-rigger install jr/skill:tdd-coach --assistant opencode --yes
```

Le flag n'accepte que `claude` ou `opencode`, et il l'emporte sur tout le reste : un script qui le
nomme ne dépend jamais de ce qui est installé sur la machine. Une valeur qui n'est ni l'une ni
l'autre est une erreur bloquante avant que le moindre travail ne démarre :

```
[error] Invalid --assistant value: "foobar". Must be "claude" or "opencode".
```

## Laisser rigger le résoudre

Sans le flag, rigger choisit exactement un assistant par passage. En bref : un seul assistant
configuré est utilisé, sinon un seul détecté (`~/.claude` pour Claude Code, `~/.config/opencode`
pour opencode), sinon une invite de terminal, sinon `claude` comme défaut rétrocompatible. `check`,
`remove` et `update` lisent d'abord le [manifest](/fr/reference/glossary/#manifest), donc quand
chaque entrée qu'ils touchent a été installée pour un seul assistant, cet assistant est utilisé sans
invite. La [vue d'ensemble](/fr/reference/cli/overview/#résolution-de-lassistant) fait autorité sur
cet ordre.

Dans un terminal sans rien de configuré ni détecté, rigger demande :

```
Which assistant do you want to target?
```

Dans un script l'invite n'est pas disponible, donc épinglez l'assistant explicitement (le flag
ci-dessus) ou configurez-le une bonne fois (ci-dessous). La résolution est la même pour chaque
commande, ce qui veut dire qu'une machine configurée d'une certaine façon se comporte de la même
manière à travers `install`, `check`, `remove` et `update`.

## Persister votre choix

`agent-rigger init` écrit les assistants que vous choisissez dans `assistants[]` de votre
configuration. Quand cette liste ne contient qu'une seule entrée, chaque commande la cible sans le
flag, et la détection comme l'invite sont sautées. Configurez-le une bonne fois plutôt que de passer
`--assistant` à chaque appel. Voyez [prise en main](/fr/start/getting-started/) pour le parcours de
init.

## Ce qui change quand vous ciblez opencode

La surface de commande est identique. Ce qui diffère, c'est où les fichiers atterrissent et la forme
native que prend chaque artifact.

**Où atterrissent les fichiers.** Les artifacts Claude Code vont sous `~/.claude` au scope user, ou
`<repo>/.claude` au scope project. Les artifacts opencode vont sous `~/.config/opencode` au scope
user ; au scope project, `opencode.json` et `AGENTS.md` se trouvent à la racine du dépôt et le reste
sous `<repo>/.opencode`. La grille complète de chaque nature contre chaque assistant et scope est
[où chaque nature atterrit](/fr/concepts/artifact-natures/#où-chaque-nature-atterrit).

**Guardrails.** Un [guardrail](/fr/reference/glossary/#guardrail) sur Claude Code est un ensemble de
règles deny et allow fusionnées dans `settings.json`. Sur opencode, c'est un objet `permission`
natif fusionné dans `opencode.json`. Le catalog rédige directement le descripteur de permission
d'opencode ; il n'y a aucune traduction automatique depuis les règles Claude, donc un guardrail ne
s'installe pour opencode que si son entrée de catalog en fournit un.

**Agents.** Claude Code lie le `.md` source tel quel. opencode écrit un fichier traduit : son
frontmatter est réécrit dans le schéma d'opencode. Vous obtenez un fichier différent sur le disque à
partir de la même source de catalog.

**Vous n'avez pas besoin qu'opencode soit installé.** rigger écrit directement les fichiers
d'opencode et n'invoque jamais le binaire opencode, ce qui veut dire que vous pouvez mettre en place un
harness opencode sur une machine avant même qu'opencode y soit installé. Le seul effet d'un
`~/.config/opencode` manquant est sur l'auto-détection : rigger ne choisira pas opencode de lui-même,
donc passez `--assistant opencode` ou fixez `assistants[]`.

## Quand un artifact ne cible pas votre assistant

Chaque entrée de catalog déclare les assistants qu'elle cible. Quand vous sélectionnez une entrée
dont les cibles excluent l'assistant pour lequel vous installez, rigger la saute plutôt que d'écrire
le mauvais format. Il rapporte le saut et n'installe rien :

```
--- Skipped (assistant mismatch) ---
  [skipped] example/skill:hello-rigger — targets [claude], not opencode
```

Le passage sort en `0` et ne touche aucun fichier. Le correctif n'est pas un flag : soit vous ciblez
l'assistant pour lequel l'entrée a été rédigée, soit vous utilisez une entrée de catalog qui liste le
vôtre parmi ses cibles.

## copilot est réservé

`copilot` est un nom d'assistant reconnu, mais sans [adapter](/fr/reference/glossary/#adapter) pour
l'instant, il ne peut pas être sélectionné. Le passer est rejeté comme n'importe quelle valeur
invalide :

```
[error] Invalid --assistant value: "copilot". Must be "claude" or "opencode".
```

La commande sort en `2` et n'écrit rien.
