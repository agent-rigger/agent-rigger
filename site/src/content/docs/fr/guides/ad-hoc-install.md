---
title: Installer depuis une URL ou un chemin local
description: Installez une source d'artifact unique en ad-hoc depuis une URL git ou un chemin local, lisez le préfixe de provenance dérivé, et sachez ce qu'impliquent le scan et l'absence de suivi pour les mises à jour.
---

Vous voulez du contenu qui vit en dehors de vos catalogs configurés : un dépôt git, le fork d'un
collègue, ou un dossier sur disque sur lequel vous itérez encore. `install` prend directement une
URL git ou un chemin local, sans étape `catalog add` intermédiaire. Pour le flux appuyé sur un
catalog, voyez [installer depuis un catalog](/fr/guides/install-from-catalog/) ; pour la surface
complète des flags, voyez la [référence `install`](/fr/reference/cli/install/).

Une seule cible ad-hoc par invocation. `install` traite un argument comme une source ad-hoc dès
qu'il contient `://`, commence par `git@`, se termine par `.git`, commence par `./`, `/`, ou `~/`,
ou débute par `github.com/`, `gitlab.com/`, ou `bitbucket.org/`. Tout le reste est lu comme un
[qualified id](/fr/reference/glossary/#qualified-id).

## Installer depuis une URL git

Passez l'URL de clone. Dans un script ou toute session
[non-interactive](/fr/reference/glossary/#tty--non-interactive), ajoutez `--yes` (sans lui
l'exécution sort en `2` avant tout fetch, voir
[interactif vs non-interactif](#interactif-vs-non-interactif)) :

```
rigger install https://github.com/agent-rigger/agent-rigger-catalog-example.git --yes
```

Le contenu est récupéré, [scanné](#le-contenu-est-scanné), puis affiché comme un
[plan](/fr/reference/glossary/#plan-dry-run) avant que quoi que ce soit ne soit écrit :

```
--- Plan ---
Plan · 7 changes · scope: user (~/.claude)

+ gh-agent-rigger-catalog-example/skill:hello-rigger   ~/.claude/skills/hello-rigger
  link  ~/.claude/skills/hello-rigger → store

+ gh-agent-rigger-catalog-example/agent:demo   ~/.claude/agents/demo.md
  link  ~/.claude/agents/demo.md → store

...

Σ  deny +4 · allow +1 · 1 write · 1 import · 1 hook · 2 links

--- Warnings ---
  [warning] this remote guardrail widens permissions.allow: Read(./.env.example)

--- Result ---
  [ok] Applied 7 file(s).
```

## Installer depuis un chemin local

Indiquez un répertoire à la place. Un chemin absolu, un chemin relatif en `~/`, ou un chemin relatif en
`./` fonctionnent tous :

```
rigger install /path/to/agent-rigger-catalog-example --yes
```

Le plan se lit pareil, seul le préfixe de [provenance](#le-préfixe-de-provenance) diffère :

```
+ local-agent-rigger-catalog-example/skill:hello-rigger   ~/.claude/skills/hello-rigger
  link  ~/.claude/skills/hello-rigger → store
```

## Le préfixe de provenance

Une source ad-hoc n'a pas de nom de catalog, donc `install` en dérive un depuis la source et
l'enregistre dans le [manifest](/fr/reference/glossary/#manifest) comme préfixe d'id. L'ensemble des
règles est énuméré dans la [référence `install`](/fr/reference/cli/install/#les-trois-modes) ; les
formes que vous verrez :

- `github.com/<owner>/<repo>` → `gh-<repo>`
- `gitlab.com/<owner>/<repo>` → `glab-<repo>`
- un autre hôte `<host>/<owner>/<repo>` → `<host-without-TLD>-<repo>`
- un chemin local → `local-<name>`

Ce préfixe n'est que de la provenance. Une install ad-hoc n'enregistre **pas** de catalog source,
donc `rigger catalog ls` et `rigger ls` continuent de rapporter
`no catalog configured` ensuite. Ce que vous avez obtenu, et d'où, vit dans le manifest sous l'id
dérivé.

## Le contenu est scanné

Une source ad-hoc est du [contenu untrusted](/fr/reference/glossary/#untrusted-content) : chaque
fichier récupéré est [scanné](/fr/reference/glossary/#scan--scanner) avant d'atteindre le disque,
exactement comme le serait une install de catalog. Il n'y a aucun moyen de sauter le scan pour une
source ad-hoc.

Si un scanner (gitleaks ou trivy) est installé et rapporte un finding, l'install s'arrête et n'écrit
rien. Lisez le finding, et seulement si vous le jugez faux positif, relancez avec
[`--force`](/fr/reference/glossary/#force) pour le rétrograder en avertissement et poursuivre.
`--force` n'élargit rien d'autre : une divergence de provenance ou un id de path-traversal refuse
toujours l'install.

Si aucun scanner n'est installé, le scan ne peut pas s'exécuter. L'install se poursuit et le
signale :

```
[warning] content not scanned — install gitleaks or trivy then re-run for a full scan; see `rigger doctor`
```

Si exactement l'un de gitleaks/trivy est installé et ne trouve rien, le scan ne couvre que la
moitié du terrain : l'install se poursuit et l'avertissement nomme l'outil manquant (un finding
bloquant de l'outil qui a tourné prime toujours sur cet avertissement) :

```
[warning] content partially scanned — trivy not installed (gitleaks ran); install trivy then re-run for a full scan; see `rigger doctor`
```

Pour ce que cherche le scan et pourquoi le contenu ad-hoc est traité comme hostile, voyez
[confiance et sécurité](/fr/concepts/trust-and-security/).

## Interactif vs non-interactif

Avec un TTY et sans `--yes`, `install` ouvre un sélecteur bloquant pour choisir quelles entrées de
la source installer, puis vous demande de confirmer le plan. Les deux étapes exigent un vrai
terminal.

Sans TTY, il n'y a pas de sélecteur : `--yes` est obligatoire et sélectionne **toutes** les entrées
que la source propose. C'est une sélection intégrale délibérée sur du contenu untrusted, ce qui
explique que le scan ne soit pas optionnel. Omettez `--yes` en session non-interactive et
l'exécution sort en `2`
avant tout accès réseau (le contrat non-interactif complet vit dans
[CI et scripts](/fr/guides/ci-and-scripts/)) :

```
[error] non-interactive session — pass --yes to confirm non-interactively
```

## Les installs ad-hoc ne sont pas trackées pour les mises à jour

Comme aucun catalog n'est enregistré, `update` n'a rien à résoudre et refuse, exit `2` :

```
[error] No catalog URL configured.
  Run `rigger init` to configure the catalog URL.
```

`check` ne refuse pas de la même façon. Comme `ls` et `catalog ls`, il traite un catalog manquant
comme une information plutôt qu'une erreur, et sort en `0` :

```
no catalog configured — run `rigger init`
```

Pour rafraîchir un artifact ad-hoc, relancez le même `install <url|path> --yes` : il re-récupère et
ré-applique. Pour désinstaller, utilisez [`remove`](/fr/guides/remove-artifacts/) avec le qualified
id dérivé (remove est hors ligne et lit le manifest, donc le préfixe dérivé lui suffit) :

```
rigger remove gh-agent-rigger-catalog-example/agent:demo --yes
```

Pour une source que vous voulez suivre dans le temps, ajoutez-la plutôt comme catalog
(`rigger catalog add <name> <url>`) et installez par qualified id, ce qui garde `update` et
`check` fonctionnels. Voyez [installer depuis un catalog](/fr/guides/install-from-catalog/), et
[travailler avec plusieurs catalogs](/fr/guides/multiple-catalogs/) si cela en fait votre deuxième
source.
