---
title: ls
description: List the effective catalog across every configured source, marking each entry installed or available, with per-source degradation and an assistant filter.
---

## Synopsis

```
rigger ls [--scope=<user|project>] [--assistant=<claude|opencode>]
rigger <resource> ls [--scope=<user|project>] [--assistant=<claude|opencode>]
```

Lists the [effective catalog](/reference/glossary/#effective-catalog): the union of every configured
[catalog](/reference/glossary/#catalog) source, with each entry marked installed or available. Entry
ids are shown as [qualified ids](/reference/glossary/#qualified-id) so two sources that reuse a bare
id stay distinct.

## Multi-source resolution

ls fetches every configured source in parallel. A source that cannot be reached is skipped with a
warning and the listing continues from the sources that responded:

```
[warning] Catalog "<name>" (<url>) unavailable (<reason>). Check the URL or run `rigger init`.
```

Two sources that expose the same qualified id are deduplicated (first source wins), with a warning
naming the discarded entries.

## Columns

Each row shows a status tag, the qualified id, the [nature](/reference/glossary/#nature), and a hint.

- `[installed]` marks an id present in the manifest for the scope.
- `[available]` marks the rest.
- An installed row lists the [assistant](/reference/glossary/#assistant)(s) it is installed for, for
  example `(claude, opencode)`.
- A [pack](/reference/glossary/#pack) row shows its member count.

## Flags

| Flag                             | Effect                                                                                                                                                                                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--scope=<user\|project>`        | Which scope the installed state is read from. Default `user`.                                                                                                                                                                                                                       |
| `--assistant=<claude\|opencode>` | Filter what counts as installed. With it, only that assistant's manifest entries are `[installed]`. Without it, an id installed for any assistant is `[installed]`, and every installed row still names its assistant(s). This filter is read-only: it never falls back or prompts. |

## Resource form

`<resource> ls` filters the listing to one nature (or packs) and heads it with the capitalised
singular label, for example `Skill (12):`.

## Interactive vs non-interactive

ls is read-only and never prompts. With no catalog configured it prints the following and stops:

```
no catalog configured — run `rigger init`
```

## Exit codes

| Code | Condition                                                                 |
| ---- | ------------------------------------------------------------------------- |
| `0`  | Arguments valid. A per-source fetch failure only warns.                   |
| `2`  | An invalid `--scope` or `--assistant` value, rejected before any listing. |

## Example

```
rigger skills ls --assistant=claude
```

See [exit codes](/reference/exit-codes) for the shared contract.
