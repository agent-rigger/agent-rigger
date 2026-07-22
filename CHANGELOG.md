# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

agent-rigger is pre-1.0. Pre-built binaries are published with each
release (GitHub releases and the Homebrew tap).

## [Unreleased]

## [0.2.0] - 2026-07-22

### Added

- **`lib` nature — shared code libraries.** A catalog entry of nature `lib` is
  materialized once by the engine into `~/.config/agent-rigger/libs/<name>/` and
  imported by its consumers (Claude hooks, opencode plugins) through the
  `#libs/<lib>/<mod>.ts` subpath alias — the mapping lives in the context's
  `package.json` (catalog repo → `./common/libs/*`; a managed rigger-home
  `package.json` → `./libs/*`), so the same bytes resolve from the checkout AND
  once posed. Libs declare no assistant targets, are pulled transitively through
  `requires`, can never be installed directly (the error names real consumers),
  are filtered from install pickers, and show up in `ls`/`info` with a
  deduplicated `used by:` line. This removes the committed JS bundles the guard
  plugins previously required.
- **Dependency graph enforced at removal.** Resolved `requires` edges are
  persisted on every manifest entry (captured before pruning, inherited from
  packs — including nested packs, order-independent). `remove` refuses (exit 2)
  to take out an entry another installed entry still requires, naming the
  dependents; `--force` proceeds loudly. Removing a lib's last dependent offers
  the orphan lib under the same confirmation.
- **Fail-closed symlink posing for lib-dependent opencode plugins.** A fast-fail
  probe on the real filesystem of the scope's plugin dir, plus a hard check at
  the actual pose: a copy fallback undoes the write and aborts the run with a
  platform-aware, actionable error (a copied consumer would break its
  `#libs` import at runtime). The copy fallback is untouched for artifacts
  without lib dependencies.
- **Doctor coverage for the libs store and the requires graph** — phantom and
  hygiene scanning of `libs/`, plus report-only findings for broken edges,
  orphan libs, legacy entries predating the graph, and a missing or incorrect
  managed `#libs` mapping; the scanner provably never crashes, even on a
  malformed home `package.json`.
- **Real line-by-line diffs for `write-text` plan entries** — a unified
  context-3 diff against the installed content (new file = all additions),
  capped at 40 lines with explicit elision; headers keep real counts and
  `--summary` output is byte-identical to before.
- **`rigger config set <key> <value>`** — edit the persisted config from the
  CLI (the config-file header referenced it before it existed).
- **Layout-skew detection** — an ENOENT at scan staging or at the opencode
  plugin lookup now names the catalog/CLI layout-skew hypothesis (both
  directions) instead of surfacing a bare filesystem error.
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

### Changed

- **BREAKING: catalog checkout layout moves to `common/` + per-assistant
  directories** — `common/{skills,agents,libs}`, `claude/{hooks,guardrails,contexts}`,
  `opencode/{plugins,guardrails}`. The CLI reads only the new layout (a
  bi-target entry is scanned in every target dir it can be applied from);
  catalogs must republish a migrated release — the jr and example catalogs ship
  theirs alongside this version. Mixing an old CLI with a new catalog, or the
  reverse, fails with the explicit skew message above.
- **Zero-dependency entries persist `requires: []`** — a missing `requires`
  field now exclusively marks entries installed before the dependency graph
  existed; they are backfilled on their first `update` (with a visible
  `[skipped]` line when an entry can no longer be re-resolved).
- **`rigger` is the canonical command** across USAGE and user-facing messages
  (`agent-rigger` stays as a compatible alias; the Homebrew formula keeps its
  name and its caveat now shows `rigger`).
- **`--assistant` help distinguishes real targeting** (install/check/remove/
  update) from the read-only `[installed]` marker on `ls`/`info`; `remove
  --force` (refcount bypass) is documented.
- **`update lib:<id>` explains itself** — a lib is updated through the
  artifacts that require it (previously a misleading "not installed" skip).
- **Security scan runs once per install, over the exact selection** — the
  pre-apply gate now scans a single staging mirror holding the union of the
  selected artifacts plus `catalog.json`, instead of invoking the scanners once
  per artifact. A full install drops from ~22 scanner spawns to 2 (gitleaks +
  trivy), measured at −46 % install time, with the same fail-closed semantics.
  Scan findings now name each file by its path relative to the checkout root
  (e.g. `common/skills/my-skill/SKILL.md`) instead of an absolute
  temporary-checkout path.

### Fixed

- **CLI fix lot B5-B10** — project-scope `AGENTS.md` removal is symmetric
  between adapters (refcount on both, B5); installing from a local path with
  uncommitted content errors instead of silently installing nothing (B7);
  doctor no longer reports directory symlinks as "gone from disk" (B8); a
  tools-only selection actually runs its presence checks (B10).
- **Scan signal no longer lost** on `init --yes` (warnings discarded) and on an
  aborted `update` (collected warnings dropped); when only one of
  gitleaks/trivy is present, the scan now warns about the absent tool instead
  of silently scanning with one.
- **Catalog ids are validated at the schema** — a forged `skill:../../evil` id
  is rejected at parse time (defense-in-depth on top of the staging guards).
- **Multi-target packs filtered at the adapter boundary** — installing a mixed
  pack for one assistant no longer trips the other assistant's guards
  (`opencode-pack-target-filter`), with the same symmetry applied to update.
- **Foreign lib dependencies resolve to their singleton** — a cross-catalog lib
  requirement is satisfied by its installed `(user, shared)` entry; previously
  the lookup used the transaction's scope/assistant, wrongly refusing installs
  whose dependency was present.
- **Release changelog guard escapes every ERE metacharacter** — a
  `v1.2.3+build` tag now matches its own header.
- **Tool-check runner output is bounded** — captured stdout/stderr capped at
  1 MiB with an explicit truncation marker (exit-code semantics unchanged).
- **Ad-hoc `install --yes` works on catalogs containing libs** (it previously
  always threw); a libs-only catalog gets an honest message instead of
  "catalog is empty".
- **gitleaks unparseable exit-1 output now fails closed** — when gitleaks exits
  1 (findings) but its JSON report cannot be parsed, the scan resolves to a
  clean blocking verdict instead of crashing on `JSON.parse`.

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

[Unreleased]: https://github.com/agent-rigger/agent-rigger/compare/v0.2.0...main
[0.2.0]: https://github.com/agent-rigger/agent-rigger/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/agent-rigger/agent-rigger/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/agent-rigger/agent-rigger/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/agent-rigger/agent-rigger/releases/tag/v0.1.0
