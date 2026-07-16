---
title: Configuration and state files
description: "The local files agent-rigger reads and writes (config.json, state.json, consent.json) field by field, plus the environment variables it honours: RIGGER_HOME, HOME, NO_COLOR, RIGGER_SCOPE, RIGGER_AUTH_METHOD."
---

agent-rigger keeps three JSON files on the machine it runs on: `config.json` (which catalogs are
configured and how installs default), `state.json` (the [manifest](/reference/glossary/#manifest) of
what is installed), and `consent.json` (the execution-[consent](/reference/glossary/#consent)
ledger). This page is the field-by-field contract for each file (its exact path, the fields the
tool reads and writes, and their types), followed by the environment variables the tool honours. The
reasoning behind the manifest and the consent ledger lives in
[Safety and reversibility](/concepts/safety-and-reversibility/) and
[Trust and security](/concepts/trust-and-security/); this page carries the shapes only.

## Where the files live

Paths are resolved under the effective home directory (see [RIGGER_HOME](#environment-variables)).
Only `config.json` has a project-scope variant; the manifest and the consent ledger are user-scope
only.

| File           | User-scope path                       | Project-scope path                |
| -------------- | ------------------------------------- | --------------------------------- |
| `config.json`  | `~/.config/agent-rigger/config.json`  | `<cwd>/.agent-rigger/config.json` |
| `state.json`   | `~/.config/agent-rigger/state.json`   | —                                 |
| `consent.json` | `~/.config/agent-rigger/consent.json` | —                                 |

## config.json

The configuration file records the configured catalogs and the defaults a run falls back to when no
flag overrides them. It is read as **JSONC**: line comments and trailing commas are accepted. When
the tool writes it (via `rigger init` or `rigger catalog add/remove`), it prepends a header comment
and then pretty-prints the JSON:

```jsonc title="config.json"
// agent-rigger config — edit this file or run `rigger config set`
{
  "catalogs": [
    {
      "name": "example",
      "url": "https://github.com/example/catalog.git"
    }
  ]
}
```

The header comment's `rigger config set` is not a delivered command: there is no `config` verb in the
CLI today, and running `rigger config set` prints `Unknown command: "config"` and exits
[`2`](/reference/exit-codes/). Edit the file directly until that command lands.

### Fields

| Field          | Type                                     | Required | Default  | Meaning                                                                                                                                                                             |
| -------------- | ---------------------------------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultScope` | `"user"` \| `"project"`                  | no       | `"user"` | The [scope](/reference/glossary/#scope) `rigger init` persists into this file. Not read by `install`/`check`/`remove`/`update`; see [below](#how-the-effective-config-is-resolved). |
| `catalogs`     | `CatalogEntry[]`                         | no       | `[]`     | The [catalogs](/reference/glossary/#catalog) to fetch. Each source is fetched independently, qualified, and folded. See below.                                                      |
| `authMethod`   | `"provider-cli"` \| `"https"` \| `"ssh"` | no       | none     | The authentication method the fetch pre-flight uses. Written by `rigger init`.                                                                                                      |
| `assistants`   | `Assistant[]`                            | no       | none     | The target [assistants](/reference/glossary/#assistant) for install/check/remove/update. When it holds exactly one value, that value is used without prompting.                     |

Each `CatalogEntry` in `catalogs` is an object with two string fields:

| Field  | Type   | Rule                                                                                                                                                                                        |
| ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name` | string | Must be present and of type `string` (an empty string passes) or the whole entry is dropped at parse time, the same all-or-nothing gate as `url`. Used as the qualifier prefix for its ids. |
| `url`  | string | Must be present, of type `string`, and non-empty, or the whole entry is dropped at parse time, the same gate as `name`. The git URL the catalog is fetched from.                            |

`assistants` accepts only the literals `claude` and `opencode`; any other value (including the
reserved `copilot` id) is dropped from the array at parse time. Unknown top-level keys are stripped:
they neither error nor round-trip.

### How the effective config is resolved

`resolveConfig` merges several layers into the value used for a command. A defined field in a
higher-priority layer overwrites lower ones; a missing field never erases a value set below it.
Highest to lowest:

1. **flags** — command-line flags for the current run.
2. **env** — the environment variables mapped into config (see [below](#environment-variables)).
3. **project** — `<cwd>/.agent-rigger/config.json`.
4. **user** — `~/.config/agent-rigger/config.json`.
5. **defaults** — `defaultScope: "user"`, `catalogs: []`.

The resolver also accepts a `preset` layer between user and defaults, but the CLI does not populate
it (no preset file is read by any command today); it does not populate the `flags` layer either.
`loadCliConfig`, the sole production caller of the resolver, supplies only `env`, `project`, and
`user`. So for the fields this merge actually reaches at runtime (`catalogs`, `assistants`,
`authMethod`), the running priority is env > project > user > defaults.

`defaultScope` is not one of those fields: no command reads the resolved value at all. `rigger init`
is the only reader, and only of the raw on-disk file, to decide what `defaultScope` to write on the
next save. `install`, `check`, `remove`, `update`, and the interactive scope picker never consult it.
The scope a run targets comes straight from `--scope`: `project` when the flag says so, `user` in
every other case. Neither `config.json`'s `defaultScope` nor `RIGGER_SCOPE` changes that.

### Errors

| Condition                                                        | Result                                                                                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| File absent                                                      | Treated as an empty config (no error).                                                                                                           |
| Valid JSONC, root not an object (null or array)                  | Treated as an empty config.                                                                                                                      |
| Invalid JSONC                                                    | `InvalidConfigError` — `Invalid JSONC config in "<path>"`. Falls through to the generic error path; exit [`1`](/reference/exit-codes/), not `2`. |
| Top-level `catalogUrl` string present, but no valid `catalogs[]` | `LegacyConfigError` — ``Obsolete config in "<path>" — run `rigger init` to migrate to catalogs[].`` Exit `2`.                                    |

## state.json

`state.json` is the local [manifest](/reference/glossary/#manifest): the source of truth for what is
installed, where it came from, and what it wrote to disk. It is user-scope only and written as plain
JSON (two-space indent, trailing newline) with no header comment. There is no project-scope manifest.

### Top-level shape

| Field       | Type              | Rule                                                                                                                       |
| ----------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `version`   | number            | Must be exactly `1`. A different number is rejected — a schema bump requires an explicit migration, not a silent coercion. |
| `artifacts` | `ManifestEntry[]` | One entry per installed artifact. See [entry fields](#manifest-entry-fields).                                              |

Reading the manifest fails closed on a corrupt top level so a later write cannot overwrite good
state with an empty one:

| Condition                                                                                  | Result                                                                       |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| File absent                                                                                | Treated as an empty manifest `{"version":1,"artifacts":[]}` (fresh install). |
| Present, top level not an object / `version` not the number `1` / `artifacts` not an array | `MalformedManifestError`. Exit [`2`](/reference/exit-codes/).                |
| Present, syntactically broken JSON                                                         | `InvalidJsonError`. Exit `2`.                                                |

Top-level validation is strict; entry-level shape stays tolerant, so entries written by an older
version (with no `assistant` or no `applied` field) remain readable.

### Manifest entry fields

| Field         | Type                    | Required | Meaning                                                                                                                                                      |
| ------------- | ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`          | string                  | yes      | The artifact's [qualified id](/reference/glossary/#qualified-id).                                                                                            |
| `nature`      | enum                    | yes      | One of the eight [natures](/reference/glossary/#nature): `plugin`, `guardrail`, `context`, `skill`, `agent`, `mcp`, `tool`, `hook`.                          |
| `ref`         | string                  | yes      | The [ref](/reference/glossary/#ref) the artifact was fetched at — a semver tag.                                                                              |
| `sha`         | string                  | yes      | The resolved commit [sha](/reference/glossary/#sha) — pins the content and lets the tool detect [drift](/reference/glossary/#drift).                         |
| `scope`       | `"user"` \| `"project"` | yes      | The [scope](/reference/glossary/#scope) the artifact was installed under.                                                                                    |
| `installedAt` | string                  | yes      | ISO-8601 timestamp of the install.                                                                                                                           |
| `files`       | string[]                | yes      | Absolute paths of the files written or managed for this entry. Existence-drift detection reads this list.                                                    |
| `applied`     | `AppliedPayload`        | no       | Structured record of the mutations the install applied, so `remove` can replay them exactly. Absent on entries written before this field existed. See below. |
| `assistant`   | `Assistant`             | no       | The [assistant](/reference/glossary/#assistant) the entry was installed for. Absent on legacy entries → treated as `claude`.                                 |

An entry's identity is the triple `(id, scope, assistant)`: the same artifact can be installed for
both `claude` and `opencode` without one clobbering the other.

The `applied` payload is a discriminated union on its `kind` field. Each kind records exactly what a
given [nature](/reference/glossary/#nature) wrote, which is what makes a removal an exact reversal:

| `kind`                | Recorded for                                                                 |
| --------------------- | ---------------------------------------------------------------------------- |
| `guardrail`           | The deny + allow rule sets merged into a guardrail target.                   |
| `context`             | The written AGENTS.md content plus its restore baseline.                     |
| `hook`                | The registered `event`, `matcher`, `command`, and optional `timeout`.        |
| `link`                | The absolute paths written for a linked skill or agent.                      |
| `opencode-permission` | The permission fragment merged into `opencode.json`.                         |
| `opencode-mcp`        | The opencode MCP server id and its rendered config (secrets as env-refs).    |
| `claude-mcp`          | The Claude Code MCP server id, rendered config, and the scope it registered. |

A `tool`-nature entry records its presence check only: performing a tool install itself is not yet
delivered.

### Example

```json title="state.json"
{
  "version": 1,
  "artifacts": [
    {
      "id": "example/skill:hello-rigger",
      "nature": "skill",
      "ref": "v1.0.0",
      "sha": "deadbeef",
      "scope": "user",
      "installedAt": "2026-07-16T09:12:00.000Z",
      "files": ["/home/you/.config/agent-rigger/skills/hello-rigger/SKILL.md"],
      "assistant": "claude",
      "applied": {
        "kind": "link",
        "files": ["/home/you/.config/agent-rigger/skills/hello-rigger/SKILL.md"]
      }
    }
  ]
}
```

## consent.json

`consent.json` is the execution-consent ledger. A catalog `check` command runs arbitrary shell
content sourced from the catalog; confirming an install plan is not by itself consent to run those
commands. That consent is granular — per `(id, command)` pair, not per catalog — and recorded here,
so a previously-approved command is never re-prompted. A changed command, even under the same id,
always re-prompts. The full reasoning is in [Trust and security](/concepts/trust-and-security/). The
file is user-scope only, written as plain JSON.

### Top-level shape

| Field     | Type             | Meaning                                      |
| --------- | ---------------- | -------------------------------------------- |
| `version` | number           | Ledger schema version — `1`.                 |
| `entries` | `ConsentEntry[]` | One entry per approved `(id, command)` pair. |

If a read file has `version` that is not a number or `entries` that is not an array, it is treated
as an empty ledger (not an error). Syntactically broken JSON gets the identical treatment: unlike
config.json (`InvalidConfigError`) and state.json (`InvalidJsonError`), a parse failure here raises
no error and no distinct exit code; it is caught and coerced to an empty ledger, exactly like a shape
mismatch. The ledger is advisory memoization, and a malformed or unparsable one fails closed to "not
consented" (re-ask), never open on trust.

### Entry fields

| Field         | Type   | Required | Meaning                                                                                                            |
| ------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `id`          | string | yes      | The catalog entry id the command belongs to, for example `tool:glab`.                                              |
| `commandHash` | string | yes      | The sha256 hex digest of the exact command string that was approved.                                               |
| `approvedAt`  | string | yes      | ISO-8601 timestamp of the approval.                                                                                |
| `sha`         | string | no       | The catalog provenance [sha](/reference/glossary/#sha) at approval time — audit only. Never part of the match key. |

The match key is the pair `(id, commandHash)`. Changing the command (even under an unchanged catalog
sha) re-prompts; an unchanged command stays consented even if the catalog sha changes underneath it.
A `sha` present on an entry never affects whether it matches. Recording is idempotent: an already-present
`(id, commandHash)` pair is left untouched, with no duplicate and no timestamp bump.

### Example

```json title="consent.json"
{
  "version": 1,
  "entries": [
    {
      "id": "tool:glab",
      "commandHash": "3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b",
      "approvedAt": "2026-07-16T09:12:00.000Z",
      "sha": "deadbeef"
    }
  ]
}
```

## Environment variables

Five environment variables are read by the tool. Two steer where user-scope files live, one controls
colour, and two feed the config `env` layer.

| Variable             | Read for                                                                                                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RIGGER_HOME`        | Overrides the home directory used for every user-scope path. Takes priority over `HOME`; see the resolution order below. See [RIGGER_HOME](/reference/glossary/#rigger_home).                                                                                                      |
| `HOME`               | The home directory used when `RIGGER_HOME` is unset or empty.                                                                                                                                                                                                                      |
| `NO_COLOR`           | Disables ANSI colour output. See [NO_COLOR](/reference/glossary/#no_color).                                                                                                                                                                                                        |
| `RIGGER_SCOPE`       | Mapped into the config `env` layer's `defaultScope` (accepts `user` or `project`), but no command reads the resolved `defaultScope` — see [how the effective config is resolved](#how-the-effective-config-is-resolved). It has no observable effect on which scope a run targets. |
| `RIGGER_AUTH_METHOD` | Sets `authMethod` through the config `env` layer. Accepts `provider-cli`, `https`, or `ssh`.                                                                                                                                                                                       |

### Home resolution

The effective home directory for every user-scope path is resolved in this order, first non-empty
value winning:

1. `RIGGER_HOME` (a non-empty string).
2. `HOME` (a non-empty string).
3. The operating system's home directory.

`RIGGER_HOME` is the single seam used to point the tool at an isolated directory. This is exactly
what the [sandbox](/start/sandbox/) sets, so real commands never touch your real `~/`.

### Colour

Colour is emitted only when standard output is a real terminal **and** `NO_COLOR` is unset. Any
value defines the variable, so `NO_COLOR=1` and `NO_COLOR=` both disable colour. An explicit
`--color`/`--no-color` decision, when a command exposes it, takes precedence over this
auto-detection. See the [CI and scripts guide](/guides/ci-and-scripts/) for colour control in a
pipeline.

### Config env layer

`RIGGER_SCOPE` and `RIGGER_AUTH_METHOD` are mapped into the config `env` layer, above both config
files and below command-line flags. A value that is empty or not one of the accepted literals is
ignored: it never erases a value set by a config file or a lower layer.
