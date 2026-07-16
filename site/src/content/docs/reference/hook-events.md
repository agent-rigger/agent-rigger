---
title: Hook events
description: "The hook contract agent-rigger owns: the nine hook events it recognises, the event/matcher/timeout declaration, the settings.json shape it writes, and the runtime protocol boundary it does not cross."
---

A [hook](/reference/glossary/#hook) entry registers a command an assistant runs automatically at a
lifecycle moment. This page is the exact contract for the [`hook`](/concepts/artifact-natures/)
nature: the events agent-rigger recognises, how a hook is declared in a catalog, what agent-rigger
writes into the assistant's settings, and where the runtime protocol stops being agent-rigger's
concern. For the field-by-field catalog schema, see [catalog.json schema](/reference/catalog-schema/#hook-fields);
for why hooks exist as one of the artifact natures, see [artifact natures](/concepts/artifact-natures/).

## Supported events

agent-rigger recognises **nine** hook events. The `event` field of a hook entry must be exactly one
of these strings; any other value is rejected at parse time.

| Event              | Fires                                    |
| ------------------ | ---------------------------------------- |
| `PreToolUse`       | Before a tool call runs.                 |
| `PostToolUse`      | After a tool call completes.             |
| `UserPromptSubmit` | When the user submits a prompt.          |
| `Stop`             | When the main agent finishes responding. |
| `SubagentStop`     | When a sub-agent finishes responding.    |
| `SessionStart`     | At the start of a session.               |
| `SessionEnd`       | At the end of a session.                 |
| `Notification`     | When the assistant emits a notification. |
| `PreCompact`       | Before the conversation is compacted.    |

The list is closed. It is fixed in the catalog schema as `HOOK_EVENTS`; adding an event is a code
change, not a catalog change. The moment each event fires is Claude Code's behaviour, not
agent-rigger's. agent-rigger only records which event name a hook is registered under.

This nine is agent-rigger's own recognised set, not a claim that Claude Code defines no others.
If Claude Code accepts an event name outside this list — `PostCompact`, say — agent-rigger does
not recognise it: a catalog entry that declares it fails to parse, reporting the
`event` field against the closed list:

```text title="catalog.json parse error (PostCompact is outside HOOK_EVENTS)"
catalog.json contains invalid entries: index <n>: event Invalid option: expected one of "PreToolUse"|"PostToolUse"|"UserPromptSubmit"|"Stop"|"SubagentStop"|"SessionStart"|"SessionEnd"|"Notification"|"PreCompact"
```

so a hook on such an event cannot be catalogued through agent-rigger at all. Extending `HOOK_EVENTS`
to cover events outside this nine is not yet delivered.

## Platform support

The hook nature is delivered for the [`claude`](/reference/glossary/#assistant) assistant. The
registration writes Claude Code's native `settings.json` hook format, so a hook takes effect on
Claude Code. The `opencode` adapter carries no hook handler, and `copilot` is reserved across the
catalog. A hook entry's `targets` list is still validated against `claude`, `opencode`, `copilot`
by the schema, but only `claude` has a mechanism that consumes it.

## Declaring a hook

A hook is a catalog [artifact](/reference/glossary/#artifact) entry with `nature: "hook"`. Two
fields are mandatory for this nature; the schema rejects an entry that omits either, each with its
own message.

| Field     | Type    | Required | Rule                                                                                            |
| --------- | ------- | -------- | ----------------------------------------------------------------------------------------------- |
| `event`   | enum    | yes      | One of the nine [supported events](#supported-events). Absent → `hook entries require 'event'`. |
| `matcher` | string  | yes      | The action pattern the hook listens for. Absent → `hook entries require 'matcher'`.             |
| `timeout` | integer | no       | Maximum execution time in seconds. Positive integer.                                            |

`matcher` is a tool name or pattern, for example `Bash` to fire only on Bash tool calls, or `*` to
match every action. agent-rigger requires a `matcher` on every hook entry and always writes one,
including for events that carry no tool (`Stop`, `SessionStart`, `PreCompact`, …). A hook entry also
carries the [common entry fields](/reference/catalog-schema/#common-fields): `id`, `targets`,
`scopes`, and optional `requires`.

```json title="a hook entry in catalog.json"
{
  "kind": "artifact",
  "id": "hook:demo",
  "nature": "hook",
  "targets": ["claude"],
  "scopes": ["user", "project"],
  "event": "PreToolUse",
  "matcher": "Bash",
  "timeout": 5
}
```

Fields that belong to other natures (`config`, `secrets`, `install`, …) are ignored on a hook entry;
they are neither required nor rejected. Only `event` and `matcher` are enforced.

## What agent-rigger writes

Installing a hook merges one entry into the assistant's `settings.json` under the
[`hooks`](/reference/glossary/#hook) key, in Claude Code's native shape. No other key in the file is
touched.

```json title="settings.json (result of the entry above)"
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bun run ~/.config/agent-rigger/hooks/demo.ts",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

The registered `command` is derived, not authored: it is `bun run <store>/<name>.ts`, where `<name>`
is the entry id with its `hook:` prefix stripped (path-safety checked), and `<store>` is the shared
hook [store](/reference/glossary/#store), `~/.config/agent-rigger/hooks/`. At install the guard
script is copied from the catalog checkout's `hooks/` directory into that store; every hook shares
the one store directory. Hooks install from a remote catalog checkout; a hook that is not resolved
from a checkout is refused. `timeout`, when declared, is copied onto the command; when absent, the
command carries no `timeout` field at all.

The scope decides which `settings.json` is written: `user` scope targets `~/.claude/settings.json`,
`project` scope targets `<cwd>/.claude/settings.json`.

## The runtime protocol is Claude Code's

agent-rigger registers a command and deposits a script; it does not run the hook and does not define
what the hook exchanges at runtime. When the event fires, **Claude Code** — not agent-rigger — runs
the registered command. What that command reads on stdin, what it writes on stdout, its encoding,
and the exit codes it returns are Claude Code's hook protocol, defined and interpreted by Claude
Code. To agent-rigger the `command` string is opaque: it is registered, deduplicated, and removed as
a literal string, never parsed or executed by agent-rigger itself.

This is a hard boundary. The [exit codes](/reference/exit-codes/) reference documents the codes the
agent-rigger **CLI** returns from `install`, `remove`, `check`, and the rest. It does not document
the exit codes a hook script returns to Claude Code at runtime. The two are unrelated contracts.

## Registration semantics

The merge that installs a hook, and the removal that uninstalls it, obey fixed rules.

- Registering the same `(event, matcher, command)` twice is idempotent: it yields the same
  `settings.json` as registering it once. A repair install never adds a second copy of a command
  that is already present under the matcher, including when a manual reorder moved it into a later
  same-matcher entry.
- Only the command entries agent-rigger recognises (a `matcher` string plus a `hooks` array of
  `type: "command"` items) are managed. Entries authored by hand (matcher-less native entries, items
  that are not `type: "command"`, unknown fields) survive in place and in order across an install or
  a remove.
- Removing a hook deletes its command entry. If that leaves the matcher entry empty it is dropped;
  if that empties the event array the event key is dropped; and if that empties the map the `hooks`
  key itself is removed. Foreign items count as content and keep their entry alive.
- When a re-install resolves a different `event`, `matcher`, or `command` than the manifest
  recorded, the old registration is retired in the same operation that writes the new one, so the
  hook never ends up registered twice.

## Fail-closed on a malformed file

If `settings.json` was hand-edited into a shape the merge cannot safely rewrite, agent-rigger aborts
before touching the file rather than overwrite content. Two typed errors carry this, with the exact
message shown:

| Condition                                   | Message                                                                                                                                                                                               |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks.<event>` is present but not an array | `Invalid hooks shape at "hooks.<event>": expected an array of hook entries, got <shape>. Fix "hooks.<event>" in the settings file so it is a JSON array, then retry. The file has not been modified.` |
| `hooks` is present but not an object        | `Invalid hooks shape at "hooks": expected an object mapping events to arrays, got <shape>. Fix "hooks" in the settings file so it is a JSON object, then retry. The file has not been modified.`      |

Both abort the run before any write; the audit path (`check`) stays lenient and reads a malformed
`hooks` value as "not installed" rather than raising.
