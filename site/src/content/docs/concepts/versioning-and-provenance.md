---
title: Versioning and provenance
description: "How agent-rigger knows, for every installed artifact, which version it is and where it came from: a semver tag resolved to an exact commit, that commit stored as the record, and the mismatch check that refuses content which is not the version it claims."
---

When agent-rigger puts a file on your machine, it records which version of your team's
shared setup that file came from. The point is to answer a plain question at any later
date: what exactly is installed here, and where did it come from? Answering it reliably
takes more than saving a version number, because a version tag is a name a person chooses
and can later re-point at different content.

## A version tag can move

A team marks a release of its [catalog](/reference/glossary/#catalog) with a
[tag](/reference/glossary/#tag), a short human name that follows
[semver](/reference/glossary/#semver) such as `v0.1.3`. A tag is convenient for people and
unreliable as a record on its own, because git lets whoever controls the repository
re-point a tag at a different commit whenever they choose. A tag that can silently change
what it means cannot, by itself, tell you months later what you installed. So rather than
trust the tag as written, the tool turns it into something that does not move.

## Resolving a tag to a commit

Before it fetches anything, the tool asks the remote which tags exist and what each one
points at, with `git ls-remote --tags`. Among the tags that parse as semver it keeps the
greatest one, and it keeps that tag's commit [sha](/reference/glossary/#sha). Two values
come out of this step. The [ref](/reference/glossary/#ref) is the tag name a human reads.
The sha is the exact commit that tag pointed at the moment the tool looked. The ref stays
human-facing; the sha is the part that pins content.

A catalog release is a single tag for the whole repository, not a version per entry.
Letting each artifact carry its own version would be more flexible for publishing one
artifact without touching the rest, but it removes the single repository-level tag and
makes resolving and comparing versions heavier, so a release stays one tag covering every
entry it contains.

When a catalog carries no semver tags at all, resolution falls back to the sha of the
default branch's `HEAD` (`git ls-remote <url> HEAD`), and the ref stored is that sha
itself, so ref and sha are equal. This lets you consume a catalog nobody has tagged yet, at
a cost: `HEAD` moves as the branch advances, so a version resolved this way is not
reproducible over time. A tag is the right choice once a catalog is stable enough to depend
on.

## Storing the commit, not just the tag

Each entry in the [manifest](/reference/glossary/#manifest) records both values, the ref
and the sha, for the version it was installed at. Keeping the sha and not only the tag is
what makes the record durable. The tag tells a person which release this was. The sha says
precisely which commit's bytes landed, independently of where the tag points now. That pair
is what [provenance](/reference/glossary/#provenance) means here: the catalog's name
together with the ref and sha an artifact was fetched at. Every installed artifact carries
it, because every installed artifact is fetched and none is built into the binary.

## Re-checking the commit after the clone

Resolution and fetching are two separate steps, and the gap between them is where a tag
can betray the record. The tool resolves the sha with `ls-remote`, then clones the content
in a second operation, a [shallow clone](/reference/glossary/#shallow-clone) of only the
commit it needs. Nothing about running those two steps back to back guarantees they agree:
the commit that lands under the tag's name in the clone is not always the commit
`ls-remote` named a moment before. The
[trust and security](/concepts/trust-and-security/) page walks through the two concrete
ways that gap opens; for this page, the fact that it can open at all is what matters,
because it is the reason the tool does not simply trust the sha it resolved.

Rather than assume the clone produced the resolved commit, the tool checks it. Right after
the checkout it runs `git rev-parse HEAD` on the cloned directory and compares that commit
to the sha it resolved earlier. When they match, the sha recorded in the manifest is the
commit actually on disk, not merely the one `ls-remote` named a step before. When they
differ, the install is refused before the catalog is even read, and the tool says so in a
message built from this exact string:

```
Invalid provenance for ref "${ref}": expected sha ${expectedSha}, found sha ${foundSha} on the checkout. Installation refused — this check cannot be bypassed with --force.
```

The `${ref}` is the tag that was resolved, `${expectedSha}` the commit `ls-remote`
returned for it, and `${foundSha}` the commit that was actually on disk after the clone.

## The mismatch is a signal, not a detail

A tag that no longer points where it pointed is not routine bookkeeping: installing the
content anyway and recording a sha that disagrees with the ref the manifest claims would
produce a record that lies about itself. The tool refuses instead, and a script sees that
refusal as [exit code](/reference/exit-codes/) 2.

This refusal does not go through the scan gate, and `--force` cannot lift it. What that
boundary does and does not cover is the [trust and security](/concepts/trust-and-security/)
page's concern. What belongs here is narrower: without this check, the sha the manifest
stores would be a guess about what `ls-remote` reported before the clone, not a fact about
what is actually on disk. The check is what turns it back into a fact.

## What a moved tag means afterwards

Because the installed sha is on record, `check` and `update` compare it against the sha
freshly resolved from the remote. A tag re-pushed to a new commit reads as an update
available, even though its name never changed, because the comparison is between commits
and not between names. The reverse holds too: content identical under a renamed ref is not
reported as an update. A comparison that looked only at the version name would miss both
cases, and the stored sha is what makes them visible.

One exception: an entry installed by an older build that predates sha tracking has no
stored sha. For those entries the tool falls back to comparing version names, so a
same-name re-push stays invisible, exactly as it did before the sha was recorded. That is a
known limit of legacy entries, not the behaviour going forward.

## Next

- See how `install` points at a catalog and a version in the
  [install reference](/reference/cli/install/).
- Read the security boundary around the mismatch check in
  [trust and security](/concepts/trust-and-security/).
- Look up any term in the [glossary](/reference/glossary/).
