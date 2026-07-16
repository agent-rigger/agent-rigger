---
title: Declare a tool dependency
description: "The catalog entry for the tool nature: a host-system program agent-rigger checks for but never installs: its check command, the consent that gates running it, present/absent/unverified, and why the install hints are declared but not yet consumed."
---

A [tool](/reference/glossary/#tool) is the one [nature](/reference/glossary/#nature) that runs the
contract backwards. Every other nature ends with something installed on your machine: a file
written, or an install delegated to the assistant. A tool is a program agent-rigger expects to
already be there: `jq`, `gh`, `terraform`, a host-system dependency it never installs. Its entry is
a claim to verify: is the command present or not? This page is the contract for that entry: the
fields it carries, the shell `check` behind it, and the consent gate that stands between the catalog
and your shell.

It assumes you already have a catalog repository and know the edit-install-tag loop. If you do not,
build one first in [create a catalog](/authoring/create-a-catalog/); that tutorial owns the general
mechanics (git repo, `catalog.json` skeleton, cutting a version). Here you only add one tool to a
catalog that already exists.

## The catalog entry

A tool is an [artifact](/reference/glossary/#artifact) entry with `nature: "tool"`. Beyond the fields
every artifact shares, it uses three of its own: `level`, `check`, and `install`. A `jq` dependency,
recommended rather than mandatory, checked by asking the binary for its version, looks like this:

```json title="entry in catalog.json"
{
  "kind": "artifact",
  "id": "tool:jq",
  "nature": "tool",
  "targets": ["claude", "opencode"],
  "scopes": ["user"],
  "level": "recommended",
  "check": "jq --version",
  "install": {
    "brew": "jq",
    "mise": "jq"
  }
}
```

Field by field:

| Field      | Required | For a tool entry                                                                                                                                                        |
| ---------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`     | yes      | Always `"artifact"`. A tool is a single artifact, never a `pack`.                                                                                                       |
| `id`       | yes      | `tool:<name>`. The `<name>` after the prefix is a label only; a tool has no folder and no on-disk name to match.                                                        |
| `nature`   | yes      | `"tool"`.                                                                                                                                                               |
| `targets`  | yes      | The [assistants](/reference/glossary/#assistant) whose install run should check for it: `claude`, `opencode`, or both.                                                  |
| `scopes`   | yes      | `user`, `project`, or both. See [scope](/reference/glossary/#scope).                                                                                                    |
| `level`    | no       | `"required"` or `"recommended"`. An advisory importance hint; it never changes whether an install proceeds (see below). Omit it and an absent tool is reported nowhere. |
| `check`    | no       | A shell command that detects the tool. Exit `0` means present, non-zero means absent. Here, `jq --version`.                                                             |
| `install`  | no       | Package-manager hints (`brew` / `npm` / `pnpm` / `mise`). Declared today, not yet consumed (see below).                                                                 |
| `requires` | no       | Ids of entries that must install first. A tool is more often the target of another entry's `requires` than the source. See [requires](/reference/glossary/#requires).   |

A tool that both assistants should check, marked as a hard expectation and detected with a plain
lookup, is just as valid:

```json title="entry in catalog.json"
{
  "kind": "artifact",
  "id": "tool:gh",
  "nature": "tool",
  "targets": ["claude", "opencode"],
  "scopes": ["user", "project"],
  "level": "required",
  "check": "gh --version",
  "install": { "brew": "gh" }
}
```

The artifact fields for other natures (`event`, `matcher`, `timeout`, `config`, `secrets`) carry no
meaning on a tool entry. The parser accepts them if present and the tool path ignores them; do not
add them. The full field-by-field rules are in the [catalog.json schema](/reference/catalog-schema/#artifact-entries).

A tool with no `check` is accepted but does nothing: there is no file to install and no command to
run, so the entry is inert. The `check` is what makes a tool entry worth declaring.

## The check at work

A tool is [never installed by any adapter](/reference/natures-matrix/#tool--advisory-only), for any
assistant or any scope. It contributes no change line to a plan and writes nothing to disk. What it
does contribute is a presence check, and that check is a shell command an author wrote into the
catalog, so agent-rigger treats it as [untrusted content](/reference/glossary/#untrusted-content) and
guards it with two separate gates.

The first gate is the plan itself. Every selection-scoped tool's raw `check` command is printed in
the plan, under its own heading, **before** you confirm anything, so a command you are about to run
is one you can read first:

```
--- Tool presence-checks (run after you confirm) ---
  myteam/tool:jq  →  jq --version
```

The second gate is [consent](/reference/glossary/#consent) to actually run it. Confirming the plan is
not consent to execute a check command: that approval is asked per command, after confirmation, and
only for the tools in the selection. Once granted it is remembered, so a command you have approved
before is not re-asked. Accepting the plan non-interactively with `--yes` carries this consent
implicitly: the plan already listed every command, so pre-accepting it pre-accepts them.

Running a check yields one of three states, and the difference between two of them is the whole point:

- **present**: the command exited `0`. The tool is there.
- **absent**: the command exited non-zero. The tool is verifiably not there.
- **unverified**: the command never ran, because consent to run it was declined. Presence is simply
  unknown. This is **not** the same as absent: agent-rigger did not find the tool missing, it never
  looked.

Whatever the result, the check is advisory and never blocks. A missing `required` or `recommended`
tool is reported after the install completes, not before it starts; the install of everything else
proceeds regardless. An `unverified` tool is listed separately and, because its presence is unknown,
is not counted among the missing at all: declining a check hides nothing and fails nothing, it just
leaves the question open. There is no `level` and no check outcome that turns a tool into a gate.

One edge is worth knowing before you test your entry: the checks only run when the install run
actually applies something. A selection of tools alone — or a re-run where everything is already up
to date — ends with `Nothing to apply` and skips the presence checks entirely, reporting nothing.
To see your check verified, install it alongside an artifact that writes a file, or bundle it in a
pack that does.

## Installing a tool is not yet delivered

Say it plainly: agent-rigger does not install tools. The `install` hints — `brew`, `npm`, `pnpm`,
`mise` — are part of the schema and you can declare them today, but nothing consumes them. There is
no code path that runs `brew install`, and an install run that finds a `required` tool absent will
tell you so and carry on; it will not fetch it for you. The CLI help says as much, labelling the
nature `Host system tools (advisory check only).`

Declaring the hints now is still worth doing: they record, in one place your team can read, how each
dependency is meant to be obtained, and they are the input a future release will use to perform the
install itself. Until that lands, treat a `tool` entry as a documented, checkable expectation. It is
the one nature whose job is to tell you what to install by hand; it never installs anything itself.

## Other natures

This page covers the `tool` nature only, the sole nature agent-rigger checks for rather than writes.
Each of the eight natures has its own contract; the complete map, per assistant and per scope, is the
[natures matrix](/reference/natures-matrix/). The natures that do ship a payload have their own
authoring pages: [publish a skill](/authoring/skills/), [publish a guardrail](/authoring/guardrails/),
and [publish an MCP server](/authoring/mcp-servers/).
