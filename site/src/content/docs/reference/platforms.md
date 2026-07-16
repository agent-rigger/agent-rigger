---
title: Platforms and prerequisites
description: "The platform contract for agent-rigger: the OS/architecture targets the release build produces a binary for, the Homebrew tap channel, the external tools the CLI expects at runtime, and the files it writes on disk under each scope and OS."
---

This page is the platform contract for agent-rigger. It covers the OS/architecture targets the
release build produces a binary for and the external tools the CLI expects at runtime, plus where it
writes files on disk under each [scope](/reference/glossary/#scope). It records what ships and what
the code resolves, not how to install it. For the install procedure, see
[Installation](/start/installation/); for why the [scanners](/reference/glossary/#scan--scanner)
matter, see [Trust and security](/concepts/trust-and-security/).

## Release binaries

Each tag pushed as `v*` triggers the release build. A single `ubuntu-latest` host cross-compiles
every target with `bun build --compile --target=…`, so one job produces the whole matrix. There is
no per-OS runner. These five targets are built and attached to the GitHub Release, and nothing else:

| Build target       | Release asset                  | OS      | Architecture          |
| ------------------ | ------------------------------ | ------- | --------------------- |
| `bun-linux-x64`    | `agent-rigger-linux-x64`       | Linux   | x64                   |
| `bun-linux-arm64`  | `agent-rigger-linux-arm64`     | Linux   | arm64                 |
| `bun-darwin-x64`   | `agent-rigger-darwin-x64`      | macOS   | x64 (Intel)           |
| `bun-darwin-arm64` | `agent-rigger-darwin-arm64`    | macOS   | arm64 (Apple Silicon) |
| `bun-windows-x64`  | `agent-rigger-windows-x64.exe` | Windows | x64                   |

A sixth asset, `SHA256SUMS.txt`, carries the `sha256sum` of every binary. The release step sets
`fail_on_unmatched_files: true`, so a missing binary fails the release rather than publishing a
partial set.

Each binary is a standalone executable with the Bun runtime compiled in; end users do not need Bun,
node, or any package manager installed to run it. The compiled binary reports the version stamped
from the git tag when built in CI; a from-source build (`bun run build`) instead reports its
git-derived version — `git describe --tags --always --dirty`, leading `v` stripped, e.g.
`0.1.2-5-gabc123` and a `-dirty` suffix when the tree is modified — falling back to `0.0.0` only
when built with no git available.

Before building, the release job runs the full gate: `bun run lint`, `bun run format:check`,
`bun run typecheck`, `bun test`. It aborts the release if any step fails. Of the five binaries,
only `agent-rigger-linux-x64` is smoke-tested in CI (a `--version` invocation); the other four,
including the Windows binary, are published without an execution check in the release job.

### Windows

Windows has one prebuilt binary, `agent-rigger-windows-x64.exe` (x64 only; there is no
Windows-on-arm64 target). That binary is built and published on every release, but it is neither
smoke-tested in CI nor distributed through the Homebrew tap below. There is no Windows-specific code
path for on-disk locations; paths resolve through the same logic as every other OS (see
[Path resolution across platforms](#path-resolution-across-platforms)).

### Architectures with no prebuilt binary

The five targets above are the complete built set. Any other OS/architecture combination (for
example Windows on arm64, or a Linux libc the compiled target does not cover) has no prebuilt
binary. It can still run agent-rigger by building from source on any platform Bun supports; the
from-source build needs Bun 1.3 or newer and produces the binary at `packages/cli/dist/agent-rigger`.

## Distribution channels

Three channels deliver the same tool, but only the Homebrew formula installs the `rigger` alias
automatically. The release binary and the from-source build install only the canonical
`agent-rigger` command; adding the `rigger` alias for either is a manual step you run yourself.

| Channel        | Platforms covered                           | Notes                                                                                                                                                                                       |
| -------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Homebrew tap   | macOS (arm64, x64), Linux (arm64, x64)      | Recommended. `brew tap agent-rigger/tap && brew install agent-rigger`. Not available on Windows. Installs the `rigger` alias automatically.                                                 |
| Release binary | All five release targets, including Windows | Download the asset for your platform, verify against `SHA256SUMS.txt`. The `rigger` alias is a manual symlink you create yourself.                                                          |
| From source    | Any OS Bun supports                         | Needs Bun 1.3+. Binary reports its git-derived version (e.g. `0.1.2-5-gabc123`); `0.0.0` only when built with no git available. The `rigger` alias is a manual symlink you create yourself. |

The Homebrew formula is named `agent-rigger`. It ships the four Unix binaries (the two macOS and
the two Linux targets) and installs the downloaded binary under the canonical name plus a `rigger`
symlink. The formula does not cover Windows; the release binary is the only prebuilt channel there.
The formula is pushed to the tap in the same release run, gated on a tap token; if the token is
absent the formula update is skipped and the binaries are still published.

For the exact commands per channel, see [Installation](/start/installation/).

## Runtime prerequisites

agent-rigger shells out to a small set of external tools that must be present on `PATH`. The tool
does not install any of them for you: catalog entries can carry package-manager
[install hints](/reference/catalog-schema/#install), but performing the install from those hints is
not yet delivered. Install these tools through your own package manager.

[`doctor`](/reference/glossary/#doctor) reports each tool's presence in this order. A present tool
prints `✓ <name> (<resolved path>)`; an absent one prints `✗ <name> — missing  hint: <install hint>`
with the verbatim hint below:

| Tool       | Role                                                                                                                          | Requirement                                   | Absent hint (verbatim)                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `git`      | Fetches catalogs. Invoked as an external binary (`git clone`, `git fetch`, `git ls-remote`, `git checkout`, `git rev-parse`). | Required. Without it, no catalog can be read. | `install git: https://git-scm.com/downloads`                                               |
| `glab`     | GitLab CLI, for authenticating against GitLab-hosted catalog sources.                                                         | Recommended.                                  | `install glab: https://gitlab.com/gitlab-org/cli#installation`                             |
| `gitleaks` | Secret scanner run over fetched catalog content before it is written.                                                         | Optional.                                     | `install gitleaks: https://github.com/gitleaks/gitleaks#install`                           |
| `trivy`    | Vulnerability and misconfiguration scanner run over fetched content.                                                          | Optional.                                     | `install trivy: https://aquasecurity.github.io/trivy/latest/getting-started/installation/` |

An [assistant](/reference/glossary/#assistant) (Claude Code or opencode) is required in practice:
with none installed, agent-rigger has nothing to configure.

### Scan mode

The two [scanners](/reference/glossary/#scan--scanner) are detected on `PATH` at scan time and run in
parallel when present. The mode depends only on whether at least one is installed. `doctor` prints
the mode after the tool list, verbatim:

- At least one of `gitleaks`/`trivy` present — `mode : full scan`
- Neither present — `mode : warn-only (external content not scanned — install gitleaks or trivy)`

In [warn-only](/reference/glossary/#warn-only) mode the install proceeds with a warning rather than
blocking, so unscanned content reaches your machine. Installing at least one scanner is what makes
the security check real.

## Paths the tool creates

agent-rigger writes to fixed locations per assistant and scope. The tables below list the logical
paths; `<home>` is the resolved home directory and `<cwd>` is the current working directory (see
[Path resolution across platforms](#path-resolution-across-platforms) for how each is resolved).

### Claude Code — user scope

| Path                                       | Contents                                                             |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `<home>/.claude/settings.json`             | Claude Code settings the tool manages.                               |
| `<home>/.claude/CLAUDE.md`                 | User-scope context file.                                             |
| `<home>/.claude/harness/AGENTS.md`         | Harness agents file.                                                 |
| `<home>/.config/agent-rigger/config.json`  | Configured [catalog sources](/reference/glossary/#catalog-source).   |
| `<home>/.config/agent-rigger/state.json`   | Recorded install state (the manifest agent-rigger reads and writes). |
| `<home>/.config/agent-rigger/consent.json` | Recorded [consent](/reference/glossary/#consent) grants.             |
| `<home>/.config/agent-rigger/skills/`      | The physical skills [store](/reference/glossary/#store).             |

### Claude Code — project scope

| Path                          | Contents                              |
| ----------------------------- | ------------------------------------- |
| `<cwd>/.claude/settings.json` | Project-scope Claude Code settings.   |
| `<cwd>/.claude/CLAUDE.md`     | Project-scope context file.           |
| `<cwd>/AGENTS.md`             | Project agents file at the repo root. |

### opencode — user scope

| Path                                    | Contents                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `<home>/.config/opencode/opencode.json` | opencode configuration.                                                                                  |
| `<home>/.config/opencode/AGENTS.md`     | User-scope agents file.                                                                                  |
| `<home>/.config/opencode/agents/`       | Agents directory.                                                                                        |
| `<home>/.config/opencode/plugin/`       | Plugins directory.                                                                                       |
| `<home>/.config/opencode/skills/`       | Symlink into the physical store; the skills themselves live under `<home>/.config/agent-rigger/skills/`. |

### opencode — project scope

| Path                      | Contents                                 |
| ------------------------- | ---------------------------------------- |
| `<cwd>/opencode.json`     | opencode configuration at the repo root. |
| `<cwd>/AGENTS.md`         | Project agents file.                     |
| `<cwd>/.opencode/agents/` | Project agents directory.                |
| `<cwd>/.opencode/plugin/` | Project plugins directory.               |
| `<cwd>/.opencode/skills/` | Project skills directory.                |

A third assistant id, `copilot`, is reserved: it has no adapter and no on-disk convention, so the
tool writes no paths for it. Copilot support is not delivered.

## Path resolution across platforms

The on-disk layout above is identical across Linux, macOS, and Windows. Only the root directory and
the separator differ, both resolved by the runtime rather than by any per-OS branch in the tool.

`<home>` is resolved in this order, first non-empty value wins:

1. `RIGGER_HOME` — the [override](/reference/glossary/#rigger_home) used for test isolation and to
   redirect every user-scope path.
2. `HOME`
3. The runtime's home directory (`os.homedir()`) as the final fallback.

On Windows, `HOME` is typically unset, so `<home>` falls back to the runtime home directory
(`%USERPROFILE%`). `<cwd>` is the process working directory.

The `.claude` and `.config` directory names are fixed literals. There is no `XDG_CONFIG_HOME`
handling: even on Linux the config root is always `<home>/.config/agent-rigger`, never a
`$XDG_CONFIG_HOME`-derived path. Likewise there is no Windows `APPDATA`/`LOCALAPPDATA` handling. The
same `.config` and `.claude` names apply, joined with the platform path separator under
`%USERPROFILE%`.
