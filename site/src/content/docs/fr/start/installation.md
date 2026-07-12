---
title: Installation
description: Installez agent-rigger via Homebrew, un binaire de release GitHub préconstruit ou depuis les sources ; la page liste aussi les outils supposés présents sur votre poste et la façon de vérifier l'installation.
---

Cette page explique comment installer l'outil en ligne de commande agent-rigger. Choisissez l'une des trois
méthodes ci-dessous ; Homebrew est la méthode recommandée. Vérifiez ensuite les prérequis
d'usage, puis validez le résultat.

Chaque méthode vous donne deux commandes pour le même outil : `agent-rigger` et la plus
courte `rigger`.

## Homebrew (recommandé)

Sur macOS et Linux, installez depuis le tap officiel :

```sh
brew tap agent-rigger/tap
brew install agent-rigger
```

Cela installe un binaire estampillé d'une version et l'alias `rigger`. La formule fournit
des binaires natifs pour macOS (arm64 et x64) et Linux (arm64 et x64). Homebrew n'est pas
disponible sur Windows ; utilisez plutôt le binaire de release ci-dessous.

Pour mettre à jour plus tard, `brew upgrade agent-rigger`.

## Binaire de release préconstruit

Chaque release taguée publie sur GitHub un binaire autonome pour cinq cibles,
plus un fichier de sommes de contrôle `SHA256SUMS.txt`. Les assets sont nommés :

- `agent-rigger-darwin-arm64` : macOS, Apple Silicon
- `agent-rigger-darwin-x64` : macOS, Intel
- `agent-rigger-linux-arm64` : Linux, arm64
- `agent-rigger-linux-x64` : Linux, x64
- `agent-rigger-windows-x64.exe` : Windows, x64

Téléchargez celui de votre plateforme (cet exemple utilise macOS Apple Silicon), vérifiez
sa somme de contrôle, rendez-le exécutable et placez-le sur votre `PATH` :

```sh
base="https://github.com/agent-rigger/agent-rigger/releases/latest/download"
curl -fLO "$base/agent-rigger-darwin-arm64"
curl -fLO "$base/SHA256SUMS.txt"

# verify the download against the published checksum
shasum -a 256 -c SHA256SUMS.txt --ignore-missing

chmod +x agent-rigger-darwin-arm64
mv agent-rigger-darwin-arm64 /usr/local/bin/agent-rigger
ln -sf /usr/local/bin/agent-rigger /usr/local/bin/rigger
```

Les binaires de release ne sont pas signés. Sur macOS, un binaire téléchargé de cette façon
peut être mis en quarantaine par Gatekeeper ; s'il est refusé au premier lancement, effacez
l'attribut avec `xattr -d com.apple.quarantine /usr/local/bin/agent-rigger`.

## Depuis les sources

Construire depuis les sources nécessite [Bun](https://bun.sh) 1.3 ou plus récent. Clonez le
dépôt, installez les dépendances et construisez le binaire autonome :

```sh
git clone https://github.com/agent-rigger/agent-rigger.git
cd agent-rigger
bun install
bun run build
```

Le binaire compilé se trouve à `packages/cli/dist/agent-rigger`. Lancez-le directement, ou
placez les deux noms sur votre `PATH` :

```sh
./packages/cli/dist/agent-rigger --version
ln -sf "$PWD/packages/cli/dist/agent-rigger" /usr/local/bin/agent-rigger
ln -sf "$PWD/packages/cli/dist/agent-rigger" /usr/local/bin/rigger
```

**Réserve :** un binaire construit localement affiche `0.0.0` comme version. Le vrai
numéro de version n'est estampillé depuis le tag git que lors du build de release en CI ; un
build depuis les sources n'a donc aucune version à afficher. Tout le reste fonctionne à
l'identique : le `0.0.0` est cosmétique.

## Prérequis d'usage

agent-rigger s'appuie sur quelques outils externes. Il fonctionne sans les avoir tous, mais
avec moins de garanties.

- **git — requis.** Les catalogs sont des dépôts git ; l'outil les récupère avec git. Sans
  git, il ne peut lire aucun catalog.
- **gitleaks et/ou trivy — recommandés.** Ce sont les
  [scanners](/fr/reference/glossary/#scan--scanner) qui inspectent le contenu récupéré du
  catalog à la recherche de secrets fuités et de misconfigurations avant qu'il ne soit
  écrit sur le disque. Si aucun des deux n'est installé, l'outil ne peut pas scanner et
  bascule en mode [warn-only](/fr/reference/glossary/#warn-only) : il installe quand même et
  affiche un avertissement, plutôt que de bloquer chaque install. Cela signifie qu'un
  contenu non scanné atteint votre poste, si bien qu'installer au moins un scanner est ce
  qui rend le contrôle de sécurité réel. Les compromis sont exposés dans
  [confiance et sécurité](/fr/concepts/trust-and-security/).
- **Un assistant — requis en pratique.** agent-rigger configure Claude Code ou opencode ;
  installez-en au moins un, sinon il n'a rien à configurer.

## Vérifier l'installation

Deux commandes confirment une installation fonctionnelle. D'abord, la version :

```sh
agent-rigger --version
```

Une install Homebrew ou de release affiche la version publiée ; un build depuis les sources
affiche `0.0.0` (voir la réserve ci-dessus).

Lancez ensuite [`doctor`](/fr/reference/glossary/#doctor), qui indique si git et les
scanners sont présents et dans quel mode de scan vous êtes :

```sh
rigger doctor
```

Un poste où les scanners sont installés indique le mode full scan :

```
--- agent-rigger doctor ---

✓ git (/opt/homebrew/bin/git)
✓ glab (/opt/homebrew/bin/glab)
✓ gitleaks (/opt/homebrew/bin/gitleaks)
✓ trivy (/opt/homebrew/bin/trivy)

mode : full scan

Installed state is healthy — no findings.
```

Sans gitleaks ni trivy, la ligne de mode affiche à la place
`mode : warn-only (external content not scanned — install gitleaks or trivy)`.

## La suite

- [Parcourez votre premier rig](/fr/start/getting-started/) en une dizaine de minutes.
- Comprenez [à quoi sert agent-rigger](/fr/start/what-is-agent-rigger/).
