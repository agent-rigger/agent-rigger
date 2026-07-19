---
title: install
description: Install artifacts interactively, by qualified id, or ad-hoc from a URL or path, through the fetch-scan-resolve-confirm-apply pipeline.
---

## Synopsis

```
rigger install [--scope=<user|project>] [--assistant=<claude|opencode>]
rigger install <id...> [--yes] [--force] [--secret-env=<ref>=<VAR>]...
rigger install <url|path> [--yes] [--force]
```

`install` adds artifacts to the current machine for one [assistant](/reference/glossary/#assistant).
It runs in one of three modes depending on its arguments: an interactive picker when none are given,
a list of [qualified ids](/reference/glossary/#qualified-id) for a scripted install, or a single
URL or path for an ad-hoc install. Every mode shows a [plan](/reference/glossary/#plan-dry-run) and
writes nothing until you confirm.

## Arguments

| Argument      | Mode                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| _(none)_      | Interactive: fetch the [effective catalog](/reference/glossary/#effective-catalog), pick from a grouped list. |
| `<id...>`     | One or more qualified ids, `<catalog>/<nature>:<name>`.                                                       |
| `<url\|path>` | A single git URL or local path, installed ad-hoc.                                                             |

An unqualified id, a prefix that is not configured, and no catalog at all are each rejected before
any network access, all exit `2`:

```
[error] unqualified id "<id>" — use `<catalog>/<id>` (see `rigger ls`)
[error] catalog "<prefix>" not configured — see `rigger catalog ls`
[error] no catalog configured — run `rigger init`
```

## Flags

| Flag                       | Effect                                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--scope`                  | Install to `user` (machine-wide) or `project` (current repository); default `user`.                                                                                         |
| `--assistant`              | Target `claude` or `opencode`; otherwise resolved as described in the [overview](/reference/cli/overview).                                                                  |
| `--yes`                    | Skip the confirmation prompt. In interactive mode it is not used; in id and ad-hoc modes it applies the plan without asking.                                                |
| `--force`                  | Downgrade a blocking security [scan](/reference/glossary/#scan--scanner) finding to a warning and proceed.                                                                  |
| `--secret-env=<ref>=<VAR>` | Map a catalog [secret reference](/reference/glossary/#secret-by-environment-reference-var) to an environment variable on your machine. Repeatable; last value wins per ref. |

## The three modes

**Interactive.** With no ids, `install` asks for the scope (unless `--scope` was given), classifies
every catalog entry against the manifest and the remote version, and shows a picker grouped into
_to install_, _to update_, and _up to date_. When nothing is actionable it prints the following and
exits `0`:

```
✓ Everything already up-to-date for scope "<scope>" (<n> artifact(s) installed). Use `rigger remove` to uninstall.
```

Selecting nothing prints `No artifacts selected — nothing to install.` and exits `0`.

**By qualified id.** Ids are grouped by catalog prefix and installed one source at a time. A
[pack](/reference/glossary/#pack) expands to its members, and each artifact's
[`requires`](/reference/glossary/#requires) chain is pulled in.

**Ad-hoc.** A single URL or path installs content from outside the configured catalogs. It is
treated as [untrusted](/reference/glossary/#untrusted-content): every fetched file is scanned before
anything is written. The manifest records a derived source prefix so provenance is kept:
`github.com/...` becomes `gh-<repo>`, `gitlab.com/...` becomes `glab-<repo>`, another host becomes
`<host-without-TLD>-<repo>` (the second-level domain label; `git.company.io/owner/repo` →
`company-repo`), and a local path becomes `local-<name>`. Under `--yes` the ad-hoc install selects
every entry; without it, a picker is shown.

## Pipeline

Each source install runs the same steps: resolve the remote version, [shallow-clone](/reference/glossary/#shallow-clone)
the content, guard against path-traversal ids, scan (`catalog.json` and every fetched artifact),
merge and resolve the selection, build the plan, confirm, then apply: [backup](/reference/glossary/#backup-bak),
write, record the [manifest](/reference/glossary/#manifest). No file is written before the scan
passes and the plan is confirmed.

When no scanner tool is installed, the scan degrades to warn-only and the install proceeds:

```
[warning] content not scanned — install gitleaks or trivy then re-run for a full scan; see `rigger doctor`
```

When a scanner is present and reports a blocking finding, the install stops (`ScanBlockedError`)
unless `--force` is set.

### What `--force` does not bypass

`--force` overrides a scan finding and nothing else. It does not bypass a ref/sha provenance
mismatch (`RefShaMismatchError`), a path-traversal id, or an unsatisfied cross-catalog
`requires`. Each of those refuses the install and exits `2`, forced or not.

## Interactive vs non-interactive

Interactive mode (no ids) needs a TTY: on a non-interactive session its picker cannot open, so the
run is rejected immediately, before any network access, even under `--yes`:

```
[error] interactive picker requires a TTY — pass explicit ids to install non-interactively
```

In a non-interactive session, id and ad-hoc installs require `--yes`; without it the run exits `2`
before any network access (`[error] non-interactive session — pass --yes to confirm non-interactively`).
Under `--yes`, a required MCP secret with no `--secret-env` mapping and no ambient value is a
fail-closed error (exit `2`), since no prompt is possible.

## Exit codes

| Code  | Condition                                                                                                                                                                                                                                          |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`   | Installed, or nothing to install / selection declined.                                                                                                                                                                                             |
| `2`   | Bad or unqualified id, unknown entry, dependency cycle, unsatisfied cross-catalog require, provenance mismatch, no catalog configured, no ids on a non-TTY session, non-TTY without `--yes`, malformed `--secret-env`, unresolved required secret. |
| `1`   | Fetch or clone failed, scan blocked (no `--force`), another run holds the lock, plugin or skill install failed.                                                                                                                                    |
| `130` | A prompt was cancelled with Ctrl+C.                                                                                                                                                                                                                |

See [exit codes](/reference/exit-codes) for the shared contract.

## Example

```
rigger install team/skill:spec-workflow --scope=project --yes
```
