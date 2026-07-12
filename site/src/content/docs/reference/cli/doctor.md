---
title: doctor
description: Diagnose the environment dependencies and the installed state, optionally against a remote catalog differential, and repair the safe findings under consent.
---

## Synopsis

```
agent-rigger doctor [--remote] [--fix [--yes]]
```

Runs two diagnostics in order. First it reports the external tools agent-rigger depends on and
whether it will scan or run [warn-only](/reference/glossary/#warn-only). Then it reads the installed
state and reports what has [drifted](/reference/glossary/#drift), grouped by
[finding](/reference/glossary/#finding) class. It is read-only unless `--fix` is passed.

## Phase 1: environment dependencies

Checks four binaries in order: `git`, `glab`, `gitleaks`, `trivy`.

```
✓ git (/opt/homebrew/bin/git)
✗ trivy — missing  hint: install trivy: ...
```

A mode line follows. `mode : full scan` when `gitleaks` or `trivy` is present. Otherwise
`mode : warn-only (external content not scanned — install gitleaks or trivy)`.

## Phase 2: installed state

Reads the [manifest](/reference/glossary/#manifest) and the on-disk layout for `claude` and
`opencode`, then reports findings grouped into six classes:

| Class       | Meaning                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `untracked` | An artifact on disk with no manifest entry. A conforming one is adoptable; one that diverges from its [store](/reference/glossary/#store) is reported as drift and left alone. |
| `dangling`  | A [symlink](/reference/glossary/#symlink) whose target is gone.                                                                                                                |
| `phantom`   | A store directory nothing references.                                                                                                                                          |
| `manifest`  | An entry that no longer matches reality (orphan catalog, missing sha, missing file, applied-payload drift), or a `state.json` whose top-level shape is invalid.                |
| `lock`      | A leftover [run-lock](/reference/glossary/#run-lock).                                                                                                                          |
| `hygiene`   | Aged temporary files or backups.                                                                                                                                               |

A healthy state prints `Installed state is healthy — no findings.` Each finding is one line: its
summary and a tag, `[fix]`, `[confirm]`, or `[report]`. If a run appears to be in progress (a live
run-lock), the installed-state scan is skipped, reported, and the command exits `0`.

## --remote (differential)

By default phase 2 touches no network. With `--remote`, doctor also fetches every configured
[catalog](/reference/glossary/#catalog)'s content, read-only, and compares it against the host to
surface findings that leave no disk signature: a [guardrail](/reference/glossary/#guardrail) rule,
[context](/reference/glossary/#context) block, or [mcp](/reference/glossary/#mcp) server present at
the host but not tracked. The fetch is [fail-closed](/reference/glossary/#fail-closed--fail-open):
any fetch error stops the command and names the offending source rather than degrading to a
disk-only scan. Combinable with `--fix`.

## --fix (consented repair)

Applies the repairs the findings carry. The [consent](/reference/glossary/#consent) required depends
on the act performed:

| Tag                        | Grant rule                                                                                 | Acts                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `[fix]` (safe)             | [`--yes`](/reference/glossary/#yes) grants it; in a TTY without `--yes` each is confirmed. | Adopting a skill, agent, or plugin entry; deleting orphaned staging or lock-break debris; backing up a malformed `state.json`. |
| `[confirm]` (item-confirm) | `--yes` is never sufficient. Confirmed per item in a TTY; skipped in a non-TTY.            | Removing a dangling symlink; deleting a phantom store; breaking a run-lock; deleting an aged backup.                           |
| `[report]` (report-only)   | No repair.                                                                                 | The manual way out is in the finding's summary.                                                                                |

No destructive act ever runs under a blanket `--yes`. Breaking a run-lock re-verifies the lock's
identity and liveness at the moment it acts. A non-TTY `--fix` without `--yes` exits `2` before any
repair, since the per-item confirmations cannot be obtained.

## Interactive vs non-interactive

Plain `doctor` and `doctor --remote` never prompt. `doctor --fix` prompts per item in a
[TTY](/reference/glossary/#tty--non-interactive). In a non-TTY it needs `--yes` and then applies
only the safe repairs.

## Exit codes

Diagnosis (no `--fix`):

| Code  | Condition                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------- |
| `0`   | Healthy, or the scan was skipped under a live lock.                                                                 |
| `3`   | One or more findings.                                                                                               |
| `2`   | `state.json` shape invalid, or a `--remote` provenance mismatch (checkout sha differs from the resolved ref's sha). |
| `1`   | A `--remote` catalog fetch failed.                                                                                  |
| `130` | Interrupted.                                                                                                        |

Repair (`--fix`):

| Code  | Condition                                                       |
| ----- | --------------------------------------------------------------- |
| `0`   | Every repair applied.                                           |
| `3`   | Findings remain (report-only, refused, or skipped).             |
| `2`   | `state.json` shape invalid, or non-TTY `--fix` without `--yes`. |
| `1`   | A repair failed.                                                |
| `130` | Interrupted.                                                    |

## Example

```
agent-rigger doctor --remote --fix
```

See [exit codes](/reference/exit-codes) for the shared contract.
