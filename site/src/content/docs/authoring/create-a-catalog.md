---
title: Create a catalog
description: Build your first catalog from scratch (a git repo, a minimal catalog.json, one skill), install it on your own machine from a local path, then cut a versioned release.
---

A catalog is the shared list of things your team installs into their AI coding assistants: which
skills exist and how each one is installed. It lives in its own git repository, so teaching your
team a new habit becomes a commit and a tag rather than a message on Slack.

This tutorial builds one from nothing. You will make the repository with its two files, then install
your own skill on your own machine straight from a local folder. That local loop is how catalog
authors work day to day: no pushing to a remote, just edit and install. At the end you cut a version
and see the tool pick it up.

You need agent-rigger [installed](/start/installation/) and `git` on your machine. Basic Markdown
and JSON are enough; no prior knowledge of the tool's internals is assumed.

## Work against a disposable sandbox

Installing writes real files into a home directory. To keep this step fully undoable, point the tool
at a throwaway home with [`RIGGER_HOME`](/reference/glossary/#rigger_home), the one environment
variable that overrides where every user-scope path goes:

```sh
export RIGGER_HOME="$(mktemp -d)"
export NO_COLOR=1
```

Now every install lands under that temporary directory instead of your real `~/.claude`. One
`rm -rf` at the end erases it. `NO_COLOR=1` just keeps the copy-pasted output plain; a real terminal
adds colour. The catalog repository you are about to create is a normal folder you keep. Only the
install _target_ is sandboxed.

The absolute paths shown in outputs below reflect whatever `RIGGER_HOME` and your working folder
resolved to. Yours will differ.

## Step 1 — create the repository

A catalog is a git repository. Make an empty one:

```sh
mkdir my-first-catalog
cd my-first-catalog
git init
```

```
Initialized empty Git repository in /home/you/my-first-catalog/.git/
```

That is the whole container. Everything else is two files inside it.

## Step 2 — write catalog.json

[`catalog.json`](/reference/glossary/#catalogjson) sits at the repository root and is the one file
the tool reads to know what your catalog offers. It has two parts: a `meta` header naming the
catalog, and an `entries` list of installable things. Write the smallest valid version, one
[skill](/reference/glossary/#skill) entry:

```sh "myteam"
cat > catalog.json <<'JSON'
{
  "meta": {
    "name": "myteam"
  },
  "entries": [
    {
      "kind": "artifact",
      "id": "skill:commit-style",
      "nature": "skill",
      "targets": ["claude"],
      "scopes": ["user"]
    }
  ]
}
JSON
```

Each field is load-bearing. `meta.name` is the catalog's declared name; by convention you register
the catalog under this same name in Step 4, and that registered name — not `meta.name` itself —
becomes the prefix on every id. The entry says: this is one installable [artifact](/reference/glossary/#artifact)
(`kind`), of [nature](/reference/glossary/#nature) `skill`, that targets the `claude`
[assistant](/reference/glossary/#assistant) and installs at
[`user`](/reference/glossary/#scope) scope. The `id`, `skill:commit-style`, follows the
`<nature>:<name>` shape. Every field and every optional one it omits is listed in the
[catalog schema reference](/reference/catalog-schema/).

## Step 3 — add the skill

The entry above declares a skill named `commit-style`. Its content lives at a conventional path:
`skills/<name>/SKILL.md`. The file opens with an [agentskills.io](/reference/glossary/#agentskillsio)
[frontmatter](/reference/glossary/#frontmatter) block carrying a `name` and a `description`, then
plain Markdown instructions:

````sh
mkdir -p skills/commit-style
cat > skills/commit-style/SKILL.md <<'MD'
---
name: commit-style
description: Write commit messages in our team's convention. Conventional Commits, imperative subject under 50 characters, body explaining why.
---

# Commit style

When you write a commit message, follow the team's convention.

- **Subject**: `<type>(<scope>): <summary>`, imperative mood, no trailing
  period, under 50 characters. Types: `feat`, `fix`, `docs`, `refactor`,
  `test`, `chore`.
- **Body**: wrap at 72 characters. Explain *why* the change was made, not what
  changed. The diff already shows what.
- **One logical change per commit.** Split unrelated edits.

Example:

```
fix(auth): reject expired refresh tokens

A stale token slipped past the guard because the clock check
compared seconds against milliseconds. Normalise both to ms.
```
MD
````

The path `skills/commit-style/` matches the `commit-style` in your entry id. The
[catalog layout reference](/reference/catalog-layout/) gives the conventional path for every nature.

## Step 4 — install it from a local path

Here is the loop you will spend most of your authoring time in. The tool reads catalogs over git, so
your working files stay invisible to it until you commit them. Commit first:

```sh
git add .
git commit -m "feat: first catalog with commit-style skill"
```

```
[main (root-commit) a51008b] feat: first catalog with commit-style skill
 2 files changed, 38 insertions(+)
 create mode 100644 catalog.json
 create mode 100644 skills/commit-style/SKILL.md
```

Now register the catalog under a local name, pointing at its folder with an absolute path. A local
path is a valid source, exactly like a remote git URL, and it means zero network round-trips while
you iterate:

```sh
agent-rigger catalog add myteam "$(pwd)"
```

```
catalog "myteam" added (/home/you/my-first-catalog)
```

List what the catalog now offers:

```sh
agent-rigger ls
```

```
Catalog (1 entry):
  [available]  myteam/skill:commit-style  skill
```

Your skill appears, its id [qualified](/reference/glossary/#qualified-id) with the catalog name:
`myteam/skill:commit-style`. The `myteam/` prefix is the local name you just registered the catalog
under (`catalog add myteam …`); it matches `meta.name` here only because you used the same word for
both, as the convention recommends. `[available]` means it is known but not yet installed. Install it, accepting the plan without a prompt:

```sh
agent-rigger install myteam/skill:commit-style --yes
```

```
--- Plan ---
Plan · 1 change · scope: user (~/.claude)

+ myteam/skill:commit-style   ~/.claude/skills/commit-style
  link  ~/.claude/skills/commit-style → store

Σ  1 link

--- Result ---
  [ok] Applied 1 file(s).
    + /tmp/tmp.aB3kZ9pQ7r/.claude/skills/commit-style
```

The **Plan** block previews the change before it happens; **Result** shows what was written. Notice
the two paths differ: the Plan lists the logical user-scope location (`~/.claude/…`), while the
Result shows where `RIGGER_HOME` actually redirected the write — your throwaway sandbox, not your
real home. Your skill installed as a link into a managed [store](/reference/glossary/#store), the
same mechanism every installed skill uses. Confirm the install is sound:

```sh
agent-rigger check
```

```
--- Catalogs ---
  [up-to-date]   myteam  (9f2c1ab8e7d4c05b3a61f8e29d7c4b0a5e13f6d2)
```

That 40-character hex string is the exact commit `check` resolved your catalog to. You have not
tagged a version yet, so the tool falls back to the full commit sha. The next step gives it a real
version to resolve instead.

:::caution[Commit before you install]
Run `ls` on a catalog with no commits and the tool cannot read it:

```
[warning] Catalog "myteam" (/home/you/my-first-catalog) unavailable (HEAD not found: ls-remote HEAD returned empty output). Check the URL or run `agent-rigger init`.
```

An empty repository has nothing to fetch. One commit fixes it.
:::

## Step 5 — cut a version

Teams should install a named version, not a moving commit. Tag one:

```sh
git tag -a v0.1.0 -m "v0.1.0"
```

The tool resolves a catalog to its highest [semver](/reference/glossary/#semver)
[tag](/reference/glossary/#tag). Move your install onto that tag and re-check:

```sh
agent-rigger update --yes
```

```
[up-to-date]  myteam/skill:commit-style  (v0.1.0)
```

`[up-to-date]`, not `[updated]`: the tag points at the very commit you already installed, so no
content changes — only the label the tool resolves to moves from a raw sha to `v0.1.0`. The next
`check` is the real proof:

```sh
agent-rigger check
```

```
--- Catalogs ---
  [up-to-date]   myteam  (v0.1.0)
```

Where `check` printed a raw commit before, it now prints `v0.1.0`. Your catalog has a release the
whole team can pin to.

## Step 6 — recommend it by default

A catalog can nudge its members toward the right choices. Listing an id in
[`meta.recommended`](/reference/glossary/#recommended) pre-checks it in the proposal picker a
teammate sees the first time they wire up your catalog — when they run `agent-rigger init` or
`agent-rigger catalog add`. The id arrives already selected, and they can still uncheck it. Add the
field, then commit and tag a new release:

```sh ins={5}
cat > catalog.json <<'JSON'
{
  "meta": {
    "name": "myteam",
    "recommended": ["skill:commit-style"]
  },
  "entries": [
    {
      "kind": "artifact",
      "id": "skill:commit-style",
      "nature": "skill",
      "targets": ["claude"],
      "scopes": ["user"]
    }
  ]
}
JSON
git add .
git commit -m "feat: recommend commit-style by default"
git tag -a v0.1.1 -m "v0.1.1"
```

The change is only real for the team once it is a release. Run `update`, and watch the tool reach
past `v0.1.0` for the higher tag:

```sh
agent-rigger update --yes
```

```
--- Update ---
  [updated]     myteam/skill:commit-style  → v0.1.1
```

That single `→ v0.1.1` is the highest-tag rule in action, and it is all this step prints on your
machine: the recommendation itself only surfaces later, when someone else first adds your catalog.
There, `init` and `catalog add` open a proposal picker with your recommended skill already checked,
under this prompt:

```
Select artifacts to install (required items are always included):
```

Recommended ids arrive checked and are theirs to uncheck; ids listed under `required` (this catalog
declares none) cannot be unchecked. Running either command with `--yes` skips the picker entirely
and installs required plus recommended without asking. Note that plain `agent-rigger install` uses a
different, status-based picker that does not pre-check by recommendation — the pre-selection is a
property of the `init` / `catalog add` proposal flow. The full `meta` shape is in the
[catalog schema reference](/reference/catalog-schema/).

## Clean up

Erase the sandboxed install target. Your catalog repository stays where you made it:

```sh
rm -rf "$RIGGER_HOME"
unset RIGGER_HOME
```

## Where to go next

You now have a versioned catalog with one recommended skill. To put it in your team's hands, push
the repository to a git host. The URL you push to is exactly what a teammate passes to
`agent-rigger init` or `agent-rigger catalog add <name> <url>`: the local path you used here becomes
a remote URL, and nothing else changes.

- The full field-by-field shape of `catalog.json`, including packs, tools, and mcp entries, is in
  the [catalog schema reference](/reference/catalog-schema/).
- The conventional file path for each nature is in the
  [catalog layout reference](/reference/catalog-layout/).
- For why the tool splits a catalog, a store, and a [manifest](/reference/glossary/#manifest) into
  three, read [core concepts](/concepts/core-concepts/).
