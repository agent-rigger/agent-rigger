---
title: Publier un skill
description: L'entrée de catalog et la disposition de dossier pour la nature skill, ce qu'agent-rigger lit réellement dans un SKILL.md, et une boucle locale pour prouver que l'install fonctionne avant de tagger.
---

Un [skill](/fr/reference/glossary/#skill) est ce qu'un catalog distribue le plus couramment : une
capacité réutilisable au format cross-vendor `SKILL.md`. Cette page est le contrat de la
[nature](/fr/reference/glossary/#nature) `skill` : l'entrée de catalog exacte dont elle a besoin et le
dossier où elle vit, plus ce qu'une install en fait réellement.

Elle suppose que vous avez déjà un dépôt de catalog et que vous connaissez la boucle
éditer-installer-tagger. Si ce n'est pas le cas, construisez-en un d'abord dans
[créer un catalog](/fr/authoring/create-a-catalog/) ; ce tutoriel possède la mécanique générale
(dépôt git, squelette de `catalog.json`, publication d'une version). Ici vous ajoutez seulement un
skill à un catalog qui existe déjà.

## L'entrée de catalog

Un skill est une entrée [artifact](/fr/reference/glossary/#artifact) avec `nature: "skill"`. Le
catalog d'exemple en distribue exactement une, `skill:hello-rigger` :

```json title="entrée dans catalog.json"
{
  "kind": "artifact",
  "id": "skill:hello-rigger",
  "nature": "skill",
  "targets": ["claude"],
  "scopes": ["user", "project"],
  "requires": ["tool:git"]
}
```

Un skill n'utilise que les champs communs à tout artifact, plus `nature` :

| Champ      | Requis | Pour un skill                                                                                                          |
| ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `kind`     | oui    | Toujours `"artifact"`. Un skill est un artifact unique, jamais un `pack`.                                              |
| `id`       | oui    | `skill:<name>`. Le `<name>` après le préfixe est le nom du dossier et le nom du skill sur disque.                      |
| `nature`   | oui    | `"skill"`.                                                                                                             |
| `targets`  | oui    | Les [assistants](/fr/reference/glossary/#assistant) qui le reçoivent : `claude`, `opencode`, ou les deux.              |
| `scopes`   | oui    | `user`, `project`, ou les deux. Voir [scope](/fr/reference/glossary/#scope).                                           |
| `requires` | non    | Les ids d'entrées qui doivent s'installer d'abord — ici `tool:git`. Voir [requires](/fr/reference/glossary/#requires). |

Un skill que les deux assistants doivent recevoir au seul scope user, sans prérequis, est tout aussi
valide :

```json title="entrée dans catalog.json"
{
  "kind": "artifact",
  "id": "skill:commit-style",
  "nature": "skill",
  "targets": ["claude", "opencode"],
  "scopes": ["user"]
}
```

Les champs artifact propres aux autres natures (`level`, `check`, `install`, `event`, `matcher`,
`timeout`, `config`, `secrets`) n'ont aucun sens sur une entrée skill. Le parser les accepte s'ils
sont présents et le handler skill les ignore ; ne les ajoutez pas. Les règles complètes, champ par
champ, sont dans le [schéma de catalog.json](/fr/reference/catalog-schema/).

## Le dossier dans votre catalog

L'entrée déclare le skill ; son contenu vit à un chemin conventionnel dérivé de l'id. Pour
`skill:hello-rigger`, c'est `skills/hello-rigger/SKILL.md` :

```
skills/
└── hello-rigger/
    └── SKILL.md
```

Le nom du dossier doit correspondre au `<name>` de l'id : agent-rigger retire le préfixe `skill:` de
l'id et cherche `skills/<name>/`. **Tout** le répertoire `skills/<name>/` est le skill : les fichiers
ou sous-dossiers supplémentaires qu'il contient (par exemple un dossier `scripts/`) sont copiés avec
lui. La [référence de disposition du catalog](/fr/reference/catalog-layout/) donne le chemin et
l'[allowlist de nommage](/fr/reference/catalog-layout/#allowlist-de-nommage) à laquelle obéit chaque
nature.

`SKILL.md` s'ouvre sur un bloc de [frontmatter](/fr/reference/glossary/#frontmatter)
[agentskills.io](/fr/reference/glossary/#agentskillsio) : un `name`, une `description`, et les champs
optionnels que le standard autorise. Des instructions en Markdown simple suivent :

```md title="skills/hello-rigger/SKILL.md"
---
name: hello-rigger
description: A demo skill distributed via the agent-rigger example catalog.
license: MIT
---

# Hello Rigger

This skill was installed from the example catalog. It exists to prove the
end-to-end flow: clone → store → symlink → manifest.
```

Notez ce qu'agent-rigger **ne** fait **pas** ici : il ne parse ni ne valide ce frontmatter. Le
contrat `name`/`description` relève du standard agentskills.io et est lu par l'assistant à
l'exécution, pas par l'outil. Ce qu'agent-rigger lit d'un skill est plus étroit : il dérive le nom du
skill depuis l'id de l'entrée, vérifie que ce nom est sûr pour le système de fichiers (l'allowlist de
nommage), [scanne](/fr/concepts/trust-and-security/) le répertoire source, puis copie le répertoire
tel quel. Votre `SKILL.md` est pour lui une charge utile opaque. Un frontmatter erroné n'empêche pas
l'install de réussir. Un skill malformé se voit dans l'assistant, pas ici — validez le format contre
agentskills.io vous-même.

## Ce que produit une install

Pour `claude` comme pour `opencode`, un skill s'installe de la même façon : le répertoire est copié
une fois dans un [store](/fr/reference/glossary/#store) managé sous
`~/.config/agent-rigger/skills/<name>`, et un [symlink](/fr/reference/glossary/#symlink) à chaque
cible pointe vers lui. Une seule copie physique, partagée entre tous les assistants et scopes ciblés.
Le chemin cible exact par assistant et par scope est la ligne `skill` de la
[matrice des natures](/fr/reference/natures-matrix/#skill) : le contrat sur disque des huit natures.

## Testez-le avant de tagger

Prouvez que le skill s'installe avant de publier une release. Installer écrit dans un répertoire
home, pointez donc l'outil vers un jetable et installez votre dossier de catalog directement depuis
le disque. `install` lit un chemin local directement comme une
[source ad-hoc](/fr/guides/ad-hoc-install/), sans étape `catalog add`. Seul le push vers un remote
est sauté.

`install` récupère quand même via git, même pour un chemin local : il clone ce qui se trouve à
`HEAD`, jamais votre working tree. Committez le skill que vous venez d'ajouter (le dossier
`skills/<name>/` et son entrée dans `catalog.json`) avant d'installer, sinon le plan l'omet
silencieusement : aucune erreur, aucun avertissement, exit `0`, le reste du catalog s'installe comme
si le nouveau skill n'avait jamais été ajouté.

Travaillez avec un [`RIGGER_HOME`](/fr/reference/glossary/#rigger_home) jetable, pour qu'une seule
suppression défasse tout :

```sh
export RIGGER_HOME="$(mktemp -d)"
export NO_COLOR=1
```

Installez ensuite le dossier de catalog par son chemin. Dans un shell non-interactif, `--yes` est
requis et sélectionne toutes les entrées que la source propose. Sans lui, l'exécution sort en `2`
avant de toucher le réseau :

```sh
agent-rigger install /path/to/your-catalog --yes
```

```
--- Plan ---
Plan · 1 change · scope: user (~/.claude)

+ local-your-catalog/skill:hello-rigger   ~/.claude/skills/hello-rigger
  link  ~/.claude/skills/hello-rigger → store

Σ  1 link

--- Result ---
  [ok] Applied 1 file(s).
    + /tmp/tmp.CfIr3e/.claude/skills/hello-rigger
```

Le **Plan** prévisualise le lien ; **Result** montre l'écriture atterrissant dans votre home jetable,
pas votre vrai `~/.claude`. Le chemin absolu reflète ce vers quoi `RIGGER_HOME` a résolu, le vôtre
diffère donc. Le préfixe `local-your-catalog/` est de la
[provenance](/fr/guides/ad-hoc-install/#le-préfixe-de-provenance) : une install ad-hoc dérive un
préfixe d'id depuis la source plutôt que d'un nom de catalog enregistré. Effacez le sandbox une fois
terminé :

```sh
rm -rf "$RIGGER_HOME"
unset RIGGER_HOME
```

Une fois que le skill s'installe proprement, committez-le et publiez une version comme le montre
[créer un catalog](/fr/authoring/create-a-catalog/#étape-5--publier-une-version). Un skill n'est réel
pour votre équipe qu'une fois devenu une release taggée.

## Les autres natures

Cette page couvre uniquement la nature `skill`. Chacune des huit natures a son propre contrat sur
disque ; la carte complète, par assistant et par scope, est la
[matrice des natures](/fr/reference/natures-matrix/). Deux n'ont pas encore leur page : `mcp` et
`tool`. `mcp` installe un serveur MCP déclaré ; une page dédiée arrive. La vérification de présence
de `tool` fonctionne aujourd'hui, mais son install depuis les indications d'install par gestionnaire
de paquets n'est pas encore livrée.
