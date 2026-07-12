---
title: Exit codes
description: The 0 / 1 / 2 / 3 / 130 contract every agent-rigger command returns, the typed errors behind each code, and how to read them in CI.
---

Every command returns one of five [exit codes](/reference/glossary/#exit-code). The meaning of a
given code is the same across all commands, so a script can branch on the number without knowing
which command produced it.

## The five codes

| Code  | Meaning                              | What to do                                                                                                      |
| ----- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `0`   | Success, or a deliberate no-op.      | Nothing. The run did what you asked, or you declined and nothing changed.                                       |
| `1`   | Runtime or environment failure.      | Retry, or fix the environment (network, auth, a held lock). The request was valid; something outside it failed. |
| `2`   | The command was wrong.               | Correct the command and re-run. Nothing was written.                                                            |
| `3`   | `check` or `doctor` found something. | Read the report. A missing, drifted, or off-state finding, not an error.                                        |
| `130` | Interrupted with Ctrl+C.             | Nothing was written past the point of interruption.                                                             |

### 0: success or refusal

`0` covers two cases: the command completed, or you were asked to confirm and refused. Declining a
plan, selecting nothing in a picker, or a `check` that finds everything present all exit `0`.
Nothing was written on the refusal path.

### 2: correct your command

`2` means a request the tool will not run as written: a typo, a malformed argument, or a missing
precondition it cannot supply for you. Nothing is written. The pre-flight rejections also fetch
nothing: an unknown flag or command, an [unqualified id](/reference/glossary/#qualified-id), an
invalid `--scope`/`--assistant`, a [non-interactive](/reference/glossary/#tty--non-interactive)
session with no `--yes`, or no [catalog](/reference/glossary/#catalog) configured for an install.
Two other `2` conditions surface after a fetch (a ref/sha provenance mismatch, an unresolved
required MCP secret under `--yes`), but still write nothing.

### 1: retry or fix the environment

`1` is the runtime failure: the request was legitimate but something outside it broke. A catalog
fetch that failed on network or auth, another run holding the
[run-lock](/reference/glossary/#run-lock), or a security [scan](/reference/glossary/#scan--scanner)
that blocked an install all return `1`. Exception: [`doctor`](/reference/cli/doctor/) does not fail
on a held lock — it skips the installed-state scan (its findings would be transient) and exits `0`.

### 3: the check/doctor carve-out

`check` and `doctor` are audits, so "found a problem" is a normal outcome. They
return `3` when they find something: for `check`, an entry missing from disk or [drifted](/reference/glossary/#drift)
from its recorded state; for `doctor`, one or more findings. `3` is theirs alone. No other command
returns it.

### 130: Ctrl+C

Pressing Ctrl+C at any prompt aborts the run with `130` (128 + SIGINT). It is distinct from a
refusal (`0`) and from a runtime failure (`1`): it means the operator interrupted, so a script can
tell an interruption apart from a completed or failed run. A single cancellation line is printed.

## Typed errors and their codes

Recognised failures map to a stable code and an actionable message. The table lists the observable
condition rather than the internal error name.

| Condition                                | Code  |
| ---------------------------------------- | ----- |
| Legacy configuration shape               | `2`   |
| Invalid JSON in a read file              | `2`   |
| Malformed manifest (top-level shape)     | `2`   |
| Unknown artifact id                      | `2`   |
| Artifact not installed (remove)          | `2`   |
| Dependency cycle in the catalog          | `2`   |
| Cross-catalog `requires` not installed   | `2`   |
| Ref/sha provenance mismatch              | `2`   |
| Unsafe artifact id (path traversal)      | `2`   |
| Invalid `opencode.json`                  | `2`   |
| Malformed `--secret-env` value           | `2`   |
| Required MCP secret unresolved (non-TTY) | `2`   |
| Remote fetch or clone failed             | `1`   |
| Security scan blocked the install        | `1`   |
| Authentication failed (init)             | `1`   |
| Another run holds the lock               | `1`   |
| Canonical deny artifact missing or empty | `1`   |
| Skill scan blocked                       | `1`   |
| Plugin install failed                    | `1`   |
| Any other unexpected error               | `1`   |
| Prompt cancelled (Ctrl+C)                | `130` |

A provenance mismatch is `2`, not `1`: the recorded [ref](/reference/glossary/#ref) and
[sha](/reference/glossary/#sha) no longer agree, so the request is refused before anything is
written. [`--force`](/reference/glossary/#force) never changes this: it overrides a scan finding,
not a provenance check.

## In CI and scripts

Non-interactive runs must pass [`--yes`](/reference/glossary/#yes) for any command that would
confirm, or they exit `2` before touching the network. `2` means the invocation was wrong; `1` means
the environment failed a valid request. Only `check` and `doctor` produce `3`; for every other
command, any non-zero code is a failure.

For the non-interactive guard, a drift gate, and colour control, see
[In CI and scripts](/guides/ci-and-scripts/).
