---
title: Getting started
description: Install your first rig in about ten minutes — add the public example catalog, list what it offers, install a pack, and audit the result, all in a disposable sandbox.
---

This tutorial takes you from a freshly installed agent-rigger to a working rig in about
ten minutes. You will point the tool at a public example
[catalog](/reference/glossary/#catalog), see what it offers, install a small bundle, and
confirm the result — without touching your real setup.

You need agent-rigger [installed](/start/installation/) and `git` on your machine.

## Work in a disposable sandbox

Everything here runs against a throwaway home directory, so nothing lands in your real
`~/.claude` or `~/.config`. The [`RIGGER_HOME`](/reference/glossary/#rigger_home)
environment variable overrides the home directory the tool uses for every user-scope
path — set it to a fresh temporary directory:

```sh
export RIGGER_HOME="$(mktemp -d)"
```

Every command below reads and writes only under that directory. When you are done, one
`rm -rf` erases the whole experiment. Leave `RIGGER_HOME` unset in real use, and rigger
writes to your actual home directory.

The shown outputs use `NO_COLOR=1` for readable copy-paste; on a real terminal the tool
adds colour. The absolute paths in the output reflect whatever `RIGGER_HOME` resolved to.
Yours will differ.

## Step 1 — read the environment

Start by asking [`doctor`](/reference/glossary/#doctor) what it sees. It reports the
external tools rigger relies on and which scan mode you are in, then checks the installed
state (empty so far):

```sh
rigger doctor
```

```
--- agent-rigger doctor ---

✓ git (/opt/homebrew/bin/git)
✓ glab (/opt/homebrew/bin/glab)
✓ gitleaks (/opt/homebrew/bin/gitleaks)
✓ trivy (/opt/homebrew/bin/trivy)

mode : full scan

Installed state is healthy — no findings.
```

`mode : full scan` means gitleaks or trivy is present, so fetched content will be
scanned. If both are missing you would see `warn-only` here instead: the install still
works, but content is not scanned. Nothing is installed yet, so the state is healthy.

## Step 2 — add the example catalog

Register the public example catalog under a local name, `example`. A remote git URL works
as a source (a local path does too):

```sh
agent-rigger catalog add example https://github.com/agent-rigger/agent-rigger-catalog-example.git
```

```
catalog "example" added (https://github.com/agent-rigger/agent-rigger-catalog-example.git)
```

The source is now recorded in your config. Confirm it with `agent-rigger catalog ls`,
which lists each configured catalog as `name  url`.

## Step 3 — see what is available

List the catalog's entries:

```sh
agent-rigger ls
```

```
Catalog (7 entries):
  [available]  example/skill:hello-rigger  skill
  [available]  example/agent:demo          agent
  [available]  example/guardrail:demo      guardrail
  [available]  example/hook:demo           hook
  [available]  example/context:demo        context
  [available]  example/pack:demo           pack       (2 members)
  [available]  example/pack:full           pack       (5 members)
```

Each id is [qualified](/reference/glossary/#qualified-id) with its catalog name —
`example/skill:hello-rigger` — so ids stay unambiguous when you configure several
catalogs. Every row is `[available]`; none is installed yet. The two
[packs](/reference/glossary/#pack) bundle several artifacts under one id. (The example
catalog also declares a `tool:git` entry; advisory tool entries are not shown in this
listing — see the [CLI reference](/reference/cli/overview/).)

## Step 4 — install a pack

Install `example/pack:demo`, which bundles the `hello-rigger` skill and the `demo`
sub-agent. Passing `--yes` accepts the plan without an interactive prompt:

```sh
agent-rigger install example/pack:demo --yes
```

```
--- Plan ---
Plan · 2 changes · scope: user (~/.claude)

+ example/skill:hello-rigger   ~/.claude/skills/hello-rigger
  link  ~/.claude/skills/hello-rigger → store

+ example/agent:demo   ~/.claude/agents/demo.md
  link  ~/.claude/agents/demo.md → store

Σ  2 links

--- Result ---
  [ok] Applied 2 file(s).
    + /tmp/tmp.rig8f2/.claude/skills/hello-rigger
    + /tmp/tmp.rig8f2/.claude/agents/demo.md
```

The **Plan** block is the [dry-run](/reference/glossary/#plan-dry-run): the exact changes
rigger will make, shown before it makes them. Here both artifacts install as a
[symlink](/reference/glossary/#symlink) pointing at a managed
[store](/reference/glossary/#store) — one physical copy the assistant reaches through the
link. Because you passed `--yes`, rigger applied the plan straight away; without it, it
would pause and ask before writing. The **Result** block lists the files it actually
wrote.

## Step 5 — audit the result

Run `check` to confirm everything is correctly in place:

```sh
agent-rigger check
```

```
--- Catalogs ---
  [up-to-date]   example  (v0.4.0)
```

`check` returns [exit code](/reference/glossary/#exit-code) `0` when everything it audits
is present and matching. The pack installed only a skill and a sub-agent — neither of
which `check` re-audits in detail — so the report shows just the catalog status:
`example` resolved to version `v0.4.0` and your install is up to date. A missing or
drifted artifact would instead return exit `3`.

## Step 6 — see what landed

Look at what rigger actually placed under your sandbox:

```sh
find "$RIGGER_HOME" -type f -o -type l | sort
```

```
.../.claude/agents/demo.md
.../.claude/skills/hello-rigger
.../.config/agent-rigger/agents/demo.md
.../.config/agent-rigger/config.json
.../.config/agent-rigger/skills/hello-rigger/SKILL.md
.../.config/agent-rigger/state.json
```

Three kinds of thing are here. Under `.config/agent-rigger/skills/` and
`.config/agent-rigger/agents/` is the **store**: the single real copy of each installed
artifact. Under `.claude/` are the **symlinks** the assistant follows to reach that copy.
And `state.json` is the [manifest](/reference/glossary/#manifest): rigger's record of what
is installed here, at which version, and exactly what each install wrote: the same record
`check` audits against and `remove` replays in reverse.

## The interactive path

You ran everything non-interactively. Run `agent-rigger install` with no ids and, in a
real terminal, rigger asks which scope to use and shows a checkable list instead:

```
Select installation scope:
```

```
Select artifacts to install / update (Space on a group header toggles the whole group):
```

The first-run wizard, `agent-rigger init`, is interactive too. It asks for your team's
catalog and how to authenticate against it:

```
Enter the catalog repository URL:
```

```
Select authentication method:
```

These prompts cannot run in a script; use `catalog add` and `install <id> --yes`, as this
tutorial did, for non-interactive setups.

## Clean up

Erase the whole sandbox:

```sh
rm -rf "$RIGGER_HOME"
unset RIGGER_HOME
```

## Where to go next

- Install from your team's own catalog with the [install guide](/guides/install-from-catalog/).
- Understand catalog, manifest, and store in [core concepts](/concepts/core-concepts/).
- Build your own catalog in [create a catalog](/authoring/create-a-catalog/).
