---
title: Concepts
description: Artifacts, packs, catalog, manifest — the model behind agent-rigger.
---

agent-rigger treats the harness as a versioned package. A handful of concepts
carry the whole model.

## Artifact

A deployable unit of harness configuration. Eight natures:

| Nature      | What it is                                                         |
| ----------- | ------------------------------------------------------------------ |
| `guardrail` | Deny list written into `settings.json` (`permissions.deny`)        |
| `hook`      | Claude Code hook written into `settings.json` (`hooks`) + a script |
| `context`   | AGENTS.md context file symlinked into `~/.claude/`                 |
| `skill`     | Workflow script installed into the skill store                     |
| `agent`     | Role-specialised sub-agent definition (Markdown)                   |
| `mcp`       | MCP server declaration (reserved; not in the catalog yet)          |
| `plugin`    | Claude Code plugin installed via the plugin marketplace            |
| `tool`      | Third-party host CLI (e.g. `glab`); presence-checked               |

## Pack

A named bundle of artifacts installed as a unit — for example a `baseline` pack
that groups the guard hooks, a deny list and a context file. Installing a pack
expands to its members; dependencies are pulled in transitively.

## Catalog

The list of known artifacts and packs. **agent-rigger ships no content of its
own** — every artifact comes from a catalog you configure, fetched from a remote
content repository. No catalog configured means nothing to install.

## Manifest

`~/.config/agent-rigger/state.json` records what was installed and when. `check`
reads it to detect drift, and `remove` reads it to revert exactly what was
applied.

## Store + symlink

Skills are written to a managed store (`~/.config/agent-rigger/skills/`) and
symlinked into place. The store is the source of truth; the symlink is the
target.

## Delegate-first

agent-rigger delegates external tool installation to the host package manager
(brew, mise). It detects presence via `command -v` and reports what is missing;
it does not install tools itself.
