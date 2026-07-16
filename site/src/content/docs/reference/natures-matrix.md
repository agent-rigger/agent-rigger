---
title: Natures × assistants × scopes
description: "The exact map of what agent-rigger writes for each of the eight natures, per assistant (claude, opencode) and per scope (user, project): the path it touches and the mechanism it uses."
---

This page is the on-disk contract for every [nature](/reference/glossary/#nature). For each of
the eight natures it states, per [assistant](/reference/glossary/#assistant) and per
[scope](/reference/glossary/#scope), the exact path agent-rigger touches and the mechanism it uses
to put the artifact there. Every cell comes from the adapter code, and every case the code handles
appears here. The reasoning for one source feeding several assistants lives in
[one source, many assistants](/concepts/one-source-many-assistants/); what each nature _is_ lives in
[artifact natures](/concepts/artifact-natures/).

`<name>` below is the artifact's local id with its `nature:` prefix stripped (`skill:spec-workflow`
→ `spec-workflow`). `<cwd>` is the project working directory; `~` is the effective home.

## Mechanisms

| Mechanism         | What happens                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| store + symlink   | The source is copied into a managed [store](/reference/glossary/#store) under `~/.config/agent-rigger/`, then a [symlink](/reference/glossary/#symlink) at the target points back to it (a plain copy is the fallback when a symlink cannot be made). One store, many targets — the same physical copy is shared across assistants and scopes. |
| merge             | The artifact's keys are merged into an existing settings file. Every other key in that file is preserved.                                                                                                                                                                                                                                      |
| file written      | Canonical content is written verbatim to the target file.                                                                                                                                                                                                                                                                                      |
| translate + write | The source `.md` is read, its frontmatter translated to the target schema, and the result written.                                                                                                                                                                                                                                             |
| native delegation | agent-rigger never edits the file itself; it drives the assistant's own CLI to mutate its config, and re-raises the CLI's errors verbatim.                                                                                                                                                                                                     |
| advisory check    | Nothing is written. A shell command reports presence only.                                                                                                                                                                                                                                                                                     |

## Support overview

| Nature      | claude               | opencode            |
| ----------- | -------------------- | ------------------- |
| `skill`     | store + symlink      | store + symlink     |
| `agent`     | store + symlink      | translate + write   |
| `guardrail` | merge                | merge               |
| `context`   | file written + merge | file written        |
| `plugin`    | native delegation    | store + symlink     |
| `mcp`       | native delegation    | merge               |
| `hook`      | merge                | **not delivered**   |
| `tool`      | advisory check only  | advisory check only |

`copilot` is a reserved assistant with no adapter: any command targeting it fails before any handler
runs (see [copilot](#copilot--reserved)). `tool` is never installed by any adapter (see
[tool](#tool--advisory-only)). Both apply to every scope.

## skill

Copied into the shared skill store and symlinked. The store is always user-scope and shared between
both assistants. Removing one symlink never deletes the store while another target still references
it. The [security scan](/concepts/trust-and-security/) runs on the source before anything is written.

| Assistant · Scope  | Store (physical)                       | Target (symlink)                   | Mechanism       |
| ------------------ | -------------------------------------- | ---------------------------------- | --------------- |
| claude · user      | `~/.config/agent-rigger/skills/<name>` | `~/.claude/skills/<name>`          | store + symlink |
| claude · project   | `~/.config/agent-rigger/skills/<name>` | `<cwd>/.claude/skills/<name>`      | store + symlink |
| opencode · user    | `~/.config/agent-rigger/skills/<name>` | `~/.config/opencode/skills/<name>` | store + symlink |
| opencode · project | `~/.config/agent-rigger/skills/<name>` | `<cwd>/.opencode/skills/<name>`    | store + symlink |

## agent

The two assistants diverge. Claude links the sub-agent `.md` opaquely, exactly like a skill.
opencode reads a translated schema instead: the source frontmatter (`description`, `model`, `tools`
→ a `permission` allow-list, `mode: subagent`) is translated and the result written as a file (a
`write-text`, not a symlink), so there is no store for an opencode agent.

| Assistant · Scope  | Writes where                                                                               | Mechanism         |
| ------------------ | ------------------------------------------------------------------------------------------ | ----------------- |
| claude · user      | store `~/.config/agent-rigger/agents/<name>.md` → symlink `~/.claude/agents/<name>.md`     | store + symlink   |
| claude · project   | store `~/.config/agent-rigger/agents/<name>.md` → symlink `<cwd>/.claude/agents/<name>.md` | store + symlink   |
| opencode · user    | `~/.config/opencode/agents/<name>.md`                                                      | translate + write |
| opencode · project | `<cwd>/.opencode/agents/<name>.md`                                                         | translate + write |

## guardrail

Merged into the assistant's settings file. Claude receives deny rules (and optional allow rules) in
`permissions`; opencode receives a native `permission` descriptor authored in the catalog. There is
no Claude-rule translation. The opencode write is JSONC-preserving and leaf-granular: user comments
and other keys survive. A `merge-allow` on Claude always emits a plan warning, because widening
`permissions.allow` disables Claude Code's human-approval prompt for the matched commands.

| Assistant · Scope  | File · key                                                                 | Mechanism |
| ------------------ | -------------------------------------------------------------------------- | --------- |
| claude · user      | `~/.claude/settings.json` · `permissions.deny` (+ `permissions.allow`)     | merge     |
| claude · project   | `<cwd>/.claude/settings.json` · `permissions.deny` (+ `permissions.allow`) | merge     |
| opencode · user    | `~/.config/opencode/opencode.json` · `permission`                          | merge     |
| opencode · project | `<cwd>/opencode.json` · `permission`                                       | merge     |

## context

Claude writes an `AGENTS.md` and adds a managed import block (the
[AGENTS.md bridge](/reference/glossary/#agentsmd-bridge)) to `CLAUDE.md` so Claude Code reads it
automatically; the block is fenced by `<!-- BEGIN agent-rigger (managed — do not edit) -->` and
`<!-- END agent-rigger -->`. opencode reads `AGENTS.md` natively, so it needs no import block. In
project scope both assistants write the **same** `<cwd>/AGENTS.md`. This shared-file protection is
asymmetric: removing the claude side when opencode's context is still installed for the same file
leaves the shared file in place and removes only claude's CLAUDE.md import block; removing the
opencode side unconditionally deletes the shared `AGENTS.md`, even when claude's context install
still references it.

| Assistant · Scope  | AGENTS.md written to           | Import block                                               | Mechanism            |
| ------------------ | ------------------------------ | ---------------------------------------------------------- | -------------------- |
| claude · user      | `~/.claude/harness/AGENTS.md`  | `~/.claude/CLAUDE.md`, line `@~/.claude/harness/AGENTS.md` | file written + merge |
| claude · project   | `<cwd>/AGENTS.md`              | `<cwd>/.claude/CLAUDE.md`, line `@../AGENTS.md`            | file written + merge |
| opencode · user    | `~/.config/opencode/AGENTS.md` | none (opencode reads AGENTS.md natively)                   | file written         |
| opencode · project | `<cwd>/AGENTS.md`              | none (opencode reads AGENTS.md natively)                   | file written         |

## plugin

The two assistants use unrelated mechanisms. Claude delegates to its native CLI and never edits a
file: install runs `claude plugin marketplace add <marketplace>` then `claude plugin install
<plugin>`; remove runs `claude plugin uninstall <plugin>`. Presence is read from Claude's on-disk
ledger `installed_plugins.json`, never by spawning the binary. opencode has no native plugin
install, so a plugin is a JS/TS module copied into the shared store and symlinked, the same
mechanism as a skill.

| Assistant · Scope  | Writes where                                                                                           | Mechanism         |
| ------------------ | ------------------------------------------------------------------------------------------------------ | ----------------- |
| claude · user      | native CLI; ledger `<config>/plugins/installed_plugins.json` (`CLAUDE_CONFIG_DIR`, else `~/.claude`)   | native delegation |
| claude · project   | native CLI; same ledger as user scope                                                                  | native delegation |
| opencode · user    | store `~/.config/agent-rigger/plugins/<name>.<ext>` → symlink `~/.config/opencode/plugin/<name>.<ext>` | store + symlink   |
| opencode · project | store `~/.config/agent-rigger/plugins/<name>.<ext>` → symlink `<cwd>/.opencode/plugin/<name>.<ext>`    | store + symlink   |

The Claude plugin handler does not use the scope: the native CLI and the ledger live under the
config dir regardless of the requested scope. The opencode plugin store is always user-scope and
shared across scopes, like the skill store.

## mcp

Claude delegates: install runs `claude mcp add-json <server> <json> -s <scope>` and remove runs
`claude mcp remove <server> -s <scope>`; presence is read directly from Claude's config file.
opencode merges the server declaration into the `mcp` key of `opencode.json` at server granularity:
a server of the same id already present is preserved. The server `config` is passed through verbatim,
with its `${VAR}` secret references intact; no adapter ever substitutes a secret value.

| Assistant · Scope  | Writes where                                        | Presence read from               | Mechanism         |
| ------------------ | --------------------------------------------------- | -------------------------------- | ----------------- |
| claude · user      | `claude mcp add-json <server> <json> -s user`       | `~/.claude.json` · `mcpServers`  | native delegation |
| claude · project   | `claude mcp add-json <server> <json> -s project`    | `<cwd>/.mcp.json` · `mcpServers` | native delegation |
| opencode · user    | `~/.config/opencode/opencode.json` · `mcp.<server>` | same file                        | merge             |
| opencode · project | `<cwd>/opencode.json` · `mcp.<server>`              | same file                        | merge             |

## hook

Only Claude supports hooks. The hook is merged into the `hooks` key of Claude's `settings.json`;
guard scripts, when present, are synced to a store first. **opencode does not support the `hook`
nature**: routing one to the opencode adapter raises `OpencodeAdapter: unsupported nature "hook"`.

| Assistant · Scope | File · key                              | Mechanism                                                    |
| ----------------- | --------------------------------------- | ------------------------------------------------------------ |
| claude · user     | `~/.claude/settings.json` · `hooks`     | merge                                                        |
| claude · project  | `<cwd>/.claude/settings.json` · `hooks` | merge                                                        |
| opencode · any    | —                                       | not supported (`OpencodeAdapter: unsupported nature "hook"`) |

`event` must be one of Claude Code's nine hook events (`PreToolUse`, `PostToolUse`,
`UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`, `Notification`,
`PreCompact`); see [catalog.json schema](/reference/catalog-schema/#hook-fields).

## tool — advisory only

No adapter installs the `tool` nature, for any assistant or any scope. Only the
advisory presence check is delivered: the entry's `check` shell command is run, and an exit code of
`0` means present, non-zero means absent. The check never blocks an install and never writes
anything. Performing the install itself from the `install` hints (`brew` / `npm` / `pnpm` / `mise`)
is **not yet delivered**. The CLI help states it plainly: `tool | tools             Host system tools (advisory
check only).`

| Assistant · Scope | Behaviour                                           |
| ----------------- | --------------------------------------------------- |
| claude · any      | advisory `check` only — no install, nothing written |
| opencode · any    | advisory `check` only — no install, nothing written |

## copilot — reserved

`copilot` is a valid assistant id in the domain but has no adapter. On the CLI's public surface it
never reaches a nature handler, for every nature and every scope: `--assistant copilot` is rejected
by the flag parser, and a `copilot` entry in `config.assistants[]` is silently dropped at config
load. The flag rejection is what a user actually sees:

```
[error] Invalid --assistant value: "copilot". Must be "claude" or "opencode".
```

with [exit code](/reference/exit-codes/) `2`. Nothing is fetched and nothing is written. See
[choosing an assistant](/guides/choose-assistant/).
