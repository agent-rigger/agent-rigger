---
title: Créer un catalog
description: Construisez votre premier catalog à partir de zéro (un dépôt git, un catalog.json minimal, un skill), installez-le sur votre propre poste depuis un chemin local, puis publiez une release versionnée.
---

Un catalog est la liste partagée de ce que votre équipe installe dans ses assistants de code IA :
quels skills existent et comment chacun s'installe. Il vit dans son propre dépôt git ; enseigner une
nouvelle habitude à votre équipe devient donc un commit et un tag plutôt qu'un message sur Slack.

Ce tutoriel en construit un à partir de rien. Vous allez créer le dépôt avec ses deux fichiers, puis
installer votre propre skill sur votre poste directement depuis un dossier local. Cette boucle
locale, c'est le quotidien des auteurs de catalog : aucun push vers un remote, juste éditer et
installer. À la fin, vous publiez une version et voyez l'outil la prendre en compte.

Il vous faut agent-rigger [installé](/fr/start/installation/) et `git` sur votre poste. Des notions
de base en Markdown et JSON suffisent ; aucune connaissance préalable du fonctionnement interne de
l'outil n'est supposée.

## Travailler dans un sandbox jetable

Installer écrit de vrais fichiers dans un répertoire home. Pour que cette étape reste entièrement
réversible, pointez l'outil vers un home jetable avec
[`RIGGER_HOME`](/fr/reference/glossary/#rigger_home), la seule variable d'environnement qui redéfinit
l'emplacement de tous les chemins de scope user :

```sh
export RIGGER_HOME="$(mktemp -d)"
export NO_COLOR=1
```

Désormais chaque install atterrit sous ce répertoire temporaire au lieu de votre vrai `~/.claude`. Un
seul `rm -rf` à la fin l'efface. `NO_COLOR=1` garde simplement la sortie copiée-collée sans mise en
forme ; un vrai terminal ajoute de la couleur. Le dépôt de catalog que vous vous apprêtez à créer est
un dossier normal que vous conservez. Seule la _cible_ d'installation est isolée dans le sandbox.

Les chemins absolus affichés dans les sorties ci-dessous reflètent les valeurs vers lesquelles
`RIGGER_HOME` et votre dossier de travail ont été résolus. Les vôtres seront différents.

## Étape 1 — créer le dépôt

Un catalog est un dépôt git. Créez-en un vide :

```sh
mkdir my-first-catalog
cd my-first-catalog
git init
```

```
Initialized empty Git repository in /home/you/my-first-catalog/.git/
```

Voilà tout le conteneur. Le reste tient en deux fichiers à l'intérieur.

## Étape 2 — écrire catalog.json

[`catalog.json`](/fr/reference/glossary/#catalogjson) se trouve à la racine du dépôt et c'est le seul
fichier que l'outil lit pour savoir ce que votre catalog propose. Il a deux parties : un en-tête
`meta` qui nomme le catalog, et une liste `entries` de choses installables. Écrivez la plus petite
version valide, une entrée [skill](/fr/reference/glossary/#skill) :

```sh "myteam"
cat > catalog.json <<'JSON'
{
  "meta": {
    "name": "myteam"
  },
  "entries": [
    {
      "kind": "artifact",
      "id": "skill:commit-style",
      "nature": "skill",
      "targets": ["claude"],
      "scopes": ["user"]
    }
  ]
}
JSON
```

Chaque champ est porteur de sens. `meta.name` est le nom déclaré du catalog ; par convention vous
enregistrez le catalog sous ce même nom à l'étape 4, et c'est ce nom enregistré, non `meta.name`
lui-même, qui devient le préfixe de chaque id. L'entrée dit : voici un
[artifact](/fr/reference/glossary/#artifact) installable (`kind`), de
[nature](/fr/reference/glossary/#nature) `skill`, qui cible l'[assistant](/fr/reference/glossary/#assistant)
`claude` et s'installe au scope [`user`](/fr/reference/glossary/#scope). L'id, `skill:commit-style`,
suit la forme `<nature>:<name>`. Chaque champ, ainsi que les champs optionnels que cette entrée omet,
est listé dans la [référence du schéma de catalog](/fr/reference/catalog-schema/).

## Étape 3 — ajouter le skill

L'entrée ci-dessus déclare un skill nommé `commit-style`. Son contenu vit à un chemin conventionnel :
`skills/<name>/SKILL.md`. Le fichier s'ouvre sur un bloc de
[frontmatter](/fr/reference/glossary/#frontmatter) [agentskills.io](/fr/reference/glossary/#agentskillsio)
portant un `name` et une `description`, puis des instructions en Markdown simple :

````sh
mkdir -p skills/commit-style
cat > skills/commit-style/SKILL.md <<'MD'
---
name: commit-style
description: Write commit messages in our team's convention. Conventional Commits, imperative subject under 50 characters, body explaining why.
---

# Commit style

When you write a commit message, follow the team's convention.

- **Subject**: `<type>(<scope>): <summary>`, imperative mood, no trailing
  period, under 50 characters. Types: `feat`, `fix`, `docs`, `refactor`,
  `test`, `chore`.
- **Body**: wrap at 72 characters. Explain *why* the change was made, not what
  changed. The diff already shows what.
- **One logical change per commit.** Split unrelated edits.

Example:

```
fix(auth): reject expired refresh tokens

A stale token slipped past the guard because the clock check
compared seconds against milliseconds. Normalise both to ms.
```
MD
````

Le chemin `skills/commit-style/` correspond au `commit-style` de l'id de votre entrée. La
[référence de disposition du catalog](/fr/reference/catalog-layout/) donne le chemin conventionnel de
chaque nature.

## Étape 4 — l'installer depuis un chemin local

Voici la boucle dans laquelle vous passerez l'essentiel de votre temps d'auteur. L'outil lit les
catalogs via git, si bien que vos fichiers de travail lui restent invisibles tant que vous ne les
avez pas committés. Committez d'abord :

```sh
git add .
git commit -m "feat: first catalog with commit-style skill"
```

```
[main (root-commit) a51008b] feat: first catalog with commit-style skill
 2 files changed, 38 insertions(+)
 create mode 100644 catalog.json
 create mode 100644 skills/commit-style/SKILL.md
```

Enregistrez maintenant le catalog sous un nom local, en pointant vers son dossier avec un chemin
absolu. Un chemin local est une source valide, exactement comme une URL git distante, et il vous épargne
tout aller-retour réseau pendant que vous itérez :

```sh
agent-rigger catalog add myteam "$(pwd)"
```

```
catalog "myteam" added (/home/you/my-first-catalog)
```

Listez ce que le catalog propose désormais :

```sh
agent-rigger ls
```

```
Catalog (1 entry):
  [available]  myteam/skill:commit-style  skill
```

Votre skill apparaît, son id [qualifié](/fr/reference/glossary/#qualified-id) du nom du catalog :
`myteam/skill:commit-style`. Le préfixe `myteam/` est le nom local sous lequel vous venez
d'enregistrer le catalog (`catalog add myteam …`) ; il coïncide ici avec `meta.name` uniquement parce
que vous avez employé le même mot pour les deux, comme le recommande la convention. `[available]`
signifie qu'il est connu mais pas encore installé. Installez-le, en acceptant le plan sans invite :

```sh
agent-rigger install myteam/skill:commit-style --yes
```

```
--- Plan ---
Plan · 1 change · scope: user (~/.claude)

+ myteam/skill:commit-style   ~/.claude/skills/commit-style
  link  ~/.claude/skills/commit-style → store

Σ  1 link

--- Result ---
  [ok] Applied 1 file(s).
    + /tmp/tmp.aB3kZ9pQ7r/.claude/skills/commit-style
```

Le bloc **Plan** prévisualise le changement avant qu'il ne se produise ; **Result** montre ce qui a
été écrit. Remarquez que les deux chemins diffèrent : le Plan liste l'emplacement logique de scope
user (`~/.claude/…`), tandis que le Result montre où `RIGGER_HOME` a effectivement redirigé
l'écriture : votre sandbox jetable, pas votre vrai home. Votre skill s'est installé comme un lien
vers un [store](/fr/reference/glossary/#store) managé, le mécanisme même qu'utilise chaque skill
installé. Vérifiez que l'install est saine :

```sh
agent-rigger check
```

```
--- Catalogs ---
  [up-to-date]   myteam  (9f2c1ab8e7d4c05b3a61f8e29d7c4b0a5e13f6d2)
```

Cette chaîne hexadécimale de 40 caractères est le commit exact vers lequel `check` a résolu votre
catalog. Vous n'avez pas encore taggé de version, l'outil se rabat donc sur le sha de commit complet.
L'étape suivante lui donne une vraie version à résoudre à la place.

:::caution[Committez avant d'installer]
Lancez `ls` sur un catalog sans aucun commit et l'outil ne peut pas le lire :

```
[warning] Catalog "myteam" (/home/you/my-first-catalog) unavailable (HEAD not found: ls-remote HEAD returned empty output). Check the URL or run `agent-rigger init`.
```

Un dépôt vide n'a rien à récupérer. Un seul commit règle le problème.
:::

## Étape 5 — publier une version

Les équipes devraient installer une version nommée, pas un commit mouvant. Taggez-en une :

```sh
git tag -a v0.1.0 -m "v0.1.0"
```

L'outil résout un catalog vers son [tag](/fr/reference/glossary/#tag)
[semver](/fr/reference/glossary/#semver) le plus élevé. Faites basculer votre install sur ce tag et
revérifiez :

```sh
agent-rigger update --yes
```

```
[up-to-date]  myteam/skill:commit-style  (v0.1.0)
```

`[up-to-date]`, pas `[updated]` : le tag pointe vers le commit même que vous avez déjà installé,
aucun contenu ne change donc ; seul le label vers lequel l'outil résout le catalog passe d'un sha
brut à `v0.1.0`. Le prochain `check` en est la vraie preuve :

```sh
agent-rigger check
```

```
--- Catalogs ---
  [up-to-date]   myteam  (v0.1.0)
```

Là où `check` affichait un commit brut auparavant, il affiche maintenant `v0.1.0`. Votre catalog a
une release que toute l'équipe peut épingler.

## Étape 6 — le recommander par défaut

Un catalog peut orienter ses membres vers les bons choix. Lister un id dans
[`meta.recommended`](/fr/reference/glossary/#recommended) le pré-coche dans le sélecteur de
proposition qu'un coéquipier voit la première fois qu'il branche votre catalog : quand il lance
`agent-rigger init` ou `agent-rigger catalog add`. L'id arrive déjà sélectionné, et il peut toujours
le décocher. Ajoutez le champ, puis committez et taggez une nouvelle release :

```sh ins={5}
cat > catalog.json <<'JSON'
{
  "meta": {
    "name": "myteam",
    "recommended": ["skill:commit-style"]
  },
  "entries": [
    {
      "kind": "artifact",
      "id": "skill:commit-style",
      "nature": "skill",
      "targets": ["claude"],
      "scopes": ["user"]
    }
  ]
}
JSON
git add .
git commit -m "feat: recommend commit-style by default"
git tag -a v0.1.1 -m "v0.1.1"
```

Le changement n'est réel pour l'équipe qu'une fois publié en release. Lancez `update`, et
regardez l'outil dépasser `v0.1.0` pour aller au tag supérieur :

```sh
agent-rigger update --yes
```

```
--- Update ---
  [updated]     myteam/skill:commit-style  → v0.1.1
```

Ce simple `→ v0.1.1` est la règle du tag le plus élevé en action, et c'est tout ce que cette étape
affiche sur votre poste : la recommandation elle-même ne fait surface que plus tard, quand quelqu'un
d'autre ajoute votre catalog pour la première fois. Là, `init` et `catalog add` ouvrent un sélecteur
de proposition avec votre skill recommandé déjà coché, sous cette invite :

```
Select artifacts to install (required items are always included):
```

Les ids recommandés arrivent cochés, et le coéquipier reste libre de les décocher ; les ids listés sous `required`
(ce catalog n'en déclare aucun) ne peuvent pas être décochés. Lancer l'une ou l'autre commande avec
`--yes` saute entièrement le sélecteur et installe les required plus les recommended sans rien
demander. L'opinion atteint aussi `agent-rigger install` tout court : son sélecteur différent, fondé
sur le statut, pré-coche uniquement `required` plus `recommended` dans le groupe « À installer » dès
qu'un catalog en déclare, laissant le reste de ce groupe listé mais décoché ; un catalog sans opinion
garde tout le groupe pré-coché, comme avant. La forme complète de `meta` est dans la
[référence du schéma de catalog](/fr/reference/catalog-schema/).

## Nettoyer

Effacez la cible d'installation isolée dans le sandbox. Votre dépôt de catalog reste là où vous
l'avez créé :

```sh
rm -rf "$RIGGER_HOME"
unset RIGGER_HOME
```

## Pour aller plus loin

Vous avez maintenant un catalog versionné avec un skill recommandé. Pour le mettre entre les mains de
votre équipe, poussez le dépôt vers un hébergeur git. L'URL vers laquelle vous poussez est exactement
ce qu'un coéquipier passe à `agent-rigger init` ou `agent-rigger catalog add <name> <url>` : le
chemin local que vous avez utilisé ici devient une URL distante, et rien d'autre ne change.

- La forme complète, champ par champ, de `catalog.json` (packs, tools et entrées mcp compris) est
  dans la [référence du schéma de catalog](/fr/reference/catalog-schema/).
- Le chemin de fichier conventionnel de chaque nature est dans la
  [référence de disposition du catalog](/fr/reference/catalog-layout/).
- Pour savoir pourquoi l'outil sépare un catalog, un store et un
  [manifest](/fr/reference/glossary/#manifest) en trois, lisez les
  [concepts fondamentaux](/fr/concepts/core-concepts/).
