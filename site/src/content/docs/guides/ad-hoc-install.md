---
title: Install from a URL or local path
description: Install a single artifact source ad-hoc from a git URL or a local path, read the derived provenance prefix, and know what the scan and the update gap imply.
---

You want content that lives outside your configured catalogs: a git repository, a colleague's fork,
or a folder on disk you are still iterating on. `install` takes a single git URL or local path
directly, with no `catalog add` step in between. For the catalog-backed flow, see
[install from a catalog](/guides/install-from-catalog/); for the full flag surface, see the
[`install` reference](/reference/cli/install/).

One ad-hoc target per invocation. `install` treats an argument as an ad-hoc source when it contains
`://`, starts with `git@`, ends with `.git`, starts with `./`, `/`, or `~/`, or begins with
`github.com/`, `gitlab.com/`, or `bitbucket.org/`. Anything else is read as a
[qualified id](/reference/glossary/#qualified-id).

## Install from a git URL

Pass the clone URL. In a script or any [non-interactive](/reference/glossary/#tty--non-interactive)
session, add `--yes` (without it the run exits `2` before any fetch, see
[interactive vs non-interactive](#interactive-vs-non-interactive)):

```
rigger install https://github.com/agent-rigger/agent-rigger-catalog-example.git --yes
```

The content is fetched, [scanned](#the-content-is-scanned), and shown as a
[plan](/reference/glossary/#plan-dry-run) before anything is written:

```
--- Plan ---
Plan · 7 changes · scope: user (~/.claude)

+ gh-agent-rigger-catalog-example/skill:hello-rigger   ~/.claude/skills/hello-rigger
  link  ~/.claude/skills/hello-rigger → store

+ gh-agent-rigger-catalog-example/agent:demo   ~/.claude/agents/demo.md
  link  ~/.claude/agents/demo.md → store

...

Σ  deny +4 · allow +1 · 1 write · 1 import · 1 hook · 2 links

--- Warnings ---
  [warning] this remote guardrail widens permissions.allow: Read(./.env.example)

--- Result ---
  [ok] Applied 7 file(s).
```

## Install from a local path

Point at a directory instead. An absolute path, a `~/`-relative path, or a `./`-relative path all
work:

```
rigger install /path/to/agent-rigger-catalog-example --yes
```

The plan reads the same, only the [provenance](#the-provenance-prefix) prefix differs:

```
+ local-agent-rigger-catalog-example/skill:hello-rigger   ~/.claude/skills/hello-rigger
  link  ~/.claude/skills/hello-rigger → store
```

## The provenance prefix

An ad-hoc source has no catalog name, so `install` derives one from the source and records it in the
[manifest](/reference/glossary/#manifest) as the id prefix. The rule set is enumerated in the
[`install` reference](/reference/cli/install/#the-three-modes); the shapes you will see:

- `github.com/<owner>/<repo>` → `gh-<repo>`
- `gitlab.com/<owner>/<repo>` → `glab-<repo>`
- another host `<host>/<owner>/<repo>` → `<host-without-TLD>-<repo>`
- a local path → `local-<name>`

That prefix is provenance only. An ad-hoc install does **not** register a catalog source, so
`rigger catalog ls` and `rigger ls` still report `no catalog configured` afterward. What
you got, and where from, lives in the manifest under the derived id.

## The content is scanned

An ad-hoc source is [untrusted content](/reference/glossary/#untrusted-content): every fetched file
is [scanned](/reference/glossary/#scan--scanner) before it reaches disk, exactly as a catalog install
would be. There is no way to skip the scan for an ad-hoc source.

If a scanner (gitleaks or trivy) is installed and reports a finding, the install stops and writes
nothing. Read the finding, and only if you judge it a false positive, re-run with
[`--force`](/reference/glossary/#force) to downgrade it to a warning and proceed. `--force` widens
nothing else: a provenance mismatch or a path-traversal id still refuses the install.

If no scanner is installed, the scan cannot run. The install proceeds and says so:

```
[warning] content not scanned — install gitleaks or trivy then re-run for a full scan; see `rigger doctor`
```

For what the scan looks for and why ad-hoc content is treated as hostile, see
[trust and security](/concepts/trust-and-security/).

## Interactive vs non-interactive

With a TTY and no `--yes`, `install` opens a blocking picker to choose which of the source's entries
to install, then asks you to confirm the plan. Both steps require a real terminal.

Without a TTY, there is no picker: `--yes` is mandatory and selects **every** entry the source
offers. This is a deliberate select-all over untrusted content, which is why the scan is not
optional. Omit `--yes` in a non-interactive session and the run exits `2` before any network access
(the full non-interactive contract lives in [CI and scripts](/guides/ci-and-scripts/)):

```
[error] non-interactive session — pass --yes to confirm non-interactively
```

## Ad-hoc installs are not tracked for updates

Because no catalog is registered, `update` has nothing to resolve against and refuses, exit `2`:

```
[error] No catalog URL configured.
  Run `rigger init` to configure the catalog URL.
```

`check` does not refuse the same way. Like `ls` and `catalog ls`, it treats a missing catalog as
informational rather than an error, and exits `0`:

```
no catalog configured — run `rigger init`
```

To refresh an ad-hoc artifact, re-run the same `install <url|path> --yes`: it re-fetches and
re-applies. To uninstall, use [`remove`](/guides/remove-artifacts/) with the derived qualified id
(remove is offline and reads the manifest, so the derived prefix is all it needs):

```
rigger remove gh-agent-rigger-catalog-example/agent:demo --yes
```

For a source you will track over time, add it as a catalog instead
(`rigger catalog add <name> <url>`) and install by qualified id, which keeps `update` and
`check` working. See [install from a catalog](/guides/install-from-catalog/), and
[work with multiple catalogs](/guides/multiple-catalogs/) if that makes it your second source.
