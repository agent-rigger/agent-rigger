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
