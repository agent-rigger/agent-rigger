---
title: Publier un sous-agent
description: Ajoutez une entrée agent à votre catalog et distribuez un sous-agent Claude Code — l'entrée de catalog, le fichier de définition, et ce que claude (store + symlink) et opencode (translate + write, en abandonnant le frontmatter qu'il ne peut pas mapper) écrivent chacun à l'install.
---

Une entrée [`agent`](/fr/reference/glossary/#agent-sub-agent) distribue un **sous-agent** Claude
Code : un assistant spécialisé, défini dans un unique fichier Markdown, auquel l'assistant principal
peut confier une tâche. Cette page est le contrat de cette [nature](/fr/reference/glossary/#nature)
unique : l'entrée que vous écrivez, le fichier qui la porte, et ce que chaque
[assistant](/fr/reference/glossary/#assistant) en fait à l'install. Les deux divergent nettement :
claude lie le fichier sans le toucher, opencode réécrit son frontmatter dans un schéma différent et
abandonne ce qu'il ne peut pas mapper.

Ne confondez pas `agent` et `AGENTS.md`. La nature `agent` est une définition de sous-agent ;
[`AGENTS.md`](/fr/reference/glossary/#agentsmd) est un simple fichier d'instructions qui relève de
la nature [context](/fr/reference/glossary/#context). Les noms se ressemblent ; les deux choses sont
sans rapport.

Cette page suppose que vous avez déjà un catalog : un dépôt git avec un `catalog.json`, installé
depuis un chemin local pendant que vous itérez, taggé quand vous publiez une release. Si ce n'est pas
le cas, construisez-en un d'abord dans [créer un catalog](/fr/authoring/create-a-catalog/) : ce
tutoriel possède le dépôt, la boucle d'install locale, et le tag de release. Ici, nous ajoutons
seulement l'agent.

## L'entrée de catalog

Un agent est une entrée [artifact](/fr/reference/glossary/#artifact) avec `nature: "agent"`. Elle ne
porte aucun champ spécifique à la nature. Un `hook` exige `event` et `matcher` ; un `mcp` porte
`config` et `secrets`. Une entrée agent, ce sont juste les
[champs communs](/fr/reference/catalog-schema/#champs-communs) plus sa nature :

```json title="entrée dans catalog.json"
{
  "kind": "artifact",
  "id": "agent:reviewer",
  "nature": "agent",
  "targets": ["claude", "opencode"],
  "scopes": ["user"]
}
```

Chaque champ est porteur de sens :

- `kind` est `"artifact"` — le discriminant qui route l'entrée vers la forme artifact.
- `id` suit la convention `agent:<name>`. Le `<name>` après le préfixe est le nom du fichier sur le
  disque ; gardez-le filesystem-safe (`[a-zA-Z0-9._-]`, aucun segment de chemin) ou l'install le
  rejette.
- `nature` vaut `"agent"`, une des huit natures que le schéma accepte.
- `targets` liste les assistants que cet agent supporte — `claude`, `opencode`, ou les deux. Ce choix
  décide lequel des deux mécanismes ci-dessous s'exécute. Une entrée qui omet un assistant est
  [sautée](#quand-les-targets-ne-correspondent-pas) pour cet assistant, pas traduite.
- `scopes` liste où elle peut s'installer — `user`, `project`, ou les deux.

`requires` est le seul autre champ qu'un agent utilise, et il est optionnel : des ids d'entrées à
installer d'abord. La forme complète, champ par champ, y compris chaque champ optionnel et ce que le
parser rejette, est dans le [schéma de catalog.json](/fr/reference/catalog-schema/). Le
[`agent:demo`](/fr/reference/glossary/#agent-sub-agent) du catalog exemple est le cas vivant minimal —
`nature: "agent"`, `targets: ["claude"]`, rien de plus.

## Le fichier de définition

L'entrée `agent:reviewer` est portée par un fichier au chemin conventionnel `agents/reviewer.md` — le
`<name>` de l'id devient le nom de fichier. La
[référence de disposition du catalog](/fr/reference/catalog-layout/) donne la convention de chemin
pour chaque nature.

Le fichier est un sous-agent Claude Code ordinaire : un bloc de
[frontmatter](/fr/reference/glossary/#frontmatter) au style
[agentskills.io](/fr/reference/glossary/#agentskillsio), suivi d'instructions en Markdown.

```md title="agents/reviewer.md"
---
name: reviewer
description: Reviews a diff for correctness and security regressions before commit.
model: anthropic/claude-sonnet-4-5
tools: Read, Grep, Edit, Bash
color: purple
---

You are a code reviewer. Read the diff, flag correctness and security regressions,
and suggest concrete fixes. Keep findings ranked by severity.
```

`name` et `description` sont les deux champs dont Claude Code a besoin ; `model`, `tools`, et
diverses clés propres à Claude comme `color` sont optionnelles. Écrivez le fichier pour Claude Code —
c'est le format source. Ce qu'opencode en garde, et ce qu'il abandonne silencieusement, est le sujet
de la section suivante.

## Ce que install écrit, par assistant

`targets` décide du mécanisme. Le tableau complet des chemins par scope est dans la
[matrice des natures](/fr/reference/natures-matrix/#agent) ; les deux mécanismes sont résumés ici.

### claude — store + symlink

Claude traite le sous-agent exactement comme un [skill](/fr/reference/glossary/#skill) : le `.md`
source est copié dans le [store](/fr/reference/glossary/#store) managé sous
`~/.config/agent-rigger/`, et un [symlink](/fr/reference/glossary/#symlink) à la cible pointe vers
lui. Le frontmatter n'est jamais lu ni réécrit. Le fichier atterrit octet pour octet tel que vous
l'avez écrit.

```
--- Plan ---
Plan · 1 change · scope: user (~/.claude)

+ myteam/agent:reviewer   ~/.claude/agents/reviewer.md
  link  ~/.claude/agents/reviewer.md → store

Σ  1 link

--- Result ---
  [ok] Applied 1 file(s).
    + /tmp/rigger-sandbox.AK4SUs/.claude/agents/reviewer.md
```

Les deux chemins diffèrent parce que l'exécution était en sandbox : le Plan montre l'emplacement
logique de scope user (`~/.claude/…`), le Result montre où le home jetable a effectivement redirigé
l'écriture. Sur le disque, la cible est un lien vers le store :

```
~/.claude/agents/reviewer.md -> ~/.config/agent-rigger/agents/reviewer.md
```

### opencode — translate + write

opencode ne lit pas le schéma de frontmatter de Claude, donc agent-rigger le réécrit. Le `.md` source
est lu, son frontmatter traduit champ par champ, et le résultat **écrit comme un fichier ordinaire**
— un `write-text`, pas un lien. Il n'y a **aucun store** pour un agent opencode, et aucun symlink : la
cible est un fichier ordinaire.

Chaque champ source est traité selon ses propres règles :

| Frontmatter source     | Résultat opencode                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `description`          | transmis sans changement.                                                                                                   |
| `name`                 | abandonné — l'id d'opencode est le nom de fichier, pas un champ de frontmatter.                                             |
| `model`                | transmis ; un avertissement se déclenche quand la valeur n'est pas déjà sous la forme `provider/model` d'opencode.          |
| `tools`                | traduit en allow-list `permission` : `"*": deny` d'abord, puis un `<category>: allow` par outil mappé, dans l'ordre source. |
| _(aucun)_              | `mode: subagent` est toujours ajouté — chaque agent distribué est un sous-agent.                                            |
| n'importe quoi d'autre | omis, avec un avertissement nommant le champ (par exemple `color`).                                                         |

Deux subtilités de la traduction de `tools` méritent d'être connues quand vous rédigez l'allow-list.
Un nom d'outil sans équivalent opencode (y compris chaque outil `mcp__*`) n'est **pas** autorisé ; il
reste refusé par le défaut `"*": deny`, et un avertissement le nomme. Et opencode a une seule
catégorie fusionnée `edit` couvrant write, edit et apply_patch : accorder `edit` est plus large qu'une
allow-list Claude qui n'en listait qu'un seul, ce qui déclenche donc aussi un avertissement.

Installer `agent:reviewer` pour opencode montre la traduction dans l'aperçu du plan, avec les deux
avertissements remontés avant toute écriture :

```
--- Plan ---
Plan · 1 change · scope: user (~/.config/opencode)

+ myteam/agent:reviewer   ~/.config/opencode/agents/reviewer.md
  write  +14 / -0
     │ ---
     │ description: Reviews a diff for correctness and security regressions before commit.
     │ mode: subagent
     │ model: anthropic/claude-sonnet-4-5
     │ permission:
     │   "*": deny
     │ …

Σ  1 write
--- Warnings ---
  [warning] opencode has a single "edit" permission category covering write/edit/apply_patch; granting it here is broader than the source "tools" whitelist.
  [warning] Field "color" has no opencode equivalent and was omitted.


--- Result ---
  [ok] Applied 1 file(s).
    + /tmp/rigger-sandbox.AK4SUs/.config/opencode/agents/reviewer.md
```

Le fichier écrit sur le disque est la forme traduite complète. `name` et `color` ont disparu,
`mode: subagent` est ajouté, et `tools` est devenu une map `permission` qui refuse tout et
ré-autorise les quatre catégories mappées :

```md title="~/.config/opencode/agents/reviewer.md"
---
description: Reviews a diff for correctness and security regressions before commit.
mode: subagent
model: anthropic/claude-sonnet-4-5
permission:
  "*": deny
  read: allow
  grep: allow
  edit: allow
  bash: allow
---

You are a code reviewer. Read the diff, flag correctness and security regressions,
and suggest concrete fixes. Keep findings ranked by severity.
```

Comme c'est un fichier ordinaire sans store derrière lui, `install` ne vérifie pas le
[drift](/fr/reference/glossary/#drift) avant de l'écrire. Réinstaller relit toujours la source, la
retraduit, et écrit le résultat dès que la traduction diffère de ce qui est sur le disque, quelle que
soit la raison de cette différence : votre édition locale, ou un changement plus haut dans le catalog.
Le contenu précédent est d'abord sauvegardé, mais votre édition elle-même n'est pas conservée. Éditer
le fichier écrit, puis réinstaller, le prouve :

```
--- Plan ---
Plan · 1 change · scope: user (~/.config/opencode)

~ myteam/agent:reviewer   ~/.config/opencode/agents/reviewer.md
  write  +14 / -0
     │ ---
     │ description: Reviews a diff for correctness and security regressions before commit.
     │ mode: subagent
     │ model: anthropic/claude-sonnet-4-5
     │ permission:
     │   "*": deny
     │ …

Σ  1 write
--- Warnings ---
  [warning] opencode has a single "edit" permission category covering write/edit/apply_patch; granting it here is broader than the source "tools" whitelist.
  [warning] Field "color" has no opencode equivalent and was omitted.


--- Result ---
  [ok] Applied 1 file(s).
    + /tmp/rigger-sandbox.9CM4Ed/.config/opencode/agents/reviewer.md
  [backup] 1 file(s) backed up.
    ~ /tmp/rigger-sandbox.9CM4Ed/.config/opencode/agents/reviewer.md.bak-2026-07-16T10-37-41.371Z-072266f7
```

Le `~` sur la ligne du plan (et non `+`) signifie que la cible existait déjà ; l'écriture a lieu quand
même. [`remove`](/fr/guides/remove-artifacts/#une-cible-que-vous-avez-modifiée-vous-même) est la
commande qui laisse une cible driftée tranquille. `install` ne l'est pas.

### Quand les targets ne correspondent pas

Si le `targets` de l'entrée ne liste pas l'assistant pour lequel vous installez, l'agent est sauté,
pas traduit. Installer `agent:demo` du catalog exemple (qui cible uniquement `claude`) pour opencode
rapporte le désaccord et n'écrit rien :

```
--- Skipped (assistant mismatch) ---
  [skipped] example/agent:demo — targets [claude], not opencode
```

Pour distribuer un agent à opencode, ajoutez `opencode` à son `targets`, comme le fait
`agent:reviewer` ci-dessus.

## Le tester en local

Rédiger un agent suit la même boucle d'édition-et-install que tout changement de catalog : installer
depuis un chemin local, aucun aller-retour distant. Travaillez dans un
[sandbox](/fr/reference/glossary/#sandbox) pour que les écritures atterrissent dans un home jetable,
installez votre catalog par chemin, et inspectez ce que chaque assistant a produit. La mécanique (mise
en place du sandbox, `catalog add` avec un chemin local, le tag de release) est dans
[créer un catalog](/fr/authoring/create-a-catalog/) ; installer une source unique directement depuis
un chemin ou une URL est dans
[installer depuis une URL ou un chemin local](/fr/guides/ad-hoc-install/).

Pour voir les deux mécanismes, installez une fois par assistant et relisez les fichiers :

```sh
agent-rigger install myteam/agent:reviewer --yes
agent-rigger install myteam/agent:reviewer --assistant opencode --yes
```

Le `--yes` n'est pas optionnel dans un script. Les deux commandes ci-dessus passent déjà des ids
explicites ; dans une session [non-interactive](/fr/reference/glossary/#tty--non-interactive), lancer
`install` avec des ids mais sans `--yes` sort en `2` avant de récupérer quoi que ce soit plutôt que de
rester bloqué sur une invite :

```
[error] non-interactive session — pass --yes to confirm non-interactively
```

Retirez aussi les ids et l'échec change : sans aucun id, le sélecteur a besoin d'un TTY, et une
session non-interactive est rejetée avant même que `--yes` soit vérifié. Voir
[install](/fr/reference/cli/install/#interactif-vs-non-interactif) pour ce message exact et le contrat
non-interactif complet.

## Les autres natures

Cette page couvre uniquement la nature `agent`. Chacune des huit natures a son propre contrat sur le
disque ; la carte complète, par assistant et par scope, est la
[matrice des natures](/fr/reference/natures-matrix/). Publier un serveur MCP a
[sa propre page](/fr/authoring/mcp-servers/). `tool` n'a pas de page authoring : sa vérification de
présence fonctionne aujourd'hui, mais son install depuis les indications d'install par gestionnaire
de paquets n'est pas encore livrée.
