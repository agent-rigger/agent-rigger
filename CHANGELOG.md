# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

agent-rigger is pre-1.0. Pre-built binaries are published with each
release (GitHub releases and the Homebrew tap).

## [Unreleased]

### Added

- **`--summary` flag on `install` and `remove`** — opt-in compact output: one
  recap line per artifact (symbol, id, primary target, op digest) instead of
  the full terraform-style block, and a Result section without per-item
  listings. Warnings, tool presence-checks, per-file backups and shared-store
  deletions stay fully visible; output without the flag is byte-identical.
  A 24-artifact install drops from 123 to 31 stdout lines and renders in ~7 s
  under VHS/ttyd where the full plan previously stalled.

- **opencode as a second assistant** — `install`, `check`, `remove` and `update`
  can target [opencode](https://opencode.ai): pick it in the interactive picker,
  pass `--assistant opencode`, or persist the choice at `rigger init`; the
  manifest records the assistant per entry so later commands route without
  asking again. Six natures are ported — context (native `AGENTS.md`), skills
  (shared store + symlinks), guardrails (native `permission` descriptor from
  the catalog), agents (frontmatter translated, `tools` whitelists become
  deny-by-default `permission` maps), MCP servers and plugins. Hooks stay
  Claude-only and are excluded from opencode transactions with an explicit
  message. `opencode.json` is edited as JSONC (comments survive), merges never
  touch keys agent-rigger does not own, and translation warnings are shown at
  plan and install time.

## [0.1.2] - 2026-06-30

### Added

- **RIGGER banner** — `agent-rigger --help` now opens with an ANSI Shadow
  "RIGGER" banner and the "harness package manager for teams" tagline (also
  added to the README), replacing the former one-line header.

## [0.1.1] - 2026-06-30

### Added

- **Try-it sandbox** — `scripts/sandbox` provisions a throwaway project to
  exercise agent-rigger with both scopes isolated, resolving a locally built
  binary or falling back to an installed one, and tears it all down on exit
  (documented in `docs/sandbox.md`).

### Changed

- **Homebrew tap published from the release run** — the tap formula is now
  rendered and pushed by the release workflow itself, so a tagged release
  refreshes `brew install`/`brew upgrade` automatically. It replaces a separate
  workflow that never fired.

## [0.1.0] - 2026-06-30

### Added

- **`check`** — audit the installed guardrails and context against their recorded
  state and report drift (exit codes: `0` ok, `2` malformed JSON, `3` drift).
- **`install`** — interactive picker or non-interactive `install <id…>`; resolves
  packs and dependencies, shows a terraform-style plan grouped by artifact, backs
  up before writing, and never writes without confirmation (`--yes` to skip).
- **`remove`** — uninstall artifacts with a reversible plan, backups, and `--yes`.
- **`update`** — re-install external artifacts whose remote version is newer.
- **`init`** — configure a catalog URL and authentication; probes ambient auth
  first, persists config only on success.
- **`ls`** — list catalog entries across every configured catalog source, with
  install status.
- **`doctor`** — report detected dependencies and the active scan mode.
- **Multi-catalog support** — `catalog add` plugs in named catalogs; installs are
  routed to the right source by qualified id prefix.
- **Remote install with provenance** — external artifacts record the real
  `ref`/`sha` in the manifest; fetched content is scanned (gitleaks/trivy) before
  it lands on disk — fail-closed on findings, warn-only if neither scanner is
  installed.
- **Transactional apply** — `apply()` rolls back via backups on partial failure
  (atomicity); Tier 1 rollback compensates link/plugin/store operations.

### Invariants

Idempotence, backup-before-write, human-in-the-loop confirmation, and no silent
failures hold across all commands.

[Unreleased]: https://github.com/agent-rigger/agent-rigger/compare/v0.1.2...main
[0.1.2]: https://github.com/agent-rigger/agent-rigger/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/agent-rigger/agent-rigger/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/agent-rigger/agent-rigger/releases/tag/v0.1.0
