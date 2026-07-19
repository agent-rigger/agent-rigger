---
title: Premiers pas
description: "Installez votre premier rig en une dizaine de minutes : ajoutez le catalog d'exemple public, listez ce qu'il propose, installez un pack et vérifiez le résultat, le tout dans un sandbox jetable."
---

Ce tutoriel vous mène d'un agent-rigger fraîchement installé à un rig fonctionnel en une
dizaine de minutes. Vous pointerez l'outil vers un
[catalog](/fr/reference/glossary/#catalog) d'exemple public, verrez ce qu'il propose,
installerez un petit ensemble et confirmerez le résultat, sans toucher à votre vraie
configuration.

Vous avez besoin d'agent-rigger [installé](/fr/start/installation/) et de `git` sur votre
poste.

![Enregistrement terminal de tout le tutoriel premiers pas, joué de bout en bout dans un sandbox jetable. D'abord, `rigger doctor` liste quatre dépendances — git, glab, gitleaks, trivy — chacune avec une coche, puis la ligne "mode : full scan" et un état installé sain et vide. Ensuite, `rigger catalog add example https://github.com/agent-rigger/agent-rigger-catalog-example.git` enregistre le catalog d'exemple public et affiche la confirmation "example" added. `rigger ls` liste alors les sept entrées du catalog, chacune taguée &#91;available&#93; et qualifiée du nom example/ : un skill, un agent, un guardrail, un hook, un context et deux packs. `rigger install example/pack:demo --yes --summary` installe le pack demo — un Plan compact de deux changements, le skill hello-rigger et le sous-agent demo, chacun lié dans le store, suivi d'un Result affichant "&#91;ok&#93; Applied 2 file(s)." Enfin, `rigger check` rapporte le catalog example à jour en v0.4.0. Rien ne touche au vrai répertoire home de l'opérateur.](../../../../assets/recordings/getting-started.gif)

_Tout le tutoriel en un seul passage : lire l'environnement, enregistrer le catalog d'exemple, voir ce qu'il propose, installer `example/pack:demo` et vérifier le résultat — le tout sous un `RIGGER_HOME` jetable. Le film utilise le Plan compact `--summary` ; les blocs pas à pas ci-dessous font référence, le film ne fait que les illustrer. <small>Généré depuis docs/tapes/getting-started.tape, 2026-07-18. Régénérer : bun run build && vhs docs/tapes/getting-started.tape.</small>_

## Travailler dans un sandbox jetable

Tout ici s'exécute dans un répertoire home jetable, si bien que rien n'atterrit dans
votre vrai `~/.claude` ou `~/.config`. La variable d'environnement
[`RIGGER_HOME`](/fr/reference/glossary/#rigger_home) remplace le répertoire home qu'utilise
l'outil pour tout chemin de scope user ; réglez-la sur un répertoire temporaire neuf :

```sh
export RIGGER_HOME="$(mktemp -d)"
```

Chaque commande ci-dessous lit et écrit uniquement sous ce répertoire. Une fois terminé, un
seul `rm -rf` efface toute l'expérience. Laissez `RIGGER_HOME` non défini en usage réel, et
rigger écrit dans votre véritable répertoire home.

Les sorties montrées utilisent `NO_COLOR=1` pour un copier-coller lisible ; sur un vrai
terminal, l'outil ajoute de la couleur. Les chemins absolus dans la sortie reflètent la
valeur qu'a prise `RIGGER_HOME`. Les vôtres seront différents.

## Étape 1 — lire l'environnement

Commencez par demander à [`doctor`](/fr/reference/glossary/#doctor) ce qu'il voit. Il
indique les outils externes sur lesquels rigger s'appuie et le mode de scan dans lequel
vous êtes, puis contrôle l'état installé (vide pour l'instant) :

```sh
rigger doctor
```

```
--- rigger doctor ---

✓ git (/opt/homebrew/bin/git)
✓ glab (/opt/homebrew/bin/glab)
✓ gitleaks (/opt/homebrew/bin/gitleaks)
✓ trivy (/opt/homebrew/bin/trivy)

mode : full scan

Installed state is healthy — no findings.
```

`mode : full scan` signifie que gitleaks ou trivy est présent, donc le contenu récupéré
sera scanné. Si les deux manquaient, vous verriez plutôt `warn-only` ici : l'install
fonctionne toujours, mais le contenu n'est pas scanné. Rien n'est encore installé, donc
l'état est sain.

## Étape 2 — ajouter le catalog d'exemple

Enregistrez le catalog d'exemple public sous un nom local, `example`. Une URL git distante
fait office de source (un chemin local aussi) :

```sh
rigger catalog add example https://github.com/agent-rigger/agent-rigger-catalog-example.git
```

```
catalog "example" added (https://github.com/agent-rigger/agent-rigger-catalog-example.git)
```

La source est désormais enregistrée dans votre config. Confirmez-le avec
`rigger catalog ls`, qui liste chaque catalog configuré sous la forme `name  url`.

## Étape 3 — voir ce qui est disponible

Listez les entrées du catalog :

```sh
rigger ls
```

```
Catalog (7 entries):
  [available]  example/skill:hello-rigger  skill
  [available]  example/agent:demo          agent
  [available]  example/guardrail:demo      guardrail
  [available]  example/hook:demo           hook
  [available]  example/context:demo        context
  [available]  example/pack:demo           pack       (2 members)
  [available]  example/pack:full           pack       (5 members)
```

Chaque id est [qualifié](/fr/reference/glossary/#qualified-id) du nom de son catalog
(`example/skill:hello-rigger`), pour que les ids restent non ambigus quand vous configurez
plusieurs catalogs. Chaque ligne est `[available]` ; aucune n'est encore installée. Les
deux [packs](/fr/reference/glossary/#pack) regroupent plusieurs artifacts sous un seul id.
(Le catalog d'exemple déclare aussi une entrée `tool:git` ; les entrées tool advisory ne
sont pas montrées dans cette liste, voir la [référence CLI](/fr/reference/cli/overview/).)

## Étape 4 — installer un pack

Installez `example/pack:demo`, qui regroupe le skill `hello-rigger` et le sous-agent
`demo`. Passer `--yes` accepte le plan sans invite interactive :

```sh
rigger install example/pack:demo --yes
```

```
--- Plan ---
Plan · 2 changes · scope: user (~/.claude)

+ example/skill:hello-rigger   ~/.claude/skills/hello-rigger
  link  ~/.claude/skills/hello-rigger → store

+ example/agent:demo   ~/.claude/agents/demo.md
  link  ~/.claude/agents/demo.md → store

Σ  2 links

--- Result ---
  [ok] Applied 2 file(s).
    + /tmp/tmp.rig8f2/.claude/skills/hello-rigger
    + /tmp/tmp.rig8f2/.claude/agents/demo.md
```

Le bloc **Plan** est le [dry-run](/fr/reference/glossary/#plan-dry-run) : les changements
exacts que rigger va faire, montrés avant qu'il ne les fasse. Ici, les deux artifacts
s'installent comme un [symlink](/fr/reference/glossary/#symlink) pointant vers un
[store](/fr/reference/glossary/#store) managé, une seule copie physique que l'assistant
atteint via le lien. Comme vous avez passé `--yes`, rigger a appliqué le plan aussitôt ;
sans lui, il s'arrêterait pour demander confirmation avant d'écrire. Le bloc **Result** liste les
fichiers qu'il a réellement écrits.

## Étape 5 — vérifier le résultat

Lancez `check` pour confirmer que tout est correctement en place :

```sh
rigger check
```

```
--- Catalogs ---
  [up-to-date]   example  (v0.4.0)
```

`check` renvoie l'[exit code](/fr/reference/glossary/#exit-code) `0` quand tout ce qu'il
audite est présent et concordant. Le pack n'a installé qu'un skill et un sous-agent (que
`check` ne réaudite pas en détail), si bien que le rapport n'affiche que le statut du
catalog : `example` a été résolu à la version `v0.4.0` et votre install est à jour. Un
artifact manquant ou drifté renverrait plutôt l'exit `3`.

## Étape 6 — voir ce qui a atterri

Regardez ce que rigger a réellement placé sous votre sandbox :

```sh
find "$RIGGER_HOME" -type f -o -type l | sort
```

```
.../.claude/agents/demo.md
.../.claude/skills/hello-rigger
.../.config/agent-rigger/agents/demo.md
.../.config/agent-rigger/config.json
.../.config/agent-rigger/skills/hello-rigger/SKILL.md
.../.config/agent-rigger/state.json
```

On y trouve trois sortes de choses. Sous `.config/agent-rigger/skills/` et
`.config/agent-rigger/agents/` se trouve le **store** : l'unique copie réelle de chaque
artifact installé. Sous `.claude/` se trouvent les **symlinks** que l'assistant suit pour
atteindre cette copie. Et `state.json` est le [manifest](/fr/reference/glossary/#manifest) :
le relevé, par rigger, de ce qui est installé ici, à quelle version, et exactement ce que
chaque install a écrit ; le même relevé contre lequel `check` audite et que `remove` rejoue
à l'envers.

## Le chemin interactif

Vous avez tout lancé de façon non-interactive. Lancez `rigger install` sans id et,
dans un vrai terminal, rigger demande quel scope utiliser et montre à la place une liste
cochable :

```
Select installation scope:
```

```
Select artifacts to install / update (Space on a group header toggles the whole group):
```

Le parcours guidé de premier lancement, `rigger init`, est interactif lui aussi. Il demande
le catalog de votre équipe et comment s'y authentifier :

```
Enter the catalog repository URL:
```

```
Select authentication method:
```

Ces invites ne peuvent pas s'exécuter dans un script ; utilisez `catalog add` et
`install <id> --yes`, comme l'a fait ce tutoriel, pour les installations non-interactives.

## Nettoyer

Effacez tout le sandbox :

```sh
rm -rf "$RIGGER_HOME"
unset RIGGER_HOME
```

## Où aller ensuite

- Installez depuis le catalog de votre propre équipe avec le
  [guide d'installation](/fr/guides/install-from-catalog/).
- Comprenez catalog, manifest et store dans les
  [concepts fondamentaux](/fr/concepts/core-concepts/).
- Construisez votre propre catalog dans [créer un catalog](/fr/authoring/create-a-catalog/).
