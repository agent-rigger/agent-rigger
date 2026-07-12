---
title: Confiance et sécurité
description: "Pourquoi agent-rigger traite chaque catalog comme du contenu untrusted, le vôtre compris : ce qu'il fait pour cela, et où ses protections s'arrêtent."
---

agent-rigger installe des fichiers qui gouvernent le comportement de votre assistant IA, et il
les récupère depuis un dépôt git où quelqu'un peut pousser. Cela rend le contenu untrusted par
défaut, votre propre [catalog](/fr/reference/glossary/#catalog) compris : un seul compte
compromis suffit à changer ce qu'une équipe entière installe. Ce qui suit est le modèle de
confiance bâti sur cette hypothèse, énoncé avec ses limites, parce qu'une protection que vous
surestimez est pire qu'une protection que vous comprenez.

## L'hypothèse de départ : le contenu du catalog est untrusted

Tout ce que transporte un catalog distant est traité comme hostile jusqu'à vérification : les
fichiers d'artifact, `catalog.json` lui-même, et les chaînes de commande `check` qu'il
déclare. Cela vaut même pour un catalog maintenu par votre propre équipe. Le but n'est pas de
se méfier de vos collègues mais de survivre au cas où un compte est détourné ou un dépôt
altéré. De cette seule hypothèse, l'[untrusted content](/fr/reference/glossary/#untrusted-content),
découle le reste du modèle.

## Rien n'atterrit sur le disque sans être scanné

Avant que tout contenu récupéré ne soit copié en place, il est
[scanné](/fr/reference/glossary/#scan--scanner) par des outils externes : gitleaks pour les
secrets fuités, trivy pour les misconfigurations. Le scan couvre tout le contenu récupéré sans
exception, `catalog.json` compris, puisqu'un secret codé en dur dans le fichier de catalog ou
une chaîne `check` hostile est exactement le genre de chose qu'un attaquant y placerait. Un
finding bloquant — tout secret fuité, ou une misconfiguration high/critical — bloque l'install.
Le scan constitue une porte unique, franchie avant que rien ne soit copié en place, si bien
que le contenu untrusted n'atterrit jamais d'abord pour être vérifié ensuite.

## Rien ne s'exécute sans confirmation, et le consent est granulaire

Deux protections distinctes couvrent l'exécution.

D'abord, chaque install montre un [plan](/fr/reference/glossary/#plan-dry-run) et attend que
vous confirmiez avant de rien écrire. Vous approuvez un changement que vous pouvez lire.

Ensuite, la commande `check` d'un catalog est du shell arbitraire, issu de contenu untrusted.
Confirmer le plan d'install n'est pas en soi un consentement à lancer ces commandes, donc ce
consentement est demandé séparément et mémorisé dans un ledger, `consent.json`, indexé par le
couple de l'id de l'artifact et de la chaîne de commande exacte. Une commande inchangée sous
le même id n'est jamais redemandée ; changez la commande ou l'id et le consentement est
redemandé, même si la version du catalog est inchangée. Ce que la correspondance ignore, c'est
le sha du catalog : changer seulement la version du catalog ne déclenche jamais de nouvelle
demande, tandis que modifier ce qui s'exécute réellement exige toujours une nouvelle approbation.

## Les symlinks dans le contenu cloné sont rejetés

Le contenu cloné depuis un catalog est refusé, avant que le moindre fichier ne soit écrit,
s'il est un symlink ou en contient un. La raison est précise : les scanners ne suivent pas les
symlinks, donc un lien malveillant comme `secret -> ~/.ssh/id_rsa` passe le scan sans être
détecté. S'il était alors copié dans le [store](/fr/reference/glossary/#store), le propre symlink
de l'install ré-exposerait le chemin hôte visé. C'est un rejet dur, fail-closed, fait avant
que le contenu fautif ne soit touché.

## Les secrets par référence, jamais par valeur

Un catalog ne stocke jamais une valeur de secret. Là où un secret est nécessaire, la config
porte une [référence d'environnement](/fr/reference/glossary/#secret-by-environment-reference-var)
à la forme exacte `${VAR_NAME}`. Une valeur littérale dans l'un de ces champs est rejetée au
parsing du catalog, avant même qu'un scanner ne s'exécute, si bien que la fuite est fermée au
point le plus précoce possible. À l'install, l'outil vérifie seulement que la variable est
présente, puis écrit la forme de référence propre à l'assistant dans la config ; la vraie
valeur n'est jamais écrite dans aucun fichier que l'outil produit. L'assistant lui-même lit la
variable au démarrage du serveur, si bien qu'une rotation du secret prend effet sans réinstall. À
l'install, vous faites correspondre la référence à une vraie variable avec `--secret-env`.

## La provenance est re-vérifiée après le clone

Une version est résolue d'un [tag](/fr/reference/glossary/#tag) en un
[sha](/fr/reference/glossary/#sha) exact avant le clone. Après le clone, l'outil confronte le
commit réellement sur le disque au sha qu'il a résolu. S'ils diffèrent, l'install est refusée.
Cela ferme deux vecteurs réels : une branche partageant un nom avec un tag (git clone préfère
la branche, donc le mauvais contenu arriverait sous le nom du tag), et un tag re-poussé vers
un commit différent entre la résolution et le clone.

Ce contrôle n'est pas une décision de politique de scan, et `--force` ne le contourne pas. Un
sha non concordant n'est pas du contenu non scanné : c'est du contenu qui n'est pas la version
que le [manifest](/fr/reference/glossary/#manifest) s'apprête à affirmer qu'il est. Le message
d'échec le dit, mot pour mot : `Installation refused — this check cannot be bypassed with --force.`

## Les limites, énoncées franchement

Un modèle de sécurité n'est honnête que s'il nomme ce qu'il ne fait pas.

- **Sans scanner installé, l'outil ne peut pas scanner.** Plutôt que de bloquer chaque install
  sur un hôte qui se trouve sans gitleaks ni trivy, il bascule en
  [warn-only](/fr/reference/glossary/#warn-only) : l'install se poursuit, un avertissement vous
  dit que le contenu n'a pas été scanné, et [doctor](/fr/reference/glossary/#doctor) fait
  remonter l'état dégradé ensuite. C'est une exception délibérée au défaut fail-closed, parce
  que les scanners sont des dépendances optionnelles. Cela signifie aussi qu'une install faite
  sur un tel hôte n'a fait l'objet d'aucun scan.
- **Un scanner n'attrape pas un script malveillant.** gitleaks et trivy trouvent des
  identifiants fuités et des misconfigurations, pas une intention. Un script écrit pour cacher
  ce qu'il fait, par exemple un `curl … | sh` obfusqué, leur échappe. Vous restez
  responsable des catalogs que vous configurez et du contenu que vous acceptez.
- **Sur opencode, un deny `read` est de la défense en profondeur, pas un mur.** Les sous-agents
  opencode invoqués via l'outil Task contournent les règles deny `read` et `grep` (opencode
  issue #32024). Traitez le côté lecture d'un guardrail comme une couche plutôt qu'une garantie
  qu'un secret est illisible. Les deny `edit` et `external_directory` ne sont pas affectés.

## Ce que `--force` couvre, et ne couvre pas

[`--force`](/fr/reference/glossary/#force) outrepasse un finding de sécurité bloquant et
installe quand même. C'est un choix délibéré et explicite d'accepter un risque de scan en
connaissance de cause, et c'est l'unique dérogation à la porte fail-closed sur les findings.

<details>
<summary>Schéma : Les portes de confiance</summary>

![Les portes de confiance que le contenu récupéré franchit avant toute écriture, dans l'ordre d'exécution : provenance (sha du HEAD re-vérifié contre le sha résolu, refus en exit 2), scan (gitleaks et trivy, finding bloquant en exit 1 ou warn-only quand aucun scanner n'est installé), confirmation du plan, et consent par commande enregistré dans un ledger — avec --force qui ne couvre que la porte de scan, jamais la porte de provenance.](../../../../assets/diagrams/trust-gates.svg)

_Les portes que chaque artifact récupéré franchit avant qu'un octet soit écrit. `--force` n'outrepasse que la porte de scan ; la re-vérification de provenance n'est jamais contournable. <small>Généré depuis packages/core/src/scan.ts, packages/catalog/src/fetch.ts, packages/core/src/consent.ts, packages/cli/src/remote-install.ts, 2026-07-12.</small>_

</details>

Cela s'arrête là. `--force` ne déroge pas à la re-vérification de provenance : un contenu dont
le sha ne correspond pas à son ref résolu est refusé quoi qu'il arrive. Ainsi `--force` vous
laisse installer un contenu auquel le scanner s'est opposé, sous votre responsabilité. Il ne
vous laisse jamais installer un contenu qui n'est pas la version qu'il prétend être.

## Suite

- Voyez comment un `check` en échec renvoie des [exit codes](/fr/reference/exit-codes/)
  auxquels un script peut réagir.
- Cherchez n'importe quel terme dans le [glossaire](/fr/reference/glossary/).
