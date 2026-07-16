---
title: "Déclarer une dépendance à un tool"
description: "L'entrée de catalog pour la nature tool : un programme du système hôte qu'agent-rigger vérifie mais n'installe jamais : sa commande check, le consent qui conditionne son exécution, present/absent/unverified, et pourquoi les indications d'install sont déclarées mais pas encore consommées."
---

Un [tool](/fr/reference/glossary/#tool) est l'unique [nature](/fr/reference/glossary/#nature) qui
exécute le contrat à l'envers. Chaque autre nature se termine par quelque chose d'installé sur votre
poste : un fichier écrit, ou une install déléguée à l'assistant. Un tool est un programme qu'agent-rigger
s'attend à trouver déjà là : `jq`, `gh`, `terraform`, une dépendance du système hôte qu'il n'installe
jamais. Son entrée est une affirmation à vérifier : la commande est-elle présente ou non ? Cette page
est le contrat de cette entrée : les champs qu'elle porte, la commande shell `check` derrière elle, et
la porte de consent qui se dresse entre le catalog et votre shell.

Elle suppose que vous avez déjà un dépôt de catalog et que vous connaissez la boucle
éditer-installer-tagger. Si ce n'est pas le cas, construisez-en un d'abord dans
[créer un catalog](/fr/authoring/create-a-catalog/) ; ce tutoriel possède la mécanique générale
(dépôt git, squelette de `catalog.json`, publication d'une version). Ici vous ajoutez seulement un
tool à un catalog qui existe déjà.

## L'entrée de catalog

Un tool est une entrée [artifact](/fr/reference/glossary/#artifact) avec `nature: "tool"`. Au-delà
des champs que tout artifact partage, il en utilise trois qui lui sont propres : `level`, `check`, et
`install`. Une dépendance `jq`, recommended plutôt qu'obligatoire, vérifiée en demandant au binaire
sa version, ressemble à ceci :

```json title="entry in catalog.json"
{
  "kind": "artifact",
  "id": "tool:jq",
  "nature": "tool",
  "targets": ["claude", "opencode"],
  "scopes": ["user"],
  "level": "recommended",
  "check": "jq --version",
  "install": {
    "brew": "jq",
    "mise": "jq"
  }
}
```

Champ par champ :

| Champ      | Requis | Pour une entrée tool                                                                                                                                                                    |
| ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`     | oui    | Toujours `"artifact"`. Un tool est un artifact unique, jamais un `pack`.                                                                                                                |
| `id`       | oui    | `tool:<name>`. Le `<name>` après le préfixe est un simple label ; un tool n'a ni dossier ni nom sur disque à faire correspondre.                                                        |
| `nature`   | oui    | `"tool"`.                                                                                                                                                                               |
| `targets`  | oui    | Les [assistants](/fr/reference/glossary/#assistant) dont l'install doit vérifier le tool : `claude`, `opencode`, ou les deux.                                                           |
| `scopes`   | oui    | `user`, `project`, ou les deux. Voir [scope](/fr/reference/glossary/#scope).                                                                                                            |
| `level`    | non    | `"required"` ou `"recommended"`. Un indice d'importance advisory ; il ne change jamais si une install se poursuit (voir ci-dessous). Omis, un tool absent n'est signalé nulle part.     |
| `check`    | non    | Une commande shell qui détecte le tool. Exit `0` signifie présent, non-zéro signifie absent. Ici, `jq --version`.                                                                       |
| `install`  | non    | Des indications de gestionnaire de paquets (`brew` / `npm` / `pnpm` / `mise`). Déclarées aujourd'hui, pas encore consommées (voir ci-dessous).                                          |
| `requires` | non    | Les ids d'entrées qui doivent s'installer d'abord. Un tool est plus souvent la cible du `requires` d'une autre entrée que sa source. Voir [requires](/fr/reference/glossary/#requires). |

Un tool que les deux assistants doivent vérifier, marqué comme une exigence dure et détecté par une
simple recherche, est tout aussi valide :

```json title="entry in catalog.json"
{
  "kind": "artifact",
  "id": "tool:gh",
  "nature": "tool",
  "targets": ["claude", "opencode"],
  "scopes": ["user", "project"],
  "level": "required",
  "check": "gh --version",
  "install": { "brew": "gh" }
}
```

Les champs artifact propres aux autres natures (`event`, `matcher`, `timeout`, `config`, `secrets`)
n'ont aucun sens sur une entrée tool. Le parser les accepte s'ils sont présents et le chemin tool les
ignore ; ne les ajoutez pas. Les règles complètes, champ par champ, sont dans le
[schéma de catalog.json](/fr/reference/catalog-schema/#entrées-artifact).

Un tool sans `check` est accepté mais ne fait rien : il n'y a aucun fichier à installer ni aucune
commande à lancer, l'entrée est donc inerte. Le `check` est ce qui rend une entrée tool digne d'être
déclarée.

## Le check à l'œuvre

Un tool n'est [jamais installé par aucun adapter](/fr/reference/natures-matrix/#tool--advisory-uniquement),
pour aucun assistant ni aucun scope. Il ne contribue aucune ligne de changement à un plan et n'écrit
rien sur disque. Ce qu'il contribue, c'est une vérification de présence, et cette vérification est une
commande shell qu'un auteur a écrite dans le catalog, donc agent-rigger la traite comme du
[contenu untrusted](/fr/reference/glossary/#untrusted-content) et la protège avec deux portes
distinctes.

La première porte est le plan lui-même. La commande `check` brute de chaque tool présent dans la
sélection est imprimée dans le plan, sous son propre titre, **avant** que vous ne confirmiez quoi que
ce soit, si bien qu'une commande que vous êtes sur le point de lancer est une commande que vous
pouvez d'abord lire :

```
--- Tool presence-checks (run after you confirm) ---
  myteam/tool:jq  →  jq --version
```

La seconde porte est le [consent](/fr/reference/glossary/#consent) de vraiment la lancer. Confirmer
le plan n'est pas un consent à exécuter une commande `check` : cette approbation est demandée par
commande, après la confirmation, et seulement pour les tools de la sélection. Une fois accordé, il
est mémorisé, si bien qu'une commande déjà approuvée n'est pas redemandée. Accepter le plan
non-interactivement avec `--yes` emporte ce consent implicitement : le plan listait déjà chaque
commande, donc pré-accepter le plan les pré-accepte aussi.

Lancer un check produit l'un de trois états, et la différence entre deux d'entre eux est tout
l'enjeu :

- **`present`** : la commande a renvoyé l'exit code `0`. Le tool est là.
- **`absent`** : la commande a renvoyé un exit code non-zéro. Le tool est vérifiablement absent.
- **`unverified`** : la commande ne s'est jamais lancée, parce que le consent de la lancer a été
  refusé. La présence est simplement inconnue. Ce n'est **pas** la même chose qu'absent :
  agent-rigger n'a pas constaté l'absence du tool, il n'a jamais regardé.

Quel que soit le résultat, le check est advisory et ne bloque jamais. Un tool `required` ou
`recommended` manquant est signalé après que l'install s'est terminée, pas avant qu'elle démarre ;
l'install de tout le reste se poursuit malgré tout. Un tool `unverified` est listé à part et, sa
présence étant inconnue, n'est même pas compté parmi les manquants : décliner un check ne cache rien
et ne fait rien échouer, cela laisse simplement la question ouverte. Aucun `level` et aucun résultat
de check ne transforme un tool en porte bloquante.

Une subtilité à connaître avant de tester votre entrée : les checks ne se lancent que lorsque l'install
applique effectivement quelque chose. Une sélection de tools seuls — ou une relance où tout est déjà à
jour — se termine par `Nothing to apply` et saute entièrement les vérifications de présence, sans rien
rapporter. Pour voir votre check vérifié, installez-le aux côtés d'un artifact qui écrit un fichier,
ou intégrez-le dans un pack qui le fait.

## Installer un tool n'est pas encore livré

Disons-le clairement : agent-rigger n'installe pas les tools. Les indications `install` — `brew`,
`npm`, `pnpm`, `mise` — font partie du schéma et vous pouvez les déclarer dès aujourd'hui, mais rien
ne les consomme. Il n'existe aucun chemin de code qui lance `brew install`, et une install qui trouve
un tool `required` absent vous le signale et poursuit ; elle ne va pas le récupérer à votre place.
L'aide du CLI le confirme, en libellant la nature `Host system tools (advisory check only).`

Déclarer les indications dès maintenant vaut quand même la peine : elles consignent, en un seul
endroit que votre équipe peut lire, comment chaque dépendance est censée être obtenue, et elles sont
ce qu'une future release utilisera pour réaliser l'install elle-même. En attendant, traitez une
entrée `tool` comme une attente documentée et vérifiable. C'est l'unique nature dont le rôle est de
vous dire quoi installer à la main ; elle n'installe jamais rien elle-même.

## Les autres natures

Cette page couvre uniquement la nature `tool`, l'unique nature qu'agent-rigger vérifie plutôt qu'il
n'écrit. Chacune des huit natures a son propre contrat ; la carte complète, par assistant et par
scope, est la [matrice des natures](/fr/reference/natures-matrix/). Les natures qui livrent
effectivement une charge utile ont leur propre page authoring :
[publier un skill](/fr/authoring/skills/), [publier un guardrail](/fr/authoring/guardrails/), et
[publier un serveur MCP](/fr/authoring/mcp-servers/).
