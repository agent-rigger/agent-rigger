---
title: Give an MCP server its secret
description: Map a catalog's ${VAR} secret reference to an environment variable on your machine with --secret-env at install time, and see where the value never gets written.
---

Your catalog has an [mcp](/reference/glossary/#mcp) entry whose server needs a token, and you want
that token supplied on this machine without ever committing it. agent-rigger keeps the value out of
the catalog entirely: the entry carries a
[`${VAR}` reference](/reference/glossary/#secret-by-environment-reference-var), and you decide at
install time which environment variable resolves it. This guide covers that mapping and shows where
the value does and does not land. For a first install end to end, see
[getting started](/start/getting-started/); for the entry's full schema, see
[catalog schema](/reference/catalog-schema/#mcp-fields); for every install flag, see the
[`install` reference](/reference/cli/install/).

## Before you start

- A catalog is configured (`agent-rigger catalog ls` lists it).
- That catalog declares an mcp entry with at least one secret. The reference and example catalogs
  ship none today, so this is an entry your team's catalog defines. The rest of this guide uses a
  GitHub MCP server as the worked example.

## The catalog holds a reference, never the value

An mcp entry declares its server config inline, under `config`. Every value in the secret-bearing
sub-objects (`env` for Claude Code's stdio servers, `environment` and `headers` for opencode) must
be an exact `${VAR_NAME}` reference. A GitHub server entry looks like this:

```json
{
  "kind": "artifact",
  "id": "mcp:github",
  "nature": "mcp",
  "targets": ["claude"],
  "scopes": ["user"],
  "config": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
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

Write a literal there instead of a reference and the catalog is rejected when it parses, before any
install work begins:

```
mcp entry "mcp:github" has a non-ref value at config.env.GITHUB_PERSONAL_ACCESS_TOKEN — use a "${VAR_NAME}" reference instead of a literal value
```

The match is exact: `"Bearer ${TOKEN}"` is rejected, since the check requires a literal
`${VAR_NAME}` form. The full rule, the three checked sub-objects, and the `secrets` declaration
fields are in [catalog schema](/reference/catalog-schema/#mcp-fields).

## Map the reference to a variable at install

Each declared secret has a `ref` (the name inside `${…}`) and a `required` flag. Point a reference at
the variable that holds it with
[`--secret-env=<ref>=<VAR>`](/reference/glossary/#secret-env):

```
export MY_GH_PAT=ghp_your_token
agent-rigger install acme/mcp:github --secret-env=GITHUB_PERSONAL_ACCESS_TOKEN=MY_GH_PAT --yes
```

The flag is repeatable, once per reference, and the last value wins for a given `ref`.

Whether you can skip the flag depends on the secret and the session. In an interactive session,
install always asks which variable holds each declared secret, even one already exported under a
matching name: there is no flag-free silent path. In a non-interactive session, a secret that is not
`required` defaults to a variable of its own name, but a secret marked `required`, like the GitHub
token above, has no default. Exporting a correctly named variable does not change that: without the
flag, install still exits `2` (see "When install cannot resolve the secret", below). Pass the flag
even when `<VAR>` matches `<ref>`:

```
export GITHUB_PERSONAL_ACCESS_TOKEN=ghp_your_token
agent-rigger install acme/mcp:github --secret-env=GITHUB_PERSONAL_ACCESS_TOKEN=GITHUB_PERSONAL_ACCESS_TOKEN --yes
```

## Where the value goes, and where it never goes

`--secret-env` maps a name to a name. The secret value itself is read only from the environment
variable, and only when the MCP server is spawned. It goes nowhere else:

- Not into **the catalog**. The entry carries `${VAR}` references and the `secrets` declarations
  (`ref`, `prompt`, `required`, `example`, `help`): reference names and advisory text only, no value.
- Not into **the [manifest](/reference/glossary/#manifest)**. agent-rigger records the reference-to-
  variable mapping (names only) so a later `update` re-renders without asking you again. The value
  is not part of it.
- Not into **the files agent-rigger writes**. For Claude Code, install
  [delegates](/reference/glossary/#delegate-first) the server to `claude mcp add-json`, passing the
  config with its `${VAR}` reference verbatim. Claude Code expands the variable itself when it
  launches the server. The literal token never passes through agent-rigger's writes.

## When install cannot resolve the secret

A malformed `--secret-env` value is caught before any catalog is fetched, and install exits `2`:

```
[error] Invalid --secret-env value: "notvalid". Expected "<ref>=<VAR>" (e.g. --secret-env=GITHUB_TOKEN=MY_PAT).
```

A secret marked `required` that stays unresolved fails closed; it does not fall back to a silent
guess. On a [non-interactive session](/reference/glossary/#tty--non-interactive) with no matching
variable and no override, install exits `2` and names the fix:

```
[error] missing required secret "GITHUB_PERSONAL_ACCESS_TOKEN" (GitHub personal access token) — pass --secret-env=GITHUB_PERSONAL_ACCESS_TOKEN=<VAR_NAME> or export GITHUB_PERSONAL_ACCESS_TOKEN directly
```

The same presence check runs again just before the config is rendered, so a `required` secret whose
variable is unset at that point stops the install before anything is written:

```
[error] mcp entry "acme/mcp:github" is missing required secret "GITHUB_PERSONAL_ACCESS_TOKEN" (GitHub personal access token) — env var "GITHUB_PERSONAL_ACCESS_TOKEN" is not set. Export it (export GITHUB_PERSONAL_ACCESS_TOKEN=<value>) or re-run with --secret-env=GITHUB_PERSONAL_ACCESS_TOKEN=<OTHER_VAR>.
```

A later [`update`](/reference/cli/update/) reuses the recorded mapping and does not re-ask, but it
runs the same presence check: if the variable is gone from your environment, the re-render fails
closed the same way.
