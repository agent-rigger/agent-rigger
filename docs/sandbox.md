# Sandbox — try `rigger` without touching your real setup

`scripts/sandbox` lets you drive `rigger` against **throwaway** directories, so
nothing it does can reach your real config or your real projects. It defines a
`rigger_reset` function to wipe back to a blank slate between runs.

## Quick start

```sh
source scripts/sandbox

rigger catalog add example "$RIGGER_EXAMPLE_CATALOG"   # public demo catalog
rigger ls
rigger install                                         # pick artifacts

rigger_reset                                           # blank slate, same session
rigger_exit                                            # tear down + leave (see below)
```

> `rigger_reset` is a shell function the sandbox defines for you — not a separate
> script. A function already runs in your current shell, which is exactly what
> its `cd` and exports need, and it works from anywhere (including the `/tmp`
> project dir you are cd'd into).

## Why you must `source`, not execute

The script mutates **your current shell**: it `export`s environment variables,
defines the `rigger`, `rigger_reset` and `rigger_exit` shell functions, and
`cd`s you into a disposable project dir.

An _executed_ script runs in a child sub-shell — its env, functions, and cwd
changes die the moment it exits, so they never reach your shell. _Sourcing_ runs
the lines in your current shell, which is the whole point. The script refuses to
run if executed directly.

```sh
source scripts/sandbox     # ✅
./scripts/sandbox          # ❌ "Error: source me, do not execute"
```

## What gets isolated

| Scope         | Real path                               | In the sandbox                                              |
| ------------- | --------------------------------------- | ----------------------------------------------------------- |
| User config   | `~/.claude`, `~/.config/agent-rigger`   | `$RIGGER_HOME/.claude`, `$RIGGER_HOME/.config/agent-rigger` |
| Project files | `<your cwd>/.claude`, `<cwd>/AGENTS.md` | `$RIGGER_SANDBOX_PROJECT/…` (you are cd'd here)             |

- **User scope** is redirected by `RIGGER_HOME` — the single seam the CLI honours
  for home resolution (`RIGGER_HOME` → `HOME` → `os.homedir()`, see
  `packages/core/src/paths.ts`).
- **Project scope** is redirected by putting you inside a disposable project
  directory (`$RIGGER_SANDBOX_PROJECT`); project-scope writes target the current
  working directory, so being inside the throwaway dir keeps them contained.

Together these cover **both** scopes — your real `~/.claude` _and_ any real
project directory are never read or written.

## Environment variables

| Variable                 | Meaning                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `RIGGER_HOME`            | Disposable home (`/tmp/rigger-sandbox.XXXXXX`); user-scope writes land here.            |
| `RIGGER_SANDBOX_PROJECT` | Disposable project dir (`/tmp/rigger-sandbox-project.XXXXXX`); your cwd after sourcing. |
| `RIGGER_SANDBOX_ORIGIN`  | The directory you were in before sourcing — `cd "$RIGGER_SANDBOX_ORIGIN"` to return.    |
| `RIGGER_EXAMPLE_CATALOG` | URL of the public example catalog, handy for `rigger catalog add`.                      |

## Which binary it runs

The sandbox resolves the binary in this order and prints which one it picked:

1. A locally built `packages/cli/dist/agent-rigger`, if present.
2. Otherwise, when sourced from inside the repo, it runs `bun run build` to
   produce it.
3. Otherwise it falls back to an installed `agent-rigger` on your `PATH` — e.g.
   a Homebrew build (`brew install agent-rigger/tap/agent-rigger`). This lets you
   sandbox a released binary without a source checkout.

If none of these is available it stops with instructions to build or install.

## Reset and exit

Both are functions the sandbox defines; their `rm -rf` is guarded to only delete
paths under the expected `/tmp/rigger-sandbox*` prefixes.

- **`rigger_reset`** — start over _without leaving_: removes the current
  `RIGGER_HOME` **and** `RIGGER_SANDBOX_PROJECT`, creates fresh empty ones, and
  cd's you into the new project dir.
- **`rigger_exit`** — tear everything down: cd's back to
  `RIGGER_SANDBOX_ORIGIN`, deletes both throwaway dirs, and unsets the sandbox
  vars and functions (`rigger`, `rigger_reset`, `rigger_exit`) — your shell is
  left exactly as it was before you sourced the sandbox.

If you just want to step out but keep the dirs, `cd "$RIGGER_SANDBOX_ORIGIN"`.
Either way the `/tmp` dirs are disposable — the OS clears `/tmp` on reboot.
