---
title: Installer depuis un catalog
description: Installez les artifacts d'un catalog configuré, en interactif ou par qualified id, choisissez le scope, et traitez les invites de scan et de vérification de tool du plan.
---

Vous avez un catalog configuré et vous voulez ses artifacts sur ce poste. Ce guide couvre le
sélecteur interactif, l'installation par id en une commande, le choix du scope, et les deux points de
décision que le plan peut vous soumettre. Pour un premier passage de bout en bout, voyez
[prise en main](/fr/start/getting-started/). Pour la liste complète des flags, voyez la
[référence `install`](/fr/reference/cli/install/).

<details>
<summary>Schéma : Le pipeline d'install</summary>

![Pipeline d'install : fetch (clone shallow au tag résolu en sha), scan avec gitleaks et trivy, resolve des requires et des packs, affichage du plan, confirmation humaine, sauvegarde des fichiers touchés en .bak-*, application des WriteOps, puis écriture du manifest — avec un finding de scan bloquant qui sort en exit 1 avant toute écriture et un plan refusé qui sort en exit 0.](../../../../assets/diagrams/install-pipeline.svg)

_Ce qu'un passage fait entre votre commande et le manifest, et les deux sorties qu'une décision peut prendre : un finding de scan bloquant s'arrête avant toute écriture (exit 1), et refuser le plan n'écrit rien (exit 0). <small>Généré depuis packages/cli/src/remote-install.ts, 2026-07-12.</small>_

</details>

## Installer en interactif

Lancez install sans id :

```
agent-rigger install
```

La commande demande le [scope](/fr/reference/glossary/#scope) (sauf si vous avez passé `--scope`),
puis affiche un sélecteur groupé qui classe chaque entrée par rapport à ce que vous avez déjà :

- **À installer** : les entrées pas encore installées.
- **À mettre à jour** : les entrées installées dans une version plus ancienne, présentées sous la
  forme `old → new`.
- **À jour (cocher pour réinstaller)** : les entrées déjà à jour. Laissées décochées ; n'en cochez
  une que pour forcer une réinstallation — un [pack](/fr/reference/glossary/#pack) dont tous les
  membres sont à jour atterrit ici aussi, et le cocher réinstalle chacun de ses membres.

Les lignes à mettre à jour sont toujours pré-cochées. Les lignes à installer le sont aussi, sauf si le
catalog déclare [`recommended`](/fr/reference/glossary/#recommended) : dès qu'il le fait, seules ses
entrées `required` et `recommended` démarrent cochées dans ce groupe, le reste étant listé décoché. La
touche Espace sur un en-tête de groupe bascule tout le groupe d'un coup — c'est le moyen de tout cocher
dans « À installer » quelle que soit l'opinion du catalog. Confirmez votre sélection, examinez le
[plan](/fr/reference/glossary/#plan-dry-run), puis approuvez-le pour écrire. Quand chaque entrée est
déjà à jour pour le scope choisi, install saute le sélecteur et vous le signale :

```
✓ Everything already up-to-date for scope "user" (N artifact(s) installed). Use `agent-rigger remove` to uninstall.
```

Un [pack](/fr/reference/glossary/#pack) lui-même n'est jamais enregistré comme installé : il se
développe en ses membres au moment de l'install. Mais sa ligne ici suit ces membres : à jour quand
chacun d'eux l'est, « À mettre à jour » quand l'un a divergé, « À installer » quand l'un manque.
Exception : un pack composé uniquement de [tools](/fr/reference/glossary/#tool), dont l'install n'est
pas encore trackée — sa ligne reste « À installer » quoi qu'il arrive.

## Installer des artifacts précis en une seule commande

Quand vous savez déjà ce que vous voulez, passez des [qualified ids](/fr/reference/glossary/#qualified-id)
de la forme `<catalog>/<nature>:<name>` :

```
agent-rigger install example/skill:hello-rigger example/agent:demo --yes
```

`--yes` saute l'invite de confirmation. Trouvez les ids exacts avec `agent-rigger ls`, dont la
première colonne est le qualified id :

```
Catalog (7 entries):
  [available]  example/skill:hello-rigger  skill
  [available]  example/agent:demo          agent
  [available]  example/guardrail:demo      guardrail
  [available]  example/pack:demo           pack       (2 members)
```

Un id nu est rejeté avant tout accès réseau :

```
[error] unqualified id "skill:hello-rigger" — use `<catalog>/skill:hello-rigger` (see `agent-rigger ls`)
```

De même pour un préfixe qui ne désigne aucun catalog configuré :

```
[error] catalog "<prefix>" not configured — see `agent-rigger catalog ls`
```

Sans `--yes`, la commande affiche le plan et attend votre confirmation :

```
--- Plan ---
Plan · 2 changes · scope: user (~/.claude)

+ example/skill:hello-rigger   ~/.claude/skills/hello-rigger
  link  ~/.claude/skills/hello-rigger → store

+ example/agent:demo   ~/.claude/agents/demo.md
  link  ~/.claude/agents/demo.md → store

Σ  2 links
```

## Choisir où ça atterrit

Passez `--scope` :

- `--scope user` (par défaut) : à l'échelle du poste, sous votre répertoire home.
- `--scope project` : le dépôt courant uniquement.

Si vous installez dans un projet qui est un dépôt git, le plan vous avertit avant d'écrire pour que
vous décidiez si ces fichiers ont leur place sous contrôle de version :

```
[warning] This directory is a git repo — files written here will appear
          in version control. Commit or .gitignore them intentionally.
```

## Quand le plan lève un avertissement de scan

Le contenu d'un catalog est [untrusted](/fr/reference/glossary/#untrusted-content) et
[scanné](/fr/reference/glossary/#scan--scanner) avant d'atteindre le disque. Deux issues demandent
une décision.

Aucun scanner installé : le scan ne peut pas s'exécuter, donc install continue et avertit.

```
[warning] content not scanned — install gitleaks or trivy then re-run for a full scan; see `rigger doctor`
```

Si vous voulez que le contenu soit scanné, installez gitleaks ou trivy, puis relancez.

Un scanner a trouvé quelque chose : avec un scanner présent et un finding réel, install s'arrête et
n'écrit rien.

```
Security scan blocked installation. Findings:
  - <finding>

Re-run with --force to install anyway.
```

Lisez d'abord le finding. Si c'est un faux positif que vous acceptez, relancez avec `--force` (voir
plus bas).

## Quand le plan liste une vérification de présence de tool

Si votre sélection entraîne un [tool](/fr/reference/glossary/#tool), le plan liste sa commande
`check` dans un bloc à part pour que vous puissiez lire la commande avant toute exécution :

```
--- Tool presence-checks (run after you confirm) ---
  <id>  →  <check command>
```

Confirmer le plan et accepter de lancer cette commande sont deux décisions distinctes. Après confirmation,
une seconde invite demande le [consent](/fr/reference/glossary/#consent) :

```
Run the following tool presence-checks?
```

L'accorder consigne la décision dans le consent ledger, si bien que la même commande sous le même id
n'est jamais redemandée. Sous `--yes`, confirmer le plan emporte ce consentement. Refusez-le et
aucune commande ne s'exécute : le tool est rapporté comme non vérifié et l'install se termine tout de
même.

## Quand `--force` est légitime

[`--force`](/fr/reference/glossary/#force) outrepasse un finding de scan bloquant et installe quand
même. N'y recourez qu'après avoir lu le finding et l'avoir jugé sans danger. Il n'élargit rien
d'autre :

- Il ne contourne pas un contrôle de provenance. Une divergence `ref`/`sha` refuse toujours l'install
  (exit `2`).
- Il ne crée pas un catalog manquant ni ne résout un id inconnu. Ces cas-là se corrigent, ils ne se
  forcent pas.

Pour ce que fait chaque étape et pourquoi le contenu est traité comme hostile, voyez
[confiance et sécurité](/fr/concepts/trust-and-security/).
