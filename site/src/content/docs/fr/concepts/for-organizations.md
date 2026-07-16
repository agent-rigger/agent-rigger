---
title: L'adopter pour une équipe
description: "Ce à quoi adopter agent-rigger engage une équipe : un outil générique et open source qui ne détient rien de vous, votre configuration gardée dans un dépôt qui vous appartient, un accès qui réutilise les identifiants git déjà présents sur chaque poste, et un seul fichier commité qui embarque tout le monde."
---

Avant qu'une équipe adopte un outil, quelqu'un doit répondre à une question simple qui n'est
pas vraiment technique : à quoi le faire entrer nous engage-t-il, et qu'est-ce qui, de chez
nous, finit à l'intérieur ? Pour agent-rigger, la réponse est courte. L'outil est gratuit et
son code source est ouvert, donc il n'y a pas de fournisseur avec qui signer ni de licence à
renouveler. Rien de votre équipe n'entre dans l'outil lui-même. Tout ce que votre équipe décide
de partager reste dans un endroit qui vous appartient, et l'outil ne fait que le lire. Cette
page s'adresse à la personne qui pèse cette décision, et elle reste à l'écart de la mécanique
que couvrent les autres pages de cette section.

## L'outil est générique, et son code source est ouvert

agent-rigger est publié sous licence Apache 2.0. C'est une licence open source permissive :
vous pouvez en lire chaque ligne et bâtir dessus sans rien demander. Aucun palier payant ne
verrouille une fonctionnalité dont vous auriez besoin, et il n'existe aucun compte que l'outil
contacterait en arrière-plan.

