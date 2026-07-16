---
title: Changelog
description: "How agent-rigger keeps its changelog — Keep a Changelog and Semantic Versioning, entries curated under Unreleased, a scripted rotation guarded in CI — and where to read the live version."
---

Every change a user would notice — a new command, a changed default, a fixed bug — is written
down before it ships, so you can tell what moved between the version you have and the one you are
about to install. This page explains how that record is kept. It does not reproduce the
changelog: the real one lives in the repository, and the links at the foot of this page point to
it.

## The format it follows

The changelog is written in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) style.
Changes are grouped by kind — Added, Changed, Fixed, and so on — under a heading for each release,
newest at the top. Version numbers follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html): `MAJOR.MINOR.PATCH`.

agent-rigger is pre-1.0. Under Semantic Versioning a `0.x` line makes no stability promise across
minor versions — behaviour can change between `0.1` and `0.2` — so read the changelog before
upgrading rather than assume a minor bump is safe.

## How entries are recorded

While work is in flight, each change adds its own line under an `## [Unreleased]` heading in the
changelog, grouped by kind. The entries are written by hand as pull requests land — curated, not
generated from commit titles — so the record describes what changed in a reader's terms.

## What a release does to it

Nothing about the changelog is decided by a language model at release time. Cutting a release runs
one deterministic script:

```sh
bun scripts/release-changelog.ts X.Y.Z
```

It moves the entries under `## [Unreleased]` into a new dated section, `## [X.Y.Z] - YYYY-MM-DD`,
empties Unreleased, and rewrites the version links at the foot of the file. It refuses to run if a
section for that version already exists, or if Unreleased has nothing to release: the rotation
either produces a correct section or stops. The maintainer then commits the rotation, tags the
release `vX.Y.Z`, and pushes the tag, which triggers the release build.

## The guard in CI

A tagged release is not allowed to ship without its changelog section. Before it installs or
builds anything, the release workflow checks that the changelog has a `## [X.Y.Z]` section
matching the tag. If the rotation was skipped, the run stops there — fail-closed — and prints the
exact command to fix it. No path publishes a tagged release with an undocumented changelog. The
step-by-step for maintainers is in
[CONTRIBUTING.md, under Releasing](https://github.com/agent-rigger/agent-rigger/blob/main/CONTRIBUTING.md#releasing).

## Where to read it

- [`CHANGELOG.md` on `main`](https://github.com/agent-rigger/agent-rigger/blob/main/CHANGELOG.md) —
  the live, continuously updated changelog. The `## [Unreleased]` section at the top is what the
  next release will ship; the dated sections below it are past releases.
- [The Releases page](https://github.com/agent-rigger/agent-rigger/releases) — each tagged
  release, with its downloadable binaries and notes.
