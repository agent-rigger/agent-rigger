---
title: Events de hook
description: "Le contrat hook d'agent-rigger : les neuf events de hook qu'il reconnaît, la déclaration event/matcher/timeout, la forme de settings.json qu'il écrit, et la frontière de protocole runtime qu'il ne franchit pas."
---

Une entrée [hook](/fr/reference/glossary/#hook) enregistre une command qu'un assistant lance
automatiquement à un moment de son cycle de vie. Cette page est le contrat exact pour la nature
[`hook`](/fr/concepts/artifact-natures/) : les events qu'agent-rigger reconnaît, comment un hook se
déclare dans un catalog, ce qu'agent-rigger écrit dans les settings de l'assistant, et où le
protocole runtime cesse d'être l'affaire d'agent-rigger. Pour le schéma champ par champ, voir
[schéma catalog.json](/fr/reference/catalog-schema/#champs-hook) ; pour pourquoi les hooks existent
comme l'une des natures d'artifact, voir [natures d'artifact](/fr/concepts/artifact-natures/).

## Events supportés

agent-rigger reconnaît **neuf** events de hook. Le champ `event` d'une entrée hook doit valoir
exactement l'une de ces chaînes ; toute autre valeur est rejetée au parsing.

| Event              | Se déclenche                                 |
| ------------------ | -------------------------------------------- |
| `PreToolUse`       | Avant qu'un appel d'outil ne s'exécute.      |
| `PostToolUse`      | Après qu'un appel d'outil se termine.        |
| `UserPromptSubmit` | Quand l'utilisateur soumet un prompt.        |
| `Stop`             | Quand l'agent principal termine de répondre. |
| `SubagentStop`     | Quand un sous-agent termine de répondre.     |
| `SessionStart`     | Au démarrage d'une session.                  |
| `SessionEnd`       | À la fin d'une session.                      |
| `Notification`     | Quand l'assistant émet une notification.     |
| `PreCompact`       | Avant que la conversation ne soit compactée. |

La liste est fermée. Elle est fixée dans le schéma de catalog sous le nom `HOOK_EVENTS` ; ajouter
un event est un changement de code, pas un changement de catalog. Le moment où chaque event se
déclenche est le comportement de Claude Code, pas celui d'agent-rigger. agent-rigger se contente
d'enregistrer sous quel nom d'event un hook est déclaré.

Ce neuf est l'ensemble reconnu propre à agent-rigger, pas une affirmation que Claude Code n'en
définit aucun autre. Si Claude Code accepte un nom d'event hors de cette liste — `PostCompact`, par
exemple — agent-rigger ne le reconnaît pas : une entrée de catalog qui le déclare échoue au
parsing, en signalant le champ `event` contre la liste fermée :

```text title="erreur de parsing catalog.json (PostCompact est hors de HOOK_EVENTS)"
catalog.json contains invalid entries: index <n>: event Invalid option: expected one of "PreToolUse"|"PostToolUse"|"UserPromptSubmit"|"Stop"|"SubagentStop"|"SessionStart"|"SessionEnd"|"Notification"|"PreCompact"
```

un hook sur un tel event ne peut donc pas du tout être catalogué via agent-rigger. Étendre
`HOOK_EVENTS` pour couvrir des events hors de ce neuf n'est pas encore livré.

## Support par assistant

La nature hook est livrée pour l'assistant [`claude`](/fr/reference/glossary/#assistant).
L'enregistrement écrit le format hook natif `settings.json` de Claude Code, si bien qu'un hook
prend effet sur Claude Code. L'adapter `opencode` ne porte aucun handler de hook, et `copilot` est
réservé dans tout le catalog. La liste `targets` d'une entrée hook est tout de même validée contre
`claude`, `opencode`, `copilot` par le schéma, mais seul `claude` dispose d'un mécanisme qui la
consomme.

## Déclarer un hook

Un hook est une entrée [artifact](/fr/reference/glossary/#artifact) de catalog avec
`nature: "hook"`. Deux champs sont obligatoires pour cette nature ; le schéma rejette une entrée
qui en omet un, chacun avec son propre message.

| Champ     | Type    | Requis | Règle                                                                                         |
| --------- | ------- | ------ | --------------------------------------------------------------------------------------------- |
| `event`   | enum    | oui    | L'un des neuf [events supportés](#events-supportés). Absent → `hook entries require 'event'`. |
| `matcher` | string  | oui    | Le pattern d'action que le hook écoute. Absent → `hook entries require 'matcher'`.            |
| `timeout` | integer | non    | Le temps d'exécution maximal en secondes. Entier positif.                                     |

`matcher` est un nom d'outil ou un pattern, par exemple `Bash` pour ne se déclencher que sur les
appels de l'outil Bash, ou `*` pour correspondre à toute action. agent-rigger exige un `matcher`
sur chaque entrée hook et en écrit toujours un, y compris pour les events qui ne portent aucun
outil (`Stop`, `SessionStart`, `PreCompact`, …). Une entrée hook porte aussi les
[champs communs d'entrée](/fr/reference/catalog-schema/#champs-communs) : `id`, `targets`,
`scopes`, et `requires` en option.

```json title="une entrée hook dans catalog.json"
{
  "kind": "artifact",
  "id": "hook:demo",
  "nature": "hook",
  "targets": ["claude"],
  "scopes": ["user", "project"],
  "event": "PreToolUse",
  "matcher": "Bash",
  "timeout": 5
}
```

Les champs qui appartiennent à d'autres natures (`config`, `secrets`, `install`, …) sont ignorés
sur une entrée hook ; ils ne sont ni requis ni rejetés. Seuls `event` et `matcher` sont imposés.

## Ce qu'agent-rigger écrit

Installer un hook fusionne une entrée dans le `settings.json` de l'assistant sous la clé
[`hooks`](/fr/reference/glossary/#hook), dans la forme native de Claude Code. Aucune autre clé du
fichier n'est touchée.

```json title="settings.json (résultat de l'entrée ci-dessus)"
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bun run ~/.config/agent-rigger/hooks/demo.ts",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

La `command` enregistrée est dérivée, pas rédigée à la main : c'est
`bun run <store>/<name>.ts`, où `<name>` est l'id de l'entrée avec son préfixe `hook:` retiré
(vérifié pour la sûreté des chemins), et `<store>` est le [store](/fr/reference/glossary/#store) de
hook partagé, `~/.config/agent-rigger/hooks/`. À l'install, le script garde-fou est copié depuis le
répertoire `hooks/` du checkout du catalog vers ce store ; chaque hook partage l'unique répertoire
de store. Les hooks s'installent depuis un checkout de catalog distant ; un hook qui n'est pas
résolu depuis un checkout est refusé. `timeout`, quand il est déclaré, est copié sur la command ;
quand il est absent, la command ne porte aucun champ `timeout` du tout.

Le scope décide quel `settings.json` est écrit : le scope `user` cible
`~/.claude/settings.json`, le scope `project` cible `<cwd>/.claude/settings.json`.

## Le protocole runtime appartient à Claude Code

agent-rigger enregistre une command et dépose un script ; il ne lance pas le hook et ne définit pas
ce que le hook échange au runtime. Quand l'event se déclenche, **Claude Code** — pas agent-rigger —
lance la command enregistrée. Ce que cette command lit sur stdin, ce qu'elle écrit sur stdout, son
encodage, et les exit codes qu'elle renvoie appartiennent au protocole de hook de Claude Code,
défini et interprété par Claude Code. Pour agent-rigger, la chaîne `command` est opaque : elle est
enregistrée, dédupliquée et supprimée comme une chaîne littérale, jamais parsée ni exécutée par
agent-rigger lui-même.

C'est une frontière dure. La référence [codes de sortie](/fr/reference/exit-codes/) documente les
codes que la **CLI** agent-rigger renvoie depuis `install`, `remove`, `check`, et le reste. Elle ne
documente pas les codes de sortie qu'un script de hook renvoie à Claude Code au runtime. Les deux
sont des contrats sans rapport.

## Sémantique d'enregistrement

La fusion qui installe un hook, et la suppression qui le désinstalle, obéissent à des règles
fixes.

- Enregistrer deux fois le même `(event, matcher, command)` est idempotent : cela produit le même
  `settings.json` qu'un seul enregistrement. Une install de réparation n'ajoute jamais une seconde
  copie d'une command déjà présente sous le matcher, y compris quand un réordonnancement manuel
  l'a déplacée dans une entrée de même matcher plus tardive.
- Seules les entrées de command qu'agent-rigger reconnaît (une chaîne `matcher` plus un tableau
  `hooks` d'éléments `type: "command"`) sont gérées. Les entrées rédigées à la main (entrées
  natives sans matcher, éléments qui ne sont pas `type: "command"`, champs inconnus) survivent en
  place et dans l'ordre à travers une install ou un remove.
- Supprimer un hook efface son entrée de command. Si cela laisse l'entrée de matcher vide, elle
  est retirée ; si cela vide le tableau de l'event, la clé de l'event est retirée ; et si cela vide
  la map, la clé `hooks` elle-même est supprimée. Les éléments étrangers comptent comme du contenu
  et maintiennent leur entrée en vie.
- Quand une réinstall résout un `event`, un `matcher` ou une `command` différents de ce que le
  manifest avait enregistré, l'ancien enregistrement est retiré dans la même opération qui écrit
  le nouveau, si bien que le hook ne se retrouve jamais enregistré deux fois.

## Fail-closed sur un fichier malformé

Si `settings.json` a été édité à la main vers une forme que la fusion ne peut pas réécrire en
sécurité, agent-rigger interrompt avant de toucher au fichier plutôt que d'écraser du contenu.
Deux erreurs typées portent cela, avec le message exact affiché :

| Condition                                             | Message                                                                                                                                                                                               |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks.<event>` est présent mais n'est pas un tableau | `Invalid hooks shape at "hooks.<event>": expected an array of hook entries, got <shape>. Fix "hooks.<event>" in the settings file so it is a JSON array, then retry. The file has not been modified.` |
| `hooks` est présent mais n'est pas un objet           | `Invalid hooks shape at "hooks": expected an object mapping events to arrays, got <shape>. Fix "hooks" in the settings file so it is a JSON object, then retry. The file has not been modified.`      |

Les deux interrompent l'exécution avant toute écriture ; le chemin d'audit (`check`) reste
permissif et lit une valeur `hooks` malformée comme « non installé » plutôt que de lever une
erreur.
