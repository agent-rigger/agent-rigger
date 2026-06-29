---
title: Commands
description: check, install, remove, update, init, ls, doctor — the agent-rigger CLI.
---

## `check` — audit the current setup

Compares the installed state against the expected guardrails and context.

```sh
agent-rigger check [--scope=user|project]
```

| Exit | Meaning                                         |
| ---- | ----------------------------------------------- |
| 0    | All entries present and up to date              |
| 2    | A JSON file is malformed — cannot run the audit |
| 3    | One or more entries are missing or have drifted |

When a catalog URL is configured and reachable, `check` also appends an
`Updates` section listing entries with a newer remote version (advisory — it
never changes the exit code).

## `install` — install selected artifacts

```sh
agent-rigger install                      # interactive picker
agent-rigger install <id...> [--yes]      # non-interactive
agent-rigger install <url|path> [--force] # ad-hoc, content is scanned
```

Resolves packs and dependencies, shows a terraform-style plan grouped by
artifact, backs up existing files to `.bak-<timestamp>`, and **never writes
without confirmation** (skip with `--yes`).

## `remove` — uninstall artifacts

```sh
agent-rigger remove <id...> [--yes]
agent-rigger <resource> remove <id> [--yes]
```

Shows a removal plan (un-deny, un-import, delete, unlink, uninstall), backs up
modified files, and updates the manifest. Reversal relies on the structured
payload recorded at install time.

## `update` — update from the remote

```sh
agent-rigger update <id...>   # specific ids
agent-rigger update           # every installed external artifact
```

Re-installs external artifacts whose remote version is newer. Version comparison
uses semver tags (or the default-branch HEAD sha when there are no tags).

## `init` — configure catalog URL and auth

```sh
agent-rigger init
```

Asks for the catalog URL, probes ambient auth (provider CLI / credential helper
/ SSH), and persists config only after a successful probe. Idempotent.

## `ls` — list catalog entries

```sh
agent-rigger ls
agent-rigger <resource> ls
```

Lists entries with their install status. With a catalog URL configured, it also
fetches the remote catalog and merges it with the built-in entries (built-in
wins on an id collision). Best-effort: an unreachable remote falls back to the
built-in catalog.

## `doctor` — environment report

```sh
agent-rigger doctor
```

Reports detected dependencies (git, glab/gh, gitleaks, trivy) and the active
scan mode.
