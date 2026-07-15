---
title: Try it in a sandbox
description: Drive rigger against throwaway directories under /tmp so nothing it does can reach your real config or your real projects. Source the sandbox, run a real command, reset to a blank slate, and tear it all down.
---

An AI coding assistant is configured through files on your machine, and a tool that edits
those files asks for some trust the first time you run it. This tutorial gives you a way to
earn that trust cheaply: a throwaway playground where every change rigger makes lands in
temporary directories under `/tmp`, so your real configuration and your real projects are
never read or written. When you are finished you delete the throwaway directories, and your
machine is exactly as it was before you started.

The sandbox is a small script, `scripts/sandbox`, that ships in the repository. It redirects
where rigger reads and writes, and runs a real command. Then it cleans up after itself. By the
end you will have added a [catalog](/reference/glossary/#catalog), seen the tool touch only
its temporary home, reset to a blank slate, and torn the whole thing down in one word.

## Before you start

You need one of two things:

- a checkout of the repository (`git clone`: see [installation](/start/installation/#from-source)),
  which is where `scripts/sandbox` lives, or
- an installed `agent-rigger` on your `PATH` plus the repository checkout for the script
  itself.

You also need `git`, because the example catalog is a git repository the tool fetches. The
sandbox itself changes nothing about your assistant; it only isolates where rigger works.

The outputs shown below set `NO_COLOR=1` for readable copy-paste; on a real terminal the tool
adds colour. Every `/tmp` path here ends in a random suffix that **will differ on your
machine**: `mktemp` picks a fresh one each run.

## Step 1 — source the sandbox

From inside the repository, **source** the script into your current shell:

```sh
source scripts/sandbox
```

```
[sandbox] binary      : /path/to/agent-rigger/packages/cli/dist/agent-rigger  (local build)
[sandbox] RIGGER_HOME : /tmp/rigger-sandbox.LXrT3e  (user-scope writes isolated here)
[sandbox] project dir : /tmp/rigger-sandbox-project.xtywZi  (now your cwd — project-scope writes isolated here)
[sandbox] ready — use:  rigger <command>     (reset: rigger_reset · quit: rigger_exit)
[sandbox] try:          rigger catalog add example "$RIGGER_EXAMPLE_CATALOG"
```

Four things just happened:

- The script picked a binary and told you which. It prefers a locally built
  `packages/cli/dist/agent-rigger`; if you are inside the repo without one it builds it with
  `bun run build`; failing that it falls back to an installed `agent-rigger` on your `PATH`,
  printing `(installed — PATH/Homebrew)` instead. So the banner always names the exact binary
  you are about to exercise.
- It created a disposable home directory and exported its path as
  [`RIGGER_HOME`](/reference/glossary/#rigger_home). That variable overrides the home
  directory rigger uses for every user-scope path, so machine-wide writes land under `/tmp`
  instead of your real `~/.claude` and `~/.config`.
- It created a disposable project directory and `cd`'d you into it, so
  [project-scope](/reference/glossary/#scope) writes, which target the current working
  directory, are contained too. Between them, both scopes are covered.
- It bound a `rigger` shell function to that binary. From here, plain `rigger …` runs the
  sandboxed tool.

## Step 2 — run a real command

You are now driving the actual tool, only pointed at throwaway directories. Ask
[`doctor`](/reference/glossary/#doctor) what it sees:

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

`mode : full scan` means a scanner (gitleaks or trivy) is present, so fetched content will be
checked before it is written. Without either you would see `warn-only` here instead: the tool
still runs, but content is not scanned. Nothing is installed in this fresh home, so the state
is healthy.

## Step 3 — prove nothing escaped

Add the public example catalog. The sandbox already exported its URL as
`RIGGER_EXAMPLE_CATALOG`, so you can paste the line the banner suggested:

```sh
rigger catalog add example "$RIGGER_EXAMPLE_CATALOG"
```

```
catalog "example" added (https://github.com/agent-rigger/agent-rigger-catalog-example.git)
```

That single line is what prints when the command's output is piped, which is how it was
captured for this page. On a real terminal `stdout` is a TTY, so the same command continues
past it into an interactive picker, `Select artifacts to install (required items are always
included):`, and waits for you to choose. The picker does not change the write you are about
to check below: press Ctrl-C there and the catalog source stays saved, because that write
already happened before the picker opens.

That command recorded a catalog source in rigger's config: a real write. Now look at every
file that write produced under the sandbox home:

```sh
find "$RIGGER_HOME" -type f | sort
```

```
/tmp/rigger-sandbox.LXrT3e/.config/agent-rigger/config.json
```

One file, and it is under `/tmp`. Your real `~/.config/agent-rigger` was never opened. This is
the whole point: you ran a genuine, state-changing command and it stayed inside the throwaway
directory.

From here you could add artifacts exactly as the [getting-started walk-through](/start/getting-started/)
does: `rigger ls`, `rigger install <id> --yes`, `rigger check`, and each one would write only
under `RIGGER_HOME`. This page stops here because its subject is the sandbox, not the rig.

## Step 4 — reset to a blank slate

To start over without leaving, call `rigger_reset`. It wipes the current home and project
directory and creates fresh empty ones:

```sh
rigger_reset
```

```
[reset] removed old RIGGER_HOME: /tmp/rigger-sandbox.LXrT3e
[reset] fresh RIGGER_HOME: /tmp/rigger-sandbox.momRSF
[reset] removed old project dir: /tmp/rigger-sandbox-project.xtywZi
[reset] fresh project dir: /tmp/rigger-sandbox-project.fhnRg7  (now your cwd)
```

The catalog you added is gone; `rigger doctor` would again report an empty, healthy state.
Reset as often as you like to compare a command's effect from a clean start.

## Step 5 — tear it all down

When you are done, `rigger_exit` returns your shell to exactly where it was:

```sh
rigger_exit
```

```
[sandbox] cleaned up — back in /path/to/agent-rigger
```

`rigger_exit` does three things:

- `cd`s you back to the directory you sourced from
- deletes both throwaway directories
- unsets the sandbox's variables and the `rigger`, `rigger_reset`, and `rigger_exit` functions

Afterwards `RIGGER_HOME` is unset and plain `rigger` resolves to whatever was on your `PATH`
before (an installed binary, if you have one): the shell state you started with. If you would
rather step out but keep the directories for later, `cd "$RIGGER_SANDBOX_ORIGIN"` instead.
Either way, nothing forces the throwaway directories to disappear on their own. `/tmp` cleanup
policy is OS-specific: on macOS, for instance, it is not cleared on every reboot, only aged out
periodically. Delete them yourself with `rm -rf` if you want them gone for good.

## Why you source it, and never execute it

The script only works because it changes **your current shell**. It exports variables, defines
the `rigger`, `rigger_reset`, and `rigger_exit` functions, and `cd`s you into the project
directory. An executed script runs in a child process whose environment and working directory
vanish the moment it exits, so none of that would reach you. Sourcing runs the lines in your
own shell, which is the point.

Two things stop you from getting this wrong. First, the file itself carries no executable bit,
so your shell refuses to run it as a command at all:

```sh
./scripts/sandbox
```

```
bash: ./scripts/sandbox: Permission denied
```

That alone stops the bare command above (exit code 126, before the script's own code ever
runs). If you go out of your way to force it through an interpreter instead, for example
`bash scripts/sandbox`, the script's own guard catches it too:

```sh
bash scripts/sandbox
```

```
Error: source me, do not execute:
  source scripts/sandbox
```

Either way it exits non-zero and does nothing. Source it, and it proceeds.

## What the sandbox does and does not isolate

The isolation is about **files**, and it is complete for files: user-scope writes go to the
disposable `RIGGER_HOME`, project-scope writes go to the disposable project directory you are
`cd`'d into, and the `rm -rf` in reset and exit is guarded to only ever delete paths under the
expected `/tmp/rigger-sandbox*` prefixes.

It is not an operating-system sandbox. Adding a catalog still reaches out over the network to
fetch a real git repository, and the tool still runs the real scanners on your machine. What
the sandbox guarantees is that your real configuration and your real project directories are
neither read nor written. That does not mean rigger is cut off from the outside world.

One practical note: some commands are interactive and need a real terminal. `rigger install`
with no ids, and the `rigger init` wizard, prompt for input; in a
[non-interactive](/reference/glossary/#tty--non-interactive) shell they cannot get it. When
you want a scripted, prompt-free run inside the sandbox, pass explicit ids and `--yes`, as the
getting-started tutorial does. `catalog add` (Step 3) is interactive the same way: on a real
terminal it opens the artifact picker described there, and no flag skips it; only a
non-interactive `stdout` (a pipe, a script) bypasses it.

## Where to go next

- [Walk through your first rig](/start/getting-started/): install and audit a pack, still in
  an isolated home.
- [Install agent-rigger](/start/installation/) properly, for real use.
- Read [what agent-rigger is for](/start/what-is-agent-rigger/) before committing to it.
