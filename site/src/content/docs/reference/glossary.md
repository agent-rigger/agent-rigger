---
title: Glossary
description: The shared vocabulary of agent-rigger — every product term defined for technical and non-technical readers alike.
---

This page fixes the meaning of every term the rest of the documentation uses. It is grouped by
theme rather than alphabetically, so a first-time reader can follow the model from the top; an
[alphabetical index](#alphabetical-index) at the end jumps straight to a single term.

A definition never leans on jargon it has not itself defined. Where a word has more than one common
meaning, both are stated and the one this project uses is marked.

## Product and mental model

#### harness

Everything that shapes how an AI coding assistant behaves on a repository — its skills, sub-agents,
guardrails, context files, plugins, and the external tools it expects. Left to each developer, a
team's harness drifts: no two machines end up configured the same way. agent-rigger exists to make
the harness shared, versioned, and reproducible.

#### agent-rigger

The command-line tool this documentation describes — a "harness package manager" for teams. It
shares, installs, and updates a team's harness across everyone's machine from a single source of
truth. It ships as two binaries, `agent-rigger` and the shorter `rigger`.

#### rig

A team's chosen harness — the standardised selection of artifacts a team agrees to share. In
practice a rig is expressed through a [catalog](#catalog): the packs, entries, and scopes it
declares. Running `rigger` applies that selection so every member ends up with the same harness.

#### assistant

An AI coding assistant that agent-rigger targets. Three are recognised: `claude` (Claude Code),
`opencode`, and `copilot` (reserved — no adapter yet, so selecting it fails with a clear error).
The same source artifact is translated to each one's native format by an [adapter](#adapter).

#### adapter

The module that translates one canonical artifact into the exact shape a given assistant expects —
where the file goes, what format it takes. Adding support for a new assistant means adding an
adapter, not rewriting the artifacts.

#### delegate-first

The rule that when an assistant can install an artifact through its own native mechanism,
agent-rigger delegates to it rather than copying files by hand. It only does the manual work for
what no assistant handles natively.

#### preset

A starting rig an organisation embeds so a fresh machine begins from the team's defaults instead of
an empty setup. A preset can also encode constraints — for example, that git access must go over
HTTPS rather than SSH.

## Artifacts and natures

#### artifact

The unit agent-rigger installs — one distributable piece of harness configuration. Every artifact
has exactly one [nature](#nature). Dependencies between artifacts are declared in the
[catalog](#catalog), never inside the artifact files themselves.

#### nature

The kind of an artifact. There are **eight** natures, each installed differently: [skill](#skill),
[agent](#agent-sub-agent), [guardrail](#guardrail), [context](#context), [plugin](#plugin),
[mcp](#mcp), [tool](#tool), and [hook](#hook).

#### skill

A reusable capability packaged in the cross-vendor `SKILL.md` format (see
[agentskills.io](#agentskillsio)). Installed once into the managed [store](#store) and exposed to
each assistant through a [symlink](#symlink).

#### agent (sub-agent)

A Claude Code **sub-agent** definition — a specialised assistant the main one can hand a task to,
stored as a Markdown file. Distributed like a [skill](#skill): a managed store plus a symlink.

**Do not confuse `agent` with `AGENTS.md`.** The `agent` nature is a sub-agent; `AGENTS.md` is a
plain instructions file and belongs to the [context](#context) nature. Same-looking word, unrelated
things.

#### guardrail

An _enforcement_ rule that hard-blocks an action. On Claude Code it is a `permissions.deny` entry in
`settings.json`; on opencode it is a `permission` key in `opencode.json`. Guardrails are the one
thing no assistant plugin can carry on its own, which is why the tool manages them directly.

#### context

_Advisory_ instructions or rules that guide the assistant without forcing anything. Its canonical
form is the `AGENTS.md` file (see [agents.md](#agentsmd)). Because Claude Code reads `CLAUDE.md`
rather than `AGENTS.md`, the tool wires the two together — see [AGENTS.md bridge](#agentsmd-bridge).

#### plugin

An assistant plugin bundling hooks and commands. agent-rigger installs a plugin by delegating to the
assistant's own plugin mechanism ([delegate-first](#delegate-first)).

#### mcp

A declared MCP server for an assistant — see [MCP](#mcp-model-context-protocol). The server's config
is stored as-is; any secret in it is written as an
[environment reference](#secret-by-environment-reference-var), never a literal value.

#### tool

A third-party command-line program the harness expects to be present (for example `gh`, `glab`,
`terraform`). A tool entry lists how to install it per package manager and a `check` command to detect it.
Presence checking works today; performing the install itself is not yet delivered.

#### hook

A command an assistant runs automatically at a lifecycle moment — before a tool call, when a prompt
is submitted, and so on. A hook entry names the **event** it fires on and a **matcher** for which
action triggers it. Claude Code defines nine hook events: `PreToolUse`, `PostToolUse`,
`UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`, `Notification`,
`PreCompact`.

#### AGENTS.md bridge

The managed block agent-rigger writes into `CLAUDE.md` so it imports `@AGENTS.md`. Claude Code does
not read `AGENTS.md` directly; the bridge lets one context source reach Claude, opencode, and
Copilot alike.

#### requires

The field on a catalog entry that lists other entries which must be installed first. Installing an
artifact pulls in the full chain of what it requires.

## Catalog

#### catalog

The data layer that describes which artifacts exist, what they require, and how they group into
packs. It lives in its own git repository and is the only source of artifact content — the tool
binary carries none. It is fetched remotely at a given [ref](#ref).

#### catalog.json

The single file at the root of a catalog, shaped as `{ meta, entries }`. **A note on wording:** in
the wider ecosystem "manifest" sometimes means this catalog file. In this project "manifest" means
something else (see [manifest](#manifest)) — the catalog file is always called `catalog.json`.

#### catalog entry

One record in `catalog.json`. It is either an `artifact` (a single installable thing with a nature)
or a `pack` (a bundle of other entries). Both kinds share an id, the assistants they target
(`targets`), and the scopes they support (`scopes`).

#### pack

A named catalog entry that groups several artifacts under one id, so a team installs a coherent set
in one step (for example a spec-workflow pack bundling its sub-agents and its skill).

#### meta

The header of a catalog: `{ name, required, recommended }`. `name` identifies the catalog;
`required` and `recommended` are lists of entry ids — see [required](#required) and
[recommended](#recommended).

#### effective catalog

The union of every configured catalog's entries, seen as one. Because two catalogs may reuse the
same id, entries in the effective catalog are named with a [qualified id](#qualified-id).

#### qualified id

An artifact id prefixed with its catalog name to keep it unambiguous across catalogs:
`<catalog>/<nature>:<name>` (for example `team/skill:spec-workflow`). The bare id on its own is
`<nature>:<name>` (for example `tool:glab`).

#### required

The word carries **three distinct meanings** — keep them apart.

1. `meta.required` — the catalog author's floor: entry ids the catalog puts into the install
   transaction by default.
2. `level: "required"` on an entry — an importance hint (versus `"recommended"`), used mostly for
   tools.
3. `secrets[].required` on an mcp secret — a fail-closed gate: if the secret is never resolved, the
   install stops rather than proceeding.

#### recommended

`meta.recommended` lists entry ids offered pre-selected but easy to opt out of, versus
[required](#required)'s imposed floor. As an entry `level`, `"recommended"` marks an artifact as
helpful rather than strictly needed.

## Installation and local state

#### manifest

The local record of what is installed on this machine — the file `state.json` under
`~/.config/agent-rigger/`. Each entry keeps the artifact's id, nature, [ref and sha](#ref), scope,
install time, the files it wrote, and its [applied payload](#applied-payload). It is the source of
truth for _what is installed here_. (This is the project's meaning of "manifest"; the catalog file
is `catalog.json`.)

#### applied payload

The exact, reversible record of what an install changed — the deny rules it added, the `AGENTS.md`
content it wrote, the hook it registered. `remove` replays it in reverse to undo the install offline
and precisely; `check` verifies it is still in place.

#### store

The managed local copy of an installed artifact — the one physical copy each assistant reaches
instead of duplicating it. A skill's store is a directory under
`~/.config/agent-rigger/skills/<name>/` and an agent's is a single Markdown file under
`~/.config/agent-rigger/agents/<name>.md`, each exposed through a [symlink](#symlink). Hook scripts
also live in a store — the shared directory `~/.config/agent-rigger/hooks/`, into which every hook
script is copied (not symlinked) and from which `settings.json` runs it.

#### symlink

A filesystem link that lets an assistant's own directory point at the single copy in the
[store](#store) instead of duplicating it. For a skill, `~/.claude/skills/<name>` (Claude, user
scope), `<cwd>/.claude/skills/<name>` (project scope), or `~/.config/opencode/skills/<name>`
(opencode) links back to the store. If a symlink cannot be created, a plain copy is made instead.

#### scope

Where an artifact is installed. `user` scope is machine-wide (under your home directory, e.g.
`~/.claude/`); `project` scope is limited to the current repository (e.g. `.claude/`, and
`AGENTS.md` at the repo root). Each artifact declares which scopes it supports; `install` picks one
with `--scope user` or `--scope project`.

#### plan (dry-run)

The preview of exactly what an install or removal would change before anything is written — the
files touched, rules merged, blocks added. Nothing is applied until you confirm, so you always see
the change first, in the spirit of a Terraform plan.

#### backup (.bak)

A byte copy of a file taken before the tool overwrites it, saved alongside it with a
`.bak-<timestamp>-<token>` suffix (the `.bak-*` family — never a bare `.bak`). It is the safety net
that makes a change reversible, so the tool never removes a recent one.

#### idempotence

Running the same install twice leaves the same result as running it once — re-applying an
already-present artifact changes nothing rather than duplicating it.

#### adoption

Recording an artifact that is already correctly in place into the [manifest](#manifest) so the tool
starts tracking it, without reinstalling or overwriting anything. Used by [doctor](#doctor) when it
finds a conforming artifact the manifest does not yet know about.

#### run-lock

A lock the tool holds while it writes, so two runs cannot edit the same configuration file at once.
A leftover lock from a crashed run can be inspected and, with confirmation, broken by
[doctor](#doctor).

## Trust and security

#### untrusted content

Everything a remote catalog carries — artifact files, `catalog.json`, and the `check` command
strings. It is treated as hostile by default: scanned before it touches disk, never executed before
you confirm, and any symlink inside it is rejected.

#### scan / scanner

The security check run over fetched content before it is copied into the store, delegated to
external tools (gitleaks for secrets, trivy for misconfigurations). Critical findings block the
install. The honest limit: it catches leaked secrets and misconfigurations, **not** a deliberately
obfuscated malicious script.

#### finding

A single issue reported by a scan or by [doctor](#doctor). A security finding may block an install;
a doctor finding describes something off in the local state and may or may not carry a repair.

#### fail-closed / fail-open

Two opposite postures when in doubt. _Fail-closed_ refuses — it blocks the install on a finding,
rejects a suspicious symlink. _Fail-open_ lets the action through with a warning. The default is
fail-closed on findings; the one deliberate exception is a missing scanner (see
[warn-only](#warn-only)).

#### warn-only

The degraded mode used when no scanner tool is installed on the host. Content cannot be scanned, so
rather than blocking every install the tool proceeds and warns — a deliberate fail-open, because the
scanners are optional dependencies.

#### consent

Explicit, per-item permission the tool asks for before an act that could destroy data or widen what
the assistant is allowed to do.
Two separate mechanisms carry the name. Running a catalog `check` command is memoized: granted
execution consent is recorded in a ledger (`~/.config/agent-rigger/consent.json`) keyed by the pair
of the entry id and the exact command, so an unchanged command under the same id is never re-prompted
(changing either the command or the id always re-prompts). Destructive
[doctor](#doctor) repairs (deleting a `.bak`, removing a store, breaking a lock) are the opposite:
they are confirmed per item on every run, never memoized, and never covered by a blanket `--yes`.

#### --force

The flag that overrides a blocking security finding and installs anyway. It bypasses a
[fail-closed](#fail-closed--fail-open) gate, so it is a deliberate, explicit choice.

## Versions and provenance

#### provenance

Where an installed artifact came from — the catalog's `name` plus the [ref and sha](#ref) it was
fetched at. Every installed artifact is fetched; none is built into the binary.

#### ref

The version an artifact is fetched at — a git [tag](#tag), resolved to an exact commit [sha](#sha).
The manifest stores both.

#### tag

A human-facing git version label, following [semver](#semver) (for example `v0.1.3`). A `ref` is
normally a tag.

#### sha

The exact git commit an artifact was fetched from, resolved from its [ref](#ref). It pins the
content precisely and lets the tool detect [drift](#drift) even when a tag is later moved.

#### semver

Semantic versioning — the `MAJOR.MINOR.PATCH` scheme catalog releases follow, so a version number
signals the kind of change since the last one.

#### shallow clone

Fetching only the commit needed rather than a repository's whole history, to keep catalog fetches
fast.

#### drift

A gap between what the manifest records, what is actually on disk, and what the remote holds — the
harness having quietly diverged from its declared state. `check` and [doctor](#doctor) surface it.

## Secrets and MCP

#### MCP (Model Context Protocol)

A protocol for connecting an assistant to external servers that give it extra capabilities. An
[mcp](#mcp) artifact declares such a server for an assistant.

#### secret by environment reference (${VAR})

The rule that a catalog never stores a secret value. Where a secret is needed, the config holds an
environment-variable reference in the exact form `${VAR_NAME}` — a literal value is rejected when
the catalog is parsed. The reference is resolved to the real value only at install time, on your
machine.

#### --secret-env

The install flag that tells the tool which environment variable actually holds a declared secret,
mapping the catalog's reference to a real variable on your machine — so the secret value stays out
of the catalog and out of any file the tool writes.

## Standards and formats

#### agentskills.io

The cross-vendor standard (Agentic AI Foundation / Linux Foundation) for the `SKILL.md` format: a
[frontmatter](#frontmatter) `name`, a required `description`, and optional fields. It is the native
skill format for opencode and Copilot; Claude Code keys a skill by its folder name.

#### agents.md

The cross-agent convention (Linux Foundation) for the `AGENTS.md` instructions file — free-form
Markdown, no required frontmatter. The canonical form of the [context](#context) nature.

#### frontmatter

The small metadata block at the top of a Markdown file, between `---` fences. In a `SKILL.md` it
carries the skill's `name`, `description`, and other declared fields.

## CLI and environment

#### RIGGER_HOME

An environment variable that overrides the home directory the tool uses for every user-scope path.
It takes priority over `HOME`, and is the single seam used to run the tool against an isolated
directory (for example when trying it in a sandbox).

#### TTY / non-interactive

A TTY is an interactive terminal where the tool can prompt you. _Non-interactive_ means there is
none — a CI job or a script — where the tool cannot ask questions and instead relies on flags like
`--yes`, and skips (and reports) any act that would need a confirmation it cannot obtain.

#### --yes

The flag that pre-approves the safe confirmations of a run so it can proceed without prompting, for
use in scripts and CI. It never covers a destructive act (see [consent](#consent)).

#### exit code

The numeric status a command returns so a script can react. Every command returns one of five
codes: `0` (success or a deliberate no-op), `1` (runtime or environment failure), `2` (the command
was wrong), `3` (`check` or `doctor` found something), and `130` (interrupted with Ctrl+C). See
[exit codes](/reference/exit-codes) for the authoritative contract.

#### NO_COLOR

The standard environment variable that disables coloured output. The tool colours output only on a
real terminal with `NO_COLOR` unset.

#### doctor

The diagnostic command. It reads the local state and reports what is off, grouped into six **finding
classes**: `untracked` (an artifact on disk the manifest does not track), `manifest` (a manifest
entry that no longer matches reality), `dangling` (a link whose target is gone), `phantom` (a store
directory nothing references), `lock` (a leftover [run-lock](#run-lock)), and `hygiene` (aged
temporary files or backups). With `--fix` it repairs the safe ones; anything destructive asks for
[consent](#consent) first.

## Alphabetical index

- [adapter](#adapter)
- [adoption](#adoption)
- [agent (sub-agent)](#agent-sub-agent)
- [agent-rigger](#agent-rigger)
- [agents.md](#agentsmd)
- [agentskills.io](#agentskillsio)
- [AGENTS.md bridge](#agentsmd-bridge)
- [applied payload](#applied-payload)
- [artifact](#artifact)
- [assistant](#assistant)
- [backup (.bak)](#backup-bak)
- [catalog](#catalog)
- [catalog entry](#catalog-entry)
- [catalog.json](#catalogjson)
- [consent](#consent)
- [context](#context)
- [delegate-first](#delegate-first)
- [doctor](#doctor)
- [drift](#drift)
- [effective catalog](#effective-catalog)
- [exit code](#exit-code)
- [fail-closed / fail-open](#fail-closed--fail-open)
- [finding](#finding)
- [--force](#--force)
- [frontmatter](#frontmatter)
- [guardrail](#guardrail)
- [harness](#harness)
- [hook](#hook)
- [idempotence](#idempotence)
- [manifest](#manifest)
- [MCP (Model Context Protocol)](#mcp-model-context-protocol)
- [mcp (nature)](#mcp)
- [meta](#meta)
- [nature](#nature)
- [NO_COLOR](#no_color)
- [pack](#pack)
- [plan (dry-run)](#plan-dry-run)
- [plugin](#plugin)
- [preset](#preset)
- [provenance](#provenance)
- [qualified id](#qualified-id)
- [recommended](#recommended)
- [ref](#ref)
- [required](#required)
- [requires](#requires)
- [rig](#rig)
- [RIGGER_HOME](#rigger_home)
- [run-lock](#run-lock)
- [scan / scanner](#scan--scanner)
- [scope](#scope)
- [secret by environment reference](#secret-by-environment-reference-var)
- [--secret-env](#--secret-env)
- [semver](#semver)
- [sha](#sha)
- [shallow clone](#shallow-clone)
- [skill](#skill)
- [store](#store)
- [symlink](#symlink)
- [tag](#tag)
- [tool](#tool)
- [TTY / non-interactive](#tty--non-interactive)
- [untrusted content](#untrusted-content)
- [warn-only](#warn-only)
- [--yes](#--yes)
