---
title: Publish a hook
description: "Ship a hook from your catalog: the entry fields the schema enforces, the script that travels with it, what install writes into Claude Code's settings.json, and why a hook is Claude-only with a plugin as the opencode parity path."
---

A [hook](/reference/glossary/#hook) runs a script automatically at a lifecycle moment: session
start, before a tool call, when the agent stops. Publishing one from your catalog means shipping two
things together: a catalog entry that declares _when_ the hook fires, and the script that runs. This
page is the author's side of that: what you write, what install turns it into on a teammate's
machine, and the one platform rule that shapes every hook. It is delivered for Claude Code only.

This is a how-to for a single [nature](/reference/glossary/#nature). It assumes you already have a
catalog repository with a `catalog.json`; if not, [create a catalog](/authoring/create-a-catalog/)
first. That tutorial covers the repository, the sandbox, and cutting a release; this page does
not repeat them. The event contract a hook binds to (which events exist, what each fires on, the
runtime protocol) is owned by the [hook events reference](/reference/hook-events/); the field-by-field
schema is [catalog.json schema](/reference/catalog-schema/#hook-fields). Link, don't memorise.

## What a hook is made of

Two artefacts, both living in your catalog repository:

- **The entry** in `catalog.json`: declares the [event](/reference/hook-events/#supported-events),
  the `matcher`, and an optional `timeout`. This is metadata; it carries no code.
- **The script** at `hooks/<name>.ts`: the actual command. It ships in the catalog and is copied to
  the machine at install time.

Neither works without the other. The entry names a script that must exist at the conventional path;
the script does nothing until an entry registers it against an event.

## Write the entry

A hook is an [artifact](/reference/glossary/#artifact) entry with `nature: "hook"`. Two fields are
mandatory _for this nature_ on top of the [common fields](/reference/catalog-schema/#common-fields)
every entry carries: `event` and `matcher`. Here is the hook the example catalog ships, verbatim:

```json title="catalog.json — a hook entry"
{
  "kind": "artifact",
  "id": "hook:demo",
  "nature": "hook",
  "targets": ["claude"],
  "scopes": ["user", "project"],
  "event": "SessionStart",
  "matcher": "startup"
}
```

- `event` is one of the nine events agent-rigger recognises. The list is closed and lives in the
  [hook events reference](/reference/hook-events/#supported-events); an unrecognised value fails to
  parse. Omitting `event` on a hook entry is rejected with `hook entries require 'event'`.
- `matcher` is the action the hook listens for: a tool name like `Bash`, or `*` for every action.
  Events that carry no tool (`SessionStart`, `Stop`, …) still need a `matcher`; the example uses
  `startup`. Omitting it is rejected with `hook entries require 'matcher'`.
- `timeout` is optional: a positive integer, the maximum seconds the script may run. The example
  omits it; when absent, no timeout is written at all.
- `targets` is `["claude"]`. Keep it that way. See [Hooks are Claude-only](#hooks-are-claude-only).

Fields that belong to other natures (`config`, `secrets`, `install`) are ignored on a hook entry.
Only `event` and `matcher` are enforced. The full table is in the
[catalog.json schema](/reference/catalog-schema/#hook-fields).

## Ship the script

The entry above names `demo`, so its script lives at `hooks/demo.ts`: the id with its `hook:` prefix
stripped. That is the [conventional layout](/reference/catalog-layout/#hooks): every hook script sits
under a single `hooks/` directory at the repository root.

```
your-catalog/
├── catalog.json
└── hooks/
    └── demo.ts          # hook:demo
```

The example catalog's `demo.ts` is deliberately side-effect-free. It writes one line of advisory
context and touches nothing else, so it clears the install-time security scan:

```ts title="hooks/demo.ts"
#!/usr/bin/env bun
// SessionStart hook distributed via the agent-rigger example catalog.

const payload = {
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: 'Rig loaded — hello-rigger demo catalog is active.',
  },
};

process.stdout.write(JSON.stringify(payload));
```

What the script reads on stdin and writes on stdout (the shape above) is Claude Code's hook
protocol, not agent-rigger's. agent-rigger deposits the file and registers a command; it never runs
the script or interprets its output. That boundary, and the protocol itself, are in
[the runtime protocol is Claude Code's](/reference/hook-events/#the-runtime-protocol-is-claude-codes).

Two layout rules worth knowing before you split code across files: every file under `hooks/` travels
to the store together, so a helper at `hooks/_shared/lib.ts` is available to any hook that imports
it; and a name starting with `_` is never itself an entry, only a dependency of one. Both are covered
in the [catalog layout reference](/reference/catalog-layout/#hooks).

## What install writes

Installing a hook for Claude Code does two things, both visible in the plan. Merge the entry into the
assistant's `settings.json` under the `hooks` key, and copy the script into a shared store. From the
sandbox (a catalog registered locally as `example`), installing by a
[qualified id](/reference/glossary/#qualified-id):

```sh
agent-rigger install example/hook:demo --yes
```

```
--- Plan ---
Plan · 1 change · scope: user (~/.claude)

+ example/hook:demo   ~/.claude/settings.json (+ hooks)
  hook  SessionStart/startup → demo.ts
  link  ~/.config/agent-rigger/hooks

Σ  1 hook

--- Result ---
  [ok] Applied 1 file(s).
    + /tmp/rigger-sandbox.TZot50/.claude/settings.json
```

The `settings.json` it wrote registers the script by absolute path:

```json title="~/.claude/settings.json (result)"
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "bun run /tmp/rigger-sandbox.TZot50/.config/agent-rigger/hooks/demo.ts"
          }
        ]
      }
    ]
  }
}
```

The registered `command` is `bun run <store>/demo.ts`. The store is
[`~/.config/agent-rigger/hooks/`](/reference/glossary/#store), shared by every hook. The plan labels
the store line `link`, but on disk the script lands there as a **plain copy, not a symlink**. Verify
it and the store entry is an ordinary file. This differs from a skill, which is copied to the store
_and_ symlinked into the assistant's directory. A hook has no such symlink: nothing points at the
script except the absolute-path `command` string in `settings.json`.

The copy is deliberate. A hook only installs from a catalog checkout, and that checkout is a transient
fetch (it is gone once install finishes). If `settings.json` pointed at the script inside the
checkout, the command would dangle the moment the checkout was cleaned up. Copying the script into a
durable store, then pointing the command at the copy, is what lets the hook keep running after the
thing it shipped in has vanished. (One consequence: because there is no symlink to reference-count,
the store directory is garbage-collected from the manifest, not from the filesystem; an author never
manages that.)

The mechanism, per scope, and the merge/dedup/removal semantics are the reference's job:
[hook in the natures matrix](/reference/natures-matrix/#hook) for the on-disk contract,
[registration semantics](/reference/hook-events/#registration-semantics) for how a re-install or a
remove behaves.

## Hooks are Claude-only

A hook is delivered for the [`claude`](/reference/glossary/#assistant) assistant and no other. This
is the shape of the thing, not a gap to work around. A Claude Code hook can block or steer an
action at a lifecycle moment; opencode's model carries no equivalent blocking semantics, so
agent-rigger does not pretend a hook means the same thing there.

The `targets` field is how you stay on the right side of this. With `targets: ["claude"]`, a teammate
who also runs opencode installs the hook for Claude cleanly, and opencode is skipped with a plain
line (no error, exit `0`):

```
--- Skipped (assistant mismatch) ---
  [skipped] example/hook:demo — targets [claude], not opencode
```

Do **not** add `opencode` to a hook's `targets`. If you do, and opencode is an active assistant, the
install routes the hook to the opencode adapter, which refuses it hard:
`OpencodeAdapter: unsupported nature "hook"`.

**Parity pattern.** When you genuinely want opencode to get equivalent behaviour, do not stretch the
hook. Publish a separate entry with `nature: "plugin"` and `targets: ["opencode"]`: a native opencode
plugin, which installs by [store + symlink](/reference/natures-matrix/#plugin). Two entries, one per
assistant, each native to its host, is the durable way to cover both.

## Test it before you release

The author's loop is the same one from [create a catalog](/authoring/create-a-catalog/): install into
a throwaway [`RIGGER_HOME`](/reference/glossary/#rigger_home) so nothing touches your real
`~/.claude`. A hook resolves from a catalog checkout, and a local path is a valid catalog source, so
you can iterate entirely offline. Register your catalog folder, install by id, then read what landed:

```sh
export RIGGER_HOME="$(mktemp -d)"
agent-rigger catalog add mycat "$(pwd)"
agent-rigger install mycat/hook:demo --yes
cat "$RIGGER_HOME/.claude/settings.json"
```

Confirm the install landed correctly:

- The plan reported `Σ  1 hook`.
- The `command` in `settings.json` points at `~/.config/agent-rigger/hooks/<name>.ts`.
- That file exists in the store.

To install straight from a URL or path without registering a catalog first, see
[install from a URL or local path](/guides/ad-hoc-install/). In any
[non-interactive](/reference/glossary/#tty--non-interactive) session `--yes` is mandatory. A hook
install with an id but no `--yes` exits `2` before fetching anything, rather than hanging on a prompt.

Erase the sandbox when done; your catalog repository stays put:

```sh
rm -rf "$RIGGER_HOME"
unset RIGGER_HOME
```

## Other natures

This covers the `hook` nature only. There are eight natures in all, and the other seven install by
their own mechanisms. The complete map, per assistant and per scope, is in
[natures × assistants × scopes](/reference/natures-matrix/). The `opencode` hook handler is **not
delivered** and is not planned as part of this work. Publishing an `mcp` entry (which carries
secrets) has [its own page](/authoring/mcp-servers/); `tool` is advisory-only and has no authoring
flow beyond its entry fields.
