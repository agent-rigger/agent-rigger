---
title: Changelog
description: "Un instantané daté du changelog d'agent-rigger : le format qu'il suit, les changements enregistrés à ce commit, et où vit la version mise à jour en continu."
---

Cette page est un instantané du changelog du projet à un instant donné, gardé ici pour que vous
puissiez lire ce qui a changé sans quitter la documentation. Elle n'est pas la source : la section
suivante dit contre quel commit elle a été écrite et où vit le fichier vivant.

## Un instantané, pas la source

Le contenu ci-dessous a été écrit le **2026-07-16**, contre le commit `9cc8d2d`, et chaque entrée
a été vérifiée contre le code à ce commit. Le changelog vivant, mis à jour en continu, est
[`CHANGELOG.md` dans le dépôt](https://github.com/agent-rigger/agent-rigger/blob/main/CHANGELOG.md).
Pour tout ce qui est plus récent que cette date, commencez par ce fichier ; cette page s'arrête à
l'instantané.

## Le format qu'il suit

Le changelog est écrit dans le style [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) :
les changements sont groupés par type (Added, Changed, Fixed, et ainsi de suite) sous un titre par
release, la plus récente en tête. Les versions suivent
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) : `MAJOR.MINOR.PATCH`.

agent-rigger est **pré-1.0**. Sous semver, cela signifie que la ligne `0.x` ne fait aucune
promesse de stabilité entre versions mineures : tout peut changer entre `0.1` et `0.2`, et mieux
vaut lire le changelog avant de mettre à jour plutôt que de supposer qu'une montée mineure est
sans risque.

## Où en est le projet aujourd'hui

La dernière release taguée est **v0.1.2**. Elle est installable dès maintenant — via Homebrew, un
binaire de release GitHub préconstruit ou un build depuis les sources — comme décrit sur la page
[Installation](/fr/start/installation/). Un build depuis les sources affiche `0.0.0` comme
version, ce qui est cosmétique : la vraie version n'est estampillée depuis le tag git que lors du
build de release.

Le changelog garde ses entrées sous un unique titre **Unreleased** plutôt que dans un découpage
par version. La section ci-dessous restitue ce que ce titre couvrait à cet instantané.

## Unreleased

### Added

Les commandes qui composent l'outil, chacune documentée en entier sur sa propre page de
référence :

- [**`check`**](/fr/reference/cli/check/) — un audit en lecture seule des
  [guardrails](/fr/reference/glossary/#guardrail) et du [context](/fr/reference/glossary/#context)
  installés contre leur état enregistré. Il signale le
  [drift](/fr/reference/glossary/#drift) et sort avec `3` quand il trouve une entrée manquante ou
  driftée, `0` quand tout correspond, et `2` quand un fichier dont il a besoin est du JSON
  invalide. Voir les [exit codes](/fr/reference/exit-codes/) pour le contrat partagé.
- [**`install`**](/fr/reference/cli/install/) — un sélecteur interactif, ou `install <id…>` pour
  un ensemble nommé. Il résout les [packs](/fr/reference/glossary/#pack) et les dépendances,
  affiche un plan groupé par [artifact](/fr/reference/glossary/#artifact), prend un backup avant
  d'écrire, et n'écrit jamais sans confirmation (`--yes` saute l'invite).
- [**`remove`**](/fr/reference/cli/remove/) — désinstalle des artifacts avec un plan réversible,
  des backups et le même `--yes`.
- [**`update`**](/fr/reference/cli/update/) — réinstalle les artifacts externes dont la version
  distante est plus récente que celle installée.
- [**`init`**](/fr/reference/cli/init/) — configure une URL de
  [catalog](/fr/reference/glossary/#catalog) et l'authentification. Il sonde d'abord l'auth
  ambiante et ne persiste la configuration qu'en cas de succès.
- [**`ls`**](/fr/reference/cli/ls/) — liste les entrées de catalog à travers toutes les sources de
  catalog configurées, avec leur statut d'install.
- [**`doctor`**](/fr/reference/cli/doctor/) — indique les dépendances externes détectées et le
  mode de [scan](/fr/reference/glossary/#scan--scanner) actif.

Et les capacités sous ces commandes :

- **Plusieurs catalogs** — [`catalog add`](/fr/reference/cli/catalog/) branche des catalogs
  nommés, et les installs sont routées vers la bonne source par un préfixe d'id qualifié. Le
  guide [travailler avec plusieurs catalogs](/fr/guides/multiple-catalogs/) le parcourt pas à pas.
- **Install distante avec provenance** — les artifacts externes enregistrent le vrai
  [ref](/fr/reference/glossary/#ref) et le vrai [sha](/fr/reference/glossary/#sha) auxquels ils
  ont été récupérés, et le contenu récupéré est scanné avant d'atterrir sur le disque quand un
  scanner est présent. La façon dont la version est épinglée et re-vérifiée est couverte dans
  [versions et provenance](/fr/concepts/versioning-and-provenance/) ; la frontière de scan, et ce
  qui se passe sans scanner installé, dans
  [confiance et sécurité](/fr/concepts/trust-and-security/).
- **Apply transactionnel** — un échec partiel est annulé depuis les backups pris avant
  l'écriture, si bien qu'une exécution interrompue ne laisse pas un
  [harness](/fr/reference/glossary/#harness) à moitié modifié. Voir
  [sûreté et réversibilité](/fr/concepts/safety-and-reversibility/) pour les garanties et leurs
  limites.

### Invariants

Quatre propriétés tiennent à travers chaque commande : une install répétée ne change rien la
deuxième fois (idempotence), un backup est pris avant toute écriture, un humain confirme avant
que quoi que ce soit ne soit écrit, et rien n'échoue silencieusement. Ce que chacune couvre, et
où passent ses limites, est expliqué dans
[sûreté et réversibilité](/fr/concepts/safety-and-reversibility/).

## Où vit le texte qui fait foi

- [`CHANGELOG.md`](https://github.com/agent-rigger/agent-rigger/blob/main/CHANGELOG.md) — le
  changelog vivant, mis à jour à chaque changement. Cette page en est une restitution datée et
  vérifiée.
- L'[historique des commits sur `main`](https://github.com/agent-rigger/agent-rigger/commits/main)
  — l'enregistrement complet de ce qui a changé et quand, au-delà de ce qu'un changelog résume.
