---
title: Publish a guardrail
description: "Author a guardrail entry in your catalog: the deny/allow files it points at, what agent-rigger merges into each assistant's settings, what happens to a rule that already exists, and how remove reverses it."
---

A [guardrail](/reference/glossary/#guardrail) is a permission rule that hard-blocks an action:
`Read(./.env)`, a force-push, a `curl` to an unknown host. It is the one
[nature](/reference/glossary/#nature) no assistant's own plugin system can hand your team, which is
why agent-rigger writes the rules straight into each assistant's settings file instead of shipping a
plugin (see [artifact natures](/concepts/artifact-natures/)). It assumes you already have a catalog
repository; if you do not, build one first with [create a catalog](/authoring/create-a-catalog/).

## The catalog entry

A guardrail is an [artifact](/reference/glossary/#artifact) entry in `catalog.json`. It carries only
the [common fields](/reference/catalog-schema/#common-fields); there are no guardrail-specific keys
in the entry, because the rules live in files, not inline:

```json title="entry in catalog.json"
{
  "kind": "artifact",
  "id": "guardrail:no-force-push",
  "nature": "guardrail",
  "targets": ["claude"],
  "scopes": ["user", "project"]
}
```

`id` follows the `<nature>:<name>` shape; the `no-force-push` after the colon is the `<name>` that
names the directory in the next step. `targets` lists the [assistants](/reference/glossary/#assistant)
this guardrail supports, and `scopes` the [scopes](/reference/glossary/#scope) it installs at. Every
field, and every optional one a guardrail omits (`level`, `check`, `install`, `config`), is in the
[catalog schema reference](/reference/catalog-schema/#artifact-entries).

To also protect [opencode](/guides/choose-assistant/), name it in `targets`. The two assistants read
different files (below), so a guardrail that targets both carries both sets in one directory:

```json title="entry in catalog.json"
{
  "kind": "artifact",
  "id": "guardrail:baseline",
  "nature": "guardrail",
  "targets": ["claude", "opencode"],
  "scopes": ["user", "project"]
}
```

## The files in the catalog

A guardrail's rules live under `guardrails/<name>/`, where `<name>` is the id suffix. Which files the
directory holds depends on the assistants the entry targets:

```
guardrails/
└── no-force-push/
    ├── deny.json        # Claude Code — required, non-empty
    └── allow.json       # Claude Code — optional
```

`deny.json` is the block list Claude Code enforces. A guardrail is
[fail-closed](/reference/glossary/#fail-closed--fail-open): an absent or empty `deny.json` for a
claude-targeted guardrail is a hard error, never a silent no-op. A guardrail that installs but
protects nothing would be a false confidence of security.

```json title="guardrails/no-force-push/deny.json"
{
  "deny": [
    "Bash(git push --force:*)",
    "Bash(curl:*)",
    "WebFetch(domain:paste.example)"
  ]
}
```

`allow.json` is optional. It lists carve-outs that widen `permissions.allow`: an escape hatch from a
broader deny.

```json title="guardrails/no-force-push/allow.json"
{
  "allow": [
    "Bash(git push --force-with-lease:*)"
  ]
}
```

An opencode-targeted guardrail carries a third file, `permission.json`, holding opencode's **native**
`permission` descriptor, loaded verbatim. It is never translated from the Claude rules. It is
likewise required and non-empty for an opencode guardrail. The keys are opencode tools; each value is
a state (`allow`, `ask`, `deny`) or a map of patterns to states:

```json title="guardrails/env-lock/permission.json"
{
  "permission": {
    "bash": {
      "terraform destroy*": "deny",
      "git push --force*": "ask"
    },
    "webfetch": "ask"
  }
}
```

The full per-file table, and the layout for a guardrail that ships all three files at once, is in the
[catalog layout reference](/reference/catalog-layout/#guardrails). For a living entry to compare
against, the [example catalog](https://github.com/agent-rigger/agent-rigger-catalog-example) ships
`guardrail:demo`: it denies the `Read(./.env)` family and allows `Read(./.env.example)`.

## What install writes, per assistant

Both assistants receive a guardrail by **merge**: the rules are folded into an existing settings
file, and every other key in that file is preserved. Only the target file and key differ. The exact
path-and-mechanism table for each scope is in [the natures matrix](/reference/natures-matrix/#guardrail);
what an author needs to see is the result on disk.

On **Claude Code**, the rules land in `permissions.deny` (and `permissions.allow`) of
`settings.json`. A `merge-allow` always prints a plan warning, because widening `permissions.allow`
disables Claude Code's human-approval prompt for the matched commands:

```
--- Plan ---
Plan · 2 changes · scope: user (~/.claude)

+ cltest/guardrail:no-force-push   ~/.claude/settings.json
  deny  (+3)
     + Bash(git push --force:*)
     + Bash(curl:*)
     + WebFetch(domain:paste.example)
  allow  (+1)
     + Bash(git push --force-with-lease:*)

Σ  deny +3 · allow +1
--- Warnings ---
  [warning] this remote guardrail widens permissions.allow: Bash(git push --force-with-lease:*)


--- Result ---
  [ok] Applied 2 file(s).
```

The resulting `~/.claude/settings.json`:

```json
{
  "permissions": {
    "deny": [
      "Bash(git push --force:*)",
      "Bash(curl:*)",
      "WebFetch(domain:paste.example)"
    ],
    "allow": [
      "Bash(git push --force-with-lease:*)"
    ]
  }
}
```

On **opencode**, the `permission.json` descriptor is merged into the `permission` key of
`opencode.json`, at leaf granularity: user comments and every other key (`$schema`, `mcp`, `agent`)
survive.

```
--- Plan ---
Plan · 1 change · scope: user (~/.config/opencode)

+ octest/guardrail:env-lock


--- Result ---
  [ok] Applied 1 file(s).
```

```json title="~/.config/opencode/opencode.json"
{
  "permission": {
    "bash": {
      "terraform destroy*": "deny",
      "git push --force*": "ask"
    },
    "webfetch": "ask"
  }
}
```

## What happens to a rule that already exists

The merge is additive and never overwrites. On Claude Code your rules are appended to the existing
`permissions.deny`; a rule already present is not added twice. Installing `no-force-push` into a
`settings.json` that already denies `Bash(sudo:*)` and `Bash(curl:*)` adds only the two new rules:
`Bash(curl:*)` is deduplicated, and the user's own `Bash(sudo:*)` is untouched.

```
+ cltest/guardrail:no-force-push   ~/.claude/settings.json
  deny  (+2)
     + Bash(git push --force:*)
     + WebFetch(domain:paste.example)
  allow  (+1)
     + Bash(git push --force-with-lease:*)

Σ  deny +2 · allow +1
```

Because the merge is idempotent, re-installing a guardrail that is fully present is a no-op:

```
--- Plan ---
Nothing to apply — already up to date.

--- Result ---
  [ok] Already up to date — nothing to install.
```

On opencode the merge is leaf by leaf. A leaf your descriptor wants but the user's `opencode.json`
already claims with a **different** value is not overwritten: agent-rigger drops that leaf and the
plan carries a warning naming the rule and the conflicting user value. It also warns when a guardrail
glob overlaps a differently-spelled user pattern that opencode's last-match precedence would let your
rule win. In every case existing configuration is preserved and the conflict is surfaced, not
resolved for you.

## Removing reverses exactly what was installed

At install time agent-rigger records the guardrail's full canonical rule set in the
[applied payload](/reference/glossary/#applied-payload): for Claude the deny and allow rules it
added, for opencode the whole `permission` fragment. `remove` replays that payload in reverse: it
strips exactly the recorded rules and leaves every user rule in place. The Claude removal, and the
`settings.json` it leaves behind:

```
--- Removal Plan ---
Removal plan · 2 changes · scope: user (~/.claude)

- cltest/guardrail:no-force-push   ~/.claude/settings.json
  deny  (-3)
     - Bash(git push --force:*)
     - Bash(curl:*)
     - WebFetch(domain:paste.example)
  allow  (-1)
     - Bash(git push --force-with-lease:*)

Σ  deny -3 · allow -1

--- Result ---
  [ok] Removed 1 entry(s).
    - cltest/guardrail:no-force-push
  [backup] 1 file(s) backed up.
```

```json title="~/.claude/settings.json after remove"
{
  "permissions": {
    "deny": [],
    "allow": []
  }
}
```

A backup (`.bak`) is written before the file changes. On Claude Code, `remove` matches rules by exact
string against what was recorded: a rule hand-edited on disk since install no longer matches, so it
is left in place with no warning. Opencode's removal is decided leaf by leaf and is robust to
hand-edits: a rule changed on disk since install no longer matches what was recorded, so `remove`
leaves it in place and warns rather than deleting an edited rule. The recorded `permission` fragment
is stripped from `opencode.json`, which is left with an empty `permission` object.

## Test it locally before you release

You do not need to push anything to iterate. Point the tool at a throwaway
[`RIGGER_HOME`](/reference/glossary/#rigger_home) so installs write only under a disposable
directory, then install your guardrail straight from its local catalog folder, the same loop as
[create a catalog](/authoring/create-a-catalog/):

```sh
export RIGGER_HOME="$(mktemp -d)"
export NO_COLOR=1
```

Register the local catalog by path and install the guardrail by its
[qualified id](/reference/glossary/#qualified-id), accepting the plan with `--yes`:

```sh
rigger catalog add cltest /path/to/your-catalog
rigger install cltest/guardrail:no-force-push --yes
```

Confirm it is enforced:

```sh
rigger check
```

```
  [ ok  ]  guardrails-claude  (guardrail)

--- Catalogs ---
  [up-to-date]   cltest  (v0.1.0)
```

To exercise an opencode guardrail, drive the install for that assistant with `--assistant opencode`;
its check reports under `guardrails-opencode`. In any non-interactive session (CI, the sandbox loop
above), always name the id and pass `--yes`: a bare `rigger install` with no id and no TTY has
nothing to select and cannot proceed (see [CI and scripts](/guides/ci-and-scripts/)).

Erase the sandbox when done; your catalog repository stays put:

```sh
rm -rf "$RIGGER_HOME"
unset RIGGER_HOME
```

## Other natures

The guardrail is one of eight natures. The full set, and the on-disk mechanism each uses per
assistant and per scope, is in [the natures matrix](/reference/natures-matrix/). Two of those
natures carry their rules differently from a guardrail and have their own contracts: `mcp` declares
its server `config` and `secrets` inline in `catalog.json` (see
[publish an MCP server](/authoring/mcp-servers/)), and `tool` is an advisory presence check
only (see [declare a tool dependency](/authoring/tools/); installing it is not yet delivered). See the
[catalog schema reference](/reference/catalog-schema/) for those fields.
