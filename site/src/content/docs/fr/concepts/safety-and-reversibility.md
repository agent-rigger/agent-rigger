---
title: Sûreté et réversibilité
description: "Pourquoi tout ce qu'agent-rigger écrit sur votre poste peut être défait : vous voyez le changement avant qu'il n'ait lieu, l'ancien fichier est conservé, l'install enregistre exactement ce qu'elle a changé, relancer ne fait rien de nouveau, et deux exécutions à la fois ne peuvent pas se corrompre l'une l'autre."
---

agent-rigger modifie des fichiers sur votre poste pour que votre assistant IA adopte une
configuration partagée. Chaque changement qu'il fait à ces fichiers peut être repris : vous voyez
le changement avant qu'il n'ait lieu, l'ancienne version de chaque fichier est conservée, et le
relevé de ce qu'une install a fait est assez précis pour être défait étape par étape.

## Deux questions séparées : est-ce sûr d'accepter, et puis-je le défaire

Un outil qui édite la configuration de votre assistant affronte deux risques distincts, et il
vaut la peine de les garder séparés. Le premier est de savoir si le contenu qui arrive d'un
[catalog](/fr/reference/glossary/#catalog) est digne de confiance : un dépôt sur lequel quelqu'un
peut pousser peut transporter un secret fuité ou une commande hostile. Décider ce qui a le droit
d'atteindre votre disque en premier lieu, le scan et le consent, c'est le sujet de
[confiance et sécurité](/fr/concepts/trust-and-security/). Cette page traite du second risque, qui
ne commence qu'une fois que l'outil a décidé d'écrire : une fois qu'il touche un fichier, tout ce
qu'il a écrit peut-il être défait. Une protection contre l'arrivée de mauvais contenu ne dit rien
sur la capacité à annuler un changement une fois qu'il est fait, donc les deux sont bâties
séparément, et cette page les prend l'une après l'autre.

## Rien n'est écrit avant que vous ne l'ayez vu

Avant qu'une install ou une suppression ne touche le moindre fichier, l'outil assemble un
[plan](/fr/reference/glossary/#plan-dry-run) : l'ensemble exact des fichiers qu'il écrirait et des
règles qu'il fusionnerait, plus les blocs qu'il ajouterait. Il affiche ce plan et s'arrête là.
Rien n'est appliqué avant votre confirmation.

L'alternative est d'écrire d'abord et de montrer un diff ensuite, comme le font certains outils
qui appliquent puis rapportent ce qu'ils ont fait. Cette approche a été écartée parce qu'un
changement qu'on ne peut lire qu'une fois posé est un changement qu'il faut défaire pour le
refuser. Montrer le plan d'abord fait que refuser ne coûte rien : vous déclinez l'invite et la
machine est exactement comme avant.

La confirmation est aussi le point de départ de l'histoire de la réversibilité, parce qu'un
changement que vous avez approuvé les yeux ouverts est un changement que vous comprenez déjà assez
bien pour le défaire.

## L'ancienne version est conservée avant d'être écrasée

Quand l'outil doit écraser un fichier déjà existant — un `settings.json` dans lequel il fusionne
une règle, ou un `AGENTS.md` qu'il édite — il copie d'abord l'ancien contenu à côté sous un nom
[`.bak-<horodatage>-<token>`](/fr/reference/glossary/#backup-bak). Cette copie est écrite avant
que le nouveau contenu n'atterrisse, via une écriture en deux temps qui renomme la copie terminée
à sa place, si bien qu'une exécution interrompue à mi-chemin ne laisse jamais un backup tronqué
qui a l'air complet. Le fichier de récupération est soit l'original complet, soit absent — jamais
un état intermédiaire corrompu.

Le nom porte un horodatage et un court token aléatoire plutôt qu'un `.bak` fixe. Un nom fixe
unique forcerait l'outil à sonder l'existence d'un backup déjà présent et soit à refuser, soit à
l'écraser ; le token aléatoire fait que deux backups du même fichier ne peuvent pas entrer en
collision, même au sein d'une même exécution, et aucune boucle de sondage n'est nécessaire.
L'outil garde ces copies plutôt que de les effacer de lui-même, avec ce raisonnement : un fichier
de récupération que l'outil pourrait supprimer n'est pas un fichier sur lequel vous pouvez
compter. [doctor](/fr/reference/glossary/#doctor) fait remonter les plus vieux sous sa classe de
finding `hygiene` pour que vous les voyiez s'accumuler, mais les supprimer reste votre décision.

Ces backups sont aussi ce qui permet à une install partiellement terminée de s'annuler
elle-même. Si un artifact d'un lot échoue en cours d'écriture, le moteur restaure depuis son
backup chaque fichier qu'il avait déjà écrasé et supprime ceux qu'il venait de créer, puis relève
l'erreur d'origine, si bien qu'une install en échec ne laisse pas la machine à moitié changée.

## L'install enregistre exactement ce qu'elle a changé

Si un `remove` ultérieur peut défaire une install proprement, c'est parce que l'install a consigné
précisément ce qu'elle a fait.

Chaque entrée du [manifest](/fr/reference/glossary/#manifest) porte un
[applied payload](/fr/reference/glossary/#applied-payload) : les mutations résolues que l'install
a faites, comme les règles deny et allow ajoutées à un fichier de settings, le contenu canonique
écrit dans `AGENTS.md`, le [bloc d'import](/fr/reference/glossary/#agentsmd-bridge) ajouté à
`CLAUDE.md` pour que l'assistant le lise, et le hook enregistré. `remove` lit ce payload et rejoue
chaque mutation à l'envers.

Enregistrer le payload, plutôt que de re-dériver ce qu'il faut défaire au moment de la
suppression, c'est ce qui permet à `remove` de fonctionner hors ligne et à l'identique. Deux
alternatives ont été pesées puis écartées. La première était de re-récupérer le catalog à la
suppression, pour que l'outil puisse recalculer ce qu'une entrée donnée installe ; cela lie la
suppression au réseau et à l'existence du catalog toujours à la même version, une dépendance
qu'une suppression n'a aucune raison de porter. La seconde était de stocker un diff textuel ligne
par ligne de chaque fichier, comme le ferait un système de contrôle de version. Mais ces mutations
sont des opérations structurées à l'inverse connu : retirer une règle d'un array fusionné et
retirer un bloc délimité s'annulent tous deux proprement, tout comme désenregistrer un hook. Un
patch texte n'apporte rien ici et serait plus difficile à appliquer sans risque contre un fichier
que quelqu'un a depuis édité à la main.

Comme les mutations sur un array de settings sont fusionnées avec des règles venues d'autres
sources, l'outil ne peut pas savoir, en regardant seulement le fichier, quelles entrées de l'array
lui appartiennent. L'applied payload est ce qui comble cet écart : il nomme les règles précises
que cette install a apportées, si bien que la suppression ne reprend que celles-ci et laisse
celles des autres en place. Pour un fichier context, le payload va un cran plus loin et conserve
le contenu du fichier tel qu'avant la première install, si bien que retirer l'artifact restaure ce
texte d'origine plutôt que de simplement supprimer le fichier.

## Lancer la même install deux fois ne change rien

Demandez à l'outil d'installer un artifact déjà correctement en place, et il ne fait rien plutôt
que d'en installer une seconde copie. Le plan d'un artifact déjà conforme revient vide, et un plan
vide est un no-op : rien n'est écrit, aucun backup fait, aucune nouvelle entrée de manifest. C'est
l'[idempotence](/fr/reference/glossary/#idempotence), et elle compte pour la réversibilité parce
que réparer un [drift](/fr/reference/glossary/#drift) revient à relancer l'install, et une
réparation qui dupliquerait ou orphelinerait des règles à chaque fois manquerait son but.

Une réinstall qui a réellement du travail à faire, parce qu'un fichier a été édité ou qu'une règle
a disparu, ne planifie que la partie manquante. Si l'outil enregistrait seulement ce changement
partiel comme payload complet, un `remove` ultérieur ne reprendrait que la dernière réparation et
laisserait orphelines les règles des exécutions précédentes. L'applied payload d'une entrée
s'accumule donc à travers les exécutions plutôt que d'être remplacé : l'outil fusionne le travail
nouveau dans le payload déjà enregistré, gardant le manifest comme un relevé complet de tout ce
que l'entrée a posé, quel que soit le nombre d'exécutions que cela a pris.

## Deux exécutions à la fois ne peuvent pas se corrompre l'une l'autre

Une exécution unique lit le manifest au démarrage et le garde en mémoire pendant qu'elle
travaille, ce qui peut inclure des étapes externes lentes comme installer un plugin via la
commande propre de l'assistant. Ce n'est qu'à la fin qu'elle réécrit la mise à jour. L'écriture
elle-même est atomique, si bien qu'aucun lecteur ne voit jamais un manifest à moitié écrit. Cela
seul n'empêche pas une seconde exécution, démarrée dans un autre terminal ou par un hook qui
réinvoque la CLI, d'écrire sa propre copie par-dessus celle de la première et de faire
silencieusement disparaître une entrée que la première venait d'enregistrer. Une entrée perdue
n'est pas un problème cosmétique : elle laisse un artifact qui ne peut plus être supprimé, parce
que la suppression lit le manifest.

Pour empêcher cela, l'outil prend un [run-lock](/fr/reference/glossary/#run-lock) autour de la
fenêtre où il écrit. Le verrou est un fichier créé à côté du manifest par un appel système de
création exclusive, si bien que c'est le système d'exploitation, pas l'outil, qui décide laquelle
de deux exécutions concurrentes gagne ; le perdant n'attend pas et ne réessaie pas, il échoue vite
et affiche, mot pour mot :

```
Another agent-rigger run is in progress (pid 12345). The lockfile is "/home/you/.config/agent-rigger/state.json.lock". Wait for it to finish and retry; if you are sure no run is active, delete the lockfile by hand.
```

Le verrou enregistre le processus qui le détient. Une exécution qui a planté laisserait sinon son
lockfile derrière elle pour toujours, donc un verrou n'est traité comme abandonné et cassé que
lorsque son âge dépasse un timeout et que le processus qui l'a écrit a disparu — les deux à la
fois. Juger sur les deux ensemble est délibéré : une install légitime de longue durée, dont le
processus est vivant mais dont le verrou a vieilli, n'est jamais cassée, et un crash très récent
attend l'expiration du timeout pour qu'un pid réutilisé ne puisse pas déclencher un cassage à
tort.

Deux choix de design méritent d'être nommés. Le verrou ne cadre que la fenêtre d'écriture, pas la
commande entière, donc il est pris après que vous ayez confirmé le plan ; une exécution laissée en
attente à une invite de confirmation ne détient rien et ne bloque personne. Et parce que casser un
verrou abandonné est lui-même faillible, l'outil ne s'appuie pas sur le seul verrou. Juste avant
d'écrire, il relit le manifest depuis le disque et rejoue ses propres changements sur ce qu'il y
trouve, si bien qu'une entrée qu'une autre exécution a validée entretemps survit même si un verrou
a été cassé par erreur. Une commande read-only comme `check` ne prend aucun verrou : elle n'écrit
rien, donc il n'y a rien à sérialiser.

## Les limites, dites franchement

La réversibilité ne vaut la peine d'être revendiquée que si ses limites sont nommées.

- **Le run-lock protège deux exécutions d'agent-rigger l'une de l'autre, pas contre un écrivain
  extérieur.** Si l'assistant lui-même réécrit son `settings.json` pendant que l'outil détient le
  verrou, le verrou n'y peut rien. Sa portée, ce sont les exécutions concurrentes de cet outil sur
  une même machine.
- L'avertissement affiché quand un verrou périmé est cassé n'atteint pas encore toutes les
  commandes aujourd'hui. `remove` l'affiche ; `install`, la commande dont les exemples de cette
  page se servent, casse un verrou périmé identique en silence. Le contrôle de péremption
  lui-même — âge dépassant le timeout et processus disparu — s'exécute de la même façon dans tous
  les cas ; seul l'avis diffère.
- Une réinstall qui échoue à mi-chemin est défaite pour rester orphan-safe, pas octet pour octet.
  Les fichiers qu'elle a écrasés sont restaurés depuis leurs backups, et tout ce qu'une install
  fraîche avait créé est supprimé. Mais quand l'exécution en échec réinstallait un artifact déjà
  suivi, les répertoires managés qu'elle a touchés ne sont pas restaurés à leur contenu antérieur ;
  ils sont recréables en relançant l'install, donc la récupération consiste à relancer, pas à
  s'attendre à retrouver les octets d'avant.
- Les étapes déléguées ne peuvent pas toujours être défaites complètement. Quand l'install est
  confiée à la commande propre de l'assistant, pour un plugin par exemple, la désinstallation
  compensatoire est best-effort et ne défait pas tout ce que la commande déléguée a fait, comme
  enregistrer un marketplace. L'outil rapporte ce qu'il n'a pas pu défaire plutôt que de prétendre
  l'avoir fait.
- Un fichier que vous avez édité à la main est laissé tel quel, pas réécrit en arrière. Quand la
  suppression devrait restaurer un fichier context à son texte d'avant l'install mais que le
  fichier a depuis drifté par rapport à ce que l'outil avait enregistré, l'outil laisse votre
  version en place plutôt que d'écraser votre édition. La réversibilité ne signifie jamais que
  l'outil reprend silencieusement un fichier que vous avez fait vôtre.

## Suite

- Voyez comment le contenu est jugé avant que rien de cette écriture ne commence, dans
  [confiance et sécurité](/fr/concepts/trust-and-security/).
- Lisez comment l'outil sépare ce qui est disponible, installé, et sur le disque dans
  [concepts fondamentaux](/fr/concepts/core-concepts/).
- Voyez les [exit codes](/fr/reference/exit-codes/) auxquels un script réagit, y compris une
  exécution qui a échoué parce qu'une autre était en cours.
- Cherchez n'importe quel terme dans le [glossaire](/fr/reference/glossary/).
