# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

agent-rigger is pre-1.0 (milestone M0). Pre-built binaries are published with each
release (GitHub releases and the Homebrew tap).

### Added

- **`check`** — audit the installed harness against the expected state and report
  drift (exit codes: `0` ok, `2` malformed JSON, `3` drift).
- **`install`** — interactive picker or non-interactive `install <id…>`; resolves
  packs and dependencies, shows a terraform-style plan grouped by artifact, backs
  up before writing, and never writes without confirmation (`--yes` to skip).
- **`remove`** — uninstall artifacts with a reversible plan, backups, and `--yes`.
- **`update`** — re-install external artifacts whose remote version is newer.
- **`init`** — configure a catalog URL and authentication; probes ambient auth
  first, persists config only on success.
- **`ls`** — list catalog entries (built-in ∪ remote) with install status.
- **`doctor`** — report detected dependencies and the active scan mode.
- **Multi-catalog support** — `catalog add` plugs in named catalogs; installs are
  routed to the right source by qualified id prefix.
- **Remote install with provenance** — external artifacts record the real
  `ref`/`sha` in the manifest; fetched content is scanned (gitleaks/trivy,
  fail-closed) before it lands on disk.
- **Transactional apply** — `apply()` rolls back via backups on partial failure
  (atomicity); Tier 1 rollback compensates link/plugin/store operations.

### Invariants

Idempotence, backup-before-write, human-in-the-loop confirmation, and no silent
failures hold across all commands.

[Unreleased]: https://github.com/agent-rigger/agent-rigger/commits/main
