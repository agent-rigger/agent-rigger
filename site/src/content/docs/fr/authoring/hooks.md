---
title: Publier un hook
description: "Livrez un hook depuis votre catalog : les champs d'entrée qu'impose le schéma, le script qui l'accompagne, ce qu'install écrit dans le settings.json de Claude Code, et pourquoi un hook est réservé à Claude, avec un plugin comme chemin de parité opencode."
---

Un [hook](/fr/reference/glossary/#hook) lance un script automatiquement à un moment du cycle de vie :
au démarrage de session, avant un appel d'outil, quand l'agent s'arrête. Le publier depuis votre
catalog, c'est livrer deux choses ensemble : une entrée de catalog qui déclare _quand_ le hook se
déclenche, et le script qui s'exécute. Cette page est le côté auteur de cela : ce que vous écrivez, ce
qu'install en fait sur le poste d'un coéquipier, et l'unique règle de plateforme qui façonne chaque
hook. Il est livré pour Claude Code uniquement.

Ceci est un how-to pour une seule [nature](/fr/reference/glossary/#nature). Il suppose que vous avez
déjà un dépôt de catalog avec un `catalog.json` ; sinon, [créez un catalog](/fr/authoring/create-a-catalog/)
d'abord. Ce tutoriel couvre le dépôt, le sandbox, et la publication d'une version ; cette page ne les
répète pas. Le contrat d'event auquel un hook se lie (quels events existent, ce que chacun déclenche,
le protocole runtime) appartient à la [référence des events de hook](/fr/reference/hook-events/) ; le
schéma champ par champ est le [schéma catalog.json](/fr/reference/catalog-schema/#champs-hook). Faites
le lien, ne mémorisez pas.

## De quoi un hook est fait

Deux éléments, tous deux vivant dans votre dépôt de catalog :

- **L'entrée** dans `catalog.json` : déclare l'[event](/fr/reference/hook-events/#events-supportés),
  le `matcher`, et un `timeout` optionnel. Il s'agit de métadonnées ; elle ne porte aucun code.
- **Le script** à `hooks/<name>.ts` : la command réelle. Il voyage dans le catalog et est copié sur
  la machine à l'install.

Ni l'un ni l'autre ne fonctionne seul. L'entrée nomme un script qui doit exister au chemin
conventionnel ; le script ne fait rien tant qu'une entrée ne l'enregistre pas contre un event.

## Écrire l'entrée

Un hook est une entrée [artifact](/fr/reference/glossary/#artifact) avec `nature: "hook"`. Deux
champs sont obligatoires _pour cette nature_ en plus des [champs communs](/fr/reference/catalog-schema/#champs-communs)
que porte chaque entrée : `event` et `matcher`. Voici le hook que le catalog d'exemple livre, tel
quel :

```json title="catalog.json — une entrée hook"
{
  "kind": "artifact",
  "id": "hook:demo",
  "nature": "hook",
  "targets": ["claude"],
  "scopes": ["user", "project"],
  "event": "SessionStart",
  "matcher": "startup"
}
```

- `event` est l'un des neuf events qu'agent-rigger reconnaît. La liste est fermée et vit dans la
  [référence des events de hook](/fr/reference/hook-events/#events-supportés) ; une valeur non
  reconnue échoue au parsing. Omettre `event` sur une entrée hook est rejeté avec
  `hook entries require 'event'`.
- `matcher` est l'action que le hook écoute : un nom d'outil comme `Bash`, ou `*` pour toute action.
  Les events qui ne portent aucun outil (`SessionStart`, `Stop`, …) ont quand même besoin d'un
  `matcher` ; l'exemple utilise `startup`. L'omettre est rejeté avec `hook entries require 'matcher'`.
- `timeout` est optionnel : un entier positif, le nombre maximal de secondes que le script peut
  tourner. L'exemple l'omet ; en son absence, aucun timeout n'est écrit du tout.
- `targets` vaut `["claude"]`. Gardez-le ainsi. Voir
  [Les hooks sont réservés à Claude](#les-hooks-sont-réservés-à-claude).

Les champs qui appartiennent à d'autres natures (`config`, `secrets`, `install`) sont ignorés sur
une entrée hook. Seuls `event` et `matcher` sont imposés. Le tableau complet est dans le
[schéma catalog.json](/fr/reference/catalog-schema/#champs-hook).

## Livrer le script

L'entrée ci-dessus nomme `demo`, donc son script vit à `hooks/demo.ts` : l'id privé de son préfixe
`hook:`. C'est la [disposition conventionnelle](/fr/reference/catalog-layout/#hooks) : chaque script
de hook se trouve sous un unique répertoire `hooks/` à la racine du dépôt.

```
your-catalog/
├── catalog.json
└── hooks/
    └── demo.ts          # hook:demo
```

Le `demo.ts` du catalog d'exemple est délibérément sans effet de bord. Il écrit une ligne de
contexte _advisory_ et ne touche à rien d'autre, si bien qu'il passe le scan de sécurité à l'install :

```ts title="hooks/demo.ts"
#!/usr/bin/env bun
// SessionStart hook distributed via the agent-rigger example catalog.

const payload = {
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: 'Rig loaded — hello-rigger demo catalog is active.',
  },
};

process.stdout.write(JSON.stringify(payload));
```

Ce que le script lit sur stdin et écrit sur stdout (la forme ci-dessus) appartient au protocole de
hook de Claude Code, pas à celui d'agent-rigger. agent-rigger dépose le fichier et enregistre une
command ; il ne lance jamais le script ni n'interprète sa sortie. Cette frontière, et le protocole
lui-même, sont dans
[le protocole runtime appartient à Claude Code](/fr/reference/hook-events/#le-protocole-runtime-appartient-à-claude-code).

Deux règles de disposition à connaître avant de répartir du code sur plusieurs fichiers : chaque
fichier sous `hooks/` voyage vers le store ensemble, si bien qu'un helper à `hooks/_shared/lib.ts`
est disponible pour tout hook qui l'importe ; et un nom commençant par `_` n'est jamais lui-même une
entrée, seulement la dépendance d'une autre. Les deux sont couverts dans la
[référence de disposition du catalog](/fr/reference/catalog-layout/#hooks).

## Ce qu'install écrit

Installer un hook pour Claude Code fait deux choses, toutes deux visibles dans le plan : fusionner
l'entrée dans le `settings.json` de l'assistant sous la clé `hooks`, et copier le script dans un
store partagé. Depuis le sandbox (un catalog enregistré localement sous le nom `example`), en
installant par [id qualifié](/fr/reference/glossary/#qualified-id) :

```sh
rigger install example/hook:demo --yes
```

```
--- Plan ---
Plan · 1 change · scope: user (~/.claude)

+ example/hook:demo   ~/.claude/settings.json (+ hooks)
  hook  SessionStart/startup → demo.ts
  link  ~/.config/agent-rigger/hooks

Σ  1 hook

--- Result ---
  [ok] Applied 1 file(s).
    + /tmp/rigger-sandbox.TZot50/.claude/settings.json
```

Le `settings.json` qu'il a écrit enregistre le script par chemin absolu :

```json title="~/.claude/settings.json (résultat)"
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "bun run /tmp/rigger-sandbox.TZot50/.config/agent-rigger/hooks/demo.ts"
          }
        ]
      }
    ]
  }
}
```

La `command` enregistrée est `bun run <store>/demo.ts`. Le store est
[`~/.config/agent-rigger/hooks/`](/fr/reference/glossary/#store), partagé par chaque hook. Le plan
étiquette la ligne de store `link`, mais sur disque le script y atterrit comme une **simple copie,
pas un symlink**. Vérifiez-le : l'entrée de store est un fichier ordinaire. Ceci diffère d'un
skill, qui est copié dans le store _et_ relié par symlink dans le répertoire de l'assistant. Un hook
n'a aucun symlink de la sorte : rien ne pointe vers le script hormis la chaîne `command` en chemin
absolu dans `settings.json`.

La copie est délibérée. Un hook s'installe uniquement depuis un checkout de catalog, et ce checkout
est un fetch transitoire (il disparaît une fois l'install terminée). Si `settings.json` pointait vers
le script à l'intérieur du checkout, la command deviendrait pendouillante dès que le checkout serait
nettoyé. Copier le script dans un store durable, puis faire pointer la command vers la copie, est ce
qui permet au hook de continuer à tourner après la disparition de la chose dans laquelle il a été
livré. (Une conséquence : comme il n'y a aucun symlink pour faire un compte de références, le
répertoire de store est récupéré par garbage collection depuis le manifest, pas depuis le système de
fichiers ; un auteur ne gère jamais cela.)

Le mécanisme, par scope, et la sémantique de merge/dédup/suppression sont l'affaire de la
référence : [hook dans la matrice des natures](/fr/reference/natures-matrix/#hook) pour le contrat
sur disque, [sémantique d'enregistrement](/fr/reference/hook-events/#sémantique-denregistrement)
pour comment un ré-install ou un remove se comporte.

## Les hooks sont réservés à Claude

Un hook est livré pour l'assistant [`claude`](/fr/reference/glossary/#assistant) et aucun autre.
C'est la forme même de la chose, pas une lacune à contourner. Un hook Claude Code peut bloquer ou
orienter une action à un moment du cycle de vie ; le modèle d'opencode ne porte aucune sémantique de
blocage équivalente, si bien qu'agent-rigger ne prétend pas qu'un hook signifie la même chose
là-bas.

Le champ `targets` est ce qui vous garde du bon côté de cette règle. Avec `targets: ["claude"]`, un
coéquipier qui fait aussi tourner opencode installe le hook pour Claude proprement, et opencode est
sauté avec une simple ligne (pas d'erreur, exit `0`) :

```
--- Skipped (assistant mismatch) ---
  [skipped] example/hook:demo — targets [claude], not opencode
```

N'ajoutez **pas** `opencode` aux `targets` d'un hook. Si vous le faites, et qu'opencode est un
assistant actif, l'install route le hook vers l'adapter opencode, qui le refuse durement :
`OpencodeAdapter: unsupported nature "hook"`.

**Pattern de parité.** Quand vous voulez réellement qu'opencode obtienne un comportement
équivalent, n'étirez pas le hook. Publiez une entrée séparée avec `nature: "plugin"` et
`targets: ["opencode"]` : un plugin opencode natif, qui s'installe par
[store + symlink](/fr/reference/natures-matrix/#plugin). Deux entrées, une par assistant, chacune
native à son hôte, c'est la manière durable de couvrir les deux.

## Testez-le avant de publier

La boucle de l'auteur est la même que dans [créer un catalog](/fr/authoring/create-a-catalog/) :
installez dans un [`RIGGER_HOME`](/fr/reference/glossary/#rigger_home) jetable pour que rien ne
touche votre vrai `~/.claude`. Un hook se résout depuis un checkout de catalog, et un chemin local
est une source de catalog valide, si bien que vous pouvez itérer entièrement hors ligne. Enregistrez
votre dossier de catalog, installez par id, puis lisez ce qui a atterri :

```sh
export RIGGER_HOME="$(mktemp -d)"
rigger catalog add mycat "$(pwd)"
rigger install mycat/hook:demo --yes
cat "$RIGGER_HOME/.claude/settings.json"
```

Confirmez que l'install a atterri correctement :

- Le plan a rapporté `Σ  1 hook`.
- La `command` dans `settings.json` pointe vers `~/.config/agent-rigger/hooks/<name>.ts`.
- Ce fichier existe dans le store.

Pour installer directement depuis une URL ou un chemin sans enregistrer de catalog d'abord, voyez
[installer depuis une URL ou un chemin local](/fr/guides/ad-hoc-install/). Dans toute session
[non-interactive](/fr/reference/glossary/#tty--non-interactive), `--yes` est obligatoire. Une install
de hook avec un id mais sans `--yes` sort en `2` avant de récupérer quoi que ce soit, plutôt que de
rester bloqué sur une invite.

Effacez le sandbox une fois terminé ; votre dépôt de catalog reste en place :

```sh
rm -rf "$RIGGER_HOME"
unset RIGGER_HOME
```

## Les autres natures

Ceci couvre uniquement la nature `hook`. Il y a huit natures en tout, et les sept autres s'installent
par leurs propres mécanismes. La carte complète, par assistant et par scope, est dans
[natures × assistants × scopes](/fr/reference/natures-matrix/). Le handler `opencode` pour les hooks
n'est **pas livré** et n'est pas prévu dans le cadre de ce travail. Publier une entrée `mcp` (qui
porte des secrets) a [sa propre page](/fr/authoring/mcp-servers/), tout comme
[déclarer une dépendance à un `tool`](/fr/authoring/tools/) : sa vérification est advisory
uniquement, et son install n'est pas encore livrée.
