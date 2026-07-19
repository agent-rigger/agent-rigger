---
title: Update installed artifacts
description: See which installed artifacts are behind their catalog, update all or specific ids, read the outcome tags, and rely on the transactional confirm.
---

Your catalog moved forward and you want the newer versions on this machine. This guide shows how to
see what is behind, update everything or a chosen set, and read the result. For the complete flag
surface, see the [`update` reference](/reference/cli/update/).

## See what is behind

Two read-only ways.

`rigger check` prints an advisory `--- Updates ---` section listing every installed artifact
behind its catalog's latest version, and a `--- Catalogs ---` section with per-catalog status:

```
--- Catalogs ---
  [up-to-date]   example  (v0.4.0)
```

These sections are informational: they never change check's exit code. A stale entry there is a
heads-up, not a failure.

`rigger update` with no ids classifies every installed artifact and shows a plan before it
touches anything. Decline the confirmation to keep everything as it is.

## Update everything or a chosen set

All installed artifacts:

```
rigger update
```

Specific [qualified ids](/reference/glossary/#qualified-id):

```
rigger update example/skill:hello-rigger
```

An unqualified id is rejected before any fetch:

```
[error] unqualified id "skill:hello-rigger" — use `<catalog>/skill:hello-rigger` (see `rigger ls`)
```

## Read the outcome

Each candidate ends in one of three states:

- `[updated]  <id>  → <ref>`: was behind, now re-installed at `<ref>`.
- `[up-to-date]  <id>  (<ref>)`: already at the latest version, nothing touched.
- `[skipped]  <id>  <reason>`: not acted on. The reason is `not installed` (no manifest entry for
  this scope and assistant) or `no remote version` (installed without a catalog ref, so there is
  nothing to compare against).

A run where everything is current looks like this (the CLI prints each outcome line indented two
spaces; the samples here are shown flush-left):

```
[up-to-date]  example/skill:hello-rigger  (v0.4.0)
[up-to-date]  example/agent:demo  (v0.4.0)
```

When nothing is installed, update has no candidate to classify: it makes no changes, prints
nothing, and exits `0`.

## The confirm is transactional

Updating a stale artifact removes the old version and applies the new one under a single lock. The
confirmation always comes before any removal:

```
Update N artifact(s):
  <id>  <old-ref> → <new-ref>
```

Decline it and nothing is removed or written: the artifact stays at its installed version. A network
failure or an invalid fetched catalog aborts the same way, before the removal, so a failed update
never leaves you with a half-removed artifact. Files that are replaced are backed up as
[`.bak-*`](/reference/glossary/#backup-bak) copies first.

## Automate it

In a script or CI job, pass `--yes` to accept the confirmation up front:

```
rigger update --yes
```

Without a TTY and without `--yes`, update exits `2` before any network access. See
[CI and scripts](/guides/ci-and-scripts/).
