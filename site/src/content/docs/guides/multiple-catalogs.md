---
title: Work with multiple catalogs
description: Add a second catalog source, read the combined effective catalog, act on artifacts by qualified id across catalogs, understand why same-named entries never clash, and remove a source.
---

You already install from one catalog and now want a second alongside it: a shared team catalog plus
your own, say. This guide adds a source, reads the combined view, acts on ids that span catalogs,
and drops a source again. For a first run end to end, see
[getting started](/start/getting-started/). For the command's full contract, see the
[`catalog` reference](/reference/cli/catalog/).

## Add a second source

A source is a name paired with a git url. Add one with `catalog add`:

```
agent-rigger catalog add team https://github.com/agent-rigger/agent-rigger-catalog-example.git
```

```
catalog "team" added (https://github.com/agent-rigger/agent-rigger-catalog-example.git)
```

The name must be unique across your configured sources, because it becomes the prefix on every
[qualified id](/reference/glossary/#qualified-id) from that catalog. A name already in use is
rejected, and nothing is written:

```
[error] catalog "example" already exists (https://github.com/agent-rigger/agent-rigger-catalog-example.git).
```

`catalog add` edits configuration only. It does not install anything. In a real terminal it then
fetches the new catalog and offers to install from it (the same picker as
[install](/guides/install-from-catalog/)); in a script or CI job, that offer is skipped and the
source is simply saved.

## See the combined view

`agent-rigger ls` fetches every configured source and shows them as one
[effective catalog](/reference/glossary/#effective-catalog). Each row's first column is the
qualified id, prefixed with the source it came from:

```
Catalog (14 entries):
  [available]  example/skill:hello-rigger  skill
  [available]  example/agent:demo          agent
  [available]  example/pack:demo           pack       (2 members)
  [available]  team/skill:hello-rigger     skill
  [available]  team/agent:demo             agent
  [available]  team/pack:demo              pack       (2 members)
```

The prefix is how you tell two catalogs' entries apart in one listing. For the flags `ls` accepts,
see the [`ls` reference](/reference/cli/ls/).

## Act on artifacts across catalogs

`install`, `update`, and `remove` all take qualified ids, so the catalog is named inside the id. You
work across catalogs by prefix in a single command:

```
agent-rigger install example/skill:hello-rigger team/agent:demo --yes
```

A bare, unqualified id is rejected before any network access, and so is a prefix that names no
configured source. Both are covered in [install from a catalog](/guides/install-from-catalog/);
`ls` prints the exact id to copy.

## Two catalogs, the same name

Nothing stops two catalogs from each defining `skill:hello-rigger`. They do not clash, because
qualification gives each one a distinct id under its own prefix. Adding the example catalog under
two names shows both families side by side:

```
[available]  example/skill:hello-rigger  skill
[available]  team/skill:hello-rigger     skill
```

`example/skill:hello-rigger` and `team/skill:hello-rigger` are two different artifacts as far as the
tool is concerned. You install, update, and remove each by its full qualified id, and installing one
leaves the other untouched.

The unique-name rule on `catalog add` only stops two configured sources from sharing a name. It
does not check what ids a source's own catalog declares, so a source can still ship an entry id
that is itself prefixed with another source's name, and the two qualified ids genuinely collide.
When that happens, `ls` warns about it:

```
[warning] 1 catalog entry deduplicated (duplicate qualified ids discarded): cat-b/skill:x
```

and keeps only one of the two entries. Sources are folded in the order you added them, so the
source added first wins and the later source's matching entry is dropped from the effective
catalog.

## When a source is unreachable

Sources are fetched independently. If one cannot be reached, `ls` (and the other read commands) warn
about that source and carry on with the rest, rather than failing outright:

```
[warning] Catalog "broken" (https://github.com/acme/does-not-exist.git) unavailable (remote: Repository not found.
fatal: repository 'https://github.com/acme/does-not-exist.git/' not found
). Check the URL or run `agent-rigger init`.
Catalog (7 entries):
  [available]  example/skill:hello-rigger  skill
```

Fix the url with `catalog remove` then `catalog add`, or leave it if the outage is temporary.

## Remove a source

Drop a source by name:

```
agent-rigger catalog remove team
```

```
catalog "team" removed.
```

An unknown name is refused:

```
[error] catalog "team" not found.
```

Like `add`, this touches configuration only. Artifacts you installed from that source stay on disk;
their qualified ids just no longer resolve to a configured catalog. To take them off the machine,
uninstall them with [remove](/guides/remove-artifacts/), which reads the manifest and works with no
catalog configured at all.
