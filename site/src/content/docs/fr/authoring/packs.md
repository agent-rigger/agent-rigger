---
title: Publier un pack
description: "Regroupez plusieurs artifacts sous un seul id pour qu'une équipe installe un ensemble cohérent en une étape : la forme de l'entrée pack, ce que sont ses members, comment required/recommended et targets/scopes s'appliquent, et ce que montre l'installeur."
---

Un [pack](/fr/reference/glossary/#pack) est une entrée de catalog qui regroupe d'autres entrées sous
un seul id, pour qu'un coéquipier installe un ensemble cohérent (par exemple le sous-agent d'un
spec-workflow empaqueté avec son skill et son guardrail) en une seule étape plutôt que de nommer
chaque artifact. Ce how-to couvre l'entrée pack : sa forme exacte, ce que contiennent ses `members`,
comment les trois sens de _required_ atteignent un pack, et ce que l'installeur affiche à l'écran
quand quelqu'un en sélectionne un.

Il ne réenseigne pas la boucle d'authoring. Créer le dépôt de catalog et y committer, puis tagger une
version, se fait de la même façon pour un pack que pour n'importe quelle entrée. Voyez
[créer un catalog](/fr/authoring/create-a-catalog/). Un pack n'ajoute aucun fichier au dépôt ; ce sont
ses membres qui portent le contenu.

## L'entrée pack

Un pack est une entrée avec `kind: "pack"`. Il partage les
[champs communs](/fr/reference/catalog-schema/#champs-communs) que porte chaque entrée (`id`,
`targets`, `scopes`, et `requires` en option), et ajoute exactement un champ propre, `members` :

```json title="entrée dans catalog.json"
{
  "kind": "pack",
  "id": "pack:demo",
  "targets": ["claude"],
  "scopes": ["user", "project"],
  "members": ["skill:hello-rigger", "agent:demo"]
}
```

`members` est un **tableau non vide d'ids d'entrées** : des chaînes simples, pas des objets imbriqués.
Chaque id nomme une autre entrée du même `catalog.json`. Le pack ne porte ni `nature` ni `check`, ni
`install` : c'est un ensemble de références, et ce sont les entrées référencées qui portent le contenu
installable.

