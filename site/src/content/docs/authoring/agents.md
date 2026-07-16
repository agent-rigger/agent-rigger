---
title: Publish a sub-agent
description: Add an agent entry to your catalog and ship a Claude Code sub-agent — the catalog entry, the definition file, and what claude (store + symlink) and opencode (translate + write, dropping frontmatter it cannot map) each write on install.
---

An [`agent`](/reference/glossary/#agent-sub-agent) entry ships a Claude Code **sub-agent**: a
specialised assistant, defined in one Markdown file, that the main assistant can hand a task to. This
page is the contract for that one [nature](/reference/glossary/#nature): the entry you write, the
file that backs it, and what each [assistant](/reference/glossary/#assistant) does with it on
install. The two diverge sharply: claude links the file untouched, opencode rewrites its frontmatter
into a different schema and drops what it cannot map.

Do not confuse `agent` with `AGENTS.md`. The `agent` nature is a sub-agent definition;
[`AGENTS.md`](/reference/glossary/#agentsmd) is a plain instructions file and belongs to the
[context](/reference/glossary/#context) nature. The names look alike; the two are unrelated.

This page assumes you already have a catalog: a git repository with a `catalog.json`, installed from
a local path while you iterate, tagged when you cut a release. If you do not, build one first in
[create a catalog](/authoring/create-a-catalog/): that tutorial owns the repository, the local
install loop, and the release tag. Here we only add the agent.

## The catalog entry

An agent is an [artifact](/reference/glossary/#artifact) entry with `nature: "agent"`. It carries no
nature-specific fields. A `hook` requires `event` and `matcher`; an `mcp` carries `config` and
`secrets`. An agent entry is just the [common fields](/reference/catalog-schema/#common-fields) plus
its nature:

```json title="entry in catalog.json"
{
  "kind": "artifact",
  "id": "agent:reviewer",
  "nature": "agent",
  "targets": ["claude", "opencode"],
  "scopes": ["user"]
}
```

Every field is load-bearing:

- `kind` is `"artifact"` — the discriminator that routes the entry to the artifact shape.
- `id` follows the `agent:<name>` convention. The `<name>` after the prefix is what the file on disk
  is named; keep it filesystem-safe (`[a-zA-Z0-9._-]`, no path segments) or the install rejects it.
- `nature` is `"agent"`, one of the eight natures the schema accepts.
- `targets` lists the assistants this agent supports — `claude`, `opencode`, or both. This choice
  decides which of the two mechanisms below runs. An entry that omits an assistant is
  [skipped](#when-targets-do-not-match) for that assistant, not translated.
- `scopes` lists where it may install — `user`, `project`, or both.

`requires` is the only other field an agent uses, and it is optional: ids of entries that must be
installed first. The full field-by-field shape, including every optional field and what the parser
rejects, is in the [catalog.json schema](/reference/catalog-schema/). The example catalog's
[`agent:demo`](/reference/glossary/#agent-sub-agent) is the minimal living case — `nature: "agent"`,
`targets: ["claude"]`, nothing more.

## The definition file

The entry `agent:reviewer` is backed by a file at the conventional path `agents/reviewer.md` — the
`<name>` from the id becomes the filename. The [catalog layout reference](/reference/catalog-layout/)
gives the path convention for every nature.

The file is a plain Claude Code sub-agent: an
[agentskills.io](/reference/glossary/#agentskillsio)-style
[frontmatter](/reference/glossary/#frontmatter) block, then Markdown instructions.

```md title="agents/reviewer.md"
---
name: reviewer
description: Reviews a diff for correctness and security regressions before commit.
model: anthropic/claude-sonnet-4-5
tools: Read, Grep, Edit, Bash
color: purple
---

You are a code reviewer. Read the diff, flag correctness and security regressions,
and suggest concrete fixes. Keep findings ranked by severity.
```

`name` and `description` are the two fields Claude Code needs; `model`, `tools`, and assorted
Claude-specific keys such as `color` are optional. Write the file for Claude Code — it is the source
format. What opencode keeps from it, and what it silently drops, is the subject of the next section.

## What install writes, per assistant

`targets` decides the mechanism. The full per-scope path table is in the
[natures matrix](/reference/natures-matrix/#agent); the two mechanisms are summarised here.

### claude — store + symlink

Claude treats the sub-agent exactly like a [skill](/reference/glossary/#skill): the source `.md` is
copied into the managed [store](/reference/glossary/#store) under `~/.config/agent-rigger/`, and a
[symlink](/reference/glossary/#symlink) at the target points back to it. The frontmatter is never
read or rewritten. The file lands byte-for-byte as you authored it.

```
--- Plan ---
Plan · 1 change · scope: user (~/.claude)

+ myteam/agent:reviewer   ~/.claude/agents/reviewer.md
  link  ~/.claude/agents/reviewer.md → store

Σ  1 link

--- Result ---
  [ok] Applied 1 file(s).
    + /tmp/rigger-sandbox.AK4SUs/.claude/agents/reviewer.md
```

The two paths differ because the run was sandboxed: the Plan shows the logical user-scope location
(`~/.claude/…`), the Result shows where the throwaway home actually redirected the write. On disk the
target is a link into the store:

```
~/.claude/agents/reviewer.md -> ~/.config/agent-rigger/agents/reviewer.md
```

### opencode — translate + write

opencode does not read Claude's frontmatter schema, so agent-rigger rewrites it. The source `.md` is
read, its frontmatter translated field by field, and the result **written as a plain file** — a
`write-text`, not a link. There is **no store** for an opencode agent, and no symlink: the target is
a regular file.

Each source field is handled on its own terms:

| Source frontmatter | opencode result                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `description`      | passed through unchanged.                                                                                                    |
| `name`             | dropped — opencode's id is the filename, not a frontmatter field.                                                            |
| `model`            | passed through; a warning fires when the value is not already in opencode's `provider/model` form.                           |
| `tools`            | translated into a `permission` allow-list: `"*": deny` first, then one `<category>: allow` per mapped tool, in source order. |
| _(none)_           | `mode: subagent` is always added — every distributed agent is a sub-agent.                                                   |
| anything else      | omitted, with a warning naming the field (for example `color`).                                                              |

Two edges of the `tools` translation are worth knowing when you author the whitelist. A tool name
with no opencode equivalent (including every `mcp__*` tool) is **not** allow-listed; it stays
denied by the `"*": deny` default, and a warning names it. And opencode has a single fused `edit`
category covering write, edit, and apply_patch: granting `edit` is broader than a Claude whitelist
that listed only one of them, so that too warns.

Installing `agent:reviewer` for opencode shows the translation in the plan preview, with both
warnings surfaced before anything is written:

```
--- Plan ---
Plan · 1 change · scope: user (~/.config/opencode)

+ myteam/agent:reviewer   ~/.config/opencode/agents/reviewer.md
  write  +14 / -0
     │ ---
     │ description: Reviews a diff for correctness and security regressions before commit.
     │ mode: subagent
     │ model: anthropic/claude-sonnet-4-5
     │ permission:
     │   "*": deny
     │ …

Σ  1 write
--- Warnings ---
  [warning] opencode has a single "edit" permission category covering write/edit/apply_patch; granting it here is broader than the source "tools" whitelist.
  [warning] Field "color" has no opencode equivalent and was omitted.


--- Result ---
  [ok] Applied 1 file(s).
    + /tmp/rigger-sandbox.AK4SUs/.config/opencode/agents/reviewer.md
```

The file written to disk is the full translated form. `name` and `color` are gone, `mode: subagent`
is added, and `tools` became a `permission` map that denies everything and re-allows the four mapped
categories:

```md title="~/.config/opencode/agents/reviewer.md"
---
description: Reviews a diff for correctness and security regressions before commit.
mode: subagent
model: anthropic/claude-sonnet-4-5
permission:
  "*": deny
  read: allow
  grep: allow
  edit: allow
  bash: allow
---

You are a code reviewer. Read the diff, flag correctness and security regressions,
and suggest concrete fixes. Keep findings ranked by severity.
```

Because it is a plain file with no store behind it, `install` does not check for
[drift](/reference/glossary/#drift) before writing it. Reinstalling always re-reads the source,
re-translates it, and writes the result whenever the translation differs from what's on disk,
whatever the reason for that difference: your local edit, or a change further up the catalog. The
previous content is backed up first, but your edit itself is not kept. Editing the written file, then
reinstalling, proves it:

```
--- Plan ---
Plan · 1 change · scope: user (~/.config/opencode)

~ myteam/agent:reviewer   ~/.config/opencode/agents/reviewer.md
  write  +14 / -0
     │ ---
     │ description: Reviews a diff for correctness and security regressions before commit.
     │ mode: subagent
     │ model: anthropic/claude-sonnet-4-5
     │ permission:
     │   "*": deny
     │ …

Σ  1 write
--- Warnings ---
  [warning] opencode has a single "edit" permission category covering write/edit/apply_patch; granting it here is broader than the source "tools" whitelist.
  [warning] Field "color" has no opencode equivalent and was omitted.


--- Result ---
  [ok] Applied 1 file(s).
    + /tmp/rigger-sandbox.9CM4Ed/.config/opencode/agents/reviewer.md
  [backup] 1 file(s) backed up.
    ~ /tmp/rigger-sandbox.9CM4Ed/.config/opencode/agents/reviewer.md.bak-2026-07-16T10-37-41.371Z-072266f7
```

The `~` on the plan line (not `+`) means the target already existed; the write happens anyway.
[`remove`](/guides/remove-artifacts/#a-target-you-edited-yourself) is the command that leaves a
drifted target alone. `install` is not.

### When targets do not match

If the entry's `targets` does not list the assistant you install for, the agent is skipped, not
translated. Installing the example catalog's `agent:demo` (which targets `claude` only) for
opencode reports the mismatch and writes nothing:

```
--- Skipped (assistant mismatch) ---
  [skipped] example/agent:demo — targets [claude], not opencode
```

To ship an agent to opencode, add `opencode` to its `targets`, as `agent:reviewer` does above.

## Test it locally

Authoring an agent is the same edit-and-install loop as any catalog change: install from a local
path, no remote round-trip. Work against a [sandbox](/reference/glossary/#sandbox) so the writes land
in a throwaway home, install your catalog by path, and inspect what each assistant produced. The
mechanics (sandbox setup, `catalog add` with a local path, the release tag) are in
[create a catalog](/authoring/create-a-catalog/); installing a single source straight from a path or
URL is in [install from a URL or local path](/guides/ad-hoc-install/).

To see both mechanisms, install once per assistant and read the files back:

```sh
agent-rigger install myteam/agent:reviewer --yes
agent-rigger install myteam/agent:reviewer --assistant opencode --yes
```

The `--yes` is not optional in a script. Both commands above already pass explicit ids; in a
[non-interactive](/reference/glossary/#tty--non-interactive) session, running `install` with ids but
without `--yes` exits `2` before fetching anything rather than hanging on a prompt:

```
[error] non-interactive session — pass --yes to confirm non-interactively
```

Drop the ids too and the failure changes: with no ids at all, the picker needs a TTY, and a
non-interactive session is rejected before `--yes` is even checked. See
[install](/reference/cli/install/#interactive-vs-non-interactive) for that exact message and the
full non-interactive contract.

## Other natures

This page covers the `agent` nature only. Each of the eight natures has its own on-disk contract; the
complete map, per assistant and per scope, is the [natures matrix](/reference/natures-matrix/).
Publishing an MCP server has [its own page](/authoring/mcp-servers/). `tool` has no authoring page:
its presence check works today, but its install from the package-manager hints is not yet
delivered.
