---
title: Politique de sécurité
description: "Quelles versions reçoivent des correctifs de sécurité, comment signaler une vulnérabilité en privé, et ce contre quoi le scan d'agent-rigger protège — et ne protège pas."
---

agent-rigger installe de la configuration de harness récupérée depuis un
[catalog](/fr/reference/glossary/#catalog) distant — des fichiers qui gouvernent le comportement
de votre assistant IA. Cela place la sécurité au centre de l'outil, donc cette page énonce la
politique sans détour : quelles versions reçoivent des correctifs, comment signaler un problème
sans l'exposer, et où s'arrêtent les protections intégrées. Pour le raisonnement derrière la
conception, voyez [confiance et sécurité](/fr/concepts/trust-and-security/).

## Versions prises en charge

agent-rigger est pré-1.0. Les correctifs de sécurité ne vont qu'au `main` le plus récent et à la
dernière release taguée. Il n'y a aucune garantie de backport pour les versions plus anciennes :
passez à la dernière version avant de signaler, pour qu'un correctif n'atterrisse pas sur une
version que vous n'exécutez pas.

## Signaler une vulnérabilité

**N'ouvrez pas d'issue publique pour une vulnérabilité de sécurité.** Une issue publique divulgue
le problème avant qu'un correctif existe.

Signalez-la en privé via le
[private vulnerability reporting](https://github.com/agent-rigger/agent-rigger/security/advisories/new)
de GitHub (Security → Advisories → _Report a vulnerability_).

Merci d'inclure :

- une description du problème et de son impact,
- les étapes de reproduction (un cas minimal si possible),
- la version ou le commit affecté.

Attendez-vous à un accusé de réception sous quelques jours. Après triage, le problème est
confirmé, un calendrier de divulgation est convenu, et vous êtes crédité dans l'advisory sauf si
vous préférez rester anonyme.

## Périmètre et modèle de menace

Le contenu récupéré depuis un catalog distant est traité comme untrusted — votre propre catalog
compris, parce qu'un seul compte compromis peut changer ce qu'une équipe entière installe. Deux
propriétés définissent ce que l'outil fait de cette hypothèse, et deux limites définissent ce
qu'il ne fait pas.

### Le contenu récupéré est scanné avant d'atteindre votre harness

Tout ce qui est récupéré depuis un catalog distant, `catalog.json` compris, est
[scanné](/fr/reference/glossary/#scan--scanner) avec gitleaks et/ou trivy avant qu'aucun fichier
ne soit écrit dans votre harness. Il n'existe aucune exception intégrée jugée de confiance. Le
scan s'exécute à une porte unique, avant que le plan ne soit appliqué, si bien que rien n'est
copié d'abord pour être vérifié ensuite.

Un finding bloquant arrête l'install
([fail-closed](/fr/reference/glossary/#fail-closed--fail-open)). Sans
[`--force`](/fr/reference/glossary/#force), la commande se termine et n'écrit rien :

```
Security scan blocked installation. Findings:
<findings>

Re-run with --force to install anyway.
```

### Warn-only quand aucun scanner n'est installé

gitleaks et trivy sont des dépendances optionnelles. Si aucun des deux n'est présent sur l'hôte,
l'outil ne peut pas scanner. Plutôt que de bloquer chaque install sur un tel hôte, il se dégrade
en [warn-only](/fr/reference/glossary/#warn-only) : l'install se poursuit et affiche un
avertissement.

```
[warning] content not scanned — install gitleaks or trivy then re-run for a full scan; see `rigger doctor`
```

[`rigger doctor`](/fr/reference/glossary/#doctor) fait remonter le même état dégradé ensuite, si
bien que vous pouvez savoir si un hôte a tourné avec un vrai scan :

```
mode : warn-only (external content not scanned — install gitleaks or trivy)
```

C'est l'unique exception délibérée au défaut fail-closed. Sur un hôte warn-only, du contenu qui
n'a jamais été scanné peut atteindre votre poste. Installer gitleaks ou trivy rétablit le vrai
scan.

### Le scan couvre les secrets et les misconfigurations, pas le comportement

gitleaks trouve des identifiants fuités ; trivy signale les misconfigurations et rapporte aussi
les secrets qu'il trouve. Ni l'un ni l'autre n'effectue d'analyse comportementale d'un script. Un
payload malveillant écrit pour cacher ce qu'il fait — un `curl … | sh` obfusqué, par exemple —
passe les deux. Le scan réduit la surface d'attaque ; il ne certifie pas qu'un contenu est sûr à
exécuter.

### Vous êtes responsable de `--force` et de ce que vous configurez

`--force` outrepasse un finding de scan bloquant et installe quand même. C'est un choix délibéré
d'accepter un risque de scan en connaissance de cause. Vous restez responsable des catalogs que
vous configurez et de tout contenu que vous installez avec `--force`.

Notez que `--force` ne couvre que la porte de scan. Il ne contourne pas la re-vérification de
provenance qui refuse un contenu dont le commit ne correspond pas à la version qu'il prétend
être ; voyez [confiance et sécurité](/fr/concepts/trust-and-security/) pour cette frontière et le
reste du modèle.

## Dans le périmètre d'un signalement

Les signalements portant sur les frontières ci-dessus sont dans le périmètre et bienvenus — par
exemple un contournement de la porte de scan, une écriture hors de l'emplacement d'install
déclaré, ou un backup manquant avant un écrasement.
