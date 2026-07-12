---
title: Artifact natures
description: "The eight kinds of thing agent-rigger installs (skill, agent, guardrail, context, plugin, mcp, tool, hook), told by what each one configures, and the advisory-versus-enforcement line that runs through them."
---

An assistant's behaviour is shaped by many small pieces of configuration: a capability you
hand it, an action you forbid it, a server you connect it to, a file of standing
instructions it reads. agent-rigger sorts everything it installs into eight kinds, called
[natures](/reference/glossary/#nature). Each nature configures a different part of the
assistant and is installed in its own way. This page explains what each one is for, and
the one distinction that matters most when you decide which to use. It does not lay out
where every nature writes on every assistant and scope — that per-assistant, per-scope map
belongs in the reference section rather than here.

## The line that matters most: advise or enforce

The sharpest distinction among the natures is between advice and enforcement.

A [context](/reference/glossary/#context) artifact is _advisory_. It is instructions the
assistant reads and usually follows but can override, the way a colleague reads a style
guide and mostly abides by it. Its canonical form is the `AGENTS.md` file. A
[guardrail](/reference/glossary/#guardrail) is _enforcement_. It is a rule that hard-blocks
an action through the assistant's own permission mechanism: a `permissions.deny` entry in
Claude Code's `settings.json`, or a `permission` key in opencode's config.

The difference decides where a rule belongs. "Prefer this library over that one" is advice
and goes in a context artifact, because the assistant should weigh it and may have a good
reason to depart. "Never run this destructive command" is a boundary and goes in a
guardrail, because the model can reason its way around advice, while the mechanism refuses
a deny rule outright. Putting a hard boundary in context would leave it as a
suggestion; putting a soft preference in a guardrail would block work the assistant
legitimately needs to do.

agent-rigger manages guardrails directly, by hand, rather than through a plugin. The
reason is narrow: on Claude Code a deny rule is the one thing no assistant plugin can
carry on its own. That gap is the core of what the tool has to do itself.

## Capabilities you hand the assistant: skill and agent

A [skill](/reference/glossary/#skill) is a reusable capability packaged in the cross-vendor
`SKILL.md` format. It is installed once into the managed [store](/reference/glossary/#store)
and exposed to each assistant through a [symlink](/reference/glossary/#symlink), so one copy
serves them all.

An [agent](/reference/glossary/#agent-sub-agent) is a _sub-agent_: a specialised assistant
that the main one can hand a focused task to, defined in a single Markdown file. How it is
installed depends on the assistant. On Claude Code the file is linked opaquely from the
store, the same way a skill is. On opencode there is no such shared shape, so its
frontmatter is translated into opencode's own agent schema and written out as a plain file —
neither stored nor linked.

### The `agent` and `AGENTS.md` trap

These two look alike and are unrelated. The `agent` nature is a sub-agent, a helper the
assistant can call. `AGENTS.md` is a plain instructions file, and it belongs to the
`context` nature. A rule you want the assistant to
always keep in view goes in a context artifact, which may write `AGENTS.md`. A specialised
helper the assistant can delegate to is an agent artifact. Getting this backwards installs
the wrong kind of thing.

## Things some assistants know how to install: plugin and mcp

A [plugin](/reference/glossary/#plugin) bundles hooks and commands for an assistant. An
[mcp](/reference/glossary/#mcp) artifact declares a server the assistant can reach for
extra capabilities. Where an assistant ships its own installation mechanism for these,
agent-rigger follows a rule it calls [delegate-first](/reference/glossary/#delegate-first):
rather than copy files by hand, it runs the assistant's own command. On Claude Code that
means `claude plugin install` for a plugin and `claude mcp add-json` for an mcp server.

The reason is that reinventing an installer the assistant already provides would mean
maintaining a second, poorer copy of it, one bound to drift from the real mechanism as the
assistant evolves.

Not every assistant offers such a mechanism. opencode has no install command for either
nature, so agent-rigger configures both directly: an mcp server is merged into the `mcp`
key of `opencode.json` — a pre-existing server of the same id is left untouched — and a
plugin is a catalog-provided JS/TS module placed in the store and exposed through a symlink,
the same store-and-link path a skill uses. Delegation is the rule when the assistant
provides the mechanism; direct configuration is the fallback when it does not. What no
assistant handles natively — guardrails, context, hooks — the tool always does itself.

An MCP server often needs a token to reach its service. The catalog never stores that
value. It holds an [environment reference](/reference/glossary/#secret-by-environment-reference-var)
in the exact form `${VAR_NAME}`. At install the tool checks the variable is present and
writes the assistant's own reference form, and the assistant reads the real value when it
starts the server, so nothing the tool produces ever contains the value itself. The
[trust and security](/concepts/trust-and-security/) page covers why.

## A program the harness expects to be present: tool

A [tool](/reference/glossary/#tool) is a third-party command-line program the
[harness](/reference/glossary/#harness) relies on, such as `gh`, `glab`, or `terraform`. A
harness often leans on programs it does not install itself; declaring them as tool artifacts
turns that unwritten assumption into something explicit and checkable. A tool entry lists how
to install it per package manager — `brew`, `npm`, `pnpm`, or `mise` — and a `check` command
to detect whether it is already there.

Today the `tool` nature verifies presence only. It runs the `check` command and reports
whether the program is on your `PATH`; a missing tool is reported to you, not fetched. The
reason is that installing it would mean running a package manager on your behalf, a more
invasive and less reversible act than reporting an absence, so that step is deliberately left
out for now rather than done unasked.

## Commands that fire on lifecycle events: hook

A [hook](/reference/glossary/#hook) is a command the assistant runs automatically at a
moment in its lifecycle: before a tool call, when a prompt is submitted, and so on. Each
hook fires on one lifecycle **event**, narrowed by a **matcher** that decides which actions
trigger it.

Hooks exist only where the assistant provides the mechanism. Today that means Claude Code
alone: opencode has no equivalent that agent-rigger targets, so a hook artifact applies to
Claude Code only. The full set of events a hook can bind to lives in the
[catalog schema](/reference/catalog-schema/), the canonical list that stays in step with
what the assistant supports.

## Where each nature lands

<details>
<summary>Diagram: Where each nature lands</summary>

![Where each of the eight natures lands per assistant. Claude Code: skill and agent to store plus symlink, guardrail and hook to settings.json, context to a CLAUDE.md import block plus AGENTS.md, plugin and mcp delegated to the native CLI, tool presence-checked only. opencode: skill and plugin to store plus symlink, agent written as translated frontmatter, guardrail and mcp merged into opencode.json, context to AGENTS.md, hook unsupported, tool presence-checked only.](../../../assets/diagrams/nature-targets.svg)

_The write mechanism each nature uses, per assistant — hook is Claude Code only, and tool is only checked for presence, never installed. The exhaustive per-scope paths belong in the reference. <small>Generated from packages/adapters/src/{claude,opencode}/, 2026-07-12.</small>_

</details>

## Next

- Read the [catalog schema](/reference/catalog-schema/) for the fields each nature declares.
- Understand why fetched content is treated as untrusted in
  [trust and security](/concepts/trust-and-security/).
