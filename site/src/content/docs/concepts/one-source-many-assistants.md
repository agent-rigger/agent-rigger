---
title: One source, many assistants
description: "Why a rule or skill written once reaches Claude Code and opencode both, correctly, without being written twice: a single canonical form per artifact, translated or delegated per assistant, and the AGENTS.md-to-CLAUDE.md bridge that carries context to an assistant that reads a different file."
---

You write a rule for your AI assistant once. Two assistants then keep that rule in
different places and different shapes: one wants it in a file at a certain path, another
wants it as a key inside a config file with a different name. If you wrote it out twice,
once for each, the two copies would drift the first time you edited one and forgot the
other. agent-rigger lets a single written artifact reach more than one assistant and stay
correct on each, so the same skill or rule is authored once and stays correct everywhere it
lands.

This is the reasoning behind the pieces described elsewhere: the
[three levels](/concepts/core-concepts/) it keeps apart, and the
[eight natures](/concepts/artifact-natures/) it installs. Here the question is narrower:
why the _same_ artifact lands correctly on Claude Code and on opencode from one source.

## One written form, translated on arrival

Each [artifact](/reference/glossary/#artifact) exists in a single canonical form. The piece
that knows how a given [assistant](/reference/glossary/#assistant) wants it is an
[adapter](/reference/glossary/#adapter): at install it renders the canonical form into that
assistant's native shape, deciding where the file goes and what format it takes.

A [sub-agent](/reference/glossary/#agent-sub-agent) shows the translation concretely. On
Claude Code the definition file is linked straight from the [store](/reference/glossary/#store),
untouched. opencode has no matching shape, so the same source has its frontmatter translated
into opencode's own agent schema and written out as a plain file. The `tools` list a Claude
sub-agent declares becomes an opencode `permission` allow-list that denies everything by
default and grants back only the tools that map, with a warning for any Claude-specific
field opencode has no equivalent for. The result is one authored file rendered two ways.

The alternative is to freeze a separate file per assistant in the catalog and ship both.
That was rejected because it means keeping N copies in step by hand: edit the rule for one
assistant and the copies for the others silently fall behind, which is the exact drift the
tool exists to prevent. Holding one canonical form and translating on install removes the
second copy, so there is nothing to fall behind.

Translation is not free everywhere: the [guardrail](/reference/glossary/#guardrail) nature
is the one place the tool does not translate, because opencode's permission form proved
lossy to derive from a Claude deny rule. For that nature alone the catalog carries a native
opencode descriptor next to the canonical Claude rule, each merged verbatim into its
assistant. A faithful native descriptor was judged worth more than a single source for a
security boundary that has to be exact.

## Delegate the install when the assistant already knows how

Some assistants ship their own installer for certain kinds of artifact. Claude Code
installs a [plugin](/reference/glossary/#plugin) from any git repository and adds an
[MCP server](/reference/glossary/#mcp) through its own command line. When such a mechanism
exists, agent-rigger hands the work to it rather than moving files itself: the rule it calls
[delegate-first](/reference/glossary/#delegate-first). [Artifact natures](/concepts/artifact-natures/)
covers why reimplementing that mechanism was rejected; what matters for a single source is
what crosses the boundary into it. For a plugin the tool runs `claude plugin marketplace add`
then `claude plugin install`, resolving the marketplace and plugin name from the one catalog
entry. For an MCP server it runs `claude mcp add-json` with a JSON descriptor rendered from
that same entry. Reads never spawn the assistant; only install and remove call out to it, and
any error the native command prints is re-raised verbatim.

Delegation is not universal. opencode has no install command for either nature, so the same
plugin or MCP entry is configured directly there instead: the MCP descriptor merges into the
`mcp` key of `opencode.json`, and the plugin is placed in the store and symlinked, the same
path a skill takes. Whether an adapter delegates or configures directly depends on what the
assistant offers; either way it reads from the one canonical entry, never a second copy kept
for that assistant. [Artifact natures](/concepts/artifact-natures/) covers the remainder no
assistant installs on your behalf at all: guardrails, the context file, and
[hooks](/reference/glossary/#hook), which the tool always writes itself.

## The bridge, where a single file reaches an assistant that reads another

The hardest case is a plain file of standing instructions. opencode and GitHub Copilot read
`AGENTS.md` natively from the project root. Claude Code does not: when a `CLAUDE.md` is
present it reads that and ignores `AGENTS.md`. One canonical file, and one of the three
assistants looks somewhere else for it.

The way through is not to ship an `AGENTS.md` and a separate hand-kept `CLAUDE.md`, which
would recreate the two-source drift the whole design avoids. Instead `AGENTS.md` stays
canonical, and the tool writes into `CLAUDE.md` a small managed block that imports it. The
block is fenced by markers, `<!-- BEGIN agent-rigger (managed — do not edit) -->` through
`<!-- END agent-rigger -->`, and its single job is to carry an `@`-import of `AGENTS.md`.
Writing it is idempotent: the tool locates the block by its markers and replaces it in
place, never appending a second import when an equivalent one already exists. The import
target is portable rather than absolute — the tilde form `~/.claude/harness/AGENTS.md` at
user scope, and the relative `../AGENTS.md` at project scope — so a `CLAUDE.md` committed to
a repository stays correct on another machine or a fresh clone. On opencode there is no such
block: the same `AGENTS.md` is written as-is, because opencode already reads it.

Two other shapes were considered and set aside. A proprietary context file imported
everywhere fails because opencode and Copilot do not read a non-standard name natively.
`AGENTS.md` on its own fails the other way: it never reaches Claude Code. The bridge is the
one arrangement that reaches every assistant from a single authored file, which is why the
canonical source is the standard `AGENTS.md` and the bridge is what adapts it to Claude
Code. (Copilot is recognised but has no adapter yet; selecting it fails with a clear error.)

## Why the same artifact lands correctly on both

Pull the three ideas together and the answer falls out. An artifact is authored once, in one
canonical form. For each assistant its adapter picks whichever move fits the nature: rendering
the canonical form into a native file, delegating to a native installer the assistant already
provides, or writing directly what the assistant offers no mechanism for. The core is not
blind to which assistant it is talking to: it resolves the paths each one writes to, and the
CLAUDE.md bridge described above is itself core logic, not adapter logic. What the core never
holds is a second, assistant-specific copy of an artifact's content; that rendering step stays
inside the adapter, one canonical source in and one native shape out. A skill or a rule you
wrote once therefore reaches Claude Code and opencode alike, and neither result can drift from
the other, because underneath both there is still only one source.

## Next

- See what each kind of artifact configures in the [eight natures](/concepts/artifact-natures/).
- Read how the tool keeps [what is available, installed, and on disk](/concepts/core-concepts/)
  apart, and detects drift between them.
- Look up any term in the [glossary](/reference/glossary/).
