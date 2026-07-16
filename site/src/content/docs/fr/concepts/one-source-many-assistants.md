---
title: Une source, plusieurs assistants
description: "Pourquoi une règle ou un skill écrit une fois atteint à la fois Claude Code et opencode, correctement, sans être écrit deux fois : une seule forme canonique par artifact, traduite ou déléguée selon l'assistant, et le bridge AGENTS.md-vers-CLAUDE.md qui porte le context jusqu'à un assistant qui lit un fichier différent."
---

Vous écrivez une règle pour votre assistant IA une seule fois. Deux assistants la conservent
alors à des endroits différents et sous des formes différentes : l'un la veut dans un fichier à
un chemin précis, l'autre comme une clé dans un fichier de config au nom différent. Si vous
l'écriviez deux fois, une fois pour chacun, les deux copies se mettraient à diverger dès que vous
en modifieriez une en oubliant l'autre. agent-rigger permet à un seul artifact écrit d'atteindre
plusieurs assistants et de rester correct sur chacun, si bien qu'un même skill ou une même règle
est rédigé une fois et reste correct partout où il atterrit.

C'est le raisonnement derrière les pièces décrites ailleurs : les
[trois niveaux](/fr/concepts/core-concepts/) qu'il garde séparés, et les
[huit natures](/fr/concepts/artifact-natures/) qu'il installe. Ici la question est plus étroite :
pourquoi le _même_ artifact atterrit correctement sur Claude Code et sur opencode depuis une
seule source.

## Une forme écrite, traduite à l'arrivée

