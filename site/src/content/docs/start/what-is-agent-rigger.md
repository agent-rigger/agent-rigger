---
title: What is agent-rigger?
description: The problem agent-rigger solves — a team's AI-assistant configuration drifting apart across machines — and how it keeps that configuration shared, versioned, and reproducible.
---

An AI coding assistant is only as good as the setup around it: the reusable skills you
give it, the actions you forbid it, the servers you connect it to, the project context
it reads. On one machine that setup takes an afternoon to get right. On a team of ten,
it is done ten times, slightly differently each time.

This page explains what agent-rigger is for, before any command or configuration file.
It assumes no prior knowledge of the tool.

## The problem: the setup drifts apart

Picture a team whose members all use the same assistant. One person writes a handy skill
and keeps it to themselves. Another tightens a permission rule after a scare. A third
connects the assistant to their database through an
[MCP server](/reference/glossary/#mcp-model-context-protocol). None of this is written
down anywhere shared, so each machine slowly becomes its own snowflake. A new hire starts
from an empty setup and copies whatever they can find. When something behaves differently
on one laptop than another, no one can point to why, because no one has the whole picture.

That slow divergence is what we call
[drift](/reference/glossary/#drift): the collection of settings that shape the assistant
— its [harness](/reference/glossary/#harness) — quietly diverging from machine to
machine until "our setup" means nothing precise. Drift is not a dramatic failure; it is
the absence of one. It just accumulates, and the cost lands later, on the person trying
to reproduce a teammate's environment.

## What agent-rigger changes

agent-rigger exists to make the harness a shared, versioned thing instead of a personal
habit.

The team describes its chosen setup once, in a
[catalog](/reference/glossary/#catalog): an ordinary git repository that lists the
pieces the team agrees to share and how they group together. Because the catalog is a
git repository, it is reviewed, tagged, and rolled back like any other code: the team's
setup gains a history and a single source of truth.

From there, each person runs one command to install that setup, another to check it is
still correctly in place, and another to update it when the catalog moves forward.
Because everyone applies the same versioned source the same way, everyone ends up with
the same harness. A new machine reaches the team's baseline in one step rather than by
archaeology.

The tool itself is deliberately empty of opinion. It ships no skills, no rules, no
content. It installs whatever your catalog declares, and nothing it wasn't asked to.
The judgment about _what a good setup is_ stays with your team, in your catalog, where
it can be argued about and versioned.

## How it behaves, and why

Two design choices shape every run, and both come from the same worry: a tool that edits
the files controlling your assistant has to earn trust on each use.

**It shows the change before making it.** Before anything is written, agent-rigger prints
a [plan](/reference/glossary/#plan-dry-run) — the exact files it will touch and rules it
will add — and waits for you to confirm. You approve a change you can read, not a promise
that something reasonable will happen. And because every install records precisely what
it altered, any change can be undone later, offline and exactly, rather than guessed at.

**It treats catalog content as untrusted until checked.** A catalog is just a git
repository, and a git repository can carry anything. So fetched content is
[scanned](/reference/glossary/#scan--scanner) for leaked secrets and misconfigurations
before it is ever copied into place, and a serious finding stops the install. This is an
honest, bounded safety net, not a guarantee: the scanners catch careless mistakes, not a
script written to hide what it does. Where the check cannot be run at all — because the
optional scanner tools are not installed — the tool tells you it is proceeding unchecked
rather than pretending it looked.

The throughline is that you are never surprised by what agent-rigger did, and can always
walk it back.

## What agent-rigger is not

It is **not an AI assistant**. It does not write code, answer questions, or talk to a
model. It configures the assistants you already use — today Claude Code and opencode.

It is **not a content store or marketplace**. The binary contains no skills or rules to
browse and download. Everything installable comes from a catalog you or your team point
it at. There is no central library of blessed content; there is your team's catalog, and
whatever other catalogs you choose to trust.

## Who it is for

agent-rigger is aimed at teams who share an AI coding assistant and are tired of their
setups drifting apart: the people who feel the pain of onboarding a new machine, or of
debugging "works on mine" differences that trace back to a permission rule no one
remembers changing. A solo developer can use it to keep their own setup reproducible
across laptops, but the problem it was built for is the team one.

## Next

- [Install agent-rigger](/start/installation/) on your machine.
- [Walk through your first rig](/start/getting-started/) in about ten minutes.
- Read the [core concepts](/concepts/core-concepts/) behind catalog, manifest, and store.
