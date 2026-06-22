# agent-rigger

The harness package manager for teams. Share, install, and update the AI coding
assistant harness (Claude Code at M0) in a reproducible way across a team's
machines.

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

**Catalog** — the list of known artifacts and packs. agent-rigger ships a
built-in catalog and fetches additional entries from a remote content repository
when a catalog URL is configured (`ls`/`add`/`update`).

**Manifest** — `~/.config/agent-rigger/state.json`. Records what was installed
and when. Used by `check` to detect drift.

**Store + symlink** — skills are written to a managed store
(`~/.config/agent-rigger/skills/`) and symlinked into place. The source of
truth is the store; the symlink is the target.

**Delegate-first** — `agent-rigger` delegates external tool installation to the
host package manager (brew, mise). It detects presence via `command -v` and
reports what is missing; it does not install tools itself.

---

## Prerequisites

- **Bun >= 1.3** — the runtime and package manager.
- **Claude Code** — the assistant this harness configures.
- **git** — required for remote catalog operations (`ls` against a configured
  catalog URL). agent-rigger shells out to `git ls-remote` and `git clone`.
- **`glab` or `gh`** — required if the catalog references GitLab or GitHub
  resources. `init` probes ambient auth first; it asks for the method only if
  the probe fails.

---

## Installation (M0)

M0 does not distribute a pre-built binary. Clone the repository and run from
source:

```sh
git clone https://github.com/your-org/agent-rigger.git
cd agent-rigger
bun install
```

Run directly from source:

```sh
bun run packages/cli/src/cli.ts <command>
```

**Build a local binary:**

```sh
bun run build
# produces packages/cli/dist/agent-rigger
```

Note: the compiled binary does not yet bundle the `artifacts/` directory. The
binary resolves artifacts relative to the source tree at runtime, so the
distribution of a standalone binary is deferred to a packaging milestone.

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

> Interactive `install` (no ids) currently lists the built-in catalog only;
> remote selection from the interactive picker is a follow-up.

### `remove` — uninstall artifacts

Remove installed artifacts. Shows a removal plan (what will be deleted or
reverted) and asks for confirmation before making any change.

```
# Resource-scoped form — validates the id belongs to the resource type
agent-rigger guardrails remove guardrails-claude [--yes] [--scope=user|project]
agent-rigger context remove context-claude --yes

# Top-level form — any resource type
agent-rigger remove guardrails-claude context-claude --yes
```

The command:

1. Looks up each id in the catalog — unknown ids are rejected immediately.
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

- **Claude Code only.** Support for other assistants (opencode, Copilot, etc.)
  is a later milestone.
- **Security scanner is a stub.** The scan step that gates skill and plugin
  installation always passes in M0. A real implementation (Trivy, Gitleaks, or
  similar) is the security milestone.
- **Remote catalog is non-interactive (M1).** `ls` reads the remote catalog
  (M1-a), `install <id…>` / `<resource> add <id>` install `external` artifacts
  with real `ref`/`sha` (M1-b), and `update` / `check` compare installed vs
  latest (M1-c). Still pending: remote selection from the **interactive**
  `install` picker. The security scanner that gates remote content is still a
  stub (see below).
- **No standalone binary distribution.** The compiled binary resolves artifacts
  relative to the cloned repository. Bundling artifacts into the binary is a
  prerequisite for distributing `agent-rigger` as a single file.

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

---

## License

MIT