Aussi important que la licence : ce que l'outil ne contient _pas_. Il est livré comme un moteur
sans aucune configuration à lui. Aucune des règles, aucun des
[skills](/fr/reference/glossary/#skill), aucun [context](/fr/reference/glossary/#context) de
votre équipe n'est écrit dans le programme. L'alternative serait un outil qui arrive avec une
opinion déjà compilée en lui, que chaque équipe devrait ensuite accepter ou contourner.
agent-rigger prend la forme inverse : il sait _comment_ installer et mettre à jour une
configuration partagée, et reste délibérément ignorant de _ce qu'est_ cette configuration. Le
[raisonnement derrière un moteur qui ne porte aucun contenu](/fr/concepts/core-concepts/) a sa
propre page ; pour une décision d'adoption, c'est la conséquence qui compte. Rien de propre à
votre organisation ne vit dans un dépôt que n'importe qui peut lire, parce que cela ne vit
nulle part à proximité de l'outil.

## Votre configuration vit dans un dépôt qui vous appartient

Ce sur quoi votre équipe se standardise est décrit dans un
[catalog](/fr/reference/glossary/#catalog) : un dépôt git comme les autres, qui tient la liste
de ce que l'équipe partage. Ce dépôt est le vôtre. Vous l'hébergez à côté de votre autre code,
privé si vous le voulez privé, et vous contrôlez qui peut y pousser. L'outil le lit à la
dernière version que votre équipe a taguée et installe ce qu'il déclare, et la relation
s'arrête exactement là.

Garder votre configuration dans un dépôt que vous exploitez déjà, plutôt que de la téléverser
vers un service propre à l'outil, lui fait hériter des contrôles auxquels vous faites déjà
confiance. Les relectures passent par les mêmes merge requests que n'importe quel autre
changement, et l'accès suit les permissions que votre hébergeur git applique. Il n'y a pas de
second système qui détienne une copie de votre contenu, ni de nouvel endroit d'où elle
pourrait fuiter. La sélection standardisée que votre équipe applique à travers ce catalog est
son [rig](/fr/reference/glossary/#rig), et le rig se versionne et se restaure comme n'importe
quel autre dépôt que vous maintenez, et on en débat de la même façon.

## L'accès réutilise les identifiants déjà présents sur chaque poste

Un catalog privé demande une authentification, et l'inquiétude naturelle est qu'un nouvel
outil signifie un nouveau login à mettre en place sur chaque poste. Ce n'est pas le cas. Quand
vous pointez l'outil vers votre catalog pour la première fois, pendant la mise en place, il
essaie discrètement ce que git, sur ce poste, est déjà configuré pour utiliser. Si cela donne
déjà accès au dépôt, l'outil s'en sert et ne demande rien.

Ce n'est que lorsque cette tentative discrète échoue que l'outil demande comment se connecter,
en proposant les méthodes standard qu'un développeur a en général sous la main : une session
`gh` ou `glab` où quelqu'un est déjà connecté, ou une clé SSH. Il configure la méthode que
vous choisissez et retient ce choix. Bâtir sur les identifiants qu'un développeur possède
déjà, plutôt qu'émettre son propre token, a été un choix délibéré face à l'alternative d'un
login maison. Un login maison serait un secret de plus à stocker, dont il faudrait organiser
la rotation dans toute l'équipe, et une chose de plus qui peut fuiter. L'outil ne stocke de ce
fait aucun secret en propre. Là où une pièce de votre configuration a réellement besoin d'une
valeur secrète, le catalog y fait référence
[par le nom d'une variable d'environnement](/fr/reference/glossary/#secret-by-environment-reference-var)
plutôt que par sa valeur, si bien que la valeur elle-même n'atterrit jamais dans un fichier
que l'outil écrit.

## Un seul fichier commité embarque toute l'équipe

La partie qui compte le plus pour une équipe est qu'aucun développeur n'a à configurer son
poste à la main. Un fichier de config au [scope](/fr/reference/glossary/#scope) project,
`.agent-rigger/config.json`, peut être commité dans le propre dépôt de l'équipe. Quand il est
présent, chaque poste qui récupère ce dépôt lit le même fichier et résout les mêmes catalogs,
sans définition des sources personne par personne. C'est livré et cela fonctionne aujourd'hui.

L'alternative est celle que tout le monde connaît : un document d'installation que chaque
nouvel arrivant suit, en se trompant légèrement et chacun à sa façon, si bien que les postes
divergent avant que quiconque le remarque. Commiter la configuration transforme ce document en
un fichier que l'outil lit directement, ce qui signifie que les sources de l'équipe sont
définies dans un seul endroit relu, au lieu d'être ressaisies sur chaque portable. Changer
l'endroit d'où l'équipe tire sa configuration, c'est changer un fichier commité, vu et relu
comme n'importe quel autre.

## Ce qui a été installé, et d'où, est consigné

L'adoption doit souvent satisfaire une question de gouvernance en plus de la question
pratique : pourrons-nous rendre compte plus tard de ce qui est sur un poste et d'où cela
vient ? agent-rigger enregistre, pour chaque [artifact](/fr/reference/glossary/#artifact)
qu'il installe, de quel catalog il provient et le commit exact auquel il a été pris. Une
étiquette de version peut être re-pointée plus tard ; un commit, non. C'est cet enregistrement
qui rend une install auditable après coup. Comment l'outil épingle une version à un commit
exact et refuse un contenu qui n'est pas la version qu'il prétend être est le sujet de
[versions et provenance](/fr/concepts/versioning-and-provenance/), la page où un relecteur de
gouvernance devrait aller ensuite.

## La posture de sécurité, en bref

Parce que l'outil installe des fichiers qui orientent le comportement d'un
[assistant](/fr/reference/glossary/#assistant) IA, et qu'il les récupère depuis un dépôt où
quelqu'un peut pousser, il traite tout contenu récupéré comme
[untrusted](/fr/reference/glossary/#untrusted-content) par défaut, votre propre catalog
compris. Il [scanne](/fr/reference/glossary/#scan--scanner) tout avant que quoi que ce soit
n'atterrisse quand les outils de scan sont présents sur le poste ; quand ils manquent, il avertit que le
contenu n'a pas été scanné plutôt que de refuser d'installer. Avant d'écrire quoi que ce soit,
il vous montre un [plan](/fr/reference/glossary/#plan-dry-run) et attend une confirmation, et
il refuse un contenu dont le commit ne correspond pas à la version vers laquelle il a été
résolu. Il nomme aussi ses propres limites sans détour : un scanner trouve des secrets fuités
et des misconfigurations, pas un script écrit pour cacher ce qu'il fait. Le modèle complet,
énoncé avec les frontières qu'il ne franchit pas, est sur la page
[confiance et sécurité](/fr/concepts/trust-and-security/), que quiconque évalue l'outil pour
une équipe devrait lire avant de décider.

## Ce qui n'est pas livré : un build d'organisation zéro configuration

Il n'existe aujourd'hui aucun moyen, pour une organisation, de distribuer son propre build
d'agent-rigger avec le catalog et la méthode d'accès déjà intégrés, de sorte qu'une nouvelle
recrue installe un binaire et se retrouve entièrement équipée sans la moindre configuration.
La machinerie de configuration de l'outil réserve une couche exactement pour un tel
[preset](/fr/reference/glossary/#preset), et la fusionne sous vos réglages project et user,
mais rien dans la ligne de commande ne remplit jamais cette couche. C'est une disposition de
l'architecture, pas une fonctionnalité en état de marche.

L'onboarding qui _est_ livré, c'est le fichier de config project commité décrit plus haut, qui
donne déjà à une équipe une définition unique et partagée de ses sources. Une équipe peut
adopter agent-rigger aujourd'hui sur cette base. Le build d'organisation zéro configuration
est une direction que le design laisse ouverte, et rien de plus que cela pour l'instant.

## Suite

- Lisez la [séparation entre moteur et contenu](/fr/concepts/core-concepts/) qui garde l'outil
  générique et votre configuration à vous.
- Lisez [versions et provenance](/fr/concepts/versioning-and-provenance/) pour la façon dont
  une install devient auditable.
- Lisez [confiance et sécurité](/fr/concepts/trust-and-security/) pour le modèle de sécurité
  complet et ses limites.
- Cherchez n'importe quel terme dans le [glossaire](/fr/reference/glossary/).
