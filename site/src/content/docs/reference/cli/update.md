---
title: update
description: Re-fetch installed artifacts to the latest remote version, with a sha-aware stale check and a transactional, confirmed re-install.
---

## Synopsis

```
agent-rigger update [<id>...] [--yes] [--force] [--scope=<user|project>] [--assistant=<claude|opencode>]
agent-rigger <resource> update <id>... [--yes] [--force]
```

Re-fetches installed artifacts to the latest remote version of their
[catalog](/reference/glossary/#catalog). With no ids, every artifact in the
[manifest](/reference/glossary/#manifest) whose catalog prefix matches a configured source — for the
target [scope](/reference/glossary/#scope) and [assistant](/reference/glossary/#assistant) — is a
candidate. Entries from a catalog no longer configured are omitted (doctor's orphan-catalog finding
covers them). Each candidate is classified stale, up-to-date, or skipped, and only the stale ones
are re-installed.

## Arguments

| Argument  | Required | Meaning                                                                                                                                                                              |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<id>...` | no       | [Qualified ids](/reference/glossary/#qualified-id) (`<catalog>/<nature>:<name>`) to update. Omitted: every installed artifact in scope for the assistant, from a configured catalog. |

## Classification

Each candidate lands in one bucket:

- **stale** (`[updated]`): the remote holds a newer version. The comparison is
  [sha](/reference/glossary/#sha)-aware. A [tag](/reference/glossary/#tag) re-pushed to a new
  commit is detected as stale even though its name did not change.
- **up-to-date** (`[up-to-date]`): already at the latest [ref](/reference/glossary/#ref).
- **skipped** (`[skipped]`): not installed, or installed with no remote version (ref `v0.0.0`).
  A declined transaction is not a per-id skip: it reports `[aborted] Update cancelled by user.`
  with no per-id tag.

## Transactional behaviour

For stale entries, update fetches the new content into a temporary checkout, scans it, and prints
the [plan](/reference/glossary/#plan-dry-run) before it touches anything. A network failure, an
invalid catalog, or a [provenance](/reference/glossary/#provenance) mismatch aborts before any
removal: the artifact stays at its installed version. Nothing is removed or written until you
confirm. Declining leaves every artifact at its old version and reports `[aborted] Update cancelled
by user.`

A stale [mcp](/reference/glossary/#mcp) entry replays its recorded secret references, so update
never re-prompts for a secret it already resolved at install time.

## Flags

| Flag                             | Effect                                                                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--yes`                          | Skip the confirmation prompt. Required in a non-interactive session.                                                                                                    |
| `--force`                        | Proceed despite a blocking [scan](/reference/glossary/#scan--scanner) finding: warn and continue instead of [fail-closed](/reference/glossary/#fail-closed--fail-open). |
| `--scope=<user\|project>`        | Target scope. Default `user`.                                                                                                                                           |
| `--assistant=<claude\|opencode>` | Target assistant. Default resolved from the manifest, then config.                                                                                                      |

## Interactive vs non-interactive

In a [TTY](/reference/glossary/#tty--non-interactive), update prints the plan and asks to confirm.
In a non-interactive session without [`--yes`](/reference/glossary/#yes), it exits `2` before any
fetch, since it cannot ask.

## Exit codes

| Code  | Condition                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------- |
| `0`   | Updated, up-to-date, nothing to update, or declined.                                              |
| `2`   | Unqualified id, no catalog configured, non-interactive without `--yes`, or a provenance mismatch. |
| `1`   | A catalog fetch failed, a scan blocked the update (no `--force`), or another run holds the lock.  |
| `130` | Interrupted.                                                                                      |

With no catalog configured, update prints `[error] No catalog URL configured.` and exits `2`.

## Example

```
agent-rigger update team/skill:spec-workflow --yes
```

See [exit codes](/reference/exit-codes) for the shared contract.
