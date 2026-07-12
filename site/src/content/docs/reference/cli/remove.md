---
title: remove
description: Uninstall manifest-recorded artifacts offline, replaying each install in reverse under a confirmed plan; drifted files are left alone.
---

## Synopsis

```
agent-rigger remove <id>... [--yes] [--scope=<user|project>] [--assistant=<claude|opencode>]
agent-rigger <resource> remove <id>...
```

Uninstalls artifacts recorded in the [manifest](/reference/glossary/#manifest). It is manifest-first
and fully offline: the [catalog](/reference/glossary/#catalog) plays no role. Each entry's
[applied payload](/reference/glossary/#applied-payload) is replayed in reverse to undo the install
precisely. Every removal is previewed and confirmed before anything is deleted.

## Arguments

| Argument  | Required | Meaning                                                                                        |
| --------- | -------- | ---------------------------------------------------------------------------------------------- |
| `<id>...` | yes      | [Qualified ids](/reference/glossary/#qualified-id) (`<catalog>/<nature>:<name>`) to uninstall. |

## Removal plan

The [plan](/reference/glossary/#plan-dry-run) lists one group per artifact. Each op names what it
undoes:

| Op                         | Undoes                                                                                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deny (-N)` / `allow (-N)` | [Guardrail](/reference/glossary/#guardrail) rules removed from `settings.json`.                                                                                                         |
| `unimport`                 | A managed [context](/reference/glossary/#context) block removed.                                                                                                                        |
| `restore`                  | A file returned to its pre-install content.                                                                                                                                             |
| `delete`                   | A file deleted.                                                                                                                                                                         |
| `unlink`                   | A [symlink](/reference/glossary/#symlink) removed. A `store` line follows, marking the [store](/reference/glossary/#store) `(deleted — last reference)` or `(kept — still referenced)`. |
| `uninstall`                | A plugin uninstalled through the assistant (the `claude plugin uninstall <name>` command is shown).                                                                                     |
| `un-hook`                  | A [hook](/reference/glossary/#hook) deregistered.                                                                                                                                       |

## Special cases

- **Drift left alone.** If an on-disk target no longer matches what was installed, remove leaves it
  in place and warns. A hand-edited file is never deleted.
- **Already absent.** An entry whose target already vanished is purged from the manifest without
  touching disk and without a prompt, reported as `purged (already absent)`.
- **Packs.** A [pack](/reference/glossary/#pack) is expanded at install time and never recorded as
  such. Remove its member artifacts instead. Requesting a pack id reports that packs are expanded at
  install time and lists what is installed.

## Backups

Before overwriting or restoring a file, remove writes a
[`.bak-*`](/reference/glossary/#backup-bak) copy alongside it, reported as
`[backup] N file(s) backed up.`

## Interactive vs non-interactive

In a [TTY](/reference/glossary/#tty--non-interactive), remove prints the plan and asks to confirm.
Declining removes nothing and reports `[aborted] Removal cancelled by user.` A pure purge (only
already-absent entries) mutates the manifest alone and proceeds without a prompt. A non-interactive
session without [`--yes`](/reference/glossary/#--yes) exits `2` before any mutation.

## Flags

| Flag                             | Effect                                                                     |
| -------------------------------- | -------------------------------------------------------------------------- |
| `--yes`                          | Skip the confirmation prompt. Required in a non-interactive session.       |
| `--scope=<user\|project>`        | Target scope. Default `user`.                                              |
| `--assistant=<claude\|opencode>` | Target assistant. Default resolved from the manifest of the requested ids. |

## Exit codes

| Code  | Condition                                                             |
| ----- | --------------------------------------------------------------------- |
| `0`   | Removed, purged, nothing to remove, or declined.                      |
| `2`   | Unqualified id, id not installed, or non-interactive without `--yes`. |
| `130` | Interrupted.                                                          |

Removing an id the manifest does not know exits `2` with `[error] Artifact "<id>" is not
installed.` followed by the installed inventory (`Installed entries: <ids>.`, or `Nothing is
installed.` when the manifest is empty).

## Example

```
agent-rigger remove team/skill:spec-workflow
```

See [exit codes](/reference/exit-codes) for the shared contract.