Un pack est parsé en **mode strict**. Tout champ au-delà de `kind`, `id`, `targets`, `scopes`,
`requires` et `members` est rejeté, y compris `nature`, qui appartient à une entrée
[artifact](/fr/reference/glossary/#artifact), jamais à un pack. Le tableau complet des champs est
dans la [référence des entrées pack](/fr/reference/catalog-schema/#entrées-pack).

## Ce qu'un pack peut regrouper

Un id de membre peut pointer vers un artifact de n'importe laquelle des huit
[natures](/fr/reference/glossary/#nature), ou vers un autre pack. Quand l'installeur développe une
sélection, un membre de pack qui est lui-même un pack est développé à son tour, récursivement ; les
packs eux-mêmes ne sont jamais installés, seuls les artifacts vers lesquels ils résolvent le sont. Un
pack large peut ainsi se composer de packs plus étroits :

```json title="entrée dans catalog.json"
{
  "kind": "pack",
  "id": "pack:full",
  "targets": ["claude"],
  "scopes": ["user", "project"],
  "members": [
    "skill:hello-rigger",
    "agent:demo",
    "guardrail:demo",
    "hook:demo",
    "context:demo"
  ]
}
```

Un pack peut aussi porter son propre `requires`. Ces ids sont résolus aux côtés des membres, en
suivant la même chaîne [requires](/fr/reference/glossary/#requires) que n'importe quelle entrée. Ce
que chaque nature écrit réellement sur le disque, par assistant et par scope, c'est le contrat
[natures × assistants × scopes](/fr/reference/natures-matrix/). Le pack n'y change rien : il décide
seulement quels artifacts entrent ensemble dans la transaction.

## Un membre qui ne pointe sur rien

Le parser n'effectue **aucun contrôle référentiel** sur `members`. Un pack dont l'id de membre ne
correspond à aucune entrée se parse proprement et se liste proprement. Le désaccord n'est pas détecté
à la lecture :

```
Catalog (2 entries):
  [available]  demoteam/skill:present  skill  
  [available]  demoteam/pack:sampler   pack   (2 members)
```

L'écart fait surface à l'install, quand l'installeur résout le pack en artifacts concrets et trouve
l'id absent :

```
[error] Unknown artifact: Unknown catalog entry: "skill:ghost" (required by: pack:sampler)
```

L'exécution s'arrête avec l'[exit code](/fr/reference/exit-codes/) `2` et n'écrit rien. La chaîne
`(required by: pack:sampler)` nomme le pack qui référençait l'id manquant, ce qui rend une faute de
frappe dans `members` rapide à tracer. Comme un mauvais id de membre reste invisible tant que
personne n'installe le pack, installez chaque pack que vous publiez contre un sandbox avant de le
tagger (voir [tester le pack](#tester-le-pack)).

## Required, recommended et un pack

Trois champs distincts portent le mot _required_, et chacun garde son propre sens. Le glossaire les
distingue à l'entrée [required](/fr/reference/glossary/#required) ; cette section note seulement
comment ils rencontrent un pack.

- Un id de pack peut figurer dans [`meta.required`](/fr/reference/glossary/#required) ou
  [`meta.recommended`](/fr/reference/glossary/#recommended). Lister `pack:demo` à cet endroit fait de
  tout l'ensemble la sélection par défaut du catalog : les membres arrivent pré-cochés dans le sélecteur
  de proposition, et `meta.required` ne peut pas être décoché alors que `meta.recommended` le peut.
  Le catalog d'exemple fait exactement cela : `"recommended": ["pack:demo"]`.
- `level: "required"` est un champ **artifact**, pas un champ pack. Un pack est strict, donc une clé
  `level` dessus est rejetée. Réglez l'importance sur les artifacts membres, pas sur le pack.
- `secrets[].required` est une préoccupation mcp et n'apparaît jamais sur un pack.

## Targets et scopes : pack vs membre

Un pack déclare ses propres `targets` et `scopes`, et chaque membre aussi. Le schéma exige les deux
sur les deux, chacun non vide. Ce sont deux déclarations indépendantes. Quand l'installeur développe
un pack, **chaque membre s'installe selon ses propres `targets` et `scopes`**, pas ceux du pack : la
déclaration du pack régit l'entrée pack, et la déclaration du membre régit comment ce membre est
écrit.

Rien ne valide que les targets et scopes d'un pack correspondent à ceux de ses membres, gardez-les
donc cohérents par convention : un pack qui annonce `["claude", "opencode"]` alors qu'un membre ne
supporte que `claude` installera quand même ce membre pour `claude` seul. Déclarez sur le pack les
ensembles que ses membres partagent réellement.

## Ce que voit l'installeur

Pour la personne qui installe, un pack est une **sélection groupée**. `rigger ls` le marque
comme pack et compte ses membres plutôt que de lister une nature :

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

Sélectionner le pack installe ses membres, développés et dédupliqués, en une seule transaction. Le
[plan](/fr/reference/glossary/#plan-dry-run) liste un changement par artifact résolu : l'id du pack
lui-même n'apparaît jamais comme ligne installée, parce qu'un pack n'écrit rien :

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

Quand votre pack figure sous `meta.required` ou `meta.recommended`, ses membres pilotent aussi le
sélecteur de proposition qu'un coéquipier rencontre la première fois qu'il branche votre catalog,
pré-cochés, et (pour recommended) à lui de les décocher. La mécanique de ce sélecteur est couverte
dans [créer un catalog](/fr/authoring/create-a-catalog/).

## Tester le pack

Écrivez un pack comme vous écririez n'importe quelle entrée : éditez `catalog.json`, installez-le
contre un home jetable pour que rien ne touche votre vrai `~/.claude`, lisez le plan, puis taggez une
release. Deux chemins installent depuis votre copie de travail sans aller-retour par `catalog add` :

- Enregistrez le dossier une fois sous un nom local et itérez : `rigger catalog add myteam
  "$(pwd)"`, puis `rigger install myteam/pack:demo --yes`. La
  [configuration du sandbox](/fr/authoring/create-a-catalog/#travailler-dans-un-sandbox-jetable)
  montre le home jetable `RIGGER_HOME` sur lequel cela s'appuie.
- Ou installez le chemin local directement, sans enregistrement : voyez
  [installer depuis une URL ou un chemin local](/fr/guides/ad-hoc-install/).

Passez toujours des ids explicites et `--yes` dans un shell non interactif : `rigger install`
sans id dans un script n'a aucun sélecteur vers lequel se rabattre ni aucun plan à confirmer. Résolvez
le pack une fois contre le sandbox, confirmez que le plan liste chaque membre attendu et aucune erreur
`Unknown catalog entry`, puis taggez la version sur laquelle votre équipe s'épingle.
