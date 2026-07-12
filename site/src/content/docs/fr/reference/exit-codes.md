---
title: Codes de sortie
description: Le contrat 0 / 1 / 2 / 3 / 130 que renvoie chaque commande d'agent-rigger, les erreurs typées derrière chaque code, et comment les lire en CI.
---

Chaque commande renvoie l'un des cinq [exit codes](/fr/reference/glossary/#exit-code). Le sens d'un
code donné est identique d'une commande à l'autre : un script peut donc se brancher sur le numéro
sans savoir quelle commande l'a produit.

## Les cinq codes

| Code  | Sens                                        | Que faire                                                                                                                              |
| ----- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `0`   | Succès, ou un no-op délibéré.               | Rien. L'exécution a fait ce que vous demandiez, ou vous avez refusé et rien n'a changé.                                                |
| `1`   | Échec d'exécution ou d'environnement.       | Réessayez, ou corrigez l'environnement (réseau, auth, un verrou détenu). La requête était valide ; quelque chose d'extérieur a échoué. |
| `2`   | La commande était erronée.                  | Corrigez la commande et relancez. Rien n'a été écrit.                                                                                  |
| `3`   | `check` ou `doctor` a trouvé quelque chose. | Lisez le rapport. Un finding manquant, drifté ou hors état, pas une erreur.                                                            |
| `130` | Interrompu par Ctrl+C.                      | Rien n'a été écrit au-delà du point d'interruption.                                                                                    |

### 0 : succès ou refus

`0` couvre deux cas : la commande s'est terminée, ou on vous a demandé de confirmer et vous avez
refusé. Refuser un plan, ne rien sélectionner dans un sélecteur, ou un `check` qui trouve tout
présent sortent tous en `0`. Rien n'a été écrit sur le chemin du refus.

### 2 : corrigez votre commande

`2` désigne une requête que l'outil ne lancera pas telle quelle : une faute de frappe, un argument
malformé, ou une précondition manquante qu'il ne peut fournir à votre place. Rien n'est écrit. Les
rejets avant toute exécution ne récupèrent rien non plus : un flag ou une commande inconnus, un
[id non qualifié](/fr/reference/glossary/#qualified-id), un `--scope`/`--assistant` invalide, une
session [non-interactive](/fr/reference/glossary/#tty--non-interactive) sans `--yes`, une `install`
sans id en session non-interactive (son sélecteur a besoin d'un TTY, `--yes` seul n'y change rien),
ou aucun [catalog](/fr/reference/glossary/#catalog) configuré pour une install. Deux autres
conditions de `2` surviennent après une récupération (une incohérence de provenance ref/sha, un
secret MCP required non résolu sous `--yes`), mais n'écrivent toujours rien.

### 1 : réessayez ou corrigez l'environnement

`1` est l'échec d'exécution : la requête était légitime mais quelque chose d'extérieur a cassé. Une
récupération de catalog qui a échoué sur le réseau ou l'auth, une autre exécution détenant le
[run-lock](/fr/reference/glossary/#run-lock), ou un [scan](/fr/reference/glossary/#scan--scanner) de
sécurité qui a bloqué une install renvoient tous `1`. Exception :
[`doctor`](/fr/reference/cli/doctor/) n'échoue pas sur un verrou détenu : il saute le scan de l'état
installé (ses findings seraient transitoires) et sort en `0`.

### 3 : l'exception check/doctor

`check` et `doctor` sont des audits : « trouver un problème » est donc une issue normale. Ils
renvoient `3` quand ils trouvent quelque chose : pour `check`, une entrée absente du disque ou
[driftée](/fr/reference/glossary/#drift) par rapport à son état enregistré ; pour `doctor`, un ou
plusieurs findings. `3` n'appartient qu'à eux. Aucune autre commande ne le renvoie.

### 130 : Ctrl+C

Appuyer sur Ctrl+C à n'importe quelle invite interrompt l'exécution avec `130` (128 + SIGINT). C'est
distinct d'un refus (`0`) et d'un échec d'exécution (`1`) : cela signifie que l'opérateur a
interrompu, si bien qu'un script peut distinguer une interruption d'une exécution terminée ou
échouée. Une unique ligne d'annulation est affichée.

## Erreurs typées et leurs codes

Les échecs reconnus correspondent à un code stable et un message qui indique quoi faire. Le tableau liste la
condition observable plutôt que le nom d'erreur interne.

| Condition                                   | Code  |
| ------------------------------------------- | ----- |
| Ancien format de configuration              | `2`   |
| JSON invalide dans un fichier lu            | `2`   |
| Manifest malformé (forme de premier niveau) | `2`   |
| Id d'artifact inconnu                       | `2`   |
| Artifact non installé (remove)              | `2`   |
| Cycle de dépendances dans le catalog        | `2`   |
| `requires` cross-catalog non installé       | `2`   |
| Incohérence de provenance ref/sha           | `2`   |
| Id d'artifact dangereux (path traversal)    | `2`   |
| `opencode.json` invalide                    | `2`   |
| Valeur `--secret-env` malformée             | `2`   |
| Secret MCP required non résolu (non-TTY)    | `2`   |
| Install sans id en session non-TTY          | `2`   |
| Échec de récupération ou de clone distant   | `1`   |
| Le scan de sécurité a bloqué l'install      | `1`   |
| Échec de l'authentification (init)          | `1`   |
| Une autre exécution détient le verrou       | `1`   |
| Artifact deny canonique manquant ou vide    | `1`   |
| Scan de skill bloqué                        | `1`   |
| Échec d'install de plugin                   | `1`   |
| Toute autre erreur inattendue               | `1`   |
| Invite annulée (Ctrl+C)                     | `130` |

Une incohérence de provenance est `2`, pas `1` : le [ref](/fr/reference/glossary/#ref) et le
[sha](/fr/reference/glossary/#sha) enregistrés ne concordent plus, la requête est donc refusée avant
toute écriture. [`--force`](/fr/reference/glossary/#force) ne change jamais cela : il outrepasse un
finding de scan, pas un contrôle de provenance.

## En CI et scripts

Les exécutions non-interactives doivent passer [`--yes`](/fr/reference/glossary/#yes) pour toute
commande qui confirmerait, sinon elles sortent en `2` avant de toucher le réseau — `install` a en
plus besoin d'ids explicites, car son sélecteur ne peut pas s'ouvrir sans TTY. `2` signifie que
l'invocation était erronée ; `1` signifie que l'environnement a fait échouer une requête valide.
Seuls `check` et `doctor` produisent `3` ; pour toute autre commande, tout code non nul est un échec.

Pour le garde-fou non-interactif, un verrou anti-drift et le contrôle de la couleur, voir
[En CI et scripts](/fr/guides/ci-and-scripts/).
