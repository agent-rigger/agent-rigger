---
title: Supprimer des artifacts
description: Désinstallez un ou plusieurs artifacts hors ligne, lisez les opérations du plan de suppression, gérez les packs et les fichiers que vous avez modifiés, et retrouvez les backups.
---

Vous voulez retirer un artifact de ce poste. Remove est entièrement hors ligne : il lit le
[manifest](/fr/reference/glossary/#manifest) et le disque, jamais un catalog, il fonctionne donc sans
réseau et sans catalog configuré. Pour la liste complète des flags, voyez la
[référence `remove`](/fr/reference/cli/remove/).

## Supprimer un ou plusieurs ids

Passez des [qualified ids](/fr/reference/glossary/#qualified-id) :

```
agent-rigger remove example/guardrail:demo example/context:demo --yes
```

`--yes` saute la confirmation. Un id non qualifié est rejeté d'emblée :

```
[error] unqualified id "skill:hello-rigger" — use `<catalog>/skill:hello-rigger` (see `agent-rigger ls`)
```

Un id que le manifest ne connaît pas est refusé, et le message liste ce qui est installé pour que
vous choisissiez le bon :

```
[error] Artifact "example/skill:nope" is not installed. Installed entries: example/agent:demo.
```

## Lire le plan de suppression

Remove affiche un plan avant d'écrire, puis un résultat. Chaque artifact apporte exactement les
opérations nécessaires pour défaire ce que son install a écrit :

```
--- Removal Plan ---
Removal plan · 4 changes · scope: user (~/.claude)

- example/guardrail:demo   ~/.claude/settings.json
  deny  (-4)
     - Read(./.env)
     - Read(./.env.*)
     - Read(./**/.env)
     - Read(./secrets/**)
  allow  (-1)
     - Read(./.env.example)

- example/context:demo   ~/.claude/harness/AGENTS.md
  delete  ~/.claude/harness/AGENTS.md
  unimport  ~/.claude/CLAUDE.md

Σ  deny -4 · allow -1 · 1 delete · 1 unimport
```

Les ops de ce plan, et le vocabulaire complet qu'un plan peut lister, sont énumérés dans la
[référence `remove`](/fr/reference/cli/remove/#plan-de-suppression) : ce tableau est la source de vérité. Celles que
l'exemple ci-dessus montre :

- `deny (-N)` / `allow (-N)` : retire les règles deny ou allow que le
  [guardrail](/fr/reference/glossary/#guardrail) a ajoutées à `settings.json`.
- `unimport` : retire du `CLAUDE.md` le bloc d'import managé
  [`@AGENTS.md`](/fr/reference/glossary/#agentsmd-bridge).
- `delete` : supprime un fichier que l'install a écrit.

D'autres, selon l'artifact : `restore` (rend à un fichier écrasé son contenu d'avant l'install),
`unlink` (retire le [symlink](/fr/reference/glossary/#symlink) vers le
[store](/fr/reference/glossary/#store) ; la ligne suivante indique le sort du store,
`(deleted — last reference)` ou `(kept — still referenced)`), `uninstall` (délègue la suppression
d'un [plugin](/fr/reference/glossary/#plugin) à l'assistant), et `un-hook` (désenregistre un
[hook](/fr/reference/glossary/#hook) que l'install a ajouté).

Une suppression qui change quelque chose sur le disque demande confirmation. Une entrée dont la cible
a déjà disparu est purgée du manifest sans invite (rapportée comme `purged (already absent)`),
puisqu'elle ne touche rien sur le disque.

## Supprimer un pack

Un [pack](/fr/reference/glossary/#pack) est développé en ses membres au moment de l'install, il n'y a
donc pas d'entrée de pack à supprimer. Demander la suppression d'un pack est refusé, avec un message
qui vous oriente :

```
[error] Pack "<id>" is not installed — packs are expanded at install time; remove their member artifacts instead. Installed entries: <ids>.
```

Listez les membres avec `agent-rigger ls`, puis supprimez-les par id.

## Une cible que vous avez modifiée vous-même

Si vous avez modifié un fichier qu'agent-rigger avait installé, remove ne l'écrase ni ne supprime
votre version. Il laisse le fichier en place et rapporte un avertissement au lieu de le retirer. Rien
de ce que vous avez modifié n'est perdu par un remove.

## Où sont les backups

Avant de retirer ou de remplacer un fichier, remove en prend une copie octet pour octet à côté, avec
un suffixe [`.bak-*`](/fr/reference/glossary/#backup-bak). Le bloc de résultat les liste toutes :

```
[backup] 3 file(s) backed up.
  ~ /Users/you/.claude/settings.json.bak-2026-07-12T13-57-19.084Z-50f11f03
  ~ /Users/you/.claude/harness/AGENTS.md.bak-2026-07-12T13-57-19.085Z-a02b032a
  ~ /Users/you/.claude/CLAUDE.md.bak-2026-07-12T13-57-19.085Z-8349fb01
```

Les chemins du bloc de résultat sont absolus (le plan ci-dessus les abrège en `~/.claude/…` ; le bloc
de résultat, non).

Ces copies sont votre rollback : l'outil n'en supprime jamais une récente.
