---
title: Core concepts
description: "The mental model behind agent-rigger: the catalog of what is available, the manifest of what is installed, the store of what is on disk, and why the tool keeps those three apart."
---

Three plain questions run through everything agent-rigger does: what setup could this
team use, what has actually been put on this machine, and what is physically on disk right
now. The tool keeps those three answers in three separate places, and almost all of its
behaviour follows from keeping them apart. What follows builds that model from those three
places up, before any command or configuration file, and assumes no prior knowledge of the
tool.

## What is available: the catalog

A team writes down the setup it wants to share in a
[catalog](/reference/glossary/#catalog): an ordinary git repository whose root file,
[`catalog.json`](/reference/glossary/#catalogjson), lists the pieces the team agrees on
and how they group together. Nothing about that setup lives inside the agent-rigger
program. The tool reads the catalog remotely at a chosen version, a git
[tag](/reference/glossary/#tag) resolved to an exact commit
[sha](/reference/glossary/#sha), so the catalog is reviewed, tagged, and rolled back like
any other code.

Why a separate git repository rather than a setup baked into the tool? Because a team's
opinion about its own setup changes far more often than the mechanics of installing it.
An earlier design shipped a catalog built into the binary, and every change to the
shared setup then meant cutting a new release of the tool and waiting for everyone to
upgrade. Separating the engine from the content removes that coupling: a team changes what
it installs by opening a merge request against its catalog, and no one waits on a release
of agent-rigger. The judgment about what a good setup is stays with the team, versioned,
where it can be argued about.

That chosen setup, the standardised selection a team applies, is a team's
[rig](/reference/glossary/#rig). A rig is expressed through the catalog: the entries it
declares, and the [packs](/reference/glossary/#pack) that bundle several entries under one
id so a coherent set installs in one step.

## What is installed: the manifest

The catalog says what a machine _could_ install. It does not say what a given machine
_did_. That is the job of the [manifest](/reference/glossary/#manifest): a local file,
`state.json` under `~/.config/agent-rigger/`, that records every
[artifact](/reference/glossary/#artifact) installed on this machine. Each record keeps the artifact's id and [nature](/reference/glossary/#nature),
the [ref and sha](/reference/glossary/#ref) it was taken at, its scope, when it was
installed, the files it wrote, and an [applied payload](/reference/glossary/#applied-payload):
the exact, reversible trace of what the install changed.

The manifest exists as its own record, rather than something re-derived from the catalog
each run, because only it knows this laptop's actual choices: which entries were taken,
at which version, and precisely what each one wrote. That last point is what lets a later
`remove` undo an install offline and exactly, by replaying the applied payload in reverse
instead of guessing at what was once done.

## What is on disk: the store and symlinks

For a [skill](/reference/glossary/#skill) — and for a Claude Code
[agent](/reference/glossary/#agent-sub-agent) — the tool keeps one physical copy in a managed
[store](/reference/glossary/#store) under `~/.config/agent-rigger/`, and points each
assistant's own directory at that copy through a [symlink](/reference/glossary/#symlink). One
copy, several links. (An opencode agent is the exception: its definition is translated into
opencode's schema and written out as a plain file, so it is neither stored nor linked.)

A skill shared by Claude Code and opencode should be one thing to update, not several to
keep in step. Keeping one stored copy behind links, rather than dropping a copy into each
assistant's folder, means an update touches one place and every assistant sees it. When a
filesystem cannot create a symlink, the tool falls back to a plain copy so the install
still works; a copy made this way is still recognised later by comparing its content
against the stored original. Other natures land elsewhere. A
[guardrail](/reference/glossary/#guardrail) merges into a settings file, a
[context](/reference/glossary/#context) artifact writes `AGENTS.md`. The principle holds
across all of them: the manifest records exactly what landed where, so nothing the tool
placed is a mystery later.

## Where it lands: user or project scope

Every install lands in one [scope](/reference/glossary/#scope). `user` scope is
machine-wide, under your home directory (for example `~/.claude/`). `project` scope is
limited to the current repository (for example `.claude/`, and `AGENTS.md` at the repo
root). An artifact declares which scopes it supports, and `install` picks one with
`--scope user` or `--scope project`. The distinction lets a team standardise a rule for every
repository on a machine, or scope it to the one project that needs it, without the two
interfering.

## Why the tool carries no content

The agent-rigger binary ships no content of its own: it is the engine, while the skills,
rules, and context all live in your catalog. That separation shapes how the whole system is
used. Every installed artifact is
[fetched](/reference/glossary/#provenance); none is built in. A consequence is that the
tool cannot impose a setup on you. What gets installed is whatever your catalog declares
and you confirm, and the tool does nothing it was not asked to.

## Drift, and why `check` compares three levels

Because the three answers live in three places, they can diverge independently. Someone
edits an installed file by hand. A store directory gets deleted. A catalog tag moves to a
new commit. Any one of these leaves the [harness](/reference/glossary/#harness) out of step with its declared state while
nothing else looks visibly wrong. That gap is [drift](/reference/glossary/#drift): the
harness quietly diverging from what the manifest claims.

A check that looked at only one level would miss the divergences in the others, so `check`
compares what the manifest records against what is on disk. It reports `0` when everything
the manifest claims is present and matching, and `3` when something is missing or has
drifted from that recorded state, which is the signal a script or CI job reacts to. A moved
catalog tag is a different kind of gap and is reported differently: `check` surfaces it as
an `[update available]` annotation next to the exit code rather than folding it into that
code, because a newer version existing upstream is not the same as this machine being
broken. The
[doctor](/reference/glossary/#doctor) command goes further, classifying what it finds and,
with `--fix`, repairing the safe cases while asking for confirmation on anything
destructive.

## Next

- Learn the [eight artifact natures](/concepts/artifact-natures/) and what each configures.
- Read the [trust and security model](/concepts/trust-and-security/) behind fetched content.
- Look up any term in the [glossary](/reference/glossary/).
