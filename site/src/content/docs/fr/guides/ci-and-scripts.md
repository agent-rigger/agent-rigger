---
title: Utiliser en CI et dans des scripts
description: Lancez agent-rigger en non-interactif avec --yes, appuyez-vous sur le contrat d'exit code, verrouillez un pipeline sur check pour le drift, et contrôlez la couleur avec NO_COLOR.
---

Vous voulez agent-rigger dans un pipeline ou un script shell, où personne ne peut répondre à une
invite. Ce guide couvre le garde-fou non-interactif, le contrat d'exit code sur lequel vous appuyer, un
verrou anti-drift bâti sur `check`, et le contrôle de la couleur. Pour le tableau de codes faisant
foi et les erreurs typées derrière chaque code, voyez [exit codes](/fr/reference/exit-codes/).

## Toujours passer `--yes` pour une commande qui écrit

Toute commande qui demanderait confirmation (install, update, remove) a besoin de `--yes` en
l'absence de [TTY](/fr/reference/glossary/#tty--non-interactive). Sans lui, la commande sort avec `2`
avant tout accès réseau, si bien qu'un job mal configuré échoue vite au lieu de rester bloqué sur une
invite à laquelle il ne peut répondre :

```
[error] non-interactive session — pass --yes to confirm non-interactively
```

`--yes` pré-approuve les seules confirmations sûres. Il ne couvre jamais une réparation destructrice
de doctor, qui est demandée item par item et n'est jamais accordée en bloc.

## Testez l'exit code, pas la sortie

Chaque commande renvoie l'un des cinq [exit codes](/fr/reference/glossary/#exit-code). Testez le
nombre : le texte de sortie est écrit pour des humains et peut changer, les codes sont le contrat.

| Code  | Dans un script                                                    |
| ----- | ----------------------------------------------------------------- |
| `0`   | Continuer. Succès, ou no-op délibéré.                             |
| `1`   | Réessayer, ou corriger l'environnement.                           |
| `2`   | Corriger l'invocation. Rien n'a été écrit.                        |
| `3`   | Lire le rapport. Un finding d'audit (check/doctor), pas un crash. |
| `130` | Interrompu par Ctrl+C. Rien n'a été écrit au-delà.                |

Seuls `check` et `doctor` renvoient `3`. Pour toute autre commande, tout code non nul est un échec.

## Verrouiller un pipeline sur le drift

`check` est le verrou d'audit : `0` signifie que le harness correspond à son état enregistré, `3`
qu'il a [drifté](/fr/reference/glossary/#drift), `2` que l'audit n'a pas pu s'exécuter. Ses sections
indicatives catalog et update ne changent jamais le code. Un verrou qui fait échouer le build sur le
drift :

```sh {4}
agent-rigger check
case $? in
  0) echo "harness in sync" ;;
  3) echo "drift detected; run agent-rigger update"; exit 1 ;;
  *) echo "check failed"; exit 1 ;;
esac
```

`check` n'écrit rien et n'exécute aucune commande de catalog, mais il atteint bien le réseau en
lecture seule pour résoudre le statut du catalog. Donnez au job des identifiants git pour votre
catalog.

## Garder une install de provisioning idempotente

Une install non-interactive doit nommer les [qualified ids](/fr/reference/glossary/#qualified-id) à
installer. La forme sans id se rabat sur le sélecteur de scope interactif et le sélecteur groupé,
réservés au TTY : sous `--yes` sans TTY, ils n'ont aucune réponse et la commande se bloque. Épinglez
donc toujours les ids dans un script :

```
agent-rigger install example/skill:hello-rigger example/agent:demo --yes
```

Relancer cette commande exacte sur un poste déjà à jour est un no-op qui sort avec `0`. La CLI
affiche cette ligne indentée de deux espaces dans un bloc `--- Result ---` ; elle est alignée à
gauche ici :

```
[ok] Already up to date — nothing to install.
```

Une étape de provisioning peut donc être relancée sans risque à chaque démarrage.

## Contrôler la couleur

agent-rigger ne colore sa sortie que sur un vrai terminal, un pipeline est donc déjà sans couleur.
Pour forcer une sortie sans couleur n'importe où (par exemple en capturant les logs d'un TTY vers un
fichier),
définissez [`NO_COLOR`](/fr/reference/glossary/#no_color) :

```
NO_COLOR=1 agent-rigger check
```
