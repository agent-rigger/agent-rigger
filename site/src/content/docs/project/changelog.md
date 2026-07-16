---
title: Changelog
description: "A dated snapshot of the agent-rigger changelog: the format it follows, the changes recorded at this commit, and where the continuously updated version lives."
---

This page is a point-in-time snapshot of the project's changelog, kept here so you can read what
has changed without leaving the documentation. It is not the source: the next section says which
commit it was written against and where the living file lives.

## A snapshot, not the source

The content below was written on **2026-07-16**, against commit `9cc8d2d`, and every entry was
checked against the code at that commit. The living, continuously updated changelog is
[`CHANGELOG.md` in the repository](https://github.com/agent-rigger/agent-rigger/blob/main/CHANGELOG.md).
For anything newer than that date, start with that file; this page stops at the snapshot.

## The format it follows

The changelog is written in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) style:
changes are grouped by kind (Added, Changed, Fixed, and so on) under a heading for each release,
with the newest at the top. Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html): `MAJOR.MINOR.PATCH`.

agent-rigger is **pre-1.0**. Under semver, that means the `0.x` line makes no stability promise
across minor versions: anything can change between `0.1` and `0.2`, and you should read the
changelog before upgrading rather than assume a minor bump is safe.

## Where the project is today

The latest tagged release is **v0.1.2**. It is installable now — via Homebrew, a prebuilt GitHub
release binary, or a build from source — as described on the [Installation](/start/installation/)
page. A build from source reports its version as `0.0.0`, which is cosmetic: the real version is
stamped from the git tag only during the release build.

The changelog keeps its entries under a single **Unreleased** heading rather than a per-version
breakdown. The section below restates what that heading covered at this snapshot.

## Unreleased

### Added

The commands that make up the tool, each documented in full on its own reference page:

- [**`check`**](/reference/cli/check/) — a read-only audit of the installed
  [guardrails](/reference/glossary/#guardrail) and [context](/reference/glossary/#context) against
  their recorded state. It reports
  [drift](/reference/glossary/#drift) and exits `3` when it finds a missing or drifted entry, `0`
  when everything matches, and `2` when a file it needs is invalid JSON. See
  [exit codes](/reference/exit-codes/) for the shared contract.
- [**`install`**](/reference/cli/install/) — an interactive picker, or `install <id…>` for a
  named set. It resolves [packs](/reference/glossary/#pack) and dependencies, shows a plan
  grouped by [artifact](/reference/glossary/#artifact), backs up before writing, and never
  writes without confirmation (`--yes` skips the prompt).
- [**`remove`**](/reference/cli/remove/) — uninstall artifacts with a reversible plan, backups,
  and the same `--yes`.
- [**`update`**](/reference/cli/update/) — re-install external artifacts whose remote version is
  newer than the installed one.
- [**`init`**](/reference/cli/init/) — configure a [catalog](/reference/glossary/#catalog) URL and
  authentication. It probes ambient auth first and persists the configuration only on success.
- [**`ls`**](/reference/cli/ls/) — list catalog entries across every configured catalog source,
  with their install status.
- [**`doctor`**](/reference/cli/doctor/) — report the detected external dependencies and the active
  [scan](/reference/glossary/#scan--scanner) mode.

And the capabilities beneath those commands:

- **Multiple catalogs** — [`catalog add`](/reference/cli/catalog/) plugs in named catalogs, and
  installs are routed to the right source by a qualified id prefix. The
  [multiple catalogs guide](/guides/multiple-catalogs/) walks through it.
- **Remote install with provenance** — external artifacts record the real
  [ref](/reference/glossary/#ref) and [sha](/reference/glossary/#sha) they were fetched at, and
  fetched content is scanned before it lands on disk when a scanner is present. How the version is
  pinned and re-checked is covered in
  [versioning and provenance](/concepts/versioning-and-provenance/); the scan boundary, and what
  happens without a scanner installed, in [trust and security](/concepts/trust-and-security/).
- **Transactional apply** — a partial failure rolls back from the backups taken before the write,
  so an interrupted run does not leave a half-changed [harness](/reference/glossary/#harness).
  See [safety and reversibility](/concepts/safety-and-reversibility/) for the guarantees and
  their limits.

### Invariants

Four properties hold across every command: an install repeated changes nothing the second time
(idempotence), a backup is taken before any write, a human confirms before anything is written,
and nothing fails silently. What each one covers, and where the edges are, is explained in
[safety and reversibility](/concepts/safety-and-reversibility/).

## Where the authoritative text lives

- [`CHANGELOG.md`](https://github.com/agent-rigger/agent-rigger/blob/main/CHANGELOG.md) — the
  living changelog, updated with each change. This page is a dated, verified restatement of it.
- The [commit history on `main`](https://github.com/agent-rigger/agent-rigger/commits/main) — the
  full record of what changed and when, past what any changelog summarises.