Chaque [artifact](/fr/reference/glossary/#artifact) existe sous une seule forme canonique. La
pièce qui sait comment un [assistant](/fr/reference/glossary/#assistant) donné la veut est un
[adapter](/fr/reference/glossary/#adapter) : à l'install, il rend la forme canonique dans la
forme native de cet assistant, en décidant où va le fichier et quel format il prend.

Un [agent](/fr/reference/glossary/#agent-sub-agent) est un _sous-agent_ : il montre la
traduction concrètement. Sur Claude Code, le fichier de définition est lié tel quel depuis le
[store](/fr/reference/glossary/#store), sans y toucher. opencode n'a pas de forme équivalente,
donc la même source voit son frontmatter traduit dans le schéma d'agent propre à opencode et
écrit comme un simple fichier. La liste `tools` que déclare un sous-agent Claude devient une
allow-list `permission` d'opencode qui refuse tout par défaut et ne réaccorde que les tools qui
trouvent une correspondance, avec un avertissement pour tout champ spécifique à Claude
qu'opencode n'a aucun moyen de représenter. Le résultat est un fichier rédigé une fois et rendu
de deux façons.

L'alternative consiste à figer un fichier séparé par assistant dans le catalog et à livrer les
deux. Elle a été écartée parce qu'elle oblige à garder N copies synchronisées à la main : on
édite la règle pour un assistant et les copies des autres prennent du retard sans bruit,
exactement le drift que l'outil existe pour empêcher. Garder une seule forme canonique et la
traduire à l'install supprime la seconde copie, donc il n'y a plus rien qui puisse prendre du
retard.

La traduction n'est pas gratuite partout : la nature [guardrail](/fr/reference/glossary/#guardrail)
est le seul endroit où l'outil ne traduit pas, parce que la forme `permission` d'opencode s'est
révélée insuffisante pour représenter fidèlement une règle deny Claude. Pour cette seule
nature, le catalog porte un descripteur opencode natif à côté de la règle Claude canonique,
chacun fusionné verbatim dans son assistant. Un descripteur natif fidèle a été jugé plus
précieux qu'une source unique, pour une frontière de sécurité qui doit être exacte.

## Déléguer l'install quand l'assistant sait déjà faire

Certains assistants embarquent leur propre installeur pour certains genres d'artifact. Claude
Code installe un [plugin](/fr/reference/glossary/#plugin) depuis n'importe quel dépôt git et
ajoute un [serveur MCP](/fr/reference/glossary/#mcp) via sa propre ligne de commande. Quand un
tel mécanisme existe, agent-rigger lui délègue le travail plutôt que de déplacer des fichiers
lui-même : la règle qu'il appelle [delegate-first](/fr/reference/glossary/#delegate-first).
[Natures d'artifact](/fr/concepts/artifact-natures/) explique pourquoi réimplémenter ce
mécanisme a été écarté ; ce qui compte pour une source unique, c'est ce qui traverse la
frontière vers lui. Pour un plugin, l'outil lance `claude plugin marketplace add` puis
`claude plugin install`, en résolvant le marketplace et le nom du plugin depuis la seule entrée
de catalog. Pour un serveur MCP, il lance `claude mcp add-json` avec un descripteur JSON rendu
depuis cette même entrée. Les lectures ne font jamais démarrer l'assistant ; seuls install et
remove l'appellent, et toute erreur que la commande native affiche est relevée verbatim.

La délégation n'est pas universelle. opencode n'a de commande d'install pour aucune des deux
natures, donc la même entrée plugin ou MCP y est configurée directement à la place : le
descripteur MCP se fusionne dans la clé `mcp` d'`opencode.json`, et le plugin est placé dans le
store puis lié par symlink, le même chemin qu'emprunte un skill. Qu'un adapter délègue ou
configure directement dépend de ce que l'assistant offre ; dans les deux cas, il lit depuis la
seule entrée canonique, jamais une seconde copie gardée pour cet assistant.
[Natures d'artifact](/fr/concepts/artifact-natures/) couvre le reste, ce qu'aucun assistant
n'installe jamais pour vous : les guardrails, le fichier context, et les
[hooks](/fr/reference/glossary/#hook), que l'outil écrit toujours lui-même.

## Le bridge, quand un seul fichier doit atteindre un assistant qui en lit un autre

Le cas le plus difficile est un simple fichier d'instructions permanentes. opencode et GitHub
Copilot lisent `AGENTS.md` nativement depuis la racine du projet. Claude Code, non : quand un
`CLAUDE.md` est présent, il le lit et ignore `AGENTS.md`. Un seul fichier canonique, et l'un des
trois assistants va le chercher ailleurs.

La solution retenue n'est pas de livrer un `AGENTS.md` et un `CLAUDE.md` séparé tenu à la main,
ce qui recréerait le drift à deux sources que toute la conception évite. `AGENTS.md` reste
plutôt canonique, et l'outil écrit dans `CLAUDE.md` un petit bloc managé qui l'importe. Le bloc
est délimité par des marqueurs, `<!-- BEGIN agent-rigger (managed — do not edit) -->` jusqu'à
`<!-- END agent-rigger -->`, et son unique rôle est de porter un import `@` de `AGENTS.md`.
L'écrire est idempotent : l'outil repère le bloc par ses marqueurs et le remplace en place, sans
jamais ajouter un second import quand un équivalent existe déjà. La cible de l'import est
portable plutôt qu'absolue — la forme tilde `~/.claude/harness/AGENTS.md` au scope `user`, et la
forme relative `../AGENTS.md` au scope `project` — si bien qu'un `CLAUDE.md` commité dans un
dépôt reste correct sur une autre machine ou après un clone neuf. Sur opencode, il n'y a pas un
tel bloc : le même `AGENTS.md` est écrit tel quel, parce qu'opencode le lit déjà.

Deux autres formes ont été envisagées puis écartées. Un fichier context propriétaire importé
partout échoue parce qu'opencode et Copilot ne lisent nativement aucun nom non standard.
`AGENTS.md` seul échoue dans l'autre sens : il n'atteint jamais Claude Code. Le bridge est le
seul arrangement qui atteint tous les assistants depuis un unique fichier rédigé, ce qui
explique pourquoi la source canonique est le fichier `AGENTS.md` standard et le bridge ce qui l'adapte à
Claude Code. (Copilot est reconnu mais n'a pas encore d'adapter ; le sélectionner échoue avec une
erreur claire.)

## Pourquoi le même artifact atterrit correctement sur les deux

Réunissez les trois idées et la réponse en découle. Un artifact est rédigé une fois, sous une
seule forme canonique. Pour chaque assistant, son adapter choisit le geste qui convient à la
nature : rendre la forme canonique en fichier natif, déléguer à un installeur natif que
l'assistant fournit déjà, ou écrire directement ce pour quoi l'assistant n'offre aucun
mécanisme. Le core n'est pas aveugle à l'assistant auquel il parle : il résout les chemins où
chacun écrit, et le bridge CLAUDE.md décrit plus haut est lui-même de la logique core, pas de la
logique adapter. Ce que le core ne conserve jamais, c'est une seconde copie du contenu d'un
artifact spécifique à un assistant ; cette étape de rendu reste dans l'adapter, une source
canonique en entrée et une forme native en sortie. Un skill ou une règle que vous avez écrit une
fois atteint donc Claude Code et opencode pareillement, et aucun des deux résultats ne peut
diverger de l'autre, parce qu'en dessous des deux il n'y a toujours qu'une seule source.

## Suite

- Découvrez ce que configure chaque genre d'artifact dans les
  [huit natures](/fr/concepts/artifact-natures/).
- Lisez comment l'outil garde [ce qui est disponible, installé, et sur le disque](/fr/concepts/core-concepts/)
  séparés, et détecte le drift entre eux.
- Cherchez n'importe quel terme dans le [glossaire](/fr/reference/glossary/).
