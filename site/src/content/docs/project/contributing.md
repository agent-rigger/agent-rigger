---
title: Contributing
description: "Set up agent-rigger, run the quality gates a change must pass, and propose it: prerequisites, workspace layout, conventional commits, and the pull-request flow."
---

This page is for contributors working on the CLI itself, not people configuring a
[catalog](/reference/glossary/#catalog). It covers setup, the quality gates, and the pull-request
flow.

## Prerequisites

- **Bun >= 1.3.0** — the runtime and package manager (`bun --version`). agent-rigger does not use
  node or pnpm.
- **git** — required for remote catalog operations and for the test suite.
- **gitleaks and/or trivy** — needed to exercise the
  [scan](/reference/glossary/#scan--scanner) path end to end. Without one on `PATH`, an
  install still runs but degrades to warn-only: the fetched content is simply not scanned.
  The unit tests do not require them.

## Setup

```sh
git clone https://github.com/agent-rigger/agent-rigger.git
cd agent-rigger
bun install          # runs the prepare script, which installs git hooks via lefthook
```

`bun install` runs the `prepare` script (`lefthook install`), so the commit hooks are wired up as
part of the first install.

## Quality gates

Every change must pass the same gates CI runs. Run them locally before opening a pull request:

```sh
bun run test         # bun test --pass-with-no-tests
bun run lint         # oxlint
bun run format:check # dprint check — formatting must be clean
bun run typecheck    # tsc --noEmit
```

Apply formatting with `bun run format` (`dprint fmt`).

The git hooks cover only part of this. The `pre-commit` hook auto-formats and lints your **staged**
files (`dprint fmt`, `oxlint --fix`) and restages the fixes; the `commit-msg` hook validates the
commit message. Tests and typecheck are **not** run by any hook. They run in CI, so run the four
gates above yourself before you push.

## Workspace layout

This is a Bun workspace. The CLI's source lives under `packages/`:

| Package                  | Responsibility                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `@agent-rigger/core`     | Plan/apply engine, [manifest](/reference/glossary/#manifest), backup and rollback, linker. |
| `@agent-rigger/adapters` | Per-assistant [adapters](/reference/glossary/#adapter) (Claude Code, opencode).            |
| `@agent-rigger/catalog`  | Catalog model, merge, schema, remote fetch.                                                |
| `@agent-rigger/cli`      | Command-line interface and the per-command handlers.                                       |

The CLI ships **no content of its own**: every [artifact](/reference/glossary/#artifact) comes from
a configured catalog. Keep that boundary: engine logic in `core`, target-specific writes in
`adapters`, and never hard-code catalog content into the tool.

## Commits

Commits follow [Conventional Commits](https://www.conventionalcommits.org/), enforced by commitlint
(the `@commitlint/config-conventional` ruleset) via the `commit-msg` hook. For example:

```
feat(cli): add `catalog ls --json` output
fix(core): revert symlink on partial apply failure
docs(readme): document the remote install flow
```

Keep commits incremental and scoped. A focused change with a clear message is easier to review than
one large mixed commit.

## Pull requests

1. Branch from `main` (`git checkout -b feat/<short-name>`). Never work on `main` directly.
2. Make the change with tests covering the new behaviour.
3. Run the four quality gates above; all must pass.
4. Open a PR describing **what** changed and **why**. Link any related issue.
5. CI must be green before review.

## Design invariants

A few invariants hold across the tool, and changes are expected to preserve them:

- **[Idempotence](/reference/glossary/#idempotence)** — re-running an operation that is already applied produces no new changes.
- **Backup-before-write** — an existing file is backed up before agent-rigger replaces it.
- **Human-in-the-loop** — destructive actions ask for confirmation rather than running silently.
- **No silent failures** — errors surface; they are never swallowed.

If your change touches one of these, say so in the pull request and explain the impact. Reviewers
weigh those changes differently, so calling it out up front avoids a round trip.

## Reporting bugs and security issues

- **Bugs and feature requests** — open a GitHub issue with steps to reproduce.
- **Security vulnerabilities** — do **not** open a public issue. Follow the process in the
  [security policy](/project/security-policy/).
