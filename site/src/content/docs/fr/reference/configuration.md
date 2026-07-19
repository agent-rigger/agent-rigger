---
title: Configuration et fichiers d'état
description: "Les fichiers locaux qu'agent-rigger lit et écrit (config.json, state.json, consent.json) champ par champ, plus les variables d'environnement qu'il honore : RIGGER_HOME, HOME, NO_COLOR, RIGGER_SCOPE, RIGGER_AUTH_METHOD."
---

agent-rigger conserve trois fichiers JSON sur le poste où il tourne : `config.json` (quels catalogs
sont configurés et comment les installs se comportent par défaut), `state.json` (le
[manifest](/fr/reference/glossary/#manifest) de ce qui est installé), et `consent.json` (le ledger de
[consent](/fr/reference/glossary/#consent) d'exécution). Cette page est le contrat champ par champ de
chaque fichier (son chemin exact, les champs que l'outil lit et écrit, et leurs types), suivi des
variables d'environnement que l'outil honore. Le raisonnement derrière le manifest et le ledger de
consent vit dans [sûreté et réversibilité](/fr/concepts/safety-and-reversibility/) et
[confiance et sécurité](/fr/concepts/trust-and-security/) ; cette page ne porte que les formes.

## Où vivent les fichiers

Les chemins sont résolus sous le répertoire home effectif (voir
[RIGGER_HOME](#variables-denvironnement)). Seul `config.json` a une variante de scope project ; le
manifest et le ledger de consent sont exclusivement de scope user.

| Fichier        | Chemin scope user                     | Chemin scope project              |
| -------------- | ------------------------------------- | --------------------------------- |
| `config.json`  | `~/.config/agent-rigger/config.json`  | `<cwd>/.agent-rigger/config.json` |
| `state.json`   | `~/.config/agent-rigger/state.json`   | —                                 |
| `consent.json` | `~/.config/agent-rigger/consent.json` | —                                 |

## config.json

Le fichier de configuration enregistre les catalogs configurés et les défauts sur lesquels une
exécution se rabat quand aucun flag ne les outrepasse. Il est lu en **JSONC** : les commentaires de
ligne et les virgules finales sont acceptés. Quand l'outil l'écrit (via `rigger init` ou
`rigger catalog add/remove`), il ajoute un commentaire d'en-tête puis affiche le JSON avec
indentation :

```jsonc title="config.json"
// agent-rigger config — edit this file or run `rigger config set`
{
  "catalogs": [
    {
      "name": "example",
      "url": "https://github.com/example/catalog.git"
    }
  ]
}
```

Le `rigger config set <key> <value>` du commentaire d'en-tête est une commande livrée. Seul le
verbe `set` existe (pas de get/list/unset), et il valide avant d'écrire : les clés settables sont
`defaultScope` (`user` | `project`), `authMethod` (`provider-cli` | `https` | `ssh`) et `assistants`
(liste CSV d'assistants connus). `catalogs` n'est volontairement pas settable — c'est géré par
`rigger catalog add` / `rigger catalog remove`, et `config set catalogs` le dit. Une clé inconnue ou
une valeur hors énumération affiche un `[error]` actionnable et sort en
[`2`](/fr/reference/exit-codes/) sans toucher au fichier ; une écriture réussie affiche
`config: <key> set to "<value>"` avec le chemin cible. L'édition directe du fichier reste prise en
charge.

### Champs

| Champ          | Type                                     | Requis | Défaut   | Sens                                                                                                                                                                                              |
| -------------- | ---------------------------------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultScope` | `"user"` \| `"project"`                  | non    | `"user"` | Le [scope](/fr/reference/glossary/#scope) que `rigger init` persiste dans ce fichier. Pas lu par `install`/`check`/`remove`/`update` ; voir [plus bas](#comment-la-config-effective-est-résolue). |
| `catalogs`     | `CatalogEntry[]`                         | non    | `[]`     | Les [catalogs](/fr/reference/glossary/#catalog) à récupérer. Chaque source est récupérée indépendamment, qualifiée, puis fusionnée. Voir plus bas.                                                |
| `authMethod`   | `"provider-cli"` \| `"https"` \| `"ssh"` | non    | aucun    | La méthode d'authentification que le pre-flight de récupération utilise. Écrit par `rigger init`.                                                                                                 |
| `assistants`   | `Assistant[]`                            | non    | aucun    | Les [assistants](/fr/reference/glossary/#assistant) cibles pour install/check/remove/update. Quand il ne contient exactement qu'une valeur, celle-ci est utilisée sans invite.                    |

Chaque `CatalogEntry` de `catalogs` est un objet à deux champs string :

| Champ  | Type   | Règle                                                                                                                                                                                          |
| ------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name` | string | Doit être présent et de type `string` (une chaîne vide passe), sinon l'entrée entière est éliminée au parsing — la même porte tout-ou-rien que `url`. Sert de préfixe qualifiant pour ses ids. |
| `url`  | string | Doit être présent, de type `string`, et non vide, sinon l'entrée entière est éliminée au parsing — la même porte que `name`. L'URL git depuis laquelle le catalog est récupéré.                |

`assistants` n'accepte que les littéraux `claude` et `opencode` ; toute autre valeur (y compris l'id
réservé `copilot`) est éliminée du tableau au parsing. Les clés de premier niveau inconnues sont
retirées : elles ne provoquent ni erreur ni round-trip.

### Comment la config effective est résolue

`resolveConfig` fusionne plusieurs couches dans la valeur utilisée pour une commande. Un champ
défini dans une couche de priorité plus haute écrase les couches inférieures ; un champ absent
n'efface jamais une valeur définie plus bas. De la plus haute à la plus basse priorité :

1. **flags** — les flags de ligne de commande de l'exécution en cours.
2. **env** — les variables d'environnement mappées dans la config (voir
   [plus bas](#variables-denvironnement)).
3. **project** — `<cwd>/.agent-rigger/config.json`.
4. **user** — `~/.config/agent-rigger/config.json`.
5. **defaults** — `defaultScope: "user"`, `catalogs: []`.

Le résolveur accepte aussi une couche `preset` entre user et defaults, mais la CLI ne la peuple
pas (aucune commande ne lit de fichier preset aujourd'hui) ; elle ne peuple pas non plus la couche
`flags`. `loadCliConfig`, le seul appelant en production du résolveur, ne fournit que `env`,
`project` et `user`. Donc pour les champs que cette fusion atteint réellement à l'exécution
(`catalogs`, `assistants`, `authMethod`), la priorité effective est env > project > user > defaults.

`defaultScope` ne fait pas partie de ces champs : aucune commande ne lit la valeur résolue. `rigger
init` est le seul lecteur, et uniquement du fichier brut sur disque, pour décider quel
`defaultScope` écrire à la prochaine sauvegarde. `install`, `check`, `remove`, `update`, et le
sélecteur de scope interactif ne le consultent jamais. Le scope qu'une exécution cible vient
directement de `--scope` : `project` quand le flag le dit, `user` dans tous les autres cas. Ni le
`defaultScope` de `config.json` ni `RIGGER_SCOPE` ne changent cela.

### Erreurs

| Condition                                                                      | Résultat                                                                                                                                              |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fichier absent                                                                 | Traité comme une config vide (pas d'erreur).                                                                                                          |
| JSONC valide, racine pas un objet (null ou array)                              | Traité comme une config vide.                                                                                                                         |
| JSONC invalide                                                                 | `InvalidConfigError` — `Invalid JSONC config in "<path>"`. Retombe sur le chemin d'erreur générique ; exit [`1`](/fr/reference/exit-codes/), pas `2`. |
| String `catalogUrl` de premier niveau présente, mais aucun `catalogs[]` valide | `LegacyConfigError` — ``Obsolete config in "<path>" — run `rigger init` to migrate to catalogs[].`` Exit `2`.                                         |

## state.json

`state.json` est le [manifest](/fr/reference/glossary/#manifest) local : la source de vérité pour
ce qui est installé, d'où ça vient, et ce que ça a écrit sur disque. Il est exclusivement de scope
user et écrit en JSON simple (indentation deux espaces, retour à la ligne final) sans commentaire
d'en-tête. Il n'existe pas de manifest de scope project.

### Forme de premier niveau

| Champ       | Type              | Règle                                                                                                                                          |
| ----------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`   | number            | Doit valoir exactement `1`. Un autre nombre est rejeté — un incrément de schéma exige une migration explicite, pas une coercition silencieuse. |
| `artifacts` | `ManifestEntry[]` | Une entrée par artifact installé. Voir [champs d'entrée](#champs-dentrée-du-manifest).                                                         |

La lecture du manifest échoue fermé sur un premier niveau corrompu, pour qu'une écriture
ultérieure ne puisse pas écraser un bon état par un état vide :

| Condition                                                                                       | Résultat                                                                      |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Fichier absent                                                                                  | Traité comme un manifest vide `{"version":1,"artifacts":[]}` (install neuve). |
| Présent, premier niveau pas un objet / `version` pas le nombre `1` / `artifacts` pas un tableau | `MalformedManifestError`. Exit [`2`](/fr/reference/exit-codes/).              |
| Présent, JSON syntaxiquement cassé                                                              | `InvalidJsonError`. Exit `2`.                                                 |

La validation du premier niveau est stricte ; la forme au niveau entrée reste tolérante, si bien
que les entrées écrites par une ancienne version (sans champ `assistant` ni `applied`) restent
lisibles.

### Champs d'entrée du manifest

| Champ         | Type                    | Requis | Sens                                                                                                                                                                                             |
| ------------- | ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`          | string                  | oui    | L'[id qualifié](/fr/reference/glossary/#qualified-id) de l'artifact.                                                                                                                             |
| `nature`      | enum                    | oui    | L'une des huit [natures](/fr/reference/glossary/#nature) : `plugin`, `guardrail`, `context`, `skill`, `agent`, `mcp`, `tool`, `hook`.                                                            |
| `ref`         | string                  | oui    | Le [ref](/fr/reference/glossary/#ref) auquel l'artifact a été récupéré — un tag semver.                                                                                                          |
| `sha`         | string                  | oui    | Le [sha](/fr/reference/glossary/#sha) de commit résolu — épingle le contenu et permet à l'outil de détecter le [drift](/fr/reference/glossary/#drift).                                           |
| `scope`       | `"user"` \| `"project"` | oui    | Le [scope](/fr/reference/glossary/#scope) sous lequel l'artifact a été installé.                                                                                                                 |
| `installedAt` | string                  | oui    | Horodatage ISO-8601 de l'install.                                                                                                                                                                |
| `files`       | string[]                | oui    | Chemins absolus des fichiers écrits ou gérés pour cette entrée. La détection de drift par existence lit cette liste.                                                                             |
| `applied`     | `AppliedPayload`        | non    | Enregistrement structuré des mutations que l'install a appliquées, pour que `remove` puisse les rejouer exactement. Absent sur les entrées écrites avant l'existence de ce champ. Voir plus bas. |
| `assistant`   | `Assistant`             | non    | L'[assistant](/fr/reference/glossary/#assistant) pour lequel l'entrée a été installée. Absent sur les entrées héritées → traité comme `claude`.                                                  |

L'identité d'une entrée est le triplet `(id, scope, assistant)` : le même artifact peut être
installé à la fois pour `claude` et pour `opencode` sans que l'un n'écrase l'autre.

Le payload `applied` est une union discriminée sur son champ `kind`. Chaque kind enregistre
exactement ce qu'une [nature](/fr/reference/glossary/#nature) donnée a écrit, ce qui est ce qui
rend une suppression une réversion exacte :

| `kind`                | Enregistré pour                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `guardrail`           | Les jeux de règles deny + allow fusionnés dans une cible guardrail.                             |
| `context`             | Le contenu AGENTS.md écrit plus sa baseline de restauration.                                    |
| `hook`                | L'`event`, le `matcher`, la `command` et le `timeout` optionnel enregistrés.                    |
| `link`                | Les chemins absolus écrits pour un skill ou un agent lié.                                       |
| `opencode-permission` | Le fragment de permission fusionné dans `opencode.json`.                                        |
| `opencode-mcp`        | L'id du serveur MCP opencode et sa config rendue (secrets en tant que références d'env).        |
| `claude-mcp`          | L'id du serveur MCP Claude Code, sa config rendue, et le scope sous lequel il a été enregistré. |

Une entrée de nature `tool` n'enregistre que son check de présence : réaliser l'install d'un tool
elle-même n'est pas encore livré.

### Exemple

```json title="state.json"
{
  "version": 1,
  "artifacts": [
    {
      "id": "example/skill:hello-rigger",
      "nature": "skill",
      "ref": "v1.0.0",
      "sha": "deadbeef",
      "scope": "user",
      "installedAt": "2026-07-16T09:12:00.000Z",
      "files": ["/home/you/.config/agent-rigger/skills/hello-rigger/SKILL.md"],
      "assistant": "claude",
      "applied": {
        "kind": "link",
        "files": ["/home/you/.config/agent-rigger/skills/hello-rigger/SKILL.md"]
      }
    }
  ]
}
```

## consent.json

`consent.json` est le ledger de consent d'exécution. Une commande `check` de catalog exécute du
contenu shell arbitraire issu du catalog ; confirmer un plan d'install n'est pas en soi un consent
à exécuter ces commandes. Ce consent est granulaire — par paire `(id, command)`, pas par catalog —
et enregistré ici, si bien qu'une commande déjà approuvée n'est jamais reproposée. Une commande
modifiée, même sous le même id, redemande toujours confirmation. Le raisonnement complet est dans
[confiance et sécurité](/fr/concepts/trust-and-security/). Le fichier est exclusivement de scope
user, écrit en JSON simple.

### Forme de premier niveau

| Champ     | Type             | Sens                                            |
| --------- | ---------------- | ----------------------------------------------- |
| `version` | number           | Version de schéma du ledger — `1`.              |
| `entries` | `ConsentEntry[]` | Une entrée par paire `(id, command)` approuvée. |

Si un fichier lu a un `version` qui n'est pas un nombre ou des `entries` qui ne sont pas un
tableau, il est traité comme un ledger vide (pas une erreur). Un JSON syntaxiquement cassé reçoit
exactement le même traitement : contrairement à config.json (`InvalidConfigError`) et state.json
(`InvalidJsonError`), un échec de parsing ici ne lève aucune erreur ni aucun exit code distinct ;
il est intercepté et ramené à un ledger vide, exactement comme un désaccord de forme. Le ledger
est une mémoïsation indicative, et un ledger malformé ou non parsable échoue toujours fermé vers
« pas consenti » (redemander), jamais ouvert par confiance.

### Champs d'entrée

| Champ         | Type   | Requis | Sens                                                                                                                                                         |
| ------------- | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`          | string | oui    | L'id d'entrée de catalog auquel la commande appartient, par exemple `tool:glab`.                                                                             |
| `commandHash` | string | oui    | Le digest hex sha256 de la chaîne de commande exacte qui a été approuvée.                                                                                    |
| `approvedAt`  | string | oui    | Horodatage ISO-8601 de l'approbation.                                                                                                                        |
| `sha`         | string | non    | Le [sha](/fr/reference/glossary/#sha) de provenance catalog au moment de l'approbation — audit seulement. Ne fait jamais partie de la clé de correspondance. |

La clé de correspondance est la paire `(id, commandHash)`. Changer la commande (même sous un sha
de catalog inchangé) redemande confirmation ; une commande inchangée reste consentie même si le
sha du catalog change en dessous. Un `sha` présent sur une entrée n'affecte jamais si elle
correspond. L'enregistrement est idempotent : une paire `(id, commandHash)` déjà présente est
laissée intacte, sans doublon ni mise à jour d'horodatage.

### Exemple

```json title="consent.json"
{
  "version": 1,
  "entries": [
    {
      "id": "tool:glab",
      "commandHash": "3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b",
      "approvedAt": "2026-07-16T09:12:00.000Z",
      "sha": "deadbeef"
    }
  ]
}
```

## Variables d'environnement

Cinq variables d'environnement sont lues par l'outil. Deux orientent où vivent les fichiers de
scope user, une contrôle la couleur, et deux alimentent la couche `env` de la config.

| Variable             | Lue pour                                                                                                                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RIGGER_HOME`        | Outrepasse le répertoire home utilisé pour chaque chemin de scope user. Prioritaire sur `HOME` ; voir l'ordre de résolution plus bas. Voir [RIGGER_HOME](/fr/reference/glossary/#rigger_home).                                                                                                                |
| `HOME`               | Le répertoire home utilisé quand `RIGGER_HOME` est absent ou vide.                                                                                                                                                                                                                                            |
| `NO_COLOR`           | Désactive la sortie couleur ANSI. Voir [NO_COLOR](/fr/reference/glossary/#no_color).                                                                                                                                                                                                                          |
| `RIGGER_SCOPE`       | Mappée dans le `defaultScope` de la couche `env` de la config (accepte `user` ou `project`), mais aucune commande ne lit le `defaultScope` résolu — voir [comment la config effective est résolue](#comment-la-config-effective-est-résolue). N'a aucun effet observable sur le scope qu'une exécution cible. |
| `RIGGER_AUTH_METHOD` | Définit `authMethod` via la couche `env` de la config. Accepte `provider-cli`, `https`, ou `ssh`.                                                                                                                                                                                                             |

### Résolution du home

Le répertoire home effectif pour chaque chemin de scope user est résolu dans cet ordre, la
première valeur non vide l'emportant :

1. `RIGGER_HOME` (une chaîne non vide).
2. `HOME` (une chaîne non vide).
3. Le répertoire home du système d'exploitation.

`RIGGER_HOME` est l'unique levier utilisé pour pointer l'outil vers un répertoire isolé. C'est
exactement ce que le [sandbox](/fr/start/sandbox/) définit, si bien que les vraies commandes ne
touchent jamais votre vrai `~/`.

### Couleur

La couleur n'est émise que quand la sortie standard est un vrai terminal **et** que `NO_COLOR`
est absent. Toute valeur définit la variable, donc `NO_COLOR=1` et `NO_COLOR=` désactivent tous
deux la couleur. Une décision explicite `--color`/`--no-color`, quand une commande l'expose, est
prioritaire sur cette auto-détection. Voir le [guide CI et scripts](/fr/guides/ci-and-scripts/)
pour le contrôle de la couleur dans un pipeline.

### Couche env de la config

`RIGGER_SCOPE` et `RIGGER_AUTH_METHOD` sont mappées dans la couche `env` de la config, au-dessus
des deux fichiers de config et en dessous des flags de ligne de commande. Une valeur vide ou qui
n'est pas l'un des littéraux acceptés est ignorée : elle n'efface jamais une valeur définie par un
fichier de config ou une couche inférieure.
