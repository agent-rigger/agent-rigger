---
title: Diagnostiquer votre installation
description: Lancez doctor pour lire un rapport sain, provoquer et lire un finding, réparer les cas sûrs avec --fix sous consentement, et vérifier les sources distantes avec --remote.
---

Vous voulez savoir si votre harness installé correspond toujours à son état enregistré, et le
réparer sinon. Ce guide fait tourner `doctor` sur une seule tâche : lire un rapport propre,
provoquer un finding exprès, puis le réparer sous consentement. Pour une première installation,
voyez [prise en main](/fr/start/getting-started/). Pour la surface complète des flags et chaque
classe de [finding](/fr/reference/glossary/#finding), voyez la
[référence `doctor`](/fr/reference/cli/doctor/).

## Lire un rapport sain

Lancez doctor sans flag :

```
agent-rigger doctor
```

Il lance deux diagnostics dans l'ordre. La phase 1 liste les outils externes dont agent-rigger
dépend et le mode de scan qu'ils vous donnent ; la phase 2 lit l'état installé et rapporte tout ce
qui a [drifté](/fr/reference/glossary/#drift). Sur un poste où les scanners sont présents et rien
n'est cassé, le run entier est court :

```
--- agent-rigger doctor ---

✓ git (/opt/homebrew/bin/git)
✓ glab (/opt/homebrew/bin/glab)
✓ gitleaks (/opt/homebrew/bin/gitleaks)
✓ trivy (/opt/homebrew/bin/trivy)

mode : full scan

Installed state is healthy — no findings.
```

La ligne de mode affiche `mode : full scan` quand `gitleaks` ou `trivy` est sur votre PATH. Sans
l'un ou l'autre, elle affiche `mode : warn-only (external content not scanned — install gitleaks
or trivy)` : agent-rigger fonctionne quand même, mais ne peut pas scanner le contenu du catalog
avant l'install. Ce compromis est couvert dans
[confiance et sécurité](/fr/concepts/trust-and-security/).

Doctor sans flag est en lecture seule. Il sort `0` et n'écrit rien.

## Provoquer un finding

Doctor ne se manifeste que quand l'état installé et le
[manifest](/fr/reference/glossary/#manifest) sont en désaccord. Pour voir un finding sans attendre
un vrai drift, fabriquez-en un que vous pourrez nettoyer : un
[symlink](/fr/reference/glossary/#symlink) pendouillant, un lien dont la cible n'existe pas, sous
votre racine de skills.

```
ln -s ~/.claude/skills/_gone ~/.claude/skills/ghost-skill
```

Relancez doctor :

```
--- agent-rigger doctor ---

✓ git (/opt/homebrew/bin/git)
✓ glab (/opt/homebrew/bin/glab)
✓ gitleaks (/opt/homebrew/bin/gitleaks)
✓ trivy (/opt/homebrew/bin/trivy)

mode : full scan

Installed-state check · 1 finding

Dangling symlinks (1)
  + "/Users/you/.claude/skills/ghost-skill" is a dangling symlink with no manifest entry — removable.  [confirm]
```

La commande sort maintenant avec `3`. C'est le code « quelque chose a été trouvé » de doctor : pas
un crash, un rapport à lire (voir [exit codes](/fr/reference/exit-codes/)). Le symlink fantôme est
toujours sur le disque. Le diagnostic n'a touché à rien.

Chaque ligne de finding se termine par un tag qui indique comment elle peut être réparée : `[fix]`
pour une réparation sûre, `[confirm]` pour une qui exige votre confirmation par item, `[report]`
pour une que doctor ne touchera pas. Les findings sont regroupés en six classes ; la
[référence `doctor`](/fr/reference/cli/doctor/#phase-2--état-installé) les liste toutes. Celui
ci-dessus est un finding `dangling`, tagué `[confirm]` parce que retirer un symlink est
destructeur.

## Réparer avec --fix

`--fix` applique les réparations que portent les findings. Le
[consent](/fr/reference/glossary/#consent) qu'elle exige dépend de l'acte :

- **Réparations sûres (`[fix]`).** Adopter un artifact conforme, supprimer un débris de staging,
  sauvegarder un `state.json` malformé. [`--yes`](/fr/reference/glossary/#yes) les accorde ; dans
  un terminal sans `--yes`, chacune est confirmée.
- **Réparations destructrices (`[confirm]`).** Retirer un symlink pendouillant, supprimer un store
  phantom, casser un run-lock, supprimer un backup vieilli. `--yes` ne les accorde jamais. Elles
  sont confirmées une par une dans un terminal, et sautées là où personne ne peut les confirmer.

Dans un terminal interactif, `doctor --fix` demande confirmation une fois par item :

![Un doctor --fix lancé contre un état cassé fabriqué. La phase 1 liste quatre dépendances (git, glab, gitleaks, trivy), toutes présentes avec une coche, puis la ligne "mode : full scan". La phase 2 rapporte deux findings : un skill untracked conforme à son store, tagué comme réparation sûre, et un symlink pendouillant sans entrée manifest, tagué comme nécessitant une confirmation par item. La commande demande ensuite confirmation une fois par item. Le premier prompt affiche "Apply repair?", le second "Confirm repair?" ; les deux démarrent sur No, et chacun est déplacé volontairement vers Yes avant confirmation. Une section Repairs liste enfin deux résultats ok : l'adoption de skill:diagnose, puis le unlink du symlink fantôme.](../../../../assets/recordings/doctor-fix.gif)

_Un vrai `doctor --fix` sans `--yes` : chaque réparation est confirmée un item à la fois, et
chaque prompt démarre sur No. Appuyer sur Entrée par réflexe saute la réparation. L'adopt sûr
s'accorde de la même façon que l'unlink destructif, que `--yes` seul ne peut jamais accorder.
<small>Généré depuis docs/tapes/doctor-fix.tape, 2026-07-15. Régénérer : bun run build && vhs
docs/tapes/doctor-fix.tape.</small>_

Les réparations appliquées sont listées sous un bloc `Repairs`. Une adoption sûre, par exemple,
rapporte :

```
Repairs
  [ ok  ]  adopt skill:hello-rigger  — adopted "skill:hello-rigger".
```

### Dans un script

Sans terminal, `doctor --fix` a besoin de `--yes`, et n'applique alors que les réparations sûres.
Lancez-la contre le symlink fantôme ci-dessus et rien n'est retiré : sa réparation `[confirm]` ne
peut pas être accordée en bloc, elle est donc laissée en place et la commande sort quand même avec
`3`.

Lancez `doctor --fix` sans terminal et sans `--yes` et elle refuse avant de toucher à quoi que ce
soit :

```
[error] doctor --fix needs an interactive terminal (per-item confirmation), or --yes to apply the safe repairs only.
```

Ce refus sort avec `2`. Pour le contrat non-interactif partagé entre les commandes, voyez
[CI et scripts](/fr/guides/ci-and-scripts/).

### Nettoyer le fantôme

Le symlink pendouillant que vous avez fabriqué est une réparation `[confirm]`, donc retirez-le
vous-même ou confirmez-le dans un `doctor --fix` interactif :

```
rm ~/.claude/skills/ghost-skill
```

Un dernier `agent-rigger doctor` devrait à nouveau afficher
`Installed state is healthy — no findings.`

## Vérifier les sources distantes avec --remote

Par défaut, la phase 2 ne touche pas au réseau. Certains drifts ne laissent aucune trace sur le
disque : une règle de [guardrail](/fr/reference/glossary/#guardrail), un bloc de
[context](/fr/reference/glossary/#context), ou un serveur [mcp](/fr/reference/glossary/#mcp)
présent sur votre hôte mais suivi par aucun catalog.

`--remote` les fait remonter. Elle récupère le contenu de chaque
[catalog](/fr/reference/glossary/#catalog) configuré, en lecture seule, et le compare à votre
hôte :

```
agent-rigger doctor --remote
```

La récupération est [fail-closed](/fr/reference/glossary/#fail-closed--fail-open) : toute erreur
de récupération arrête la commande et nomme le catalog fautif plutôt que de se dégrader
silencieusement en un scan disque seul. Donnez à l'exécution les identifiants de vos catalogs.
`--remote` se combine avec `--fix`, et la référence documente les exit codes supplémentaires que
l'étape réseau peut renvoyer.

Pour le contrat complet (chaque classe de finding, chaque flag, et le tableau complet des exit
codes), voyez la [référence `doctor`](/fr/reference/cli/doctor/).
