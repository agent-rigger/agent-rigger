---
title: Adopting it for a team
description: "What adopting agent-rigger commits a team to: a generic, open-source tool that holds nothing of yours, your setup kept in a repository you own, access that reuses the git credentials already on each machine, and one checked-in file that onboards everyone."
---

Before a team adopts a tool, someone has to answer a plain question that is not really
technical at all: what does bringing it in commit us to, and what of ours ends up inside it?
For agent-rigger the answer is short. The tool is free to use and its source is open, so
there is no vendor to sign with and no licence to renew. Nothing about your team goes into
the tool itself. Everything your team decides to share stays in a place you own, and the tool
only reads from it. This page is for whoever weighs that decision, and it stays out of the
mechanics that the other pages here cover.

## The tool is generic, and its source is open

agent-rigger is published under the Apache 2.0 licence. That is a permissive open-source
licence: you can read every line and build on it without asking. There is no paid
tier gating a feature you need, and no account the tool phones home to.

Just as important as the licence is what the tool does _not_ contain. It ships as an engine
with no setup of its own baked in. None of your team's rules, [skills](/reference/glossary/#skill), or
[context](/reference/glossary/#context) is written into the program. The alternative would be
a tool that arrives with an opinion already compiled into it, which every team then has to
accept or work around. agent-rigger
takes the opposite shape: it knows _how_ to install and update a shared setup, and stays
deliberately ignorant of _what_ that setup is. The
[reasoning behind an engine that carries no content](/concepts/core-concepts/) is covered on
its own page; for an adoption decision, the consequence is what counts. Nothing proprietary
to your organization lives in a repository anyone else can read, because it lives nowhere near
the tool.

## Your setup lives in a repository you own

What your team standardises on is described in a [catalog](/reference/glossary/#catalog): a git
repository like any other, holding the list of what the team shares. That repository is
yours. You host it alongside your other code, private if you want it private, and you control
who can push to it. The tool reads it at the latest version your team has
tagged and installs what it declares, and that is the full extent of the relationship.

Keeping your setup in a repository you already run, rather than uploading it to the tool's
own service, means it inherits the controls you already trust. Reviews go through the same merge requests
as any other change, and access follows the permissions your git host enforces. There is no second system holding a copy of your content, and no new place for it
to leak from. The standardised selection your team applies through that catalog is its
[rig](/reference/glossary/#rig), and the rig is versioned and rolled back like any
other repository you maintain, and argued about the same way.

## Access reuses the credentials already on each machine

A private catalog needs authentication, and the natural worry is that a new tool means a new
login to set up on every machine. It does not. When you first point the tool at your catalog
during setup, it quietly tries whatever git on that machine is already set up to use. If that
already grants access to the repository, the tool uses it and asks for nothing.

Only when that quiet attempt fails does the tool ask how to connect, offering the standard
methods a developer tends to have at hand: a `gh` or `glab` session someone is already signed
into, or an SSH key. It configures the method you pick and remembers the choice. Building on
the credentials a developer already has, rather than issuing a token of its own, was a
deliberate choice over the alternative of a bespoke login. A bespoke login would be one more secret to
store and rotate across a team, and one more thing to leak. The tool stores no secret of its
own as a result. Where a piece of your setup genuinely needs a secret value, the catalog
refers to it [by the name of an environment variable](/reference/glossary/#secret-by-environment-reference-var)
rather than by its value, so the value itself never lands in any file the tool writes.

## One checked-in file onboards the whole team

The part that matters most for a team is that no developer has to configure their machine by
hand. A [project-scoped](/reference/glossary/#scope) config file, `.agent-rigger/config.json`,
can be committed to the
team's own repository. When it is present, every machine that checks out that repository reads
the same file and resolves the same catalogs, with no per-person definition of sources. This
is delivered and works today.

The alternative is the familiar one: a setup document that each new joiner follows, getting it
slightly wrong in slightly different ways, so machines diverge before anyone notices.
Committing the configuration turns that document into a file the tool reads directly, which
means the team's sources are defined in one reviewed place instead of re-entered on every
laptop. A change to where the team pulls its setup from is a change to one checked-in file,
seen and reviewed like any other.

## What was installed, and from where, is on record

Adoption often has to satisfy a governance question as well as a practical one: can we later
account for what is on a machine and where it came from? agent-rigger records, for every
[artifact](/reference/glossary/#artifact) it installs, which catalog it came from and the
exact commit it was taken at. A version label can be re-pointed later; a commit cannot. That
record is what makes an install auditable after the fact. How the tool pins a version to an exact commit and refuses
content that is not the version it claims to be is the subject of
[versioning and provenance](/concepts/versioning-and-provenance/), which is where a governance
reviewer should go next.

## The security posture, in brief

Because the tool installs files that steer how an AI
[assistant](/reference/glossary/#assistant) behaves, and fetches them from
a repository someone can push to, it treats all fetched content as
[untrusted](/reference/glossary/#untrusted-content) by default, your own catalog included. It
[scans](/reference/glossary/#scan--scanner) everything before it lands when the scanner tools
are present on the machine; when they are missing, it warns that the content was not scanned
instead of refusing to install. Before writing anything, it shows you a
[plan](/reference/glossary/#plan-dry-run) and waits for confirmation, and it refuses content
whose commit does not match the version it was resolved to. It also names its own limits
plainly: a scanner finds leaked secrets and misconfigurations, not a script written to hide
what it does. The full model, stated together
with the boundaries it does not cross, is on the
[trust and security](/concepts/trust-and-security/) page, which anyone evaluating this for a
team should read before deciding.

## What is not delivered: a zero-config organization build

There is no way today for an organization to ship its own build of agent-rigger
with the catalog and access method already baked in, such that a new hire installs one binary
and is fully set up with no configuration at all. The tool's configuration machinery reserves
a layer for exactly such a [preset](/reference/glossary/#preset), and merges it beneath your
project and user settings, but
nothing in the command line ever fills that layer. It is a provision in the architecture, not
a working feature.

The onboarding that _is_ delivered is the checked-in project config described above, which
already gives a team a single shared definition of its sources. A team can adopt agent-rigger
today on that basis. The zero-configuration organization build is a direction the design
leaves room for, and nothing more than that yet.

## Next

- Read the [engine-and-content separation](/concepts/core-concepts/) that keeps the tool
  generic and your setup yours.
- Read [versioning and provenance](/concepts/versioning-and-provenance/) for how an install is
  made auditable.
- Read [trust and security](/concepts/trust-and-security/) for the full security model and its
  limits.
- Look up any term in the [glossary](/reference/glossary/).
