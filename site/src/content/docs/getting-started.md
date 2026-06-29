---
title: Get started
description: Install agent-rigger from source, point it at a catalog, and audit your setup.
---

agent-rigger is pre-1.0 (M0). It runs from source — no pre-built binary is
distributed yet.

## Prerequisites

- **Bun ≥ 1.3** — runtime and package manager.
- **Claude Code** — the assistant this harness configures.
- **git** — required for remote catalog operations.
- **gitleaks and/or trivy** — required to install `external` artifacts from a
  remote catalog: their content is scanned for secrets and misconfigurations
  before it lands on disk (fail-closed without a scanner, unless you pass
  `--force`).
- **`glab` or `gh`** — required if the catalog references GitLab or GitHub
  resources.

## Install from source

```sh
git clone https://github.com/agent-rigger/agent-rigger
cd agent-rigger
bun install
```

Run directly:

```sh
bun run packages/cli/src/cli.ts <command>
```

Or build a local binary:

```sh
bun run build
# produces packages/cli/dist/agent-rigger
```

## The loop

```sh
# 1. check your dependencies and the active scan mode
agent-rigger doctor

# 2. plug in your team catalog (the source of truth)
agent-rigger catalog add team https://github.com/your-org/your-catalog.git

# 3. see what the rig offers
agent-rigger ls

# 4. install the rig — a plan is shown first, nothing is written blindly
agent-rigger install team/pack:baseline --yes

# 5. verify there is no drift (exit 0 = all good)
agent-rigger check
```

Every write is backed up first, and `install` never writes without
confirmation. To try it without touching your real configuration, point
`RIGGER_HOME` at a throwaway directory:

```sh
export RIGGER_HOME="$(mktemp -d)"
```

Next: read the [Concepts](/concepts/) to understand artifacts, packs and the
manifest, or jump to the [Commands](/commands/) reference.
