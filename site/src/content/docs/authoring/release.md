---
title: Publish a release
description: Cut a versioned release of your catalog with a semver git tag, understand how that tag resolves to an exact commit when a teammate installs, see what consumers get on update, and know why moving a published tag backfires.
---

You have a catalog that works: content committed and installed once from a local path, proven on your
own machine. Publishing turns it into something your team can pin to: a named version, not a moving
commit. This how-to is the publish contract.

Building the repository, writing `catalog.json`, and the edit-then-install loop are the tutorial's
job: [create a catalog](/authoring/create-a-catalog/) walks all of that, including cutting your very
first tag locally. This page picks up once you have content worth releasing to other people, and the
_why_ behind the mechanics lives in [versioning and provenance](/concepts/versioning-and-provenance/),
linked where it matters rather than repeated here.

## Tag a version with semver

A release is one git tag over the whole catalog repository. There is no per-entry version: the tag
you cut covers every entry in `catalog.json` at that commit. Tag the commit you want to ship:

```sh
git tag -a v0.4.0 -m "v0.4.0"
```

The `-a` cuts an annotated tag, which is the conventional choice for a release; a lightweight tag
(`git tag v0.4.0`) resolves identically, because the tool reads the commit each tag points at, not
the tag object. The name must parse as [semver](/reference/glossary/#semver): `MAJOR.MINOR.PATCH`,
with an optional leading `v` and an optional prerelease suffix (`v0.4.0-rc.1`). A tag that is not
semver (`release-april`, `latest`) is simply ignored at resolution time, never an error. When several
semver tags exist, the tool keeps the **greatest** one, and a prerelease sorts below the release it
precedes (`v0.4.0-rc.1` < `v0.4.0`).

The thing you are releasing is the catalog file and its artifacts. The exact entry — one
[skill](/reference/glossary/#skill), the same `hello-rigger` the
[example catalog](/authoring/create-a-catalog/) ships — looks like this inside `catalog.json`:

```json title="entry in catalog.json"
{
  "kind": "artifact",
  "id": "skill:hello-rigger",
  "nature": "skill",
  "targets": ["claude"],
  "scopes": ["user", "project"],
  "requires": ["tool:git"]
}
```

Every field an entry may carry, for each of the eight natures, is in the
[catalog.json schema](/reference/catalog-schema/); what each nature writes on the installing machine,
per [assistant](/reference/glossary/#assistant) and [scope](/reference/glossary/#scope), is the
[natures × assistants × scopes](/reference/natures-matrix/) matrix. Nothing about a release changes
per nature: the tag covers whatever the catalog contains.

## Push the tag

A tag is invisible to your team until it reaches the remote. `git push` on its own does not carry
tags, so push it by name:

```sh
git push origin v0.4.0
```

Until this runs, `git ls-remote` against your catalog's URL returns nothing for `v0.4.0`, so no
teammate can resolve it. Push the tag and the release exists for everyone pointing at that URL.

## How a tag resolves to a commit

A consumer never installs "the tag" as written. Before fetching anything, the tool asks the remote
which tags exist with `git ls-remote --tags -- <url>`, keeps the greatest semver tag, and, from it,
reads the exact commit [sha](/reference/glossary/#sha) that tag points at. Two values come out: the
[ref](/reference/glossary/#ref) — the tag name a human reads — and the sha, the commit that pins the
content. Both are recorded in the consumer's [manifest](/reference/glossary/#manifest).

Storing the commit and not only the name is what makes the record durable, and the full reasoning —
including the check that refuses content which is not the version it claims — is in
[versioning and provenance](/concepts/versioning-and-provenance/). For publishing, one consequence is
enough: **the commit is the record, the tag name is just a label on it.**

If your catalog carries no semver tag at all, resolution falls back to the default branch's `HEAD`
sha. That lets someone consume an untagged catalog, but `HEAD` moves as the branch advances, so the
version is not reproducible over time. Cut a tag as soon as the catalog is stable enough to depend
on.

## What your team sees on update

Once the tag is pushed, a teammate who has your catalog configured resolves to it automatically. A
read-only [`check`](/guides/update-artifacts/) reports the catalog at your version:

```
--- Catalogs ---
  [up-to-date]   example  (v0.4.0)
```

The `(v0.4.0)` is the ref the tool resolved: your highest semver tag. When you later publish a
higher tag, the same `check` moves the catalog into an `--- Updates ---` section, and
[`rigger update`](/guides/update-artifacts/) re-installs each behind artifact, printing
`[updated]  <id>  → <ref>` per artifact. Cutting and pushing a new, higher tag is the whole act of
shipping a change to the team.

## Don't move a published tag

Once a tag is pushed, treat it as immutable. Publish a fix as a new, higher tag. Never re-point an
existing one. Two things happen if you do.

First, moving a tag to a different commit is not silent to consumers, precisely because the record is
the commit and not the name. `check` compares the installed sha against the freshly resolved one, so
a tag re-pushed to a new commit reads as an update available even though its name never changed:

```
--- Catalogs ---
  [update]       demo  → v1.0.0  (1 artifact(s) behind)

--- Updates ---
  [update available]  demo/skill:greet  v1.0.0 → v1.0.0
```

Both sides read `v1.0.0`, yet the artifact is flagged behind. The comparison is commit-to-commit, not
name-to-name. Running `update` re-installs it under the same name:

```
--- Update ---
  [updated]     demo/skill:greet  → v1.0.0
```

That is a silent content swap under a name people trusted to be stable, which is exactly why you cut
`v1.0.1` instead.

Second, there is a harder guard you can trip. When the commit that actually checks out disagrees with
the sha the tool resolved from the tag — a branch that shares the tag's name, or the tag moving in the
window between resolution and clone — the install is refused outright, before the catalog is even
read:

```
[error] Invalid provenance for ref "v1.2.0": expected sha 9f2c1ab8e7d4c05b3a61f8e29d7c4b0a5e13f6d2, found sha 4b17de0c9a2f8e1d6b30a5c74e9f21038d6ac5b1 on the checkout. Installation refused — this check cannot be bypassed with --force.
```

The ref is the tag that was resolved. The expected sha is the commit `ls-remote` returned for it, and
the found sha is the commit actually on disk after the clone. A script sees this as
[exit code](/reference/exit-codes/) `2`, and [`--force`](/reference/glossary/#force) does not lift it.
Provenance is not a scan policy. Why the tool cannot simply trust the sha it resolved, and the two
concrete ways the gap opens, are covered in
[versioning and provenance](/concepts/versioning-and-provenance/).

## Test a release before you publish

You do not need a remote to rehearse a release. Because the tool resolves versions over git, the same
`ls-remote --tags` / highest-semver rule applies to a local path, so you can tag locally and install
from the folder, then read the resolved tag back before anything is pushed.

Work against a throwaway install target, exactly as the [tutorial](/authoring/create-a-catalog/) sets
up (`export RIGGER_HOME="$(mktemp -d)"`), so nothing touches your real `~/.claude`. Register the
catalog by local path, install one entry, and let `check` confirm the tag:

```sh
rigger catalog add example "$(pwd)"
rigger install example/skill:hello-rigger --yes
rigger check
```

```
--- Catalogs ---
  [up-to-date]   example  (v0.4.0)
```

`check` printing your tag against a local path is the proof the release resolves before it ever
leaves your machine. For a one-off install straight from a URL or path without registering a catalog,
see [install from a URL or local path](/guides/ad-hoc-install/). Only once `check` reads the tag you
expect do you push it.

## Where to go next

- The reasoning behind storing the commit and the refusal check:
  [versioning and provenance](/concepts/versioning-and-provenance/).
- Every field a catalog entry may carry: the [catalog.json schema](/reference/catalog-schema/).
- What each nature writes per assistant and scope:
  [natures × assistants × scopes](/reference/natures-matrix/).
- How consumers pull your releases day to day:
  [update installed artifacts](/guides/update-artifacts/).
