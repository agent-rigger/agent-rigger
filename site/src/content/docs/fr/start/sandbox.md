---
title: Essayez-le dans un sandbox
description: "Pilotez rigger contre des répertoires jetables sous /tmp pour que rien de ce qu'il fait ne puisse atteindre votre vraie config ou vos vrais projets. Sourcez le sandbox, lancez une vraie commande, réinitialisez à un état vierge, puis démontez le tout."
---

Un assistant de code IA se configure via des fichiers sur votre machine, et un outil qui
modifie ces fichiers demande une certaine confiance dès la première exécution. Ce tutoriel
vous donne un moyen d'obtenir cette confiance à moindre coût : un terrain de jeu jetable où
chaque changement de rigger atterrit dans des répertoires temporaires sous `/tmp`, si bien
que votre vraie configuration et vos vrais projets ne sont jamais lus ni écrits. Une fois
terminé, vous supprimez les répertoires jetables, et votre machine se retrouve exactement
comme avant que vous ne commenciez.

Le sandbox est un petit script, `scripts/sandbox`, livré dans le dépôt. Il redirige les
emplacements de lecture et d'écriture de rigger, et lance une vraie commande. Puis il fait
le ménage derrière lui. À la fin, vous aurez ajouté un [catalog](/fr/reference/glossary/#catalog),
vu l'outil ne toucher que son foyer temporaire, réinitialisé à un état vierge, et démonté le
tout en un mot.

## Avant de commencer

Il vous faut l'une de ces deux choses :

- un checkout du dépôt (`git clone` : voir [installation](/fr/start/installation/#depuis-les-sources)),
  là où vit `scripts/sandbox`, ou
- un `agent-rigger` installé sur votre `PATH` plus le checkout du dépôt pour le script
  lui-même.

Il vous faut aussi `git`, parce que le catalog d'exemple est un dépôt git que l'outil
récupère. Le sandbox lui-même ne change rien à votre assistant ; il isole seulement les
emplacements où rigger travaille.

Les sorties montrées ci-dessous fixent `NO_COLOR=1` pour un copier-coller lisible ; sur un
vrai terminal, l'outil ajoute de la couleur. Chaque chemin `/tmp` ici se termine par un
suffixe aléatoire qui **différera sur votre machine** : `mktemp` en choisit un nouveau à
chaque exécution.

## Étape 1 — sourcer le sandbox

Depuis l'intérieur du dépôt, **sourcez** le script dans votre shell courant :

```sh
source scripts/sandbox
```

```
[sandbox] binary      : /path/to/agent-rigger/packages/cli/dist/agent-rigger  (local build)
[sandbox] RIGGER_HOME : /tmp/rigger-sandbox.LXrT3e  (user-scope writes isolated here)
[sandbox] project dir : /tmp/rigger-sandbox-project.xtywZi  (now your cwd — project-scope writes isolated here)
[sandbox] ready — use:  rigger <command>     (reset: rigger_reset · quit: rigger_exit)
[sandbox] try:          rigger catalog add example "$RIGGER_EXAMPLE_CATALOG"
```

Quatre choses viennent de se produire :

- Le script a choisi un binaire et vous a dit lequel. Il préfère un
  `packages/cli/dist/agent-rigger` construit localement ; si vous êtes dans le dépôt sans
  en avoir un, il le construit avec `bun run build` ; à défaut, il retombe sur un
  `agent-rigger` installé sur votre `PATH`, affichant `(installed — PATH/Homebrew)` à la
  place. La bannière nomme donc toujours le binaire exact que vous vous apprêtez à
  exercer.
- Il a créé un répertoire home jetable et exporté son chemin en tant que
  [`RIGGER_HOME`](/fr/reference/glossary/#rigger_home). Cette variable remplace le
  répertoire home qu'utilise rigger pour chaque chemin de scope user, si bien que les
  écritures à l'échelle machine atterrissent sous `/tmp` au lieu de vos vrais `~/.claude`
  et `~/.config`.
- Il a créé un répertoire de projet jetable et vous y a `cd`é, si bien que les écritures de
  [scope projet](/fr/reference/glossary/#scope), qui ciblent le répertoire de travail
  courant, sont contenues elles aussi. Entre les deux, les deux scopes sont couverts.
- Il a lié une fonction shell `rigger` à ce binaire. À partir d'ici, un simple `rigger …`
  lance l'outil sandboxé.

## Étape 2 — lancer une vraie commande

Vous pilotez maintenant le vrai outil, seulement pointé vers des répertoires jetables.
Demandez à [`doctor`](/fr/reference/glossary/#doctor) ce qu'il voit :

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

`mode : full scan` signifie qu'un scanner (gitleaks ou trivy) est présent, si bien que le
contenu récupéré sera contrôlé avant d'être écrit. Sans l'un ni l'autre, vous verriez
`warn-only` ici à la place : l'outil fonctionne quand même, mais le contenu n'est pas
scanné. Rien n'est installé dans ce home neuf, donc l'état est sain.

## Étape 3 — prouver que rien n'a fui

Ajoutez le catalog d'exemple public. Le sandbox a déjà exporté son URL en tant que
`RIGGER_EXAMPLE_CATALOG`, vous pouvez donc coller la ligne suggérée par la bannière :

```sh
rigger catalog add example "$RIGGER_EXAMPLE_CATALOG"
```

```
catalog "example" added (https://github.com/agent-rigger/agent-rigger-catalog-example.git)
```

Cette seule ligne est ce qui s'affiche quand la sortie de la commande est piped, ce qui est
la façon dont elle a été capturée pour cette page. Sur un vrai terminal, `stdout` est un
TTY, si bien que la même commande continue au-delà vers un sélecteur interactif,
`Select artifacts to install (required items are always included):`, et attend votre
choix. Le sélecteur ne change rien à l'écriture que vous allez vérifier ci-dessous : appuyez
sur Ctrl-C là et la source du catalog reste enregistrée, parce que cette écriture s'est
déjà produite avant que le sélecteur ne s'ouvre.

Cette commande a enregistré une source de catalog dans la config de rigger : une vraie
écriture. Regardez maintenant chaque fichier que cette écriture a produit sous le home du
sandbox :

```sh
find "$RIGGER_HOME" -type f | sort
```

```
/tmp/rigger-sandbox.LXrT3e/.config/agent-rigger/config.json
```

Un fichier, et il est sous `/tmp`. Votre vrai `~/.config/agent-rigger` n'a jamais été
ouvert. C'est tout l'intérêt : vous avez lancé une commande authentique, qui change l'état,
et elle est restée à l'intérieur du répertoire jetable.

À partir de là vous pourriez ajouter des artifacts exactement comme le fait le
[parcours premiers pas](/fr/start/getting-started/) : `rigger ls`,
`rigger install <id> --yes`, `rigger check`, et chacun n'écrirait que sous `RIGGER_HOME`.
Cette page s'arrête ici parce que son sujet est le sandbox, pas le rig.

## Étape 4 — réinitialiser à un état vierge

Pour recommencer sans repartir de zéro, appelez `rigger_reset`. Il efface le home et le
répertoire de projet courants et en crée des neufs, vides :

```sh
rigger_reset
```

```
[reset] removed old RIGGER_HOME: /tmp/rigger-sandbox.LXrT3e
[reset] fresh RIGGER_HOME: /tmp/rigger-sandbox.momRSF
[reset] removed old project dir: /tmp/rigger-sandbox-project.xtywZi
[reset] fresh project dir: /tmp/rigger-sandbox-project.fhnRg7  (now your cwd)
```

Le catalog que vous avez ajouté a disparu ; `rigger doctor` rapporterait à nouveau un état
vide et sain. Réinitialisez aussi souvent que vous voulez pour comparer l'effet d'une
commande depuis un départ propre.

## Étape 5 — tout démonter

Une fois terminé, `rigger_exit` ramène votre shell exactement là où il était :

```sh
rigger_exit
```

```
[sandbox] cleaned up — back in /path/to/agent-rigger
```

`rigger_exit` fait trois choses :

- il vous `cd` de retour au répertoire depuis lequel vous avez sourcé
- il supprime les deux répertoires jetables
- il désassigne les variables du sandbox et les fonctions `rigger`, `rigger_reset` et
  `rigger_exit`

Ensuite, `RIGGER_HOME` est désassigné et un simple `rigger` résout vers ce qui était sur
votre `PATH` avant (un binaire installé, si vous en avez un) : l'état de shell que vous
aviez au départ. Si vous préférez sortir mais garder les répertoires pour plus tard,
`cd "$RIGGER_SANDBOX_ORIGIN"` à la place. Dans tous les cas, rien ne force les répertoires
jetables à disparaître d'eux-mêmes. La politique de nettoyage de `/tmp` dépend de l'OS : sur
macOS, par exemple, il n'est pas vidé à chaque redémarrage, seulement purgé
périodiquement. Supprimez-les vous-même avec `rm -rf` si vous voulez qu'ils disparaissent
pour de bon.

## Pourquoi vous le sourcez, et ne l'exécutez jamais

Le script ne fonctionne que parce qu'il modifie **votre shell courant**. Il exporte des
variables, définit les fonctions `rigger`, `rigger_reset` et `rigger_exit`, et vous `cd`
dans le répertoire de projet. Un script exécuté tourne dans un processus enfant dont
l'environnement et le répertoire de travail disparaissent au moment où il se termine, si
bien que rien de tout cela ne vous atteindrait. Sourcer exécute les lignes dans votre
propre shell, ce qui est tout l'intérêt.

Deux choses vous empêchent de vous tromper ici. D'abord, le fichier lui-même ne porte
aucun bit exécutable, si bien que votre shell refuse carrément de le lancer comme une
commande :

```sh
./scripts/sandbox
```

```
bash: ./scripts/sandbox: Permission denied
```

Cela seul arrête la commande brute ci-dessus (exit code 126, avant même que le propre code
du script ne s'exécute). Si vous forcez le passage par un interpréteur, par exemple
`bash scripts/sandbox`, le garde-fou du script vous rattrape aussi :

```sh
bash scripts/sandbox
```

```
Error: source me, do not execute:
  source scripts/sandbox
```

Dans les deux cas, il sort en non-zéro et ne fait rien. Sourcez-le, et il procède.

## Ce que le sandbox isole et n'isole pas

L'isolation porte sur les **fichiers**, et elle est complète pour les fichiers : les
écritures de scope user vont vers le `RIGGER_HOME` jetable, les écritures de scope projet
vont vers le répertoire de projet jetable dans lequel vous êtes `cd`é, et le `rm -rf` de
reset et de exit est gardé pour ne jamais supprimer que des chemins sous les préfixes
`/tmp/rigger-sandbox*` attendus.

Ce n'est pas un sandbox au niveau du système d'exploitation. Ajouter un catalog appelle
toujours le réseau pour récupérer un vrai dépôt git, et l'outil lance toujours les vrais
scanners sur votre machine. Ce que le sandbox garantit, c'est que votre vraie configuration
et vos vrais répertoires de projet ne sont ni lus ni écrits. Cela ne veut pas dire que
rigger est coupé du monde extérieur.

Une note pratique : certaines commandes sont interactives et ont besoin d'un vrai
terminal. `rigger install` sans ids, et l'assistant `rigger init`, demandent une saisie ;
dans un shell [non-interactive](/fr/reference/glossary/#tty--non-interactive), ils ne
peuvent pas l'obtenir. Quand vous voulez une exécution scriptée, sans invite, à l'intérieur
du sandbox, passez des ids explicites et `--yes`, comme le fait le tutoriel premiers pas.
`catalog add` (étape 3) est interactif de la même façon : sur un vrai terminal, il ouvre le
sélecteur d'artifacts décrit là-bas, et aucun flag ne le saute ; seul un `stdout`
non-interactive (un pipe, un script) le contourne.

## Où aller ensuite

- [Parcourez votre premier rig](/fr/start/getting-started/) : installez et auditez un pack,
  toujours dans un home isolé.
- [Installez agent-rigger](/fr/start/installation/) proprement, pour un usage réel.
- Lisez [à quoi sert agent-rigger](/fr/start/what-is-agent-rigger/) avant de vous y engager.
