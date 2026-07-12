---
title: catalog.json schema
description: "Field-by-field reference for catalog.json: the root shape, the meta block, artifact and pack entries, the strict mcp secret form, and the errors a malformed catalog raises."
---

This page documents the exact shape of [`catalog.json`](/reference/glossary/#catalogjson), the
single file at the root of a [catalog](/reference/glossary/#catalog). It is the reference for every
field the parser accepts, what it validates, and what it rejects. Each rule below is enforced by the
schema at parse time; nothing here is advisory.

## Root shape

The root value is an object with two required keys, `meta` and `entries`. Unrecognised root
keys are ignored, not rejected:

```json
{
  "meta": { "name": "..." },
  "entries": []
}
```

| Key       | Type   | Rule                                                          |
| --------- | ------ | ------------------------------------------------------------- |
| `meta`    | object | Required. The catalog header. See [meta](#meta).              |
| `entries` | array  | Required. A list of catalog entries. See [entries](#entries). |

A bare array at the root is rejected: the legacy top-level-array format is no longer supported. A
root value that is not an object is rejected as well. Both raise a
[parse error](#parse-errors).

## meta

The [`meta`](/reference/glossary/#meta) block identifies the catalog and declares its default
selection.

| Field         | Type     | Required | Default | Rule                                                                                                 |
| ------------- | -------- | -------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `name`        | string   | yes      | none    | Non-empty. Identifies the catalog; used to build [qualified ids](/reference/glossary/#qualified-id). |
| `required`    | string[] | no       | `[]`    | Entry ids the catalog puts into the install transaction by default.                                  |
| `recommended` | string[] | no       | `[]`    | Entry ids offered pre-selected but easy to opt out of.                                               |

The ids in [`required`](/reference/glossary/#required) and
[`recommended`](/reference/glossary/#recommended) are arbitrary strings. No referential check is
performed: the parser does not verify that a listed id matches an entry in `entries`. An id that
points at nothing is accepted at parse time.

## entries

`entries` is an array of catalog entries. Each entry is a discriminated union on its `kind` field:
`"artifact"` routes to the [artifact](#artifact-entries) shape, `"pack"` to the
[pack](#pack-entries) shape. A missing or unrecognised `kind` is rejected.

### Common fields

Both kinds share these fields:

| Field      | Type                     | Required | Rule                                                                                                                                                                                                                                       |
| ---------- | ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kind`     | `"artifact"` \| `"pack"` | yes      | The discriminator. Selects the variant.                                                                                                                                                                                                    |
| `id`       | string                   | yes      | Non-empty. The entry's identifier, for example `tool:glab` or `pack:dev-tools`. Validated only as a non-empty string here; the path-safety allowlist is applied later, at install time (see [catalog-layout](/reference/catalog-layout/)). |
| `targets`  | string[]                 | yes      | Non-empty. The [assistants](/reference/glossary/#assistant) the entry supports. Each value is one of `claude`, `opencode`, `copilot`.                                                                                                      |
| `scopes`   | string[]                 | yes      | Non-empty. The [scopes](/reference/glossary/#scope) the entry supports. Each value is one of `user`, `project`.                                                                                                                            |
| `requires` | string[]                 | no       | Ids of other entries that must be installed first. See [requires](/reference/glossary/#requires).                                                                                                                                          |

## Artifact entries

An [artifact](/reference/glossary/#artifact) entry (`kind: "artifact"`) is one installable thing with
a concrete [nature](/reference/glossary/#nature). Beyond the [common fields](#common-fields):

| Field     | Type                            | Required    | Rule                                                                                                                         |
| --------- | ------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `nature`  | enum                            | yes         | One of the eight natures: `plugin`, `guardrail`, `context`, `skill`, `agent`, `mcp`, `tool`, `hook`.                         |
| `level`   | `"required"` \| `"recommended"` | no          | An importance hint for the installer. Most relevant for [tool](/reference/glossary/#tool) entries.                           |
| `check`   | string                          | no          | A shell command that detects whether the artifact is already present. Exit code `0` means present.                           |
| `install` | object                          | no          | Package-manager install hints. See [install](#install).                                                                      |
| `event`   | enum                            | conditional | The [hook](/reference/glossary/#hook) trigger event. Required when `nature` is `hook`. See [hook fields](#hook-fields).      |
| `matcher` | string                          | conditional | The action pattern the hook listens for. Required when `nature` is `hook`.                                                   |
| `timeout` | integer                         | no          | Maximum hook execution time in seconds. Positive integer.                                                                    |
| `config`  | object                          | no          | Raw [mcp](/reference/glossary/#mcp) server configuration. Constrained when `nature` is `mcp`. See [mcp fields](#mcp-fields). |
| `secrets` | object[]                        | no          | Secret declarations for an mcp entry. See [mcp fields](#mcp-fields).                                                         |

Fields that do not apply to a given nature are simply ignored: an artifact entry does not fail parse
because it omits `event`, and a non-hook entry that carries an `event` is not rejected for it. The
one exception is the hook requirement below.

### install

The optional `install` object lists how to install a [tool](/reference/glossary/#tool) per package
manager. Every key is optional; an entry lists only the managers the artifact supports.

| Key    | Meaning                                                  |
| ------ | -------------------------------------------------------- |
| `brew` | Homebrew formula or cask name.                           |
| `npm`  | npm package name, installed globally via `npm i -g`.     |
| `pnpm` | pnpm package name, installed globally via `pnpm add -g`. |
| `mise` | mise plugin or tool name.                                |

Presence checking through `check` works today. Performing the install itself from these hints is not
yet delivered.

### Hook fields

When `nature` is `hook`, two fields become mandatory. A hook entry that omits either is rejected,
each with its own error:

| Field     | Error when absent                |
| --------- | -------------------------------- |
| `event`   | `hook entries require 'event'`   |
| `matcher` | `hook entries require 'matcher'` |

`event` must be one of the nine Claude Code hook events: `PreToolUse`, `PostToolUse`,
`UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`, `Notification`,
`PreCompact`. `timeout`, if present, is a positive integer number of seconds.

### mcp fields

When `nature` is `mcp`, the entry carries the server configuration inline in `config` and declares
its secrets in `secrets`. No separate file exists on disk for an mcp artifact.

`config` is a free-form object passed through to the assistant, with one strict rule. Every value
under the sub-objects `environment`, `headers`, and `env` must be an exact
[environment reference](/reference/glossary/#secret-by-environment-reference-var) of the form
`${VAR_NAME}`, where `VAR_NAME` starts with a letter or underscore. Anything else at those keys is
rejected at parse time:

- A literal value, for example `"ghp_xxxx"`, is rejected.
- A partial reference, for example `"Bearer ${TOKEN}"`, is rejected: the match is exact, not
  "contains a reference".
- A non-string value at those keys is rejected.

All three sub-objects are checked: `environment` and `headers` are opencode's fields, `env` is
Claude Code's native stdio field. The rejection is a parse-time gate on the value's shape, applied
independently of any [security scan](/concepts/trust-and-security/). The error names the entry and
the offending path, for example
`mcp entry "mcp:github" has a non-ref value at config.environment.GITHUB_TOKEN — use a "${VAR_NAME}" reference instead of a literal value`.
Keys outside those three sub-objects carry no such constraint. An mcp entry with no `config` at all still parses; the
adapter, not the schema, enforces that a real install has one.

`secrets` is an array of declarations. Each declares which environment variable reference an mcp
entry needs resolved before the server config can be rendered:

| Field      | Type    | Required | Rule                                                                                                              |
| ---------- | ------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `ref`      | string  | yes      | Non-empty. The reference name used in `config`, for example `GITHUB_TOKEN` for a value written `${GITHUB_TOKEN}`. |
| `prompt`   | string  | yes      | Non-empty. The label shown when the CLI asks which environment variable holds the secret.                         |
| `required` | boolean | no       | When `true`, install fails closed if the secret is never resolved.                                                |
| `example`  | string  | no       | Advisory example of the value's format. Never a real secret.                                                      |
| `help`     | string  | no       | Advisory help text or URL, for example where to generate the token.                                               |

No secret value ever lives in the catalog. `secrets` declares references only; the real value is
supplied at install time, on the installing machine.

## Pack entries

A [pack](/reference/glossary/#pack) entry (`kind: "pack"`) groups other entries under one id. Beyond
the [common fields](#common-fields):

| Field     | Type     | Required | Rule                                             |
| --------- | -------- | -------- | ------------------------------------------------ |
| `members` | string[] | yes      | Non-empty. Ids of the entries this pack bundles. |

Pack entries are parsed in strict mode: any field that is not `kind`, `id`, `targets`, `scopes`,
`requires`, or `members` is rejected. In particular a `nature` field on a pack is an error, since a
pack has no nature.

## Parse errors

Reading a catalog raises a single error type, `CatalogParseError`, carrying a message and a list of
issues. It is raised when:

| Condition                           | Message                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `catalog.json` is absent            | `catalog.json not found in the content repo`                                     |
| The file is not valid JSON          | the underlying JSON error message                                                |
| The root is a bare array            | `catalog.json must be a wrapped object {meta,entries}, not a bare array`         |
| The root is not an object           | `catalog.json must be a wrapped object {meta,entries}`                           |
| `meta.name` is missing or empty     | `catalog.json: invalid meta block — meta.name is required and must not be empty` |
| `entries` is not an array           | `catalog.json: the entries field must be an array`                               |
| One or more entries fail validation | `catalog.json contains invalid entries: ...`                                     |

Entry-level issues are collected across all entries, each reported as `index <n>: <path> <reason>`,
so a single parse reports every invalid entry at once rather than stopping at the first.

## Examples

A complete, valid `catalog.json` with both kinds:

```json
{
  "meta": {
    "name": "agent-rigger-catalog-example",
    "required": [],
    "recommended": ["pack:demo"]
  },
  "entries": [
    {
      "kind": "artifact",
      "id": "skill:hello-rigger",
      "nature": "skill",
      "targets": ["claude"],
      "scopes": ["user", "project"],
      "requires": ["tool:git"]
    },
    {
      "kind": "artifact",
      "id": "hook:demo",
      "nature": "hook",
      "targets": ["claude"],
      "scopes": ["user", "project"],
      "event": "SessionStart",
      "matcher": "startup"
    },
    {
      "kind": "artifact",
      "id": "tool:git",
      "nature": "tool",
      "targets": ["claude"],
      "scopes": ["user", "project"],
      "level": "recommended",
      "check": "command -v git",
      "install": { "brew": "git" }
    },
    {
      "kind": "pack",
      "id": "pack:demo",
      "targets": ["claude"],
      "scopes": ["user", "project"],
      "members": ["skill:hello-rigger", "agent:demo"]
    }
  ]
}
```

A valid mcp artifact entry, with a strict environment reference and a secret declaration:

```json
{
  "kind": "artifact",
  "id": "mcp:github",
  "nature": "mcp",
  "targets": ["opencode"],
  "scopes": ["user"],
  "config": {
    "type": "local",
    "command": ["bunx", "github-mcp"],
    "environment": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
  },
  "secrets": [
    {
      "ref": "GITHUB_TOKEN",
      "prompt": "GitHub personal access token",
      "required": true,
      "example": "ghp_xxxxxxxxxxxxxxxxxxxx",
      "help": "https://github.com/settings/tokens"
    }
  ]
}
```
