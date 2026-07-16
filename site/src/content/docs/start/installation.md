---
title: Installation
description: Install agent-rigger via Homebrew, a prebuilt GitHub release binary, or from source. This page also covers the tools it expects on your machine and how to verify the install.
---

This page installs the agent-rigger command-line tool. Pick one of the three methods
below; Homebrew is the recommended one. Then check the usage prerequisites and verify
the result.

Every method gives you two commands for the same tool: `agent-rigger` and the shorter
`rigger`.

## Homebrew (recommended)

On macOS and Linux, install from the official tap:

```sh
brew tap agent-rigger/tap
brew install agent-rigger
```

This installs a version-stamped binary and the `rigger` alias. The formula ships native
binaries for macOS (arm64 and x64) and Linux (arm64 and x64). Homebrew is not available
on Windows; use the release binary below instead.

To upgrade later, `brew upgrade agent-rigger`.

## Prebuilt release binary

Each tagged release attaches a standalone binary for five targets, plus a
`SHA256SUMS.txt` checksum file, to the GitHub release. The assets are named:

- `agent-rigger-darwin-arm64` — macOS, Apple Silicon
- `agent-rigger-darwin-x64` — macOS, Intel
- `agent-rigger-linux-arm64` — Linux, arm64
- `agent-rigger-linux-x64` — Linux, x64
- `agent-rigger-windows-x64.exe` — Windows, x64

Download the one for your platform (this example uses macOS Apple Silicon), verify its
checksum, make it executable, and put it on your `PATH`:

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

The release binaries are not code-signed. On macOS, a binary downloaded this way may be
quarantined by Gatekeeper; if it is refused on first run, clear the attribute with
`xattr -d com.apple.quarantine /usr/local/bin/agent-rigger`.

## From source

Building from source needs [Bun](https://bun.sh) 1.3 or newer. Clone the repository,
install dependencies, and build the standalone binary:

```sh
git clone https://github.com/agent-rigger/agent-rigger.git
cd agent-rigger
bun install
bun run build
```

The compiled binary lands at `packages/cli/dist/agent-rigger`. Run it directly, or put
both names on your `PATH`:

```sh
./packages/cli/dist/agent-rigger --version
ln -sf "$PWD/packages/cli/dist/agent-rigger" /usr/local/bin/agent-rigger
ln -sf "$PWD/packages/cli/dist/agent-rigger" /usr/local/bin/rigger
```

**Caveat:** a locally built binary reports its version as `0.0.0`. The real version
number is stamped from the git tag only during the release build in CI, so a from-source
build has no version to report. Everything else works identically: the `0.0.0` is
cosmetic.

## Usage prerequisites

agent-rigger relies on a few external tools. It runs without all of them, but with fewer
guarantees.

- **git — required.** Catalogs are git repositories; the tool fetches them with git.
  Without git, it cannot read any catalog.
- **gitleaks and/or trivy — recommended.** These are the
  [scanners](/reference/glossary/#scan--scanner) that inspect fetched catalog content for
  leaked secrets and misconfigurations before it is written to disk. If neither is
  installed, the tool cannot scan and falls back to
  [warn-only](/reference/glossary/#warn-only) mode: it installs anyway and prints a
  warning, rather than blocking every install. That means unscanned content reaches your
  machine, so installing at least one scanner is what makes the security check real. The
  trade-offs are laid out in [trust and security](/concepts/trust-and-security/).
- **An assistant — required in practice.** agent-rigger configures Claude Code or
  opencode; install at least one, or there is nothing for it to configure.

## Verify the install

Two commands confirm a working setup. First, the version:

```sh
agent-rigger --version
```

A Homebrew or release install prints the released version; a from-source build prints
`0.0.0` (see the caveat above).

Then run [`doctor`](/reference/glossary/#doctor), which reports whether git and the
scanners are present and which scan mode you are in:

```sh
rigger doctor
```

A machine with the scanners installed reports full-scan mode:

```
--- agent-rigger doctor ---

✓ git (/opt/homebrew/bin/git)
✓ glab (/opt/homebrew/bin/glab)
✓ gitleaks (/opt/homebrew/bin/gitleaks)
✓ trivy (/opt/homebrew/bin/trivy)

mode : full scan

Installed state is healthy — no findings.
```

Without gitleaks or trivy, the mode line instead reads
`mode : warn-only (external content not scanned — install gitleaks or trivy)`.

## Next

- [Walk through your first rig](/start/getting-started/) in about ten minutes.
- Understand [what agent-rigger is for](/start/what-is-agent-rigger/).
