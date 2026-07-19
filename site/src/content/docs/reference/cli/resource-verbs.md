---
title: resource verbs
description: The <resource> <verb> grammar, a nature-typed front-end over install, ls, info, check, remove, and update, with per-nature id validation.
---

## Synopsis

```
rigger <resource> <verb> [<id>...] [options]
```

A second grammar addresses one [nature](/reference/glossary/#nature) at a time. The resource token
names a nature (or packs); the verb is the action. It is a typed front-end over the same commands:
`skills add` installs, validating that each id is a skill.

## Resource tokens

Singular and plural forms are equivalent:

| Token                      | Maps to                                                  |
| -------------------------- | -------------------------------------------------------- |
| `skill` / `skills`         | skill                                                    |
| `agent` / `agents`         | agent                                                    |
| `guardrail` / `guardrails` | guardrail                                                |
| `context` / `contexts`     | context                                                  |
| `plugin` / `plugins`       | plugin                                                   |
| `hook` / `hooks`           | hook                                                     |
| `tool` / `tools`           | tool                                                     |
| `pack` / `packs`           | pack                                                     |
| `catalog`                  | catalog sources (see [catalog](/reference/cli/catalog/)) |

## Verbs

| Verb             | Action                                                     |
| ---------------- | ---------------------------------------------------------- |
| `ls`             | List entries of this nature. See [ls](/reference/cli/ls/). |
| `add <id>...`    | Install the ids, each validated against the nature.        |
| `info <id>`      | Show one entry's details and whether it is installed.      |
| `check`          | Audit installed entries of this nature.                    |
| `remove <id>...` | Uninstall the ids. See [remove](/reference/cli/remove/).   |
| `update <id>...` | Update the ids. See [update](/reference/cli/update/).      |

## Nature validation

`add`, `update`, and `remove` require [qualified ids](/reference/glossary/#qualified-id). An
unqualified id is rejected:

```
[error] unqualified id "<id>" — use `<catalog>/<id>` (see `rigger ls`)
```

An id whose nature does not match the resource is rejected with `[error] id "<id>" is not a
<singular>`. `add` and `update` validate against the [catalog](/reference/glossary/#catalog);
`remove` validates against the [manifest](/reference/glossary/#manifest), so it stays offline.

## Packs check

`packs check` is not supported. A pack is a bundle, not an installable target, so `check` has
nothing to audit for it:

```
[error] "packs check" is not supported — packs are bundles, not installable directly.
```

## Exit codes

The delegated command's exit codes apply (`ls` returns `0` once its arguments are valid; `add`,
`remove`, `update`, and `check` as documented on their own pages), plus `2` for a validation error:
an unqualified id, a nature mismatch, `packs check`, or an unknown verb. An unknown verb prints
`Unknown verb "<verb>" for resource "<resource>".` followed by usage.

See [exit codes](/reference/exit-codes) for the shared contract.

## Example

```
rigger guardrails add team/guardrail:no-force-push --yes
```
