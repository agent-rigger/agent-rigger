---
title: Use in CI and scripts
description: Run agent-rigger non-interactively with --yes, branch on the exit-code contract, gate a pipeline on check for drift, and control colour with NO_COLOR.
---

You want agent-rigger inside a pipeline or a shell script, where nobody can answer a prompt. This
guide covers the non-interactive guard, the exit-code contract to branch on, a drift gate built on
`check`, and colour control. For the authoritative code table and the typed errors behind each code,
see [exit codes](/reference/exit-codes/).

## Always pass `--yes` for a writing command

Any command that would confirm (install, update, remove) needs `--yes` when there is no
[TTY](/reference/glossary/#tty--non-interactive). Without it the command exits `2` before any network
access, so a misconfigured job fails fast instead of hanging on a prompt it cannot answer:

```
[error] non-interactive session — pass --yes to confirm non-interactively
```

`--yes` pre-approves the safe confirmations only. It never covers a destructive doctor repair, which
is asked per item and is never granted in bulk.

## Branch on the exit code, not the output

Every command returns one of five [exit codes](/reference/glossary/#exit-code). Branch on the number:
the output text is written for humans and may change, the codes are the contract.

| Code  | In a script                                                    |
| ----- | -------------------------------------------------------------- |
| `0`   | Proceed. Success, or a deliberate no-op.                       |
| `1`   | Retry, or fix the environment.                                 |
| `2`   | Fix the invocation. Nothing was written.                       |
| `3`   | Read the report. An audit finding (check/doctor), not a crash. |
| `130` | Interrupted with Ctrl+C. Nothing was written past it.          |

Only `check` and `doctor` return `3`. For every other command, any non-zero code is a failure.

## Gate a pipeline on drift

`check` is the audit gate: `0` means the harness matches its recorded state, `3` means it
[drifted](/reference/glossary/#drift), `2` means the audit could not run. Its advisory catalog and
update sections never change the code. A gate that fails the build on drift:

```sh {4}
agent-rigger check
case $? in
  0) echo "harness in sync" ;;
  3) echo "drift detected; run agent-rigger update"; exit 1 ;;
  *) echo "check failed"; exit 1 ;;
esac
```

`check` writes nothing and runs no catalog command, but it does reach the network read-only to
resolve catalog status. Give the job git credentials for your catalog.

## Keep a provisioning install idempotent

A non-interactive install must name the [qualified ids](/reference/glossary/#qualified-id) to
install. The no-ids form falls back to the interactive scope selector and grouped picker, which are
TTY-only — under `--yes` without a TTY they have no answer and the command hangs, so always pin the
ids in a script:

```
agent-rigger install example/skill:hello-rigger example/agent:demo --yes
```

Re-running that exact command on an already-current machine is a no-op that exits `0`. The CLI
prints this line indented two spaces inside a `--- Result ---` block; it is shown flush-left here:

```
[ok] Already up to date — nothing to install.
```

so a provisioning step is safe to run on every boot.

## Control colour

agent-rigger colours output only on a real terminal, so a pipeline is already plain. To force plain
output anywhere (for example when capturing a TTY's logs to a file), set
[`NO_COLOR`](/reference/glossary/#no_color):

```
NO_COLOR=1 agent-rigger check
```
