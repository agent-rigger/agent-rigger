---
title: Catalog repository layout
description: "Where each artifact's files live in a catalog repository: the path convention per nature, the naming allowlist, and which natures carry no file at all."
---

A [catalog](/reference/glossary/#catalog) is an ordinary git repository:
[`catalog.json`](/reference/glossary/#catalogjson) at the root, plus the files that hold each
[artifact](/reference/glossary/#artifact)'s content. Each [nature](/reference/glossary/#nature) has a
fixed path convention. When agent-rigger installs an entry, it resolves the entry's id to a path
under these directories; a file in the wrong place is not found.

Two natures carry no file at all. An [mcp](/reference/glossary/#mcp) server is declared inline in
`catalog.json` through its `config` field, and a [tool](/reference/glossary/#tool) is declared inline
through its `check` and `install` fields. Neither has a directory in the repository.

## Path per nature

For an entry whose id is `<nature>:<name>` (for example `skill:diagnose`, name `diagnose`):

| Nature                                        | Path                              | Notes                                                                                                                                                                                      |
| --------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [skill](/reference/glossary/#skill)           | `skills/<name>/SKILL.md`          | The whole `skills/<name>/` directory is the skill. Everything in it, including subfolders such as `scripts/`, is copied into the [store](/reference/glossary/#store).                      |
| [agent](/reference/glossary/#agent-sub-agent) | `agents/<name>.md`                | A single Markdown file.                                                                                                                                                                    |
| [context](/reference/glossary/#context)       | `contexts/<name>/AGENTS.md`       | The [`AGENTS.md`](/reference/glossary/#agentsmd) file inside a named directory.                                                                                                            |
| [guardrail](/reference/glossary/#guardrail)   | `guardrails/<name>/`              | Holds the descriptor files below.                                                                                                                                                          |
| [hook](/reference/glossary/#hook)             | `hooks/<name>.ts`                 | A script in the shared `hooks/` directory. See [hooks](#hooks).                                                                                                                            |
| [plugin](/reference/glossary/#plugin)         | `plugins/<name>.<ext>` (opencode) | Resolved by basename: the extension is not fixed. Claude Code plugins carry no file; they are installed by delegating to `claude`, keyed through a root `.claude-plugin/marketplace.json`. |
| [mcp](/reference/glossary/#mcp)               | none                              | Inline in `catalog.json` (`config`).                                                                                                                                                       |
| [tool](/reference/glossary/#tool)             | none                              | Inline in `catalog.json` (`check`, `install`).                                                                                                                                             |

## Guardrails

A [guardrail](/reference/glossary/#guardrail) lives under `guardrails/<name>/`. Which files the
directory holds depends on the assistants the entry targets:

| File              | Assistant   | Rule                                                                                                                                                                                   |
| ----------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deny.json`       | Claude Code | Required and non-empty. The block rules. A guardrail is [fail-closed](/reference/glossary/#fail-closed--fail-open): an empty or missing deny list is an error.                         |
| `allow.json`      | Claude Code | Optional. The allow rules.                                                                                                                                                             |
| `permission.json` | opencode    | The native opencode `permission` descriptor, loaded verbatim. A native opencode guardrail requires it: missing or empty is a hard error. It is never translated from the Claude rules. |

A guardrail that targets both assistants can carry all three files in one directory. A guardrail that
targets one can carry only that assistant's files. Splitting the two into separately named entries
(for example `guardrail:claude` and `guardrail:opencode`) is also valid, since `<name>` is arbitrary.

## Hooks

Every file under `hooks/` is copied into the store as one unit, not just the single `<name>.ts` a
given [hook](/reference/glossary/#hook) entry names. This is what lets hook scripts share code: a
helper at `hooks/_shared/hook-lib.ts` is present at runtime for any hook that imports it.

The leading underscore is the convention that marks a path as shared code rather than an entry. A
`hook:<name>` entry maps to `hooks/<name>.ts`; a file or directory whose name starts with `_` is
never a hook entry, only a dependency of one.

## Name allowlist

The `<name>` derived from an entry id (the part after the `<nature>:` prefix) is used to build store
paths, target paths, and symlinks. It must match the allowlist `[a-zA-Z0-9._-]+`: letters, digits,
underscore, hyphen, and dot only. An empty name, `.`, `..`, or any name containing `/`, `\`, or
another character is rejected before any path is built. See
[trust and security](/concepts/trust-and-security/) for the threat this guards against.

## Example tree

```text
my-catalog/
├── catalog.json                      # meta + entries (mcp and tool live here, inline)
├── .claude-plugin/
│   └── marketplace.json              # names the marketplace for Claude Code plugins
├── skills/
│   └── diagnose/
│       ├── SKILL.md                  # skill:diagnose (whole folder is the skill)
│       └── scripts/                  # copied into the store with it
├── agents/
│   └── reviewer.md                   # agent:reviewer (one file)
├── contexts/
│   └── team/
│       └── AGENTS.md                 # context:team
├── guardrails/
│   ├── claude/
│   │   ├── deny.json                 # guardrail:claude (required, non-empty)
│   │   └── allow.json                # optional
│   └── opencode/
│       └── permission.json           # guardrail:opencode (native descriptor)
├── hooks/
│   ├── _shared/
│   │   └── hook-lib.ts               # shared code, not an entry (leading _)
│   └── guard-command.ts              # hook:guard-command
└── plugins/
    └── my-plugin.js                  # plugin:my-plugin (opencode, basename lookup)
```
