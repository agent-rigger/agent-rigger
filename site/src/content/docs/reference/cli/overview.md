---
title: CLI overview
description: The command grammar, global flags, output conventions, and assistant resolution shared by every agent-rigger command.
---

Every command follows one of two grammars and shares the same flag parser, the same
non-interactive guard, and the same [assistant](/reference/glossary/#assistant) resolution. This
page fixes those shared rules. Per-command detail lives on each command's own page.

## Two binaries

The tool ships as two binaries with identical behaviour: `agent-rigger` and the shorter `rigger`.
Every example here uses `agent-rigger`; substitute `rigger` freely.

## Grammar

```
agent-rigger <command> [options]
agent-rigger <resource> <verb> [args] [options]
```

The first non-flag token is the command. When that token is a known resource, the second non-flag
token is a verb and the rest are its arguments.

Resources: `skill` `agent` `guardrail` `context` `plugin` `hook` `tool` `pack` (each also accepts
its plural), plus `catalog`. Verbs: `ls` `add` `info` `check` `remove` `update`. For example,
`agent-rigger guardrails add jr/guardrail:claude` is the resource form of an install restricted to
the `guardrail` [nature](/reference/glossary/#nature).

## Global flags

The parser recognises exactly this set. Any other `--key`, in either form, is treated as an operator
typo: the command prints `[error] unknown flag "--<key>"` and exits `2` before doing any work. There is no `-h`, no `--json`, no `--verbose`.

| Flag           | Value                      | Used by                                                              |
| -------------- | -------------------------- | -------------------------------------------------------------------- |
| `--scope`      | `user` \| `project`        | install, check, remove, update, ls, and the install proposed by init |
| `--assistant`  | `claude` \| `opencode`     | install, check, remove, update, ls                                   |
| `--secret-env` | `<ref>=<VAR>` (repeatable) | install                                                              |
| `--yes`        | —                          | install, remove, update, init, doctor                                |
| `--force`      | —                          | install, update                                                      |
| `--fix`        | —                          | doctor                                                               |
| `--remote`     | —                          | doctor                                                               |
| `--help`       | —                          | any (prints usage, exit `0`)                                         |
| `--version`    | —                          | any (prints version, exit `0`)                                       |

`--scope`, `--assistant`, and `--secret-env` take a value and accept both `--flag=value` and
`--flag value` (space) forms. A value flag with no value at the end of the argument list is an
error: `[error] --<flag> requires a value`, exit `2`. The remaining flags are booleans, written
bare (`--yes`).

`--assistant` accepts only `claude` or `opencode`. `copilot` is reserved and has no
[adapter](/reference/glossary/#adapter) yet, so it is not accepted. An out-of-range value is
rejected centrally, before any command runs:
`[error] Invalid --assistant value: "<x>". Must be "claude" or "opencode".`, exit `2`. `--scope` is
validated the same way: `[error] Invalid --scope value: "<x>". Must be "user" or "project".`

An unknown command prints `Unknown command: "<x>"` followed by the usage text and exits `2`.

## Output and colour

ANSI colour is emitted only on a real terminal with the
[`NO_COLOR`](/reference/glossary/#no_color) environment variable unset. Output piped to a file or another
process, or run with `NO_COLOR` set, is plain text. No flag toggles colour.

## The non-interactive guard

install, remove, and update ask for confirmation before they change anything. In a
[non-interactive](/reference/glossary/#tty--non-interactive) session the prompt cannot be answered,
so a run that would reach it fails closed instead of hanging:

```
[error] non-interactive session — pass --yes to confirm non-interactively
```

This check runs at the head of the command, before any catalog fetch or network access, and exits
`2`. Pass [`--yes`](/reference/glossary/#yes) to pre-approve the safe confirmations. `--yes`
never covers a destructive act (see [consent](/reference/glossary/#consent)). The guard keys on
`stdin`: redirecting only `stdin` away from a terminal is enough to trigger it. `install` carries an
additional guard of its own: with no ids, its picker also needs a TTY, so `--yes` alone does not
satisfy it — see [install](/reference/cli/install).

## Assistant resolution

Commands that write or audit resolve exactly one assistant per run, in this order of priority:

1. The `--assistant` flag, when given (a typo is a hard error, never overridden by anything below).
2. `assistants[]` in the configuration, when it holds exactly one entry.
3. On-disk detection, when exactly one of `~/.claude` or `~/.config/opencode` is present.
4. In an interactive terminal, a prompt over the remaining candidates.
5. Otherwise, `claude` (a back-compatible default) for install, check, remove, and update.

check, remove, and update additionally read the [manifest](/reference/glossary/#manifest) first: when
every entry they touch was installed for one assistant, that assistant is used with no prompt.

## Commands

| Command             | Page                                            |
| ------------------- | ----------------------------------------------- |
| `check`             | [check](/reference/cli/check)                   |
| `doctor`            | [doctor](/reference/cli/doctor)                 |
| `install`           | [install](/reference/cli/install)               |
| `init`              | [init](/reference/cli/init)                     |
| `update`            | [update](/reference/cli/update)                 |
| `remove`            | [remove](/reference/cli/remove)                 |
| `ls`                | [ls](/reference/cli/ls)                         |
| `catalog <verb>`    | [catalog](/reference/cli/catalog)               |
| `<resource> <verb>` | [resource verbs](/reference/cli/resource-verbs) |

For the numeric status each command returns, see [exit codes](/reference/exit-codes).
