---
title: Remove artifacts
description: Uninstall one or more artifacts offline, read the removal plan's operations, handle packs and files you have edited, and find the backups.
---

You want an artifact off this machine. Remove is completely offline: it reads the
[manifest](/reference/glossary/#manifest) and the disk, never a catalog, so it works with no network
and with no catalog configured. For the complete flag surface, see the
[`remove` reference](/reference/cli/remove/).

## Remove one or more ids

Pass [qualified ids](/reference/glossary/#qualified-id):

```
agent-rigger remove example/guardrail:demo example/context:demo --yes
```

`--yes` skips the confirmation. An unqualified id is rejected up front:

```
[error] unqualified id "skill:hello-rigger" — use `<catalog>/skill:hello-rigger` (see `agent-rigger ls`)
```

An id the manifest does not know is refused, and the message lists what is installed so you can pick
the right one:

```
[error] Artifact "example/skill:nope" is not installed. Installed entries: example/agent:demo.
```

## Read the removal plan

Remove shows a plan before writing, then a result. Each artifact contributes exactly the operations
needed to undo what its install wrote:

```
--- Removal Plan ---
Removal plan · 4 changes · scope: user (~/.claude)

- example/guardrail:demo   ~/.claude/settings.json
  deny  (-4)
     - Read(./.env)
     - Read(./.env.*)
     - Read(./**/.env)
     - Read(./secrets/**)
  allow  (-1)
     - Read(./.env.example)

- example/context:demo   ~/.claude/harness/AGENTS.md
  delete  ~/.claude/harness/AGENTS.md
  unimport  ~/.claude/CLAUDE.md

Σ  deny -4 · allow -1 · 1 delete · 1 unimport
```

The ops in this plan, and the full vocabulary a plan can list, are enumerated in the
[`remove` reference](/reference/cli/remove/#removal-plan) — that table is the source of truth. The
ones the sample above shows:

- `deny (-N)` / `allow (-N)`: removes the deny or allow rules the
  [guardrail](/reference/glossary/#guardrail) added to `settings.json`.
- `unimport`: removes the managed [`@AGENTS.md` import](/reference/glossary/#agentsmd-bridge) block
  from `CLAUDE.md`.
- `delete`: deletes a file the install wrote.

Others you may see, depending on the artifact: `restore` (returns an overwritten file to its
pre-install content), `unlink` (removes the [symlink](/reference/glossary/#symlink) into the
[store](/reference/glossary/#store); the next line states the store's fate,
`(deleted — last reference)` or `(kept — still referenced)`), `uninstall` (delegates removal of a
[plugin](/reference/glossary/#plugin) to the assistant), and `un-hook` (deregisters a
[hook](/reference/glossary/#hook) the install added).

A removal that changes something on disk asks for confirmation. An entry whose target already
vanished is purged from the manifest without a prompt (reported as `purged (already absent)`), since
it touches nothing on disk.

## Removing a pack

A [pack](/reference/glossary/#pack) is expanded into its members at install time, so there is no
pack entry to remove. Asking for one is refused with guidance:

```
[error] Pack "<id>" is not installed — packs are expanded at install time; remove their member artifacts instead. Installed entries: <ids>.
```

List the members with `agent-rigger ls`, then remove them by id.

## A target you edited yourself

If you changed a file agent-rigger had installed, remove does not overwrite it or delete your
version. It leaves the file in place and reports a warning instead of removing it. Nothing you edited
is lost to a remove.

## Where the backups are

Before it removes or replaces a file, remove takes a byte copy next to it with a
[`.bak-*`](/reference/glossary/#backup-bak) suffix. The result block lists every one:

```
[backup] 3 file(s) backed up.
  ~ /Users/you/.claude/settings.json.bak-2026-07-12T13-57-19.084Z-50f11f03
  ~ /Users/you/.claude/harness/AGENTS.md.bak-2026-07-12T13-57-19.085Z-a02b032a
  ~ /Users/you/.claude/CLAUDE.md.bak-2026-07-12T13-57-19.085Z-8349fb01
```

The paths in the result block are absolute (the plan above abbreviates them to `~/.claude/…`; the
result block does not).

These are your rollback: the tool never deletes a recent one.
