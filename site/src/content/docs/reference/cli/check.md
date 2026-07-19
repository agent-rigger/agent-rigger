---
title: check
description: The read-only audit of installed guardrails and context against their recorded state, with advisory catalog status.
---

## Synopsis

```
rigger check [--scope=<user|project>] [--assistant=<claude|opencode>]
rigger <resource> check [--scope=<user|project>] [--assistant=<claude|opencode>]
```

`check` audits whether the [guardrails](/reference/glossary/#guardrail) and
[context](/reference/glossary/#context) it is responsible for are correctly installed and still
match their recorded state. It writes nothing to the harness and never executes a catalog-declared
command, but it is not offline: it fetches every configured catalog and runs `git ls-remote` per
catalog (a read-only network access) to compute the advisory sections below. The resource form
restricts the audit to one [nature](/reference/glossary/#nature).

## Arguments

`check` takes no positional arguments. In the resource form the resource token selects the nature to
audit (for example `rigger guardrails check`).

## Flags

| Flag          | Effect                                                                                                                                                                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--scope`     | Audit the `user` or `project` scope; default `user`.                                                                                                                                                                                                                                      |
| `--assistant` | Audit as `claude` or `opencode`. When omitted, the assistant is read from the [manifest](/reference/glossary/#manifest) when every audited entry was installed for one assistant; otherwise it is resolved as described in the [overview](/reference/cli/overview/#assistant-resolution). |

## What it audits

`check` audits the governance baseline the catalogs declare
([required](/reference/glossary/#required) and [recommended](/reference/glossary/#recommended),
with packs expanded), plus any guardrail or context already installed for the resolved assistant so
that [drift](/reference/glossary/#drift) is still caught. An available but undeclared, not-installed
entry is left alone, so adding a second catalog does not by itself turn `check` red. (Why a catalog
lists what a machine _could_ install rather than what it _must_ is covered in
[core concepts](/concepts/core-concepts/#what-is-installed-the-manifest).)

## Advisory sections

After the audit, `check` may print two advisory sections computed from the manifest and the
configured catalogs:

- `--- Catalogs ---`: one status line per configured catalog (up to date, an update available,
  reachable, or unreachable).
- `--- Updates ---`: one line per installed artifact behind its catalog's latest version.

These sections are informational. They never change the exit code: a stale catalog or an
unreachable one still leaves `check` at `0` when everything audited is present and matching.

## Exit codes

| Code | Condition                                                                                     |
| ---- | --------------------------------------------------------------------------------------------- |
| `0`  | Everything audited is present and matches its recorded state (or there was nothing to audit). |
| `3`  | One or more audited entries are missing or drifted.                                           |
| `2`  | A file needed for the audit is invalid JSON or the manifest is malformed.                     |

With no catalog configured, `check` prints the following and exits `0`:

```
no catalog configured — run `rigger init`
```

See [exit codes](/reference/exit-codes) for the shared contract.

## In CI

`check` writes nothing to the harness and never executes a catalog-declared command, but it does
reach the network (read-only git fetch and `ls-remote`) to resolve catalog status.

To gate a pipeline on drift, see [In CI and scripts](/guides/ci-and-scripts/).

## Example

```
rigger check --scope=project
```
