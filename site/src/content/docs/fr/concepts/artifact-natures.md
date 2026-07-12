---
title: Natures d'artifact
description: "Les huit genres de chose qu'agent-rigger installe (skill, agent, guardrail, context, plugin, mcp, tool, hook), racontés par ce que chacun configure, et la ligne advisory/enforcement qui les traverse."
---

Le comportement d'un assistant est façonné par de nombreuses petites pièces de configuration :
une capacité qu'on lui confie, une action qu'on lui interdit, un serveur auquel on le relie,
un fichier d'instructions permanentes qu'il lit. agent-rigger range tout ce qu'il installe en
huit genres, appelés [natures](/fr/reference/glossary/#nature). Chaque nature configure une
partie différente de l'assistant et s'installe à sa propre manière. Cette page explique à quoi
sert chacune, et la distinction qui compte le plus quand vous décidez laquelle employer.
Elle ne détaille pas où chaque nature écrit sur chaque assistant et chaque scope — cette carte
par assistant et par scope relève de la section de référence, pas d'ici.

## La ligne qui compte le plus : conseiller ou contraindre

La distinction la plus nette entre les natures oppose le conseil à la contrainte.

Un artifact [context](/fr/reference/glossary/#context) est _advisory_. Ce sont des
instructions que l'assistant lit et suit d'ordinaire mais peut outrepasser, comme un collègue
lit un guide de style et s'y conforme la plupart du temps. Sa forme canonique est le fichier
`AGENTS.md`. Un [guardrail](/fr/reference/glossary/#guardrail) est de l'_enforcement_. C'est
une règle qui bloque durement une action via le mécanisme de permission propre à l'assistant :
une entrée `permissions.deny` dans le `settings.json` de Claude Code, ou une clé `permission`
dans la config d'opencode.

La différence décide où une règle a sa place. « Préférer cette bibliothèque à celle-là » est un
conseil et va dans un artifact context, parce que l'assistant doit le mettre en balance et peut avoir
une bonne raison de s'en écarter. « Ne jamais lancer cette commande destructrice » est une
frontière et va dans un guardrail, parce que le modèle peut raisonner pour contourner un
conseil, tandis que le mécanisme refuse une règle deny d'emblée. Mettre une frontière dure
dans un context la laisserait à l'état de suggestion ; mettre une préférence souple dans un
guardrail bloquerait un travail que l'assistant a légitimement besoin de faire.

agent-rigger gère les guardrails directement, à la main, plutôt que par un plugin. La raison
tient en un point : sur Claude Code, une règle deny est la seule chose qu'aucun plugin d'assistant
ne peut porter seul. Cet angle mort est au cœur de ce que l'outil doit faire lui-même.

## Les capacités que vous confiez à l'assistant : skill et agent

Un [skill](/fr/reference/glossary/#skill) est une capacité réutilisable empaquetée au format
cross-vendor `SKILL.md`. Il est installé une fois dans le [store](/fr/reference/glossary/#store)
managé et exposé à chaque assistant via un [symlink](/fr/reference/glossary/#symlink), si bien
qu'une seule copie les sert tous.

Un [agent](/fr/reference/glossary/#agent-sub-agent) est un _sous-agent_ : un assistant
spécialisé auquel l'assistant principal peut confier une tâche ciblée, défini dans un unique
fichier Markdown. Sa manière d'être installé dépend de l'assistant. Sur Claude Code, le
fichier est lié de façon opaque depuis le store, comme l'est un skill. Sur opencode, il n'y a
pas de forme partagée équivalente, donc son frontmatter est traduit dans le schéma d'agent
propre à opencode et écrit comme un simple fichier — ni stocké ni lié.

### Le piège `agent` / `AGENTS.md`

Ces deux-là se ressemblent et n'ont aucun rapport. La nature `agent` est un sous-agent, un
auxiliaire que l'assistant peut appeler. `AGENTS.md` est un simple fichier d'instructions, et
il relève de la nature `context`. Une règle que vous voulez garder en permanence sous les yeux
de l'assistant va dans un artifact context, qui peut écrire `AGENTS.md`. Un auxiliaire
spécialisé auquel l'assistant peut déléguer est un artifact agent. Se tromper de sens installe
le mauvais genre de chose.

## Ce que certains assistants savent installer : plugin et mcp

Un [plugin](/fr/reference/glossary/#plugin) regroupe hooks et commandes pour un assistant. Un
artifact [mcp](/fr/reference/glossary/#mcp) déclare un serveur que l'assistant peut atteindre
pour des capacités supplémentaires. Là où un assistant embarque son propre mécanisme
d'installation pour ces natures, agent-rigger suit une règle qu'il nomme
[delegate-first](/fr/reference/glossary/#delegate-first) : plutôt que de copier des fichiers à
la main, il lance la commande propre à l'assistant. Sur Claude Code, cela signifie
`claude plugin install` pour un plugin et `claude mcp add-json` pour un serveur mcp.

La raison est que réinventer un installeur que l'assistant fournit déjà reviendrait à
maintenir une seconde copie, plus pauvre, vouée à diverger du vrai mécanisme à mesure que
l'assistant évolue.

Tous les assistants n'offrent pas un tel mécanisme. opencode n'a pas de commande d'install
pour l'une ou l'autre nature, donc agent-rigger configure les deux directement : un serveur
mcp est fusionné dans la clé `mcp` d'`opencode.json` — un serveur préexistant du même id est
laissé intact — et un plugin est un module JS/TS fourni par le catalog, placé dans le store et
exposé par un symlink, le même chemin store-and-link qu'emprunte un skill. La délégation est
la règle quand l'assistant fournit le mécanisme ; la configuration directe est le repli quand
il ne le fournit pas. Ce qu'aucun assistant ne gère nativement — guardrails, context, hooks —
l'outil le fait toujours lui-même.

Un serveur MCP a souvent besoin d'un token pour atteindre son service. Le catalog ne stocke
jamais cette valeur. Il porte une
[référence d'environnement](/fr/reference/glossary/#secret-by-environment-reference-var) à la
forme exacte `${VAR_NAME}`. À l'install, l'outil vérifie que la variable est présente et écrit
la forme de référence propre à l'assistant, et l'assistant lit la vraie valeur au démarrage du
serveur, si bien que rien de ce que l'outil produit ne contient jamais la valeur elle-même. La
page [confiance et sécurité](/fr/concepts/trust-and-security/) explique pourquoi.

## Un programme que le harness suppose présent : tool

Un [tool](/fr/reference/glossary/#tool) est un programme en ligne de commande tiers dont le
[harness](/fr/reference/glossary/#harness) dépend, comme `gh`, `glab` ou `terraform`. Un
harness s'appuie souvent sur des programmes qu'il n'installe pas lui-même ; les déclarer comme
artifacts tool transforme cette supposition tacite en quelque chose d'explicite et de
vérifiable. Une entrée tool liste comment l'installer par gestionnaire de paquets — `brew`,
`npm`, `pnpm` ou `mise` — et une commande `check` pour détecter s'il est déjà là.

Aujourd'hui, la nature `tool` vérifie seulement la présence. Elle lance la commande `check` et
rapporte si le programme est sur votre `PATH` ; un tool manquant vous est rapporté, pas
récupéré. La raison est que l'installer reviendrait à lancer un gestionnaire de paquets à
votre place, un acte plus intrusif et moins réversible que de signaler une absence, donc cette
étape est délibérément laissée de côté pour l'instant plutôt que faite sans qu'on le demande.

## Les commandes qui se déclenchent sur des events de cycle de vie : hook

Un [hook](/fr/reference/glossary/#hook) est une commande que l'assistant lance
automatiquement à un moment de son cycle de vie : avant un appel d'outil, à la soumission d'un
prompt, etc. Chaque hook se déclenche sur un **event** de cycle de vie, restreint par un
**matcher** qui décide quelles actions le déclenchent.

Les hooks n'existent que là où l'assistant fournit le mécanisme. Aujourd'hui, cela signifie
Claude Code seul : opencode n'a pas d'équivalent qu'agent-rigger cible, donc un artifact hook
s'applique à Claude Code uniquement. L'ensemble complet des events auxquels un hook peut se
lier vit dans le [schéma de catalog](/fr/reference/catalog-schema/), la liste canonique qui
reste alignée sur ce que l'assistant prend en charge.

## Où chaque nature atterrit

<details>
<summary>Schéma : Où chaque nature atterrit</summary>

![Où chaque des huit natures atterrit par assistant. Claude Code : skill et agent en store plus symlink, guardrail et hook dans settings.json, context en bloc d'import CLAUDE.md plus AGENTS.md, plugin et mcp délégués au CLI natif, tool vérifié en présence seulement. opencode : skill et plugin en store plus symlink, agent écrit en frontmatter traduit, guardrail et mcp fusionnés dans opencode.json, context en AGENTS.md, hook non supporté, tool vérifié en présence seulement.](../../../../assets/diagrams/nature-targets.svg)

_Le mécanisme d'écriture qu'utilise chaque nature, par assistant — hook est réservé à Claude Code, et tool n'est que vérifié en présence, jamais installé. Les chemins exhaustifs par scope relèvent de la référence. <small>Généré depuis packages/adapters/src/{claude,opencode}/, 2026-07-12.</small>_

</details>

## Suite

- Lisez le [schéma de catalog](/fr/reference/catalog-schema/) pour les champs que chaque nature
  déclare.
- Comprenez pourquoi le contenu récupéré est traité comme untrusted dans
  [confiance et sécurité](/fr/concepts/trust-and-security/).
