---
title: Target Claude Code or opencode
description: Pin the assistant a command acts on with --assistant, persist that choice, and know what changes when you install for opencode instead of Claude Code.
---

You run more than one assistant, or you want to be certain a command acts on the one you mean. This
guide shows how to pin the [assistant](/reference/glossary/#assistant) a command targets, persist the
choice so you stop repeating the flag, and what changes concretely when you install for opencode
instead of Claude Code. [Getting started](/start/getting-started/) walks through a first run end to
end. For the full resolution order and the flag table, see the
[CLI overview](/reference/cli/overview/#assistant-resolution); for why the same source artifact
takes a different shape on each assistant, see [artifact natures](/concepts/artifact-natures/).

## Pin the assistant for one command

Pass `--assistant` on any command that writes or audits (`install`, `check`, `remove`, `update`):

```
agent-rigger install jr/skill:tdd-coach --assistant opencode --yes
```

The flag accepts only `claude` or `opencode`, and it wins over everything else: a script that
names it never depends on what happens to be installed on the machine. A value that is neither is a
hard error before any work runs:

```
[error] Invalid --assistant value: "foobar". Must be "claude" or "opencode".
```

## Let rigger resolve it

Without the flag, rigger picks exactly one assistant per run. In short: a single configured
assistant is used, otherwise a single detected one (`~/.claude` for Claude Code,
`~/.config/opencode` for opencode), otherwise a terminal prompt, otherwise `claude` as the
back-compatible default. `check`, `remove`, and `update` read the
[manifest](/reference/glossary/#manifest) first, so when every entry they touch was installed for
one assistant, that assistant is used with no prompt. The
[CLI overview](/reference/cli/overview/#assistant-resolution) is the authoritative order.

In a terminal with nothing configured or detected, rigger asks:

```
Which assistant do you want to target?
```

In a script the prompt is not available, so pin the assistant explicitly (the flag above) or
configure it once (below). Resolution is the same for every command, which means a machine set up
one way behaves the same across `install`, `check`, `remove`, and `update`.

## Persist your choice

`agent-rigger init` writes the assistants you pick into `assistants[]` in your configuration. When
that list holds a single entry, every command targets it without the flag, and detection and the
prompt are skipped. Configure it once instead of passing `--assistant` on each call. See
[getting started](/start/getting-started/) for the init walkthrough.

## What changes when you target opencode

The command surface is identical. What differs is where files land and the native shape each
artifact takes.

**Where files land.** Claude Code artifacts go under `~/.claude` at user scope, or `<repo>/.claude`
at project scope. opencode artifacts go under `~/.config/opencode` at user scope; at project scope
`opencode.json` and `AGENTS.md` sit at the repository root and the rest under `<repo>/.opencode`.
The full grid of every nature against every assistant and scope is
[where each nature lands](/concepts/artifact-natures/#where-each-nature-lands).

**Guardrails.** A [guardrail](/reference/glossary/#guardrail) on Claude Code is a set of deny and
allow rules merged into `settings.json`. On opencode it is a native `permission` object merged into
`opencode.json`. The catalog authors opencode's permission descriptor directly; there is no
automatic translation from the Claude rules, so a guardrail installs for opencode only when its
catalog entry ships one.

**Agents.** Claude Code links the source `.md` as it is. opencode writes a translated file: its
frontmatter is rewritten into opencode's schema. You get a different file on disk from the same
catalog source.

**You do not need opencode installed.** rigger writes opencode's files directly and never invokes
the opencode binary, which means you can provision an opencode harness on a machine before opencode
itself is installed. The only effect of a missing `~/.config/opencode` is on auto-detection: rigger
will not pick opencode on its own, so pass `--assistant opencode` or set `assistants[]`.

## When an artifact does not target your assistant

Every catalog entry declares which assistants it targets. When you select an entry whose targets
exclude the assistant you are installing for, rigger skips it rather than writing the wrong format.
It reports the skip and installs nothing:

```
--- Skipped (assistant mismatch) ---
  [skipped] example/skill:hello-rigger — targets [claude], not opencode
```

The run exits `0` and touches no files. The fix is not a flag: either target the assistant the entry
was authored for, or use a catalog entry that lists yours among its targets.

## copilot is reserved

`copilot` is a recognised assistant name, but with no [adapter](/reference/glossary/#adapter) yet it
cannot be selected. Passing it is rejected like any invalid value:

```
[error] Invalid --assistant value: "copilot". Must be "claude" or "opencode".
```

The command exits `2` and writes nothing.
