```text
██████╗ ██╗ ██████╗  ██████╗ ███████╗██████╗
██╔══██╗██║██╔════╝ ██╔════╝ ██╔════╝██╔══██╗
██████╔╝██║██║  ███╗██║  ███╗█████╗  ██████╔╝
██╔══██╗██║██║   ██║██║   ██║██╔══╝  ██╔══██╗
██║  ██║██║╚██████╔╝╚██████╔╝███████╗██║  ██║
╚═╝  ╚═╝╚═╝ ╚═════╝  ╚═════╝ ╚══════╝╚═╝  ╚═╝
The harness package manager for teams
```

# agent-rigger

The harness package manager for teams. Share, install, and update the AI coding
assistant harness (Claude Code at M0) in a reproducible way across a team's
machines.

[![CI](https://github.com/agent-rigger/agent-rigger/actions/workflows/ci.yml/badge.svg)](https://github.com/agent-rigger/agent-rigger/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.3-000?logo=bun)](https://bun.sh)
[![Conventional Commits](https://img.shields.io/badge/commits-conventional-fe5196?logo=conventionalcommits)](https://www.conventionalcommits.org/)

![agent-rigger in action: doctor, browse the team catalog, install the rig in one command, verify zero drift](./docs/demo.gif)

> A throwaway `$RIGGER_HOME` is used for the recording — your real `~/.claude` is
> never touched. Regenerate the GIF with `vhs docs/demo.tape` (see
> [`docs/demo.tape`](./docs/demo.tape)).

---

## The problem

Team setups drift. Each developer maintains their own `~/.claude/settings.json`,
deny lists, context files, skills, and agents — installed manually, updated
inconsistently, and impossible to audit. When a guardrail is missing or a skill
goes stale, nobody knows until something breaks.

`agent-rigger` treats the harness as a versioned package: a shared catalog
defines what should be installed, a manifest records what is installed, and a
single command tells you whether your local setup matches the expected state.

---

## Concepts

**Artifact** — a deployable unit of harness configuration. Eight natures:

| Nature      | What it is                                                         |
| ----------- | ------------------------------------------------------------------ |
| `guardrail` | Deny list written into `settings.json` (`permissions.deny`)        |
| `hook`      | Claude Code hook written into `settings.json` (`hooks`) + a script |
| `context`   | AGENTS.md context file symlinked into `~/.claude/`                 |
| `skill`     | Workflow script installed into the skill store                     |
| `agent`     | Role-specialised sub-agent definition (Markdown)                   |
| `mcp`       | MCP server declaration (reserved; not in the catalog yet)          |
| `plugin`    | Claude Code plugin installed via the plugin marketplace            |
| `tool`      | Third-party host CLI (e.g. `glab`); presence-checked               |

A `hook` entry carries its `event` (e.g. `PreToolUse`) and `matcher`; installing
it merges the hook into `settings.json` and deposits its script into a managed
store. The built-in guards (`hook:guard-command`, `hook:guard-secret`,
`hook:guard-write-secret`, `hook:guard-prompt`) ship this way.

**Pack** — a named bundle of artifacts installed as a unit. Examples:
`pack:spec-workflow` (a skill + three agents), `pack:harness` (the four guard
hooks), `pack:baseline` (a team baseline: `pack:harness` + guardrails + context).

**Catalog** — the list of known artifacts and packs. agent-rigger ships **no
content of its own**: every artifact comes from a catalog you configure (`init`),
fetched from a remote content repository (`ls`/`add`/`update`). No catalog
configured → nothing to install.

**Manifest** — `~/.config/agent-rigger/state.json`. Records what was installed
and when. Used by `check` to detect drift.

**Store + symlink** — skills are written to a managed store
(`~/.config/agent-rigger/skills/`) and symlinked into place. The source of
truth is the store; the symlink is the target. The symlinks use **absolute
paths**, and the store is always under `~/.config/agent-rigger/` regardless of
scope.

> **Invariant — fixed paths.** Do not move, rename, or `mv` the install
> directory (`~/.config/agent-rigger/`, `~/.claude/`) or any artifact by hand:
> the absolute symlinks and the `state.json` manifest both assume stable paths,
> so a manual move breaks the links and desyncs the manifest. To rename or
> relocate an artifact, go through the CLI (`remove` then `install`).

**Delegate-first** — `agent-rigger` delegates external tool installation to the
host package manager (brew, mise). It detects presence via `command -v` and
reports what is missing; it does not install tools itself.

---

## Assistants

`agent-rigger` targets two AI coding assistants: **Claude Code** (`claude`) and
**opencode** (`opencode`). Each transaction runs through an assistant-specific
_adapter_ that writes to that assistant's native config locations; the engine
(`plan → confirm → backup → apply → manifest`) is identical for both.

### Selecting the assistant

Every `install` / `check` / `remove` / `update` targets exactly one assistant,
resolved in priority order (highest first):

1. **`--assistant claude|opencode`** — an explicit flag always wins; an invalid
   value is a hard error (fail fast on typos).
2. **`config.assistants[]`** — when the config names exactly one assistant, it is
   used without prompting (CI-reproducible).
3. **Detection** — when exactly one assistant is present on disk (`~/.claude` →
   `claude`, `~/.config/opencode` → `opencode`), it is used.
4. **Interactive prompt** — in a TTY with more than one candidate, the picker
   asks _"Which assistant do you want to target?"_.
5. Otherwise (non-interactive and ambiguous), an actionable error — never a
   silent default.

```sh
agent-rigger install --assistant opencode    # explicit target
agent-rigger install                          # infer or prompt, then remember it
```

The chosen assistant is **recorded in the manifest per entry**, so `check`,
`remove`, and `update` reconstruct the right adapter and operate on the correct
config **without re-prompting**.

### What installs, per nature (opencode)

For opencode, each nature maps to opencode's own native mechanisms. Paths shown
are project scope; user scope writes under `~/.config/opencode/` instead of
`.opencode/`.

| Nature      | opencode target                    | How it lands                                                              |
| ----------- | ---------------------------------- | ------------------------------------------------------------------------- |
| `context`   | `AGENTS.md` (root)                 | Written **as-is** — no import block (opencode reads `AGENTS.md` natively) |
| `skill`     | `.opencode/skills/<n>`             | Symlinked into place; the physical store is **shared** with Claude        |
| `agent`     | `.opencode/agents/<n>.md`          | Frontmatter **translated** to opencode's schema; Markdown body verbatim   |
| `mcp`       | `opencode.json` — `mcp` key        | Server merged in; secrets by env indirection (ADR-0019)                   |
| `plugin`    | `.opencode/plugin/<n>.ts`          | Native JS/TS module **copied** from the catalog (store + symlink)         |
| `guardrail` | `opencode.json` — `permission` key | Native opencode permission descriptor **merged verbatim**                 |
| `hook`      | — (Claude-only)                    | **Skipped** for opencode, with a visible message                          |

(`tool` is assistant-agnostic — presence-checked either way.) Merges into
`opencode.json` are leaf-granular and preserve unrelated keys, comments, and the
user's own rules.

**Guardrail — a native descriptor, not a translation.** For opencode a guardrail
installs a hand-written opencode permission descriptor shipped by the catalog
(`guardrails/opencode/permission.json`), merged verbatim into the `permission`
key. There is no Claude→opencode rule translation (ADR-0021): a native
descriptor is auditable and uses opencode's own `read` / `edit` /
`external_directory` path-globs directly.

**Hooks are Claude-only.** The `hook` nature is executable Claude Code logic
written to `settings.json`; the opencode adapter has no hook handler. When a
transaction targets opencode, hook entries — and anything whose `targets` does
not include opencode — are excluded with a visible line, never silently:

```
--- Skipped (assistant mismatch) ---
  [skipped] hook:guard-secret — targets [claude], not opencode
```

opencode's enforcement is carried by the `plugin` nature (native guard modules)
and the `permission` descriptor instead.

> **Guardrail `read` denies are defense-in-depth, not a hard barrier.** opencode
> sub-agents invoked via the Task tool bypass `read` / `grep` deny rules
> (opencode #32024). Treat the `read` side of the guardrail as one layer, not a
> guarantee that secrets are unreadable; the `edit` and `external_directory`
> denies are not affected.

---

## Prerequisites

- **Bun >= 1.3** — the runtime and package manager.
- **Claude Code and/or opencode** — the AI coding assistant(s) this harness
  configures. See [Assistants](#assistants) for how the target is selected.
- **git** — required for remote catalog operations (`ls` against a configured
  catalog URL). agent-rigger shells out to `git ls-remote` and `git clone`.
- **gitleaks and/or trivy** — required to **install** `external` artifacts from a
  remote catalog: their content is scanned for secrets/misconfigurations before
  it lands on disk. A blocking finding stops the install unless you pass
  `--force` (fail-closed on findings). With no scanner installed, the scan is
  degraded instead: the install proceeds with a warning that the content was
  not scanned, and `rigger doctor` reports the warn-only mode — no `--force`
  needed for this case.
- **`glab` or `gh`** — required if the catalog references GitLab or GitHub
  resources. `init` probes ambient auth first; it asks for the method only if
  the probe fails.

---

## Installation

### Homebrew (macOS / Linux)

```sh
brew tap agent-rigger/tap
brew install agent-rigger
```

Installs the `agent-rigger` binary and the shorter `rigger` alias.

### Pre-built binaries

Every [GitHub Release](https://github.com/agent-rigger/agent-rigger/releases)
attaches standalone binaries for five targets (Linux x64/arm64, macOS
x64/arm64, Windows x64) plus a `SHA256SUMS.txt` to verify the download.

### From source

Requires [Bun](https://bun.sh) >= 1.3.

```sh
git clone https://github.com/agent-rigger/agent-rigger.git
cd agent-rigger
bun install
bun run build
# produces packages/cli/dist/agent-rigger
```

Or run directly without building:

```sh
bun run packages/cli/src/cli.ts <command>
```

Caveat: a local build reports `--version` as `0.0.0`. The real version is
stamped from the git tag at release time only.

Note: the CLI ships no content of its own. Every artifact comes from a
configured catalog fetched at runtime, so the compiled binary is
self-contained (nothing to bundle).

### Try it in isolation (sandbox)

Want to try `rigger` without touching your real setup? Source the sandbox
helper: it points a `rigger` shell function at the binary (a local build, or an
installed one on your `PATH` such as Homebrew) and isolates **both** scopes — a
disposable `RIGGER_HOME` for user-scope writes and a disposable project dir it
cd's you into for project-scope writes.

```sh
source scripts/sandbox
# [sandbox] RIGGER_HOME : /tmp/rigger-sandbox.XXXXXX  (user-scope writes isolated here)
# [sandbox] project dir : /tmp/rigger-sandbox-project.XXXXXX  (now your cwd)

rigger catalog add example "$RIGGER_EXAMPLE_CATALOG"   # public demo catalog
rigger ls
rigger install            # pick artifacts; nothing is written outside the sandbox

rigger_reset              # wipe and start from a blank slate (works from /tmp)
rigger_exit               # tear down: cd back, delete temp dirs, unset everything
```

Your real config (`~/.claude`, `~/.config/agent-rigger`) and your real projects
are never read or written. Must be **sourced**, not executed — it mutates your
current shell (env, the `rigger`/`rigger_reset`/`rigger_exit` functions, and your
cwd). Full guide: [docs/sandbox.md](docs/sandbox.md).

---

## Usage

### `check` — audit the current setup

Reads the installed state and compares it against the expected guardrails and
context entries.

```
agent-rigger check [--scope=user|project]
```

Exit codes:

| Code | Meaning                                         |
| ---- | ----------------------------------------------- |
| 0    | All entries present and up to date              |
| 2    | A JSON file is malformed — cannot run the audit |
| 3    | One or more entries are missing or have drifted |

Example output when entries are missing:

```
[missing]  guardrails-claude  (~/.claude/settings.json deny list)
[missing]  context-claude     (~/.claude/harness/AGENTS.md)

--- Tools ---
  [missing required]  tool:glab
```

Example output when everything is present:

```
[present]  guardrails-claude
[present]  context-claude

--- Tools ---
  [tools ok] All tools present.
```

### `doctor` — diagnose environment and installed state

Where `check` audits the entries the manifest expects, `doctor` is the wider
health check. It runs in **two phases**, in order:

1. **Environment dependencies.** Lists the external tools agent-rigger relies on
   (`gitleaks`, `trivy`, `glab`, `git`) with their availability, so you know
   whether remote installs run in **full scan** or **warn-only** mode before you
   install anything.
2. **Installed state.** Scans the actual filesystem and manifest for problems
   `check` does not look at — untracked artifacts, dangling symlinks, phantom
   stores, manifest issues, a stale run lock, and `.bak` hygiene — and reports
   them grouped by class.

```
agent-rigger doctor                 # read-only diagnosis
agent-rigger doctor --fix           # diagnose, then repair under consent
agent-rigger doctor --remote        # also read configured catalog content
agent-rigger doctor --remote --fix  # both (combinable)
```

Example environment phase:

```
--- agent-rigger doctor ---

✓ gitleaks (/opt/homebrew/bin/gitleaks)
✓ trivy (/opt/homebrew/bin/trivy)
✓ glab (/opt/homebrew/bin/glab)
✓ git (/usr/bin/git)

mode : full scan
```

Example installed-state phase with findings:

```
Installed-state check · 2 findings

Untracked artifacts (1)
  + skill "spec-workflow" is untracked but conforms to its store — adoptable.  [fix]

Manifest issues (1)
  ~ "jr/guardrail:claude"'s recorded applied payload no longer matches the live config.  [report]
```

When there is nothing to report, the phase prints
`Installed state is healthy — no findings.`

**`--fix` — repair under consent.** Without `--fix`, `doctor` is strictly
read-only: it never writes. With `--fix` it repairs the findings it can, driven
by consent tags shown in the report:

- `[fix]` — a **safe** repair (e.g. adopt a conforming artifact, unlink a
  dangling symlink). Applied non-interactively when you pass `--yes`.
- `[confirm]` — a **destructive** repair (e.g. delete residue, break a lock).
  Confirmed **per item**, never applied under `--yes` alone.
- `[report]` — a **report-only** finding. It carries no repair; the summary
  states the manual way out (reinstall, or `remove`). `--fix` never touches it.

In a non-interactive session (no TTY), `--fix` applies the safe repairs and
leaves every `[confirm]` and `[report]` finding untouched — it never prompts.

**`--remote` — the catalog differential.** Some natures leave no disk signature
that distinguishes a rigger-installed element from user-typed content: a
guardrail deny rule, a context block, and an mcp server are the same bytes
either way. Telling them apart needs a reference to compare against, which means
fetching the catalog. Under `--remote`, `doctor` shallow-clones **every**
configured catalog read-only (ephemeral, cleaned up afterwards — same fetch as
`ls`), reads its canonical content, and surfaces two extra findings:

- **host-diff** — an element present in the host config, absent from the
  manifest, whose content is **byte-identical** to the catalog canon (proven
  rigger content that was never tracked). Content that only resembles the canon
  is treated as your own and stays silent — zero false positives.
- **divergent mcp** — a host mcp server under the **same name** as a catalog
  server but with different content, never adopted. The finding names the two
  ways out (consented reinstall, or manual removal).

Both are **report-only** (no repair). `--remote` is **fail-closed**: any fetch
error (network, auth, ref/sha mismatch) aborts with the offending catalog named
and exit 1 — it never degrades silently to a disk-only scan (a CI passing
`--remote` must never believe it got the differential without getting it). It
combines with `--fix`; the only cross-effect is adoption resolution — when two
configured catalogs offer the same nature+name, `--fix` prompts for the catalog
in a TTY, and skips + reports in a non-TTY rather than guess.

Exit codes:

| Code | Meaning                                                                        |
| ---- | ------------------------------------------------------------------------------ |
| 0    | Healthy — no findings (with `--fix`: everything was repaired)                  |
| 3    | One or more findings (with `--fix`: findings remain — irreparable or refused)  |
| 2    | `state.json` is malformed — cannot diagnose the installed state                |
| 1    | A repair failed (`--fix`), or a catalog fetch failed (`--remote`, fail-closed) |
| 130  | Interrupted (Ctrl-C at a confirmation prompt)                                  |

### `install` — install selected artifacts

Opens an interactive selection of the built-in catalog, resolves dependencies
and packs, shows a diff plan, and asks for confirmation before writing anything.

```
agent-rigger install
```

The command:

1. Presents a multi-select list of available artifacts and packs.
2. Asks for the installation scope (`user` or `project`).
3. Resolves the selection: packs expand to their members; dependencies are
   included transitively.
4. Displays the plan (what will be written, linked, or updated).
5. Asks for explicit confirmation — **nothing is written without it**.
6. Backs up existing files to `.bak-<timestamp>` before overwriting.
7. Writes files, creates symlinks, installs plugins, and updates the manifest.

Example plan section:

```
--- Plan ---
  +  deny rule: Read(./.env)
  ~  import: ~/.claude/harness/AGENTS.md
  -> skill:spec-workflow  ~/.config/agent-rigger/skills/spec-workflow -> ~/.claude/skills/spec-workflow

--- Tool Warnings ---
  [missing required]    tool:glab
```

Tool warnings are advisory. A missing required tool is reported but does not
block installation.

**Installing from a remote catalog.** When a catalog URL is configured (via
`init`), a **non-interactive** install (`install <id…>` / `<resource> add <id>`)
resolves the requested ids against the **effective catalog** (built-in ∪
remote). For an `external` artifact, agent-rigger shallow-clones the content
repo at the resolved version, copies the artifact's content
(`skills/<name>/`, `agents/<name>.md`) into the managed store, and records the
real `ref` (tag) and `sha` in the manifest. The temporary clone is always
removed afterwards. A built-in (`internal`) artifact installs from the local
tree and records the tool's own version. Without a catalog URL, install uses the
built-in catalog only (no network).

Interactive `install` (no ids) lists the **effective catalog** too: when a
catalog URL is configured, remote entries appear in the multiselect and install
through the same remote path.

**Installing hooks.** A `hook` artifact (e.g. `hook:guard-secret`, or the whole
set via `pack:harness` / `pack:baseline`) merges its `event`/`matcher` into
`settings.json` under `hooks` and deposits its script into the managed hook store
(`~/.config/agent-rigger/hooks/`); the registered command runs that deposited
script. Removing a hook reverts the `settings.json` entry (the shared scripts are
left in the store).

### `remove` — uninstall artifacts

Remove installed artifacts. Shows a removal plan (what will be deleted or
reverted) and asks for confirmation before making any change.

```
# Resource-scoped form — validates the id belongs to the resource type
agent-rigger guardrails remove jr/guardrail:claude [--yes] [--scope=user|project]
agent-rigger context remove jr/context:claude --yes

# Top-level form — any resource type
agent-rigger remove jr/guardrail:claude jr/context:claude --yes
```

The command:

1. Looks up each id in the **manifest** (what is actually installed) — this is
   offline and requires no catalog or network access; unknown/unqualified ids
   are rejected immediately.
2. Validates that each id matches the resource type (when using the resource
   form: `guardrails remove`, `skills remove`, etc.).
3. Computes the removal plan via the adapter: rules to un-deny, import blocks
   to remove, files to delete, symlinks to unlink, plugins to uninstall.
4. Displays the plan with aligned verbs:
   - `un-deny` — removes deny rules from `settings.json`
   - `un-import` — removes managed import block from `CLAUDE.md`
   - `delete` — deletes a managed file (e.g. `AGENTS.md`)
   - `unlink` — removes a skill symlink and its store entry
   - `uninstall` — uninstalls a plugin via the native CLI
5. Asks for confirmation — **nothing is removed without it** (skip with `--yes`).
6. Backs up modified files before removal.
7. Updates the manifest to reflect the removed entries.

Example output:

```
--- Removal Plan ---
Removal plan (1 change):

  un-deny  ~/.claude/settings.json
           - Read(./.env)
           - Read(~/.ssh/**)

--- Result ---
  [ok] Removed 1 entry(s).
    - guardrails-claude
  [backup] 1 file(s) backed up.
    ~ ~/.claude/settings.json.bak-2026-06-21T21-00-00.000Z-abc123
```

After a `remove`, running `check` will show the entry as `[miss ]`.

### `update` — update installed artifacts from the remote

Compares installed artifacts against the latest version of the remote catalog
and re-installs the ones that are out of date. Requires a configured catalog URL
(`init`).

```
agent-rigger update <id…>        # update specific ids
agent-rigger <resource> update <id>
agent-rigger update              # update every installed external artifact
agent-rigger update <id…> --yes  # skip confirmation
```

For each candidate:

- An `external` artifact with a **newer** remote version is re-installed: the
  artifact is removed (unlinked) and re-installed from the new version, so the
  store holds the fresh content and the manifest records the new `ref`/`sha`.
- An artifact already at the latest version is left untouched (no write).
- A built-in (`internal`) artifact has no remote version — reported as a no-op.

Version comparison uses semver tags (or the default-branch HEAD sha when the
content repo has no tags). Nothing is written without confirmation (skip with
`--yes`).

`check` also surfaces available updates: when a catalog URL is configured and
the remote is reachable, it appends an `--- Updates ---` section listing
installed entries with a newer version (`<id>  <installed> → <latest>`). This is
advisory — it never changes the exit code and writes nothing.

### `init` — configure catalog URL and auth

Run once before the first `install` on a new machine. Persists the catalog URL
and authentication method to `~/.config/agent-rigger/config.json`.

```
agent-rigger init
```

The wizard:

1. Asks for the catalog repository URL.
2. Probes ambient auth (provider CLI probe first).
3. If the probe fails, asks which method to use: `gh`/`glab` provider CLI,
   HTTPS credential helper, or SSH key.
4. Writes config only after a successful auth probe. If auth fails, config is
   not persisted and the command exits with code 1 and an actionable message.

`init` is idempotent: re-running it merges the new URL and method on top of the
existing config.

### `ls` — list catalog entries (remote-aware)

Lists catalog entries with their install status. When a catalog URL is
configured (via `init`), `ls` also fetches the **remote** catalog and shows its
entries alongside the built-in ones.

```
agent-rigger ls               # all entries
agent-rigger catalog ls       # same
agent-rigger skills ls        # filtered by resource type
```

How the remote fetch works:

1. Resolves the current version of the content repo — the highest semver **tag**,
   or the default-branch **HEAD sha** when the repo has no tags.
2. Shallow-clones that version into a temporary directory (`git clone --depth 1
   --branch <ref>`), reads and validates `catalog.json`, then removes the
   temporary directory (always — success or failure).
3. Merges remote entries with the built-in catalog; **built-in entries win** on
   an id collision.

`ls` is **best-effort**: if the remote is unreachable (network, auth, bad ref),
it prints a warning and falls back to the built-in catalog (exit 0). Remote
access uses **ambient git credentials** (credential helper / ssh-agent). Installing
or updating _from_ the remote is a later milestone (M1-b / M1-c); at this stage
the remote is **read-only** through `ls`.

---

## Invariants

These properties hold across all commands:

- **Idempotence** — running `install` twice leaves the filesystem in the same
  state as running it once. An already-up-to-date plan produces zero writes.
- **Backup before write** — every existing file is copied to
  `.bak-<timestamp>` before being overwritten. No data is lost silently.
- **Human-in-the-loop** — `install` never writes without an explicit
  confirmation. The plan is shown first; declining writes nothing.
- **No silent failures** — every error is mapped to an actionable message and
  a non-zero exit code. The process never exits 0 on a partial failure.

---

## Caveats and M0 limitations

- **Two assistants: Claude Code and opencode.** Both are supported and selected
  per transaction (see [Assistants](#assistants)); other assistants (Copilot,
  etc.) are a later milestone. Two opencode limits to note: the `hook` nature is
  Claude-only (skipped with a visible message), and guardrail `read` denies are
  defense-in-depth rather than a hard barrier — sub-agents invoked via the Task
  tool bypass read denies (opencode #32024).
- **Security scan covers secrets + misconfig, not arbitrary behaviour.** Remote
  `external` content is scanned with gitleaks and/or trivy before install
  (fail-closed; `--force` overrides — you are responsible for what you install).
  This catches leaked secrets and misconfigurations, **not** behavioural analysis
  of an arbitrary malicious script. All fetched content is scanned uniformly
  (no trusted built-in exception).
- **Remote catalog.** `ls` reads the configured catalog, `install`/`add`
  install artifacts with real `ref`/`sha`, `update`/`check` compare
  installed vs latest, and the interactive picker lists catalog entries. A single
  configured catalog is supported (no built-in); multi-catalog is a follow-up.
- **Hook scripts and logs are shared.** Installing a `hook` deposits the whole
  hook script set into `~/.config/agent-rigger/hooks/` (a re-sync on each hook
  install). Any runtime log files the guard scripts write next to themselves are
  reset on the next hook install — treat the in-store hook logs as volatile.
- **Reversible manifest required for offline remove.** `remove`/`check` rely on
  the structured `applied` payload recorded at install time (ADR-0016). Entries
  installed by an older version (legacy manifest, no `applied`) degrade to
  best-effort — reinstall to record an exact, reversible payload.

---

## Development

```sh
bun install          # install dependencies
bun test             # run unit tests
bun run lint         # oxlint
bun run format       # dprint fmt
bun run format:check # verify formatting
bun run typecheck    # tsc --noEmit
```

Commits must follow [Conventional Commits](https://www.conventionalcommits.org/)
(enforced by commitlint via lefthook).

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow, the quality
gates, and the workspace layout. Changes are tracked in
[CHANGELOG.md](./CHANGELOG.md).

---

## Core team

- **Jonathan Robic** — Founder
  [GitHub](https://github.com/jrobic) · [LinkedIn](https://www.linkedin.com/in/jonathan-robic/)

---

## License

Released under the [Apache License 2.0](./LICENSE). See [DISCLAIMER.md](./DISCLAIMER.md)
for important notices on warranty, liability, and use.
