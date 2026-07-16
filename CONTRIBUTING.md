# Contributing to agent-rigger

Thanks for considering a contribution. This document explains how to set up the
project, the quality gates a change must pass, and how to propose it.

## Prerequisites

- **Bun >= 1.3** — runtime and package manager (`bun --version`).
- **git** — required for remote catalog operations and the test suite.
- **gitleaks and/or trivy** — required to exercise the install path against a
  remote catalog (content is scanned before it lands on disk).

See the [README](./README.md#installation) for the full list.

## Setup

```sh
git clone https://github.com/agent-rigger/agent-rigger.git
cd agent-rigger
bun install          # also installs git hooks via lefthook (prepare script)
```

## Quality gates

Every change must pass the same gates CI runs. Run them locally before opening a
pull request:

```sh
bun test             # unit tests (bun test)
bun run lint         # oxlint
bun run format:check # dprint — formatting must be clean
bun run typecheck    # tsc --noEmit
```

Apply formatting with `bun run format`. The lefthook hooks format and lint staged
files at commit time and enforce the commit message format; tests and typecheck run
in CI, so run all four gates locally before pushing.

## Workspace layout

This is a Bun workspace. Source lives under `packages/`:

| Package                  | Responsibility                              |
| ------------------------ | ------------------------------------------- |
| `@agent-rigger/core`     | Plan/apply engine, manifest, rollback       |
| `@agent-rigger/adapters` | Per-assistant adapters (claude, opencode)   |
| `@agent-rigger/catalog`  | Catalog model, merge, remote fetch          |
| `@agent-rigger/cli`      | Command-line interface and command handlers |

The CLI ships **no content of its own** — every artifact comes from a configured
catalog. Keep that boundary: engine logic in `core`, target-specific writes in
`adapters`, never hard-code catalog content into the tool.

## Commits

Commits must follow [Conventional Commits](https://www.conventionalcommits.org/),
enforced by commitlint via lefthook. Examples:

```
feat(cli): add `catalog ls --json` output
fix(core): revert symlink on partial apply failure
docs(readme): document the remote install flow
```

Keep commits incremental and scoped. Prefer a focused change with a clear
message over a large mixed one.

## Pull requests

1. Branch from `main` (`git checkout -b feat/<short-name>`).
2. Make the change with tests covering the new behaviour.
3. Run the quality gates above — all must pass.
4. Open a PR describing **what** changed and **why**. Link any related issue.
5. CI must be green before review.

## Releasing

Releases are cut from `main` by the maintainer. The version is carried by the git
tag; the changelog is rotated by a scripted, zero-LLM step, and CI refuses to
publish a tag whose changelog section is missing.

1. Make sure `## [Unreleased]` lists everything the release ships.
2. Rotate the changelog into a dated section (version as `X.Y.Z`, no leading `v`):

   ```sh
   bun scripts/release-changelog.ts X.Y.Z
   ```

   This moves the Unreleased entries under `## [X.Y.Z] - <today>`, empties
   Unreleased, and rewrites the `compare`/`tag` link references. It refuses if
   that section already exists, or if Unreleased has no entries to release.

3. Commit the rotation:

   ```sh
   git commit -am "chore(release): X.Y.Z"
   ```

4. Tag and push the tag:

   ```sh
   git tag vX.Y.Z
   git push origin main --follow-tags
   ```

5. The tag push triggers the **Release** workflow. Before installing or building
   it verifies the changelog has a `## [X.Y.Z]` section (fail-closed) — if the
   rotation was skipped the run stops with the command to fix it. It then builds
   the standalone binaries, publishes the GitHub Release, and updates the
   Homebrew tap.

## Architecture decisions

Significant design decisions are tracked by the maintainer outside this public
repository and cited by id in code comments (grep the source for `ADR-` to find
the decision a given module follows). The decision records themselves are not
part of the public tree, and the README does not reference them. If your change
alters an invariant — idempotence, backup-before-write, human-in-the-loop, no
silent failures — explain the impact in the PR.

## Reporting bugs and security issues

- **Bugs / features** — open a GitHub issue with steps to reproduce.
- **Security vulnerabilities** — do **not** open a public issue. Follow
  [SECURITY.md](./SECURITY.md).
