---
title: Publier un serveur MCP
description: "L'entrée de catalog pour la nature mcp : sa config et son transport déclarés à même l'entrée, la contrainte stricte de secret ${VAR}, pourquoi la valeur ne vit jamais dans le catalog, ce qu'une install délègue par assistant, et une boucle locale pour le prouver avant de tagger."
---

Une entrée [mcp](/fr/reference/glossary/#mcp) distribue un serveur Model Context Protocol : le
catalog stocke une déclaration ; l'assistant l'exécute. Cette page est le contrat de la
[nature](/fr/reference/glossary/#nature) `mcp` : l'entrée de catalog dont elle a besoin, la seule
règle stricte que ses références de secret obéissent, et ce qu'une install en fait réellement.

Elle suppose que vous avez déjà un dépôt de catalog et que vous connaissez la boucle
éditer-installer-tagger. Si ce n'est pas le cas, construisez-en un d'abord dans
[créer un catalog](/fr/authoring/create-a-catalog/) ; ce tutoriel possède la mécanique générale
(dépôt git, squelette de `catalog.json`, publication d'une version). Ici vous ajoutez seulement une
entrée mcp à un catalog qui existe déjà.

## L'entrée de catalog

Un serveur mcp est une entrée [artifact](/fr/reference/glossary/#artifact) avec `nature: "mcp"`.
Contrairement à un skill, il ne porte aucun dossier : toute la déclaration du serveur vit à même
l'entrée, sous `config`. Un serveur MCP GitHub pour Claude Code ressemble à ceci :

```json title="entrée dans catalog.json"
{
  "kind": "artifact",
  "id": "mcp:github",
  "nature": "mcp",
  "targets": ["claude"],
  "scopes": ["user"],
  "config": {
    "command": "docker",
    "args": [
      "run",
      "-i",
      "--rm",
      "-e",
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "ghcr.io/github/github-mcp-server"
    ],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}" }
  },
  "secrets": [
    {
      "ref": "GITHUB_PERSONAL_ACCESS_TOKEN",
      "prompt": "GitHub personal access token",
      "required": true,
      "help": "https://github.com/settings/tokens"
    }
  ]
}
```

Au-delà des champs que tout artifact partage, une entrée mcp ajoute `config` et `secrets` :

| Champ      | Requis | Pour une entrée mcp                                                                                                   |
| ---------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
| `kind`     | oui    | Toujours `"artifact"`. Un serveur mcp est un artifact unique, jamais un `pack`.                                       |
| `id`       | oui    | `mcp:<name>`. Le `<name>` après le préfixe est l'id de serveur sous lequel l'assistant le stocke.                     |
| `nature`   | oui    | `"mcp"`.                                                                                                              |
| `targets`  | oui    | Les [assistants](/fr/reference/glossary/#assistant) qui le reçoivent : `claude`, `opencode`, ou les deux.             |
| `scopes`   | oui    | `user`, `project`, ou les deux. Voir [scope](/fr/reference/glossary/#scope).                                          |
| `config`   | oui¹   | La déclaration du serveur, transmise verbatim. La forme dépend de l'assistant — voir [transport](#le-transport).      |
| `secrets`  | non    | Une déclaration par référence `${VAR}` que la config porte. Voir [la contrainte de secret](#la-contrainte-de-secret). |
| `requires` | non    | Ids des entrées qui doivent s'installer d'abord. Voir [requires](/fr/reference/glossary/#requires).                   |

¹ Le parser accepte une entrée mcp sans `config`, mais une install n'a alors rien à ajouter ; c'est
l'adapter, pas le schéma, qui impose qu'un vrai serveur en porte une. Les règles complètes, champ
par champ, sont dans le [schéma catalog.json](/fr/reference/catalog-schema/#champs-mcp).

### Le transport

Puisque `config` est transmise à l'assistant sans y toucher, sa forme appartient à l'assistant, pas
à agent-rigger. Les deux assistants déclarent un serveur différemment :

- **Claude Code** prend un descripteur natif. La forme stdio ci-dessus utilise `command`, `args`, et
  une map `env`. Un serveur distant porterait `url` et `headers` à la place.
- **opencode** prend une forme discriminée sous `config`. Un serveur local (spawné) est
  `{ "type": "local", "command": [...], "environment": { ... } }` ; un serveur distant est
  `{ "type": "remote", "url": "...", "headers": { ... } }`.

Le même serveur GitHub, ciblé vers opencode comme serveur local, donne :

```json title="entrée dans catalog.json"
{
  "kind": "artifact",
  "id": "mcp:github",
  "nature": "mcp",
  "targets": ["opencode"],
  "scopes": ["user"],
  "config": {
    "type": "local",
    "command": [
      "docker",
      "run",
      "-i",
      "--rm",
      "-e",
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "ghcr.io/github/github-mcp-server"
    ],
    "environment": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}" }
  },
  "secrets": [
    {
      "ref": "GITHUB_PERSONAL_ACCESS_TOKEN",
      "prompt": "GitHub personal access token",
      "required": true,
      "help": "https://github.com/settings/tokens"
    }
  ]
}
```

### La contrainte de secret

Un serveur a besoin d'un token, et ce token ne doit jamais être committé. agent-rigger garde la
valeur totalement hors du catalog : `config` porte une
[référence `${VAR}`](/fr/reference/glossary/#secret-by-environment-reference-var), et la valeur est
fournie sur la machine qui installe, au moment de l'install. Trois sous-objets sont ceux qui peuvent
porter un secret, et chaque valeur qu'ils contiennent doit être une référence `${VAR_NAME}` exacte :
`env` (le champ stdio de Claude Code), et `environment` et `headers` (les champs d'opencode). Les
clés en dehors de ces trois-là (`command`, `args`, `url`, `type`) ne portent aucune règle de ce
type.

La correspondance est stricte. Une valeur littérale, ou une référence partielle comme
`"Bearer ${TOKEN}"`, est rejetée au parsing du catalog, avant tout début de travail d'install.
Écrivez un littéral :

```json
"env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_a_real_token" }
```

et le parsing échoue, en nommant l'entrée et le chemin fautif :

```
[error] catalog.json contains invalid entries: index 0: config.env.GITHUB_PERSONAL_ACCESS_TOKEN mcp entry "mcp:github" has a non-ref value at config.env.GITHUB_PERSONAL_ACCESS_TOKEN — use a "${VAR_NAME}" reference instead of a literal value
```

Chaque référence que la config porte reçoit une entrée dans `secrets`. Une déclaration nomme la
référence et indique à l'installeur comment la demander :

| Champ      | Requis | Pour une déclaration de secret                                                                                               |
| ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `ref`      | oui    | Le nom à l'intérieur de `${…}` — ici `GITHUB_PERSONAL_ACCESS_TOKEN`. Relie la déclaration à la config.                       |
| `prompt`   | oui    | Le libellé affiché quand l'installeur demande quelle variable d'environnement porte la valeur.                               |
| `required` | non    | Quand `true`, install échoue en fail-closed si le secret n'est jamais résolu (voir [la boucle](#testez-le-avant-de-tagger)). |
| `example`  | non    | Exemple indicatif du format de la valeur. Jamais un vrai secret.                                                             |
| `help`     | non    | Texte ou URL indicatif, par exemple où générer le token.                                                                     |

Aucune valeur n'apparaît jamais nulle part dans l'entrée : `secrets` déclare des noms de référence
et du texte indicatif seulement. Comment une référence est associée à une vraie variable au moment
de l'install, et où la valeur atterrit et n'atterrit jamais, c'est
[donner son secret à un serveur MCP](/fr/guides/mcp-secrets/).

## Ce que produit une install

Les deux assistants utilisent des mécanismes sans rapport, et aucun n'écrit jamais une valeur de
secret. Pour **claude**, install [délègue](/fr/reference/glossary/#delegate-first) au CLI natif de
Claude Code : `claude mcp add-json <server> <json> -s <scope>`. La config qu'il transmet porte
toujours une référence `${VAR}`, mais agent-rigger réécrit d'abord le nom à l'intérieur de `${…}` :
il devient la variable vers laquelle `--secret-env` a fait correspondre le `ref` du catalog, ou le
nom du `ref` lui-même quand aucune correspondance n'a été donnée. Ce nom réécrit est ce que Claude
Code stocke dans sa propre config, sur cette machine, et ce qu'il étend quand il lance ensuite le
serveur ; comment la correspondance elle-même se résout, c'est
[donner son secret à un serveur MCP](/fr/guides/mcp-secrets/). Pour **opencode**, install fusionne
le serveur sous la clé `mcp` de `opencode.json` à la granularité du serveur, en préservant toute
autre clé et tout serveur déjà présent. Le chemin exact, le fichier de config, et le mécanisme par
assistant et par scope sont la ligne `mcp` de la
[matrice des natures](/fr/reference/natures-matrix/#mcp).

## Testez-le avant de tagger

Prouvez que l'entrée se parse et s'installe avant de publier une release. Pointez l'outil vers un
home jetable et installez votre dossier de catalog directement depuis le disque : `install` lit un
chemin local directement comme une [source ad-hoc](/fr/guides/ad-hoc-install/), sans étape
`catalog add`.

Une entrée mcp ciblant claude a une seconde préoccupation d'isolation qu'un skill n'a pas. Son
install délègue l'écriture au CLI natif de Claude Code, qui écrit dans la config de Claude Code, pas
sous [`RIGGER_HOME`](/fr/reference/glossary/#rigger_home). Pointez aussi cette config vers le
sandbox avec `CLAUDE_CONFIG_DIR`, sinon le serveur atterrit dans votre vrai `~/.claude.json` :

```sh
export RIGGER_HOME="$(mktemp -d)"
export CLAUDE_CONFIG_DIR="$RIGGER_HOME/.claude-cfg"
export NO_COLOR=1
```

`install` clone ce qui se trouve à `HEAD`, jamais votre working tree, committez donc l'entrée (le
changement de `catalog.json`) avant d'installer, sinon le plan l'omet silencieusement : aucune
erreur, exit `0`, le reste du catalog s'installe comme si le nouveau serveur n'avait jamais été
ajouté.

Faites ensuite correspondre la référence à une variable et installez par chemin. Dans un shell
non-interactif, `--yes` est requis et sélectionne toutes les entrées que la source propose ; un
secret marqué `required` n'a pas de défaut à cet endroit, passez donc aussi
[`--secret-env`](/fr/reference/glossary/#secret-env) :

```sh
export MY_GH_PAT=ghp_your_token
agent-rigger install /path/to/your-catalog --secret-env=GITHUB_PERSONAL_ACCESS_TOKEN=MY_GH_PAT --yes
```

```
--- Plan ---
Plan · 1 change · scope: user (~/.claude)

+ local-your-catalog/mcp:github


--- Result ---
  [ok] Applied 0 file(s).
```

Le **Plan** prévisualise un changement ; **Result** rapporte `Applied 0 file(s)` parce
qu'agent-rigger n'a écrit aucun fichier de son cru ; c'est le CLI de Claude Code qui a ajouté le
serveur, pas le mécanisme d'écriture de fichiers d'agent-rigger. Le préfixe `local-your-catalog/` est de la
[provenance](/fr/guides/ad-hoc-install/#le-préfixe-de-provenance) : une install ad-hoc dérive un
préfixe d'id depuis la source plutôt que d'un nom de catalog enregistré.

Sautez le flag et le secret `required` échoue en fail-closed, avant que quoi que ce soit ne soit
écrit :

```
[error] missing required secret "GITHUB_PERSONAL_ACCESS_TOKEN" (GitHub personal access token) — pass --secret-env=GITHUB_PERSONAL_ACCESS_TOKEN=<VAR_NAME> or export GITHUB_PERSONAL_ACCESS_TOKEN directly
```

La correspondance elle-même (comment `--secret-env` se résout, ce qu'une session interactive
demande, et où la valeur va) c'est [donner son secret à un serveur MCP](/fr/guides/mcp-secrets/).
Effacez le sandbox une fois terminé :

```sh
rm -rf "$RIGGER_HOME"
unset RIGGER_HOME CLAUDE_CONFIG_DIR MY_GH_PAT
```

Une fois que l'entrée s'installe proprement, committez-la et publiez une version comme le montre
[créer un catalog](/fr/authoring/create-a-catalog/#étape-5--publier-une-version). Un serveur mcp
n'est réel pour votre équipe qu'une fois devenu une release taggée.

## Les autres natures

Cette page couvre uniquement la nature `mcp`. Chacune des huit natures a son propre contrat sur
disque ; la carte complète, par assistant et par scope, est la
[matrice des natures](/fr/reference/natures-matrix/). La dernière a elle aussi sa propre page :
[déclarer une dépendance à un tool](/fr/authoring/tools/) couvre la vérification de présence de
`tool`, qui fonctionne aujourd'hui, même si son install depuis les indications d'install par
gestionnaire de paquets n'est pas encore livrée.
