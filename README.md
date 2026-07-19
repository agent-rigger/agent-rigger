```text
██████╗ ██╗ ██████╗  ██████╗ ███████╗██████╗
██╔══██╗██║██╔════╝ ██╔════╝ ██╔════╝██╔══██╗
██████╔╝██║██║  ███╗██║  ███╗█████╗  ██████╔╝
██╔══██╗██║██║   ██║██║   ██║██╔══╝  ██╔══██╗
██║  ██║██║╚██████╔╝╚██████╔╝███████╗██║  ██║
╚═╝  ╚═╝╚═╝ ╚═════╝  ╚═════╝ ╚══════╝╚═╝  ╚═╝
The harness package manager for teams
```

# agent-rigger

The harness package manager for teams. Share, install, and update the AI coding
assistant harness (skills, sub-agents, guardrails, context, plugins, tools) in a
reproducible way across a team's machines.

[![CI](https://github.com/agent-rigger/agent-rigger/actions/workflows/ci.yml/badge.svg)](https://github.com/agent-rigger/agent-rigger/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3-000?logo=bun)](https://bun.sh)
[![Conventional Commits](https://img.shields.io/badge/commits-conventional-fe5196?logo=conventionalcommits)](https://www.conventionalcommits.org/)

![agent-rigger in action: doctor, browse the team catalog, install the rig in one command, verify zero drift](./docs/demo.gif)

> A throwaway `$RIGGER_HOME` is used for the recording — your real `~/.claude` is
> never touched. Regenerating this GIF is currently blocked by a VHS/ttyd rendering
> throttle on large installs; the recording pipeline, prerequisites and status live in
> [`docs/tapes/README.md`](./docs/tapes/README.md).

---

## The problem

Team setups drift. Each developer maintains their own settings, deny lists,
context files, skills, and agents, installed manually and updated inconsistently.
When a guardrail is missing or a skill goes stale, nobody knows until something
breaks. agent-rigger treats the harness as a versioned package: a shared catalog
declares what should be installed, a manifest records what is installed, and one
command tells you whether your local setup matches.

---

## Installation

### Homebrew (macOS / Linux)

```sh
brew tap agent-rigger/tap
brew install agent-rigger
```

Installs the `agent-rigger` binary and the shorter `rigger` alias.

### Pre-built binaries

Every [GitHub Release](https://github.com/agent-rigger/agent-rigger/releases)
attaches standalone binaries plus a `SHA256SUMS.txt` to verify the download.

| Platform    | Binary | Homebrew | CI-tested |
| ----------- | :----: | :------: | :-------: |
| Linux x64   |   ✅   |    ✅    |    ✅     |
| Linux arm64 |   ✅   |    ✅    |     —     |
| macOS arm64 |   ✅   |    ✅    |     —     |
| macOS x64   |   ✅   |    ✅    |     —     |
| Windows x64 |   ✅   |    —     |     —     |

Only Linux x64 is exercised in CI today; the other binaries are cross-compiled
and shipped as-is. On Windows, symlink-based installs (skills, agents, plugins)
fall back to plain file copies when symlinks are unavailable.

### From source

Requires [Bun](https://bun.sh) >= 1.3.

```sh
git clone https://github.com/agent-rigger/agent-rigger.git
cd agent-rigger
bun install
bun run build
# produces packages/cli/dist/agent-rigger
```

Or run directly without building:

```sh
bun run packages/cli/src/cli.ts <command>
```

Caveat: a local build reports `--version` as `0.0.0`. The real version is
stamped from the git tag at release time only.

Note: the CLI ships no content of its own. Every artifact comes from a
configured catalog fetched at runtime, so the compiled binary is
self-contained (nothing to bundle).

### Try it in isolation (sandbox)

Want to try `rigger` without touching your real setup? Source the sandbox
helper: it points a `rigger` shell function at the binary (a local build, or an
installed one on your `PATH` such as Homebrew) and isolates **both** scopes, a
disposable `RIGGER_HOME` for user-scope writes and a disposable project dir it
cd's you into for project-scope writes.

```sh
source scripts/sandbox
# [sandbox] RIGGER_HOME : /tmp/rigger-sandbox.XXXXXX  (user-scope writes isolated here)
# [sandbox] project dir : /tmp/rigger-sandbox-project.XXXXXX  (now your cwd)

rigger catalog add example "$RIGGER_EXAMPLE_CATALOG"   # public demo catalog
rigger ls
rigger install            # pick artifacts; nothing is written outside the sandbox

rigger_reset              # wipe and start from a blank slate (works from /tmp)
rigger_exit               # tear down: cd back, delete temp dirs, unset everything
```

Your real config (`~/.claude`, `~/.config/agent-rigger`) and your real projects
are never read or written. Must be **sourced**, not executed: it mutates your
current shell (env, the `rigger`/`rigger_reset`/`rigger_exit` functions, and your
cwd). Full guide: [docs/sandbox.md](docs/sandbox.md).

---

## Quick start

```sh
agent-rigger doctor       # check the environment (scanners, git, provider CLIs)
agent-rigger init         # point rigger at your team's catalog (one-time)
agent-rigger ls           # list catalog entries and their install status
agent-rigger install      # select artifacts, review the plan, confirm, apply
agent-rigger check        # audit the installed setup for drift
```

Every write is shown as a plan and confirmed first, and every command targets one
assistant (`--assistant claude|opencode`, or inferred from config or disk).

---

## Artifact natures

An **artifact** is a deployable unit of harness configuration. There are eight
natures, each configuring a different part of the assistant. The two rightmost
columns show what each adapter installs today.

| Nature      | Summary                                                                   | Claude Code | opencode |
| ----------- | ------------------------------------------------------------------------- | :---------: | :------: |
| `skill`     | Reusable capability (`SKILL.md`) stored once and symlinked to each host   |     ✅      |    ✅    |
| `agent`     | Role-specialised sub-agent definition, a single Markdown file             |     ✅      |    ✅    |
| `guardrail` | Hard-block rule via the assistant's own permission mechanism              |     ✅      |    ✅    |
| `context`   | Advisory instructions file (`AGENTS.md`) the assistant reads              |     ✅      |    ✅    |
| `hook`      | Command the assistant runs on a lifecycle event                           |     ✅      |    —     |
| `plugin`    | Bundle of hooks and commands installed via the host's own mechanism       |     ✅      |    ✅    |
| `mcp`       | MCP server declaration the assistant can reach for extra capabilities     |     ✅      |    ✅    |
| `tool`      | Third-party host CLI the harness expects; presence-checked, not installed |    check    |  check   |

A **pack** bundles artifacts installed as a unit; a **catalog** is the versioned
git repository that declares them; a **manifest** records what was installed so
`check` can detect drift.

---

## Assistants

agent-rigger targets two assistants today, Claude Code and opencode, each written
through an assistant-specific adapter over the same plan-confirm-apply engine.
Per-nature support is the two rightmost columns of the artifact natures table
above. The target is resolved per transaction (explicit flag, config, or disk
detection), recorded per manifest entry, and reused by later commands without
re-prompting. Other assistants such as GitHub Copilot CLI are reserved for a
later milestone (the catalog schema already accepts `copilot` as a target).

---

## Status & roadmap

Pre-1.0. The engine and both adapters are in daily use; here is where the big
topics stand.

| Topic                                                         | Status         |
| ------------------------------------------------------------- | -------------- |
| Install engine (plan → confirm → apply, backups, drift check) | ✅ shipped     |
| Remote catalogs, `update`, multi-catalog config               | ✅ shipped     |
| MCP server management (both assistants, secrets via env refs) | ✅ shipped     |
| Security scanning (Trivy, Gitleaks, …) and `doctor --fix`     | ✅ shipped     |
| opencode adapter                                              | ✅ shipped     |
| Documentation site (EN/FR)                                    | ✅ shipped     |
| Terminal recordings with a CI freshness contract              | 🚧 in progress |
| GitHub Copilot CLI adapter                                    | 🗺️ planned      |
| Real `tool` install (brew/mise) — today: presence check only  | 🗺️ planned      |
| Organization profiles                                         | 🗺️ planned      |

---

## Invariants

These properties hold across all commands:

- **Idempotence**: running `install` twice leaves the same state as once.
- **Backup before write**: every file is copied to `.bak-<timestamp>-<token>` first.
- **Human-in-the-loop**: `install` never writes without explicit confirmation.
- **No silent failures**: every error maps to an actionable message and a non-zero exit.

---

## Documentation

Full documentation lives at **[agent-rigger.dev](https://agent-rigger.dev/)**
(Astro/Starlight, English and French; source under [`site/`](./site)).

**Getting started**

- [What is agent-rigger?](https://agent-rigger.dev/start/what-is-agent-rigger/)
- [Installation](https://agent-rigger.dev/start/installation/)
- [Getting started (10-minute tutorial)](https://agent-rigger.dev/start/getting-started/)

**Concepts**

- [Core concepts](https://agent-rigger.dev/concepts/core-concepts/) (catalog, manifest, store)
- [Artifact natures](https://agent-rigger.dev/concepts/artifact-natures/)
- [Trust and security](https://agent-rigger.dev/concepts/trust-and-security/)

**Guides**

- [Install from a catalog](https://agent-rigger.dev/guides/install-from-catalog/)
- [Update artifacts](https://agent-rigger.dev/guides/update-artifacts/)
- [Remove artifacts](https://agent-rigger.dev/guides/remove-artifacts/)
- [CI and scripts](https://agent-rigger.dev/guides/ci-and-scripts/)

**Reference**

- [CLI reference](https://agent-rigger.dev/reference/cli/overview/) (every command and flag)
- [catalog.json schema](https://agent-rigger.dev/reference/catalog-schema/)
- [Catalog repository layout](https://agent-rigger.dev/reference/catalog-layout/)
- [Exit codes](https://agent-rigger.dev/reference/exit-codes/)
- Glossary: [English](https://agent-rigger.dev/reference/glossary/) · [Français](https://agent-rigger.dev/fr/reference/glossary/)

---

## Development

```sh
bun install          # install dependencies
bun test             # run unit tests
bun run lint         # oxlint
bun run format       # dprint fmt
bun run format:check # verify formatting
bun run typecheck    # tsc --noEmit
```

Commits must follow [Conventional Commits](https://www.conventionalcommits.org/)
(enforced by commitlint via lefthook).

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow, the quality
gates, and the workspace layout. Changes are tracked in
[CHANGELOG.md](./CHANGELOG.md).

---

## Core team

- **Jonathan Robic** — Founder
  [GitHub](https://github.com/jrobic) · [LinkedIn](https://www.linkedin.com/in/jonathan-robic/)

---

## License

Released under the [Apache License 2.0](./LICENSE). See [DISCLAIMER.md](./DISCLAIMER.md)
for important notices on warranty, liability, and use.
