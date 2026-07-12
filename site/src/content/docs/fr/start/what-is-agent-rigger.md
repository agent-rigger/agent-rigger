---
title: Qu'est-ce qu'agent-rigger ?
description: Le problème que résout agent-rigger : la configuration des assistants IA d'une équipe qui dérive d'un poste à l'autre, et comment il garde cette configuration partagée, versionnée et reproductible.
---

Un assistant de code IA ne vaut que la configuration qui l'entoure : les skills
réutilisables que vous lui donnez, les actions que vous lui interdisez, les serveurs
auxquels vous le reliez, le contexte de projet qu'il lit. Sur un poste, cette
configuration demande un après-midi pour être bien réglée. Dans une équipe de dix, elle
est faite dix fois, un peu différemment à chaque fois.

Cette page explique à quoi sert agent-rigger, avant toute commande ou fichier de
configuration. Elle ne suppose aucune connaissance préalable de l'outil.

## Le problème : la configuration dérive

Imaginez une équipe dont tous les membres utilisent le même assistant. L'un écrit un skill
pratique et le garde pour lui. Un autre resserre une règle de permission après une
frayeur. Un troisième relie l'assistant à sa base de données via un
[serveur MCP](/fr/reference/glossary/#mcp-model-context-protocol). Rien de tout cela n'est
consigné dans un endroit partagé, si bien que chaque poste devient peu à peu un cas
particulier. Une nouvelle recrue part d'une configuration vide et recopie ce qu'elle peut
trouver. Quand quelque chose se comporte différemment d'un portable à l'autre, personne ne
peut dire pourquoi, car personne n'a la vue d'ensemble.

Cette lente divergence, c'est ce que nous appelons le
[drift](/fr/reference/glossary/#drift) : l'ensemble des réglages qui façonnent l'assistant
(son [harness](/fr/reference/glossary/#harness)) divergeant discrètement d'un poste à
l'autre, jusqu'à ce que « notre configuration » ne veuille plus rien dire de précis. Le
drift n'est pas une panne spectaculaire ; c'en est l'absence. Il ne fait que s'accumuler,
et le coût retombe plus tard, sur celui qui essaie de reproduire l'environnement d'un
coéquipier.

## Ce que change agent-rigger

agent-rigger existe pour faire du harness une chose partagée et versionnée plutôt qu'une
habitude personnelle.

L'équipe décrit une fois la configuration qu'elle a choisie, dans un
[catalog](/fr/reference/glossary/#catalog) : un dépôt git ordinaire qui liste les pièces
que l'équipe convient de partager et la façon dont elles se regroupent. Comme le
catalog est un dépôt git, on peut le relire, le taguer et revenir en arrière comme sur
n'importe quel autre code : la configuration de l'équipe gagne un historique et une source
unique de vérité.

À partir de là, chacun lance une commande pour installer cette configuration, une autre
pour vérifier qu'elle est toujours correctement en place, et une autre pour la mettre à
jour quand le catalog avance. Comme tout le monde applique la même source versionnée de
la même façon, tout le monde se retrouve avec le même harness. Un nouveau poste atteint le
socle de l'équipe en une étape, plutôt qu'à force d'archéologie.

L'outil lui-même est délibérément sans parti pris. Il n'embarque aucun skill, aucune règle,
aucun contenu. Il installe ce que votre catalog déclare, et rien d'autre. Le
jugement sur _ce qu'est une bonne configuration_ reste à votre équipe, dans votre catalog,
là où il peut être débattu et versionné.

## Comment il se comporte, et pourquoi

Deux choix de conception façonnent chaque exécution, et tous deux naissent de la même
inquiétude : un outil qui modifie les fichiers pilotant votre assistant doit gagner la
confiance à chaque usage.

**Il montre le changement avant de le faire.** Avant que quoi que ce soit ne soit écrit,
agent-rigger affiche un [plan](/fr/reference/glossary/#plan-dry-run) (les fichiers exacts
qu'il va toucher et les règles qu'il va ajouter) et attend votre confirmation. Vous
approuvez un changement que vous pouvez lire, pas la promesse que quelque chose de
raisonnable arrivera. Et parce que chaque install consigne précisément ce qu'elle a
modifié, tout changement peut être défait plus tard, hors ligne et à l'identique, plutôt
que deviné.

**Il traite le contenu d'un catalog comme [untrusted](/fr/reference/glossary/#untrusted-content) (non fiable) tant qu'il n'est pas contrôlé.** Un
catalog n'est qu'un dépôt git, et un dépôt git peut transporter n'importe quoi. Le contenu
récupéré est donc [scanné](/fr/reference/glossary/#scan--scanner) à la recherche de secrets
fuités et de misconfigurations avant même d'être copié à sa place, et un finding sérieux
arrête l'install. C'est un filet de sécurité honnête et borné, pas une garantie : les
scanners attrapent les erreurs d'inattention, pas un script écrit pour cacher ce qu'il
fait. Là où le contrôle ne peut pas être lancé du tout (parce que les outils de scan
optionnels ne sont pas installés), l'outil vous dit qu'il continue sans contrôle plutôt que
de prétendre avoir regardé.

Le fil conducteur : vous n'êtes jamais surpris par ce qu'agent-rigger a fait, et vous
pouvez toujours revenir en arrière.

## Ce qu'agent-rigger n'est pas

Ce n'est **pas un assistant IA**. Il n'écrit pas de code, ne répond pas aux questions et ne
parle à aucun modèle. Il configure les assistants que vous utilisez déjà, aujourd'hui
Claude Code et opencode.

Ce n'est **pas un magasin de contenu ni une marketplace**. Le binaire ne contient aucun
skill ni aucune règle à parcourir et télécharger. Tout ce qui est installable provient d'un
catalog vers lequel vous ou votre équipe le pointez. Il n'y a pas de bibliothèque centrale
de contenu officiellement validé ; il y a le catalog de votre équipe, et tous les autres catalogs auxquels
vous choisissez de faire confiance.

## À qui il s'adresse

agent-rigger vise les équipes qui partagent un assistant de code IA et sont lasses de voir
leurs configurations dériver : celles qui peinent à mettre en route un nouveau poste, ou
à déboguer des différences « ça marche chez moi » qui remontent à une règle de permission
que personne ne se souvient d'avoir changée. Un développeur solo peut s'en servir pour
garder sa propre configuration reproductible d'un portable à l'autre, mais le problème pour
lequel il a été construit est celui de l'équipe.

## La suite

- [Installez agent-rigger](/fr/start/installation/) sur votre poste.
- [Parcourez votre premier rig](/fr/start/getting-started/) en une dizaine de minutes.
- Lisez les [concepts fondamentaux](/fr/concepts/core-concepts/) derrière catalog, manifest
  et store.
