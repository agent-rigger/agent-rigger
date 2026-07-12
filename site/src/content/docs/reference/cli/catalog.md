---
title: catalog
description: "Manage the configured catalog sources: list, add, and remove the remote catalogs agent-rigger reads from, with a unique-name rule and a post-add install offer."
---

## Synopsis

```
agent-rigger catalog ls
agent-rigger catalog add <name> <url>
agent-rigger catalog remove <name>
```

Manages the configured [catalog](/reference/glossary/#catalog) sources: the list of remote catalogs
agent-rigger reads from. It edits configuration only. It never installs, updates, or removes
artifacts. Each source is a name paired with a git url.

## Arguments

| Argument | Used by         | Meaning                                                                                                                      |
| -------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `<name>` | `add`, `remove` | The source's unique name. It becomes the prefix in every [qualified id](/reference/glossary/#qualified-id) from that source. |
| `<url>`  | `add`           | The catalog's git url.                                                                                                       |

## Sub-commands

### catalog ls

Lists each configured source as `<name>  <url>`. With none configured, it prints:

```
no catalog configured — run `agent-rigger init` or `catalog add <name> <url>`
```

### catalog add

Adds a source. The name must be unique: an existing name is rejected with
`[error] catalog "<name>" already exists (<url>).` On success it prints `catalog "<name>" added
(<url>)`. In a [TTY](/reference/glossary/#tty--non-interactive), add then fetches the new catalog and
offers to install from it (the same picker as `init`). A fetch failure at this step is non-fatal:
the source stays saved and add prints:

```
Catalog fetch failed. Run `install` later to install artifacts from the catalog.
```

### catalog remove

Removes a source by name. An unknown name is rejected with `[error] catalog "<name>" not found.` On
success it prints `catalog "<name>" removed.`

## Interactive vs non-interactive

Only `catalog add` is interactive, and only for the post-add install offer. In a non-interactive
session the source is still added; the install offer is skipped.

## Exit codes

| Code  | Condition                                                                                  |
| ----- | ------------------------------------------------------------------------------------------ |
| `0`   | Success.                                                                                   |
| `2`   | Missing argument, name already exists (`add`), name not found (`remove`), or unknown verb. |
| `130` | Interrupted (Ctrl+C in the post-add picker).                                               |

An unrecognised sub-command exits `2` with `Unknown verb "<verb>" for resource "catalog".`
followed by usage.

## Example

```
agent-rigger catalog add team https://gitlab.com/acme/rig-catalog.git
```

See [exit codes](/reference/exit-codes) for the shared contract.
