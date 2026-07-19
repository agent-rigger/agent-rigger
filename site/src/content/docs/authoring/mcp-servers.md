---
title: Publish an MCP server
description: "The catalog entry for the mcp nature: its inline config and transport, the strict ${VAR} secret constraint, why the value never lives in the catalog, what an install delegates per assistant, and a local loop to prove it before you tag."
---

An [mcp](/reference/glossary/#mcp) entry ships a Model Context Protocol server: the catalog stores a
declaration; the assistant runs it. This page is the contract for the `mcp`
[nature](/reference/glossary/#nature): the catalog entry it needs, the one strict rule its secret
references obey, and what an install actually does with it.

It assumes you already have a catalog repository and know the edit-install-tag loop. If you do not,
build one first in [create a catalog](/authoring/create-a-catalog/); that tutorial owns the general
mechanics (git repo, `catalog.json` skeleton, cutting a version). Here you only add one mcp entry to
a catalog that already exists.

## The catalog entry

An mcp server is an [artifact](/reference/glossary/#artifact) entry with `nature: "mcp"`. Unlike a
skill, it carries no folder: the whole server declaration lives inline in the entry, under `config`.
A GitHub MCP server for Claude Code looks like this:

```json title="entry in catalog.json"
{
  "kind": "artifact",
  "id": "mcp:github",
  "nature": "mcp",
  "targets": ["claude"],
  "scopes": ["user"],
  "config": {
    "command": "docker",
    "args": [
      "run",
      "-i",
      "--rm",
      "-e",
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "ghcr.io/github/github-mcp-server"
    ],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}" }
  },
  "secrets": [
    {
      "ref": "GITHUB_PERSONAL_ACCESS_TOKEN",
      "prompt": "GitHub personal access token",
      "required": true,
      "help": "https://github.com/settings/tokens"
    }
  ]
}
```

Beyond the fields every artifact shares, an mcp entry adds `config` and `secrets`:

| Field      | Required | For an mcp entry                                                                                                   |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `kind`     | yes      | Always `"artifact"`. An mcp server is a single artifact, never a `pack`.                                           |
| `id`       | yes      | `mcp:<name>`. The `<name>` after the prefix is the server id the assistant stores it under.                        |
| `nature`   | yes      | `"mcp"`.                                                                                                           |
| `targets`  | yes      | The [assistants](/reference/glossary/#assistant) that get it: `claude`, `opencode`, or both.                       |
| `scopes`   | yes      | `user`, `project`, or both. See [scope](/reference/glossary/#scope).                                               |
| `config`   | yes¹     | The server declaration, passed through verbatim. Shape depends on the assistant — see [transport](#the-transport). |
| `secrets`  | no       | One declaration per `${VAR}` reference the config carries. See [the secret constraint](#the-secret-constraint).    |
| `requires` | no       | Ids of entries that must install first. See [requires](/reference/glossary/#requires).                             |

¹ The parser accepts an mcp entry with no `config`, but an install then has nothing to add; the
adapter, not the schema, enforces that a real server has one. The full field-by-field rules are in
the [catalog.json schema](/reference/catalog-schema/#mcp-fields).

### The transport

Because `config` is handed to the assistant untouched, its shape belongs to the assistant, not to
agent-rigger. The two assistants declare a server differently:

- **Claude Code** takes a native descriptor. The stdio form above uses `command`, `args`, and an
  `env` map. A remote server would carry a `url` and `headers` instead.
- **opencode** takes a discriminated shape under `config`. A local (spawned) server is
  `{ "type": "local", "command": [...], "environment": { ... } }`; a remote one is
  `{ "type": "remote", "url": "...", "headers": { ... } }`.

The same GitHub server, targeted at opencode as a local server, is:

```json title="entry in catalog.json"
{
  "kind": "artifact",
  "id": "mcp:github",
  "nature": "mcp",
  "targets": ["opencode"],
  "scopes": ["user"],
  "config": {
    "type": "local",
    "command": [
      "docker",
      "run",
      "-i",
      "--rm",
      "-e",
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "ghcr.io/github/github-mcp-server"
    ],
    "environment": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}" }
  },
  "secrets": [
    {
      "ref": "GITHUB_PERSONAL_ACCESS_TOKEN",
      "prompt": "GitHub personal access token",
      "required": true,
      "help": "https://github.com/settings/tokens"
    }
  ]
}
```

### The secret constraint

A server needs a token, and that token must never be committed. agent-rigger keeps the value out of
the catalog entirely: `config` carries a
[`${VAR}` reference](/reference/glossary/#secret-by-environment-reference-var), and the value is
supplied on the installing machine at install time. Three sub-objects are the ones that may hold a
secret, and every value in them must be an exact `${VAR_NAME}` reference: `env` (Claude Code's stdio
field), and `environment` and `headers` (opencode's fields). Keys outside those three (`command`,
`args`, `url`, `type`) carry no such rule.

The match is strict. A literal value, or a partial reference like `"Bearer ${TOKEN}"`, is rejected
when the catalog parses, before any install work runs. Write a literal:

```json
"env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_a_real_token" }
```

and the parse fails, naming the entry and the offending path:

```
[error] catalog.json contains invalid entries: index 0: config.env.GITHUB_PERSONAL_ACCESS_TOKEN mcp entry "mcp:github" has a non-ref value at config.env.GITHUB_PERSONAL_ACCESS_TOKEN — use a "${VAR_NAME}" reference instead of a literal value
```

Each reference the config carries gets one entry in `secrets`. A declaration names the reference and
tells the installer how to ask for it:

| Field      | Required | For a secret declaration                                                                                     |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `ref`      | yes      | The name inside `${…}` — here `GITHUB_PERSONAL_ACCESS_TOKEN`. Ties the declaration to the config.            |
| `prompt`   | yes      | The label shown when the installer asks which environment variable holds the value.                          |
| `required` | no       | When `true`, install fails closed if the secret is never resolved (see [the loop](#test-it-before-you-tag)). |
| `example`  | no       | Advisory example of the value's format. Never a real secret.                                                 |
| `help`     | no       | Advisory text or URL, for example where to generate the token.                                               |

No value ever appears anywhere in the entry: `secrets` declares reference names and advisory text
only. How a reference is mapped to a real variable at install time, and where the value does and does
not land, is [give an MCP server its secret](/guides/mcp-secrets/).

## What an install produces

The two assistants use unrelated mechanisms, and neither ever writes a secret value. For **claude**,
install [delegates](/reference/glossary/#delegate-first) to Claude Code's own CLI:
`claude mcp add-json <server> <json> -s <scope>`. The config it passes still carries a `${VAR}`
reference, but agent-rigger rewrites the name inside `${…}` first: it becomes whichever variable
`--secret-env` mapped the catalog's `ref` to, or the `ref`'s own name when no mapping was given. That
rewritten name is what Claude Code stores in its own config, on this machine, and what it expands
when it later launches the server; how the mapping itself resolves is
[give an MCP server its secret](/guides/mcp-secrets/). For **opencode**, install merges the server
under the `mcp` key of `opencode.json` at server granularity, preserving every other key and any
server already there. The exact path, config file, and mechanism per assistant and scope are the
`mcp` row of the [natures matrix](/reference/natures-matrix/#mcp).

## Test it before you tag

Prove the entry parses and installs before you cut a release. Point the tool at a throwaway home and
install your catalog folder straight from disk: `install` reads a local path directly as an
[ad-hoc source](/guides/ad-hoc-install/), no `catalog add` step needed.

A claude-target mcp entry has a second isolation concern a skill does not. Its install delegates the
write to Claude Code's own CLI, which writes into Claude Code's config, not under
[`RIGGER_HOME`](/reference/glossary/#rigger_home). Point that config at the sandbox too with
`CLAUDE_CONFIG_DIR`, or the server lands in your real `~/.claude.json`:

```sh
export RIGGER_HOME="$(mktemp -d)"
export CLAUDE_CONFIG_DIR="$RIGGER_HOME/.claude-cfg"
export NO_COLOR=1
```

`install` clones whatever is at `HEAD`, never your working tree, so commit the entry (the
`catalog.json` change) before installing, or the plan silently omits it: no error, exit `0`, the rest
of the catalog installs as if the new server were never added.

Then map the reference to a variable and install by path. In a non-interactive shell `--yes` is
required and selects every entry the source offers; a secret marked `required` has no default there,
so pass [`--secret-env`](/reference/glossary/#secret-env) too:

```sh
export MY_GH_PAT=ghp_your_token
rigger install /path/to/your-catalog --secret-env=GITHUB_PERSONAL_ACCESS_TOKEN=MY_GH_PAT --yes
```

```
--- Plan ---
Plan · 1 change · scope: user (~/.claude)

+ local-your-catalog/mcp:github


--- Result ---
  [ok] Applied 0 file(s).
```

The **Plan** previews one change; **Result** reports `Applied 0 file(s)` because agent-rigger wrote
no file of its own; Claude Code's CLI added the server, not agent-rigger's file writer. The
`local-your-catalog/` prefix is
[provenance](/guides/ad-hoc-install/#the-provenance-prefix): an ad-hoc install derives an id prefix
from the source rather than a registered catalog name.

Skip the flag and the `required` secret fails closed, before anything is written:

```
[error] missing required secret "GITHUB_PERSONAL_ACCESS_TOKEN" (GitHub personal access token) — pass --secret-env=GITHUB_PERSONAL_ACCESS_TOKEN=<VAR_NAME> or export GITHUB_PERSONAL_ACCESS_TOKEN directly
```

The mapping itself (how `--secret-env` resolves, what an interactive session asks, and where the
value goes) is [give an MCP server its secret](/guides/mcp-secrets/). Erase the sandbox when done:

```sh
rm -rf "$RIGGER_HOME"
unset RIGGER_HOME CLAUDE_CONFIG_DIR MY_GH_PAT
```

Once the entry installs clean, commit it and cut a version the way
[create a catalog](/authoring/create-a-catalog/#step-5--cut-a-version) shows. An mcp server is only
real for your team once it is a tagged release.

## Other natures

This page covers the `mcp` nature only. Each of the eight natures has its own on-disk contract; the
complete map, per assistant and per scope, is the [natures matrix](/reference/natures-matrix/). The
last one has its own page too: [declare a tool dependency](/authoring/tools/) covers `tool`'s
presence check, which works today, though its install from the package-manager hints is not yet
delivered.
