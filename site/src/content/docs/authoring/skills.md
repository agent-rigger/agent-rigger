---
title: Publish a skill
description: The catalog entry and folder layout for the skill nature, what agent-rigger actually reads from a SKILL.md, and a local loop to prove it installs before you tag.
---

A [skill](/reference/glossary/#skill) is the most common thing a catalog ships: a reusable
capability in the cross-vendor `SKILL.md` format. This page is the contract for the `skill`
[nature](/reference/glossary/#nature): the exact catalog entry it needs and the folder it lives in,
plus what an install actually does with it.

It assumes you already have a catalog repository and know the edit-install-tag loop. If you do not,
build one first in [create a catalog](/authoring/create-a-catalog/); that tutorial owns the general
mechanics (git repo, `catalog.json` skeleton, cutting a version). Here you only add one skill to a
catalog that already exists.

## The catalog entry

A skill is an [artifact](/reference/glossary/#artifact) entry with `nature: "skill"`. The example
catalog ships exactly one, `skill:hello-rigger`:

```json title="entry in catalog.json"
{
  "kind": "artifact",
  "id": "skill:hello-rigger",
  "nature": "skill",
  "targets": ["claude"],
  "scopes": ["user", "project"],
  "requires": ["tool:git"]
}
```

A skill uses only the fields every artifact shares, plus `nature`:

| Field      | Required | For a skill                                                                                              |
| ---------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `kind`     | yes      | Always `"artifact"`. A skill is a single artifact, never a `pack`.                                       |
| `id`       | yes      | `skill:<name>`. The `<name>` after the prefix is the folder name and the on-disk skill name.             |
| `nature`   | yes      | `"skill"`.                                                                                               |
| `targets`  | yes      | The [assistants](/reference/glossary/#assistant) that get it: `claude`, `opencode`, or both.             |
| `scopes`   | yes      | `user`, `project`, or both. See [scope](/reference/glossary/#scope).                                     |
| `requires` | no       | Ids of entries that must install first — here `tool:git`. See [requires](/reference/glossary/#requires). |

A skill that both assistants should get at user scope only, with no prerequisite, is just as valid:

```json title="entry in catalog.json"
{
  "kind": "artifact",
  "id": "skill:commit-style",
  "nature": "skill",
  "targets": ["claude", "opencode"],
  "scopes": ["user"]
}
```

The artifact fields for other natures (`level`, `check`, `install`, `event`, `matcher`, `timeout`,
`config`, `secrets`) carry no meaning on a skill entry. The parser accepts them if present and the
skill handler ignores them; do not add them. The full field-by-field rules are in the
[catalog.json schema](/reference/catalog-schema/).

## The folder in your catalog

The entry declares the skill; its content lives at a conventional path derived from the id. For
`skill:hello-rigger`, that is `skills/hello-rigger/SKILL.md`:

```
skills/
└── hello-rigger/
    └── SKILL.md
```

The folder name must match the `<name>` in the id: agent-rigger strips the `skill:` prefix from the
id and looks for `skills/<name>/`. The **whole** `skills/<name>/` directory is the skill: any extra
files or subfolders it contains (for example a `scripts/` directory) are copied along with it. The
[catalog layout reference](/reference/catalog-layout/) gives the path and the
[name allowlist](/reference/catalog-layout/#name-allowlist) every nature obeys.

`SKILL.md` opens with an [agentskills.io](/reference/glossary/#agentskillsio)
[frontmatter](/reference/glossary/#frontmatter) block: a `name`, a `description`, and any optional
fields the standard allows. Plain Markdown instructions follow:

```md title="skills/hello-rigger/SKILL.md"
---
name: hello-rigger
description: A demo skill distributed via the agent-rigger example catalog.
license: MIT
---

# Hello Rigger

This skill was installed from the example catalog. It exists to prove the
end-to-end flow: clone → store → symlink → manifest.
```

Note what agent-rigger does **not** do here: it does not parse or validate this frontmatter. The
`name`/`description` contract belongs to the agentskills.io standard and is read by the assistant at
runtime, not by the tool. What agent-rigger reads from a skill is narrower: it derives the skill name
from the entry id, checks that name is safe for the filesystem (the name allowlist), [scans](/concepts/trust-and-security/)
the source directory, then copies the directory verbatim. Your `SKILL.md` is opaque payload to it.
Get the frontmatter wrong and the install still succeeds. A malformed skill shows up in the
assistant, not here — validate the format against agentskills.io yourself.

## What an install produces

For both `claude` and `opencode`, a skill installs the same way: the directory is copied once into a
managed [store](/reference/glossary/#store) under `~/.config/agent-rigger/skills/<name>`, and a
[symlink](/reference/glossary/#symlink) at each target points back to it. One physical copy, shared
across every assistant and scope you targeted. The exact target path per assistant and scope is the
`skill` row of the [natures matrix](/reference/natures-matrix/#skill): the on-disk contract for all
eight natures.

## Test it before you tag

Prove the skill installs before you cut a release. Installing writes into a home directory, so point
the tool at a throwaway one and install your catalog folder straight from disk. `install` reads a
local path directly as an [ad-hoc source](/guides/ad-hoc-install/), no `catalog add` step needed.
Only the push to a remote is skipped.

`install` still fetches over git, even for a local path: it clones whatever is at `HEAD`, never your
working tree. Commit the skill you just added (the `skills/<name>/` folder and its `catalog.json`
entry) before installing, or the plan silently omits it: no error, no warning, exit `0`, the rest of
the catalog installs as if the new skill were never added.

Work against a disposable [`RIGGER_HOME`](/reference/glossary/#rigger_home) so one delete undoes
everything:

```sh
export RIGGER_HOME="$(mktemp -d)"
export NO_COLOR=1
```

Then install the catalog folder by path. In a non-interactive shell `--yes` is required and selects
every entry the source offers. Without it, the run exits `2` before touching the network:

```sh
agent-rigger install /path/to/your-catalog --yes
```

```
--- Plan ---
Plan · 1 change · scope: user (~/.claude)

+ local-your-catalog/skill:hello-rigger   ~/.claude/skills/hello-rigger
  link  ~/.claude/skills/hello-rigger → store

Σ  1 link

--- Result ---
  [ok] Applied 1 file(s).
    + /tmp/tmp.CfIr3e/.claude/skills/hello-rigger
```

The **Plan** previews the link; **Result** shows the write landing in your throwaway home, not your
real `~/.claude`. The absolute path reflects whatever `RIGGER_HOME` resolved to, so yours differs.
The `local-your-catalog/` prefix is [provenance](/guides/ad-hoc-install/#the-provenance-prefix): an
ad-hoc install derives an id prefix from the source rather than a registered catalog name. Erase the
sandbox when done:

```sh
rm -rf "$RIGGER_HOME"
unset RIGGER_HOME
```

Once the skill installs clean, commit it and cut a version the way
[create a catalog](/authoring/create-a-catalog/#step-5--cut-a-version) shows. A skill is only real
for your team once it is a tagged release.

## Other natures

This page covers the `skill` nature only. Each of the eight natures has its own on-disk contract; the
complete map, per assistant and per scope, is the [natures matrix](/reference/natures-matrix/). Two
are not covered by an authoring page yet: `mcp` and `tool`. `mcp` installs a declared MCP server; a
dedicated page is coming. `tool`'s presence check works today, but its install from the
package-manager hints is not yet delivered.
